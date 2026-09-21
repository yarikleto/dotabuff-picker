import test from "node:test";
import assert from "node:assert/strict";
import {
  EARLY_SCALE,
  TARGET_EARLY_COVER,
  deriveTimingShape,
  earlyCover,
  earlyCoverPenalty,
  earlySkew,
  exposure,
  teamCover,
  weightedEdge,
} from "./timing.ts";
import type { Hero, HeroTiming } from "../types.ts";

// Run with: node --test --experimental-strip-types src/lib/*.test.ts

/**
 * A hero with a made-up curve.
 *
 * `games` is passed per bucket because it is what the duration distribution is
 * derived from — the tests that care about weighting have to be able to say
 * "hardly any games end here" without also saying anything about win rates.
 */
const timed = (slug: string, skews: number[], games: number[]): Hero => ({
  slug,
  name: slug.toUpperCase(),
  attr: "uni",
  steam: slug,
  winRate: 50,
  timings: skews.map(
    (skew, i): HeroTiming => ({ games: games[i] ?? 1000, winRate: 50 + skew, skew }),
  ),
});

/**
 * Four windows in the shape the live table has: a first one that hardly any
 * game reaches the end of, and two long ones that most do. The exact figures
 * are 2/24/41/33 in the real file; these are rounder and make the same point.
 */
const POOL = [
  timed("early-a", [6, 4, -1, -4], [200, 2400, 4100, 3300]),
  timed("early-b", [4, 2, 0, -3], [200, 2400, 4100, 3300]),
  timed("flat", [0, 0, 0, 0], [200, 2400, 4100, 3300]),
  timed("late-a", [-4, -3, 1, 4], [200, 2400, 4100, 3300]),
  timed("late-b", [-8, -6, 1, 6], [200, 2400, 4100, 3300]),
];

const shape = () => deriveTimingShape(POOL, 4);

test("the duration distribution is read off the table, not assumed flat", () => {
  const s = shape();
  assert.ok(s);
  assert.deepEqual(
    s.shares.map((x) => Number(x.toFixed(3))),
    [0.02, 0.24, 0.41, 0.33],
  );
  assert.equal(
    Number(s.shares.reduce((a, b) => a + b, 0).toFixed(6)),
    1,
    "shares must be a distribution",
  );
});

test("the early windows are the ones that close before the median game", () => {
  const s = shape();
  assert.ok(s);
  // 2% + 24% = 26% < 50%, and adding the third would pass it, so two windows.
  assert.deepEqual(s.earlyWindows, [0, 1]);
  assert.equal(Number(s.earlyMass.toFixed(3)), 0.26);
  // Renormalised, so the 25–35 window carries twelve times the first one.
  assert.deepEqual(
    s.earlyWeights.map((w) => Number(w.toFixed(4))),
    [0.0769, 0.9231],
  );
});

test("a table whose first window already holds half the games still yields a shape", () => {
  const lopsided = [timed("a", [1, 0], [9000, 1000]), timed("b", [-1, 0], [9000, 1000])];
  const s = deriveTimingShape(lopsided, 2);
  assert.ok(s, "must not return null just because the split is degenerate");
  assert.deepEqual(s.earlyWindows, [0], "falls back to the first window alone");
  assert.deepEqual(s.earlyWeights, [1]);
});

test("no timing rows at all means no shape, rather than a fabricated one", () => {
  const bare: Hero = { slug: "x", name: "X", attr: "uni", steam: "x" };
  assert.equal(deriveTimingShape([bare], 4), null);
  assert.equal(deriveTimingShape(POOL, 0), null);
});

test("early skew weights the windows by how often games end in them", () => {
  const s = shape();
  const hero = timed("x", [10, 0, 0, 0], [200, 2400, 4100, 3300]);
  const skew = earlySkew(hero, s);
  assert.ok(skew !== null);
  // Ten points in the window holding 2% of games, nothing in the one holding
  // 24%: the flat mean would call this +5.0, which is the error being fixed.
  assert.equal(Number(skew.toFixed(3)), 0.769);
});

test("a window the collector never saw is dropped, not counted as zero", () => {
  const s = shape();
  const hero = timed("x", [6, 4, 0, 0], [0, 2400, 4100, 3300]);
  // Only the 25–35 window survives, so its figure is the whole answer rather
  // than being halved by an empty bucket standing in as average.
  assert.equal(earlySkew(hero, s), 4);
});

test("an untimed hero is unknown, which is not the same as average", () => {
  const bare: Hero = { slug: "x", name: "X", attr: "uni", steam: "x" };
  assert.equal(earlySkew(bare, shape()), null);
  assert.equal(earlyCover(bare, shape()), null);
  assert.equal(earlySkew(POOL[0]!, null), null);
});

test("cover reads an average hero as half a body and saturates at both ends", () => {
  const s = shape();
  const at = (skew: number) =>
    earlyCover(timed("x", [skew, skew, 0, 0], [200, 2400, 4100, 3300]), s);
  assert.equal(at(0), 0.5);
  assert.equal(at(EARLY_SCALE), 1);
  assert.equal(at(-EARLY_SCALE), 0);
  // The clamp is the point: one extraordinary hero cannot buy the draft more
  // than one body of early game, however good they are.
  assert.equal(at(EARLY_SCALE * 10), 1);
  assert.equal(at(-EARLY_SCALE * 10), 0);
});

