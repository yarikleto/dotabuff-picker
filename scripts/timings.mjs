#!/usr/bin/env node
/**
 * Builds public/data/timings.json — how each hero's win rate moves with the
 * length of the game.
 *
 *   npm run timings                      # ~300k ranked matches, resumes if interrupted
 *   npm run timings -- --probe           # one window, print what came back, stop
 *   npm run timings -- --matches=800000  # bigger sample, tighter numbers
 *   npm run timings -- --fresh           # ignore the saved progress file
 *   npm run timings -- --min-rank=70     # Divine+ only (avg_rank_tier)
 *
 * Counters tell you who beats whom and synergies tell you who belongs together;
 * neither says *when* a line-up is supposed to win. That is the question a
 * captain actually has to answer out loud — do we force fights at twenty
 * minutes or do we farm and take the late game — and it is answerable from the
 * same OpenDota table the synergies come from, because `public_matches` carries
 * a duration for every row.
 *
 * What is stored is not the raw win rate in a bucket but the *skew*: how far
 * the hero's win rate in that window sits from their own overall win rate. A
 * hero who wins 54% everywhere is not a late-game hero; a hero who wins 46%
 * before twenty-five minutes and 53% after forty-five is, and only the skew
 * shows it.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { staleProgress } from "./progress.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_FILE = join(ROOT, "public", "data", "timings.json");
const PROGRESS_FILE = join(ROOT, "scripts", ".cache", "timings-progress.json");
const API = "https://api.opendota.com/api";

/**
 * The windows the game is actually decided in, in seconds.
 *
 * Four buckets rather than a smooth curve: this exists to be said out loud in
 * a draft ("we are a before-thirty team"), and nobody talks in deciles. The
 * edges sit either side of the typical game length so both tails hold real
 * sample rather than a handful of stomps and a handful of marathons.
 */
export const BUCKETS = [
  { key: "early", label: "Before 25′", short: "<25", maxSeconds: 1500 },
  { key: "mid", label: "25–35′", short: "25–35", maxSeconds: 2100 },
  { key: "late", label: "35–45′", short: "35–45", maxSeconds: 2700 },
  { key: "veryLate", label: "45′ and up", short: "45+", maxSeconds: null },
];

/**
 * How hard a thin sample is pulled back towards "no skew at all".
 *
 * A hero with 40 games in the 45-minute bucket will show a wild number by
 * chance alone. Halving the skew at 400 games keeps the bucket honest without
 * flattening heroes that genuinely swing.
 */
const SHRINK_GAMES = 400;

// ---------------------------------------------------------------- CLI options

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const options = {
  matches: Number(opt("matches", 300_000)),
  window: Number(opt("window", 60_000)),
  minGames: Number(opt("min-games", 200)),
  minRank: Number(opt("min-rank", 0)),
  delay: Number(opt("delay", 1200)),
  timeout: Number(opt("timeout", 90_000)),
  fresh: flag("fresh"),
  probe: flag("probe"),
  key: opt("key", process.env.OPENDOTA_API_KEY || ""),
};

const log = (...a) => console.log(...a);
const warn = (...a) => console.warn("  !", ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function progress(matches, target, label) {
  const width = 24;
  const filled = Math.min(width, Math.round((matches / target) * width));
  const bar = "#".repeat(filled).padEnd(width, ".");
  const line = `  [${bar}] ${matches.toLocaleString().padStart(9)} matches  ${label}`;
  if (process.stdout.isTTY) process.stdout.write(`\r${line.padEnd(88)}`);
  else log(line);
}

// ------------------------------------------------------------------- fetching

async function getJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json", "User-Agent": "dotabuff-picker/1.0" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function explorer(sql) {
  const url =
    `${API}/explorer?sql=${encodeURIComponent(sql.replace(/\s+/g, " ").trim())}` +
    (options.key ? `&api_key=${encodeURIComponent(options.key)}` : "");
  const body = await getJson(url);
  if (body?.err) throw new Error(String(body.err));
  if (!Array.isArray(body?.rows)) throw new Error("no rows in response");
  return body.rows;
}

// ------------------------------------------------------------------- the SQL

