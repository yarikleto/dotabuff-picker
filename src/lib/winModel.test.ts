import test from "node:test";
import assert from "node:assert/strict";
import {
  WIN_FEATURES,
  WIN_MODEL_FLOORS,
  calibrationDrift,
  draftFeatures,
  readCalibration,
  roleDeficit,
  winFeatures,
} from "./winModel.ts";
import type { Calibration } from "./winModel.ts";
import { deriveTimingShape, earlyCoverPenalty, teamCover } from "./timing.ts";
import type { Dataset, DraftPick, Hero, MatchupTable, Position, SynergyTable, TimingBucket } from "../types.ts";

// Run with: node --test --experimental-strip-types --import ./scripts/register-ts-resolve.mjs src/lib/winModel.test.ts

const SEATS: Position[] = [1, 2, 3, 4, 5];

/**
 * A hero who plays `main` in 90% of their games and every other seat in 2.5%,
 * winning `winRate` in their own seat and `offBy` points less anywhere else.
 */
function hero(slug: string, winRate: number, main: Position, offBy = 8): Hero {
  return {
    slug,
    name: slug.toUpperCase(),
    attr: "uni",
    steam: slug,
    winRate,
    positions: Object.fromEntries(SEATS.map((p) => [p, p === main ? 0.9 : 0.025])),
    positionWinRate: Object.fromEntries(SEATS.map((p) => [p, p === main ? winRate : winRate - offBy])),
  };
}

const pick = (slug: string, position: Position | null): DraftPick => ({ slug, position });
const seated = (heroes: Hero[]): DraftPick[] => heroes.map((h, i) => pick(h.slug, SEATS[i]!));
/** A matchup row from the page hero's side, `advantage` points in their favour. */
const row = (advantage: number, matches = 5_000) => ({
  disadvantage: -advantage,
  winRate: 50 + advantage,
  matches,
});
const pair = (synergy: number, matches = 5_000) => ({ synergy, matches, winRate: 50 + synergy });

function dataset(heroes: Hero[], matchups: MatchupTable = {}, synergies: SynergyTable = {}): Dataset {
  return {
    heroes,
    bySlug: new Map(heroes.map((h) => [h.slug, h])),
    matchups,
    synergies,
    generatedAt: "2026-09-19T00:00:00.000Z",
    hasData: true,
    hasPositions: true,
    hasSynergies: Object.keys(synergies).length > 0,
    synergyMatches: 0,
    hasTimings: false,
    timingBuckets: [],
    timingShape: null,
    timingMatches: 0,
    error: null,
  };
}

/** Five heroes who all play position 1, a sound line-up, and a sound enemy. */
const CARRIES = ["c1", "c2", "c3", "c4", "c5"].map((slug) => hero(slug, 52, 1));
const SOUND = SEATS.map((p) => hero(`s${p}`, 50, p));
const ENEMY = SEATS.map((p) => hero(`e${p}`, 50, p));

const CALIBRATION: Calibration = {
  generatedAt: "2026-09-23T00:00:00.000Z",
  matches: 300_000,
  matchIdRange: [9_000_000_000, 9_009_000_000],
  tau: 1.5,
  weights: {
    matchups: 0.046,
    cohesion: 0.018,
    heroes: 0.052,
    seatPenalty: 0.028,
    seatBonus: 0.02,
    roleDeficit: -0.08,
    timing: 0.01,
  },
  range: [0.15, 0.85],
  inputs: { matchups: "2026-09-19T00:00:00.000Z" },
  holdout: { logLoss: 0.672, baseline: 0.691, auc: 0.61 },
  reliability: [
    [0.35, 0.4, 74_115, 0.377, 0.378],
    [0.4, 0.45, 117_615, 0.426, 0.427],
    [0.45, 0.5, 146_917, 0.475, 0.477],
    [0.5, 0.55, 146_917, 0.525, 0.523],
  ],
};

