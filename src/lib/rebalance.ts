import { NOISE, draftBalance } from "./scoring";
import { laneScoreboard, verdictFor } from "./analysis";
import { POSITIONS, canPlay, positionFit, seatWorth } from "./roles";
import { WIN_GROUPS, verdictForChance, winChance } from "./winModel";
import type { WinGroup } from "./winModel";
import type { DraftView } from "./scoring";
import type { ContestedLane, LaneScoreboardEntry } from "./analysis";
import type { Dataset, DraftPick, Hero, LanePlan, Position, Settings } from "../types";

/**
 * What to do when the hero you spent a first pick on is the one they answered.
 *
 * Everything else in this app changes the draft by adding a hero to it. This is
 * the one question you can ask after the picks are locked and still get a
 * different game: the five heroes are fixed, and the only things left to move
 * are which of them takes which position and which lane each duo walks to.
 *
 * That move is genuinely hard to do by eye, which is why it is here. A five-hero
 * line-up has 120 role seatings; the lane swap doubles it; and each one
 * reweights every pairing on the board and re-cuts every lane read. Nobody works
 * that out in the thirty seconds a draft gives you, so the search is small
 * enough to just run exhaustively and report what it found.
 *
 * The search is *only* over arrangements. It never suggests a different hero —
 * that is what the pick list is for, and by the time this question is worth
 * asking the hero is already spent.
 */

// --------------------------------------------------------------- readiness

/** Why the question cannot be asked yet. */
export type BlockReason = "no-team" | "no-enemy" | "short-team" | "unseated";

export interface Readiness {
  ready: boolean;
  reason: BlockReason | null;
  /** One sentence, for the disabled button. */
  detail: string;
  /** Heroes of mine with no position booked, by slug. Empty unless "unseated". */
  unseated: string[];
}

const READY: Readiness = { ready: true, reason: null, detail: "", unseated: [] };

/**
 * Whether a rearrangement is a question worth asking, and if not, why not.
 *
 * Deliberately cheap and separate from the search, for two reasons that pull the
 * same way. The caller can render a truthful disabled state without running 240
 * board evaluations to discover there was nothing to run them on; and the search
 * itself gets to assume a complete, fully-seated five, which is what makes its
 * arithmetic comparable.
 *
 * That completeness requirement is the correction. The search used to run from
 * two heroes, and on a partial board it is not measuring what it claims to:
 * `lineupFit` averages over whoever happens to be seated, so a two-hero mean and
 * a five-hero mean were being compared against the same noise floor; two thirds
 * of the "seatings" it counted were bookings of heroes who do not exist yet; and
 * a lane plan is a statement about four duos, so offering to swap lanes before
 * the duos are drafted is advice about nothing. The honest answer at 2v5 is that
 * there is still a hero to pick, and the pick list is the tool for that.
 */
export function rebalanceReadiness(draft: DraftView): Readiness {
  if (draft.mine.length === 0) {
    return { ready: false, reason: "no-team", detail: "Add your heroes first.", unseated: [] };
  }
  if (draft.enemy.length === 0) {
    return {
      ready: false,
      reason: "no-enemy",
      detail: "Nothing to rearrange against — add at least one of their heroes.",
      unseated: [],
    };
  }
  if (draft.mine.length < POSITIONS.length) {
    const short = POSITIONS.length - draft.mine.length;
    return {
      ready: false,
      reason: "short-team",
      detail:
        `${short} more of your heroes to go. Seats and lanes only mean something once the ` +
        `line-up is complete — until then the pick list is the tool.`,
      unseated: [],
    };
  }
  const unseated = draft.mine.filter((p) => !p.position).map((p) => p.slug);
  if (unseated.length) {
    return {
      ready: false,
      reason: "unseated",
      detail: `${unseated.length} of your heroes has no position booked, and seats are what this searches over.`,
      unseated,
    };
  }
  return READY;
}

// ------------------------------------------------------------------- model

/** One line-up, deployed one way. */
export interface Arrangement {
  picks: DraftPick[];
  lanePlan: LanePlan;
}

/**
 * What an arrangement is worth, in percentage points.
 *
 * Two halves, kept apart because they answer different objections and because
 * only one of them is a number the rest of the app prints. `advantage` *is* the
 * app's headline draft figure — matchups, cohesion and timing — read off the
 * board as this arrangement would leave it. `fit` is everything about a hero
 * that depends on *where you put them*, which the headline cannot see: the same
 * recipe `evaluate` uses to rank a candidate for a position, so a reshuffle and
 * a suggestion agree about what a hero is worth in a role.
 */
