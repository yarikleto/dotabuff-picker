import { matchup, synergy } from "./scoring";
import type { DraftView } from "./scoring";
import { positionFit, positionWinRate } from "./roles";
import { earlyCoverPenalty, teamCover } from "./timing";
import type { Dataset, DraftPick, Position } from "../types";

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

// ------------------------------------------------------------------ the read

/** How the parts are shown: the seat terms together, everything else on its own. */
export const WIN_GROUPS = ["roles", "matchups", "cohesion", "heroes", "timing"] as const;
export type WinGroup = (typeof WIN_GROUPS)[number];

export const GROUP_LABEL: Record<WinGroup, string> = {
  roles: "Roles",
  matchups: "Matchups",
  cohesion: "Cohesion",
  heroes: "Heroes",
  timing: "Timing",
};

const GROUP_OF: Record<WinFeature, WinGroup> = {
  matchups: "matchups",
  cohesion: "cohesion",
  heroes: "heroes",
  seatPenalty: "roles",
  seatBonus: "roles",
  roleDeficit: "roles",
  timing: "timing",
};

export const sigmoid = (z: number): number => 1 / (1 + Math.exp(-z));

/**
 * Each group's exact Shapley value, in points of win chance.
 *
 * `values` are the groups' log-odds. A chance is not additive in them, so a
 * plain split would leave a remainder nobody could account for; the Shapley
 * value averages each group's effect over every order the groups could be
 * added in, and the parts then add up to `100·σ(Σ values) − 50` exactly. Five
 * groups are 32 evaluations.
 */
export function shapley(values: number[]): number[] {
  const n = values.length;
  const factorial = [1];
  for (let i = 1; i <= n; i++) factorial.push(factorial[i - 1]! * i);
  const parts = values.map(() => 0);
  for (let mask = 0; mask < 1 << n; mask++) {
    let z = 0;
    let size = 0;
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) {
        z += values[i]!;
        size++;
      }
    }
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) continue;
      const weight = (factorial[size]! * factorial[n - size - 1]!) / factorial[n]!;
      parts[i] = (parts[i] ?? 0) + weight * (sigmoid(z + values[i]!) - sigmoid(z)) * 100;
    }
  }
  return parts;
}

/** The verdict, in the same words the comparison signal used. */
export interface WinVerdict {
  label: string;
  side: "mine" | "enemy" | "even";
  /** 0..4, for the strength of the colour. */
  strength: number;
}

/** Bands by distance from an even game, in points of win chance. */
export function verdictForChance(chance: number): WinVerdict {
  const distance = Math.abs(chance * 100 - 50);
  const mine = chance >= 0.5;
  if (distance < 5) return { label: "Coin flip", side: "even", strength: 0 };
  const side = mine ? "mine" : "enemy";
  if (distance < 10) return { label: mine ? "Slight edge to you" : "Slight edge to them", side, strength: 1 };
  if (distance < 17) return { label: mine ? "You are favoured" : "They are favoured", side, strength: 2 };
  if (distance < 25) return { label: mine ? "You are well ahead" : "They are well ahead", side, strength: 3 };
  return { label: mine ? "Dominant draft" : "You are being run over", side, strength: 4 };
}

/**
 * The chance as printed: a whole percent inside the span the calibration can
 * vouch for, and a bound beyond it — the model's own figure there is an
 * extrapolation past the last bin with enough games to check it against.
 */
export function showChance(
  chance: number,
  range: readonly [number, number],
): { shown: string; short: string; inRange: boolean } {
  const [low, high] = range;
  const pct = (n: number) => Math.round(n * 100);
  if (chance < low) return { shown: `under ${pct(low)}%`, short: `<${pct(low)}%`, inRange: false };
  if (chance > high) return { shown: `over ${pct(high)}%`, short: `>${pct(high)}%`, inRange: false };
  return { shown: `${pct(chance)}%`, short: `${pct(chance)}%`, inRange: true };
}

/** One group of the model, in points of win chance. */
export interface WinPart {
  group: WinGroup;
  label: string;
  points: number;
}

/** The reliability bin a chance falls in: what drafts rated like this actually did. */
export interface WinEvidence {
  from: number;
  to: number;
  games: number;
  actual: number;
}

/** One hero's seat, for the Roles card and the reasons. */
export interface SeatReport {
  slug: string;
  name: string;
  position: Position | null;
  /** Share of their games in this seat, or null without position data. */
  share: number | null;
  /** Their win rate in this seat, and overall; null when either is unknown. */
  seatWinRate: number | null;
  winRate: number | null;
  /** `seatWinRate − winRate`, 0 when either is unknown. */
  delta: number;
}

export interface SideRoles {
  seats: SeatReport[];
  /** Σ delta. */
  total: number;
  /** Seats under `ROLE_REASON_SHARE` of the hero's games, rarest first. */
  offRole: SeatReport[];
  /** A complete side whose summed position-4 and -5 shares are under half a hero. */
  noSupports: boolean;
  /** A complete side whose summed position-1 to -3 shares are under half a hero. */
  noCores: boolean;
}

export interface RolesRead {
  mine: SideRoles;
  theirs: SideRoles;
}

/** Below this share of a hero's games, a seat is named as off-role in the reasons. */
export const ROLE_REASON_SHARE = 0.05;

