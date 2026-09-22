#!/usr/bin/env node
/**
 * Builds public/data/matchups.json from Dotabuff.
 *
 *   npm run scrape                 # Node first; falls back to a browser on 403
 *   npm run scrape -- --browser    # skip Node, collect through a hidden Chromium
 *   npm run scrape -- --node       # Node only, never launch a browser
 *   npm run scrape -- --headed     # show that browser window
 *   npm run scrape -- --force      # ignore cache, refetch everything
 *   npm run scrape -- --images     # also download hero portraits (offline UI)
 *   npm run scrape -- --images-only  # portraits only, no Dotabuff request at all
 *   npm run scrape -- --only=axe,pudge
 *   npm run scrape -- --offline    # rebuild JSON from cache, no network
 *   npm run scrape -- --diagnose   # one request, fully explained
 *   npm run scrape -- --dump-roles # print the derived positions and stop
 *   npm run scrape -- --no-lanes   # skip lane pages (no position data)
 *   npm run scrape -- --delay=2500
 *   npm run scrape -- --cookie="__cfduid=...; other=..."
 *
 * One request every ~1.5s, single connection, exponential backoff on 429/5xx.
 * Raw HTML is cached in scripts/.cache so an interrupted run resumes for free.
 *
 * Dotabuff sits behind Cloudflare, which fingerprints the TLS handshake rather
 * than just reading headers — so on a blocked day no cookie, User-Agent or
 * delay will get Node through. Instead of failing there, a 403 hands the run to
 * scripts/scrape-electron.mjs, which does the same collection from inside a
 * real Chromium. See "The scraper" in the README.
 */

import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import {
  parseMatchups,
  parseHeroStats,
  parseHeroAttributes,
  parseHeroNames,
  parseLaneTable,
  round,
} from "./parse.mjs";
import { LANES, derivePositions } from "./roles.mjs";
import { carryOver, countCells, writeMatchups } from "./matchups-file.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CACHE_DIR = join(ROOT, "scripts", ".cache");
const OUT_FILE = join(ROOT, "public", "data", "matchups.json");
const IMG_DIR = join(ROOT, "public", "heroes");
const BASE = "https://www.dotabuff.com";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

// ---------------------------------------------------------------- CLI options

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const options = {
  force: flag("force"),
  offline: flag("offline"),
  images: flag("images"),
  imagesOnly: flag("images-only"),
  noLanes: flag("no-lanes"),
  dumpRoles: flag("dump-roles"),
  diagnose: flag("diagnose"),
  recomputeRoles: flag("recompute-roles"),
  browser: flag("browser"),
  nodeOnly: flag("node"),
  headed: flag("headed"),
  delay: Number(opt("delay", 1500)),
  retries: Number(opt("retries", 4)),
  cookie: opt("cookie", process.env.DOTABUFF_COOKIE || ""),
  only: opt("only", "").split(",").map((s) => s.trim()).filter(Boolean),
  cacheTtlHours: Number(opt("cache-ttl", 24)),
};

// ------------------------------------------------------------------- plumbing

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (ms) => ms * (0.75 + Math.random() * 0.5);

let lastRequestAt = 0;
async function throttle() {
  const wait = lastRequestAt + jitter(options.delay) - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
}

const log = (...a) => console.log(...a);
const warn = (...a) => console.warn("  !", ...a);

function progress(done, total, label) {
  const width = 24;
  const filled = Math.round((done / total) * width);
  const bar = "#".repeat(filled).padEnd(width, ".");
  const line = `  [${bar}] ${String(done).padStart(3)}/${total}  ${label}`;
  if (process.stdout.isTTY) process.stdout.write(`\r${line.padEnd(78)}`);
  else if (done === total || done % 10 === 0) log(line);
}

async function cachePath(key) {
  await mkdir(CACHE_DIR, { recursive: true });
  return join(CACHE_DIR, `${key}.html`);
}

