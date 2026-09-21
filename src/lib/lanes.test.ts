import test from "node:test";
import assert from "node:assert/strict";
import { buildLaneModel, fitLaneCounters, laneCounter, lanePair, readLaneCell } from "./lanes.ts";
import type { LaneCell } from "./lanes.ts";
import type { Position } from "../types.ts";

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

/**
 * A synthetic lane table with everything known: ten offlaners against ten safe
 * carries, offlaners losing lanes on average, a handful of pairings planted
 * with an effect of their own, and games that follow those pairing effects —
 * and only those — at a known rate.
 */
const OFF_BASE = -0.2;
const GAME_PER_LANE = 0.4;
const DRAW_SHARE = 0.3;
const offlaners = Array.from({ length: 10 }, (_, i) => `off${i}`);
const carries = Array.from({ length: 10 }, (_, i) => `carry${i}`);
const offStrength = (i: number) => -0.3 + i * (0.6 / 9);
const carryStrength = (j: number) => 0.25 - j * (0.5 / 9);
const PLANTED: Record<string, number> = { "off2|carry7": 0.5, "off6|carry1": -0.45, "off8|carry3": 0.4 };

/** Counts for a lane won `p` of the time, from the row hero's side. */
function cell(p: number, decided: number, gameRate: number) {
  const draws = DRAW_SHARE * decided;
  const wins = (p - DRAW_SHARE / 2) * decided;
  const losses = decided - wins - draws;
  const lanes = Math.round(decided / 0.86);
  return [lanes, Math.round(wins), Math.round(draws), Math.round(losses), Math.round(gameRate * lanes)];
}

function world({ thinPair = null as null | string, thinLanes = 150 } = {}) {
  const against: Record<string, Record<string, Record<string, unknown>>> = {};
  for (const [i, o] of offlaners.entries()) {
    for (const [j, c] of carries.entries()) {
      const planted = PLANTED[`${o}|${c}`] ?? 0;
      const expected = sigmoid(OFF_BASE + offStrength(i) - carryStrength(j));
      const p = sigmoid(OFF_BASE + offStrength(i) - carryStrength(j) + planted);
      const game = 0.5 + GAME_PER_LANE * (p - expected);
      const decided = `${o}|${c}` === thinPair ? thinLanes : 20_000;
      ((against[o] ??= {})["3"] ??= {})[c] = cell(p, decided, game);
      ((against[c] ??= {})["1"] ??= {})[o] = cell(1 - p, decided, 1 - game);
    }
  }
  return buildLaneModel({ generatedAt: "2026-09-19T00:00:00Z", weeks: [2958], against })!;
}

test("lane cells are refused whole when malformed", () => {
  assert.deepEqual(readLaneCell([100, 40, 30, 20, 55]), { lanes: 100, wins: 40, draws: 30, losses: 20, gameWins: 55 });
  assert.equal(readLaneCell([100, 40, 30, 20]), null, "the game column is required");
  assert.equal(readLaneCell([100, 0, 0, 0, 0]), null, "no decided lanes, nothing to read");
  assert.equal(readLaneCell([100, 40, 30, 20, 101]), null, "more games won than lanes");
  assert.equal(readLaneCell([100, -1, 30, 20, 5]), null);
  assert.equal(buildLaneModel(null), null);
  assert.equal(buildLaneModel({ against: {} }), null);
});

test("a seat's typical result is not counted twice", () => {
  const model = world();
  // Offlaners as a group lose lanes; both records carry that, and an average
  // pairing must still come out at the seat's own baseline rather than twice it.
  assert.ok(Math.abs(model.fit[3]!.mean) < 0.005, `mean residual ${model.fit[3]!.mean}`);
  const pair = lanePair(model, "off4", 3, "carry5", 1)!;
  const truth = sigmoid(OFF_BASE + offStrength(4) - carryStrength(5));
  assert.ok(Math.abs(pair.result - truth) < 0.01, `${pair.result} vs ${truth}`);
});

test("the answer is the same from either side of the pairing, however the two seats were fitted", () => {
  const model = world();
  // The mirrored synthetic table fits both seats alike, which would let a
  // one-sided reading pass; real seats differ, so make these differ too.
  model.fit[1] = { mean: -0.02, signalVar: model.fit[3]!.signalVar * 3, gamePerLane: 0.2 };
  model.fit[3] = { ...model.fit[3]!, mean: 0.015, gamePerLane: 0.55 };
  for (const [o, c] of [["off2", "carry7"], ["off0", "carry9"], ["off6", "carry1"]] as const) {
    const forward = lanePair(model, o, 3, c, 1)!;
    const back = lanePair(model, c, 1, o, 3)!;
    assert.ok(Math.abs(forward.result + back.result - 1) < 1e-9, `${o} vs ${c}: ${forward.result} + ${back.result}`);
    assert.ok(Math.abs(forward.gameEdge + back.gameEdge) < 1e-9, `${o} vs ${c} game edges mirror`);
  }
});

