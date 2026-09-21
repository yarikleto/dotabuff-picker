#!/usr/bin/env node
/**
 * Builds public/data/lanes.json — how each hero's laning stage goes against,
 * and beside, every other hero, from STRATZ.
 *
 *   npm run lanes                               # the last 4 complete weeks, every rank
 *   npm run lanes -- --weeks=8                  # a longer window, more lanes per pair
 *   npm run lanes -- --bracket=DIVINE_IMMORTAL  # one rank band (comma-separated for several)
 *   npm run lanes -- --min-lanes=200            # leave out thinner pairs
 *   npm run lanes -- --probe                    # one request, print what came back, stop
 *   npm run lanes -- --offline                  # rebuild the file from cache, no network
 *   npm run lanes -- --fresh                    # ignore the cache and refetch every week
 *
 * Every other lane figure the picker has is a whole-game number arranged by
 * lane. STRATZ classifies the laning stage itself: a win, a draw or a loss for
 * a hero against each opponent in the same lane, and beside each partner. Only
 * the opponents are published — nothing in the app reads the partners yet —
 * but both are cached, so publishing them is a rebuild with --offline.
 *
 * Needs a STRATZ API token — docs/refreshing-data.md says where it lives.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  StratzError,
  WEEK_SECONDS,
  completeWeeks,
  createClient,
  isoDay,
  loadHeroIds,
  readToken,
  weekEndMs,
  weekStartMs,
} from "./stratz.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_FILE = join(ROOT, "public", "data", "lanes.json");
const CACHE_DIR = join(ROOT, "scripts", ".cache", "stratz");

const DAY_MS = 24 * 60 * 60 * 1000;
export const POSITIONS = [1, 2, 3, 4, 5];
export const DIRECTIONS = ["against", "with"];
export const BRACKETS = ["HERALD_GUARDIAN", "CRUSADER_ARCHON", "LEGEND_ANCIENT", "DIVINE_IMMORTAL"];
export const MAX_WEEKS = 26;

/**
 * STRATZ aggregates behind the games — two days into a week it held 7% of a
 * full week's lanes — so a week that closed recently may still be filling in.
 * Younger weeks are refetched every run; older ones come from cache for good.
 */
const SETTLE_DAYS = 7;
/** A still-settling week is reused this long, so rerunning after a failure is cheap. */
const UNSETTLED_TTL_HOURS = 12;

/** Shipped inside the JSON so the file explains itself to whoever opens it. */
export const NOTE =
  "against[a][pos][b] = [lanes, wins, draws, losses, gameWins] for hero a playing position " +
  "pos against b in the same lane, counted from a's side. lanes is STRATZ's matchCount for " +
  "the pair and gameWins the games a won out of those lanes; wins + draws + losses come to " +
  "about 86% of lanes, 70-95% " +
  "depending on the pair, and STRATZ does not say what the rest is, so a lane win rate is " +
  "(wins + draws / 2) / (wins + draws + losses). b's own position is not recorded. Pairs " +
  "with fewer than minLanes wins + draws + losses are left out.";

// ---------------------------------------------------------------- CLI options

export function parseBrackets(value) {
  const names = String(value ?? "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  for (const name of names) {
    if (!BRACKETS.includes(name)) {
      throw new StratzError(`unknown --bracket "${name}" — pick from ${BRACKETS.join(", ")}`);
    }
  }
  return [...new Set(names)].sort((a, b) => BRACKETS.indexOf(a) - BRACKETS.indexOf(b));
}

export function readOptions(argv) {
  const flag = (name) => argv.includes(`--${name}`);
  const opt = (name, fallback) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : fallback;
  };
  const whole = (name, fallback, min, max) => {
    const n = Number(opt(name, fallback));
    if (!Number.isInteger(n) || n < min || n > max) {
      throw new StratzError(`--${name} must be a whole number from ${min} to ${max}`);
    }
    return n;
  };
  if (flag("probe") && flag("offline")) {
    throw new StratzError("--probe asks STRATZ a question, so it cannot run --offline");
  }
  return {
    weeks: whole("weeks", 4, 1, MAX_WEEKS),
    brackets: parseBrackets(opt("bracket", "")),
    minLanes: whole("min-lanes", 50, 0, 1_000_000),
    delay: whole("delay", 400, 0, 60_000),
    fresh: flag("fresh"),
    offline: flag("offline"),
    probe: flag("probe"),
  };
}