/** `CASE WHEN duration < … THEN 0 …` built from BUCKETS, so the two cannot drift. */
export const bucketCase = () => {
  const arms = BUCKETS.filter((b) => b.maxSeconds !== null).map(
    (b, i) => `WHEN duration < ${b.maxSeconds} THEN ${i}`,
  );
  return `CASE ${arms.join(" ")} ELSE ${BUCKETS.length - 1} END`;
};

/**
 * One window of matches, folded to (hero, bucket, games, wins).
 *
 * Both sides of every game are unioned into one relation so a hero's row counts
 * their games wherever they were drafted, and the win flag is already read from
 * that hero's own side.
 */
export const windowSql = (lo, hi) => {
  const where = (extra = "") => `
    WHERE match_id > ${lo} AND match_id <= ${hi}
      AND lobby_type = 7 AND game_mode = 22
      AND duration > 600
      AND array_length(radiant_team, 1) = 5 AND array_length(dire_team, 1) = 5
      ${options.minRank ? `AND avg_rank_tier >= ${options.minRank}` : ""}${extra}`;

  return `
    WITH src AS (
      SELECT radiant_team AS team, radiant_win AS won, duration FROM public_matches
      ${where()}
      UNION ALL
      SELECT dire_team AS team, NOT radiant_win AS won, duration FROM public_matches
      ${where()}
    )
    SELECT unnest(team) AS hero,
           ${bucketCase()} AS bucket,
           count(*) AS games,
           count(*) FILTER (WHERE won) AS wins
      FROM src
     GROUP BY 1, 2`;
};

// ---------------------------------------------------------------------- roster

