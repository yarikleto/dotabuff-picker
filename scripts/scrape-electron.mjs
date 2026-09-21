/**
 * The browser route, run for you.
 *
 * `npm run scrape` tries plain Node first, because that path is cached, polite
 * and fast. Most days Cloudflare turns it away with a 403 — it fingerprints the
 * TLS handshake, so no header, cookie or delay fixes it — and rather than dying
 * there, scrape.mjs re-launches itself through this file.
 *
 * Only the *origin of the requests* changes. A hidden Electron window is a real
 * Chromium: real TLS handshake, real HTTP/2 fingerprint, real cookie jar. The
 * collection logic is the same scripts/collector-body.js the console snippet
 * uses, injected instead of pasted, so the JSON comes out the same shape.
 *
 * Not meant to be run by hand: `node scripts/scrape.mjs --browser` spawns it.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { BrowserWindow, app, session } from "electron";

import { buildCollector } from "./build-collector.mjs";
import { carryOver, countCells, writeMatchups } from "./matchups-file.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_FILE = join(ROOT, "public", "data", "matchups.json");
const START_URL = "https://www.dotabuff.com/heroes";
/**
 * `persist:` keeps the cookie jar on disk between runs. That is the whole
 * payoff of clearing a challenge once: the clearance cookie is still there next
 * time, so the run after it is silent.
 */
const PARTITION = "persist:dotabuff-scraper";
/** A real hero list has ~127 links; a challenge page has none. */
const READY_LINKS = 20;

// ---------------------------------------------------------------- CLI options

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const options = {
  headed: flag("headed"),
  spacing: Number(opt("spacing", 400)),
  concurrency: Number(opt("concurrency", 2)),
  challengeTimeout: Number(opt("challenge-timeout", 180)) * 1000,
  timeout: Number(opt("timeout", 900)) * 1000,
};