export interface ArrangementScore {
  advantage: number;
  fit: number;
  /**
   * What the three lanes are worth, from the readings taken *in* a lane — how
   * the pairings standing opposite each other have gone in lane, each side's
   * record from the ground they are standing on, and how the two duos work
   * together. Averaged over the contested lanes, in the same percentage points
   * as everything else here.
   *
   * The term the panel was missing, and the reason it existed at all. Seating is
   * the one thing a locked draft can still change about the laning stage, and
   * the objective could not see the laning stage: `advantage` is measured over
   * whole games and says nothing about the first ten minutes, `fit` is about a
   * hero's record in a role rather than a lane. What stood here before was a
   * hand-rolled half of this — a per-hero difference between their offlane and
   * safe-lane win rates, charged only when the deployment changed, blind to the
   * enemy and to the duos. This is that question asked properly and asked on
   * every arrangement.
   *
   * Free of the matchup table on purpose. `advantage` already sums every pairing
   * on the board, at double weight where the two heroes meet in a lane; reading
   * the lane cards' own headline figure here would count those pairings a third
   * time. See `laning` on `LaneScoreboardEntry`.
   */
  lanes: number;
  /**
   * The win chance of the board arranged this way, in points (0–100), when the
   * dataset carries a calibration; null otherwise. With it, this is what
   * arrangements are ranked on: seats and the role deficit are inside the
   * model, fitted on how seats actually go, and the lane read measured nothing
   * on real games. See docs/scoring.md, "Scoring an arrangement".
   */
  chance: number | null;
  /** `chance` as the headline prints it — "38%", or "under 15%" beyond the calibrated range. */
  shown: string | null;
  /** `chance` by group, in points; null without a calibration. */
  parts: Record<WinGroup, number> | null;
  /** What arrangements are ranked on: `chance` when calibrated, `advantage + fit + lanes` otherwise. */
  total: number;
}

/**
 * What an arrangement *changes*, term by term.
 *
 * The panel used to lead with `total` under the word "board" while printing
 * `advantage` on the line below under the word "draft" — two different
 * quantities, one of them labelled as the other, three points apart on a typical
 * board. Reporting the terms separately is the fix: the ranking still happens on
 * the sum, and the reader can see which half of it they are being sold.
 */
export interface Gain {
  advantage: number;
  fit: number;
  lanes: number;
  /** Points of win chance, when calibrated. */
  chance: number | null;
  /** That change by group; the parts add up to `chance`. */
  parts: Record<WinGroup, number> | null;
  total: number;
}

/** One hero changing position. */
export interface RoleMove {
  slug: string;
  name: string;
  from: Position | null;
  to: Position;
  /** Share of this hero's games in the position they are being moved to, 0..1. */
  fit: number;
}

/** A lane whose read moves when the arrangement is applied. */
export interface LaneShift {
  key: ContestedLane;
  label: string;
  /**
   * One or two words, for the places a full label will not fit — the unit
   * printed under a figure, and the top-bar button. `label` runs to "Safe duos
   * (swapped)", which is right in a lane card and far too long anywhere a
   * number needs saying what it is a number *of*.
   */
  short: string;
  before: number;
  after: number;
  /** Percentage points the lane score moves, from my side. */
  delta: number;
}

const LANE_SHORT: Record<ContestedLane, string> = {
  safe: "safe lane",
  mid: "mid",
  off: "off lane",
};

/**
 * Why an arrangement is on the list.
 *
 * `score` is the original rule: the board is worth more arranged this way.
 * `lane` is the one it was missing — an arrangement that leaves the whole-board
 * figure where it was while taking a lane out of the fire.
 *
 * Those two are not the same claim and must not be shown as one. A single scalar
 * over 25 pairings can hide an enormous change to four of them: moving a
 * countered mid can be worth two points in that lane, cost most of it back
 * across the map, and net out below the noise floor — at which point the score
 * rule alone reports "the five are already where they should be" about a draft
 * whose mid is being run over.
 *
 * `seat` is the third, and it exists because the panel used to apply its own
 * role threshold to every arrangement it *considered* and never once to the
 * board it was sitting on. A line-up with Earth Spirit booked at position 1 —
 * 0.15% of his games, flagged in red two panels over, and a seat this search
 * would refuse to suggest to anybody — came back "no arrangement beats the
 * board", because the only seatings that put him somewhere he plays cost half a
 * point of score. Half a point is not the price of a carry who cannot carry.
 *
 * So an arrangement that takes a hero out of a position they do not play earns
 * its place whether or not the figure improves, and the figure is printed next
 * to it as the cost. Nothing else in this file is allowed to lose score.
 */
export type RebalanceReason = "score" | "lane" | "seat";

/** A hero booked into a position they hardly ever play. */
export interface OffRoleSeat {
  slug: string;
  name: string;
  position: Position;
  /** Share of this hero's games in that position, 0..1. */
  fit: number;
}

export interface RebalanceOption extends Arrangement {
  /** Stable identity: same five, same seats, same plan — same id. */
  id: string;
  score: ArrangementScore;
  gain: Gain;
  reason: RebalanceReason;
  /** The losing lane this arrangement repairs. Set only when `reason` is "lane". */
  repairedLane: LaneShift | null;
  /**
   * Heroes the board has in a seat they do not play, whom this arrangement puts
   * back on one. Empty unless the board itself is off-role.
   */
  repairedSeats: OffRoleSeat[];
  /** Heroes this arrangement itself leaves off-role. Zero when `legal`. */
  offRole: number;
  moves: RoleMove[];
  /** True when the lane plan differs from the one on the board. */
  swapsLanes: boolean;
  /**
   * How much upheaval this is: heroes moved, plus one if the duos walk the
   * other way. The trade-off curve is cut on it, so the reader is always
   * offered the cheapest fix as well as the biggest one.
   */
  size: number;
  /** The lanes that move most, worst first. Empty when none clears the floor. */
  laneShifts: LaneShift[];
  /** The headline verdict this arrangement would leave the draft on. */
  verdict: string;
  /**
   * The hero this arrangement asks the most of — the smallest role fit in it,
   * counting only heroes who actually move. Null when nobody is stretched.
   */
  stretch: { name: string; position: Position; fit: number } | null;
  /** Every hero clears `settings.minRoleFit` in the seat this gives them. */
  legal: boolean;
}

