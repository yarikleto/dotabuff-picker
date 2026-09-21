#!/usr/bin/env node
/**
 * Builds public/data/positions.json — how often each hero plays each position
 * and how often they win there, as STRATZ counts it, for three rank bands.
 *
 *   npm run positions               # the last 4 complete weeks
 *   npm run positions -- --weeks=8  # a longer window
 *   npm run positions -- --offline  # rebuild the file from the last run's cache
 *
 * Without this file the picker reconstructs positions from Dotabuff's lane
 * tables (lane presence plus a GPM split), which misfiles about 15% of a
 * typical hero's games — docs/scoring.md, "Where positions come from".
 *
 * All three bands are collected every run so the app can switch between them
 * without a new collection. Ranked All Pick only, like every other data set.
 *
 * Needs a STRATZ API token — docs/refreshing-data.md says where it lives.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  StratzError,
  completeWeeks,
  createClient,
  isoDay,
  loadHeroIds,
  readToken,
  weekEndMs,
  weekStartMs,
  WEEK_SECONDS,
} from "./stratz.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_FILE = join(ROOT, "public", "data", "positions.json");
const CACHE_DIR = join(ROOT, "scripts", ".cache", "stratz");
const HERO_CACHE = join(CACHE_DIR, "heroes.json");
const responseCache = (band, position) => join(CACHE_DIR, `positions-${band}-p${position}.json`);

export const POSITIONS = [1, 2, 3, 4, 5];

/** The keys the app's rank switch offers, and the STRATZ brackets behind each. */
export const BANDS = [
  { key: "all", brackets: null },
  { key: "divine", brackets: ["DIVINE", "IMMORTAL"] },
  { key: "immortal", brackets: ["IMMORTAL"] },
];

/**
 * Left unfiltered, STRATZ counts Turbo and unranked All Pick too — about a
 * fifth of Dragon Knight's mid games in one week.
 */
export const GAME_MODES = ["ALL_PICK_RANKED"];

/** `winWeek` has no week filter and returns every week it keeps, so it is paged. */
export const PAGE = 5000;

export const NOTE =
  "heroes[slug][band] = one [games, wins] pair per position, 1 to 5, summed over the weeks " +
  "listed, ranked All Pick only. bands names the STRATZ rank brackets behind each key. " +
  "All three bands ship so the app can switch between them without a new collection.";

export const POSITIONS_QUERY = `query Positions($positions: [MatchPlayerPositionType], $brackets: [RankBracket], $modes: [GameModeEnumType], $take: Int, $skip: Int) {
  heroStats {
    winWeek(positionIds: $positions, bracketIds: $brackets, gameModeIds: $modes, take: $take, skip: $skip) {
      week heroId matchCount winCount
    }
  }
}`;

export function readOptions(argv) {
  const hit = argv.find((a) => a.startsWith("--weeks="));
  const weeks = Number(hit ? hit.slice("--weeks=".length) : 4);
  if (!Number.isInteger(weeks) || weeks < 1 || weeks > 12) {
    throw new StratzError("--weeks must be a whole number from 1 to 12");
  }
  return { weeks, offline: argv.includes("--offline") };
}

/**
 * The rows for one band and position: from STRATZ, saved for next time, or —
 * with --offline — from what the last run saved.
 */
async function rowsFor(client, band, position) {
  const file = responseCache(band.key, position);
  if (!client) {
    try {
      return JSON.parse(await readFile(file, "utf8")).rows;
    } catch {
      throw new StratzError(`--offline has no cached ${band.key} rows for position ${position}: run once online first.`);
    }
  }
  const rows = await fetchAllRows(client, band, position);
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(file, JSON.stringify({ fetchedAt: new Date().toISOString(), rows }), "utf8");
  return rows;
}

/** Every row for one band and position, however many pages that takes. */
export async function fetchAllRows(client, band, position) {
  const rows = [];
  for (let skip = 0; ; skip += PAGE) {
    const data = await client.query(POSITIONS_QUERY, {
      positions: [`POSITION_${position}`],
      brackets: band.brackets,
      modes: GAME_MODES,
      take: PAGE,
      skip,
    });
    const page = data?.heroStats?.winWeek;
    if (!Array.isArray(page)) throw new StratzError("STRATZ returned no winWeek rows");
    rows.push(...page);
    if (page.length < PAGE) return rows;
  }
}

