#!/usr/bin/env node
/**
 * Builds public/data/synergies.json — how much better (or worse) each pair of
 * heroes does on the same team than the two of them do apart.
 *
 *   npm run synergy                     # ~300k ranked matches, resumes if interrupted
 *   npm run synergy -- --matches=800000 # bigger sample, tighter numbers
 *   npm run synergy -- --fresh          # ignore the saved progress file
 *   npm run synergy -- --min-rank=70    # Divine+ only (avg_rank_tier)
 *   npm run synergy -- --probe          # one window, print what came back, stop
 *
 * Why OpenDota rather than Dotabuff: Dotabuff publishes counters for free but
 * not synergies. OpenDota exposes `public_matches` — one row per ranked game
 * with both hero line-ups — through an open SQL endpoint, so the pair counts
 * can simply be aggregated. Counters still come from Dotabuff, where the
 * samples are an order of magnitude larger.
 *
 * The endpoint has a statement timeout, so we walk backwards through match_id
 * in windows and let the window size find its own level: too slow and it
 * halves, comfortably fast and it grows.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSynergies, CELLS } from "./synergy-math.mjs";
import { assignPositions, cellOf } from "./assign.mjs";
import { staleProgress } from "./progress.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_FILE = join(ROOT, "public", "data", "synergies.json");
const MATCHUP_FILE = join(ROOT, "public", "data", "matchups.json");
const POSITIONS_FILE = join(ROOT, "public", "data", "positions.json");
const PROGRESS_FILE = join(ROOT, "scripts", ".cache", "synergy-progress.json");
const API = "https://api.opendota.com/api";

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
  minGames: Number(opt("min-games", 50)),
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

/** Run one SQL statement against OpenDota's explorer. Returns its rows. */
async function explorer(sql) {
  const url =
    `${API}/explorer?sql=${encodeURIComponent(sql.replace(/\s+/g, " ").trim())}` +
    (options.key ? `&api_key=${encodeURIComponent(options.key)}` : "");
  const body = await getJson(url);
  if (body?.err) throw new Error(String(body.err));
  if (!Array.isArray(body?.rows)) throw new Error("no rows in response");
  return body.rows;
}

// ---------------------------------------------------------------------- roster

