import { LANE_OPPONENTS, POSITIONS } from "./roles";
import type { Position } from "../types";

/**
 * Who wins the laning stage, pair by pair, and what that is worth in games —
 * from STRATZ's lane outcomes in public/data/lanes.json.
 *
 * Two measurements from the live table decide how this is built
 * (docs/scoring.md, "Lane outcomes"). A hero's general lane strength barely
 * moves their game win rate: across heroes the correlation is about zero, and
 * so is its correlation with the Dotabuff lane win rate the card calls form.
 * The part of a lane that is specific to *this* pairing does move the game —
 * 0.3 to 0.5 win-rate points per point of lane — so that part, and only that
 * part, is what reaches a score in win-rate points.
 */

export interface LaneCell {
  /** STRATZ's matchCount: lanes the two shared. */
  lanes: number;
  wins: number;
  draws: number;
  losses: number;
  /** Games the row's hero won out of those lanes. */
  gameWins: number;
}

/** One hero's lane record at one seat, pooled over every opponent. */
export interface SeatRecord {
  /** Share of the laning stage won: (wins + draws / 2) over decided lanes. */
  score: number;
  /** Games won out of those lanes. */
  game: number;
  decided: number;
}

export interface LaneModel {
  /** against[a][seat][b]: a at that seat against b in the same lane, from a's side. */
  against: Record<string, Partial<Record<Position, Record<string, LaneCell>>>>;
  seats: Record<string, Partial<Record<Position, SeatRecord>>>;
  /** Every hero at a seat pooled, in log-odds: how that seat's lanes go on average. */
  seatBaseline: Partial<Record<Position, number>>;
  /**
   * Per seat of the row hero: the mean pair residual, the variance of *real*
   * pair effects left after sampling noise, and the game win-rate points one
   * point of pair effect is worth. All three are measured from the table.
   */
  fit: Partial<Record<Position, { mean: number; signalVar: number; gamePerLane: number }>>;
  weeks: number[];
  generatedAt: string | null;
}

export interface LanePair {
  /** Share of the laning stage `a` is expected to take against `b`, 0 to 1. */
  result: number;
  /** The part of `result` that is this pairing rather than the two heroes' records. */
  residual: number;
  /** `residual` in win-rate points of the game. */
  gameEdge: number;
  /** Decided lanes the residual rests on, both directions. */
  lanes: number;
}

/** Pairs with fewer decided lanes are too noisy to fit the lane-to-game slope on. */
const MIN_FIT_LANES = 300;

/** Keeps logits finite for a hero who won or lost every lane in a thin sample. */
const clampRate = (p: number) => Math.min(0.99, Math.max(0.01, p));
const logit = (p: number) => Math.log(clampRate(p) / (1 - clampRate(p)));
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

const decided = (c: LaneCell) => c.wins + c.draws + c.losses;
const laneScore = (c: LaneCell) => (c.wins + c.draws / 2) / decided(c);

/** Sampling variance of a lane score: each lane is worth 1, ½ or 0. */
function laneNoise(c: LaneCell): number {
  const n = decided(c);
  const s = laneScore(c);
  return Math.max(0, (c.wins + c.draws / 4) / n - s * s) / n;
}

export function readLaneCell(value: unknown): LaneCell | null {
  if (!Array.isArray(value) || value.length < 5) return null;
  const [lanes, wins, draws, losses, gameWins] = value as unknown[];
  const nums = [lanes, wins, draws, losses, gameWins];
  if (!nums.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0)) return null;
  const cell = { lanes, wins, draws, losses, gameWins } as LaneCell;
  if (decided(cell) <= 0 || cell.gameWins > cell.lanes) return null;
  return cell;
}

function pool(cells: Iterable<LaneCell>): SeatRecord | null {
  let w = 0;
  let d = 0;
  let l = 0;
  let lanes = 0;
  let games = 0;
  for (const c of cells) {
    w += c.wins;
    d += c.draws;
    l += c.losses;
    lanes += c.lanes;
    games += c.gameWins;
  }
  const n = w + d + l;
  return n > 0 && lanes > 0 ? { score: (w + d / 2) / n, game: games / lanes, decided: n } : null;
}

