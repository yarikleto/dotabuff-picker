#!/usr/bin/env node
/**
 * One command that rebuilds everything the picker reads.
 *
 *   npm run refresh                        # every step, in order
 *   npm run refresh -- --steps=counters    # just one (comma-separated)
 *   npm run refresh -- --skip=timings      # all but one
 *   npm run refresh -- --list              # what the steps are, and stop
 *
 * The collectors have separate entry points because they have separate
 * failure modes, separate rate limits and separate resume files. That is right
 * for debugging and wrong for the ordinary "the patch dropped, update it" case,
 * where remembering all but one of the commands is how a stale synergies.json
 * survives six patches without anyone noticing.
 *
 * So: one command, a summary at the end that shows the *age of every file*
 * rather than only the ones this run touched, and a non-zero exit if anything
 * failed. Steps do not stop each other — a rate-limited OpenDota should not
 * cost you the Dotabuff scrape that already succeeded.
 *
 * Anything else on the command line is forwarded to every step. Each script
 * only reads the flags it knows, so `--headed`, `--fresh` or `--matches=800000`
 * can be passed here and land where they mean something.
 */

import { spawn } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseEntries } from "./roster.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(ROOT, "public", "data");
const SCRIPTS = join(ROOT, "scripts");

/**
 * Node flags for a step that runs the app's own TypeScript — see
 * scripts/ts-resolve.mjs. A file URL rather than a path, because `--import`
 * refuses a bare Windows path.
 */
const TS_NODE_ARGS = [
  "--experimental-strip-types",
  "--no-warnings",
  "--import",
  pathToFileURL(join(SCRIPTS, "register-ts-resolve.mjs")).href,
];

// ---------------------------------------------------------------- the steps

const STEPS = [
  {
    key: "roster",
    what: "who is in the game — OpenDota's hero list into src/data/heroes.ts",
    script: "roster.mjs",
    args: [],
    // First: every later step finds heroes through this roster, the scrape
    // included when Dotabuff's own hero list is blocked.
    describe: async () => {
      try {
        const src = await readFile(join(ROOT, "src", "data", "heroes.ts"), "utf8");
        // No age: an unchanged roster is current, not stale.
        return { detail: `${parseEntries(src).length} heroes`, at: null };
      } catch {
        return null;
      }
    },
  },
  {
    key: "counters",
    what: "who beats whom — Dotabuff matchup tables",
    script: "scrape.mjs",
    args: [],
    // Runs first: synergy.mjs falls back to these positions when positions.json is missing.
    describe: () =>
      describeJson("matchups.json", (d) => [
        `${Object.keys(d.matchups ?? {}).length} heroes`,
        `${Object.values(d.matchups ?? {}).reduce((n, t) => n + Object.keys(t).length, 0)} cells`,
        `${(d.heroes ?? []).filter((h) => h.topPositions?.length).length} with positions`,
      ]),
  },
  {
    key: "positions",
    what: "who plays where — STRATZ position counts, three rank bands",
    script: "positions.mjs",
    args: [],
    // Before synergies: synergy.mjs assigns positions from this file.
    describe: () =>
      describeJson("positions.json", (d) => [
        `${Object.keys(d.heroes ?? {}).length} heroes`,
        `${Object.keys(d.bands ?? {}).length} rank bands`,
        `${(d.weeks ?? []).length} weeks`,
      ]),
  },
  {
    key: "synergies",
    what: "who belongs together — OpenDota pair records",
    script: "synergy.mjs",
    args: [],
    describe: () =>
      describeJson("synergies.json", (d) => [
        `${Object.keys(d.synergies ?? {}).length} heroes`,
        // Each unordered pair is stored once, under whichever slug sorts first.
        `${Object.values(d.synergies ?? {}).reduce((n, p) => n + Object.keys(p).length, 0)} pairs`,
        `${thousands(d.matches)} matches`,
      ]),
  },
  {
    key: "timings",
    what: "when a line-up wins — OpenDota win rate by game length",
    script: "timings.mjs",
    args: [],
    describe: () =>
      describeJson("timings.json", (d) => [
        `${Object.keys(d.timings ?? {}).length} heroes`,
        `${(d.buckets ?? []).length} buckets`,
        `${thousands(d.matches)} matches`,
      ]),
  },
  {
    key: "lanes",
    what: "who wins the lane — STRATZ lane outcomes",
    script: "lanes.mjs",
    args: [],
    describe: () =>
      describeJson("lanes.json", (d) => [
        `${Object.keys(d.against ?? {}).length} heroes`,
        `${Object.values(d.against ?? {}).reduce(
          (n, byPosition) => n + Object.values(byPosition).reduce((m, t) => m + Object.keys(t).length, 0),
          0,
        )} lane pairs`,
        `${(d.weeks ?? []).length} weeks`,
      ]),
  },
  {
    key: "portraits",
    what: "hero portraits from Valve's CDN",
    script: "scrape.mjs",
    args: ["--images-only"],
    describe: async () => {
      try {
        const files = await readdir(join(ROOT, "public", "heroes"));
        const pngs = files.filter((f) => f.endsWith(".png"));
        if (!pngs.length) return null;
        const newest = Math.max(
          ...(await Promise.all(
            pngs.map(async (f) => (await stat(join(ROOT, "public", "heroes", f))).mtimeMs),
          )),
        );
        return { detail: `${pngs.length} files`, at: newest };
      } catch {
        return null;
      }
    },
  },
  {
    key: "calibrate",
    what: "what a draft is worth — the win-chance model, fitted on OpenDota games",
    script: "calibrate.mjs",
    args: [],
    nodeArgs: TS_NODE_ARGS,
    // After every collector: it fits the model on the files they just wrote,
    // from games older than the synergy and timing samples.
    describe: () =>
      describeJson("calibration.json", (d) => [
        `${thousands(d.matches)} matches`,
        `log-loss ${Number(d.holdout?.logLoss).toFixed(4)} vs ${Number(d.holdout?.baseline).toFixed(4)}`,
        `range ${Math.round((d.range?.[0] ?? 0) * 100)}–${Math.round((d.range?.[1] ?? 0) * 100)}%`,
      ]),
  },
  {
    key: "readme",
    what: "the README's badges and data table, from the files above",
    script: "readme.mjs",
    args: [],
    // Joins any run that includes another step, --steps or not: the commit that
    // carries new numbers has to carry the README that describes them.
    trailing: true,
    describe: async () => {
      try {
        const readme = await readFile(join(ROOT, "README.md"), "utf8");
        const patch = readme.match(/alt="Data patch: ([^"]+)"/)?.[1];
        return patch ? { detail: `data patch ${patch}`, at: null } : null;
      } catch {
        return null;
      }
    },
  },
];