// ---------------------------------------------------------------------- weeks

export const isSettled = (week, nowMs) => nowMs - weekEndMs(week) >= SETTLE_DAYS * DAY_MS;

// ------------------------------------------------------------------ requests

/**
 * Every request a run makes: one per week, position and direction, each
 * covering all heroes at once. Four weeks is forty requests.
 */
export function planRequests(weeks, brackets) {
  const band = brackets.length ? brackets.map((b) => b.toLowerCase()).join("+") : "all";
  const requests = [];
  for (const week of weeks) {
    for (const position of POSITIONS) {
      for (const direction of DIRECTIONS) {
        requests.push({
          week,
          position,
          direction,
          brackets,
          cacheKey: `lanes-${band}-w${week}-p${position}-${direction}`,
        });
      }
    }
  }
  return requests;
}

/**
 * Rows are filed under what was *asked for*. The response also has `position`
 * and `bracketBasicIds` fields, but they read POSITION_1 and UNCALIBRATED
 * whatever the filter was, so they are not requested at all.
 */
export const LANES_QUERY = `query Lanes($week: Long!, $isWith: Boolean!, $positions: [MatchPlayerPositionType], $brackets: [RankBracketBasicEnum]) {
  heroStats {
    laneOutcome(week: $week, isWith: $isWith, positionIds: $positions, bracketBasicIds: $brackets) {
      heroId1 heroId2 matchCount winCount drawCount lossCount matchWinCount stompWinCount stompLossCount
    }
  }
}`;

export const laneVariables = ({ week, position, direction, brackets }) => ({
  // The argument is the week's first second; the response's `week` field is a week number.
  week: week * WEEK_SECONDS,
  isWith: direction === "with",
  positions: [`POSITION_${position}`],
  brackets: brackets.length ? brackets : null,
});

const CORE_FIELDS = ["heroId1", "heroId2", "matchCount", "winCount", "drawCount", "lossCount"];
/** Only matchWinCount is published; the stomps are cached so publishing them later needs no refetch. */
const EXTRA_FIELDS = ["matchWinCount", "stompWinCount", "stompLossCount"];

/** Response rows as arrays in CORE_FIELDS then EXTRA_FIELDS order; malformed rows are dropped. */
export function compactRows(rows) {
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const core = CORE_FIELDS.map((field) => row?.[field]);
    if (!core.every((v) => Number.isInteger(v) && v >= 0)) continue;
    const extra = EXTRA_FIELDS.map((field) => (Number.isInteger(row?.[field]) ? row[field] : 0));
    out.push([...core, ...extra]);
  }
  return out;
}

// ------------------------------------------------------------- the aggregate

export function foldLanes(totals, { position, direction }, rows) {
  for (const [hero, other, matches, wins, draws, losses, gameWins = 0] of rows) {
    const key = `${direction}:${position}:${hero}:${other}`;
    const cell =
      totals.get(key) ??
      { direction, position, hero, other, matches: 0, wins: 0, draws: 0, losses: 0, gameWins: 0 };
    cell.matches += matches;
    cell.wins += wins;
    cell.draws += draws;
    cell.losses += losses;
    cell.gameWins += gameWins;
    totals.set(key, cell);
  }
}

/** Totals -> the two published tables, keyed by slug and sorted so reruns diff cleanly. */
export function buildLanes(totals, byId, { minLanes = 50 } = {}) {
  const tables = { against: {}, with: {} };
  const unknown = new Set();
  let kept = 0;
  let thin = 0;

  const cells = [];
  for (const cell of totals.values()) {
    const a = byId.get(cell.hero);
    const b = byId.get(cell.other);
    if (!a) unknown.add(cell.hero);
    if (!b) unknown.add(cell.other);
    if (a && b && a !== b) cells.push({ ...cell, a, b });
  }
  cells.sort((x, y) => x.a.localeCompare(y.a) || x.position - y.position || x.b.localeCompare(y.b));

  for (const cell of cells) {
    if (cell.wins + cell.draws + cell.losses < minLanes) {
      thin++;
      continue;
    }
    const byPosition = (tables[cell.direction][cell.a] ??= {});
    (byPosition[cell.position] ??= {})[cell.b] = [cell.matches, cell.wins, cell.draws, cell.losses, cell.gameWins];
    kept++;
  }
  return { against: tables.against, with: tables.with, kept, thin, unknown: [...unknown].sort((x, y) => x - y) };
}