/** A position exactly one of my heroes clears the role threshold for. */
export interface ForcedSeat {
  position: Position;
  name: string;
  fit: number;
}

/**
 * What the search cost and what it ruled out.
 *
 * Every field is in one unit and says which, because the footer used to mix
 * them: "2 of 20 seatings clear your threshold ... out of 39 scored" put two
 * denominators of different kinds in one sentence and invited the reader to
 * reconcile them.
 */
export interface SearchCounts {
  /** Distinct role seatings generated. 120 for a full five. */
  seatings: number;
  /** Of those, the ones where every hero clears the role threshold. */
  legalSeatings: number;
  /** Seatings × lane plans, less the board's own — what was actually scored. */
  arrangements: number;
  /**
   * Lane reads bought. Equal to `arrangements` now that the lane read is part of
   * the score rather than something bought on top of it — kept as its own figure
   * precisely so that stays checkable: anything above `arrangements` means an
   * arrangement was read twice, and two reads of one board are two chances for a
   * card's figure and its explanation to disagree.
   */
  laneReads: number;
}

export interface RebalanceReport {
  current: ArrangementScore;
  /** The verdict the board reads as now, for the before/after. */
  currentVerdict: string;
  /** The lanes we are losing right now, worst first. Why a repair can exist. */
  losing: LaneScoreboardEntry[];
  /**
   * Heroes on the board *as it stands* who are below the role threshold, worst
   * first — the check this panel applied to everything except the thing the
   * reader is actually looking at.
   *
   * Reported even when nothing can be done about it, because "your carry is not
   * a carry and no rearrangement of these five fixes that" is a true and useful
   * sentence, and the panel's old answer to that board was silence.
   */
  offRole: OffRoleSeat[];
  /** Arrangements that put an off-role hero back on a seat they play. */
  seatFixes: RebalanceOption[];
  /**
   * Every single trade that already improves the board, best first.
   *
   * Not a shortlist and not on the trade-off curve — the curve exists to make a
   * hundred and twenty seatings choosable, and these are eleven arrangements
   * every one of which costs the same trivial amount of upheaval. Filtering
   * them further would be answering a question nobody asked; there is nothing
   * to trade off.
   *
   * Ones that need a hero below the role threshold are kept and flagged rather
   * than dropped, because at this size the reader can judge each on its own —
   * "swap your 4 and your 5" is a sentence somebody who knows the players can
   * accept or refuse on sight, which is exactly what the threshold is standing
   * in for elsewhere.
   */
  swaps: RebalanceOption[];
  /** Arrangements worth more than the board is on, along the trade-off curve. */
  options: RebalanceOption[];
  /** Arrangements that fix a losing lane without moving the whole-board figure. */
  laneFixes: RebalanceOption[];
  /**
   * Arrangements that would qualify but need somebody below the role threshold.
   *
   * Kept apart rather than filtered away, because "no better arrangement exists"
   * and "no better arrangement exists that respects your 8% threshold" are
   * different sentences and only one of them is true. A five-hero line-up with
   * one carry has *no* legal way to move that carry off position 1, and the
   * panel used to report that as the draft being correctly seated.
   */
  beyondThreshold: RebalanceOption[];
  /** The find worth interrupting someone for, or null when there is none. */
  best: RebalanceOption | null;
  counts: SearchCounts;
  /**
   * Positions only one of my heroes plays often enough, which is usually the
   * whole explanation for a search that came back with two arrangements out of
   * a hundred and twenty.
   */
  forced: ForcedSeat[];
  /**
   * True when the role threshold left nothing to try — every hero is pinned to
   * the one position they play often enough. Without it the panel would report
   * "no better arrangement" when the truthful answer is "no other arrangement".
   */
  pinned: boolean;
  /**
   * The qualifying floor this search used — a point of win chance when
   * calibrated, the noise floor otherwise — so nothing downstream has to
   * restate it.
   */
  threshold: number;
  /** The role threshold in force, for the same reason. */
  minRoleFit: number;
}

/**
 * How many arrangements the panel is willing to show.
 *
 * Small on purpose. Past three or four the list stops being a decision and
 * becomes a table of permutations, and the reader is back to doing the
 * combinatorics this exists to spare them.
 */
const MAX_OPTIONS = 4;

/** The secondary lists are shorter — they are caveats, not menus. */
const MAX_ASIDES = 3;

const PLANS: LanePlan[] = ["standard", "swapped"];

/**
 * What a hero is worth in one position, in percentage points.
 *
 * The term `evaluate` uses and `draftBalance` cannot: the hero's record in that
 * specific position. How far the seat is from what they actually play is inside
 * that record, and `seatWorth` reads it exactly as `evaluate` does — so "Earth
 * Spirit is a 4" cannot come to mean one thing in the suggestion list and
 * another in this panel.
 *
 * A third term used to live here: the gap between a hero's offlane and
 * safe-lane records, charged only when the deployment changed. It was a
 * hand-rolled quarter of a lane read — one side of one lane, no enemy in it, no
 * duo, and silent under the standard plan, where seating decides the laning
 * stage just as much. `ArrangementScore.lanes` asks that question properly, for
 * both sides and on every arrangement, so this is back to being what its name
 * says: what a hero is worth in a *seat*.
 */
function heroFit(data: Dataset, hero: Hero, position: Position, settings: Settings): number {
  return settings.metaWeight * (seatWorth(hero, position, data.calibration) - 50);
}

