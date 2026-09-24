import test from "node:test";
import assert from "node:assert/strict";

import {
  COLORS,
  badgeBlock,
  badgePart,
  dataPatch,
  dataTable,
  describeData,
  formatSpan,
  formatWindow,
  patchAt,
  patchesBetween,
  periodWindow,
  projectLinks,
  readPatches,
  readmeDrift,
  replaceBlock,
  spanColor,
} from "./readme-status.mjs";

const at = (iso) => Date.parse(iso);

/** Valve's feed as it reads for the 7.40 to 7.41f stretch, out of order on purpose. */
const FEED = {
  success: true,
  patches: [
    { patch_number: "7.41f", patch_name: "7.41f", patch_timestamp: 1789455600 }, // 2026-09-15 07:00Z
    { patch_number: "7.41", patch_name: "7.41", patch_timestamp: 1774335600 }, // 2026-03-24
    { patch_number: "7.41e", patch_name: "7.41e", patch_timestamp: 1785394800 }, // 2026-07-30
    { patch_number: "7.40c", patch_name: "7.40c", patch_timestamp: 1768982400 }, // 2026-01-21
    { patch_number: "", patch_timestamp: 1 },
  ],
};
const PATCHES = readPatches(FEED);
const names = (span) => span.map((p) => p.name);

test("the feed is read oldest first and nameless entries are dropped", () => {
  assert.deepEqual(names(PATCHES), ["7.40c", "7.41", "7.41e", "7.41f"]);
  assert.equal(PATCHES[3].at, at("2026-09-15T07:00:00Z"));
  assert.deepEqual(readPatches(null), []);
});

test("a patch counts from the second it ships", () => {
  assert.equal(patchAt(PATCHES, at("2026-09-15T06:59:59Z")).name, "7.41e");
  assert.equal(patchAt(PATCHES, at("2026-09-15T07:00:00Z")).name, "7.41f");
  assert.equal(patchAt(PATCHES, at("2020-01-01T00:00:00Z")), null);
});

test("a window reports the patch it opened in and every one released inside it", () => {
  const stratz = periodWindow(["2026-08-20", "2026-09-16"]);
  assert.deepEqual(names(patchesBetween(PATCHES, stratz.from, stratz.to)), ["7.41e", "7.41f"]);

  const openDota = { from: at("2026-09-18T12:06:52Z"), to: at("2026-09-19T13:05:11Z") };
  assert.deepEqual(names(patchesBetween(PATCHES, openDota.from, openDota.to)), ["7.41f"]);
});

test("a STRATZ period runs to the last millisecond of its final day", () => {
  const w = periodWindow(["2026-08-20", "2026-09-16"]);
  assert.equal(w.from, at("2026-08-20T00:00:00Z"));
  assert.equal(w.to, at("2026-09-16T23:59:59.999Z"));
  assert.equal(periodWindow(["2026-09-16", "2026-08-20"]), null);
  assert.equal(periodWindow(undefined), null);
});

test("spans read as one name or first – last", () => {
  assert.equal(formatSpan([]), "unknown");
  assert.equal(formatSpan([{ name: "7.41f" }]), "7.41f");
  assert.equal(formatSpan([{ name: "7.41e" }, { name: "7.41f" }]), "7.41e – 7.41f");
});

test("colour: one patch, letter patches of one version, across versions, behind", () => {
  const [p740c, p741, p741e, p741f] = PATCHES;
  assert.equal(spanColor([p741f], p741f), COLORS.onePatch);
  assert.equal(spanColor([p741e, p741f], p741f), COLORS.letterPatches);
  assert.equal(spanColor([p740c, p741], p741), COLORS.majorPatches);
  // 7.41e data, written up after 7.41f shipped: the data is behind the game.
  assert.equal(spanColor([p741e], p741f), COLORS.behind);
  assert.equal(spanColor([], p741f), COLORS.neutral);
});