test("a planted pairing effect is recovered, and an ordinary pairing has none", () => {
  const model = world();
  const planted = lanePair(model, "off2", 3, "carry7", 1)!;
  const truth = sigmoid(OFF_BASE + offStrength(2) - carryStrength(7) + 0.5) -
    sigmoid(OFF_BASE + offStrength(2) - carryStrength(7));
  // Each hero's own record includes this pairing, so each side absorbs about
  // one opponent's worth of it: 2 in 10 here, 1–2% against a real pool.
  const absorbed = truth * (1 - 2 / carries.length);
  assert.ok(Math.abs(planted.residual - absorbed) < 0.005, `${planted.residual} vs ${absorbed}`);
  assert.ok(Math.abs(lanePair(model, "off4", 3, "carry5", 1)!.residual) < 0.01);
});

test("a thin pairing is pulled towards its expectation; a thick one is not", () => {
  const thick = lanePair(world(), "off2", 3, "carry7", 1)!;
  const thin = lanePair(world({ thinPair: "off2|carry7", thinLanes: 150 }), "off2", 3, "carry7", 1)!;
  assert.ok(thin.residual > 0 && thin.residual < thick.residual * 0.8, `${thin.residual} vs ${thick.residual}`);
});

test("what a lane is worth in games is measured from the table", () => {
  const model = world();
  const k = model.fit[3]!.gamePerLane;
  assert.ok(Math.abs(k - GAME_PER_LANE) < 0.08, `game per lane point ${k}`);
  const pair = lanePair(model, "off2", 3, "carry7", 1)!;
  const both = (model.fit[3]!.gamePerLane + model.fit[1]!.gamePerLane) / 2;
  assert.ok(Math.abs(pair.gameEdge - 100 * both * pair.residual) < 1e-9, "gameEdge is the residual in game points");
});

test("a hero with no record at the seat asked for gets no read at all", () => {
  const model = world();
  assert.equal(lanePair(model, "off2", 5, "carry7", 1), null);
  assert.equal(lanePair(model, "nobody", 3, "carry7", 1), null);
});

/**
 * A second synthetic world, built for the counter fit: twenty offlaners
 * against twenty carries, every game win rate assembled from four known
 * pieces — the row hero's level at their seat, the opponent's own strength,
 * the whole-game matchup, and a pairing effect that is different in every
 * cell. Only the last of those is what `fitLaneCounters` is supposed to
 * return, and the other three are given the widest spread of the four so that
 * anything leaking out of them would be obvious.
 */
const SIDE = 20;
const offs = Array.from({ length: SIDE }, (_, i) => `off${i}`);
const cores = Array.from({ length: SIDE }, (_, j) => `core${j}`);
const offLevel = (i: number) => -4 + i * (8 / (SIDE - 1));
const coreLevel = (j: number) => 3 - j * (6 / (SIDE - 1));
/** The whole-game figure the score already has, and the fit must not return. */
const dotabuff = (i: number, j: number) => -2 + ((i * 7 + j * 3) % 9) * 0.5;
/**
 * The pairing effect itself: about 1.4 points of spread, as on the live table,
 * and swept clean of anything constant along a row or a column. A pairing
 * effect every one of a hero's opponents shares is not a pairing effect — it
 * is that hero's level at the seat, and no fit could tell the two apart.
 */
const PAIR_EFFECT = (() => {
  const raw = Array.from({ length: SIDE }, (_, i) =>
    Array.from({ length: SIDE }, (_, j) => 2 * Math.sin(1.7 * i + 2.3 * j)),
  );
  const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
  for (const row of raw) {
    const m = mean(row);
    for (let j = 0; j < SIDE; j++) row[j] -= m;
  }
  for (let j = 0; j < SIDE; j++) {
    const m = mean(raw.map((row) => row[j]));
    for (const row of raw) row[j] -= m;
  }
  return raw;
})();
const planted = (i: number, j: number) => PAIR_EFFECT[i][j];
/** One pairing with a huge effect and almost no games behind it. */
const THIN = { i: 5, j: 5, effect: 20, lanes: 60 };

