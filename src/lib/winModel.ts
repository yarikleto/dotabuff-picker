import { matchup, synergy } from "./scoring";
import type { DraftView } from "./scoring";
import { positionWinRate } from "./roles";
import { earlyCoverPenalty, teamCover } from "./timing";
import type { Dataset, DraftPick } from "../types";

/**
 * The draft on the board as a chance of winning.
 *
 * The one place the model is written down. The app reads it for the Draft
 * analysis headline, the hero card's preview and the Rebalance search, and
 * `scripts/calibrate.mjs` fits its weights by running this same code over real
 * ranked games — so the figure a draft is shown and the figure its weights were
 * fitted against cannot drift apart. See docs/scoring.md, "Win chance".
 */

/** The features the model weighs, in the order `calibration.json` lists them. */
export const WIN_FEATURES = [
  "matchups",
  "cohesion",
  "heroes",
  "seatPenalty",
  "seatBonus",
  "roleDeficit",
  "timing",
] as const;
export type WinFeature = (typeof WIN_FEATURES)[number];

/**
 * Sample floors the features are read under.
 *
 * Fixed here rather than taken from the Tuning sliders: the weights were fitted
 * under these floors, and a chance computed under others would no longer be the
 * calibrated one. The sliders go on tuning the pick list.
 */
export const WIN_MODEL_FLOORS = { minMatches: 200, minSynergyMatches: 200 } as const;

const TEAM_SIZE = 5;

/** The two line-ups, and nothing else a win chance needs. */
export type Board = Pick<DraftView, "mine" | "enemy">;

/**
 * One board, measured. Every figure is mine minus theirs, so swapping the two
 * line-ups negates all of them; `seatTotal` keeps each side's summed seat delta
 * apart because the role deficit is convex in it and has to be taken per side
 * before it is differenced.
 */
export interface DraftFeatures {
  /** Σ of every cross pairing's damped advantage, in points. */
  matchups: number;
  /** My pairs' synergy minus theirs, in points. */
  cohesion: number;
  /** Σ (win rate − 50) over my heroes, minus theirs. */
  heroes: number;
  /** Σ of the seats booked below a hero's own record, mine minus theirs. */
  seatPenalty: number;
  /** Σ of the seats booked above it, mine minus theirs. */
  seatBonus: number;
  /** Their early-cover shortfall minus mine, at unit weight. */
  timing: number;
  seatTotal: { mine: number; theirs: number };
}

interface SideRead {
  heroes: number;
  penalty: number;
  bonus: number;
}

/**
 * A side's strength and seats.
 *
 * A hero with no win rate adds nothing — unknown is not average — and a hero
 * with no seat booked counts for their strength but not for a seat.
 */
function readSide(data: Dataset, picks: DraftPick[]): SideRead {
  let heroes = 0;
  let penalty = 0;
  let bonus = 0;
  for (const pick of picks) {
    const hero = data.bySlug.get(pick.slug);
    if (!hero || hero.winRate === undefined) continue;
    heroes += hero.winRate - 50;
    if (!pick.position) continue;
    const delta = positionWinRate(hero, pick.position) - hero.winRate;
    if (delta < 0) penalty += delta;
    else bonus += delta;
  }
  return { heroes, penalty, bonus };
}

/** Σ of a side's pair synergies, read with the positions as booked. */
function sideCohesion(data: Dataset, picks: DraftPick[]): number {
  let total = 0;
  for (let i = 0; i < picks.length; i++) {
    for (let j = i + 1; j < picks.length; j++) {
      const a = picks[i]!;
      const b = picks[j]!;
      const s = synergy(data, a.slug, b.slug, a.position, b.position, WIN_MODEL_FLOORS.minSynergyMatches);
      if (s && s.matches >= WIN_MODEL_FLOORS.minSynergyMatches) total += s.synergy;
    }
  }
  return total;
}

/** Everything the model reads off a board. */
export function draftFeatures(data: Dataset, board: Board): DraftFeatures {
  let matchups = 0;
  for (const a of board.mine) {
    for (const b of board.enemy) {
      const m = matchup(data, a.slug, b.slug);
      if (m && m.matches >= WIN_MODEL_FLOORS.minMatches) matchups += m.advantage;
    }
  }
  const mine = readSide(data, board.mine);
  const theirs = readSide(data, board.enemy);
  const cover = (picks: DraftPick[]) =>
    teamCover(picks.map((p) => data.bySlug.get(p.slug)), data.timingShape);

  return {
    matchups,
    cohesion: sideCohesion(data, board.mine) - sideCohesion(data, board.enemy),
    heroes: mine.heroes - theirs.heroes,
    seatPenalty: mine.penalty - theirs.penalty,
    seatBonus: mine.bonus - theirs.bonus,
    timing: earlyCoverPenalty(cover(board.enemy), 1) - earlyCoverPenalty(cover(board.mine), 1),
    seatTotal: { mine: mine.penalty + mine.bonus, theirs: theirs.penalty + theirs.bonus },
  };
}