/**
 * The fit term for a whole line-up: the mean over its heroes.
 *
 * Mean rather than sum so it stays in the same units as `advantage`, which is
 * itself a mean over pairings. `rebalanceReadiness` guarantees a complete,
 * fully-seated five here, so the denominator is the same for every arrangement
 * being compared — which is the property that makes the difference between two
 * of these figures meaningful at all.
 */
function lineupFit(data: Dataset, picks: DraftPick[], settings: Settings): number {
  let total = 0;
  let counted = 0;
  for (const pick of picks) {
    const hero = data.bySlug.get(pick.slug);
    if (!hero || !pick.position) continue;
    total += heroFit(data, hero, pick.position, settings);
    counted++;
  }
  return counted ? total / counted : 0;
}

/**
 * The mean of the three lanes' laning edges, over the ones that were both
 * contested and measured.
 *
 * A mean rather than a sum so the term stays in win-rate points and means the
 * same thing on a board where the scrape only carried lane rows for one front —
 * the same reason `lineupFit` averages. A board with nothing measured anywhere
 * scores zero here and the objective is exactly what it was before this term
 * existed, which is the honest answer when the data cannot see the lanes.
 */
function laningEdge(board: Map<ContestedLane, LaneScoreboardEntry>): number {
  let total = 0;
  let counted = 0;
  for (const lane of board.values()) {
    if (!lane.contested || lane.laning === null) continue;
    total += lane.laning;
    counted++;
  }
  return counted ? total / counted : 0;
}

/**
 * What the board would be worth arranged this way, and the lane read it was
 * scored from.
 *
 * The scoreboard comes back with the score because the search needs both and
 * they are the same read: the figures behind "this arrangement is worth +1.4"
 * and behind "and here is which lane moved" must be one computation, or the
 * panel can show a gain whose explanation contradicts it.
 */
function readArrangement(
  data: Dataset,
  draft: DraftView,
  settings: Settings,
  arrangement: Arrangement,
): { score: ArrangementScore; board: Map<ContestedLane, LaneScoreboardEntry> } {
  const view: DraftView = { ...draft, mine: arrangement.picks, lanePlan: arrangement.lanePlan };
  // Null when there is nothing to compare — an empty enemy side. Treated as
  // zero rather than bailing, so the fit term can still order the arrangements
  // and `rebalanceReadiness` decides whether the question was worth asking.
  const advantage = draftBalance(data, view, settings)?.advantage ?? 0;
  const fit = lineupFit(data, arrangement.picks, settings);
  const board = laneScoreboard(data, view, settings);
  const lanes = laningEdge(board);
  const win = data.calibration ? winChance(data, view, data.calibration) : null;
  const chance = win ? win.chance * 100 : null;
  const parts = win
    ? (Object.fromEntries(win.parts.map((p) => [p.group, p.points])) as Record<WinGroup, number>)
    : null;
  return {
    score: {
      advantage,
      fit,
      lanes,
      chance,
      shown: win ? win.shown : null,
      parts,
      total: chance ?? advantage + fit + lanes,
    },
    board,
  };
}

/** What the board would be worth arranged this way. */
export function scoreArrangement(
  data: Dataset,
  draft: DraftView,
  settings: Settings,
  arrangement: Arrangement,
): ArrangementScore {
  return readArrangement(data, draft, settings, arrangement).score;
}

/** Stable identity for an arrangement, independent of pick order. */
export const arrangementId = (arrangement: Arrangement): string =>
  `${arrangement.lanePlan}:${[...arrangement.picks]
    .map((p) => `${p.slug}@${p.position ?? "-"}`)
    .sort()
    .join(",")}`;

// ------------------------------------------------------------------ search

/**
 * Every way the heroes could be booked into distinct positions.
 *
 * Deliberately *unfiltered*. The threshold used to prune inside this generator,
 * which made the pruned arrangements unmentionable — the caller could not count
 * them, describe them or offer them as a clearly-flagged aside, because they
 * were never generated. It now yields all of them and the caller decides what
 * each one is: a legal option, or one that needs somebody out of their depth.
 *
 * 120 seatings for a full five, which is nothing; the cost of a candidate is in
 * scoring it, not in producing it.
 */
function* placements(picks: DraftPick[]): Generator<DraftPick[]> {
  const used = new Set<Position>();
  const chosen: DraftPick[] = [];

  function* step(i: number): Generator<DraftPick[]> {
    const pick = picks[i];
    if (!pick) {
      yield chosen.map((p) => ({ ...p }));
      return;
    }
    for (const position of POSITIONS) {
      if (used.has(position)) continue;
      used.add(position);
      chosen.push({ slug: pick.slug, position });
      yield* step(i + 1);
      chosen.pop();
      used.delete(position);
    }
  }

  yield* step(0);
}

/**
 * The board one move away.
 *
 * The full search answers "where should these five be", and the answer is often
 * a four-way rotation worth more than anything else on the list and acted on by
 * nobody — the reader cannot hold it in their head, cannot check it against what
 * they know about their team, and cannot half-take it. This asks the smaller
 * question instead: is there a *single* trade that already makes the board
 * better? Two heroes exchanging seats, or the duos walking the other way, and
 * nothing else moves.
 *
 * Small moves compose. Applying the best one re-runs the search from the board
 * it produced, so a line-up two or three trades away from where it should be
 * gets there by steps that can each be understood and refused on their own —
 * which is the difference between advice and a permutation table.
 *
 * Eleven arrangements for a full five: ten pairs of seats, plus the deployment
 * on its own. Every one of them is already in the exhaustive sweep, so these are
 * *selected* out of it rather than scored again — the figures on a small move
 * and on the big arrangement that contains it can never disagree.
 */