test("matchups add up over every pairing, read under the model's own sample floor", () => {
  const data = dataset([...SOUND, ...ENEMY], {
    s1: { e1: row(2), e2: row(-1) },
    s2: { e1: row(3, WIN_MODEL_FLOORS.minMatches - 1) },
  });
  const f = draftFeatures(data, {
    mine: [pick("s1", 1), pick("s2", 2)],
    enemy: [pick("e1", 1), pick("e2", 2)],
  });
  assert.equal(f.matchups, 1, "s1 is +2 into e1 and −1 into e2; s2's thin row is left out");
});

test("swapping the line-ups negates every feature", () => {
  const data = dataset(
    [...SOUND, ...CARRIES],
    { s1: { c1: row(2) }, c3: { s4: row(-1.5) } },
    {
      s1: { s2: pair(1.2) },
      s2: { s1: pair(1.2) },
      c1: { c2: pair(-0.4) },
      c2: { c1: pair(-0.4) },
    },
  );
  const a = winFeatures(draftFeatures(data, { mine: seated(SOUND), enemy: seated(CARRIES) }), 1.5);
  const b = winFeatures(draftFeatures(data, { mine: seated(CARRIES), enemy: seated(SOUND) }), 1.5);
  for (const key of WIN_FEATURES) {
    assert.ok(Math.abs(a[key] + b[key]) < 1e-12, `${key}: ${a[key]} against ${b[key]}`);
  }
});

test("strength counts once per hero and an off-role seat counts as a penalty", () => {
  const data = dataset([...SOUND, ...CARRIES]);
  const f = draftFeatures(data, { mine: seated(CARRIES), enemy: seated(SOUND) });
  assert.equal(f.heroes, 10, "five 52% heroes against five 50% heroes");
  assert.equal(f.seatPenalty, -32, "four carries out of position 1, eight points each");
  assert.equal(f.seatBonus, 0);
  assert.deepEqual(f.seatTotal, { mine: -32, theirs: 0 });
});

test("a hero with no seat booked counts for strength and not for a seat", () => {
  const f = draftFeatures(dataset([hero("x", 54, 1)]), { mine: [pick("x", null)], enemy: [] });
  assert.equal(f.heroes, 4);
  assert.equal(f.seatPenalty, 0);
  assert.equal(f.seatBonus, 0);
});

test("an empty board measures nothing", () => {
  const f = draftFeatures(dataset(SOUND), { mine: [], enemy: [] });
  assert.deepEqual(f, {
    matchups: 0,
    cohesion: 0,
    heroes: 0,
    seatPenalty: 0,
    seatBonus: 0,
    timing: 0,
    seatTotal: { mine: 0, theirs: 0 },
  });
});

test("the role deficit is silent inside τ and convex beyond it", () => {
  assert.equal(roleDeficit(0, 1.5), 0);
  assert.equal(roleDeficit(-7, 1.5), 0, "−1.4 a hero is inside the threshold");
  assert.ok(Math.abs(roleDeficit(-10, 1.5) - 0.25) < 1e-12, "−2 a hero is half a point past it");
  assert.ok(Math.abs(roleDeficit(-32, 1.5) - 4.9 ** 2) < 1e-12, "−6.4 a hero is 4.9 past it");
  assert.equal(roleDeficit(12, 1.5), 0, "bonuses never make a deficit");
});

test("a calibration file reads back whole, or not at all", () => {
  assert.deepEqual(readCalibration(JSON.parse(JSON.stringify(CALIBRATION))), CALIBRATION);
  const without = JSON.parse(JSON.stringify(CALIBRATION));
  delete without.weights.roleDeficit;
  assert.equal(readCalibration(without), null, "a missing weight was fitted for a different model");
  assert.equal(readCalibration({ ...CALIBRATION, range: [0.6, 0.4] }), null, "a range the wrong way round");
  assert.equal(readCalibration({ ...CALIBRATION, tau: -1 }), null);
  assert.equal(readCalibration({ ...CALIBRATION, matches: 0 }), null);
  assert.equal(readCalibration("calibration"), null);
  assert.equal(readCalibration(null), null);
});