/**
 * The seat an opponent of `seat` most likely held: of the seats that face it
 * in lane, the one they play most. Rows do not record it, so the fit assumes it.
 */
function opposingSeat(
  seats: LaneModel["seats"],
  hero: string,
  seat: Position,
): { seat: Position; record: SeatRecord } | null {
  let best: { seat: Position; record: SeatRecord } | null = null;
  for (const q of LANE_OPPONENTS[seat]) {
    const record = seats[hero]?.[q];
    if (record && (!best || record.decided > best.record.decided)) best = { seat: q, record };
  }
  return best;
}

/**
 * The lane `a` should expect against `b` from their records alone.
 *
 * Each record already carries its seat's typical result — offlaners as a group
 * lose more lanes than they win — so subtracting one record from the other
 * would count that twice. Each hero is measured against their own seat's
 * baseline instead, and the two seats meet halfway between their baselines,
 * which keeps the answer the same from either side of the pairing.
 */
function expectation(
  model: Pick<LaneModel, "seatBaseline">,
  mine: number,
  seatA: Position,
  theirs: number,
  seatB: Position,
): number {
  const la = model.seatBaseline[seatA] ?? 0;
  const lb = model.seatBaseline[seatB] ?? 0;
  return sigmoid(logit(mine) - logit(theirs) - (la - lb) / 2);
}

/**
 * Parse lanes.json and measure, per seat, how much real pairing effect there
 * is and what it is worth in games. Null when the file is missing or empty.
 */
export function buildLaneModel(raw: {
  generatedAt?: string;
  weeks?: number[];
  against?: Record<string, Record<string, Record<string, unknown>>>;
} | null): LaneModel | null {
  if (!raw?.against) return null;

  const against: LaneModel["against"] = {};
  let rows = 0;
  for (const [a, bySeat] of Object.entries(raw.against)) {
    for (const [seatKey, opponents] of Object.entries(bySeat ?? {})) {
      const seat = Number(seatKey) as Position;
      if (!POSITIONS.includes(seat)) continue;
      for (const [b, tuple] of Object.entries(opponents ?? {})) {
        const cell = readLaneCell(tuple);
        if (!cell || a === b) continue;
        ((against[a] ??= {})[seat] ??= {})[b] = cell;
        rows++;
      }
    }
  }
  if (!rows) return null;

  const seats: LaneModel["seats"] = {};
  for (const [a, bySeat] of Object.entries(against)) {
    for (const seat of POSITIONS) {
      const record = pool(Object.values(bySeat[seat] ?? {}));
      if (record) (seats[a] ??= {})[seat] = record;
    }
  }

  const seatBaseline: LaneModel["seatBaseline"] = {};
  const gameBaseline: Partial<Record<Position, number>> = {};
  for (const seat of POSITIONS) {
    const all = pool(Object.values(against).flatMap((bySeat) => Object.values(bySeat[seat] ?? {})));
    if (!all) continue;
    seatBaseline[seat] = logit(all.score);
    gameBaseline[seat] = logit(all.game);
  }

  const fit: LaneModel["fit"] = {};
  for (const seat of POSITIONS) {
    const points: Array<{ r: number; noise: number; rg: number; n: number }> = [];
    for (const [a, bySeat] of Object.entries(against)) {
      const mine = seats[a]?.[seat];
      if (!mine) continue;
      for (const [b, cell] of Object.entries(bySeat[seat] ?? {})) {
        const theirs = opposingSeat(seats, b, seat);
        if (!theirs) continue;
        const expected = expectation({ seatBaseline }, mine.score, seat, theirs.record.score, theirs.seat);
        const expectedGame = expectation(
          { seatBaseline: gameBaseline },
          mine.game,
          seat,
          theirs.record.game,
          theirs.seat,
        );
        points.push({
          r: laneScore(cell) - expected,
          noise: laneNoise(cell),
          rg: cell.gameWins / cell.lanes - expectedGame,
          n: decided(cell),
        });
      }
    }
    if (points.length < 20) continue;

    // Same estimate as the synergy table: whatever spread is left once the
    // known sampling noise is taken out is the spread of real pairing effects.
    const mean = points.reduce((s, p) => s + p.r, 0) / points.length;
    const observed = points.reduce((s, p) => s + (p.r - mean) ** 2, 0) / points.length;
    const noise = points.reduce((s, p) => s + p.noise, 0) / points.length;
    const signalVar = Math.max(0, observed - noise);

    // How far the game moves with the lane, pairing by pairing, both measured
    // against what the two heroes' own records predicted.
    const thick = points.filter((p) => p.n >= MIN_FIT_LANES);
    const weight = thick.reduce((s, p) => s + p.n, 0);
    let gamePerLane = 0;
    if (weight > 0) {
      const mx = thick.reduce((s, p) => s + p.n * p.r, 0) / weight;
      const my = thick.reduce((s, p) => s + p.n * p.rg, 0) / weight;
      let sxy = 0;
      let sxx = 0;
      for (const p of thick) {
        sxy += p.n * (p.r - mx) * (p.rg - my);
        sxx += p.n * (p.r - mx) ** 2;
      }
      gamePerLane = sxx > 0 ? Math.min(1, Math.max(0, sxy / sxx)) : 0;
    }
    fit[seat] = { mean, signalVar, gamePerLane };
  }

  return {
    against,
    seats,
    seatBaseline,
    fit,
    weeks: Array.isArray(raw.weeks) ? raw.weeks : [],
    generatedAt: raw.generatedAt ?? null,
  };
}