/**
 * What a side's seats cost it beyond the seats themselves.
 *
 * Zero until the side's mean seat delta passes `−tau`, then the square of the
 * excess. Divided by five whatever is on the board, so an undrafted hero counts
 * as seated where they belong. Bonuses never create a deficit.
 */
export const roleDeficit = (seatTotal: number, tau: number): number =>
  Math.min(0, seatTotal / TEAM_SIZE + tau) ** 2;

/** The model's inputs for one board at one threshold. */
export function winFeatures(features: DraftFeatures, tau: number): Record<WinFeature, number> {
  return {
    matchups: features.matchups,
    cohesion: features.cohesion,
    heroes: features.heroes,
    seatPenalty: features.seatPenalty,
    seatBonus: features.seatBonus,
    roleDeficit:
      roleDeficit(features.seatTotal.mine, tau) - roleDeficit(features.seatTotal.theirs, tau),
    timing: features.timing,
  };
}

// --------------------------------------------------------------- calibration

/** The data files the features are read from, whose dates a calibration records. */
export const CALIBRATION_INPUTS = ["matchups", "positions", "synergies", "timings"] as const;
export type CalibrationInput = (typeof CALIBRATION_INPUTS)[number];

/** `public/data/calibration.json`, validated. */
export interface Calibration {
  generatedAt: string | null;
  /** Games the weights were fitted on. */
  matches: number;
  matchIdRange: [number, number] | null;
  /** The role-deficit threshold, in points per hero. */
  tau: number;
  /** Log-odds per unit of each feature. */
  weights: Record<WinFeature, number>;
  /** The span of chances the reliability table can vouch for. */
  range: [number, number];
  /** `generatedAt` of each data file the features were read from. */
  inputs: Partial<Record<CalibrationInput, string>>;
  holdout: { logLoss: number; baseline: number; auc: number } | null;
  /** `[from, to, team-games, mean predicted, actual]`, out of fold and read from both seats. */
  reliability: Array<[number, number, number, number, number]>;
}

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/**
 * The file, or null when it is anything short of usable.
 *
 * Every feature needs a weight: a calibration missing one was fitted for a
 * different model, and filling the gap with zero would be inventing a fit.
 */
export function readCalibration(raw: unknown): Calibration | null {
  if (!raw || typeof raw !== "object") return null;
  const file = raw as Record<string, unknown>;

  const rawWeights = file.weights;
  if (!rawWeights || typeof rawWeights !== "object") return null;
  const weights = {} as Record<WinFeature, number>;
  for (const key of WIN_FEATURES) {
    const value = (rawWeights as Record<string, unknown>)[key];
    if (!finite(value)) return null;
    weights[key] = value;
  }

  const { tau, matches, range } = file;
  if (!finite(tau) || tau < 0) return null;
  if (!finite(matches) || matches <= 0) return null;
  if (!Array.isArray(range) || range.length !== 2) return null;
  const [low, high] = range as unknown[];
  if (!finite(low) || !finite(high)) return null;
  if (!(low > 0 && low < 0.5 && high > 0.5 && high < 1)) return null;

  const inputs: Calibration["inputs"] = {};
  if (file.inputs && typeof file.inputs === "object") {
    for (const key of CALIBRATION_INPUTS) {
      const value = (file.inputs as Record<string, unknown>)[key];
      if (typeof value === "string") inputs[key] = value;
    }
  }

  const reliability = Array.isArray(file.reliability)
    ? file.reliability.filter(
        (row): row is [number, number, number, number, number] =>
          Array.isArray(row) && row.length === 5 && row.every(finite),
      )
    : [];

  const h = file.holdout as Record<string, unknown> | null | undefined;
  const holdout =
    h && finite(h.logLoss) && finite(h.baseline) && finite(h.auc)
      ? { logLoss: h.logLoss, baseline: h.baseline, auc: h.auc }
      : null;

  const ids = file.matchIdRange;
  const matchIdRange: [number, number] | null =
    Array.isArray(ids) && ids.length === 2 && finite(ids[0]) && finite(ids[1])
      ? [ids[0], ids[1]]
      : null;

  return {
    generatedAt: typeof file.generatedAt === "string" ? file.generatedAt : null,
    matches,
    matchIdRange,
    tau,
    weights,
    range: [low, high],
    inputs,
    holdout,
    reliability,
  };
}

/**
 * Data files loaded now that differ from the ones the weights were fitted on.
 *
 * Not a reason to hide the chance — a refresh that re-collects synergies moves
 * the weights a little, not wholesale — but a reason to say so.
 */
export function calibrationDrift(data: Dataset): CalibrationInput[] {
  const calibration = data.calibration;
  if (!calibration) return [];
  const loaded: Record<CalibrationInput, string | null | undefined> = {
    matchups: data.generatedAt,
    positions: data.positionsGeneratedAt,
    synergies: data.synergyGeneratedAt,
    timings: data.timingGeneratedAt,
  };
  return CALIBRATION_INPUTS.filter((key) => {
    const fitted = calibration.inputs[key];
    return fitted !== undefined && fitted !== (loaded[key] ?? null);
  });
}
