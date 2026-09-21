import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { buildCollector } from "./build-collector.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const run = promisify(execFile);

/**
 * The collector is generated, so these tests build it exactly the way
 * scrape-electron.mjs does and run it inside a fake dotabuff.com page with the
 * saved fixtures served over a stubbed `fetch`. That covers the part the Node
 * scraper cannot: that the inlining produced a valid script, and that the
 * payload it leaves on the window is the same shape the scraper writes.
 *
 * jsdom is optional — it is not a dependency of the app, so skip when absent.
 */

/** node --check needs a path, and the collector is only ever a string. */
async function checkSyntax(script) {
  const file = join(await mkdtemp(join(tmpdir(), "collector-")), "collector.js");
  await writeFile(file, script, "utf8");
  await run("node", ["--check", file]);
}
let JSDOM;
try {
  ({ JSDOM } = await import("jsdom"));
} catch {
  JSDOM = null;
}

async function fixtures() {
  const [heroes, lanes, matchups] = await Promise.all([
    readFile(join(HERE, "fixtures", "heroes.html"), "utf8"),
    readFile(join(HERE, "fixtures", "lanes-mid.html"), "utf8"),
    readFile(join(HERE, "fixtures", "matchups.html"), "utf8"),
  ]);
  // parseHeroStats only trusts a table that lists every hero.
  const filler = Array.from({ length: 60 }, (_, i) => `
    <tr>
      <td class="cell-icon"><a href="/heroes/filler-${i}"><img src="x.jpg"></a></td>
      <td class="cell-large"><a href="/heroes/filler-${i}">Filler ${i}</a></td>
      <td class="cell-centered">C</td>
      <td class="cell-centered" data-value="50.0000">50.00%</td>
      <td class="cell-centered" data-value="0.0000">0.00%</td>
      <td class="cell-centered" data-value="5.0000">5.00%</td>
      <td class="cell-centered" data-value="0.0000">0.00%</td>
      <td class="cell-centered" data-value="0.5000">0.50%</td>
    </tr>`).join("");
  return { heroes: heroes.replace("<!--FILLER-->", filler), lanes, matchups };
}

/** Run the generated collector in a fake dotabuff page; return what it produced. */
async function runCollector({ hostname = "www.dotabuff.com", failPaths = [], compact = false } = {}) {
  const script = await buildCollector({ compact });
  const fx = await fixtures();

  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: `https://${hostname}/heroes`,
    runScripts: "outside-only",
  });
  const { window } = dom;

  const requested = [];
  window.fetch = async (path) => {
    requested.push(path);
    if (failPaths.includes(path)) return { ok: false, status: 500, text: async () => "" };
    const body = path.startsWith("/heroes/lanes")
      ? fx.lanes
      : path === "/heroes"
        ? fx.heroes
        : fx.matchups;
    return { ok: true, status: 200, text: async () => body };
  };

  const errors = [];
  window.console = { ...console, log() {}, warn() {}, error: (...a) => errors.push(String(a[1] ?? a[0])) };
  // Keep the suite quick; the real defaults are polite to Dotabuff.
  window.__dotabuffConfig = { spacing: 0, concurrency: 4 };

  window.eval(script);
  // The IIFE returns immediately; the run itself hangs off window.__dotabuff.
  await window.__dotabuff.done;

  return {
    // scrape-electron.mjs pulls the payload across a process boundary as JSON,
    // so round-trip it here too — the test should see what actually gets
    // written, not a live object from jsdom's realm.
    payload: window.__dotabuff.payload
      ? JSON.parse(JSON.stringify(window.__dotabuff.payload))
      : null,
    requested,
    errors,
    title: window.document.title,
  };
}