/**
 * How `a` at `seatA` fares in lane against `b` at `seatB`.
 *
 * The expectation comes from both heroes' records at those seats; the pairing's
 * own effect is read from both directions of the table and shrunk by its
 * noise, so a pair seen in a few hundred lanes moves the answer a little and
 * one seen in fifty thousand moves it most of the way. Null when either hero
 * has no lane record at their seat.
 */
export function lanePair(
  model: LaneModel,
  a: string,
  seatA: Position,
  b: string,
  seatB: Position,
): LanePair | null {
  const mine = model.seats[a]?.[seatA];
  const theirs = model.seats[b]?.[seatB];
  if (!mine || !theirs) return null;
  const expected = expectation(model, mine.score, seatA, theirs.score, seatB);

  const readings: Array<{ r: number; noise: number; n: number }> = [];
  const forward = model.against[a]?.[seatA]?.[b];
  if (forward) readings.push({ r: laneScore(forward) - expected, noise: laneNoise(forward), n: decided(forward) });
  const reverse = model.against[b]?.[seatB]?.[a];
  if (reverse) readings.push({ r: 1 - laneScore(reverse) - expected, noise: laneNoise(reverse), n: decided(reverse) });

  // Each seat has its own fit, and taking only `a`'s would make the answer
  // depend on which hero was asked about. The pairing is read with both seats'
  // figures averaged, and centred on both seats' means, so it is the exact
  // mirror from the other side.
  const fitA = model.fit[seatA];
  const fitB = model.fit[seatB];
  let residual = 0;
  let lanes = 0;
  let gamePerLane = 0;
  if (readings.length && fitA && fitB) {
    lanes = readings.reduce((s, x) => s + x.n, 0);
    const r = readings.reduce((s, x) => s + x.n * x.r, 0) / lanes;
    // The two directions largely share games, so together they are credited
    // with no more precision than the better of the two alone.
    const noise = Math.min(...readings.map((x) => x.noise));
    const signalVar = (fitA.signalVar + fitB.signalVar) / 2;
    const shrink = signalVar > 0 ? signalVar / (signalVar + noise) : 0;
    residual = shrink * (r - (fitA.mean - fitB.mean) / 2);
    gamePerLane = (fitA.gamePerLane + fitB.gamePerLane) / 2;
  }

  return {
    result: Math.min(1, Math.max(0, expected + residual)),
    residual,
    gameEdge: 100 * gamePerLane * residual,
    lanes,
  };
}

// ------------------------------------------------- counters, seat by seat

/**
 * One pairing's counter reading: how the row hero's *games* went against this
 * opponent from this seat, beyond what the seat and the whole-game matchup
 * already predicted.
 */