async function readCache(key) {
  try {
    const file = await cachePath(key);
    const info = await stat(file);
    const ageHours = (Date.now() - info.mtimeMs) / 3.6e6;
    if (!options.offline && options.cacheTtlHours > 0 && ageHours > options.cacheTtlHours) return null;
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

/** Fetch with cache, throttling and backoff. Returns HTML or throws. */
async function fetchPage(path, key) {
  if (!options.force) {
    const cached = await readCache(key);
    if (cached) return cached;
  }
  if (options.offline) throw new Error(`no cached copy for ${key} (running --offline)`);

  let lastError;
  for (let attempt = 0; attempt <= options.retries; attempt++) {
    if (attempt > 0) {
      const backoff = jitter(2000 * 2 ** (attempt - 1));
      warn(`retry ${attempt}/${options.retries} for ${path} in ${Math.round(backoff / 1000)}s — ${lastError}`);
      await sleep(backoff);
    }
    await throttle();
    try {
      const res = await fetch(`${BASE}${path}`, {
        redirect: "follow",
        headers: {
          "User-Agent": UA,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          "Cache-Control": "no-cache",
          Referer: `${BASE}/heroes`,
          ...(options.cookie ? { Cookie: options.cookie } : {}),
        },
      });
      if (res.status === 429 || res.status >= 500) {
        const retryAfter = Number(res.headers.get("retry-after"));
        if (Number.isFinite(retryAfter) && retryAfter > 0) await sleep(retryAfter * 1000);
        lastError = `HTTP ${res.status}`;
        continue;
      }
      if (res.status === 403) throw new Error(`HTTP 403 for ${path}`);
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`);
      const html = await res.text();
      await writeFile(await cachePath(key), html, "utf8");
      return html;
    } catch (err) {
      // A 403 is a decision, not a hiccup — retrying just digs the hole deeper.
      if (String(err.message).startsWith("HTTP 403")) throw err;
      lastError = describeFetchError(err);
    }
  }
  throw new Error(`failed after ${options.retries} retries: ${path} (${lastError})`);
}

/** Turn undici's terse network errors into something actionable. */
export function describeFetchError(err) {
  const cause = err?.cause;
  const code = cause?.code || err?.code;
  const detail = cause?.message && cause.message !== err.message ? ` — ${cause.message}` : "";
  if (code) return `${err.message} (${code})${detail}`;
  return `${err.message}${detail}`;
}

/**
 * Advice for the failure we actually hit, rather than a generic "it broke".
 * Everything here is recoverable; the point is to say which lever to pull.
 */
export function explainFailure(reason = "") {
  if (/HTTP 403/.test(reason)) {
    return [
      "Dotabuff is behind Cloudflare and refused this request (403).",
      "",
      "Copying a Cookie header usually does NOT fix this: Cloudflare also fingerprints",
      "the TLS handshake, and Node cannot imitate a browser's. The requests have to",
      "come from a real browser — which `npm run scrape` normally arranges for you:",
      "",
      "  npm run scrape -- --browser --headed",
      "",
      "That collects the same data through a Chromium window you can watch, so a",
      "challenge can be cleared by hand. `npm run scrape` does it unattended.",
      "",
      'A cookie is still worth a try if you want one: --cookie="<paste>".',
    ];
  }
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|ECONNRESET|UND_ERR|fetch failed/i.test(reason)) {
    return [
      "The requests never reached Dotabuff — this looks like a network problem rather",
      "than a block. Check that https://www.dotabuff.com loads in your browser, and",
      "whether a VPN, proxy or DNS filter is in the way.",
    ];
  }
  if (/HTTP 429/.test(reason)) {
    return ["Rate limited. Wait a few minutes, then rerun with --delay=4000."];
  }
  return [
    "Rerun with --diagnose to see exactly what Dotabuff returned for a single page.",
  ];
}

/**
 * `--diagnose`: one request, fully described. Far quicker than reading a wall
 * of retry warnings when the whole run fails.
 */
async function diagnose() {
  const path = "/heroes/bristleback/matchups";
  log("Diagnosing a single request\n");
  log(`  GET ${BASE}${path}`);
  log(`  User-Agent: ${UA.slice(0, 60)}…`);
  log(`  Cookie:     ${options.cookie ? `${options.cookie.length} chars supplied` : "none"}`);

  let res;
  const started = Date.now();
  try {
    res = await fetch(`${BASE}${path}`, {
      redirect: "follow",
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        Referer: `${BASE}/heroes`,
        ...(options.cookie ? { Cookie: options.cookie } : {}),
      },
    });
  } catch (err) {
    log(`\n  request failed after ${Date.now() - started}ms`);
    log(`  ${describeFetchError(err)}\n`);
    for (const line of explainFailure(describeFetchError(err))) log(`  ${line}`);
    return;
  }

  const body = await res.text();
  log(`\n  status:       ${res.status} ${res.statusText}`);
  log(`  final URL:    ${res.url}`);
  log(`  content-type: ${res.headers.get("content-type") ?? "?"}`);
  log(`  server:       ${res.headers.get("server") ?? "?"}`);
  log(`  body:         ${body.length.toLocaleString()} bytes, ${Date.now() - started}ms`);

  const challenged = /cf-browser-verification|challenge-platform|Just a moment|captcha/i.test(body);
  if (challenged) log("  !! body looks like a bot challenge page, not the hero page");

  const rows = parseMatchups(body);
  log(`  parsed rows:  ${rows.length}`);
  if (rows.length) {
    log(`  first row:    ${rows[0].slug} ${rows[0].disadvantage}% over ${rows[0].matches} matches`);
    log("\n  Looks healthy — rerun `npm run scrape`.");
    return;
  }
  if (res.ok && !challenged) {
    log("\n  The page loaded but no matchup table was found: Dotabuff has probably");
    log("  changed its markup. scripts/parse.mjs is the only file that needs fixing;");
    log("  scripts/fixtures/matchups.html pins the structure it expects.");
    return;
  }
  if (challenged) {
    log("");
    for (const line of explainFailure("HTTP 403")) log(`  ${line}`);
    return;
  }
  log("");
  for (const line of explainFailure(`HTTP ${res.status}`)) log(`  ${line}`);
}

// --------------------------------------------------------------- hero roster

/** Baseline roster read straight out of the app's generated TS file. */
async function readBaselineHeroes() {
  const src = await readFile(join(ROOT, "src", "data", "heroes.ts"), "utf8");
  const re = /\{\s*slug:\s*"([^"]+)",\s*name:\s*"([^"]+)",\s*attr:\s*"([^"]+)",\s*steam:\s*"([^"]+)"\s*\}/g;
  const out = [];
  let m;
  while ((m = re.exec(src)) !== null) {
    out.push({ slug: m[1], name: m[2], attr: m[3], steam: m[4] });
  }
  if (!out.length) throw new Error("could not read src/data/heroes.ts — has its format changed?");
  return out;
}

async function buildRoster() {
  const baseline = await readBaselineHeroes();
  const bySlug = new Map(baseline.map((h) => [h.slug, { ...h }]));

  let indexHtml = null;
  let blocked = false;
  try {
    indexHtml = await fetchPage("/heroes", "index");
  } catch (err) {
    blocked = /HTTP 403/.test(err.message);
    warn(`could not load /heroes (${err.message}); using the bundled roster`);
  }

  if (indexHtml) {
    const names = parseHeroNames(indexHtml);
    const attrs = parseHeroAttributes(indexHtml);
    const stats = parseHeroStats(indexHtml);

    for (const [slug, name] of names) {
      const existing = bySlug.get(slug);
      if (existing) {
        existing.name = name;
      } else {
        // A hero released after this checkout was generated.
        bySlug.set(slug, { slug, name, attr: "uni", steam: slug.replace(/-/g, "_") });
        log(`  + new hero on Dotabuff: ${name} (${slug})`);
      }
    }
    for (const [slug, attr] of attrs) {
      const hero = bySlug.get(slug);
      if (hero) hero.attr = attr;
    }
    let statCount = 0;
    for (const [slug, s] of stats) {
      const hero = bySlug.get(slug);
      if (!hero) continue;
      statCount++;
      if (s.winRate !== null) hero.winRate = round(s.winRate, 2);
      if (s.pickRate !== null) hero.pickRate = round(s.pickRate, 2);
      if (s.banRate !== null) hero.banRate = round(s.banRate, 2);
      if (s.tier) hero.tier = s.tier;
    }
    log(`  roster: ${bySlug.size} heroes, ${attrs.size} attributes, ${statCount} stat rows`);
    if (!statCount) warn("hero win/pick/ban rates not found — meta weighting will be inactive");
  }

  return {
    roster: [...bySlug.values()].sort((a, b) => a.name.localeCompare(b.name)),
    blocked,
  };
}

// ------------------------------------------------------------------ positions

/**
 * Reconstruct positions 1-5 from the free lane pages.
 *
 * Dotabuff's own position filter is behind Plus, but `/heroes/lanes` gives
 * presence and GPM per lane for free, and that is enough: the lane says where
 * the hero stands, the GPM says whether they are the core or the support
 * standing there. See roles.mjs for the split.
 */
async function attachPositions(roster) {
  const heroLanes = new Map();
  let pages = 0;

  for (const lane of LANES) {
    let html;
    try {
      html = await fetchPage(`/heroes/lanes?lane=${lane}`, `lane-${lane}`);
    } catch (err) {
      warn(`lane page "${lane}" failed: ${err.message}`);
      continue;
    }
    const table = parseLaneTable(html);
    if (table.size < 20) {
      warn(`lane page "${lane}" parsed only ${table.size} rows — markup may have changed`);
    }
    pages++;
    for (const [slug, stats] of table) {
      if (!heroLanes.has(slug)) heroLanes.set(slug, {});
      heroLanes.get(slug)[lane] = stats;
    }
    log(`  ${lane.padEnd(8)} ${String(table.size).padStart(3)} heroes`);
  }

  if (!pages) {
    warn("no lane data — positions will be unavailable and role filters inactive");
    return 0;
  }

  const derived = derivePositions(heroLanes, overallWinRates(roster));
  let assigned = 0;
  for (const hero of roster) {
    const lanes = heroLanes.get(hero.slug);
    const roles = derived.get(hero.slug);
    if (lanes) hero.lanes = lanes;
    if (!roles) continue;
    hero.positions = roles.positions;
    hero.positionWinRate = roles.positionWinRate;
    hero.topPositions = roles.topPositions;
    assigned++;
  }
  log(`  positions derived for ${assigned}/${roster.length} heroes`);
  reportRoleSanity(roster);
  return assigned;
}

/**
 * Overall win rates, keyed by slug — the prior `derivePositions` shrinks a thin
 * position's win rate towards. Heroes without one are simply left out, and
 * their lane figures pass through unshrunk.
 */
const overallWinRates = (heroes) =>
  new Map(
    heroes
      .filter((h) => Number.isFinite(h.winRate))
      .map((h) => [h.slug, h.winRate]),
  );

/**
 * Print a handful of heroes nobody disagrees about. The core/support split is
 * learned from each lane's GPM spread, so it degrades quietly if a lane page
 * comes back short — and a wrong split is far easier to spot here than in the
 * app. Anti-Mage showing up as a support means something went wrong upstream.
 */
const ROLE_CANARIES = {
  "anti-mage": 1, "crystal-maiden": 5, invoker: 2, axe: 3, "shadow-fiend": 2, lion: 5,
};

function reportRoleSanity(roster) {
  const checks = [];
  let wrong = 0;
  for (const [slug, expected] of Object.entries(ROLE_CANARIES)) {
    const hero = roster.find((h) => h.slug === slug);
    if (!hero?.topPositions?.length) continue;
    const ok = hero.topPositions.includes(expected);
    if (!ok) wrong++;
    checks.push(`${hero.name} ${hero.topPositions.join("/")}${ok ? "" : ` (expected ${expected})`}`);
  }
  if (!checks.length) return;
  log(`  sanity check: ${checks.join(", ")}`);
  if (wrong > 1) {
    warn(
      `${wrong} well-known heroes landed in an odd position — the lane pages may ` +
      "be incomplete. Rerun with --force, or --no-lanes to drop position data.",
    );
  }
}

/**
 * `--recompute-roles`: re-derive positions from the lane stats already stored
 * in matchups.json. The expensive part of a scrape is the 127 matchup pages;
 * the position maths is local, so improving it should not cost another crawl.
 */
async function recomputeRoles() {
  let payload;
  try {
    payload = JSON.parse(await readFile(OUT_FILE, "utf8"));
  } catch (err) {
    throw new Error(`could not read public/data/matchups.json (${err.message})`);
  }

  const heroLanes = new Map();
  for (const hero of payload.heroes ?? []) {
    if (hero.lanes && Object.keys(hero.lanes).length) heroLanes.set(hero.slug, hero.lanes);
  }
  if (!heroLanes.size) {
    throw new Error(
      "matchups.json has no lane stats to work from — rerun `npm run scrape` to " +
      "fetch them",
    );
  }

  const before = new Map(payload.heroes.map((h) => [h.slug, (h.topPositions ?? []).join("/")]));
  const derived = derivePositions(heroLanes, overallWinRates(payload.heroes));
  let changed = 0;
  for (const hero of payload.heroes) {
    const roles = derived.get(hero.slug);
    if (!roles) continue;
    hero.positions = roles.positions;
    hero.positionWinRate = roles.positionWinRate;
    hero.topPositions = roles.topPositions;
    if (before.get(hero.slug) !== roles.topPositions.join("/")) changed++;
  }

  payload.generatedAt = new Date().toISOString();
  await writeFile(OUT_FILE, JSON.stringify(payload), "utf8");

  log(`Recomputed positions for ${derived.size} heroes from stored lane stats.`);
  log(`  ${changed} hero(es) changed position`);
  if (changed) {
    for (const hero of payload.heroes) {
      const was = before.get(hero.slug);
      const now = (hero.topPositions ?? []).join("/");
      if (was && now && was !== now) log(`    ${hero.name.padEnd(20)} ${was.padEnd(8)} -> ${now}`);
    }
  }
  reportRoleSanity(payload.heroes);
}

/** `--dump-roles`: eyeball the derivation without opening the app. */
function dumpRoles(roster) {
  const withRoles = roster.filter((h) => h.topPositions?.length);
  log(`\nDerived positions (${withRoles.length} heroes)\n`);
  log(`  ${"hero".padEnd(20)} ${"pos".padEnd(9)} ${"1     2     3     4     5"}`);
  for (const hero of withRoles) {
    const bars = [1, 2, 3, 4, 5]
      .map((p) => String(Math.round((hero.positions?.[p] ?? 0) * 100)).padStart(3) + "% ")
      .join(" ");
    log(`  ${hero.name.slice(0, 19).padEnd(20)} ${hero.topPositions.join("/").padEnd(9)} ${bars}`);
  }
}

// ------------------------------------------------------------------- images

async function downloadPortraits(heroes) {
  await mkdir(IMG_DIR, { recursive: true });
  let saved = 0;
  let cached = 0;
  const failed = [];
  for (const [i, hero] of heroes.entries()) {
    const dest = join(IMG_DIR, `${hero.slug}.png`);
    if (!options.force) {
      try {
        await stat(dest);
        cached++;
        progress(i + 1, heroes.length, `portrait ${hero.name} (cached)`);
        continue;
      } catch { /* not downloaded yet */ }
    }
    const url =
      `https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/heroes/${hero.steam}.png`;
    try {
      await sleep(120);
      const res = await fetch(url, { headers: { "User-Agent": UA } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
      saved++;
    } catch (err) {
      failed.push(`${hero.slug} (${err.message})`);
    }
    progress(i + 1, heroes.length, `portrait ${hero.name}`);
  }
  if (process.stdout.isTTY) process.stdout.write("\n");
  log(`  public/heroes/: ${saved} new, ${cached} already there, ${failed.length} failed`);
  if (failed.length) {
    warn(`no portrait for ${failed.length} hero(es):`);
    for (const f of failed.slice(0, 10)) warn(`   ${f}`);
    if (failed.length > 10) warn(`   …and ${failed.length - 10} more`);
  }
  return { saved, cached, failed };
}

/**
 * `--images-only`: portraits and nothing else.
 *
 * Valve's CDN is not behind Cloudflare, so this route still works on a day when
 * every Dotabuff request comes back 403 — which is the whole point, and the
 * reason it reads the roster from the bundled `src/data/heroes.ts` instead of
 * calling buildRoster(). It makes no request to dotabuff.com at all.
 */
async function portraitsOnly() {
  const baseline = await readBaselineHeroes();
  const roster = options.only.length
    ? baseline.filter((h) => options.only.includes(h.slug))
    : baseline;
  if (!roster.length) throw new Error(`--only matched no heroes (${options.only.join(", ")})`);
  log("Hero portraits");
  log("  source: Valve's CDN — no Dotabuff request is made");
  log(`  roster: ${roster.length} hero${roster.length === 1 ? "" : "es"} from src/data/heroes.ts` +
      (options.force ? ", redownloading every one (--force)" : ""));
  log("");
  const { saved, cached, failed } = await downloadPortraits(roster);
  if (failed.length && !saved && !cached) {
    const err = new Error(`no portraits downloaded — ${failed[0]}`);
    err.title = "Portrait download failed";
    err.advice = [
      "Valve's CDN was unreachable. Check the connection and rerun.",
      "The board falls back to the CDN at runtime, so it still works online.",
    ];
    throw err;
  }
}

// ------------------------------------------------------------- browser route

/**
 * Whether a 403 should hand the run over. `--node` opts out — that is the flag
 * for proving what plain Node does — an offline rebuild has nothing to ask a
 * browser for, and the collector always collects the whole roster, so `--only`
 * would silently do more than it was asked.
 */
const canFallBack = () =>
  !options.nodeOnly && !options.offline && !options.only.length;

/**
 * Re-run the collection inside Electron.
 *
 * Importing the `electron` package from Node hands back the path to its
 * Chromium binary rather than the Electron API.
 */
async function runBrowser() {
  let electronPath;
  try {
    ({ default: electronPath } = await import("electron"));
  } catch (cause) {
    const err = new Error(`Electron is not available — ${cause.message}`);
    err.advice = [
      "The browser route runs on the Electron already in devDependencies.",
      "Run `npm install` and try again.",
    ];
    throw err;
  }

  const forwarded = argv.filter(
    (a) => a === "--headed" || /^--(timeout|challenge-timeout|spacing|concurrency)=/.test(a),
  );
  // ELECTRON_RUN_AS_NODE turns the binary back into plain Node, which is the
  // one thing this route exists to avoid.
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  const { spawn } = await import("node:child_process");
  const code = await new Promise((resolve, reject) => {
    const child = spawn(
      electronPath,
      [join(ROOT, "scripts", "scrape-electron.mjs"), ...forwarded],
      { stdio: "inherit", env },
    );
    child.on("error", reject);
    child.on("exit", (status) => resolve(status ?? 1));
  });

  if (code !== 0) {
    const err = new Error("the browser run did not finish");
    err.advice = [
      "Watch it work and clear anything Cloudflare puts up by hand:",
      "",
      "  npm run scrape -- --browser --headed",
    ];
    throw err;
  }
}

function handOver(what) {
  log("");
  log(`  ${what} with HTTP 403. Cloudflare fingerprints the TLS handshake, so`);
  log("  no header, cookie or delay will get Node through — handing the run to a");
  log("  real browser instead. Pass --node to stop here rather than fall back.");
  log("");
  return runBrowser();
}

// ---------------------------------------------------------------------- main

async function main() {
  const started = Date.now();
  if (options.diagnose) return diagnose();
  if (options.recomputeRoles) return recomputeRoles();
  if (options.imagesOnly) return portraitsOnly();
  if (options.browser) return runBrowser();

  log("Dotabuff matchup scraper");
  log(`  mode: ${options.offline ? "offline (cache only)" : `live, ~${options.delay}ms between requests`}`);

  const { roster, blocked } = await buildRoster();
  if (blocked && canFallBack()) return handOver("Dotabuff refused the first request");

  if (!options.noLanes) {
    log("\nReading lane tables to derive positions…");
    await attachPositions(roster);
  }
  if (options.dumpRoles) {
    dumpRoles(roster);
    return;
  }

  const targets = options.only.length
    ? roster.filter((h) => options.only.includes(h.slug))
    : roster;
  if (!targets.length) throw new Error(`--only matched no heroes (${options.only.join(", ")})`);

  log(`\nFetching matchups for ${targets.length} heroes…`);
  const matchups = {};
  const failures = [];
  let lastFetchError = "";

  for (const [i, hero] of targets.entries()) {
    try {
      const html = await fetchPage(`/heroes/${hero.slug}/matchups`, hero.slug);
      const rows = parseMatchups(html);
      if (rows.length < 40) {
        failures.push(`${hero.slug} (only ${rows.length} rows parsed)`);
      }
      const table = {};
      for (const row of rows) {
        if (row.slug === hero.slug) continue;
        table[row.slug] = [row.disadvantage, row.winRate, row.matches];
      }
      matchups[hero.slug] = table;
    } catch (err) {
      failures.push(`${hero.slug} (${err.message})`);
      lastFetchError = err.message;
      // Once Dotabuff starts refusing, every further request is wasted.
      if (String(err.message).startsWith("HTTP 403")) break;
    }
    progress(i + 1, targets.length, hero.name);
  }
  if (process.stdout.isTTY) process.stdout.write("\n");

  if (options.images) {
    log("\nDownloading hero portraits…");
    await downloadPortraits(roster);
  }

  // The roster can come from cache while the matchup pages are still blocked.
  if (!Object.keys(matchups).length && /HTTP 403/.test(lastFetchError) && canFallBack()) {
    return handOver("Dotabuff refused every matchup page");
  }

  // Keep whatever a previous run collected for heroes this run did not cover,
  // so an interrupted or `--only` run never shrinks the dataset.
  const kept = await carryOver(OUT_FILE, { heroes: roster, matchups });
  if (kept.matchups) log(`  kept ${kept.matchups} hero(es) from the previous matchups.json`);
  if (kept.fields) log(`  kept lane/position data for ${kept.fields} hero(es) this run could not derive`);

  const covered = Object.keys(matchups).length;
  if (!covered) {
    const err = new Error(
      `no matchup data collected — nothing written (${lastFetchError || "no successful request"})`,
    );
    err.advice = explainFailure(lastFetchError);
    throw err;
  }

  await writeMatchups(OUT_FILE, {
    heroes: roster,
    matchups,
    source: "https://www.dotabuff.com/heroes",
  });

  const cells = countCells(matchups);
  log(`\nWrote public/data/matchups.json`);
  log(`  ${covered}/${roster.length} heroes, ${cells} matchup cells, ${(Date.now() - started) / 1000 | 0}s`);
  if (failures.length) {
    warn(`${failures.length} problem(s):`);
    for (const f of failures.slice(0, 15)) warn(`   ${f}`);
    if (failures.length > 15) warn(`   …and ${failures.length - 15} more`);
    warn("rerun the same command to retry — cached pages are skipped");
  }
}

// Only run when invoked directly, so the helpers above stay importable.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(`\n${err.title ?? "Scrape failed"}: ${err.message}\n`);
    for (const line of err.advice ?? explainFailure(err.message)) console.error(`  ${line}`);
    console.error("");
    process.exit(1);
  });
}