/**
 * Add one response to the table, keeping only the weeks asked for. The row's
 * position is the one requested: `winWeek` rows do not carry one.
 * Returns how many games the response contributed.
 */
export function foldWinWeek(table, { band, position, rows, weeks, byId }) {
  const wanted = new Set(weeks.map((week) => week * WEEK_SECONDS));
  let games = 0;
  for (const row of rows) {
    if (!wanted.has(row?.week)) continue;
    const slug = byId.get(row.heroId);
    const matches = row.matchCount;
    const wins = row.winCount;
    if (!slug || !Number.isInteger(matches) || !Number.isInteger(wins) || matches < 0 || wins < 0) continue;
    const perBand = (table[slug] ??= {});
    const cells = (perBand[band] ??= POSITIONS.map(() => [0, 0]));
    cells[position - 1][0] += matches;
    cells[position - 1][1] += wins;
    games += matches;
  }
  return games;
}

/** Slugs in order, so reruns diff cleanly. */
export const sortTable = (table) =>
  Object.fromEntries(Object.keys(table).sort().map((slug) => [slug, table[slug]]));

/** "1(81%)/2(12%)" — the positions holding at least 12% of a hero's games, commonest first. */
export function describePositions(cells) {
  const total = cells.reduce((n, [games]) => n + games, 0);
  if (!total) return "no games";
  return POSITIONS.map((p) => [p, cells[p - 1][0] / total])
    .filter(([, share]) => share >= 0.12)
    .sort((a, b) => b[1] - a[1])
    .map(([p, share]) => `${p}(${Math.round(share * 100)}%)`)
    .join("/");
}

const log = (...a) => console.log(...a);
const warn = (...a) => console.warn("  !", ...a);

/** Heroes nobody argues about, so a bad collection shows before it reaches a draft. */
const SANITY = ["anti-mage", "crystal-maiden", "invoker", "axe", "shadow-fiend", "lion"];

export async function main(argv = process.argv.slice(2)) {
  const options = readOptions(argv);
  const started = Date.now();
  const weeks = completeWeeks(Date.now(), options.weeks);

  log("\nCollecting positions from STRATZ\n");
  const client = options.offline ? null : createClient({ token: readToken() });
  const byId = await loadHeroIds({
    client,
    rosterFile: join(ROOT, "src", "data", "heroes.ts"),
    cacheFile: HERO_CACHE,
    warn,
  });
  log(`  mapped ${byId.size} heroes from STRATZ ids`);
  log(`  weeks ${weeks[0]}–${weeks.at(-1)} (${isoDay(weekStartMs(weeks[0]))} to ` +
    `${isoDay(weekEndMs(weeks.at(-1)) - 1)}), ${BANDS.length} bands × ${POSITIONS.length} positions\n`);

  const table = {};
  for (const band of BANDS) {
    for (const position of POSITIONS) {
      const rows = await rowsFor(client, band, position);
      const games = foldWinWeek(table, { band: band.key, position, rows, weeks, byId });
      // A position with no games in the weeks asked for is an outage, and
      // writing it would tell the app that nobody plays that seat.
      if (!games) throw new StratzError(`STRATZ returned no ${band.key} games at position ${position}`);
      log(`  ${band.key.padEnd(9)} pos ${position}  ${games.toLocaleString().padStart(12)} hero-games`);
    }
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    source: "https://api.stratz.com/graphql (heroStats.winWeek)",
    note: NOTE,
    weeks,
    period: [isoDay(weekStartMs(weeks[0])), isoDay(weekEndMs(weeks.at(-1)) - 1)],
    gameModes: GAME_MODES,
    bands: Object.fromEntries(BANDS.map((b) => [b.key, b.brackets])),
    heroes: sortTable(table),
  };
  await mkdir(dirname(OUT_FILE), { recursive: true });
  await writeFile(OUT_FILE, JSON.stringify(payload), "utf8");

  log(`\nWrote ${relative(ROOT, OUT_FILE)} — ${Object.keys(table).length} heroes`);
  for (const band of BANDS) {
    const line = SANITY.map((slug) => `${slug} ${table[slug]?.[band.key] ? describePositions(table[slug][band.key]) : "missing"}`);
    log(`  ${band.key.padEnd(9)} ${line.join(", ")}`);
  }
  log(`\n  ${((Date.now() - started) / 1000) | 0}s\n`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(`\nPosition collection failed: ${err.message}\n`);
      process.exit(1);
    },
  );
}