export interface CounterCell {
  /**
   * Win-rate points from the row hero's side, before shrinkage: everything in
   * these games that the score does not already have from Dotabuff.
   */
  raw: number;
  /** Sampling variance of `raw`, pp². */
  noise: number;
  lanes: number;
}

export interface CounterModel {
  /** cells[a][seat][b]: a at that seat with b in the same lane. */
  cells: Record<string, Partial<Record<Position, Record<string, CounterCell>>>>;
  /** Spread of real pair effects across the table, pp² — the shrinkage prior. */
  signalVar: number;
  /** How much of a whole-game matchup edge turns up inside these games. */
  slope: number;
  /** Readings the fit rests on, mirrors counted once. */
  pairs: number;
}

/**
 * Below this the fixed effects have nothing to be estimated from — a fixture
 * table, a `--only=` scrape — and no counter reading is offered at all.
 */
const MIN_COUNTER_CELLS = 500;

/**
 * Alternating least squares converges geometrically on a design this dense.
 * Measured on the live table: by round 10 no cell moves by another 0.0002
 * points, so 12 is the whole of the fit and 25 was twice the work for nothing.
 */
const COUNTER_ROUNDS = 12;

/**
 * What a hero's seat is worth against a *particular* opponent, over and above
 * what is already known about both of them.
 *
 * The file records, for every (hero, seat, lane opponent), the games that hero
 * went on to win. Three things move that number and only one of them is news:
 *
 * - the hero's own record at that seat — the meta term already prices it,
 * - the opponent's strength — a fact about them, in every draft they are in,
 * - the whole-game matchup — `matchup()` already has it, from Dotabuff.
 *
 * All three are fitted out, the first two as fixed effects and the third as a
 * slope on the figure the score already adds, so what is left is the part that
 * exists *because* this hero played this seat into this opponent. That part is
 * worth about a point of win rate either way across the table, reaches ±5 on
 * the sharpest pairings, and replicates at r ≈ 0.52 between the first and last
 * halves of the collection window — see docs/scoring.md, "Counters by seat".
 *
 * `edge` supplies the whole-game advantage, damped exactly as the score damps
 * it; a pairing Dotabuff has no row for is left out rather than fitted against
 * a zero it has not earned.
 */
