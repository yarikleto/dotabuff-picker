#!/usr/bin/env node
/**
 * Builds public/data/calibration.json — the weights that turn a draft into a
 * win chance, fitted on real games.
 *
 *   npm run calibrate                      # ~300k ranked games older than the synergy and timing samples
 *   npm run calibrate -- --matches=500000  # a bigger sample
 *   npm run calibrate -- --window=400000   # starting id window
 *   npm run calibrate -- --delay=1500      # ms between requests
 *   npm run calibrate -- --timeout=120000  # ms per request
 *   npm run calibrate -- --key=…           # OpenDota API key (OPENDOTA_API_KEY also works)
 *   npm run calibrate -- --fresh           # ignore the cached line-ups
 *   npm run calibrate -- --dry-run         # fit and report, write nothing
 *
 * A reused cache can hold more games than --matches and all of them are used.
 *
 * The features come from src/lib/winModel.ts — the arithmetic the app runs — so
 * this script needs the TypeScript loader, which `npm run calibrate` supplies.
 * The games are the ones just older than the synergy and timing samples, so no
 * weight is fitted on the games those figures were measured on. See
 * docs/scoring.md, "Win chance".
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assignPositions } from "./assign.mjs";
import { calibrationProblems, calibrationWindow, fitCalibration } from "./calibrate-math.mjs";
import { BASE_HEROES } from "../src/data/heroes.ts";
import { buildDataset } from "../src/lib/dataset.ts";
import { withRankBand } from "../src/lib/positions.ts";
import { WIN_FEATURES, draftFeatures, readCalibration, winFeatures, winRead } from "../src/lib/winModel.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(ROOT, "public", "data");
const OUT_FILE = join(DATA, "calibration.json");
const CACHE_FILE = join(ROOT, "scripts", ".cache", "calibration-matches.json");
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
  window: Number(opt("window", 400_000)),
  delay: Number(opt("delay", 1500)),
  timeout: Number(opt("timeout", 120_000)),
  fresh: flag("fresh"),
  dryRun: flag("dry-run"),
  key: opt("key", process.env.OPENDOTA_API_KEY || ""),
};

/**
 * The rank band the features are read at. Written into the file, and the app
 * reads every chance at it whatever band its Tuning shows — see `modelData` in
 * src/lib/winModel.ts.
 */
const RANK_BAND = "all";
/** Candidates for the role-deficit threshold, in points per hero. */
const TAUS = [0.5, 1, 1.5, 2, 2.5, 3];
/** Weights no draft could explain the negative of: more of these never loses games. */
const POSITIVE = ["matchups", "cohesion", "heroes", "seatPenalty", "seatBonus"];

/**
 * Drafts printed after every fit, so a refresh shows what the model now says
 * about cases a player can judge. Booked in the order listed, positions 1 to 5.
 * They are the spec's sanity cases; nothing asserts on them here.
 */
const SANITY = [
  ["Five cores, as booked", ["anti-mage", "meepo", "sven", "lifestealer", "arc-warden"], ["leshrac", "lina", "enigma", "bounty-hunter", "earthshaker"]],
  ["Same enemy, a sound five", ["anti-mage", "meepo", "axe", "rubick", "crystal-maiden"], ["leshrac", "lina", "enigma", "bounty-hunter", "earthshaker"]],
  ["The early-game case", ["phantom-lancer", "arc-warden", "axe", "silencer", "ancient-apparition"], ["sniper", "lion", "bristleback", "enigma", "lich"]],
  ["Five supports", ["shadow-shaman", "lion", "dazzle", "witch-doctor", "crystal-maiden"], ["juggernaut", "invoker", "mars", "tusk", "lich"]],
  ["A sound pub draft", ["faceless-void", "storm-spirit", "centaur-warrunner", "hoodwink", "warlock"], ["phantom-assassin", "puck", "underlord", "nyx-assassin", "jakiro"]],
  ["The same, Snapfire mid", ["faceless-void", "snapfire", "centaur-warrunner", "hoodwink", "warlock"], ["phantom-assassin", "puck", "underlord", "nyx-assassin", "jakiro"]],
  ["The same, Slark mid", ["faceless-void", "slark", "centaur-warrunner", "hoodwink", "warlock"], ["phantom-assassin", "puck", "underlord", "nyx-assassin", "jakiro"]],
];

