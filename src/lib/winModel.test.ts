import test from "node:test";
import assert from "node:assert/strict";
import {
  GROUP_LABEL,
  WIN_FEATURES,
  WIN_MODEL_FLOORS,
  calibrationDrift,
  draftFeatures,
  readCalibration,
  roleDeficit,
  rolesReason,
  shapley,
  showChance,
  sigmoid,
  verdictForChance,
  winChance,
  winFeatures,
  winRead,
} from "./winModel.ts";
import type { Calibration } from "./winModel.ts";
import { withRankBand } from "./positions.ts";
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
  rankBand: "all",
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

test("a calibration names the band it was fitted at, and all ranks when it predates saying so", () => {
  const older = JSON.parse(JSON.stringify(CALIBRATION));
  delete older.rankBand;
  assert.equal(readCalibration(older)?.rankBand, "all");
  assert.equal(readCalibration({ ...CALIBRATION, rankBand: "immortal" })?.rankBand, "immortal");
  assert.equal(readCalibration({ ...CALIBRATION, rankBand: "herald" }), null, "a band the app cannot apply");
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

// ------------------------------------------------------------------ the read

test("Shapley parts add up to the chance exactly, and a silent group gets nothing", () => {
  const parts = shapley([-1.8, -0.7, 0, 0.2, 0.05]);
  const total = parts.reduce((sum, p) => sum + p, 0);
  assert.ok(Math.abs(total - (100 * sigmoid(-2.25) - 50)) < 1e-9);
  assert.equal(parts[2], 0);
  const even = shapley([0.4, 0.4]);
  assert.ok(Math.abs(even[0]! - even[1]!) < 1e-12, "equal inputs, equal shares");
});

test("the verdict reads the distance from even", () => {
  assert.equal(verdictForChance(0.5).label, "Coin flip");
  assert.equal(verdictForChance(0.53).label, "Coin flip");
  assert.equal(verdictForChance(0.57).label, "Slight edge to you");
  assert.equal(verdictForChance(0.38).label, "They are favoured");
  assert.equal(verdictForChance(0.38).side, "enemy");
  assert.equal(verdictForChance(0.3).label, "They are well ahead");
  assert.equal(verdictForChance(0.2).label, "You are being run over");
  assert.equal(verdictForChance(0.8).label, "Dominant draft");
});

test("outside the calibrated range the headline gives a bound, not a figure", () => {
  assert.deepEqual(showChance(0.384, [0.15, 0.85]), { shown: "38%", short: "38%", inRange: true });
  assert.deepEqual(showChance(0.064, [0.15, 0.85]), { shown: "under 15%", short: "<15%", inRange: false });
  assert.deepEqual(showChance(0.9, [0.15, 0.85]), { shown: "over 85%", short: ">85%", inRange: false });
});

test("an empty board is an even game with nothing to explain", () => {
  const win = winRead(dataset(SOUND), { mine: [], enemy: [] }, CALIBRATION);
  assert.equal(win.chance, 0.5);
  assert.ok(win.parts.every((p) => p.points === 0));
  assert.equal(win.verdict.label, "Coin flip");
});

test("five cores against a sound five is run over, and the roles say why", () => {
  const data = dataset([...SOUND, ...CARRIES]);
  const win = winRead(data, { mine: seated(CARRIES), enemy: seated(SOUND) }, CALIBRATION);
  // heroes +10 × 0.052, seats −32 × 0.028, deficit (−6.4 + 1.5)² × −0.08
  const z = 10 * 0.052 - 32 * 0.028 - 0.08 * 4.9 ** 2;
  assert.ok(Math.abs(win.chance - sigmoid(z)) < 1e-12);
  assert.equal(win.shown, "under 15%");
  assert.equal(win.verdict.label, "You are being run over");
  const roles = win.parts.find((p) => p.group === "roles")!;
  assert.ok(win.parts.every((p) => p.points >= roles.points), "roles is the largest cost");
  assert.equal(roles.label, GROUP_LABEL.roles);
  const sum = win.parts.reduce((s, p) => s + p.points, 0);
  assert.ok(Math.abs(sum - (win.chance * 100 - 50)) < 1e-9, "the parts add up to the figure");
  assert.equal(win.evidence, null, "no bin vouches for a figure out of range");
  assert.equal(
    rolesReason(win.roles),
    "Nobody on your side supports: C2 at 2 (2.5% of their games), C3 at 3 (2.5% of their games), " +
      "C4 at 4 (2.5% of their games), C5 at 5 (2.5% of their games)",
  );
});

test("swapping the line-ups gives the other side the rest of the chance", () => {
  const data = dataset([...SOUND, ...CARRIES], { s1: { c1: row(2) } }, { s1: { s2: pair(1.2) }, s2: { s1: pair(1.2) } });
  const a = winRead(data, { mine: seated(SOUND), enemy: seated(CARRIES) }, CALIBRATION);
  const b = winRead(data, { mine: seated(CARRIES), enemy: seated(SOUND) }, CALIBRATION);
  assert.ok(Math.abs(a.chance + b.chance - 1) < 1e-12);
});

test("an ordinary flex costs a fraction of a point", () => {
  // A hero who mids in 26% of their games and wins a point less there.
  const flex: Hero = {
    ...hero("flex", 50, 4),
    positions: { 2: 0.26, 4: 0.6, 5: 0.14 },
    positionWinRate: { 2: 49, 4: 50, 5: 50 },
  };
  const data = dataset([...SOUND, ...ENEMY, flex]);
  const lineup = [pick("s1", 1), pick("flex", 2), pick("s3", 3), pick("s4", 4), pick("s5", 5)];
  const win = winRead(data, { mine: lineup, enemy: seated(ENEMY) }, CALIBRATION);
  const roles = win.parts.find((p) => p.group === "roles")!;
  assert.ok(Math.abs(roles.points) < 2, `roles moved ${roles.points}`);
  assert.equal(rolesReason(win.roles), null, "nobody is off-role and no seat costs three points");
});

test("five supports are told nobody farms, and the enemy's stretch is good news", () => {
  const supports = ["p1", "p2", "p3", "p4", "p5"].map((slug) => hero(slug, 51, 5));
  const data = dataset([...supports, ...ENEMY, hero("wanderer", 50, 1)]);
  const enemy = [pick("e1", 1), pick("e2", 2), pick("e3", 3), pick("wanderer", 4), pick("e5", 5)];
  const reason = rolesReason(winRead(data, { mine: seated(supports), enemy }, CALIBRATION).roles)!;
  assert.match(reason, /^Nobody on your side farms: P1 at 1 \(2\.5% of their games\)/);
  assert.match(reason, /their WANDERER at 4 \(2\.5% of their games\) is off-role$/);
});

test("inside the range the evidence is the bin the chance falls in", () => {
  const data = dataset([...SOUND, ...ENEMY], { s1: { e1: row(-3) } });
  const win = winRead(data, { mine: seated(SOUND), enemy: seated(ENEMY) }, CALIBRATION);
  // −3 points of matchups: σ(−0.138) ≈ 46.6%.
  assert.equal(win.shown, "47%");
  assert.deepEqual(win.evidence, { from: 0.45, to: 0.5, games: 146_917, actual: 0.477 });
});

/**
 * `hero`, with STRATZ counts behind it: 90% of their games in `main`, won at
 * `all` at all ranks and at `immortal` at Immortal, and eight points and one
 * points less, respectively, anywhere else.
 */
function bandedHero(slug: string, main: Position, all: number, immortal: number): Hero {
  const cells = (winRate: number, offBy: number): Array<[number, number]> =>
    SEATS.map((p) => {
      const games = p === main ? 9_000 : 250;
      return [games, Math.round((games * (p === main ? winRate : winRate - offBy)) / 100)];
    });
  return { ...hero(slug, all, main), positionCounts: { all: cells(all, 8), immortal: cells(immortal, 1) } };
}

/** Five carries who fall off at Immortal against a sound five who rise there. */
const BANDED_MINE = SEATS.map((p) => bandedHero(`m${p}`, 1, 53, 47));
const BANDED_THEIRS = SEATS.map((p) => bandedHero(`t${p}`, p, 49, 52));
const bandedData = (): Dataset => ({
  ...dataset([...BANDED_MINE, ...BANDED_THEIRS]),
  positionBands: ["all", "immortal"],
  rankBand: null,
  calibration: CALIBRATION,
});
const BANDED_BOARD = { mine: seated(BANDED_MINE), enemy: seated(BANDED_THEIRS) };

test("the chance is read at the band it was fitted on, whatever band is on screen", () => {
  const loaded = bandedData();
  const all = withRankBand(loaded, "all");
  const immortal = withRankBand(loaded, "immortal");
  assert.notEqual(all.bySlug.get("m1")!.winRate, immortal.bySlug.get("m1")!.winRate, "the bands disagree");

  const read = winRead(all, BANDED_BOARD, CALIBRATION);
  assert.deepEqual(winRead(immortal, BANDED_BOARD, CALIBRATION), read);
  assert.deepEqual(winRead(loaded, BANDED_BOARD, CALIBRATION), read, "and before any band is applied");
  assert.deepEqual(draftFeatures(immortal, BANDED_BOARD), draftFeatures(all, BANDED_BOARD));

  // Not a model blind to bands: fitted at Immortal, the same board reads otherwise.
  const fittedAtImmortal: Calibration = { ...CALIBRATION, rankBand: "immortal" };
  const high = winRead(all, BANDED_BOARD, fittedAtImmortal);
  assert.notEqual(high.chance, read.chance);
  assert.deepEqual(winRead(immortal, BANDED_BOARD, fittedAtImmortal), high);
});

test("the Roles card prints the seats the chance priced, not the band on screen", () => {
  const all = withRankBand(bandedData(), "all");
  const immortal = withRankBand(bandedData(), "immortal");
  const seat = winRead(immortal, BANDED_BOARD, CALIBRATION).roles.mine.seats[1]!;
  const priced = all.bySlug.get("m2")!;
  assert.equal(seat.winRate, priced.winRate);
  assert.equal(seat.seatWinRate, priced.positionWinRate![2]);
  assert.notEqual(seat.seatWinRate, immortal.bySlug.get("m2")!.positionWinRate![2]);
});

test("the chance alone is the read's own chance and parts", () => {
  const immortal = withRankBand(bandedData(), "immortal");
  const { chance, logOdds, shown, short, inRange, parts } = winRead(immortal, BANDED_BOARD, CALIBRATION);
  assert.deepEqual(winChance(immortal, BANDED_BOARD, CALIBRATION), { chance, logOdds, shown, short, inRange, parts });
});