/** OpenDota hero id -> our slug, matched on Valve's internal short name. */
async function heroIdMap() {
  const src = await readFile(join(ROOT, "src", "data", "heroes.ts"), "utf8");
  const bySteam = new Map();
  const re = /\{\s*slug:\s*"([^"]+)",\s*name:\s*"([^"]+)",\s*attr:\s*"[^"]+",\s*steam:\s*"([^"]+)"\s*\}/g;
  let m;
  while ((m = re.exec(src)) !== null) bySteam.set(m[3], { slug: m[1], name: m[2] });
  if (!bySteam.size) throw new Error("could not read src/data/heroes.ts — has its format changed?");

  const heroes = await getJson(`${API}/heroes`);
  const byId = new Map();
  const unmatched = [];
  for (const hero of heroes) {
    const steam = String(hero.name ?? "").replace(/^npc_dota_hero_/, "");
    const known = bySteam.get(steam);
    if (known) byId.set(hero.id, known.slug);
    else unmatched.push(hero.localized_name ?? steam);
  }
  if (unmatched.length) {
    warn(`${unmatched.length} hero(es) on OpenDota are missing from src/data/heroes.ts: ${unmatched.join(", ")}`);
    warn("rerun the Dotabuff scrape to pick them up — they are skipped for now");
  }
  return byId;
}

/**
 * The rank band of positions.json that matches this run's population:
 * `avg_rank_tier` 80 is Immortal and 70 is Divine.
 */
export const bandForMinRank = (minRank) => (minRank >= 80 ? "immortal" : minRank >= 70 ? "divine" : "all");

/** Position shares by slug from positions.json's per-position game counts. */
export function sharesFromCounts(payload, band) {
  const bySlug = new Map();
  for (const [slug, bands] of Object.entries(payload?.heroes ?? {})) {
    const cells = bands?.[band];
    if (!Array.isArray(cells) || cells.length !== 5) continue;
    const total = cells.reduce((n, cell) => n + (Number(cell?.[0]) || 0), 0);
    if (!total) continue;
    bySlug.set(slug, Object.fromEntries(cells.map((cell, i) => [i + 1, (Number(cell?.[0]) || 0) / total])));
  }
  return bySlug;
}

/**
 * Position shares keyed by OpenDota hero id — the only thing the assignment
 * knows. STRATZ's counted positions when positions.json exists, the shares
 * reconstructed from the Dotabuff scrape otherwise, and position-blind totals
 * when there is neither.
 *
 * `source` names where they came from, because a saved run is only resumable
 * under the same source: see `readProgress`.
 */
async function positionPriors(byId) {
  let bySlug = new Map();
  let source = null;

  try {
    const band = bandForMinRank(options.minRank);
    bySlug = sharesFromCounts(JSON.parse(await readFile(POSITIONS_FILE, "utf8")), band);
    if (bySlug.size) source = `stratz:${band}`;
  } catch {
    bySlug = new Map();
  }

  if (!bySlug.size) {
    try {
      const payload = JSON.parse(await readFile(MATCHUP_FILE, "utf8"));
      for (const hero of payload.heroes ?? []) {
        if (hero.positions) bySlug.set(hero.slug, hero.positions);
      }
      if (bySlug.size) source = "dotabuff";
    } catch {
      bySlug = new Map();
    }
  }

  if (!bySlug.size) {
    warn("neither positions.json nor matchups.json carries positions — collecting without position cells");
    warn("run `npm run positions` first to get core/support synergy cells");
    return { priors: null, source: null };
  }

  const priors = new Map();
  for (const [id, slug] of byId) {
    const shares = bySlug.get(slug);
    if (shares) priors.set(id, shares);
  }
  log(`  position priors for ${priors.size}/${byId.size} heroes, from ${source}`);
  return { priors, source };
}

// -------------------------------------------------------------- the aggregate

/**
 * One window of matches, as raw line-ups: five hero ids and who won.
 *
 * This used to aggregate the pairs server-side, which was cheaper to fold but
 * threw away the one thing positions can be recovered from — which four heroes
 * a hero stood *next to*. Position is not in this table at any price (the
 * parsed rows that carry `lane_role` cover roughly 80 player rows per million
 * match ids), so it has to be inferred from the line-up, and that needs the
 * line-up intact. See `scripts/assign.mjs`.
 *
 * The extra traffic is smaller than it looks: the aggregate returned about
 * 8,000 rows per window regardless of width, and two team rows per match comes
 * out within about 25% of that over a full run.
 */
export const windowSql = (lo, hi) => `
  SELECT radiant_team AS t, radiant_win AS w FROM public_matches
  WHERE match_id > ${lo} AND match_id <= ${hi}
    AND lobby_type = 7 AND game_mode = 22
    AND array_length(radiant_team, 1) = 5 AND array_length(dire_team, 1) = 5
    ${options.minRank ? `AND avg_rank_tier >= ${options.minRank}` : ""}
  UNION ALL
  SELECT dire_team, NOT radiant_win FROM public_matches
  WHERE match_id > ${lo} AND match_id <= ${hi}
    AND lobby_type = 7 AND game_mode = 22
    AND array_length(radiant_team, 1) = 5 AND array_length(dire_team, 1) = 5
    ${options.minRank ? `AND avg_rank_tier >= ${options.minRank}` : ""}`;

/** Postgres int arrays arrive as arrays already, but text is worth tolerating. */
const asTeam = (t) => {
  const list = Array.isArray(t)
    ? t
    : typeof t === "string"
      ? t.replace(/[{}]/g, "").split(",")
      : null;
  if (!list || list.length !== 5) return null;
  const team = list.map(Number);
  return team.every(Number.isFinite) ? team : null;
};

/**
 * Below this log-likelihood gap between the best core/support split and the
 * next-best one, a line-up's positions are close to a coin flip.
 *
 * Reported, not enforced — see `fold`. It tells the user how much of their
 * sample the cells rest on a guess for, which is worth knowing and is not
 * worth throwing games away over.
 */
export const AMBIGUOUS_BELOW = 0.5;

const emptyCells = () => ({
  cc: { games: 0, wins: 0 },
  cs: { games: 0, wins: 0 },
  sc: { games: 0, wins: 0 },
  ss: { games: 0, wins: 0 },
});

/**
 * Add one window's line-ups to the running totals, and report how many matches
 * they represent. Exported so the pipeline can be tested end to end against
 * simulated drafts without touching the network.
 *
 * Every team is read twice: once for the flat totals the old aggregate produced,
 * and once through the position assignment, which decides for each of the ten
 * pairs whether it is being seen as two cores, a core and a support, or two
 * supports. The solo baselines have to come from these same games or the
 * residuals are biased, so they are counted here rather than fetched.
 *
 * @param {Map<number, Record<number, number>>} [priors] hero id -> position
 *   shares. Without it the cells are left empty and the output is exactly what
 *   it was before positions existed.
 */
export function fold(rows, totals, priors) {
  let teams = 0;

  for (const row of rows) {
    const team = asTeam(row.t);
    if (!team) continue;
    const won = row.w === true || row.w === "t" || row.w === 1 ? 1 : 0;
    teams++;

    for (const id of team) {
      const entry = totals.heroes.get(id) ?? { games: 0, wins: 0 };
      entry.games++;
      entry.wins += won;
      totals.heroes.set(id, entry);
    }

    /*
     * Positions for every line-up — including the ones the priors are unsure
     * about, which is not the obvious choice and was measured rather than
     * assumed.
     *
     * `assignPositions` always returns *an* answer: it is a maximum over 120
     * permutations, and a maximum exists even when the top two splits are a
     * hair apart. Filing those coin flips into cells is clearly impure, so an
     * earlier version of this refused them — line-ups whose `cellMargin` fell
     * below a threshold were counted in the pair totals and left out of the
     * cells.
     *
     * It made the output worse. Against a simulation with known planted
     * position effects, gating at 0.5 rejected 46% of line-ups and turned an
     * 11% RMSE improvement over having no cells at all into a 7% *regression*:
     * the surviving cells were purer but so much thinner that the write
     * threshold started selecting on noise, and the cells that did get written
     * came out overstated by half again. Dilution from a wrong guess is
     * symmetric and shrinks towards the blend, which is the safe direction;
     * starvation is not.
     *
     * So every line-up is used, and the ambiguity is *reported* instead of
     * acted on — see the run summary. `cellMargin` is still the right measure
     * of it: the cells care only which heroes farmed, so the near-tie between
     * "core A plays 1" and "core A plays 2" is not ambiguity they can see.
     */
    let positions = null;
    if (priors) {
      const assignment = assignPositions(team, priors);
      positions = assignment.positions;
      if (assignment.cellMargin < AMBIGUOUS_BELOW) {
        totals.ambiguous = (totals.ambiguous ?? 0) + 1;
      }
    }

    for (let i = 0; i < 5; i++) {
      for (let j = i + 1; j < 5; j++) {
        // Stored one way round only, smaller id first, so the cell labels mean
        // the same thing every time this pair is seen.
        const [a, b, pa, pb] =
          team[i] < team[j]
            ? [team[i], team[j], positions?.[i], positions?.[j]]
            : [team[j], team[i], positions?.[j], positions?.[i]];
        if (a === b) continue;

        const key = `${a}:${b}`;
        const entry = totals.pairs.get(key) ?? { a, b, games: 0, wins: 0, cells: emptyCells() };
        entry.games++;
        entry.wins += won;
        if (pa && pb) {
          const cell = entry.cells[cellOf(pa, pb)];
          cell.games++;
          cell.wins += won;
        }
        totals.pairs.set(key, entry);
      }
    }
  }

  // Two teams per match.
  return Math.round(teams / 2);
}

// -------------------------------------------------------------------- progress

/**
 * Bumped whenever a saved run stops being resumable. Progress from before the
 * core/support cells has no per-cell counts, and blending it into new windows
 * would leave every cell short of the games its pair claims.
 */
const PROGRESS_SHAPE = 2;

async function readProgress(hasPriors, priorSource) {
  if (options.fresh) return null;
  try {
    const saved = JSON.parse(await readFile(PROGRESS_FILE, "utf8"));
    const stale = staleProgress(saved, { target: options.matches });
    if (stale) {
      log(`  ${stale} — collecting fresh matches`);
      return null;
    }
    if (saved.minRank !== options.minRank) {
      warn(`saved progress used --min-rank=${saved.minRank}; starting over`);
      return null;
    }
    if ((saved.shape ?? 1) !== PROGRESS_SHAPE) {
      warn("saved progress predates the core/support cells; starting over");
      return null;
    }
    /*
     * A run that had no position priors recorded no cells, so its pair totals
     * and its cell totals disagree by construction. Blending that into a run
     * that *does* have priors leaves every cell short of the games its pair
     * claims — the deviation each cell is measured by is taken against a pair
     * figure built from games the cell never saw, and the whole core/support
     * split is biased by however much of the run predated the scrape.
     *
     * The shape version cannot catch this: both runs write shape 2. So the
     * flag is recorded and compared directly.
     */
    if (Boolean(saved.positional) !== Boolean(hasPriors)) {
      warn(
        saved.positional
          ? "saved progress was collected with position priors and this run has none; starting over"
          : "saved progress was collected without position priors; starting over so the cells are whole",
      );
      return null;
    }
    /*
     * The same argument one level down: cells assigned under one set of
     * position shares and cells assigned under another are different
     * measurements, and summing them biases every split by however much of the
     * run came from each. Runs saved before sources were recorded used the
     * Dotabuff reconstruction.
     */
    const savedSource = saved.positional ? (saved.priorSource ?? "dotabuff") : null;
    if (hasPriors && savedSource !== priorSource) {
      warn(`saved progress assigned positions from ${savedSource}, this run uses ${priorSource}; starting over`);
      return null;
    }
    return saved;
  } catch {
    return null;
  }
}

async function writeProgress(totals, cursor, matches, newest, positional, priorSource) {
  await mkdir(dirname(PROGRESS_FILE), { recursive: true });
  await writeFile(
    PROGRESS_FILE,
    JSON.stringify({
      cursor,
      matches,
      newest,
      minRank: options.minRank,
      shape: PROGRESS_SHAPE,
      /** Whether this run was cutting pairs into cells — see `readProgress`. */
      positional,
      priorSource,
      savedAt: new Date().toISOString(),
      ambiguous: totals.ambiguous ?? 0,
      heroes: [...totals.heroes].map(([id, t]) => [id, t.games, t.wins]),
      pairs: [...totals.pairs.values()].map((p) => [
        p.a,
        p.b,
        p.games,
        p.wins,
        ...CELLS.flatMap((c) => [p.cells[c].games, p.cells[c].wins]),
      ]),
    }),
    "utf8",
  );
}

function restore(saved) {
  const totals = { heroes: new Map(), pairs: new Map(), ambiguous: saved.ambiguous ?? 0 };
  for (const [id, games, wins] of saved.heroes ?? []) totals.heroes.set(Number(id), { games, wins });
  for (const [a, b, games, wins, ...cellCounts] of saved.pairs ?? []) {
    const cells = emptyCells();
    CELLS.forEach((c, i) => {
      cells[c] = { games: cellCounts[i * 2] ?? 0, wins: cellCounts[i * 2 + 1] ?? 0 };
    });
    totals.pairs.set(`${a}:${b}`, { a: Number(a), b: Number(b), games, wins, cells });
  }
  return totals;
}

// ------------------------------------------------------------------------ main

async function newestMatchId() {
  // ORDER BY on the primary key, so this is an index read rather than a scan.
  const rows = await explorer("SELECT match_id FROM public_matches ORDER BY match_id DESC LIMIT 1");
  const id = Number(rows[0]?.match_id);
  if (!Number.isFinite(id)) throw new Error("could not read the newest match id");
  return id;
}

async function collect() {
  const byId = await heroIdMap();
  log(`  mapped ${byId.size} heroes from OpenDota ids`);
  const { priors, source: priorSource } = await positionPriors(byId);

  const saved = await readProgress(Boolean(priors), priorSource);
  const totals = saved ? restore(saved) : { heroes: new Map(), pairs: new Map(), ambiguous: 0 };
  let matches = saved?.matches ?? 0;
  let newest = saved?.newest ?? (await newestMatchId());
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
      // A timeout means the window was too wide for the statement budget.
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
    const found = fold(rows, totals, priors);
    matches += found;
    cursor = lo;

    if (options.probe) {
      log(`\n  probe: ${found.toLocaleString()} matches from ${width.toLocaleString()} ids in ${elapsed}ms`);
      log(`  ${rows.length} team rows, ${totals.pairs.size} distinct pairs`);
      const perThousand = (found / width) * 1000;
      log(`  density ≈ ${perThousand.toFixed(1)} matches per 1,000 ids`);
      log(`  ${options.matches.toLocaleString()} matches ≈ ${Math.ceil(options.matches / Math.max(1, found))} more requests at this width`);
      return { totals, byId, priors, priorSource, matches, newest, cursor };
    }

    if (found === 0 && ++emptyWindows >= 5) {
      warn("five windows in a row came back empty — stopping");
      break;
    }
    if (found > 0) emptyWindows = 0;

    // Aim for windows that take a few seconds: fast enough to stay well inside
    // the statement timeout, wide enough not to spend the run on round trips.
    if (elapsed < 4_000) width = Math.min(width * 2, 2_000_000);
    else if (elapsed > 20_000) width = Math.max(2_000, Math.floor(width / 2));

    progress(matches, options.matches, `${totals.pairs.size} pairs, window ${width.toLocaleString()} ids, ${(elapsed / 1000).toFixed(1)}s`);
    await writeProgress(totals, cursor, matches, newest, Boolean(priors), priorSource);
    await sleep(options.delay);
  }

  if (process.stdout.isTTY) process.stdout.write("\n");
  return { totals, byId, priors, priorSource, matches, newest, cursor };
}

