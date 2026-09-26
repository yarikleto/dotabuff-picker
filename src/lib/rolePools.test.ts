import test from "node:test";
import assert from "node:assert/strict";
import {
  EMPTY_POOLS,
  MAX_POOL,
  MIN_OTHERS,
  addPoolHero,
  clearPools,
  poolFirst,
  poolIndex,
  poolSeat,
  poolSize,
  readRolePools,
  togglePoolHero,
  type RolePools,
} from "./rolePools.ts";
import { DEFAULT_SETTINGS, rankAll, type DraftView } from "./scoring.ts";
import type { Dataset, DraftPick, Hero, Position } from "../types.ts";

// Run with: node --test --experimental-strip-types src/lib/*.test.ts

const hero = (
  slug: string,
  winRate: number,
  positions: Partial<Record<Position, number>>,
  positionWinRate: Partial<Record<Position, number>> = {},
): Hero => ({
  slug,
  name: slug.toUpperCase(),
  attr: "uni",
  steam: slug,
  winRate,
  pickRate: 5,
  positions,
  positionWinRate,
  topPositions: (Object.keys(positions).map(Number) as Position[]).filter(
    (p) => (positions[p] ?? 0) >= 0.12,
  ),
});

/**
 * Offlaners only, no matchups: with an empty board the score is the meta term
 * alone, so the order is the win-rate order and every place is predictable.
 */
function makeDataset(): Dataset {
  const heroes = [
    hero("best", 58, { 3: 1 }),
    hero("good", 55, { 3: 1 }),
    hero("fine", 53, { 3: 1 }),
    ...Array.from({ length: 8 }, (_, i) => hero(`filler${i}`, 52 - i * 0.5, { 3: 1 })),
    hero("weak", 42, { 3: 1 }),
    // Plays the offlane in 2% of games, under the 5% role threshold.
    hero("rare", 50, { 3: 0.02, 5: 0.98 }, { 3: 49, 5: 50 }),
    hero("flex", 51, { 3: 0.5, 4: 0.5 }),
  ];
  return {
    heroes,
    bySlug: new Map(heroes.map((h) => [h.slug, h])),
    matchups: {},
    synergies: {},
    generatedAt: null,
    hasData: true,
    hasPositions: true,
    hasSynergies: false,
    synergyMatches: 0,
    hasTimings: false,
    timingBuckets: [],
    timingShape: null,
    timingMatches: 0,
    error: null,
  };
}

const data = makeDataset();
const settings = DEFAULT_SETTINGS;
const EMPTY: DraftView = { mine: [], enemy: [], banned: [] };
const pick = (slug: string, position: Position | null = null): DraftPick => ({ slug, position });
const pools = (entries: Partial<RolePools>): RolePools => ({ ...EMPTY_POOLS, ...entries });

const listFor = (draft: DraftView, position: Position | null, roster: RolePools, limit = 10) =>
  poolFirst(data, draft, settings, position, rankAll(data, draft, settings, position, "pick"), roster, limit);

test("readRolePools keeps lists of slugs and drops everything else", () => {
  assert.deepEqual(readRolePools(null), EMPTY_POOLS);
  assert.deepEqual(readRolePools("axe"), EMPTY_POOLS);
  const read = readRolePools({ 1: ["axe", 3, "", "axe", "mars"], 2: "lina", 6: ["pudge"] });
  assert.deepEqual(read[1], ["axe", "mars"], "strings only, each once, in order");
  assert.deepEqual(read[2], [], "a non-list is an empty pool");
  assert.equal(Object.keys(read).length, 5, "only the five roles");
  const long = readRolePools({ 3: Array.from({ length: 40 }, (_, i) => `h${i}`) });
  assert.equal(long[3].length, MAX_POOL);
});

test("togglePoolHero adds, removes and stops at the cap", () => {
  const one = togglePoolHero(EMPTY_POOLS, 3, "axe");
  assert.deepEqual(one[3], ["axe"]);
  assert.deepEqual(EMPTY_POOLS[3], [], "the input is not mutated");
  assert.deepEqual(togglePoolHero(one, 3, "axe")[3], []);
  assert.equal(addPoolHero(one, 3, "axe"), one, "adding a hero already there changes nothing");

  const full = pools({ 3: Array.from({ length: MAX_POOL }, (_, i) => `h${i}`) });
  assert.equal(togglePoolHero(full, 3, "axe"), full);
});

test("clearPools empties one role or all of them", () => {
  const roster = pools({ 1: ["am"], 3: ["axe", "mars"] });
  assert.deepEqual(clearPools(roster, 3), pools({ 1: ["am"] }));
  assert.deepEqual(clearPools(roster, null), EMPTY_POOLS);
  assert.equal(poolSize(roster), 3);
});

test("poolIndex lists every role a hero is pooled for", () => {
  const index = poolIndex(pools({ 3: ["mars"], 4: ["mars", "tusk"] }));
  assert.deepEqual(index.get("mars"), [3, 4]);
  assert.deepEqual(index.get("tusk"), [4]);
  assert.equal(index.has("axe"), false);
});