const log = (...a) => console.log(...a);
const warn = (...a) => console.warn("  !", ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
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

/** OpenDota hero id -> our slug, matched on Valve's internal name. */
async function heroIds() {
  const bySteam = new Map(BASE_HEROES.map((h) => [h.steam, h.slug]));
  const out = new Map();
  for (const hero of await getJson(`${API}/heroes`)) {
    const slug = bySteam.get(String(hero.name ?? "").replace(/^npc_dota_hero_/, ""));
    if (slug) out.set(Number(hero.id), slug);
  }
  return out;
}

const windowSql = (lo, hi) => `
  SELECT match_id AS id, radiant_team AS r, dire_team AS d, radiant_win AS w
  FROM public_matches
  WHERE match_id > ${lo} AND match_id <= ${hi}
    AND lobby_type = 7 AND game_mode = 22
    AND array_length(radiant_team, 1) = 5 AND array_length(dire_team, 1) = 5`;

/** Postgres int arrays arrive as arrays already, but text is worth tolerating. */
const asTeam = (t) => {
  const list = Array.isArray(t) ? t : typeof t === "string" ? t.replace(/[{}]/g, "").split(",") : null;
  if (!list || list.length !== 5) return null;
  const team = list.map(Number);
  return team.every(Number.isFinite) ? team : null;
};

/** Line-ups strictly below `below`, newest first, from the cache when it still fits. */
async function collect(below) {
  const cached = options.fresh ? null : await readJson(CACHE_FILE);
  if (cached?.below === below && Array.isArray(cached.rows) && cached.rows.length >= options.matches) {
    log(`  ${cached.rows.length.toLocaleString()} line-ups from the cache`);
    return cached.rows;
  }

  const rows = [];
  let hi = below - 1;
  let width = options.window;
  while (rows.length < options.matches) {
    const lo = Math.max(0, hi - width);
    if (lo <= 0) {
      warn("reached the start of the table");
      break;
    }
    const started = Date.now();
    let found;
    try {
      found = await explorer(windowSql(lo, hi));
    } catch (err) {
      const narrower = Math.max(20_000, Math.floor(width / 2));
      if (narrower === width) throw err;
      warn(`window of ${width.toLocaleString()} ids failed (${err.message}); retrying at ${narrower.toLocaleString()}`);
      width = narrower;
      await sleep(options.delay * 2);
      continue;
    }
    for (const m of found) {
      const r = asTeam(m.r);
      const d = asTeam(m.d);
      if (!r || !d) continue;
      rows.push([Number(m.id), r, d, m.w === true || m.w === "t" || m.w === 1 ? 1 : 0]);
    }
    const elapsed = Date.now() - started;
    log(
      `  ${rows.length.toLocaleString().padStart(9)} line-ups · ids ${lo.toLocaleString()}–${hi.toLocaleString()} · ` +
        `${(elapsed / 1000).toFixed(1)}s`,
    );
    hi = lo;
    if (elapsed < 5_000) width = Math.min(width * 2, 3_000_000);
    else if (elapsed > 30_000) width = Math.max(20_000, Math.floor(width / 2));
    await sleep(options.delay);
  }

  await mkdir(dirname(CACHE_FILE), { recursive: true });
  await writeFile(CACHE_FILE, JSON.stringify({ below, rows }));
  return rows;
}

// ------------------------------------------------------------------- the fit

/** Every usable line-up as the model's features, from Radiant's side. */
function samplesFrom(rows, data, idToSlug, priors) {
  const samples = [];
  let skipped = 0;
  const seat = (slugs) => {
    const { positions } = assignPositions(slugs, priors);
    return slugs.map((slug, i) => ({ slug, position: positions[i] }));
  };
  for (const [id, r, d, won] of rows) {
    const radiant = r.map((h) => idToSlug.get(h));
    const dire = d.map((h) => idToSlug.get(h));
    if ([...radiant, ...dire].some((slug) => !slug || !priors.has(slug))) {
      skipped++;
      continue;
    }
    samples.push({ id, y: won, features: draftFeatures(data, { mine: seat(radiant), enemy: seat(dire) }) });
  }
  return { samples, skipped };
}

const pct = (n) => `${(n * 100).toFixed(1)}%`;
const signed = (n, digits = 4) => `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(digits)}`;

function report(result) {
  log(`\n  τ = ${result.tau}  (held-out log-loss by τ: ${result.grid.map((g) => `${g.tau} ${g.logLoss.toFixed(5)}`).join(", ")})`);
  log(
    `  held-out log-loss ${result.holdout.logLoss.toFixed(5)} against ${result.holdout.baseline.toFixed(5)} ` +
      `for the side term alone · AUC ${result.holdout.auc.toFixed(3)}`,
  );
  log("  weights, log-odds per point:");
  for (const [key, weight] of Object.entries(result.weights)) {
    const se = result.se[key];
    log(`    ${key.padEnd(12)} ${signed(weight)}${se === null ? "  (pinned at 0)" : ` ± ${se.toFixed(4)}`}`);
  }
  log("  calibration, out of fold, both seats (predicted → won):");
  for (const [from, to, games, predicted, actual] of result.reliability) {
    if (!games) continue;
    log(`    ${pct(from).padStart(6)}–${pct(to).padEnd(6)} ${String(games).padStart(8)} team-games  ${pct(predicted).padStart(6)} → ${pct(actual)}`);
  }
  if (result.range) log(`  figures shown between ${pct(result.range[0])} and ${pct(result.range[1])}`);
}

function sanity(data, calibration) {
  log("  sanity drafts (spec, \"Sanity cases\"):");
  const seated = (slugs) => slugs.map((slug, i) => ({ slug, position: i + 1 }));
  for (const [label, mine, theirs] of SANITY) {
    if ([...mine, ...theirs].some((slug) => !data.bySlug.has(slug))) {
      log(`    ${label.padEnd(26)} a hero is missing from the data`);
      continue;
    }
    const win = winRead(data, { mine: seated(mine), enemy: seated(theirs) }, calibration);
    const lead = [...win.parts].sort((a, b) => Math.abs(b.points) - Math.abs(a.points))[0];
    const roles = win.parts.find((p) => p.group === "roles");
    log(
      `    ${label.padEnd(26)} ${win.shown.padEnd(10)} ${win.verdict.label.padEnd(24)} ` +
        `leads: ${lead.label} ${signed(lead.points, 1)} · roles ${signed(roles.points, 1)}`,
    );
  }
}

async function main() {
  const started = Date.now();
  log("Win-chance calibration");

  const files = {
    matchups: await readJson(join(DATA, "matchups.json")),
    synergies: await readJson(join(DATA, "synergies.json")),
    timings: await readJson(join(DATA, "timings.json")),
    positions: await readJson(join(DATA, "positions.json")),
    lanes: await readJson(join(DATA, "lanes.json")),
  };
  if (!files.matchups) throw new Error("public/data/matchups.json is missing — run the counters step first");
  const below = calibrationWindow(files.synergies, files.timings);
  if (below === null) {
    throw new Error("synergies.json and timings.json record no matchIdRange — run the synergies and timings steps first");
  }

  const data = withRankBand(
    buildDataset({
      matchupFile: { data: files.matchups },
      synergyFile: { data: files.synergies },
      timingFile: { data: files.timings },
      positionFile: { data: files.positions },
      laneFile: { data: files.lanes },
    }),
    RANK_BAND,
  );
  const priors = new Map(data.heroes.filter((h) => h.positions).map((h) => [h.slug, h.positions]));
  const idToSlug = await heroIds();
  log(`  ${priors.size} heroes with positions, ${idToSlug.size} OpenDota ids mapped`);
  log(`  games strictly below match ${below.toLocaleString()}, the older edge of the synergy and timing samples\n`);

  const rows = await collect(below);
  const { samples, skipped } = samplesFrom(rows, data, idToSlug, priors);
  log(`\n  ${samples.length.toLocaleString()} line-ups scored, ${skipped.toLocaleString()} skipped for a hero the data does not know`);

  const result = fitCalibration(samples, {
    keys: [...WIN_FEATURES],
    taus: TAUS,
    vectorize: (sample, tau) => winFeatures(sample.features, tau),
    nonPositive: ["roleDeficit"],
  });
  report(result);

  const problems = calibrationProblems(result, { positive: POSITIVE });
  if (problems.length) {
    for (const problem of problems) warn(problem);
    throw new Error("the fit failed its checks; calibration.json was left as it was");
  }

  const ids = samples.map((s) => s.id);
  const lo = ids.reduce((m, id) => Math.min(m, id), Infinity);
  const hi = ids.reduce((m, id) => Math.max(m, id), -Infinity);
  const round = (n, digits) => Math.round(n * 10 ** digits) / 10 ** digits;
  const payload = {
    generatedAt: new Date().toISOString(),
    source: "https://api.opendota.com/api/explorer (public_matches)",
    note:
      "weights are log-odds per unit of each feature of src/lib/winModel.ts, fitted by logistic " +
      "regression on ranked All Pick games (lobby_type 7, game_mode 22) strictly older than the " +
      "synergy and timing samples; se are their standard errors, null where a sign constraint " +
      "pinned the weight at zero. side is the Radiant term, which the app leaves out. tau is the " +
      "role-deficit threshold in points per hero, chosen by two-fold held-out log-loss. " +
      "reliability rows are [from, to, team-games, mean predicted, actual win rate], out of fold " +
      "and read from both seats; range is the span of bins with at least 200 team-games. inputs " +
      "are the generatedAt of the data files the features were read from.",
    matches: result.matches,
    matchIdRange: [lo, hi],
    rankBand: RANK_BAND,
    inputs: {
      matchups: files.matchups.generatedAt ?? null,
      positions: files.positions?.generatedAt ?? null,
      synergies: files.synergies?.generatedAt ?? null,
      timings: files.timings?.generatedAt ?? null,
    },
    tau: result.tau,
    weights: Object.fromEntries(Object.entries(result.weights).map(([k, w]) => [k, round(w, 6)])),
    se: Object.fromEntries(Object.entries(result.se).map(([k, s]) => [k, s === null ? null : round(s, 6)])),
    side: round(result.side, 6),
    holdout: {
      logLoss: round(result.holdout.logLoss, 6),
      baseline: round(result.holdout.baseline, 6),
      auc: round(result.holdout.auc, 4),
    },
    reliability: result.reliability.map(([from, to, games, predicted, actual]) => [
      from,
      to,
      games,
      round(predicted, 4),
      round(actual, 4),
    ]),
    range: result.range,
  };

  // Read back exactly as the app will read it: a file the app would refuse is not written.
  const calibration = readCalibration(payload);
  if (!calibration) throw new Error("the payload does not pass the app's own validation");
  sanity(data, calibration);

  if (options.dryRun) {
    log("\n  --dry-run: nothing written\n");
    return;
  }
  await writeFile(OUT_FILE, JSON.stringify(payload), "utf8");
  log(`\nWrote public/data/calibration.json`);
  log(`  ${((Date.now() - started) / 1000) | 0}s\n`);
}

main().catch((err) => {
  console.error(`\nCalibration failed: ${err.message}\n`);
  if (/HTTP 429|rate/i.test(err.message)) {
    console.error("  OpenDota rate-limited the run. Wait a minute and rerun — the line-ups fetched");
    console.error("  so far are not kept until a run finishes, so a free API key helps:");
    console.error("    OPENDOTA_API_KEY=... npm run calibrate\n");
  }
  process.exit(1);
});