async function main() {
  const started = Date.now();
  log("OpenDota synergy collector");
  log(`  target: ${options.matches.toLocaleString()} ranked all-draft matches`);
  if (options.minRank) log(`  rank filter: avg_rank_tier >= ${options.minRank}`);
  if (!options.key) log("  no API key (set OPENDOTA_API_KEY if you hit rate limits)");
  log("");

  const { totals, byId, priors, priorSource, matches, cursor, newest } = await collect();
  if (options.probe) return;
  if (!matches) throw new Error("no matches collected — nothing written");

  // Translate hero ids to slugs, dropping anything we cannot name.
  const heroes = new Map();
  for (const [id, t] of totals.heroes) {
    const slug = byId.get(id);
    if (slug) heroes.set(slug, t);
  }
  const pairs = new Map();
  for (const p of totals.pairs.values()) {
    const a = byId.get(p.a);
    const b = byId.get(p.b);
    if (!a || !b) continue;
    // Store one direction only; the app mirrors it on load. The ids were
    // already ordered when folded, so the cells need no flipping here — but the
    // slugs may sort the other way, and then the mixed cells must swap with it.
    const [x, y] = a < b ? [a, b] : [b, a];
    const cells =
      a < b ? p.cells : { cc: p.cells.cc, cs: p.cells.sc, sc: p.cells.cs, ss: p.cells.ss };
    pairs.set(`${x}|${y}`, { a: x, b: y, games: p.games, wins: p.wins, cells });
  }

  const result = buildSynergies(heroes, pairs, { minGames: options.minGames });

  const round3 = (n) => Math.round(n * 1000) / 1000;
  const table = {};
  let withCells = 0;
  for (const row of result.pairs) {
    const entry = [round3(row.synergy), row.games, Math.round(row.winRate * 100) / 100];
    if (row.cells) {
      // Only the cells that moved are written; the reader falls back to the
      // pair's overall figure for the rest, which keeps the file honest about
      // where it actually knows something.
      entry.push(
        Object.fromEntries(
          Object.entries(row.cells).map(([cell, c]) => [cell, [round3(c.synergy), c.games]]),
        ),
      );
      withCells++;
    }
    (table[row.a] ??= {})[row.b] = entry;
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    source: "https://api.opendota.com/api/explorer (public_matches)",
    note:
      "synergies[a][b] = [synergy, games, winRate, cells?], stored once with a < b. " +
      "synergy is percentage points of win rate the pair adds beyond what both " +
      "heroes contribute on their own, shrunk towards zero by sample size. " +
      "cells splits that by whether each hero farmed — cc/cs/sc/ss, read in the " +
      "stored a-then-b order, each [synergy, games] — with positions inferred " +
      "per line-up from the position shares named in positionsFrom. Only cells that disagree " +
      "with the pair's overall figure are written; anything absent falls back " +
      "to it. Ranked all-draft only (lobby_type 7, game_mode 22).",
    matches,
    matchIdRange: [cursor, newest],
    minRank: options.minRank || null,
    minGames: options.minGames,
    positionsFrom: priorSource,
    synergies: table,
  };

  await mkdir(dirname(OUT_FILE), { recursive: true });
  await writeFile(OUT_FILE, JSON.stringify(payload), "utf8");

  const best = result.pairs.slice(0, 5);
  const worst = result.pairs.slice(-5).reverse();
  const label = (r) => `${r.a} + ${r.b}`;

  log(`\nWrote public/data/synergies.json`);
  log(`  ${matches.toLocaleString()} matches, ${result.pairs.length} pairs kept, ${result.skipped} below --min-games=${options.minGames}`);
  log(`  real spread ${result.signalSd.toFixed(2)}pp vs noise ${result.noiseSd.toFixed(2)}pp`);
  if (priors) {
    log(`  ${withCells}/${result.pairs.length} pairs carry a core/support cell that moved the number`);
    const ambiguous = totals.ambiguous ?? 0;
    if (ambiguous) {
      const share = (100 * ambiguous) / Math.max(1, matches * 2);
      log(
        `  ${ambiguous.toLocaleString()} line-ups (${share.toFixed(1)}%) were near coin flips to ` +
          "position — still counted, but their cells are a guess",
      );
      if (share > 60) {
        warn(
          "most line-ups could not be positioned confidently, so the core/support cells are " +
            "diluted towards each pair's blended figure. Rerun `npm run positions` so the " +
            "position priors are current.",
        );
      }
    }
    if (!withCells) {
      warn("no cell disagreed with its pair — either positions are flat here or the sample is thin");
    }
  } else {
    warn("collected without positions — synergy is blind to core/support");
  }
  if (result.signalSd < result.noiseSd / 2) {
    warn("noise dominates — collect more matches before trusting individual pairs");
  }
  log(`  ${((Date.now() - started) / 1000) | 0}s\n`);
  log("  strongest pairings");
  for (const r of best) log(`    ${label(r).padEnd(38)} ${r.synergy >= 0 ? "+" : "−"}${Math.abs(r.synergy).toFixed(2)}pp  (${r.games.toLocaleString()} games)`);
  log("  weakest pairings");
  for (const r of worst) log(`    ${label(r).padEnd(38)} ${r.synergy >= 0 ? "+" : "−"}${Math.abs(r.synergy).toFixed(2)}pp  (${r.games.toLocaleString()} games)`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(`\nSynergy collection failed: ${err.message}\n`);
    if (/HTTP 429|rate/i.test(err.message)) {
      console.error("  OpenDota rate-limited the run. Wait a minute, then rerun — progress is");
      console.error("  saved after every window, so it picks up where it stopped. A free API key");
      console.error("  from https://www.opendota.com/api-keys raises the limit:");
      console.error("    OPENDOTA_API_KEY=... npm run synergy\n");
    } else {
      console.error("  Try `npm run synergy -- --probe` to see what one window returns.\n");
    }
    process.exit(1);
  });
}