function sideRoles(data: Dataset, picks: DraftPick[]): SideRoles {
  const seats: SeatReport[] = picks.map((pick) => {
    const hero = data.bySlug.get(pick.slug);
    const winRate = hero?.winRate ?? null;
    const share = hero?.positions && pick.position ? positionFit(hero, pick.position) : null;
    const seatWinRate =
      hero && pick.position && winRate !== null ? positionWinRate(hero, pick.position) : null;
    return {
      slug: pick.slug,
      name: hero?.name ?? pick.slug,
      position: pick.position,
      share,
      seatWinRate,
      winRate,
      delta: seatWinRate !== null && winRate !== null ? seatWinRate - winRate : 0,
    };
  });
  const complete =
    picks.length >= TEAM_SIZE && picks.every((p) => data.bySlug.get(p.slug)?.positions);
  const summed = (from: Position[]) =>
    picks.reduce((total, p) => {
      const positions = data.bySlug.get(p.slug)?.positions;
      return total + from.reduce((n, position) => n + (positions?.[position] ?? 0), 0);
    }, 0);
  return {
    seats,
    total: seats.reduce((n, s) => n + s.delta, 0),
    offRole: seats
      .filter((s) => s.share !== null && s.share < ROLE_REASON_SHARE)
      .sort((a, b) => (a.share ?? 0) - (b.share ?? 0)),
    noSupports: complete && summed([4, 5]) < 0.5,
    noCores: complete && summed([1, 2, 3]) < 0.5,
  };
}

/** Both sides' seats, for the Roles card and `rolesReason`. */
export function rolesRead(data: Dataset, board: Board): RolesRead {
  return { mine: sideRoles(data, board.mine), theirs: sideRoles(data, board.enemy) };
}

const sharePct = (share: number) =>
  `${share < 0.1 ? (share * 100).toFixed(1) : Math.round(share * 100)}%`;
const seatText = (seat: SeatReport) =>
  `${seat.name} at ${seat.position} (${sharePct(seat.share ?? 0)} of their games)`;

/**
 * The Roles part in words: what is wrong with our seats, and what is wrong with
 * theirs, which is good news. Null when neither side has anything to say.
 */
export function rolesReason(roles: RolesRead): string | null {
  const ours = roles.mine;
  const lead = ours.noSupports
    ? "Nobody on your side supports"
    : ours.noCores
      ? "Nobody on your side farms"
      : null;
  const named = ours.offRole.map(seatText).join(", ");
  let text: string | null = lead ? (named ? `${lead}: ${named}` : lead) : named || null;
  if (!text) {
    // Nobody is somewhere they never play, but a seat can still cost a lot.
    const worst = [...ours.seats].sort((a, b) => a.delta - b.delta)[0];
    if (worst && worst.delta <= -3 && worst.seatWinRate !== null && worst.winRate !== null) {
      text =
        `${worst.name} wins ${worst.seatWinRate.toFixed(1)}% at ${worst.position} ` +
        `against ${worst.winRate.toFixed(1)}% overall`;
    }
  }
  const theirs = roles.theirs.offRole;
  if (theirs.length) {
    const news = `their ${theirs.map(seatText).join(", ")} ${theirs.length === 1 ? "is" : "are"} off-role`;
    text = text ? `${text}; ${news}` : `${news.charAt(0).toUpperCase()}${news.slice(1)}`;
  }
  return text;
}

/** The board as a win chance, with its parts and the seats behind the roles part. */
export interface WinRead {
  /** 0..1, the model's own figure. */
  chance: number;
  logOdds: number;
  /** "38%", "under 15%". */
  shown: string;
  /** "38%", "<15%" — for the top-bar chip. */
  short: string;
  inRange: boolean;
  verdict: WinVerdict;
  /** In `WIN_GROUPS` order; they add up to `100·chance − 50`. */
  parts: WinPart[];
  roles: RolesRead;
  /** What drafts rated like this won, when the chance is inside the calibrated range. */
  evidence: WinEvidence | null;
  /** Games the weights were fitted on. */
  matches: number;
}

export function winRead(data: Dataset, board: Board, calibration: Calibration): WinRead {
  const vector = winFeatures(draftFeatures(data, board), calibration.tau);
  const byGroup = new Map<WinGroup, number>(WIN_GROUPS.map((group) => [group, 0]));
  for (const key of WIN_FEATURES) {
    const group = GROUP_OF[key];
    byGroup.set(group, (byGroup.get(group) ?? 0) + calibration.weights[key] * vector[key]);
  }
  const values = WIN_GROUPS.map((group) => byGroup.get(group) ?? 0);
  const logOdds = values.reduce((sum, v) => sum + v, 0);
  const chance = sigmoid(logOdds);
  const points = shapley(values);
  const display = showChance(chance, calibration.range);
  const bin = display.inRange
    ? calibration.reliability.find(([from, to]) => chance >= from && chance < to)
    : undefined;
  return {
    chance,
    logOdds,
    ...display,
    verdict: verdictForChance(chance),
    parts: WIN_GROUPS.map((group, i) => ({ group, label: GROUP_LABEL[group], points: points[i] ?? 0 })),
    roles: rolesRead(data, board),
    evidence: bin ? { from: bin[0], to: bin[1], games: bin[2], actual: bin[4] } : null,
    matches: calibration.matches,
  };
}