test("pooled heroes lead the list best to worst, however weak, with their true place", () => {
  const rows = listFor(EMPTY, 3, pools({ 3: ["weak", "good"] }));
  assert.deepEqual(
    rows.slice(0, 2).map((r) => [r.suggestion.hero.slug, r.place, r.pooled]),
    [
      ["good", 2, [3]],
      ["weak", 13, [3]],
    ],
  );
  const others = rows.slice(2);
  assert.equal(others[0]!.suggestion.hero.slug, "best", "then the best of everyone else");
  assert.equal(others[0]!.place, 1);
  assert.ok(others.every((r) => r.pooled.length === 0));
  assert.ok(!others.some((r) => r.suggestion.hero.slug === "good"), "a pooled hero appears once");
  assert.equal(rows.length, 10);
});

test("a long pool still leaves room for the best of everyone else", () => {
  const roster = pools({ 3: ["weak", "fine", "filler0", "filler1", "filler2", "filler3", "filler4"] });
  const rows = listFor(EMPTY, 3, roster);
  assert.equal(rows.filter((r) => r.pooled.length).length, 7);
  assert.equal(rows.filter((r) => !r.pooled.length).length, MIN_OTHERS);
});

test("a pooled hero under the role threshold is scored and placed anyway", () => {
  const rows = listFor(EMPTY, 3, pools({ 3: ["rare"] }));
  const rare = rows[0]!;
  assert.equal(rare.suggestion.hero.slug, "rare");
  assert.equal(rare.ranked, false);
  assert.equal(rare.suggestion.position, 3, "scored for the seat asked about");
  const ranking = rankAll(data, EMPTY, settings, 3, "pick");
  assert.ok(!ranking.some((s) => s.hero.slug === "rare"), "the ranking proper still leaves them out");
  assert.equal(rare.place, 1 + ranking.filter((s) => s.score > rare.suggestion.score).length);
});

test("a pooled hero already on the board or banned is not offered", () => {
  const roster = pools({ 3: ["good", "fine", "weak"] });
  const draft: DraftView = { mine: [], enemy: [pick("good", 3)], banned: [{ slug: "fine", by: "enemy" }] };
  const rows = listFor(draft, 3, roster);
  assert.deepEqual(
    rows.filter((r) => r.pooled.length).map((r) => r.suggestion.hero.slug),
    ["weak"],
  );
});

test("pooled heroes with equal scores keep the ranking's order", () => {
  const twin = hero("twin", 58, { 3: 1 });
  const withTwin = { ...data, heroes: [...data.heroes, twin], bySlug: new Map([...data.bySlug, ["twin", twin]]) };
  const ranking = rankAll(withTwin, EMPTY, settings, 3, "pick");
  const rows = poolFirst(withTwin, EMPTY, settings, 3, ranking, pools({ 3: ["twin", "best"] }), 10);
  assert.deepEqual(
    rows.slice(0, 2).map((r) => r.place),
    [1, 2],
  );
});

test("with no seat chosen the list reads the pools of the roles still open", () => {
  const roster = pools({ 3: ["weak"], 4: ["flex"] });
  const open = listFor(EMPTY, null, roster);
  assert.deepEqual(
    open.filter((r) => r.pooled.length).map((r) => [r.suggestion.hero.slug, r.pooled]),
    [
      ["flex", [4]],
      ["weak", [3]],
    ],
  );

  const offlaneTaken: DraftView = { mine: [pick("best", 3)], enemy: [], banned: [] };
  const rows = listFor(offlaneTaken, null, roster);
  assert.deepEqual(
    rows.filter((r) => r.pooled.length).map((r) => r.suggestion.hero.slug),
    ["flex"],
    "the offlane is filled, so its pool no longer leads",
  );
});

test("a chosen seat reads that role's pool even when it is already filled", () => {
  const draft: DraftView = { mine: [pick("best", 3)], enemy: [], banned: [] };
  const rows = listFor(draft, 3, pools({ 3: ["weak"] }));
  assert.equal(rows[0]!.suggestion.hero.slug, "weak");
});

test("poolSeat books a pooled hero into their pool's open role", () => {
  const flex = data.bySlug.get("flex");
  const roster = pools({ 3: ["flex"], 4: ["flex"] });
  assert.equal(poolSeat(roster, flex, [], 4), 4, "the seat being drafted for, when it is one of theirs");
  assert.equal(poolSeat(roster, flex, [], 1), 3, "otherwise the pooled seat they play most, first on a tie");
  assert.equal(poolSeat(roster, flex, [pick("x", 3)], null), 4, "only an open role");
  assert.equal(poolSeat(roster, flex, [pick("x", 3), pick("y", 4)], null), null);
  assert.equal(poolSeat(EMPTY_POOLS, flex, [], 3), null, "not pooled: the usual guess applies");
  assert.equal(poolSeat(roster, undefined, [], 3), null);
});