const log = (line = "") => process.stdout.write(`${line}\n`);
const warn = (line) => process.stderr.write(`  ! ${line}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let windowClosed = false;

function fail(message, advice = []) {
  process.stderr.write(`\nBrowser scrape failed: ${message}\n\n`);
  for (const line of advice) process.stderr.write(`  ${line}\n`);
  process.stderr.write("\n");
  app.exit(1);
}

// ------------------------------------------------------------------ the page

/** Runs in the page. Cheap enough to poll, and says nothing a page cannot see. */
const READY_PROBE = `document.querySelectorAll('a[href^="/heroes/"]').length`;

/** Collector state, small enough to poll every couple of seconds. */
const STATUS_PROBE = `(() => {
  const s = window.__dotabuff;
  if (!s) return { stage: "starting" };
  if (s.payload) return { stage: "done" };
  if (document.title.startsWith("failed")) return { stage: "failed" };
  return { stage: "working", heroes: Object.keys(s.matchups || {}).length };
})()`;

async function evaluate(win, code, fallback) {
  try {
    return await win.webContents.executeJavaScript(code, true);
  } catch {
    return fallback;
  }
}

const heroLinks = (win) => evaluate(win, READY_PROBE, 0);

/** Poll `check` until it is truthy or the budget runs out. */
async function waitUntil(check, budgetMs, everyMs = 1000) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (windowClosed) return false;
    if (await check()) return true;
    await sleep(everyMs);
  }
  return false;
}

/**
 * Electron ≥36 hands `console-message` a single event object; older versions
 * pass positional arguments. Take the message whichever way it arrives.
 */
function consoleText(args) {
  const first = args[0];
  if (first && typeof first === "object" && typeof first.message === "string") return first.message;
  return typeof args[2] === "string" ? args[2] : "";
}

// ---------------------------------------------------------------------- main

async function run() {
  const started = Date.now();

  // Electron's User-Agent advertises Electron, and the app name after it.
  // Neither is true of the engine actually making the request, and both are the
  // kind of oddity a bot filter notices, so strip them and keep the Chrome
  // token — which stays honest, and in sync with whatever Chromium ships here.
  app.userAgentFallback = app.userAgentFallback
    .replace(/ Electron\/[^ ]+/, "")
    .replace(new RegExp(` ${app.getName()}\\/[^ ]+`), "");

  if (!options.headed) app.dock?.hide();

  const ses = session.fromPartition(PARTITION);
  ses.setUserAgent(app.userAgentFallback);

  const win = new BrowserWindow({
    show: options.headed,
    width: 1280,
    height: 900,
    title: "dotabuff collector",
    webPreferences: {
      partition: PARTITION,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      // A hidden window is a throttled window: Chromium clamps its timers to
      // roughly one a second, and the collector paces itself with setTimeout.
      // Left on, a two-minute run turns into a ten-minute one.
      backgroundThrottling: false,
    },
  });
  win.on("closed", () => { windowClosed = true; });

  // The collector narrates itself to the console; forward that to the terminal
  // so a browser run reads like the Node one.
  win.webContents.on("console-message", (...args) => {
    const text = consoleText(args);
    const at = text.indexOf("[dotabuff]");
    if (at < 0) return;
    // The collector styles its prefix with `%c`. Consoles that apply the
    // formatting drop the CSS; ones that do not hand it over as text.
    const line = text.slice(at + "[dotabuff]".length).replace(/^\s*color:[^;]*;\S*/, "").trim();
    if (line) log(`  ${line}`);
  });
  win.webContents.on("render-process-gone", (_e, details) =>
    fail(`the browser window crashed (${details.reason})`),
  );

  log("Dotabuff matchup scraper");
  log("  mode: browser — a hidden Chromium makes the requests, not Node");
  log(`\n  opening ${START_URL} …`);

  try {
    await win.loadURL(START_URL);
  } catch (err) {
    return fail(`could not load ${START_URL} — ${err.message}`, [
      "That is a network error rather than a block. Check the connection,",
      "and whether a VPN, proxy or DNS filter is in the way.",
    ]);
  }

  // A 403 challenge page still "loads" fine, so judge by what is on it.
  if ((await heroLinks(win)) < READY_LINKS) {
    warn("Cloudflare is showing a challenge instead of the hero list.");
    if (!options.headed) {
      log("  showing the window so you can clear it — usually one click.");
      win.show();
      win.focus();
    }
    const cleared = await waitUntil(
      async () => (await heroLinks(win)) >= READY_LINKS,
      options.challengeTimeout,
    );
    if (!cleared) {
      return fail("the Cloudflare challenge was not cleared in time", [
        "Rerun with --headed to watch the window and clear it by hand:",
        "",
        "  npm run scrape -- --browser --headed",
        "",
        "The cookie is kept between runs, so this should only happen once.",
      ]);
    }
    log("  challenge cleared — the cookie is kept, so the next run should be silent.");
    if (!options.headed) win.hide();
  }

  log("  hero list is up; injecting the collector.\n");

  await evaluate(
    win,
    `window.__dotabuffConfig = ${JSON.stringify({
      spacing: options.spacing,
      concurrency: options.concurrency,
    })};`,
  );
  await win.webContents.executeJavaScript(await buildCollector({ compact: true }), true);

  const finished = await waitUntil(async () => {
    const status = await evaluate(win, STATUS_PROBE, { stage: "gone" });
    if (status.stage === "failed") throw new Error("the collector stopped — see the log above");
    return status.stage === "done";
  }, options.timeout, 2000);

  if (windowClosed) return fail("the browser window was closed before the run finished");
  if (!finished) {
    return fail(`the collector did not finish within ${options.timeout / 1000}s`, [
      "Raise the budget with --timeout=1800, or watch it work with --headed.",
    ]);
  }

  const raw = await evaluate(win, `JSON.stringify(window.__dotabuff.payload)`, null);
  if (!raw) return fail("the collector finished but handed back nothing");

  const { heroes, matchups } = JSON.parse(raw);
  const kept = await carryOver(OUT_FILE, { heroes, matchups });
  if (kept.matchups) log(`  kept ${kept.matchups} hero(es) from the previous matchups.json`);
  if (kept.fields) log(`  kept lane/position data for ${kept.fields} hero(es) this run could not derive`);

  await writeMatchups(OUT_FILE, {
    heroes,
    matchups,
    source: "https://www.dotabuff.com/heroes (browser run)",
  });

  log(`\nWrote public/data/matchups.json`);
  log(
    `  ${Object.keys(matchups).length}/${heroes.length} heroes, ` +
      `${countCells(matchups)} matchup cells, ${((Date.now() - started) / 1000) | 0}s`,
  );
  app.exit(0);
}

app.disableHardwareAcceleration();
app.whenReady().then(() => run().catch((err) => fail(err.message)));
// Closing the window is a deliberate abort, not a successful finish.
app.on("window-all-closed", () => app.exit(1));