test("drift names the data files that changed since the fit", () => {
  const data = { ...dataset(SOUND), calibration: CALIBRATION };
  assert.deepEqual(calibrationDrift(data), [], "matchups is the only input it recorded, and it matches");
  assert.deepEqual(calibrationDrift({ ...data, generatedAt: "2026-09-25T00:00:00.000Z" }), ["matchups"]);
  assert.deepEqual(calibrationDrift(dataset(SOUND)), [], "no calibration, nothing to drift from");
});

test("an off-seat placement better than the hero's own rate counts as a bonus", () => {
  // Hero plays position 1 at 50%, but position 2 at 53% (3 points better)
  const boosted = hero("boost", 50, 1, -3);
  const data = dataset([boosted]);
  const f = draftFeatures(data, { mine: [pick("boost", 2)], enemy: [] });
  assert.equal(f.seatBonus, 3, "position 2 is 3 points better than position 1");
  assert.equal(f.seatPenalty, 0);
  assert.deepEqual(f.seatTotal, { mine: 3, theirs: 0 });
});

test("timing measures early-game cover with nonzero value and correct sign", () => {
  const TIMING_BUCKETS: TimingBucket[] = [
    { key: "early", short: "<25", label: "Before 25′", maxSeconds: 1500 },
    { key: "mid", short: "25–35", label: "25–35′", maxSeconds: 2100 },
    { key: "late", short: "35–45", label: "35–45′", maxSeconds: 2700 },
    { key: "veryLate", short: "45+", label: "45′ and up", maxSeconds: null },
  ];
  // Our heroes: strongly negative early skews (bad early)
  const ours = SEATS.map((p) => ({
    ...hero(`ours${p}`, 50, p),
    timings: [-5, -2, 1, 4].map((skew) => ({ skew, games: 1000, winRate: 50 + skew })),
  }));
  // Enemy heroes: strongly positive early skews (good early)
  const enemy = SEATS.map((p) => ({
    ...hero(`enemy${p}`, 50, p),
    timings: [2, 1, 0, -2].map((skew) => ({ skew, games: 1000, winRate: 50 + skew })),
  }));
  const heroes = [...ours, ...enemy];
  const timingShape = deriveTimingShape(heroes, 4);
  const data: Dataset = {
    heroes,
    bySlug: new Map(heroes.map((h) => [h.slug, h])),
    matchups: {},
    synergies: {},
    generatedAt: "2026-09-19T00:00:00.000Z",
    hasData: true,
    hasPositions: true,
    hasSynergies: false,
    synergyMatches: 0,
    hasTimings: true,
    timingBuckets: TIMING_BUCKETS,
    timingShape,
    timingMatches: 1000,
    error: null,
  };
  const myCover = teamCover(ours.map((h) => data.bySlug.get(h.slug)), timingShape);
  const theirCover = teamCover(enemy.map((h) => data.bySlug.get(h.slug)), timingShape);
  const f = draftFeatures(data, { mine: seated(ours), enemy: seated(enemy) });
  const expectedTiming = earlyCoverPenalty(theirCover, 1) - earlyCoverPenalty(myCover, 1);
  assert.ok(f.timing < 0, "our side short of early cover should make timing negative");
  assert.ok(Math.abs(f.timing - expectedTiming) < 1e-12, `timing ${f.timing} matches independent calculation ${expectedTiming}`);
  // Swapping sides should negate timing
  const g = draftFeatures(data, { mine: seated(enemy), enemy: seated(ours) });
  assert.ok(Math.abs(g.timing + f.timing) < 1e-12, `swapped timing ${g.timing} negates original ${f.timing}`);
});