// ---------------------------------------------------------------- CLI options

const argv = process.argv.slice(2);
const opt = (name) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3).split(",").map((s) => s.trim()).filter(Boolean) : [];
};

const log = (line = "") => process.stdout.write(`${line}\n`);
const thousands = (n) => String(n ?? 0).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const KEYS = STEPS.map((s) => s.key);

function chosen() {
  const only = opt("steps");
  const skip = opt("skip");
  for (const key of [...only, ...skip]) {
    if (!KEYS.includes(key)) {
      throw new Error(`unknown step "${key}" — pick from ${KEYS.join(", ")}`);
    }
  }
  const picked = STEPS.filter((s) => (only.length ? only.includes(s.key) : true) && !skip.includes(s.key));
  const trailing = STEPS.filter((s) => s.trailing && !picked.includes(s) && !skip.includes(s.key));
  return picked.length ? [...picked, ...trailing] : picked;
}

/** Everything that is not ours goes through to the individual scripts. */
const forwarded = argv.filter((a) => !/^--(steps|skip|list)(=|$)/.test(a));

// ------------------------------------------------------------------ reporting

async function describeJson(name, parts) {
  try {
    const file = join(DATA, name);
    const data = JSON.parse(await readFile(file, "utf8"));
    const at = Date.parse(data.generatedAt) || (await stat(file)).mtimeMs;
    return { detail: parts(data).join(", "), at };
  } catch {
    return null;
  }
}

function age(at, now) {
  const minutes = Math.round((now - at) / 60000);
  if (minutes < 2) return "just now";
  if (minutes < 90) return `${minutes}m old`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours}h old`;
  return `${Math.round(hours / 24)}d old`;
}

const rule = (label = "") =>
  log(`\n${"─".repeat(4)} ${label} ${"─".repeat(Math.max(2, 68 - label.length))}\n`);

// ---------------------------------------------------------------------- main

function runStep(step) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [...(step.nodeArgs ?? []), join(SCRIPTS, step.script), ...step.args, ...forwarded],
      { stdio: "inherit" },
    );
    child.on("error", reject);
    child.on("exit", (code) => resolve(code === 0));
  });
}

async function main() {
  if (argv.includes("--list")) {
    log("Steps, in the order `npm run refresh` runs them:\n");
    for (const s of STEPS) log(`  ${s.key.padEnd(10)} ${s.what}`);
    log("\nRun a subset with --steps=a,b or leave one out with --skip=a");
    log("readme joins every run, --steps included, unless --skip=readme\n");
    return 0;
  }

  const steps = chosen();
  const started = Date.now();
  log(`Refreshing ${steps.length} of ${STEPS.length} data sets: ${steps.map((s) => s.key).join(", ")}`);

  const results = [];
  for (const [i, step] of steps.entries()) {
    rule(`${i + 1}/${steps.length}  ${step.key} — ${step.what}`);
    results.push({ step, ok: await runStep(step) });
  }

  // Report on every data set, not just the ones this run touched: a summary
  // that hides an untouched, six-patch-old timings.json is the problem this
  // command exists to solve.
  rule("summary");
  const now = Date.now();
  const failed = results.filter((r) => !r.ok).map((r) => r.step.key);
  for (const step of STEPS) {
    const result = results.find((r) => r.step === step);
    const state = !result ? "  --  " : result.ok ? "  ok  " : " FAIL ";
    const found = await step.describe();
    const detail = found ? found.detail : "no data file yet";
    log(`  ${state}  ${step.key.padEnd(10)} ${detail.padEnd(52)} ${found?.at ? age(found.at, now) : ""}`);
  }

  const seconds = Math.round((now - started) / 1000);
  log(`\n  ${steps.length - failed.length}/${steps.length} steps in ${Math.floor(seconds / 60)}m${seconds % 60}s`);
  if (failed.length) {
    log(`\n  Failed: ${failed.join(", ")}. The output above says why; to retry just those:`);
    log(`\n    npm run refresh -- --steps=${failed.join(",")}`);
  }
  log("");
  return failed.length ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`\nRefresh failed: ${err.message}\n`);
    process.exit(1);
  },
);