const FILES = {
  matchups: {
    generatedAt: "2026-09-19T13:06:14.190Z",
    heroes: [{ slug: "axe" }, { slug: "lion" }],
    matchups: { axe: { lion: [-1, 51, 100] }, lion: { axe: [1, 49, 100] } },
  },
  positions: {
    generatedAt: "2026-09-19T13:06:27.055Z",
    period: ["2026-08-20", "2026-09-16"],
    heroes: {
      axe: { all: [[10, 5], [20, 10], [60_000_000, 30_000_000], [0, 0], [0, 0]] },
      lion: { all: [[0, 0], [0, 0], [0, 0], [30, 15], [60_000_000, 29_000_000]] },
    },
  },
  lanes: {
    generatedAt: "2026-09-19T13:07:00.130Z",
    period: ["2026-08-20", "2026-09-16"],
    against: { axe: { 3: { lion: [1, 1, 0, 0, 1], zeus: [1, 0, 0, 1, 0] } }, lion: { 5: { axe: [1, 0, 0, 1, 0] } } },
  },
  synergies: { generatedAt: "2026-09-19T13:06:47.238Z", matches: 589_508, matchIdRange: [100, 200] },
  timings: { generatedAt: "2026-09-19T13:06:59.475Z", matches: 589_324, matchIdRange: [100, 250] },
};
const WINDOWS = { "100-200": { from: at("2026-09-18T12:06:52Z"), to: at("2026-09-19T13:05:11Z") } };

test("rows count what each file holds and date only the samples they can", () => {
  const rows = describeData(FILES, { sampleWindows: WINDOWS });
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
  assert.equal(byKey.counters.sample, "2 hero pairs");
  assert.equal(byKey.counters.window, null, "Dotabuff's range is not recorded");
  assert.equal(byKey.positions.sample, "12.0 million ranked matches");
  assert.equal(byKey.lanes.sample, "3 lane pairings");
  assert.equal(byKey.synergies.window.from, WINDOWS["100-200"].from);
  assert.equal(byKey.timings.window, null, "a different id range is not assumed to share dates");
});

test("the data patch spans every recorded window; the Dotabuff read date does not count", () => {
  const rows = describeData(FILES, { sampleWindows: WINDOWS });
  const patch = dataPatch(rows, PATCHES, at("2026-09-22T00:00:00Z"));
  assert.equal(patch.label, "7.41e – 7.41f");
  assert.equal(patch.color, COLORS.letterPatches);
  assert.equal(patch.latest.name, "7.41f");

  const none = dataPatch(describeData({}, {}), PATCHES, at("2026-09-22T00:00:00Z"));
  assert.equal(none.label, "unknown");
  assert.equal(dataPatch(rows, [], Date.now()).label, "unknown");
});

test("the table says what is missing instead of leaving a gap", () => {
  const table = dataTable(describeData({ ...FILES, lanes: null }, { sampleWindows: WINDOWS }), PATCHES);
  assert.match(table, /\| Counters \| Dotabuff \| read Sep 19, 2026 \| 2 hero pairs \| — \|/);
  assert.match(table, /\| Lanes by seat \| STRATZ \| not collected yet \|/);
  assert.match(table, /\| Synergies \| OpenDota \| Sep 18 – Sep 19, 2026 \| 589,508 matches \| 7\.41f \|/);
  assert.match(table, /\| Game length \| OpenDota \| unknown \|/);
  assert.ok(table.includes("| 7.41e\u00a0–\u00a07.41f |"), "a span stays on one line in the table");
});

test("windows across a new year keep both years", () => {
  const w = { from: at("2025-12-28T00:00:00Z"), to: at("2026-01-24T00:00:00Z") };
  assert.equal(formatWindow(w), "Dec 28, 2025 – Jan 24, 2026");
});

test("badge text escapes shields' separators", () => {
  assert.equal(badgePart("data patch"), "data_patch");
  assert.equal(badgePart("7.41e – 7.41f"), "7.41e_%E2%80%93_7.41f");
  assert.equal(badgePart("a-b_c"), "a--b__c");
});

test("the repository field gives the site and repo links in any form npm accepts", () => {
  const expected = { site: null, slug: "owner/repo", repo: "https://github.com/owner/repo", license: null };
  assert.deepEqual(projectLinks({ repository: "github:owner/repo" }), expected);
  assert.deepEqual(projectLinks({ repository: { url: "git+https://github.com/owner/repo.git" } }), expected);
  assert.deepEqual(projectLinks({ repository: "git@github.com:owner/repo.git" }), expected);
  assert.equal(projectLinks({}).slug, null);
  assert.equal(projectLinks({ license: "MIT" }).license, "MIT");
});