function* neighbours(picks: DraftPick[], plan: LanePlan): Generator<Arrangement> {
  // The one move that costs nobody their seat, so it leads.
  yield { picks: picks.map((p) => ({ ...p })), lanePlan: plan === "standard" ? "swapped" : "standard" };

  for (let i = 0; i < picks.length; i++) {
    for (let j = i + 1; j < picks.length; j++) {
      const a = picks[i]!;
      const b = picks[j]!;
      // Two unseated heroes trading nothing is not a move. `rebalance` refuses
      // to run on a board with any of them, but the generator is exported to
      // tests and should not invent a candidate identical to the board.
      if (a.position === b.position) continue;
      const traded = picks.map((p) => ({ ...p }));
      traded[i] = { ...a, position: b.position };
      traded[j] = { ...b, position: a.position };
      yield { picks: traded, lanePlan: plan };
    }
  }
}

/** The heroes in this seating booked below the role threshold, worst first. */
function offRoleSeats(data: Dataset, picks: DraftPick[], settings: Settings): OffRoleSeat[] {
  const out: OffRoleSeat[] = [];
  for (const pick of picks) {
    const hero = data.bySlug.get(pick.slug);
    if (!hero || !pick.position) continue;
    if (canPlay(hero, pick.position, settings.minRoleFit)) continue;
    out.push({
      slug: pick.slug,
      name: hero.name,
      position: pick.position,
      fit: positionFit(hero, pick.position),
    });
  }
  return out.sort((a, b) => a.fit - b.fit);
}

/**
 * The most score a seat repair may cost before it stops being advice, on the
 * comparison signal — the search without a calibration. With one, `total` is in
 * points of win chance and the ceiling is `MAX_SEAT_CHANCE_COST`.
 *
 * A ceiling, not a working limit. Across 283 scrambled boards the dearest
 * repair the live table produced cost 1.48, and only 39 of 794 cost anything at
 * all — which is the shape the arithmetic predicts, since the thinnest seats
 * read 7.4pp below their hero's own figure and a two-hero trade averages twice
 * that over five heroes at the default meta weight.
 *
 * So this does not pick between the repairs a captain will actually see. It is
 * here for the board that would produce one anyway, where the trade has stopped
 * being "put the carry back where he can farm" and become "wreck the draft to
 * satisfy a slider" — the one kind of row on this panel allowed to lose score
 * should not be allowed to lose an unbounded amount of it.
 *
 * Exported so the test that pins the bound reads the bound itself.
 */
export const MAX_SEAT_COST = 2;

/**
 * Points of win chance an arrangement has to add to be offered on its figure
 * alone, when the dataset carries a calibration. The comparison signal's half
 * point was worth about four and a half points of win chance on real games; one
 * is the smallest change worth asking a player to move for.
 */
export const CHANCE_GAIN = 1;

/**
 * The most win chance a seat repair may cost, in points, when the dataset
 * carries a calibration — `MAX_SEAT_COST`'s job, in the units `total` is then in.
 *
 * Not `MAX_SEAT_COST` read in new units, which is what stood here first. Two
 * points of win chance is inside what real repairs cost: across 900 scrambled
 * boards on the live table, one in forty of the repairs the panel would have
 * shortlisted cost more than two points of win chance, against almost none past
 * two on the comparison signal. Reusing the number made the calibrated search
 * several times stricter than the one it replaced, silently — a repair the
 * signal offered was dropped, and a board whose only repairs were dear was told
 * no rearrangement fixes it. Nor is it that limit put through the conversion
 * `CHANCE_GAIN` quotes, which would make it eighteen: that rate is what a point
 * of the draft figure is worth on real games, and a reseat moves the seat terms
 * and little else. On those boards a repair's change in win chance ran at about half
 * its change in the signal, with a wider spread.
 *
 * Five is the same kind of ceiling as the signal's two, and it is reached from
 * both sides. It is above every repair the panel would have shown on those
 * boards — the dearest, shortlisted or one trade away, cost 4.3 — so it does not
 * pick between the repairs a captain will actually see. And it is just under
 * what the model itself charges for the stretch being undone: a hero in the
 * thinnest seats reads 7.4pp below their own figure, which at the fitted
 * seat-penalty weight (0.031 log-odds a point in the current calibration) is
 * 0.23 log-odds, about five and three-quarter points of win chance on an even
 * board. A repair dearer than that is losing more elsewhere than the stranded
 * seat was ever costing, which is the "wreck the draft to satisfy a slider" row
 * the bound exists to refuse.
 *
 * Seldom reached, because the model prices a bad seat: freeing one usually
 * *adds* chance, and the median shortlisted repair on those boards gained half
 * a point. The cost comes from a thin seat the model does not mind — a small
 * sample that happens to have gone well — and from whoever has to move to make
 * room.
 */
export const MAX_SEAT_CHANCE_COST = 5;

/** The same five heroes in the same positions? */
const samePlacement = (a: DraftPick[], b: DraftPick[]): boolean => {
  const was = new Map(a.map((p) => [p.slug, p.position]));
  return b.every((p) => was.get(p.slug) === p.position);
};