test("undrafted slots are valued at the pool average, so an empty board costs nothing", () => {
  const s = shape();
  assert.ok(s);
  const empty = teamCover([], s);
  assert.equal(empty, null, "nothing measured at all is null, not a full team of averages");

  const one = teamCover([POOL[2]], s); // the flat hero, worth exactly half a body
  assert.ok(one !== null);
  assert.equal(Number(one.toFixed(4)), Number((0.5 + 4 * s.poolCover).toFixed(4)));
  assert.ok(
    earlyCoverPenalty(one, 2) === 0,
    "a single ordinary pick must not be charged for the four slots still to come",
  );
});

test("stacking late heroes is what the penalty actually catches", () => {
  const s = shape();
  const allLate = teamCover([POOL[4], POOL[4], POOL[4], POOL[3], POOL[3]], s);
  const balanced = teamCover([POOL[4], POOL[3], POOL[2], POOL[1], POOL[0]], s);
  assert.ok(allLate !== null && balanced !== null);
  assert.ok(allLate < balanced);
  assert.ok(
    earlyCoverPenalty(balanced, 2) === 0,
    "a line-up with a carry and some early heroes pays nothing",
  );
  assert.ok(earlyCoverPenalty(allLate, 2) > 1, "five scaling heroes pay most of the weight");
});

test("the penalty is convex, so the third scaling hero costs more than the second", () => {
  const step = (cover: number) => earlyCoverPenalty(cover, 2);
  const second = step(TARGET_EARLY_COVER - 0.5) - step(TARGET_EARLY_COVER);
  const third = step(TARGET_EARLY_COVER - 1) - step(TARGET_EARLY_COVER - 0.5);
  const fourth = step(TARGET_EARLY_COVER - 1.5) - step(TARGET_EARLY_COVER - 1);
  assert.ok(third > second && fourth > third);
  // Never a bonus: a surplus of early heroes is not a reason to pick another,
  // or the term would quietly become a second meta score.
  assert.equal(earlyCoverPenalty(TARGET_EARLY_COVER + 3, 2), 0);
  assert.equal(earlyCoverPenalty(5, 2), 0);
  // At zero cover it is worth exactly the weight, and no more.
  assert.equal(earlyCoverPenalty(0, 2), 2);
});

test("zero weight turns the whole idea off", () => {
  assert.equal(earlyCoverPenalty(0, 0), 0);
  assert.equal(earlyCoverPenalty(null, 2), 0);
});

test("weighting by game length can flip the sign of a flat average", () => {
  const s = shape();
  // The shape that started this: badly behind early, ahead late, and read as a
  // slight edge by an unweighted mean of the four windows.
  const edges = [-4, -3, 0.5, 1.8];
  const flat = edges.reduce((a, b) => a + b, 0) / edges.length;
  const weighted = weightedEdge(edges, s);
  assert.ok(weighted !== null);
  assert.equal(Number(flat.toFixed(3)), -1.175);
  assert.equal(Number(weighted.toFixed(3)), -0.001);
  assert.ok(
    Math.abs(flat - weighted) > 1,
    "the two readings of the same four numbers differ by more than a whole point",
  );
  // And the other way round, which is the case the old mean flattered most: a
  // draft enormous in the window almost nobody reaches the end of.
  const frontloaded = weightedEdge([8, -1, -1, -1], s);
  assert.ok(frontloaded !== null && frontloaded < 0);
});

test("exposure counts the games that finish before the draft is ahead", () => {
  const s = shape();
  // Ahead only in the last window: everything before it has to be survived.
  assert.equal(Number(exposure([-4, -3, 0.2, 1.8], s, 0.5)!.toFixed(3)), 0.67);
  // Ahead from the first: nothing to survive.
  assert.equal(exposure([2, 2, 2, 2], s, 0.5), 0);
  // Never ahead anywhere is 1 — there is no window to hold on for.
  assert.equal(exposure([-1, -1, -1, -1], s, 0.5), 1);
  // The floor is honoured: an edge inside the noise is not being ahead.
  assert.equal(Number(exposure([0.4, 2, 0, 0], s, 0.5)!.toFixed(3)), 0.02);
});

test("mismatched inputs return null instead of a number built from the wrong buckets", () => {
  const s = shape();
  assert.equal(weightedEdge([1, 2], s), null);
  assert.equal(exposure([1, 2], s, 0.5), null);
  assert.equal(weightedEdge([1, 2, 3, 4], null), null);
  assert.equal(exposure([1, 2, 3, 4], null, 0.5), null);
});

test("cover counted beats cover averaged, which is the whole reason it is counted", () => {
  const s = shape();
  // Two sides with the same mean early skew and very different drafts: one is
  // uniformly mediocre, the other has one disaster and three heroes who lane.
  const spread = teamCover([POOL[4], POOL[0], POOL[0], POOL[0], POOL[2]], s);
  const uniform = teamCover([POOL[3], POOL[3], POOL[3], POOL[3], POOL[3]], s);
  assert.ok(spread !== null && uniform !== null);
  assert.ok(
    spread > uniform,
    "a side with real early heroes and one liability must read better than one with none",
  );
});