/** OpenDota hero id -> our slug, matched on Valve's internal short name. */
async function heroIdMap() {
  const src = await readFile(join(ROOT, "src", "data", "heroes.ts"), "utf8");
  const bySteam = new Map();
  const re = /\{\s*slug:\s*"([^"]+)",\s*name:\s*"([^"]+)",\s*attr:\s*"[^"]+",\s*steam:\s*"([^"]+)"\s*\}/g;
  let m;
  while ((m = re.exec(src)) !== null) bySteam.set(m[3], m[1]);
  if (!bySteam.size) throw new Error("could not read src/data/heroes.ts — has its format changed?");

  const heroes = await getJson(`${API}/heroes`);
  const byId = new Map();
  const unmatched = [];
  for (const hero of heroes) {
    const steam = String(hero.name ?? "").replace(/^npc_dota_hero_/, "");
    const slug = bySteam.get(steam);
    if (slug) byId.set(hero.id, slug);
    else unmatched.push(hero.localized_name ?? steam);
  }
  if (unmatched.length) {
    warn(`${unmatched.length} hero(es) on OpenDota are missing from src/data/heroes.ts: ${unmatched.join(", ")}`);
    warn("rerun the Dotabuff scrape to pick them up — they are skipped for now");
  }
  return byId;
}

// -------------------------------------------------------------- the aggregate

/** Add one window's rows into the running totals. Returns matches counted. */
export function fold(rows, totals) {
  let games = 0;
  // `Number(null)` is 0, which is a perfectly good hero id as far as
  // `isFinite` is concerned — so a missing field has to be rejected before the
  // coercion, not after it.
  const num = (value) => {
    if (value === null || value === undefined || value === "") return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  };

  for (const row of rows) {
    const hero = num(row.hero);
    const bucket = num(row.bucket);
    const n = num(row.games);
    const wins = num(row.wins) ?? 0;
    if (hero === null || bucket === null || n === null) continue;

    const key = `${hero}:${bucket}`;
    const seen = totals.get(key) ?? { hero, bucket, games: 0, wins: 0 };
    seen.games += n;
    seen.wins += wins;
    totals.set(key, seen);
    games += n;
  }
  // Ten hero rows per match, five a side.
  return Math.round(games / 10);
}

/**
 * Turn raw counts into the per-hero skew table.
 *
 * Exported so the tests can drive it without touching the network.
 */
export function buildTimings(totals, byId, { minGames = 200 } = {}) {
  /** slug -> bucket index -> {games, wins} */
  const heroes = new Map();
  for (const row of totals.values()) {
    const slug = byId.get(row.hero);
    if (!slug) continue;
    const buckets = heroes.get(slug) ?? BUCKETS.map(() => ({ games: 0, wins: 0 }));
    const cell = buckets[row.bucket];
    if (!cell) continue;
    cell.games += row.games;
    cell.wins += row.wins;
    heroes.set(slug, buckets);
  }

  const table = {};
  let kept = 0;
  let thin = 0;

  for (const [slug, buckets] of heroes) {
    const games = buckets.reduce((sum, b) => sum + b.games, 0);
    const wins = buckets.reduce((sum, b) => sum + b.wins, 0);
    if (games < minGames) {
      thin++;
      continue;
    }
    const overall = (wins / games) * 100;

    table[slug] = buckets.map((b) => {
      if (!b.games) return [0, 0, 0];
      const winRate = (b.wins / b.games) * 100;
      // Shrink towards the hero's own baseline, hard when the bucket is thin.
      const skew = (winRate - overall) * (b.games / (b.games + SHRINK_GAMES));
      return [
        b.games,
        Math.round(winRate * 100) / 100,
        Math.round(skew * 1000) / 1000,
      ];
    });
    kept++;
  }

  return { table, kept, thin };
}

// -------------------------------------------------------------------- progress

async function readProgress() {
  if (options.fresh) return null;
  let saved;
  try {
    saved = JSON.parse(await readFile(PROGRESS_FILE, "utf8"));
  } catch {
    return null;
  }
  const stale = staleProgress(saved, { target: options.matches });
  if (stale) {
    log(`  ${stale} — collecting fresh matches`);
    return null;
  }
  if ((saved.minRank ?? 0) !== options.minRank) {
    warn(`saved progress used --min-rank=${saved.minRank ?? 0}; starting over`);
    return null;
  }
  return saved;
}

async function saveProgress(state, totals) {
  await mkdir(dirname(PROGRESS_FILE), { recursive: true });
  await writeFile(
    PROGRESS_FILE,
    JSON.stringify({
      ...state,
      minRank: options.minRank,
      savedAt: new Date().toISOString(),
      rows: [...totals.values()].map((r) => [r.hero, r.bucket, r.games, r.wins]),
    }),
    "utf8",
  );
}

function restore(saved) {
  const totals = new Map();
  for (const [hero, bucket, games, wins] of saved.rows ?? []) {
    totals.set(`${hero}:${bucket}`, { hero, bucket, games, wins });
  }
  return totals;
}

// ------------------------------------------------------------------------ main

async function newestMatchId() {
  const rows = await explorer("SELECT match_id FROM public_matches ORDER BY match_id DESC LIMIT 1");
  const id = Number(rows[0]?.match_id);
  if (!Number.isFinite(id)) throw new Error("could not read the newest match id");
  return id;
}

async function collect() {
  const byId = await heroIdMap();
  log(`  mapped ${byId.size} heroes from OpenDota ids`);

  const saved = await readProgress();
  const totals = saved ? restore(saved) : new Map();
  let matches = saved?.matches ?? 0;
  const newest = saved?.newest ?? (await newestMatchId());
  let cursor = saved?.cursor ?? newest;
  let width = options.window;

  if (saved) log(`  resuming: ${matches.toLocaleString()} matches already counted`);
  log(`  newest match id ${newest.toLocaleString()}, walking backwards\n`);

  let emptyWindows = 0;

  while (matches < options.matches) {
    const hi = cursor;
    const lo = Math.max(0, cursor - width);
    if (lo <= 0) {
      warn("reached the start of the table");
      break;
    }

    const started = Date.now();
    let rows;
    try {
      rows = await explorer(windowSql(lo, hi));
    } catch (err) {
      const narrower = Math.max(2_000, Math.floor(width / 2));
      if (narrower === width) {
        warn(`window ${lo}-${hi} keeps failing (${err.message}); giving up here`);
        break;
      }
      warn(`window of ${width.toLocaleString()} ids failed (${err.message}); retrying at ${narrower.toLocaleString()}`);
      width = narrower;
      await sleep(options.delay * 2);
      continue;
    }

    const elapsed = Date.now() - started;
    const found = fold(rows, totals);
    matches += found;
    cursor = lo;

    if (options.probe) {
      log(`\n  probe: ${found.toLocaleString()} matches from ${width.toLocaleString()} ids in ${elapsed}ms`);
      log(`  ${rows.length} aggregate rows across ${BUCKETS.length} buckets`);
      const spread = BUCKETS.map((b, i) => {
        const games = rows
          .filter((r) => Number(r.bucket) === i)
          .reduce((sum, r) => sum + Number(r.games), 0);
        return `${b.short}: ${Math.round(games / 10).toLocaleString()}`;
      });
      log(`  matches per bucket — ${spread.join(", ")}`);
      log(`  ${options.matches.toLocaleString()} matches ≈ ${Math.ceil(options.matches / Math.max(1, found))} more requests at this width`);
      return { totals, byId, matches, newest, cursor };
    }

    if (found === 0 && ++emptyWindows >= 5) {
      warn("five windows in a row came back empty — stopping");
      break;
    }
    if (found > 0) emptyWindows = 0;

    if (elapsed < 4_000) width = Math.min(width * 2, 2_000_000);
    else if (elapsed > 20_000) width = Math.max(2_000, Math.floor(width / 2));

    await saveProgress({ matches, newest, cursor }, totals);
    progress(matches, options.matches, `${(elapsed / 1000).toFixed(1)}s per window`);
    await sleep(options.delay);
  }

  return { totals, byId, matches, newest, cursor };
}

async function main() {
  const started = Date.now();
  log("\nCollecting win rate by game length from OpenDota\n");

  const { totals, byId, matches, newest, cursor } = await collect();
  if (options.probe) return;

  const { table, kept, thin } = buildTimings(totals, byId, { minGames: options.minGames });

  const payload = {
    generatedAt: new Date().toISOString(),
    source: "https://api.opendota.com/api/explorer (public_matches)",
    note:
      "timings[slug][bucket] = [games, winRate, skew]. skew is percentage points " +
      "away from that hero's own overall win rate in this sample, shrunk towards " +
      "zero by sample size — positive means the hero does better than usual when " +
      "games run this long. Ranked all-draft only (lobby_type 7, game_mode 22).",
    matches,
    matchIdRange: [cursor, newest],
    minRank: options.minRank || null,
    minGames: options.minGames,
    buckets: BUCKETS,
    timings: table,
  };

  await mkdir(dirname(OUT_FILE), { recursive: true });
  await writeFile(OUT_FILE, JSON.stringify(payload), "utf8");

  log(`\nWrote public/data/timings.json`);
  log(`  ${matches.toLocaleString()} matches, ${kept} heroes kept, ${thin} below --min-games=${options.minGames}`);

  // A quick sanity read: the heroes the sample calls the most extreme. If these
  // do not look like the game's known early and late heroes, something upstream
  // is wrong and it is better to see it now than in a draft.
  const late = Object.entries(table)
    .map(([slug, rows]) => [slug, rows.at(-1)?.[2] ?? 0])
    .sort((a, b) => b[1] - a[1]);
  const early = [...late].reverse();

  log("\n  strongest when the game runs long");
  for (const [slug, skew] of late.slice(0, 5)) log(`    ${slug.padEnd(24)} ${skew >= 0 ? "+" : "−"}${Math.abs(skew).toFixed(2)}pp`);
  log("  weakest when the game runs long");
  for (const [slug, skew] of early.slice(0, 5)) log(`    ${slug.padEnd(24)} ${skew >= 0 ? "+" : "−"}${Math.abs(skew).toFixed(2)}pp`);
  log(`\n  ${((Date.now() - started) / 1000) | 0}s\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(`\nTiming collection failed: ${err.message}\n`);
    if (/HTTP 429|rate/i.test(err.message)) {
      console.error("  OpenDota rate-limited the run. Wait a minute, then rerun — progress is");
      console.error("  saved after every window, so it picks up where it stopped. A free API key");
      console.error("  from https://www.opendota.com/api-keys raises the limit:");
      console.error("    OPENDOTA_API_KEY=... npm run timings\n");
    } else {
      console.error("  Try `npm run timings -- --probe` to see what one window returns.\n");
    }
    process.exit(1);
  });
}