/**
 * The positions only one of my heroes plays often enough to be offered.
 *
 * Almost always the whole explanation for a search that came back with two
 * arrangements out of a hundred and twenty. A five-hero line-up with exactly
 * one hero who plays position 1 has that hero nailed to it, and every other
 * seat is then decided by what is left — so "nothing better was found" is not a
 * statement about the draft, it is a statement about the threshold, and the
 * panel has to be able to say which.
 */
function forcedSeats(data: Dataset, picks: DraftPick[], settings: Settings): ForcedSeat[] {
  const out: ForcedSeat[] = [];
  for (const position of POSITIONS) {
    const able = picks
      .map((p) => data.bySlug.get(p.slug))
      .filter((h): h is Hero => Boolean(h) && canPlay(h!, position, settings.minRoleFit));
    if (able.length === 1 && picks.length >= POSITIONS.length) {
      out.push({ position, name: able[0]!.name, fit: positionFit(able[0], position) });
    }
  }
  return out;
}

/** The heroes whose position differs between two bookings of the same five. */
function movesBetween(data: Dataset, from: DraftPick[], to: DraftPick[]): RoleMove[] {
  const was = new Map(from.map((p) => [p.slug, p.position]));
  const moves: RoleMove[] = [];

  for (const pick of to) {
    if (!pick.position) continue;
    const before = was.get(pick.slug) ?? null;
    if (before === pick.position) continue;
    const hero = data.bySlug.get(pick.slug);
    moves.push({
      slug: pick.slug,
      name: hero?.name ?? pick.slug,
      from: before,
      to: pick.position,
      fit: positionFit(hero, pick.position),
    });
  }

  // Read top-down as a set of instructions, so the hero going to the earliest
  // position is named first.
  moves.sort((a, b) => a.to - b.to);
  return moves;
}

/*
 * `laneOccupancy`, `PLAN_SENSITIVE` and `couldMoveLosingLanes` used to live
 * here: an exact rule for deciding, without touching the dataset, whether an
 * arrangement could possibly have moved a lane we were losing. It existed
 * because a lane read was something the search bought *extra*, on top of
 * scoring, and buying two per candidate on every keystroke was not affordable.
 *
 * The lane read is now part of the score — see `ArrangementScore.lanes` — so
 * every arrangement has one whether or not anything is losing, and there is
 * nothing left to avoid. Predicting the answer to a question already answered
 * is not an optimisation; it is a second implementation of the lane read, kept
 * in step by hand, that can only ever be wrong.
 */

/**
 * Which lanes an arrangement actually moves, and by how much.
 *
 * The gain is one number and it is the wrong shape for the decision: "+1.4"
 * does not tell a captain that the reason is their mid no longer stands in
 * front of the hero who answers him.
 */
function shiftsBetween(
  before: Map<ContestedLane, LaneScoreboardEntry>,
  after: Map<ContestedLane, LaneScoreboardEntry>,
): LaneShift[] {
  const shifts: LaneShift[] = [];
  for (const [key, lane] of after) {
    const was = before.get(key);
    // A front nobody contests has no read to move, on either board.
    if (!was || !was.contested || !lane.contested) continue;
    const delta = lane.score - was.score;
    if (Math.abs(delta) < NOISE) continue;
    shifts.push({
      key,
      label: lane.label,
      short: LANE_SHORT[key],
      before: was.score,
      after: lane.score,
      delta,
    });
  }

  // Biggest swing first, whichever way it points: an arrangement that wins the
  // draft by 1.4 while handing away a lane has to say so.
  shifts.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  return shifts;
}

/**
 * The losing lane an arrangement rescues, if it rescues one.
 *
 * Three conditions, and each is there to stop a different kind of nonsense: the
 * lane has to have been losing past the noise floor (rescuing a lane that was
 * fine is not a rescue), it has to improve past the noise floor (a tenth of a
 * point is not a fix), and it must not simply be handing the deficit to another
 * lane — so the largest swing in the whole arrangement has to be this one.
 */
function repairedLane(shifts: LaneShift[]): LaneShift | null {
  const best = shifts[0];
  if (!best || best.delta < NOISE) return null;
  return best.before <= -NOISE ? best : null;
}

// ----------------------------------------------------------------- ranking

/**
 * The trade-off curve between upheaval and reward.
 *
 * Ranking on reward alone is useless here, and the shape of the uselessness is
 * specific: the biggest number is almost always a four- or five-way shuffle, and
 * a captain offered only that will take none of them. What they can act on is
 * the two most common moves in Dota — trade the carry and the mid, or just walk
 * the duos the other way — sitting next to the big one with the price of each
 * visible.
 *
 * So: best arrangement of each size, then drop every size that is not actually
 * worth its extra moves. What comes back is strictly increasing in both size and
 * reward, which is what "trade-off" means and what the old code was reaching for
 * when it took the top N by gain and then overwrote the last slot with the
 * cheapest entry — a patch that could silently discard a better option and leave
 * the list out of order.
 */
function tradeOffCurve<T extends { size: number }>(from: T[], reward: (item: T) => number): T[] {
  const bestOfSize = new Map<number, T>();
  for (const item of from) {
    const held = bestOfSize.get(item.size);
    if (!held || reward(item) > reward(held)) bestOfSize.set(item.size, item);
  }

  const curve: T[] = [];
  let ceiling = -Infinity;
  for (const item of [...bestOfSize.values()].sort((a, b) => a.size - b.size)) {
    // A cheaper arrangement already does at least this well, so paying for the
    // extra moves buys nothing.
    if (reward(item) <= ceiling) continue;
    curve.push(item);
    ceiling = reward(item);
  }
  return curve;
}

