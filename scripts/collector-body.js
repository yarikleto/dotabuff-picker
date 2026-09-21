/**
 * Body of the in-page collector. Not run directly — build-collector.mjs inlines
 * scripts/parse.mjs and scripts/roles.mjs above this, and scrape-electron.mjs
 * injects the result into a dotabuff.com page.
 *
 * Running inside the page is the whole point: every request carries the
 * session, cookies and TLS fingerprint Cloudflare expects, none of which Node
 * can reproduce. Same parsing code as the Node scraper, so the result is the
 * same shape whichever route collected it.
 *
 * Hands its result back on `window.__dotabuff.payload`; writing the file is the
 * caller's job. Available here: `P` (parse.mjs) and `R` (roles.mjs).
 */

/**
 * Set before injecting, e.g.
 *   window.__dotabuffConfig = { spacing: 800 }   // gentler on Dotabuff
 */
const cfg = window.__dotabuffConfig ?? {};
const CONCURRENCY = cfg.concurrency ?? 2;
const SPACING_MS = cfg.spacing ?? 400;
const RETRIES = cfg.retries ?? 2;

const log = (...a) => console.log("%c[dotabuff]", "color:#4aa8e0;font-weight:bold", ...a);
const warn = (...a) => console.warn("[dotabuff]", ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Keep partial results on the window so an interrupted run is not wasted. */
const state = (window.__dotabuff ??= { matchups: {}, lanes: {}, heroes: null });

async function get(path) {
  let lastError;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    if (attempt) await sleep(1500 * attempt);
    try {
      const res = await fetch(path, { credentials: "include", headers: { Accept: "text/html" } });
      if (res.status === 429 || res.status >= 500) {
        lastError = `HTTP ${res.status}`;
        await sleep(3000);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      lastError = err.message;
    }
  }
  throw new Error(`${path}: ${lastError}`);
}

/** Bounded-concurrency map that keeps requests spaced out. */
async function pool(items, worker, onProgress) {
  const results = [];
  let index = 0;
  let done = 0;
  const runner = async () => {
    while (index < items.length) {
      const i = index++;
      await sleep(SPACING_MS);
      try {
        results[i] = await worker(items[i]);
      } catch (err) {
        results[i] = { error: err.message };
      }
      onProgress?.(++done, items.length, items[i]);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, runner));
  return results;
}

function progressBar(done, total, label) {
  const width = 24;
  const bar = "#".repeat(Math.round((done / total) * width)).padEnd(width, ".");
  const line = `[${bar}] ${done}/${total} ${label}`;
  document.title = `${done}/${total} — dotabuff collector`;
  if (done === total || done % 10 === 0 || done === 1) log(line);
}

async function collect() {
  const started = Date.now();
  // Same-origin is the whole point: the requests must carry this tab's session.
  if (!location.hostname.endsWith("dotabuff.com")) {
    throw new Error(
      `this must run on a dotabuff.com page, not ${location.hostname}`,
    );
  }
  log("starting");

  // ---- roster -------------------------------------------------------------
  log("reading /heroes …");
  const indexHtml = await get("/heroes");
  const names = P.parseHeroNames(indexHtml);
  const attrs = P.parseHeroAttributes(indexHtml);
  const stats = P.parseHeroStats(indexHtml);
  if (!names.size) throw new Error("no heroes found on /heroes — markup may have changed");

  const heroes = [...names].map(([slug, name]) => {
    const hero = { slug, name, attr: attrs.get(slug) ?? "uni" };
    const s = stats.get(slug);
    if (s) {
      if (s.winRate != null) hero.winRate = s.winRate;
      if (s.pickRate != null) hero.pickRate = s.pickRate;
      if (s.banRate != null) hero.banRate = s.banRate;
      if (s.tier) hero.tier = s.tier;
    }
    return hero;
  });
  heroes.sort((a, b) => a.name.localeCompare(b.name));
  state.heroes = heroes;
  log(`roster: ${heroes.length} heroes, ${attrs.size} attributes, ${stats.size} stat rows`);

  // ---- lanes -> positions -------------------------------------------------
  log("reading lane tables …");
  const heroLanes = new Map();
  for (const lane of R.LANES) {
    try {
      const table = P.parseLaneTable(await get(`/heroes/lanes?lane=${lane}`));
      for (const [slug, s] of table) {
        if (!heroLanes.has(slug)) heroLanes.set(slug, {});
        heroLanes.get(slug)[lane] = s;
      }
      log(`  ${lane.padEnd(8)} ${table.size} heroes`);
    } catch (err) {
      warn(`lane "${lane}" failed: ${err.message}`);
    }
    await sleep(SPACING_MS);
  }
  // The overall win rates are the prior a thin position's win rate is shrunk
  // towards — without them a hero inherits the raw lane figure for a role they
  // barely play, which is somebody else's number. Same call as scrape.mjs
  // makes; the two collection paths must not disagree about the maths.
  const derived = R.derivePositions(
    heroLanes,
    new Map(heroes.filter((h) => Number.isFinite(h.winRate)).map((h) => [h.slug, h.winRate])),
  );
  for (const hero of heroes) {
    const lanes = heroLanes.get(hero.slug);
    const roles = derived.get(hero.slug);
    if (lanes) hero.lanes = lanes;
    if (!roles) continue;
    hero.positions = roles.positions;
    hero.positionWinRate = roles.positionWinRate;
    hero.topPositions = roles.topPositions;
  }
  log(`positions derived for ${derived.size}/${heroes.length} heroes`);
  const canaries = { "anti-mage": 1, "crystal-maiden": 5, invoker: 2, axe: 3 };
  log(
    "sanity check: " +
      Object.keys(canaries)
        .map((slug) => {
          const h = heroes.find((x) => x.slug === slug);
          if (!h?.topPositions) return `${slug} ?`;
          const ok = h.topPositions.includes(canaries[slug]);
          return `${h.name} ${h.topPositions.join("/")}${ok ? "" : ` (expected ${canaries[slug]})`}`;
        })
        .join(", "),
  );

  // ---- matchups -----------------------------------------------------------
  const todo = heroes.filter((h) => !state.matchups[h.slug]);
  log(`fetching matchups for ${todo.length} heroes (${heroes.length - todo.length} already held) …`);
  const thin = [];
  await pool(
    todo,
    async (hero) => {
      const rows = P.parseMatchups(await get(`/heroes/${hero.slug}/matchups`));
      if (rows.length < 40) thin.push(`${hero.slug} (${rows.length} rows)`);
      const table = {};
      for (const row of rows) {
        if (row.slug !== hero.slug) table[row.slug] = [row.disadvantage, row.winRate, row.matches];
      }
      state.matchups[hero.slug] = table;
    },
    (done, total, hero) => progressBar(done, total, hero.name),
  );

  const covered = Object.keys(state.matchups).length;
  const cells = Object.values(state.matchups).reduce((n, t) => n + Object.keys(t).length, 0);
  if (!covered) throw new Error("no matchup data collected");

  const payload = {
    generatedAt: new Date().toISOString(),
    source: "https://www.dotabuff.com/heroes (browser collector)",
    note:
      "matchups[a][b] = [disadvantage, winRate, matches] from hero A's page. " +
      "disadvantage > 0 means A performs worse than usual against B. " +
      "hero.positions[1..5] is the share of that hero's games spent in each " +
      "position, reconstructed from lane presence and GPM.",
    heroes,
    matchups: state.matchups,
  };

  // The caller reads this off the window and writes the file itself.
  state.payload = payload;

  document.title = "done — dotabuff collector";
  log(
    `done: ${covered}/${heroes.length} heroes, ${cells} matchup cells, ` +
      `${Math.round((Date.now() - started) / 1000)}s`,
  );
  if (thin.length) warn(`${thin.length} hero(es) parsed thin:`, thin.slice(0, 10));
}

// Exposed so you can `await window.__dotabuff.done` if you want to chain on it.
state.done = collect().catch((err) => {
  document.title = "failed — dotabuff collector";
  console.error("[dotabuff] collection failed:", err.message);
  console.error("[dotabuff] partial results are still on window.__dotabuff.");
});