test("the badge block links the site and deploy status only when it knows where they are", () => {
  const rows = describeData(FILES, { sampleWindows: WINDOWS });
  const patch = dataPatch(rows, PATCHES, at("2026-09-22T00:00:00Z"));
  const withLinks = badgeBlock({
    rows,
    patch,
    heroes: 127,
    links: {
      site: "https://owner.github.io/repo/",
      slug: "owner/repo",
      repo: "https://github.com/owner/repo",
      license: "MIT",
    },
  });
  assert.match(withLinks, /alt="Data patch: 7\.41e – 7\.41f"/);
  assert.match(withLinks, /alt="Data collected Sep 19, 2026"/);
  assert.match(withLinks, /workflow\/status\/owner\/repo\/pages\.yml/);
  assert.match(withLinks, /alt="Code license: MIT"/);
  assert.match(withLinks, /<h3><a href="https:\/\/owner\.github\.io\/repo\/">Open the picker →<\/a><\/h3>/);
  assert.doesNotMatch(withLinks, /src="[^"]*"[^>]*src=/, "one src per tag");

  const bare = badgeBlock({ rows, patch, heroes: 127, links: { site: null, slug: null, repo: null } });
  assert.doesNotMatch(bare, /workflow\/status|Open the picker|Code license/);
});

test("a block is replaced between its markers and nowhere else", () => {
  const readme = [
    "# Title",
    "<!-- badges:start — generated -->",
    "old",
    "<!-- badges:end -->",
    "prose that mentions badges:start",
  ].join("\n");
  const once = replaceBlock(readme, "badges", "new");
  assert.equal(
    once,
    ["# Title", "<!-- badges:start — generated -->", "new", "<!-- badges:end -->", "prose that mentions badges:start"].join(
      "\n",
    ),
  );
  assert.equal(replaceBlock(once, "badges", "new"), once, "running twice changes nothing");
  assert.throws(() => replaceBlock("# no markers", "data", "x"), /no <!-- data:start -->/);
});

test("a README written from the files has no drift; refreshed files show exactly what moved", () => {
  const rows = describeData(FILES, { sampleWindows: WINDOWS });
  const patch = dataPatch(rows, PATCHES, at("2026-09-22T00:00:00Z"));
  const readme = [
    "<!-- badges:start -->",
    badgeBlock({ rows, patch, heroes: 2, links: { site: null, slug: null, repo: null } }),
    "<!-- badges:end -->",
    "<!-- data:start -->",
    dataTable(rows, PATCHES),
    "<!-- data:end -->",
  ].join("\n");
  assert.deepEqual(readmeDrift(readme, { files: FILES, heroes: 2 }), [], "undated OpenDota windows are not drift");

  const refreshed = {
    ...FILES,
    matchups: { ...FILES.matchups, generatedAt: "2026-10-02T09:00:00.000Z" },
    positions: { ...FILES.positions, period: ["2026-09-03", "2026-09-30"] },
    synergies: { ...FILES.synergies, matches: 601_000 },
  };
  const drift = readmeDrift(readme, { files: refreshed, heroes: 3 });
  const text = drift.join("\n");
  assert.match(text, /heroes badge should say 3/);
  assert.match(text, /Counters: the table says "read Sep 19, 2026", the file "read Oct 2, 2026"/);
  assert.match(text, /Positions by rank: the table says "Aug 20 – Sep 16, 2026", the file "Sep 3 – Sep 30, 2026"/);
  assert.match(text, /Synergies: the table says "589,508 matches", the file "601,000 matches"/);
  assert.equal(drift.length, 4, text);
});

test("a README without its blocks reports both badges and every row", () => {
  const drift = readmeDrift("# nothing generated here", { files: FILES, heroes: 2 });
  assert.match(drift.join("\n"), /collected badge should say "Data collected Sep 19, 2026"/);
  assert.match(drift.join("\n"), /heroes badge should say 2/);
  assert.equal(drift.filter((d) => d.startsWith("the data table has no")).length, 6);
});

test("the win model is dated by its match ids, like the other OpenDota samples", () => {
  const withModel = {
    ...FILES,
    calibration: { generatedAt: "2026-09-23T10:00:00.000Z", matches: 301_000, matchIdRange: [50, 99] },
  };
  const windows = { ...WINDOWS, "50-99": { from: at("2026-09-16T00:00:00Z"), to: at("2026-09-17T00:00:00Z") } };
  const row = describeData(withModel, { sampleWindows: windows }).find((r) => r.key === "calibration");
  assert.equal(row.what, "Win model");
  assert.equal(row.source, "OpenDota");
  assert.equal(row.sample, "301,000 matches");
  assert.equal(row.window.from, windows["50-99"].from);
  assert.match(
    dataTable(describeData(FILES, { sampleWindows: WINDOWS }), PATCHES),
    /\| Win model \| OpenDota \| not collected yet \|/,
  );
});