/**
 * Thin a curve to `limit` entries without losing either end.
 *
 * Both ends are load-bearing — the cheapest thing that helps and the most it can
 * be worth — so anything dropped comes out of the middle, weakest first.
 */
function alongCurve<T extends { size: number }>(
  curve: T[],
  reward: (item: T) => number,
  limit: number,
): T[] {
  if (limit <= 0) return [];
  if (curve.length <= limit) return curve;
  if (limit === 1) return [curve[curve.length - 1]!];

  const middle = curve
    .slice(1, -1)
    .sort((a, b) => reward(b) - reward(a))
    .slice(0, limit - 2);
  return [curve[0]!, ...middle, curve[curve.length - 1]!];
}

const byTotal = (option: RebalanceOption) => option.gain.total;
const byRepair = (option: RebalanceOption) => option.repairedLane?.delta ?? 0;

/** Curve, thinned, then ordered for reading: biggest reward first. */
function shortlist(
  from: RebalanceOption[],
  reward: (option: RebalanceOption) => number,
  limit: number,
): RebalanceOption[] {
  return alongCurve(tradeOffCurve(from, reward), reward, limit).sort(
    (a, b) => reward(b) - reward(a) || a.size - b.size,
  );
}

// ------------------------------------------------------------------ report

/**
 * Rearrangements of my own line-up worth more than the one on the board.
 *
 * Null when the question does not arise — see `rebalanceReadiness`, which is the
 * same test, cheap, and callable by anyone who needs to explain the absence
 * rather than just handle it.
 */