export function isReusable(entry, nowMs) {
  if (!entry || !Array.isArray(entry.rows) || !entry.rows.length) return false;
  if (isSettled(entry.week, nowMs)) return true;
  const fetched = Date.parse(entry.fetchedAt);
  return Number.isFinite(fetched) && nowMs - fetched < UNSETTLED_TTL_HOURS * 60 * 60 * 1000;
}

// -------------------------------------------------------------------- network

const log = (...a) => console.log(...a);
const warn = (...a) => console.warn("  !", ...a);
const cacheFile = (key) => join(CACHE_DIR, `${key}.json`);

async function readJsonFile(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function writeJsonFile(file, value) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value), "utf8");
}

async function fetchLanes(client, request) {
  const data = await client.query(LANES_QUERY, laneVariables(request));
  const rows = compactRows(data?.heroStats?.laneOutcome);
  // An empty closed week is an outage rather than a quiet week, and caching it would publish a hole.
  if (!rows.length) throw new StratzError("STRATZ returned no lane rows");
  return {
    week: request.week,
    position: request.position,
    direction: request.direction,
    brackets: request.brackets,
    fetchedAt: new Date().toISOString(),
    rows,
  };
}

const describe = (r) => `week ${r.week} pos ${r.position} ${r.direction}`;
const pct = (x) => `${(x * 100).toFixed(1)}%`;

function progress(done, total, label) {
  const width = 24;
  const bar = "#".repeat(Math.round((done / total) * width)).padEnd(width, ".");
  const line = `  [${bar}] ${String(done).padStart(3)}/${total}  ${label}`;
  if (process.stdout.isTTY) process.stdout.write(`\r${line.padEnd(80)}`);
  else log(line);
}

async function probe(client, byId, options, week) {
  const request = { week, position: 3, direction: "against", brackets: options.brackets };
  const started = Date.now();
  const { rows } = await fetchLanes(client, request);
  const lanes = rows.reduce((n, r) => n + r[2], 0);
  const decided = rows.reduce((n, r) => n + r[3] + r[4] + r[5], 0);
  log(`\n  probe: ${describe(request)} — ${rows.length} pairs, ${lanes.toLocaleString()} lanes, ` +
    `${pct(decided / Math.max(1, lanes))} of them won, drawn or lost, ${Date.now() - started}ms`);
  for (const [hero, other, n, w, d, l] of [...rows].sort((x, y) => y[2] - x[2]).slice(0, 5)) {
    const name = (id) => byId.get(id) ?? `#${id}`;
    log(`    ${name(hero).padEnd(20)} vs ${name(other).padEnd(20)} ${String(n).padStart(7)} lanes  ` +
      `won ${pct(w / (w + d + l))}  drew ${pct(d / (w + d + l))}  lost ${pct(l / (w + d + l))}`);
  }
  log("");
}

/**
 * The best and worst laners in each position, as a smell test: if these are
 * not the heroes the game knows as lane bullies and lane victims, something
 * upstream is wrong and it is better seen now than in a draft.
 */
function sanityRead(against) {
  const floor = 2000;
  log("\n  lane win rate by position, best and worst (heroes with 2,000+ lanes won, drawn or lost)");
  for (const position of POSITIONS) {
    const records = [];
    for (const [slug, byPosition] of Object.entries(against)) {
      let w = 0;
      let d = 0;
      let l = 0;
      for (const [, wins, draws, losses] of Object.values(byPosition[position] ?? {})) {
        w += wins;
        d += draws;
        l += losses;
      }
      if (w + d + l >= floor) records.push([slug, (w + d / 2) / (w + d + l)]);
    }
    records.sort((x, y) => y[1] - x[1]);
    const show = (list) => list.map(([slug, rate]) => `${slug} ${pct(rate)}`).join(", ");
    log(`    pos ${position}  best: ${show(records.slice(0, 3))}`);
    log(`           worst: ${show(records.slice(-3).reverse())}`);
  }
}

