#!/usr/bin/env node
/**
 * Rewrites the two generated blocks in README.md — the badge row and the data
 * table — from public/data/*.json.
 *
 *   npm run readme
 *
 * It is the last step of `npm run refresh`, so the commit that carries new
 * numbers carries a README that describes them. Two lookups need the network:
 * Valve's patch list, and the start times of the first and last match in each
 * OpenDota sample. Both are kept in scripts/.cache/readme/ and read from there
 * when the network is not available; a match's start time never changes, so
 * those entries never expire.
 *
 * A failed lookup still writes the README, with "unknown" where the answer
 * would go, and exits non-zero: a README describing the previous data is the
 * worse of the two.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PATCH_FEED,
  badgeBlock,
  countHeroes,
  dataPatch,
  dataTable,
  describeData,
  projectLinks,
  rangeKey,
  readPatches,
  replaceBlock,
} from "./readme-status.mjs";
import { parseEntries } from "./roster.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(ROOT, "public", "data");
const CACHE = join(ROOT, "scripts", ".cache", "readme");
const README = join(ROOT, "README.md");
const EXPLORER = "https://api.opendota.com/api/explorer";

const log = (line = "") => process.stdout.write(`${line}\n`);
const warn = (line) => process.stderr.write(`  ! ${line}\n`);

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function writeCache(name, value) {
  await mkdir(CACHE, { recursive: true });
  await writeFile(join(CACHE, name), JSON.stringify(value, null, 2));
}

async function loadPatches(problems) {
  try {
    const feed = await fetchJson(PATCH_FEED);
    const patches = readPatches(feed);
    if (!patches.length) throw new Error("the feed listed no patches");
    await writeCache("patches.json", feed);
    return patches;
  } catch (err) {
    const patches = readPatches(await readJson(join(CACHE, "patches.json")));
    if (patches.length) {
      warn(`Valve's patch list is unreachable (${err.message}); using the cached copy`);
      return patches;
    }
    problems.push(`Valve's patch list is unreachable (${err.message}) and nothing is cached`);
    return [];
  }
}

/**
 * Match ids climb with time, so the nearest match inside each end of a sample's
 * id range dates that end. Both queries walk the primary key and return in
 * about a second, where a MIN/MAX over the range times out.
 */
async function loadSampleWindows(files, problems) {
  const times = (await readJson(join(CACHE, "match-times.json"))) ?? {};
  let added = false;

  const startOf = async (id, end) => {
    const key = `${end}:${id}`;
    if (typeof times[key] !== "number") {
      const sql =
        end === "first"
          ? `SELECT start_time FROM public_matches WHERE match_id >= ${Number(id)} ORDER BY match_id ASC LIMIT 1`
          : `SELECT start_time FROM public_matches WHERE match_id <= ${Number(id)} ORDER BY match_id DESC LIMIT 1`;
      const body = await fetchJson(`${EXPLORER}?${new URLSearchParams({ sql })}`);
      const seconds = Number(body?.rows?.[0]?.start_time);
      if (!Number.isFinite(seconds)) throw new Error(body?.err ?? "no match in range");
      times[key] = seconds * 1000;
      added = true;
    }
    return times[key];
  };

  const windows = {};
  for (const file of files) {
    const key = rangeKey(file?.matchIdRange);
    if (!key || windows[key]) continue;
    const [lo, hi] = file.matchIdRange;
    try {
      windows[key] = { from: await startOf(lo, "first"), to: await startOf(hi, "last") };
    } catch (err) {
      problems.push(`could not date OpenDota matches ${lo}–${hi} (${err.message})`);
    }
  }
  if (added) await writeCache("match-times.json", times);
  return windows;
}

async function rosterSize() {
  try {
    return parseEntries(await readFile(join(ROOT, "src", "data", "heroes.ts"), "utf8")).length;
  } catch {
    return 0;
  }
}

async function main() {
  const problems = [];
  const names = ["matchups", "positions", "lanes", "synergies", "timings"];
  const files = Object.fromEntries(
    await Promise.all(names.map(async (name) => [name, await readJson(join(DATA, `${name}.json`))])),
  );

  const [patches, sampleWindows, pkg] = await Promise.all([
    loadPatches(problems),
    loadSampleWindows([files.synergies, files.timings], problems),
    readJson(join(ROOT, "package.json")),
  ]);

  const rows = describeData(files, { sampleWindows });
  const patch = dataPatch(rows, patches, Date.now());
  const links = projectLinks(pkg);

  const before = await readFile(README, "utf8");
  let after = replaceBlock(
    before,
    "badges",
    badgeBlock({ rows, patch, heroes: countHeroes(files.matchups, await rosterSize()), links }),
  );
  after = replaceBlock(after, "data", dataTable(rows, patches));
  if (after !== before) await writeFile(README, after);

  log(`README.md ${after === before ? "already matched" : "updated from"} the data files`);
  log(`  data patch   ${patch.label}${patch.latest ? `   (latest patch ${patch.latest.name})` : ""}`);
  for (const row of rows) {
    log(`  ${row.key.padEnd(12)} ${row.file ? (row.sample ?? "") : "no file"}`);
  }
  if (!links.site || !links.slug) {
    warn("package.json has no homepage or GitHub repository, so the site link and deploy badge are left out");
  }
  for (const problem of problems) warn(problem);
  return problems.length ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`\nREADME update failed: ${err.message}\n`);
    process.exit(1);
  },
);