export function rebalance(
  data: Dataset,
  draft: DraftView,
  settings: Settings,
  limit = MAX_OPTIONS,
): RebalanceReport | null {
  if (!rebalanceReadiness(draft).ready) return null;

  const plan = draft.lanePlan ?? "standard";
  const board = readArrangement(data, draft, settings, { picks: draft.mine, lanePlan: plan });
  const current = board.score;
  const currentLanes = board.board;
  /**
   * The qualifying floor, in the units `total` is in: a point of win chance
   * when calibrated, the app's half-point noise floor on the comparison signal
   * otherwise.
   */
  const floor = current.chance !== null ? CHANCE_GAIN : NOISE;
  /**
   * And the most a seat repair may cost, in the same units. Chosen the same way
   * as `floor` and for the same reason: a limit set on one scale and read on the
   * other is a different rule, not the same one.
   */
  const seatCeiling = current.chance !== null ? MAX_SEAT_CHANCE_COST : MAX_SEAT_COST;
  const verdictOf = (score: ArrangementScore) =>
    score.chance !== null ? verdictForChance(score.chance / 100).label : verdictFor(score.advantage).label;
  const oneMoveAway = new Set(
    [...neighbours(draft.mine, plan)].map((arrangement) => arrangementId(arrangement)),
  );
  // The check the panel applied to every arrangement it considered and never to
  // the one it was looking at.
  const boardOffRole = offRoleSeats(data, draft.mine, settings);
  const stranded = new Set(boardOffRole.map((seat) => seat.slug));

  const losing = [...currentLanes.values()]
    .filter((lane) => lane.contested && lane.score <= -NOISE)
    .sort((a, b) => a.score - b.score);

  const candidates: RebalanceOption[] = [];
  const counts: SearchCounts = { seatings: 0, legalSeatings: 0, arrangements: 0, laneReads: 0 };

  for (const picks of placements(draft.mine)) {
    counts.seatings++;
    const offRoleHere = offRoleSeats(data, picks, settings);
    const legal = offRoleHere.length === 0;
    if (legal) counts.legalSeatings++;
    // Which of the board's stranded heroes this seating rescues. Named rather
    // than counted: "fewer off-role heroes" can also mean it stranded somebody
    // else instead, and the panel has to be able to say whose problem it fixed.
    const stillStranded = new Set(offRoleHere.map((seat) => seat.slug));
    const repairedSeats = boardOffRole.filter((seat) => !stillStranded.has(seat.slug));
    const strandsAnyoneNew = offRoleHere.some((seat) => !stranded.has(seat.slug));

    for (const lanePlan of PLANS) {
      const planChanged = lanePlan !== plan;
      if (!planChanged && samePlacement(draft.mine, picks)) continue;
      counts.arrangements++;
      counts.laneReads++;

      const read = readArrangement(data, draft, settings, { picks, lanePlan });
      const score = read.score;
      const gain: Gain = {
        advantage: score.advantage - current.advantage,
        fit: score.fit - current.fit,
        lanes: score.lanes - current.lanes,
        chance: score.chance !== null && current.chance !== null ? score.chance - current.chance : null,
        parts:
          score.parts && current.parts
            ? (Object.fromEntries(
                WIN_GROUPS.map((group) => [group, score.parts![group] - current.parts![group]]),
              ) as Record<WinGroup, number>)
            : null,
        total: score.total - current.total,
      };

      /**
       * A seat repair is the one thing here allowed to cost score, so it is
       * decided before the floor that would otherwise throw it away: it has to
       * free somebody the board had stranded, must not strand anybody who was
       * fine, and may not spend more than the stretch it is undoing was priced
       * at. See `MAX_SEAT_COST` and `MAX_SEAT_CHANCE_COST`.
       */
      const fixesSeats =
        repairedSeats.length > 0 && !strandsAnyoneNew && gain.total > -seatCeiling;

      /**
       * Below this the arrangement is not merely unhelpful, it is a loss, and
       * no lane it happens to improve is worth taking one for. Above `NOISE` it
       * qualifies outright. In between is the band the lane rule exists for.
       */
      if (gain.total <= -floor && !fixesSeats) continue;
      const qualifies = gain.total >= floor;

      // Free now: the scoreboard behind these shifts is the one the arrangement
      // was scored from, so the figure and its explanation cannot disagree.
      const laneShifts = shiftsBetween(currentLanes, read.board);
      const repaired = repairedLane(laneShifts);

      // Nothing worth saying about the board figure, nothing worth saying about
      // a seat, and no losing lane rescued.
      if (!qualifies && !fixesSeats && !repaired) continue;

      const moves = movesBetween(data, draft.mine, picks);
      const swapsLanes = planChanged;
      // Only the heroes who move: a hero already sitting off-role is the
      // board's problem, not this arrangement's, and naming them here would
      // flag every option on a draft with one awkward pick.
      const stretched = [...moves].sort((a, b) => a.fit - b.fit)[0];

      candidates.push({
        id: arrangementId({ picks, lanePlan }),
        picks,
        lanePlan,
        score,
        gain,
        /**
         * A repair the reader can act on beats a figure they cannot see. An
         * arrangement that both scores better *and* puts the carry back is filed
         * under the seat it fixes, because that is the sentence that gets it
         * applied — the gain is printed either way.
         */
        reason: fixesSeats ? "seat" : qualifies ? "score" : "lane",
        // Only on the rows that are on the list *for* the lane. A score option
        // that happens to rescue one leads with its own figure, and the lane is
        // then part of the supporting line rather than the headline — hiding it
        // there would drop the reason the figure is what it is.
        repairedLane: !fixesSeats && !qualifies ? repaired : null,
        repairedSeats,
        offRole: offRoleHere.length,
        moves,
        swapsLanes,
        size: moves.length + (swapsLanes ? 1 : 0),
        laneShifts: laneShifts.slice(0, 3),
        verdict: verdictOf(score),
        stretch: stretched
          ? { name: stretched.name, position: stretched.to, fit: stretched.fit }
          : null,
        legal,
      });
    }
  }

  /**
   * Ranked legal-first rather than on the figure alone.
   *
   * The gain is the reason to read a row; whether somebody can actually play the
   * seat decides whether it is advice. A half-point better trade that needs the
   * position-4 hero to carry belongs under the ones that need nothing, not above
   * them, and it stays on the list because a captain who knows the player is a
   * better judge of that than the share of games Dotabuff scraped.
   */
  const swaps = candidates
    .filter((c) => oneMoveAway.has(c.id) && (c.gain.total >= floor || c.reason === "seat"))
    .sort(
      (a, b) =>
        // A trade that puts a stranded hero back leads, whatever it costs — it
        // is the only kind of row here the reader cannot work out for themselves
        // from the figure.
        b.repairedSeats.length - a.repairedSeats.length ||
        Number(b.legal) - Number(a.legal) ||
        b.gain.total - a.gain.total,
    );

  /**
   * Ranked by how much of the board's problem each one removes, then by what it
   * costs to do it. Not by the score: every entry here exists because the score
   * was the wrong question — the board is on a seat the app itself would refuse
   * to suggest, and the cheapest way out of that is worth more than a tenth of a
   * point in either direction.
   */
  const seatFixes = shortlist(
    candidates.filter((c) => c.reason === "seat"),
    (option) => option.repairedSeats.length * 100 + option.gain.total,
    MAX_OPTIONS,
  );

  const legalOnes = candidates.filter((c) => c.legal);
  const scoring = legalOnes.filter((c) => c.reason === "score");
  const repairing = legalOnes.filter((c) => c.reason === "lane");
  const blocked = candidates.filter((c) => !c.legal);

  const options = shortlist(scoring, byTotal, limit);
  const laneFixes = shortlist(repairing, byRepair, MAX_ASIDES);

  /**
   * The threshold aside carries both kinds, each ranked in its own units — a
   * repair the threshold is hiding is exactly the "your mid is being run over
   * and the only fix is off-role" case this list was added for, and it would
   * never survive a ranking on the board figure, which is near zero by
   * construction.
   */
  const beyondThreshold = [
    ...shortlist(
      blocked.filter((c) => c.reason === "score"),
      byTotal,
      MAX_ASIDES,
    ),
    ...shortlist(
      blocked.filter((c) => c.reason === "lane"),
      byRepair,
      MAX_ASIDES,
    ),
  ].slice(0, MAX_ASIDES);

  return {
    current,
    currentVerdict: verdictOf(current),
    losing,
    offRole: boardOffRole,
    seatFixes,
    swaps,
    options,
    laneFixes,
    beyondThreshold,
    /**
     * A board with a hero in a seat they do not play has one thing wrong with it
     * worth interrupting somebody for, and it is not the third decimal of the
     * draft figure.
     */
    best: seatFixes[0] ?? options[0] ?? laneFixes[0] ?? null,
    counts,
    forced: forcedSeats(data, draft.mine, settings),
    // One legal seating means the role threshold pinned every hero where they
    // are; the only thing ever on the table was the lane plan.
    pinned: counts.legalSeatings <= 1,
    threshold: floor,
    minRoleFit: settings.minRoleFit,
  };
}