// ------------------------------------------------------------------------ main

export async function main(argv = process.argv.slice(2)) {
  const options = readOptions(argv);
  const started = Date.now();
  const now = Date.now();
  const weeks = completeWeeks(now, options.weeks);
  const band = options.brackets.length ? options.brackets.join(", ") : "every rank";

  log("\nCollecting lane outcomes from STRATZ\n");
  const client = options.offline ? null : createClient({ token: readToken(), spacing: options.delay });
  const byId = await loadHeroIds({
    client,
    rosterFile: join(ROOT, "src", "data", "heroes.ts"),
    cacheFile: cacheFile("heroes"),
    warn,
  });
  log(`  mapped ${byId.size} heroes from STRATZ ids`);

  if (options.probe) {
    await probe(client, byId, options, weeks.at(-1));
    return 0;
  }

  const requests = planRequests(weeks, options.brackets);
  log(`  weeks ${weeks[0]}–${weeks.at(-1)} (${isoDay(weekStartMs(weeks[0]))} to ` +
    `${isoDay(weekEndMs(weeks.at(-1)) - 1)}), ${band}, ${requests.length} requests\n`);

  const totals = new Map();
  const failed = [];
  let fetched = 0;
  let reused = 0;

  for (const [i, request] of requests.entries()) {
    const cached = options.fresh ? null : await readJsonFile(cacheFile(request.cacheKey));
    let entry = cached && (options.offline ? cached.rows?.length : isReusable(cached, now)) ? cached : null;

    if (entry) {
      reused++;
    } else if (options.offline) {
      failed.push({ request, message: "not in the cache" });
      continue;
    } else {
      try {
        entry = await fetchLanes(client, request);
        await writeJsonFile(cacheFile(request.cacheKey), entry);
        fetched++;
      } catch (err) {
        failed.push({ request, message: err.message });
        if (err.fatal) break;
        continue;
      }
    }
    foldLanes(totals, request, entry.rows);
    progress(i + 1, requests.length, `${fetched} fetched, ${reused} from cache`);
  }
  if (process.stdout.isTTY) log("");

  // All or nothing: a file built from some of the weeks would read as complete
  // and quietly carry less than the one it replaced.
  if (failed.length) {
    const file = relative(ROOT, OUT_FILE);
    log(`\n  ${failed.length} of ${requests.length} requests failed, so ${file} was left as it was.`);
    for (const { request, message } of failed.slice(0, 5)) warn(`${describe(request)}: ${message}`);
    if (failed.length > 5) warn(`…and ${failed.length - 5} more`);
    log("\n  Everything that did arrive is cached; rerun and only the rest is fetched.\n");
    return 1;
  }

  const built = buildLanes(totals, byId, { minLanes: options.minLanes });
  const payload = {
    generatedAt: new Date().toISOString(),
    source: "https://api.stratz.com/graphql (heroStats.laneOutcome)",
    note: NOTE,
    weeks,
    period: [isoDay(weekStartMs(weeks[0])), isoDay(weekEndMs(weeks.at(-1)) - 1)],
    brackets: options.brackets.length ? options.brackets : null,
    minLanes: options.minLanes,
    against: built.against,
  };
  await writeJsonFile(OUT_FILE, payload);

  log(`\nWrote ${relative(ROOT, OUT_FILE)}`);
  const published = Object.values(built.against).reduce(
    (n, bySeat) => n + Object.values(bySeat).reduce((m, t) => m + Object.keys(t).length, 0),
    0,
  );
  log(`  ${published.toLocaleString()} pairs published, ${built.thin.toLocaleString()} below --min-lanes=${options.minLanes}` +
    (built.unknown.length ? `, ${built.unknown.length} STRATZ hero id(s) not in the roster` : ""));
  log(`  ${fetched} requests fetched, ${reused} read from cache`);
  sanityRead(built.against);
  log(`\n  ${((Date.now() - started) / 1000) | 0}s\n`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(`\nLane collection failed: ${err.message}\n`);
      process.exit(1);
    },
  );
}