function counterWorld() {
  const against: Record<string, Partial<Record<Position, Record<string, LaneCell>>>> = {};
  const cell = (rate: number, lanes: number): LaneCell => ({
    lanes,
    wins: Math.round(0.5 * lanes),
    draws: 0,
    losses: Math.round(0.5 * lanes),
    gameWins: Math.round((rate / 100) * lanes),
  });
  for (const [i, o] of offs.entries()) {
    for (const [j, c] of cores.entries()) {
      const thin = i === THIN.i && j === THIN.j;
      const effect = planted(i, j) + (thin ? THIN.effect : 0);
      const rate = 50 + offLevel(i) - coreLevel(j) + dotabuff(i, j) + effect;
      const lanes = thin ? THIN.lanes : 40_000;
      ((against[o] ??= {})[3] ??= {})[c] = cell(rate, lanes);
      ((against[c] ??= {})[1] ??= {})[o] = cell(100 - rate, lanes);
    }
  }
  const edge = (a: string, b: string) => {
    const i = offs.indexOf(a);
    const j = cores.indexOf(b);
    if (i >= 0 && j >= 0) return dotabuff(i, j);
    const i2 = offs.indexOf(b);
    const j2 = cores.indexOf(a);
    return i2 >= 0 && j2 >= 0 ? -dotabuff(i2, j2) : null;
  };
  return fitLaneCounters({ against }, edge)!;
}

const counterModel = counterWorld();

test("fitLaneCounters returns the planted pairing effect and nothing else", () => {
  let worst = 0;
  let worstShrunk = 0;
  for (const [i, o] of offs.entries()) {
    for (const [j, c] of cores.entries()) {
      if (i === THIN.i && j === THIN.j) continue;
      const reading = laneCounter(counterModel, o, 3, c, 1);
      assert.ok(reading, `${o} vs ${c} missing`);
      worst = Math.max(worst, Math.abs(reading.raw - planted(i, j)));
      worstShrunk = Math.max(worstShrunk, Math.abs(reading.edge - planted(i, j)));
    }
  }
  // Not exact, and cannot be: the planted effects correlate a little with the
  // whole-game figures by chance, so the fitted slope lands near one rather
  // than on it, and a tenth of a point of `db` rides along in the residual.
  assert.ok(Math.abs(counterModel.slope - 1) < 0.1, `slope ${counterModel.slope.toFixed(3)}`);
  assert.ok(worst < 0.12, `worst cell was out by ${worst.toFixed(3)} points`);
  // Forty thousand lanes is most of the evidence there is, so the damping
  // should barely be felt — but it is still there, and it is what keeps the
  // thin pairing in the next test from reaching a score.
  assert.ok(worstShrunk > worst, "the published edge is damped, not raw");
  assert.ok(worstShrunk < 0.2, `damping cost ${worstShrunk.toFixed(2)} points`);
});

test("a hero's own seat record, their opponent's strength and the whole-game matchup all fit out", () => {
  // off0 has the worst record of any offlaner in this world and core0 the best
  // of any carry, and the pairing between them is worth what it is worth.
  const extremes = laneCounter(counterModel, "off0", 3, "core0", 1);
  assert.ok(extremes && Math.abs(extremes.raw - planted(0, 0)) < 0.12);
  // The widest whole-game matchup in the table, which the score already adds.
  const dominant = laneCounter(counterModel, "off1", 3, "core3", 1);
  assert.ok(dominant && Math.abs(dominant.raw - planted(1, 3)) < 0.12);
  // The same pairing from the carry's seat is the same effect, reversed.
  const mirrored = laneCounter(counterModel, "core7", 1, "off3", 3);
  assert.ok(mirrored && Math.abs(mirrored.raw + planted(3, 7)) < 0.12);
});

test("a pairing with almost no games behind it is damped to nearly nothing", () => {
  const reading = laneCounter(counterModel, offs[THIN.i], 3, cores[THIN.j], 1);
  assert.ok(reading);
  assert.equal(reading.lanes, THIN.lanes);
  assert.ok(Math.abs(reading.raw) > 10, "the raw reading is as wild as its sample");
  assert.ok(Math.abs(reading.edge) < 1.5, `shrunk to ${reading.edge.toFixed(2)}`);
});

test("laneCounter says nothing about seats that never meet", () => {
  assert.equal(laneCounter(counterModel, "off3", 3, "core7", 3), null);
  assert.equal(laneCounter(counterModel, "off3", 3, "core7", 2), null);
  assert.equal(laneCounter(counterModel, "off3", 2, "core7", 2), null);
});

test("a table too small to fit fixed effects on is refused rather than guessed at", () => {
  const tiny: Record<string, Partial<Record<Position, Record<string, LaneCell>>>> = {
    a: { 3: { b: { lanes: 100, wins: 50, draws: 0, losses: 50, gameWins: 55 } } },
  };
  assert.equal(fitLaneCounters({ against: tiny }, () => 0), null);
});
