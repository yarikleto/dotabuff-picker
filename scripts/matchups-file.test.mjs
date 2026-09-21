import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { carryOver, countCells, writeMatchups } from "./matchups-file.mjs";

/**
 * The dataset is a merge, not a snapshot: every run has to publish at least as
 * much as the run before it. These cover both halves of that — the matchup
 * tables, and the hero fields that come from the separately-fetched lane pages.
 */

async function fixture(previous) {
  const dir = await mkdtemp(join(tmpdir(), "matchups-"));
  const file = join(dir, "matchups.json");
  if (previous) await writeFile(file, JSON.stringify(previous), "utf8");
  return file;
}

const PREVIOUS = {
  heroes: [
    {
      slug: "axe",
      name: "Axe",
      attr: "str",
      winRate: 50.26,
      lanes: { off: { presence: 0.9 } },
      positions: { 3: 0.92 },
      topPositions: [3],
    },
    { slug: "pudge", name: "Pudge", attr: "str", positions: { 4: 0.7 }, topPositions: [4] },
  ],
  matchups: { axe: { pudge: [1, 50, 10] }, pudge: { axe: [-1, 51, 10] } },
};

test("heroes this run missed keep their previous tables", async () => {
  const file = await fixture(PREVIOUS);
  const matchups = { axe: { pudge: [2, 49, 20] } };
  const kept = await carryOver(file, { heroes: [], matchups });

  assert.equal(kept.matchups, 1, "pudge should have been carried over");
  assert.deepEqual(matchups.pudge, { axe: [-1, 51, 10] });
  assert.deepEqual(matchups.axe, { pudge: [2, 49, 20] }, "a fresh table must win");
});

test("a run that could not read the lane pages keeps the positions it had", async () => {
  // The regression this guards: --offline, --no-lanes and a partial 403 all
  // produce a roster with no positions. Writing that as-is looks like a
  // complete file while silently switching the app's role filters off.
  const file = await fixture(PREVIOUS);
  const heroes = [
    { slug: "axe", name: "Axe", attr: "str" },
    { slug: "pudge", name: "Pudge", attr: "str" },
  ];
  const kept = await carryOver(file, { heroes, matchups: {} });

  assert.equal(kept.fields, 2);
  assert.deepEqual(heroes[0].positions, { 3: 0.92 });
  assert.deepEqual(heroes[0].topPositions, [3]);
  assert.deepEqual(heroes[0].lanes, { off: { presence: 0.9 } });
  assert.equal(heroes[0].winRate, 50.26);
  assert.deepEqual(heroes[1].topPositions, [4]);
});

test("freshly derived positions are never overwritten by stale ones", async () => {
  const file = await fixture(PREVIOUS);
  const heroes = [{ slug: "axe", name: "Axe", attr: "str", positions: { 1: 0.8 }, topPositions: [1] }];
  await carryOver(file, { heroes, matchups: {} });

  assert.deepEqual(heroes[0].positions, { 1: 0.8 });
  assert.deepEqual(heroes[0].topPositions, [1]);
  assert.equal(heroes[0].winRate, 50.26, "fields the run did not set still come across");
});

test("a hero that did not exist before is left alone", async () => {
  const file = await fixture(PREVIOUS);
  const heroes = [{ slug: "kez", name: "Kez", attr: "agi" }];
  const kept = await carryOver(file, { heroes, matchups: {} });

  assert.equal(kept.fields, 0);
  assert.deepEqual(Object.keys(heroes[0]), ["slug", "name", "attr"]);
});

test("no previous file, and an unreadable one, both carry over nothing", async () => {
  assert.deepEqual(await carryOver(await fixture(null), { heroes: [], matchups: {} }), {
    matchups: 0,
    fields: 0,
  });

  const broken = await fixture(null);
  await writeFile(broken, "{ not json", "utf8");
  assert.deepEqual(await carryOver(broken, { heroes: [], matchups: {} }), {
    matchups: 0,
    fields: 0,
  });
});

test("an empty previous table is not carried over as if it were data", async () => {
  const file = await fixture({ heroes: [], matchups: { axe: {} } });
  const matchups = {};
  const kept = await carryOver(file, { heroes: [], matchups });

  assert.equal(kept.matchups, 0);
  assert.deepEqual(matchups, {});
});

test("writeMatchups produces the shape the app reads", async () => {
  const file = await fixture(null);
  await writeMatchups(file, {
    heroes: PREVIOUS.heroes,
    matchups: PREVIOUS.matchups,
    source: "test",
  });

  const written = JSON.parse(await readFile(file, "utf8"));
  assert.equal(written.source, "test");
  assert.match(written.note, /^matchups\[a\]\[b\]/);
  assert.ok(Date.parse(written.generatedAt) > 0);
  assert.equal(written.heroes.length, 2);
  assert.equal(countCells(written.matchups), 2);
});