for (const compact of [false, true]) {
  const label = compact ? "compact" : "readable";

  test(`build-collector produces a valid ${label} script`, async () => {
    const script = await buildCollector({ compact });

    assert.match(script, /const P = \(\(\) => \{/, "parse.mjs must be wrapped");
    assert.match(script, /const R = \(\(\) => \{/, "roles.mjs must be wrapped");
    assert.match(script, /return \{ [^}]*parseMatchups/, "P must expose parseMatchups");
    assert.match(script, /return \{ [^}]*derivePositions/, "R must expose derivePositions");
    assert.doesNotMatch(script, /^export /m, "no ESM syntax survives — this is injected, not imported");
    assert.doesNotMatch(script, /^import /m);

    // Duplicate helpers in both modules must not collide in one scope.
    await checkSyntax(script);
  });
}

test("the compact build keeps regex literals intact", async () => {
  // The comment stripper has to tell `//` from a regex like /<\/table>/gi.
  // Getting this wrong silently guts the parser, so pin the tricky ones.
  const script = await buildCollector({ compact: true });

  assert.match(script, /const TABLE_RE = \/<table\[\^>\]\*>\(\[\\s\\S\]\*\?\)<\\\/table>\/gi;/);
  assert.match(script, /const NUMBER_IN_TEXT_RE = \/-\?\\d\+\(\?:,\\d\{3\}\)\*\(\?:\\\.\\d\+\)\?\/;/);
  // The generated banner is added after stripping, so skip the first line.
  const stripped = script.split("\n").slice(1).join("\n");
  assert.doesNotMatch(stripped, /^\s*\/\*/m, "block comments should be gone");
  assert.doesNotMatch(stripped, /^\s*\/\//m, "line comments should be gone");
  assert.ok(script.length < 20_000, `compact build should stay small, was ${script.length}`);
});

test("the collector refuses to run outside dotabuff.com", { skip: !JSDOM }, async () => {
  const { errors, payload } = await runCollector({ hostname: "example.com" });
  assert.equal(payload, null, "no payload should be produced");
  assert.ok(
    errors.some((e) => /dotabuff\.com/.test(e)),
    `expected a hostname complaint, got: ${errors.join(" | ")}`,
  );
});

test("the collector builds the same payload shape as the scraper", { skip: !JSDOM }, async () => {
  // Compact is what gets injected into a page, so exercise that build.
  const { payload, requested, title } = await runCollector({ compact: true });

  assert.ok(payload, "the run should leave a payload on the window");
  assert.match(title, /done/);

  assert.ok(payload.generatedAt, "payload carries a timestamp");
  assert.match(payload.source, /browser collector/);
  assert.ok(Array.isArray(payload.heroes) && payload.heroes.length > 0);
  assert.equal(typeof payload.matchups, "object");

  // Hero stats came off the /heroes table.
  const pl = payload.heroes.find((h) => h.slug === "phantom-lancer");
  assert.equal(pl.name, "Phantom Lancer");
  assert.equal(pl.winRate, 53.0701);
  assert.equal(pl.tier, "S");

  // Attributes came off the Quick Search block.
  assert.equal(payload.heroes.find((h) => h.slug === "axe").attr, "str");
  assert.equal(payload.heroes.find((h) => h.slug === "lina").attr, "int");

  // Matchup rows are the same [disadvantage, winRate, matches] tuples.
  const anyTable = payload.matchups[Object.keys(payload.matchups)[0]];
  assert.deepEqual(anyTable.slark, [6.837, 42.663, 90848]);

  // Positions were derived from the lane pages.
  const withPositions = payload.heroes.filter((h) => h.topPositions?.length);
  assert.ok(withPositions.length > 0, "at least some heroes carry positions");

  // Lane pages and hero pages were both visited.
  assert.ok(requested.includes("/heroes"));
  assert.ok(requested.some((p) => p.startsWith("/heroes/lanes?lane=mid")));
  assert.ok(requested.some((p) => /\/heroes\/[a-z-]+\/matchups$/.test(p)));
});

test("a failed hero page does not sink the run", { skip: !JSDOM }, async () => {
  const { payload } = await runCollector({ failPaths: ["/heroes/axe/matchups"] });
  assert.ok(payload, "the rest of the run still produces a file");
  assert.equal(payload.matchups.axe, undefined, "the failed hero is simply absent");
  assert.ok(Object.keys(payload.matchups).length > 1);
});