export function fitLaneCounters(
  model: Pick<LaneModel, "against">,
  edge: (a: string, b: string) => number | null,
  { rounds = COUNTER_ROUNDS }: { rounds?: number } = {},
): CounterModel | null {
  interface Point {
    a: string;
    seat: Position;
    b: string;
    row: string;
    obs: number;
    db: number;
    lanes: number;
    noise: number;
    resid: number;
  }

  const points: Point[] = [];
  for (const [a, bySeat] of Object.entries(model.against)) {
    for (const seat of POSITIONS) {
      for (const [b, cell] of Object.entries(bySeat[seat] ?? {})) {
        const db = edge(a, b);
        if (db === null || !(cell.lanes > 0)) continue;
        const game = cell.gameWins / cell.lanes;
        points.push({
          a,
          seat,
          b,
          row: `${a}|${seat}`,
          obs: 100 * game,
          db,
          lanes: cell.lanes,
          noise: (10_000 * game * (1 - game)) / cell.lanes,
          resid: 0,
        });
      }
    }
  }
  if (points.length < MIN_COUNTER_CELLS) return null;

  // Weighted by games, so a 50-lane row cannot drag a hero's seat level around.
  const level = new Map<string, number>();
  const opponent = new Map<string, number>();
  let slope = 1;
  const meansBy = (key: "row" | "b", value: (p: Point) => number) => {
    const acc = new Map<string, { w: number; sum: number }>();
    for (const p of points) {
      const e = acc.get(p[key]) ?? { w: 0, sum: 0 };
      e.w += p.lanes;
      e.sum += p.lanes * value(p);
      acc.set(p[key], e);
    }
    const out = new Map<string, number>();
    for (const [k, e] of acc) out.set(k, e.sum / e.w);
    return out;
  };

  for (let round = 0; round < rounds; round++) {
    const seats = meansBy("row", (p) => p.obs - (opponent.get(p.b) ?? 0) - slope * p.db);
    level.clear();
    for (const [k, v] of seats) level.set(k, v);

    // The opponent effect is only identified up to a constant; centring it
    // keeps the level where it belongs, on the hero's own seat.
    const theirs = meansBy("b", (p) => p.obs - (level.get(p.row) ?? 0) - slope * p.db);
    let mean = 0;
    for (const v of theirs.values()) mean += v;
    mean /= theirs.size || 1;
    opponent.clear();
    for (const [k, v] of theirs) opponent.set(k, v - mean);

    let sxy = 0;
    let sxx = 0;
    for (const p of points) {
      const y = p.obs - (level.get(p.row) ?? 0) - (opponent.get(p.b) ?? 0);
      sxy += p.lanes * p.db * y;
      sxx += p.lanes * p.db * p.db;
    }
    slope = sxx > 0 ? sxy / sxx : 0;
  }
  for (const p of points) {
    // Published against a slope of one rather than the fitted `slope`, because
    // the score adds Dotabuff's figure at face value and then adds this. What
    // is kept is therefore the whole of what these games say beyond that
    // figure — the pairing's own effect plus the part of the matchup that only
    // shows up when the two stand in the same lane — and `advantage + edge` is
    // exactly the fit's prediction rather than a sum of two different models.
    p.resid = p.obs - (level.get(p.row) ?? 0) - (opponent.get(p.b) ?? 0) - p.db;
  }

  // Every pairing is in the table twice — once from each hero's seat — and the
  // two rows are the same games, so the prior is estimated over one of each.
  const seen = new Set<string>();
  let n = 0;
  let sumSq = 0;
  let sumNoise = 0;
  let sumWeight = 0;
  for (const p of points) {
    const key = `${p.seat}|${p.a < p.b ? `${p.a}|${p.b}` : `${p.b}|${p.a}`}`;
    if (seen.has(key)) continue;
    seen.add(key);
    n++;
    sumSq += p.lanes * p.resid ** 2;
    sumNoise += p.lanes * p.noise;
    sumWeight += p.lanes;
  }
  // Weighted by games like the fit itself: unweighted, the estimate is set by
  // the 50-lane rows, whose noise is several times the effect being measured.
  const signalVar = sumWeight > 0 ? Math.max(0, (sumSq - sumNoise) / sumWeight) : 0;

  const cells: CounterModel["cells"] = {};
  for (const p of points) {
    ((cells[p.a] ??= {})[p.seat] ??= {})[p.b] = { raw: p.resid, noise: p.noise, lanes: p.lanes };
  }
  return { cells, signalVar, slope, pairs: n };
}

export interface CounterReading {
  /** Win-rate points to add to the whole-game matchup, `a`'s side. */
  edge: number;
  /** Before shrinkage — what the games said on their own. */
  raw: number;
  /** Lanes behind the reading. */
  lanes: number;
}

/**
 * What `a` at `seatA` is worth against `b` at `seatB`, beyond their whole-game
 * matchup. Null for seats that never meet, and for a pairing thinner than the
 * file's own floor, which was never written down.
 *
 * Read from `a`'s row only, never averaged with `b`'s. The mirror row is the
 * same games, but it is conditioned on *`b`'s* seat and pools every seat `a`
 * played in that lane — on the live table `axe` at 3 against Pudge is 62,550
 * lanes of mostly pos 5 Pudge, and averaging it in turns a +4.3 reading of the
 * pos 1 Pudge this hero card is about into +1.5 of somebody else's game. The
 * one asymmetry that leaves is intended: the ban list runs from the enemy's
 * seat and reads their row, which is the correctly conditioned figure for the
 * question it asks.
 */
export function laneCounter(
  model: CounterModel,
  a: string,
  seatA: Position,
  b: string,
  seatB: Position,
): CounterReading | null {
  if (!LANE_OPPONENTS[seatA].includes(seatB)) return null;
  const cell = model.cells[a]?.[seatA]?.[b];
  if (!cell) return null;
  const shrink = model.signalVar > 0 ? model.signalVar / (model.signalVar + cell.noise) : 0;
  return { edge: shrink * cell.raw, raw: cell.raw, lanes: cell.lanes };
}
