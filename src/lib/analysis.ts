import { lanePair } from "./lanes";
import { buildBriefing } from "./draftInsights";
import { atRankBand } from "./positions";
import { POSITION_LABEL, laneForPosition, laneOpponents, positionFit } from "./roles";
import { NOISE, draftBalance, matchup, sharesLane, synergy } from "./scoring";
import { rolesReason, winRead } from "./winModel";
import type { WinGroup, WinRead } from "./winModel";
import {
  TARGET_EARLY_COVER,
  earlyCoverPenalty,
  exposure,
  teamCover,
  weightedEdge,
} from "./timing";
import type { DraftView } from "./scoring";
import type {
  Dataset,
  DraftImpact,
  DraftPick,
  Hero,
  Lane,
  LanePlan,
  Position,
  Settings,
} from "../types";

/**
 * The full read-out behind the headline draft number.
 *
 * The badge in the top bar answers "am I ahead?" with one figure, which is the
 * right size for a glance and useless for a decision: a draft that wins mid by
 * four and loses the safe lane by five nets out to roughly zero and looks like
 * a coin flip. Everything here exists to take that single number apart again —
 * by lane, by hero, and down to the individual pairings that moved it.
 *
 * It is all a re-cut of the same arithmetic `scoring.ts` already does, never a
 * second implementation of it: every pair below comes from `matchup`/`synergy`
 * under the same thresholds and the same lane weighting `draftBalance` uses, so
 * the parts always add back up to the headline.
 */

/** The three lane fronts, plus the pairings that never meet in a lane. */
export type LaneKey = "safe" | "mid" | "off" | "map";

/**
 * The app's one noise floor, defined next to the pairings it judges. Re-exported
 * here because this panel is where most of it is read, and every existing caller
 * asks `analysis` for it.
 */
export { NOISE };

/** One hero on the board, resolved for display. */
export interface LineupSlot {
  slug: string;
  name: string;
  position: Position | null;
}

/**
 * A single head-to-head pairing, always read from my side.
 *
 * `sameLane` and `lane` say where the two heroes would stand. They do not make
 * `advantage` a lane number — it is measured over whole games in which the two
 * were on opposite sides, and it carries every minute of those games, not the
 * first ten. Grouping by lane decides which figures are put in front of you; it
 * does not change what any of them measured.
 */
export interface PairEdge {
  mine: LineupSlot;
  theirs: LineupSlot;
  /** Percentage points; positive = my hero is favoured. */
  advantage: number;
  matches: number;
  /** How far apart Dotabuff's two readings of this pairing were. */
  spread: number;
  sameLane: boolean;
  lane: LaneKey;
}

/**
 * A reason a lane reads the way it does, in words.
 *
 * The number alone ("safe lane −2.4") tells a captain nothing they can act on.
 * These are the three things that actually move it: a specific losing pairing,
 * a hero whose own record in that lane is poor before any matchup is
 * considered, and a hero standing somewhere they almost never stand.
 */
export interface LaneNote {
  kind: "laning" | "pair" | "off-role" | "split" | "unmeasured";
  text: string;
  /** Signed, for colour; null when the note is not about a swing. */
  value: number | null;
}

/**
 * STRATZ's read of one lane's laning stage: how much of it each side should
 * take, and what the pairings standing in it are worth in games.
 */
export interface LaneOutcome {
  /** My side's expected share of the laning stage, in points either side of 50. */
  result: number;
  /**
   * The pairings' own lane effects converted to win-rate points of the game,
   * from my side. The only part of the laning read that enters `score`: a
   * hero's general lane strength does not show up in game results, the
   * specific pairing does. See docs/scoring.md, "Lane outcomes".
   */
  gameEdge: number;
  /**
   * Cross pairings whose own lanes are on record, out of those standing here.
   * Only these feed `gameEdge`: a pairing with no lanes of its own has an
   * expected result but no evidence about itself, and its zero is not a reading.
   */
  covered: number;
  possible: number;
  /** The pairing furthest from even, from my side. */
  widest: { mine: LineupSlot; theirs: LineupSlot; result: number; lanes: number } | null;
}

/** One side's record from the lane it is standing in. */
export interface LaneForm {
  /** Mean win rate from this lane, in points either side of 50. */
  value: number;
  /** Heroes the figure is built from, and how many were asked for. */
  covered: number;
  possible: number;
  /** The hero dragging it down, when one clearly is. */
  worst: { name: string; value: number } | null;
}

export interface LaneReport {
  key: LaneKey;
  label: string;
  /** Positions of mine that stand here, and theirs that contest it. */
  mine: LineupSlot[];
  theirs: LineupSlot[];
  /**
   * The lane read: what this lane is worth in games, in win-rate points.
   * `outcome` says who takes the laning stage itself.
   *
   * This is the headline, and it is deliberately *not* `advantage`. The panel
   * used to lead with the mean of the whole-game matchup figures, which is the
   * one reading in this card that was never taken from a lane — so a safe lane
   * could print "+0.1" in green while the two heroes standing in it were two
   * points worse from that lane than the two opposite, and every other number
   * in the card agreed they were losing it.
   *
   * So the four readings are blended instead, weighted by how much each of
   * them is actually about a lane: the pairings' laning worth and the side's
   * record from this lane first (`LANE_WEIGHTS`), the 2v2 chemistry next, the
   * whole-game head-to-head last. `advantage` is still carried below,
   * unchanged, as one of the inputs.
   */
  score: number;
  /**
   * True when a lane-measured reading fed `score` — laning, form, duo, or any
   * of them.
   *
   * False means the score is the matchup mean under another name, which is all
   * there is for the map front and for any lane the scrape has no rows for.
   */
  measured: boolean;
  /**
   * Mean advantage over the pairings we have data for, from my side.
   *
   * Read this as "how the whole-game matchups between these four heroes fall",
   * because that is what it is. It is not a prediction of who wins the lane —
   * `outcome` is — and it can disagree with `formEdge`, which is measured on
   * games played from the lane. When those two split, `notes` says so.
   */
  advantage: number;
  pairs: PairEdge[];
  /**
   * Chemistry between the two heroes standing together on each side.
   *
   * The cohesion card ranks a team's pairings by value and shows the best of
   * them, which is the right list for "who works with whom" and the wrong one
   * for "how does this lane go" — the duo that actually shares a lane only
   * appears there if its number happens to be large. This is that duo,
   * whatever it is worth.
   */
  myDuo: SynergyPair | null;
  theirDuo: SynergyPair | null;
  /**
   * Our duo minus theirs — the 2v2 half of the read.
   *
   * Null unless both pairs cleared the sample floor, because a difference needs
   * two halves. Much smaller in magnitude than a matchup figure: a full point
   * of synergy is around the 99th percentile of the table, so this term nudges
   * the lane score rather than deciding it.
   */
  duoEdge: number | null;
  /**
   * Who takes the laning stage here, from STRATZ's lane outcomes. Null without
   * lanes.json, or when neither side has a lane record at the seats booked.
   */
  outcome: LaneOutcome | null;
  /**
   * How the heroes standing here do *from this lane*, in percentage points
   * either side of 50, averaged over the side.
   *
   * A game figure measured on games played from this lane: it catches a hero
   * whose games go badly from a lane, whatever the head-to-head says. It is not
   * a reading of the laning stage — across heroes it barely correlates with
   * who actually wins their lane — and it says nothing about who they face.
   */
  myForm: LaneForm | null;
  theirForm: LaneForm | null;
  /**
   * My side's lane record minus theirs, in games won from this lane.
   *
   * Null unless both sides have a figure. It says nothing about who faces whom,
   * so it is not a replacement for `advantage`; it is a different half of the
   * read, taken from games played in the lane being asked about.
   */
  formEdge: number | null;
  /** Why it reads that way, worst first. */
  notes: LaneNote[];
  /** Both sides have someone booked here. */
  contested: boolean;
  /** Pairings on the board vs. pairings Dotabuff had a usable sample for. */
  possible: number;
  covered: number;
  /**
   * What this front is actually worth, in the units the picker weighs pairings
   * in. Only the map row needs it — the three real lanes are read off `score`,
   * which is a lane reading and not a share of anything.
   *
   * It exists because the card used to *assert* the answer in prose: "they
   * count once each in the headline where lane pairings count twice, which on
   * a full board is still most of its weight". Every clause of that was wrong
   * in a different way. Lane pairings count `1 + laneWeight` times and the
   * slider runs to 4, so "twice" was one setting out of many. "Most of its
   * weight" is false at the default: 16 units against 9 lane pairings at
   * double is 16 of 34, a minority — it is only "most" below a lane weight of
   * about 0.78. And none of it was ever weight in *the headline*: these are
   * shares of the head-to-head term, which the headline then adds synergy and
   * timing to. On the draft that prompted this, the map front was 47% of the
   * matchup term and under 10% of the headline.
   *
   * So the numbers are computed from `settings` and printed, rather than
   * described from memory.
   */
  weight: LaneWeightShare | null;
}

/** The map row's share of the head-to-head term, in weight units. */
export interface LaneWeightShare {
  /** Units these pairings carry — one each, since none of them share a lane. */
  own: number;
  /** Units behind the whole matchup term, both fronts and map together. */
  total: number;
  /** What one lane pairing is worth next to one of these: `1 + laneWeight`. */
  laneMultiple: number;
}

/** What one of my heroes is worth in this specific draft. */
export interface HeroReport {
  hero: Hero;
  position: Position | null;
  /** Lane-weighted mean advantage against their five. */
  matchup: number;
  /** Mean synergy with my other four. */
  synergy: number;
  /** The two together, weighted the way the draft score weights them. */
  total: number;
  /** How many of their five we had matchup data against. */
  covered: number;
  /**
   * The pairings worth naming — null unless the edge clears `NOISE`.
   *
   * Taking the ends of a sorted list unconditionally is how the panel came to
   * say "Axe struggles into Lich" about a −0.1 matchup: something is always
   * last, even when a hero has no bad game at all. A hero whose worst pairing
   * is noise does not have a problem hero, and the read-out should say nothing
   * rather than manufacture one.
   */
  best: PairEdge | null;
  worst: PairEdge | null;
}

/** A pairing inside one team. */
export interface SynergyPair {
  a: LineupSlot;
  b: LineupSlot;
  synergy: number;
  matches: number;
}

/** How the two line-ups compare in one length-of-game window. */
export interface StageReport {
  key: string;
  label: string;
  short: string;
  /** Mean skew of my five in this window, in percentage points. */
  mine: number;
  theirs: number;
  /** Mine minus theirs: who owns this part of the game. */
  edge: number;
  /** Heroes on each side we actually had timing data for. */
  covered: number;
  theirCovered: number;
}

/** The whole game-length read, or null when timings.json has not been built. */
export interface StageRead {
  buckets: StageReport[];
  /** Where my draft is at its best and worst relative to theirs. */
  best: StageReport | null;
  worst: StageReport | null;
  /** One line a captain can say out loud. */
  summary: string;
  /** The heroes pulling my curve each way, for the "why". */
  mostLate: { name: string; skew: number } | null;
  mostEarly: { name: string; skew: number } | null;

  /**
   * Share of games that end in each window — the fact the card was missing.
   *
   * Without it every figure above is read as though the four windows were
   * equally likely to be the one that decides the game, and they are not: in
   * the live sample 2% of games finish before 25 minutes and 41% between 35
   * and 45. A draft that is enormous in the last window and poor in the first
   * looked balanced and was not.
   */
  shares: number[] | null;
  /**
   * The window edges weighted by those shares. The honest one-number answer to
   * "is our timing an advantage", and routinely a different sign from the mean
   * of the four the card prints.
   */
  weightedEdge: number | null;
  /**
   * Share of games that are over before my draft is ahead — scanning the
   * windows in order and stopping at the first that clears the noise floor.
   *
   * The figure that answers the complaint this whole read exists for: a
   * line-up whose edge only arrives after 45 minutes has to get through
   * two-thirds of the distribution first, and nothing else in the panel says
   * so. 1 means no window is ever clearly ours.
   */
  exposure: number | null;
  /**
   * Bodies on each side that function before the median game length, out of
   * five, with undrafted slots valued at the pool average.
   *
   * Counted rather than averaged, and that is the whole point of it: five
   * heroes at −3 and one at −15 beside four at zero have the same mean early
   * skew and are not the same draft, because the second can still contest two
   * lanes. The mean cannot see the difference and this can.
   */
  cover: number | null;
  theirCover: number | null;
  /** Points the shortfall costs each side, already in the headline figure. */
  penalty: number;
  theirPenalty: number;
  /** How many of the windows count as "before the median game". */
  earlyWindows: number;
}

export interface DraftVerdict {
  /** "Coin flip", "Slight edge to you", … */
  label: string;
  /** Which side the number favours, for colouring. */
  side: "mine" | "enemy" | "even";
  /** 0..4 — how far from even, for the strength of that colour. */
  strength: number;
}

/**
 * The win chance, with each part's reason in words.
 *
 * The model says how much each part moves the chance; this says *why*, from the
 * same board — the pairing behind the matchups, the pair behind the cohesion,
 * the hero behind the strength, the seats behind the roles.
 */
export interface DraftWin extends WinRead {
  reasons: Record<WinGroup, string | null>;
}

export interface DraftAnalysis {
  lineups: { mine: LineupSlot[]; enemy: LineupSlot[] };
  /**
   * The headline: the board as a calibrated win chance, from
   * public/data/calibration.json. Null without that file, and every consumer
   * then shows `advantage` and `verdict` as before. See docs/scoring.md,
   * "Win chance".
   */
  win: DraftWin | null;
  /** The weighted cohesion contribution, so displayed terms add to the total. */
  cohesionContribution: number;
  /** The headline figure and its two halves, straight from `draftBalance`. */
  advantage: number;
  counter: number;
  synergyEdge: number;
  mySynergy: number;
  theirSynergy: number;
  /**
   * The third part of the headline: their early-game shortfall minus mine.
   *
   * Kept beside `counter` and `synergyEdge` rather than folded into either,
   * because it is the only one that can move the verdict without a single
   * pairing on the board changing — and a reader who sees the number swing
   * after a pick that counters nothing deserves to be told which term did it.
   */
  earlyEdge: number;
  verdict: DraftVerdict;
  /**
   * There is deliberately no win probability here.
   *
   * The panel used to print `50 + advantage` as "≈49.7% expected win rate",
   * and it was the least defensible number on the screen. `advantage` is the
   * *mean* of up to 25 pairwise deltas plus the mean synergy delta, and a mean
   * of marginal effects is not the combined effect of all of them: if you
   * believed they were additive you would sum, not average. Averaging also
   * drags the figure towards zero as more heroes go on the board, so the number
   * got calmer the more complete the draft became — backwards. Printed to one
   * decimal it promised a precision that 25 noisy scraped figures cannot
   * support, and it is why a draft that lost badly could be read out as a coin
   * flip. `advantage` is an ordering signal between drafts, not a probability,
   * and it is now presented as one.
   */
  /** Both sides have all five in. */
  complete: boolean;
  /**
   * How many heroes are actually on each side.
   *
   * Every "x of y" in the panel needs this, and mid-draft it is not five. The
   * timing card used to hard-code a denominator of 5 and the per-hero rows had
   * no denominator at all, which is how a figure covering two of their heroes
   * could be shown with the same confidence as one covering all five.
   */
  sides: { mine: number; enemy: number };
  /** Every position on both sides has a hero booked, so the lane split is real. */
  lanesResolved: boolean;
  /**
   * The deployment every lane figure below was read under.
   *
   * Carried rather than assumed because the lane rows change meaning with it —
   * "Safe lane +2.1" is a claim about two different sets of four heroes under
   * the two plans, and a reader arriving at the panel has no other way to know
   * which one they are looking at.
   */
  lanePlan: LanePlan;

  lanes: LaneReport[];
  /** My five, best contributor first. */
  heroes: HeroReport[];
  /** Pairings that hurt me most, worst first. */
  threats: PairEdge[];
  /** Pairings I win hardest, best first. */
  edges: PairEdge[];
  mySynergyPairs: SynergyPair[];
  theirSynergyPairs: SynergyPair[];
  /** Null until `npm run timings` has been run. */
  stages: StageRead | null;

  coverage: {
    /** Head-to-head pairings with a usable sample, out of those on the board. */
    matchups: number;
    matchupsPossible: number;
    /** Same for same-team pairings, across both teams. */
    synergies: number;
    synergiesPossible: number;
  };
}

/**
 * The three fronts are keyed by *my* duo, not by geography — `safe` is wherever
 * my 1 and 5 are standing. Under a swap that is the enemy's safe lane, so the
 * labels say so rather than printing "Safe lane" over a card whose four heroes
 * are two carries and two supports.
 *
 * The swapped pair name both sides on purpose. "Safe duos (swapped)" read to
 * everyone who saw it as a claim about *my* safe lane, which made the enemy
 * carry standing in it look like a seating bug rather than the consequence of
 * my duo having walked over there. Naming the meeting instead of the ground —
 * safe against safe — is the shortest thing that cannot be misread.
 */
const LANE_LABEL: Record<LanePlan, Record<LaneKey, string>> = {
  standard: {
    safe: "Safe lane",
    mid: "Mid",
    off: "Off lane",
    map: "Across the map",
  },
  swapped: {
    safe: "Safe vs safe (swapped)",
    mid: "Mid",
    off: "Off vs off (swapped)",
    map: "Across the map",
  },
};

/** My positions on each front, and the enemy positions that contest it. */
const LANE_SIDES: Record<
  LanePlan,
  Record<Exclude<LaneKey, "map">, { mine: Position[]; theirs: Position[] }>
> = {
  standard: {
    safe: { mine: [1, 5], theirs: [3, 4] },
    mid: { mine: [2], theirs: [2] },
    off: { mine: [3, 4], theirs: [1, 5] },
  },
  swapped: {
    safe: { mine: [1, 5], theirs: [1, 5] },
    mid: { mine: [2], theirs: [2] },
    off: { mine: [3, 4], theirs: [3, 4] },
  },
};

/**
 * Which front a pairing belongs to, from my hero's seat.
 *
 * Derived from `laneOpponents` rather than restated, so the two can never drift
 * apart: a pairing is on a front only if the game would actually stand them
 * next to each other, under the deployment the board is actually on.
 */
function laneOf(
  mine: Position | null,
  theirs: Position | null,
  plan: LanePlan = "standard",
): LaneKey {
  if (!mine || !theirs || !laneOpponents(plan)[mine].includes(theirs)) return "map";
  if (mine === 2) return "mid";
  return mine === 1 || mine === 5 ? "safe" : "off";
}

const slot = (data: Dataset, pick: DraftPick): LineupSlot => ({
  slug: pick.slug,
  name: data.bySlug.get(pick.slug)?.name ?? pick.slug,
  position: pick.position,
});

/**
 * A plain-language read of the headline number.
 *
 * The bands are deliberately wide at the bottom. Half a point of win rate is
 * inside the noise of the data these numbers come from, and a picker that calls
 * that "an advantage" trains you to trust it in exactly the spot where it is
 * worth nothing.
 */
export function verdictFor(advantage: number): DraftVerdict {
  const size = Math.abs(advantage);
  const mine = advantage >= 0;
  const who = mine ? "you" : "them";
  if (size < 0.5) return { label: "Coin flip", side: "even", strength: 0 };

  const side = mine ? "mine" : "enemy";
  if (size < 1.5) return { label: `Slight edge to ${who}`, side, strength: 1 };
  if (size < 3) return { label: mine ? "You are favoured" : "They are favoured", side, strength: 2 };
  if (size < 5) return { label: mine ? "You are well ahead" : "They are well ahead", side, strength: 3 };
  return { label: mine ? "Dominant draft" : "You are being run over", side, strength: 4 };
}

/**
 * Every my-hero × their-hero pairing we have a usable sample for, with the
 * denominator kept per front as well as overall.
 *
 * The per-lane count has to be tallied here rather than reconstructed later as
 * `mine.length * theirs.length`, because that expression cannot see the
 * pairings that belong to no front at all — which is how "Across the map" ended
 * up reporting itself as fully covered by definition, `possible` set equal to
 * `covered` and no way for a gap to show.
 */
function crossPairs(data: Dataset, draft: DraftView, settings: Settings) {
  const pairs: PairEdge[] = [];
  const possibleByLane = new Map<LaneKey, number>();
  const plan = draft.lanePlan ?? "standard";
  let possible = 0;

  for (const a of draft.mine) {
    for (const b of draft.enemy) {
      possible++;
      const lane = laneOf(a.position, b.position, plan);
      possibleByLane.set(lane, (possibleByLane.get(lane) ?? 0) + 1);

      const m = matchup(data, a.slug, b.slug);
      if (!m || m.matches < settings.minMatches) continue;
      pairs.push({
        mine: slot(data, a),
        theirs: slot(data, b),
        advantage: m.advantage,
        matches: m.matches,
        spread: m.spread,
        sameLane: sharesLane(a.position, b.position, plan),
        lane,
      });
    }
  }
  return { pairs, possible, possibleByLane };
}

/**
 * Same-team pairings, best first.
 *
 * Asked with positions and with the sample floor, exactly as `teamSynergy`
 * inside `draftBalance` asks. The two used to differ — this list read the
 * blended figure while the headline read the core/support cell — so the
 * cohesion card could list pairings that did not average to the average printed
 * at the top of the same card. They agreed only by accident, because no pairing
 * in the current synergies.json carries cells at all; rebuilding that file with
 * them would have split the card from its own headline silently.
 */
function teamPairs(data: Dataset, team: DraftPick[], settings: Settings) {
  const pairs: SynergyPair[] = [];
  let possible = 0;

  for (let i = 0; i < team.length; i++) {
    for (let j = i + 1; j < team.length; j++) {
      const [a, b] = [team[i], team[j]];
      if (!a || !b) continue;
      possible++;
      const s = synergy(
        data,
        a.slug,
        b.slug,
        a.position,
        b.position,
        settings.minSynergyMatches,
      );
      if (!s || s.matches < settings.minSynergyMatches) continue;
      pairs.push({ a: slot(data, a), b: slot(data, b), synergy: s.synergy, matches: s.matches });
    }
  }
  pairs.sort((x, y) => y.synergy - x.synergy);
  return { pairs, possible };
}

/**
 * Below this share of games, a hero is somewhere they do not normally go — and
 * that is worth saying before the lane is blamed on the matchup.
 */
const OFF_ROLE_SHARE = 0.15;

/**
 * Points of laning-stage share either side of 50 before the card says who
 * takes the lane. Three points is a 53–47 lane: small enough to be common,
 * large enough that the side behind has to plan for it.
 */
const LANING_NOTE = 3;

/**
 * The bar for a lost laning stage to make the captain's short list: a 55–45
 * lane. The card notes anything past `LANING_NOTE`; the talking points are for
 * lanes the other four have to change their plan for.
 */
const LANING_TALK = 5;

/**
 * Points of win chance the seats have to cost before the roles lead the talking
 * points: the size of a lost laning stage, and a line the other four have to
 * change their plan for.
 */
const ROLES_TALK = 5;

/**
 * Why a lane reads the way it does, worst first.
 *
 * Five sources, in the order a captain would want them: the two readings of the
 * lane disagreeing with each other, the lane having no lane-measured reading at
 * all, the pairing that is actually losing, and a hero on either side playing a
 * position they almost never play.
 */
function laneNotes(args: {
  data: Dataset;
  mine: DraftPick[];
  theirs: DraftPick[];
  pairs: PairEdge[];
  advantage: number;
  outcome: LaneOutcome | null;
  formEdge: number | null;
  /** True when form or duo fed the lane score — see `laneScore`. */
  measured: boolean;
  myForm: LaneForm | null;
  theirForm: LaneForm | null;
  contested: boolean;
}): LaneNote[] {
  const { data, mine, theirs, pairs, advantage, outcome, formEdge, measured, myForm, theirForm, contested } =
    args;
  const notes: LaneNote[] = [];

  /**
   * Who takes the laning stage, said outright when it is lopsided enough to
   * plan around. The one statement in the card about the first ten minutes
   * that was measured on the first ten minutes.
   */
  if (outcome && Math.abs(outcome.result) >= LANING_NOTE) {
    const w = outcome.widest;
    const share = (x: number) => `${Math.round(50 + x)}%`;
    notes.push({
      kind: "laning",
      text:
        `${outcome.result > 0 ? "We win" : "We lose"} the laning stage here — about ` +
        `${share(outcome.result)} of it is ours` +
        (w && Math.abs(w.result) >= LANING_NOTE
          ? `; ${w.mine.name} takes ${share(w.result)} against ${w.theirs.name}`
          : ""),
      value: outcome.result,
    });
  }

  /**
   * The matchup mean and the form pointing opposite ways.
   *
   * This is the failure the panel was built around and then hid: a safe lane
   * averaging +0.1 over four whole-game matchup figures while the two heroes
   * standing in it are 2 points worse from that lane than the two opposite.
   *
   * The headline no longer *is* that +0.1 — `laneScore` blends the readings, so
   * the large number now moves with the lane data on its own. This note survives
   * that fix because the matchup mean is still printed in the card, and a reader
   * comparing the two rows deserves to be told which of them was measured in a
   * lane rather than left to assume the bigger-looking figure wins.
   */
  if (formEdge !== null && Math.abs(formEdge) >= NOISE) {
    const behind = formEdge < 0;
    /**
     * The test is not "do the two numbers have opposite signs" — it is "does
     * the headline fail to warn about what the lane data says".
     *
     * Requiring the headline to be significant in the other direction was the
     * first attempt and it excluded the exact case worth catching: a lane
     * sitting at +0.1, which is inside the noise and reads as *fine*, while the
     * heroes standing in it are two points worse from that lane than the two
     * opposite. Nothing warns you, and "nothing warns you" was the condition
     * for staying silent. A headline that is already negative past the floor
     * has done its job and needs no second voice.
     */
    const unwarned = behind ? advantage > -NOISE : advantage < NOISE;
    if (unwarned) {
      notes.push({
        kind: "split",
        text:
          `Matchups read ${signed(advantage)} here, but these heroes' record from this lane is ` +
          `${signed(formEdge)} against theirs — and that record comes from games played from this ` +
          `lane, which the matchups do not. Read the lane as ${behind ? "weaker" : "stronger"} ` +
          `than the matchups say.`,
        value: behind ? formEdge : null,
      });
    }
  }

  /**
   * The lane whose figure was never taken from a lane.
   *
   * `measured` already says this and the value's tooltip already explains it,
   * which between them is nothing: a reader looking at "Mid +0.0" over "Shadow
   * Fiend vs Enigma" concludes the app thinks the lane is even, and the app
   * thinks no such thing — it has no reading of that lane at all and is showing
   * the whole-game head-to-head under the lane's name.
   *
   * That case is not rare or academic. It is what happens *every* time somebody
   * is booked into a position they do not play: Dotabuff publishes no lane row
   * for them, so the one lane-measured term drops out, and what is left counts
   * every minute of games in which the two heroes were almost never opposite
   * each other in the first place.
   */
  if (contested && !measured && pairs.length > 0) {
    const lonely =
      myForm && !theirForm
        ? " Their side has no record from this lane at all, so the form row is one number rather than a comparison."
        : theirForm && !myForm
          ? " Our side has no record from this lane at all, so the form row is one number rather than a comparison."
          : "";
    notes.push({
      kind: "unmeasured",
      text:
        `Nothing here was measured in a lane — the figure is the whole-game head-to-head between ` +
        `these heroes, which counts every minute of those games rather than the first ten.${lonely}`,
      value: null,
    });
  }

  const worst = pairs.filter((p) => p.advantage <= -NOISE)[0];
  if (worst) {
    notes.push({
      kind: "pair",
      text: `${worst.theirs.name} beats ${worst.mine.name} by ${Math.abs(worst.advantage).toFixed(1)} over ${worst.matches.toLocaleString()} games`,
      value: worst.advantage,
    });
  }

  /**
   * A hero standing somewhere they never stand — on *either* side.
   *
   * This used to run over my picks only, which quietly made the most useful
   * version of the note impossible to reach: an enemy booked into a position
   * they play 0% of the time is the single best thing that can happen to a
   * lane, and the card said nothing about it while printing a figure that
   * prices it at exactly zero.
   */
  for (const [side, picks] of [
    ["mine", mine],
    ["theirs", theirs],
  ] as const) {
    for (const pick of picks) {
      const hero = data.bySlug.get(pick.slug);
      if (!hero || !pick.position) continue;

      // A hero's own lane record is reported as `LaneForm` instead — the whole
      // side at once, with the worst of them named — so it is not repeated here.
      const share = positionFit(hero, pick.position);
      if (!hero.positions || share >= OFF_ROLE_SHARE) continue;
      const pct = Math.round(share * 100);

      notes.push({
        kind: "off-role",
        text:
          side === "mine"
            ? `${hero.name} is off-role at ${pick.position} — only ${pct}% of their games`
            : `Their ${hero.name} is off-role at ${pick.position} — ${pct}% of their games, ` +
              `which no figure in this card prices`,
        value: null,
      });
    }
  }

  // Bad news first: this list is read top-down and truncated.
  return notes.sort((a, b) => (a.value ?? 0) - (b.value ?? 0));
}

/**
 * How the two line-ups compare across the length of the game.
 *
 * Each hero's skew is their distance from their *own* baseline, so this is a
 * read on shape rather than on strength: a team of five 53% heroes that all
 * fall off has a negative late number, which is exactly the thing the headline
 * draft figure hides.
 */
function stageRead(data: Dataset, draft: DraftView, settings: Settings): StageRead | null {
  const buckets = data.timingBuckets;
  if (!buckets.length) return null;
  const shape = data.timingShape;

  const skews = (team: DraftPick[], index: number) => {
    const values: number[] = [];
    for (const pick of team) {
      const timing = data.bySlug.get(pick.slug)?.timings?.[index];
      if (timing && timing.games > 0) values.push(timing.skew);
    }
    return values;
  };

  const reports: StageReport[] = buckets.map((bucket, i) => {
    const mine = skews(draft.mine, i);
    const theirs = skews(draft.enemy, i);
    const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
    return {
      key: bucket.key,
      label: bucket.label,
      short: bucket.short,
      mine: mean(mine),
      theirs: mean(theirs),
      edge: mean(mine) - mean(theirs),
      covered: mine.length,
      theirCovered: theirs.length,
    };
  });

  const usable = reports.filter((r) => r.covered > 0);
  if (!usable.length) return null;

  const comparable = reports.filter((r) => r.covered === draft.mine.length && r.theirCovered === draft.enemy.length && r.covered > 0 && r.theirCovered > 0);
  const ranked = [...comparable].sort((a, b) => b.edge - a.edge);
  const best = ranked[0] ?? null;
  const worst = ranked.at(-1) ?? null;

  // The heroes stretching my own curve, taken from the ends of the timeline.
  // A hero whose curve is flat is not "our latest-scaling hero" just because
  // they sorted first, so both ends have to clear a threshold to be named.
  //
  // The `games > 0` filter is the same one the bucket means apply. Without it a
  // hero the collector never saw in the last window contributes a skew of 0 to
  // nothing and can still be named as the team's latest or earliest — a claim
  // built from an empty bucket, in the one card whose whole job is to say when
  // the draft wins.
  const last = buckets.length - 1;
  const NOTABLE_SKEW = NOISE;
  const skewAt = (hero: Hero) => hero.timings?.[last]?.skew ?? 0;
  const byLate = draft.mine
    .map((p) => data.bySlug.get(p.slug))
    .filter((h): h is Hero => Boolean(h?.timings?.[last] && h.timings[last]!.games > 0))
    .sort((a, b) => skewAt(b) - skewAt(a));

  const head = byLate[0];
  const tail = byLate.at(-1);
  const mostLate =
    head && skewAt(head) >= NOTABLE_SKEW ? { name: head.name, skew: skewAt(head) } : null;
  const mostEarly =
    tail && tail !== head && skewAt(tail) <= -NOTABLE_SKEW
      ? { name: tail.name, skew: skewAt(tail) }
      : null;

  /**
   * "Your window is X" must only be said about a window that is actually
   * yours. `best` is merely the *least bad* bucket when every edge is
   * negative — a run-over draft used to be read out as owning its smallest
   * deficit, with the losing number printed right there in the brackets. Each
   * half of the sentence is now gated on its own sign clearing the noise
   * floor, and a side with no window past the floor is said to have none.
   */
  const base =
    !best || !worst || best === worst
      ? "Not enough of both line-ups is timed yet to call a window."
      : best.edge < NOISE && worst.edge > -NOISE
        ? "Neither draft owns a particular part of the game."
        : best.edge < NOISE
          ? `No part of the game is truly yours — ${worst.label.toLowerCase()} is theirs (${signed(worst.edge)}), ` +
            `and you are least behind ${best.label.toLowerCase()} (${signed(best.edge)}).`
          : worst.edge > -NOISE
            ? `Your window is ${best.label.toLowerCase()} (${signed(best.edge)} on them); no part of the game is clearly theirs.`
            : `Your window is ${best.label.toLowerCase()} (${signed(best.edge)} on them); ` +
              `${worst.label.toLowerCase()} is theirs (${signed(worst.edge)}).`;

  const edges = reports.map((r) => r.edge);
  const fullyTimed = comparable.length === reports.length;
  const weighted = fullyTimed ? weightedEdge(edges, shape) : null;
  const risk = fullyTimed ? exposure(edges, shape, NOISE) : null;
  const cover = teamCover(
    draft.mine.map((p) => data.bySlug.get(p.slug)),
    shape,
  );
  const theirCover = teamCover(
    draft.enemy.map((p) => data.bySlug.get(p.slug)),
    shape,
  );

  /**
   * The sentence that would have stopped the draft this feature was built for.
   *
   * "Your window is 45′ and up" is true and, alone, misleading: it invites the
   * reader to price a late-game edge at face value when two thirds of games
   * are decided before it applies. Appending how much of the distribution has
   * to be survived first turns the same two numbers into a decision, and it is
   * only said when the wait is long enough to be a real risk — a draft that is
   * ahead from the first window has no exposure worth mentioning.
   */
  const summary =
    !fullyTimed ? "Timing coverage is incomplete — no whole-draft window can be called yet." :
    risk !== null && risk >= 0.2
      ? `${base} ${
          risk >= 0.999
            ? "No window is ever clearly yours — there is no point to survive to."
            : `${Math.round(risk * 100)}% of games are over before you are ahead.`
        }`
      : base;

  return {
    buckets: reports,
    best,
    worst,
    summary,
    mostLate,
    mostEarly,
    shares: shape?.shares ?? null,
    weightedEdge: weighted,
    exposure: risk,
    cover,
    theirCover,
    penalty: earlyCoverPenalty(cover, settings.earlyWeight),
    theirPenalty: earlyCoverPenalty(theirCover, settings.earlyWeight),
    earlyWindows: shape?.earlyWindows.length ?? 0,
  };
}

/**
 * How much a hero's lane record is allowed to speak for itself, in points of
 * lane presence.
 *
 * A hero who spends 40% of their games in a lane has a lane win rate worth
 * reading; one who wanders in for 3% has a number built from a corner of their
 * games, and it is pulled back towards their overall figure. Same shape as the
 * `POSITION_WR_PRIOR` the scraper uses on position win rates, for the same
 * reason.
 */
const LANE_PRESENCE_PRIOR = 12;

/**
 * A hero's win rate from one lane, shrunk towards their own overall figure by
 * how often they actually stand there. Null when the scrape has no lane row.
 *
 * Exported for `rebalance`, which needs exactly this reading to price a lane
 * swap: moving the safe duo into the off lane changes nothing about any matchup
 * and everything about the lane each hero is standing in, and this is the only
 * figure in the app that can see the difference.
 */
export function laneWinRate(hero: Hero, lane: Lane): number | null {
  const stats = hero.lanes?.[lane];
  if (!stats || !Number.isFinite(stats.winRate)) return null;
  const overall = hero.winRate ?? 50;
  const presence = Math.max(0, stats.presence ?? 0);
  const weight = presence / (presence + LANE_PRESENCE_PRIOR);
  return stats.winRate * weight + overall * (1 - weight);
}

/**
 * STRATZ's read of the laning stage between the heroes on one front: every
 * cross pairing of mine against theirs, each from its heroes' own seats.
 * Null without lanes.json, or when no pairing here has a lane record.
 */
function outcomeOf(data: Dataset, mine: DraftPick[], theirs: DraftPick[]): LaneOutcome | null {
  const model = data.laneOutcomes;
  if (!model) return null;

  let possible = 0;
  const readings: Array<{ mine: DraftPick; theirs: DraftPick; result: number; gameEdge: number; lanes: number }> = [];
  for (const a of mine) {
    for (const b of theirs) {
      if (!a.position || !b.position) continue;
      possible++;
      const pair = lanePair(model, a.slug, a.position, b.slug, b.position);
      if (!pair) continue;
      readings.push({ mine: a, theirs: b, result: (pair.result - 0.5) * 100, gameEdge: pair.gameEdge, lanes: pair.lanes });
    }
  }
  if (!readings.length) return null;

  const evidenced = readings.filter((r) => r.lanes > 0);
  const widest = [...readings].sort((x, y) => Math.abs(y.result) - Math.abs(x.result))[0]!;
  return {
    result: readings.reduce((sum, r) => sum + r.result, 0) / readings.length,
    gameEdge: evidenced.length ? evidenced.reduce((sum, r) => sum + r.gameEdge, 0) / evidenced.length : 0,
    covered: evidenced.length,
    possible,
    widest: {
      mine: slot(data, widest.mine),
      theirs: slot(data, widest.theirs),
      result: widest.result,
      lanes: widest.lanes,
    },
  };
}

/** The lane record of one side of a front, averaged. */
function formOf(data: Dataset, side: DraftPick[], plan: LanePlan): LaneForm | null {
  if (!side.length) return null;
  const values: Array<{ name: string; value: number }> = [];

  for (const pick of side) {
    const hero = data.bySlug.get(pick.slug);
    if (!hero || !pick.position) continue;
    // The lane they are standing in under this deployment, which after a swap
    // is not the one their position normally implies.
    const wr = laneWinRate(hero, laneForPosition(pick.position, plan));
    if (wr === null) continue;
    values.push({ name: hero.name, value: wr - 50 });
  }
  if (!values.length) return null;

  const value = values.reduce((sum, v) => sum + v.value, 0) / values.length;
  const worst = [...values].sort((a, b) => a.value - b.value)[0] ?? null;
  return {
    value,
    covered: values.length,
    possible: side.length,
    worst: worst && worst.value <= -1 && values.length > 1 ? worst : null,
  };
}

/**
 * The pairing between the two heroes holding one side of a lane.
 *
 * A front never has more than two heroes a side — safe is 1 and 5, offlane 3
 * and 4, mid is one hero — so "the duo" is unambiguous when it exists at all.
 */
function duoOf(data: Dataset, side: DraftPick[], settings: Settings): SynergyPair | null {
  if (side.length !== 2) return null;
  const [a, b] = side as [DraftPick, DraftPick];
  const s = synergy(data, a.slug, b.slug, a.position, b.position, settings.minSynergyMatches);
  if (!s || s.matches < settings.minSynergyMatches) return null;
  return { a: slot(data, a), b: slot(data, b), synergy: s.synergy, matches: s.matches };
}

/**
 * What each reading is worth in the lane score, and why they are not equal.
 *
 * The lane score is what this lane is worth in games, in win-rate points, and
 * the four readings speak to it with different authority:
 *
 * - `laning` is STRATZ's lane outcome for the pairings actually standing here,
 *   reduced to the part that is specific to them and converted to games (see
 *   `LaneOutcome.gameEdge`). Measured in the lane and knows who faces whom.
 * - `form` is the win rate the heroes standing here post in games played from
 *   this lane. Measured from the lane, but blind to who they face.
 * - `duo` is how the two heroes on each side work together — the 2v2 the lane
 *   really is, but measured over whole games rather than the laning stage.
 * - `matchup` is the head-to-head between the four. Also whole-game, and worse:
 *   on a 2v2 it includes the support-versus-carry and support-versus-support
 *   pairings, which are pure noise about a lane and can easily carry the mean
 *   back across zero on their own. That is exactly how a lane both sides could
 *   see we were losing came out at +0.1.
 *
 * These are not free parameters to tune until a particular draft reads right;
 * they are an ordering — lane-measured, then 2v2, then whole-game — and the
 * numbers are the smallest ones that express it.
 */
const LANE_WEIGHTS = { laning: 1, form: 1, duo: 0.5, matchup: 0.5 } as const;

/**
 * Blend the four readings into the number the lane row leads with.
 *
 * A weighted mean over whichever terms exist, normalised by the weight that
 * was actually available — so the score stays in win-rate points and means the
 * same thing whether or not the scrape happened to carry lane rows for these
 * heroes. With neither form nor duo it degrades to `advantage` exactly, which
 * is the honest answer when the matchup table is all there is.
 *
 * The form term is additionally shrunk by how much of each side it was built
 * from: a difference between "both our heroes" and "one of their two" is a
 * weaker claim than one between two full sides, and it should not be allowed
 * to swing a lane as hard.
 */
function laneScore(args: {
  advantage: number;
  covered: number;
  outcome: LaneOutcome | null;
  formEdge: number | null;
  myForm: LaneForm | null;
  theirForm: LaneForm | null;
  duoEdge: number | null;
}): { score: number; laning: number | null; measured: boolean } {
  const { advantage, covered, outcome, formEdge, myForm, theirForm, duoEdge } = args;
  let total = 0;
  let weight = 0;
  let measured = false;

  /**
   * The same blend with the whole-game term left out.
   *
   * `score` is what the card leads with and is the honest answer to "what is
   * this lane worth" — all four readings, matchups included. `laning` is the
   * part of it that was *measured in a lane*: laning, form and duo, nothing that
   * counts minute forty. It exists for `rebalance`, whose objective already contains every
   * matchup on the board through `draftBalance`, and which would be counting the
   * same pairings twice if it read `score`.
   */
  let laneTotal = 0;
  let laneWeight = 0;

  if (covered > 0) {
    total += advantage * LANE_WEIGHTS.matchup;
    weight += LANE_WEIGHTS.matchup;
  }

  // Shrunk by coverage for the same reason form is: a read of one pairing out
  // of four is a weaker claim about the lane than a read of all four.
  if (outcome && outcome.covered > 0) {
    const w = LANE_WEIGHTS.laning * (outcome.covered / Math.max(1, outcome.possible));
    total += outcome.gameEdge * w;
    weight += w;
    laneTotal += outcome.gameEdge * w;
    laneWeight += w;
    measured = true;
  }

  if (formEdge !== null && myForm && theirForm) {
    const confidence = Math.min(
      myForm.covered / Math.max(1, myForm.possible),
      theirForm.covered / Math.max(1, theirForm.possible),
    );
    const w = LANE_WEIGHTS.form * confidence;
    if (w > 0) {
      total += formEdge * w;
      weight += w;
      laneTotal += formEdge * w;
      laneWeight += w;
      measured = true;
    }
  }

  if (duoEdge !== null) {
    total += duoEdge * LANE_WEIGHTS.duo;
    weight += LANE_WEIGHTS.duo;
    laneTotal += duoEdge * LANE_WEIGHTS.duo;
    laneWeight += LANE_WEIGHTS.duo;
    measured = true;
  }

  return {
    score: weight ? total / weight : 0,
    laning: laneWeight ? laneTotal / laneWeight : null,
    measured,
  };
}

/** Lane-weighted mean of a set of pairings, the way `draftBalance` weights them. */
function weightedMean(pairs: PairEdge[], laneWeight: number): number {
  let weighted = 0;
  let total = 0;
  for (const p of pairs) {
    const w = p.sameLane ? 1 + laneWeight : 1;
    weighted += p.advantage * w;
    total += w;
  }
  return total ? weighted / total : 0;
}

/** The three fronts that have two sides to them. "map" is not one of them. */
export const CONTESTED_LANES = ["safe", "mid", "off"] as const;
export type ContestedLane = (typeof CONTESTED_LANES)[number];

/**
 * Everything about one front that is arithmetic rather than prose.
 *
 * Split out of `analyseDraft` so a caller that only wants the numbers is not
 * made to pay for the words. `laneScoreboard` scores hundreds of hypothetical
 * boards during a rebalance search, and the parts it was previously buying by
 * accident — every hero's contribution, both synergy tables, the threat and
 * edge rankings, and a paragraph of English per lane — cost far more than the
 * three figures it actually reads.
 */
function laneCore(
  data: Dataset,
  draft: DraftView,
  settings: Settings,
  plan: LanePlan,
  pairs: PairEdge[],
  key: ContestedLane,
) {
  const sides = LANE_SIDES[plan][key];
  const mine = draft.mine.filter((p) => p.position && sides.mine.includes(p.position));
  const theirs = draft.enemy.filter((p) => p.position && sides.theirs.includes(p.position));
  const lanePairs = pairs.filter((p) => p.lane === key);
  lanePairs.sort((x, y) => x.advantage - y.advantage);

  const advantage = weightedMean(lanePairs, 0);
  const outcome = outcomeOf(data, mine, theirs);
  const myForm = formOf(data, mine, plan);
  // Their side is always read under `standard`, and the asymmetry is the whole
  // point. A swap is something *one* team does — we walk our safe duo the other
  // way, they stand where they always stand — and if both sides walked, the
  // duos would meet their usual opponents again and the plan would not be a
  // swap at all. Handing `plan` to both sides priced the enemy carry on his
  // *offlane* record for a lane he never left: on a Sniper/Lion safe duo that
  // is half a point of win rate invented out of nothing, in the direction that
  // makes the swap look better than it is.
  const theirForm = formOf(data, theirs, "standard");
  const formEdge = myForm && theirForm ? myForm.value - theirForm.value : null;
  const myDuo = duoOf(data, mine, settings);
  const theirDuo = duoOf(data, theirs, settings);
  const duoEdge = myDuo && theirDuo ? myDuo.synergy - theirDuo.synergy : null;
  const { score, laning, measured } = laneScore({
    advantage,
    covered: lanePairs.length,
    outcome,
    formEdge,
    myForm,
    theirForm,
    duoEdge,
  });

  return {
    key,
    label: LANE_LABEL[plan][key],
    mine,
    theirs,
    lanePairs,
    advantage,
    outcome,
    myForm,
    theirForm,
    formEdge,
    myDuo,
    theirDuo,
    duoEdge,
    score,
    laning,
    measured,
    contested: mine.length > 0 && theirs.length > 0,
  };
}

/** One front's read, with nothing on it a search would not use. */
export interface LaneScoreboardEntry {
  key: ContestedLane;
  label: string;
  score: number;
  /**
   * The part of `score` that was measured in a lane — laning, form and duo, without the
   * whole-game matchup term. Null when the scrape carried neither.
   *
   * Kept apart from `score` because the two answer to different callers. A
   * reader wants every reading that bears on the lane; an objective that already
   * sums the matchup table wants only what that table cannot see, or it is
   * paying for the same pairings twice.
   */
  laning: number | null;
  contested: boolean;
}

/**
 * The three lane scores of a board, and nothing else.
 *
 * The narrow read behind the rebalance search. It shares `laneCore` with
 * `analyseDraft`, so the figure a hypothetical board is judged on is the same
 * one the read-out would print for it if you applied the arrangement — the two
 * cannot drift.
 */
export function laneScoreboard(
  data: Dataset,
  draft: DraftView,
  settings: Settings,
): Map<ContestedLane, LaneScoreboardEntry> {
  const plan = draft.lanePlan ?? "standard";
  const { pairs } = crossPairs(data, draft, settings);
  const out = new Map<ContestedLane, LaneScoreboardEntry>();
  for (const key of CONTESTED_LANES) {
    const { label, score, laning, contested } = laneCore(data, draft, settings, plan, pairs, key);
    out.set(key, { key, label, score, laning, contested });
  }
  return out;
}

/** Parts smaller than this, in points of win chance, get no reason: there is nothing to explain. */
const WIN_REASON_FLOOR = 0.5;

/** The reasons behind each part of the win chance, read off the same board. */
function explainWin(
  data: Dataset,
  win: WinRead,
  board: Pick<DraftAnalysis, "threats" | "edges" | "mySynergyPairs" | "theirSynergyPairs" | "stages" | "lineups">,
): DraftWin {
  const part = (group: WinGroup) => win.parts.find((p) => p.group === group)?.points ?? 0;
  // The win rates the Heroes part was priced on, which are the calibration's
  // band and not necessarily the one on screen.
  const priced = data.calibration ? atRankBand(data, data.calibration.rankBand) : data;
  const strongest = (slots: LineupSlot[]) =>
    slots
      .map((slot) => ({ slot, winRate: priced.bySlug.get(slot.slug)?.winRate }))
      .filter((x): x is { slot: LineupSlot; winRate: number } => typeof x.winRate === "number")
      .sort((a, b) => b.winRate - a.winRate)[0];

  const matchups = part("matchups");
  const threat = board.threats[0];
  const edge = board.edges[0];
  const cohesion = part("cohesion");
  const theirPair = board.theirSynergyPairs.find((p) => p.synergy >= NOISE);
  const ourPair = board.mySynergyPairs.find((p) => p.synergy >= NOISE);
  const heroes = part("heroes");
  const theirBest = strongest(board.lineups.enemy);
  const ourBest = strongest(board.lineups.mine);
  const timing = part("timing");
  const stages = board.stages;

  return {
    ...win,
    reasons: {
      roles: rolesReason(win.roles),
      matchups:
        matchups <= -WIN_REASON_FLOOR && threat
          ? `${threat.theirs.name} beats ${threat.mine.name} by ${Math.abs(threat.advantage).toFixed(1)}`
          : matchups >= WIN_REASON_FLOOR && edge
            ? `${edge.mine.name} beats ${edge.theirs.name} by ${edge.advantage.toFixed(1)}`
            : null,
      cohesion:
        cohesion <= -WIN_REASON_FLOOR && theirPair
          ? `their ${theirPair.a.name} + ${theirPair.b.name} (${signed(theirPair.synergy)})`
          : cohesion >= WIN_REASON_FLOOR && ourPair
            ? `our ${ourPair.a.name} + ${ourPair.b.name} (${signed(ourPair.synergy)})`
            : null,
      heroes:
        heroes <= -WIN_REASON_FLOOR && theirBest
          ? `their ${theirBest.slot.name} wins ${theirBest.winRate.toFixed(1)}% of games`
          : heroes >= WIN_REASON_FLOOR && ourBest
            ? `our ${ourBest.slot.name} wins ${ourBest.winRate.toFixed(1)}% of games`
            : null,
      timing:
        Math.abs(timing) >= WIN_REASON_FLOOR && stages?.cover != null
          ? `heroes who work before the median game: us ${stages.cover.toFixed(1)}, them ` +
            `${stages.theirCover?.toFixed(1) ?? "unknown"}, of ${TARGET_EARLY_COVER} needed`
          : null,
    },
  };
}

/**
 * Break a draft down into the parts a player can act on.
 *
 * Null until there is something to compare — one hero a side is enough, and the
 * sections fill in as the board does, because a lane read at 3v3 is exactly
 * when it can still change a pick.
 */
export function analyseDraft(
  data: Dataset,
  draft: DraftView,
  settings: Settings,
  teamSize = 5,
): DraftAnalysis | null {
  const balance = draftBalance(data, draft, settings);
  if (!balance) return null;

  const plan = draft.lanePlan ?? "standard";
  const { pairs, possible, possibleByLane } = crossPairs(data, draft, settings);
  const mineSyn = teamPairs(data, draft.mine, settings);
  const theirSyn = teamPairs(data, draft.enemy, settings);

  // ------------------------------------------------------------------ lanes
  const lanes: LaneReport[] = CONTESTED_LANES.map((key) => {
    const core = laneCore(data, draft, settings, plan, pairs, key);
    const { mine, theirs, lanePairs, advantage, outcome, formEdge, measured, myForm, theirForm } = core;

    return {
      key,
      label: core.label,
      mine: mine.map((p) => slot(data, p)),
      theirs: theirs.map((p) => slot(data, p)),
      score: core.score,
      measured,
      advantage,
      pairs: lanePairs,
      myDuo: core.myDuo,
      theirDuo: core.theirDuo,
      duoEdge: core.duoEdge,
      outcome,
      myForm,
      theirForm,
      formEdge,
      notes: laneNotes({
        data,
        mine,
        theirs,
        pairs: lanePairs,
        advantage,
        outcome,
        formEdge,
        measured,
        myForm,
        theirForm,
        contested: core.contested,
      }),
      contested: core.contested,
      possible: possibleByLane.get(key) ?? 0,
      covered: lanePairs.length,
      weight: null,
    };
  });

  // Pairings that never meet in a lane. Kept as a front of its own and shown
  // like one: on a full board this is 16 of the 25 figures and, at the default
  // lane weight, 16 of the 34 units of weight behind the head-to-head term.
  // While it was filtered out of the card the three visible lane numbers could
  // not be reconciled with that term by any arithmetic the reader had access
  // to.
  const offLane = pairs.filter((p) => p.lane === "map");
  if (offLane.length) {
    offLane.sort((x, y) => x.advantage - y.advantage);
    // Counted over the pairings that actually reached the card, not over the
    // 25 seats on the board. A pairing thrown out for a thin sample carries no
    // weight in `draftBalance` either, so the share printed here is the share
    // of the figure the reader is looking at.
    const laneMultiple = 1 + settings.laneWeight;
    const totalWeight = pairs.reduce((sum, p) => sum + (p.sameLane ? laneMultiple : 1), 0);
    lanes.push({
      key: "map",
      label: LANE_LABEL[plan].map,
      mine: [],
      theirs: [],
      // Nobody stands anywhere here, so there is no lane reading to blend in
      // and the score is the matchup mean under another name. `measured: false`
      // is what stops the card claiming otherwise.
      score: weightedMean(offLane, 0),
      measured: false,
      advantage: weightedMean(offLane, 0),
      pairs: offLane,
      myDuo: null,
      theirDuo: null,
      duoEdge: null,
      outcome: null,
      myForm: null,
      theirForm: null,
      formEdge: null,
      notes: [],
      contested: true,
      possible: possibleByLane.get("map") ?? offLane.length,
      covered: offLane.length,
      weight: { own: offLane.length, total: totalWeight, laneMultiple },
    });
  }

  // ------------------------------------------------------------- my heroes
  const heroes: HeroReport[] = [];
  for (const pick of draft.mine) {
    const hero = data.bySlug.get(pick.slug);
    if (!hero) continue;
    const own = pairs.filter((p) => p.mine.slug === pick.slug);
    const sorted = [...own].sort((x, y) => y.advantage - x.advantage);
    const withTeam = mineSyn.pairs.filter((p) => p.a.slug === pick.slug || p.b.slug === pick.slug);
    const synergyMean = withTeam.length
      ? withTeam.reduce((sum, p) => sum + p.synergy, 0) / withTeam.length
      : 0;
    const matchupMean = weightedMean(own, settings.laneWeight);

    heroes.push({
      hero,
      position: pick.position,
      matchup: matchupMean,
      synergy: synergyMean,
      total: matchupMean + settings.synergyWeight * synergyMean,
      covered: own.length,
      // Only named when the edge is worth naming — see `HeroReport.best`.
      best: sorted[0] && sorted[0].advantage >= NOISE ? sorted[0] : null,
      worst:
        sorted.length > 1 && (sorted.at(-1)?.advantage ?? 0) <= -NOISE
          ? sorted.at(-1) ?? null
          : null,
    });
  }
  heroes.sort((a, b) => b.total - a.total);

  const byAdvantage = [...pairs].sort((a, b) => a.advantage - b.advantage);
  // "Pairings that matter" has to mean it. Any sign at all used to qualify,
  // so a +0.05 pairing could be listed as an edge by the same panel that had
  // just called half a point a coin flip.
  const threats = byAdvantage.filter((p) => p.advantage <= -NOISE).slice(0, 5);
  const edges = byAdvantage.filter((p) => p.advantage >= NOISE).reverse().slice(0, 5);
  const stages = stageRead(data, draft, settings);
  const lineups = {
    mine: draft.mine.map((p) => slot(data, p)),
    enemy: draft.enemy.map((p) => slot(data, p)),
  };
  const win = data.calibration
    ? explainWin(data, winRead(data, draft, data.calibration), {
        threats,
        edges,
        mySynergyPairs: mineSyn.pairs,
        theirSynergyPairs: theirSyn.pairs,
        stages,
        lineups,
      })
    : null;

  return {
    lineups,
    win,
    cohesionContribution: settings.synergyWeight * balance.synergyEdge,
    advantage: balance.advantage,
    counter: balance.counter,
    synergyEdge: balance.synergyEdge,
    mySynergy: balance.mySynergy,
    theirSynergy: balance.theirSynergy,
    earlyEdge: balance.earlyEdge,
    verdict: verdictFor(balance.advantage),
    complete: draft.mine.length === teamSize && draft.enemy.length === teamSize,
    sides: { mine: draft.mine.length, enemy: draft.enemy.length },
    lanesResolved: [...draft.mine, ...draft.enemy].every((p) => p.position !== null),
    lanePlan: plan,

    lanes,
    heroes,
    threats,
    edges,
    mySynergyPairs: mineSyn.pairs,
    theirSynergyPairs: theirSyn.pairs,
    stages,

    coverage: {
      matchups: pairs.length,
      matchupsPossible: possible,
      synergies: mineSyn.pairs.length + theirSyn.pairs.length,
      synergiesPossible: mineSyn.possible + theirSyn.possible,
    },
  };
}

/**
 * The whole read as text, for pasting into a team chat before the horn.
 *
 * Everything here is already on screen; what it adds is portability. The panel
 * is the artefact one person is looking at, and a draft plan is worth nothing
 * if the other four cannot see it — so this is the same numbers in the same
 * order, shaped to survive a paste into Discord.
 *
 * Coverage goes at the bottom on purpose. A reader who receives a wall of
 * figures with no idea how many pairings they rest on will over-trust them,
 * and the sender is no longer in the room to say so.
 */
export function toMarkdown(analysis: DraftAnalysis): string {
  const out: string[] = [];
  const pct = (n: number) => signed(n);

  const progress = analysis.complete ? "" : ` · draft in progress (${analysis.sides.mine}v${analysis.sides.enemy})`;
  if (analysis.win) {
    const win = analysis.win;
    out.push(`**Win chance ${win.shown} — ${win.verdict.label.toLowerCase()}**`);
    out.push(
      [...win.parts]
        .sort((a, b) => Math.abs(b.points) - Math.abs(a.points))
        .map((p) => `${p.label.toLowerCase()} ${pct(p.points)}`)
        .join(" · ") + progress,
    );
    if (win.reasons.roles) out.push(`Roles: ${win.reasons.roles}`);
  } else {
    out.push(`**Draft ${pct(analysis.advantage)} — ${analysis.verdict.label.toLowerCase()}**`);
    out.push(
      `matchups ${pct(analysis.counter)} · cohesion ${pct(analysis.cohesionContribution)} · early cover ${pct(analysis.earlyEdge)}` +
        progress,
    );
  }

  const briefing = buildBriefing(analysis);
  out.push("", "**Game plan — " + briefing.title + "**", briefing.description);
  for (const insight of briefing.insights) {
    out.push(`- ${insight.title}: ${insight.action} ${insight.evidence}`);
  }

  const points = talkingPoints(analysis);
  if (points.length) {
    out.push("", ...points.map((p) => `- ${p}`));
  }

  const lanes = analysis.lanes.filter((l) => l.key !== "map" && l.contested && l.covered > 0);
  if (lanes.length) {
    out.push(
      "",
      analysis.lanePlan === "swapped"
        ? "**Lanes** _(swapped — our safe duo walked into their safe lane, so carry meets carry)_"
        : "**Lanes**",
    );
    for (const lane of lanes) {
      const who = [...lane.mine.map((s) => s.name), "vs", ...lane.theirs.map((s) => s.name)].join(" ");
      out.push(
        `- ${lane.label} ${pct(lane.score)} — ${who}` +
          (lane.outcome ? ` · laning ${Math.round(50 + lane.outcome.result)}% ours` : "") +
          ` · matchups ${pct(lane.advantage)}` +
          (lane.formEdge !== null ? ` · form ${pct(lane.formEdge)}` : "") +
          (lane.duoEdge !== null ? ` · duo ${pct(lane.duoEdge)}` : ""),
      );
    }
  }

  if (analysis.stages) {
    out.push("", "**Game length**", `- ${analysis.stages.summary}`);
    for (const b of analysis.stages.buckets) {
      if (!b.covered && !b.theirCovered) continue;
      out.push(`- ${b.label}: us ${b.covered ? pct(b.mine) : "unknown"} · them ${b.theirCovered ? pct(b.theirs) : "unknown"} · edge ${b.covered && b.theirCovered ? pct(b.edge) : "unknown"} · timed ${b.covered}/${analysis.sides.mine} vs ${b.theirCovered}/${analysis.sides.enemy}`);
    }
    // The two figures that reprice everything above them. Pasted into a chat
    // the bucket list alone reads as "we win late", which is exactly the
    // misreading this pair exists to prevent.
    if (analysis.stages.weightedEdge !== null) {
      out.push(
        `- Weighted by how long games actually run: ${pct(analysis.stages.weightedEdge)}`,
      );
    }
    if (analysis.stages.cover !== null) {
      out.push(
        `- Heroes who work before the median game: us ${analysis.stages.cover.toFixed(1)}` +
          (analysis.stages.theirCover !== null
            ? ` · them ${analysis.stages.theirCover.toFixed(1)}`
            : "") +
          ` (of ${TARGET_EARLY_COVER} needed)`,
      );
    }
  }

  if (analysis.threats.length) {
    out.push("", "**Watch out for**");
    for (const p of analysis.threats) {
      out.push(
        `- ${p.theirs.name} beats ${p.mine.name} by ${Math.abs(p.advantage).toFixed(1)}` +
          ` (${p.matches.toLocaleString()} games)`,
      );
    }
  }

  out.push(
    "",
    `_${analysis.coverage.matchups}/${analysis.coverage.matchupsPossible} matchups and ` +
      `${analysis.coverage.synergies}/${analysis.coverage.synergiesPossible} pairings had a usable ` +
      `sample. Percentage points of win rate; anything under ${NOISE.toFixed(1)} is noise._`,
  );
  if (analysis.win) {
    out.push(
      `_Win chance from a model calibrated on ${analysis.win.matches.toLocaleString()} ranked games; ` +
        `each part is points of win chance against an even draft._`,
    );
  }

  return out.join("\n");
}

/**
 * What one hypothetical pick would do to the whole draft, not just to its own
 * score.
 *
 * The suggestion score answers "what is this hero worth", which is the right
 * question for ranking and the wrong one for the decision in front of you: it
 * is an average over pairings, so a hero who is +2 overall can still be the
 * pick that hands away the safe lane. This runs the real read twice — the
 * board as it stands, and the board with the hero on it — and reports the
 * difference the captain would actually feel.
 *
 * Deliberately the same `draftBalance`/`analyseDraft` arithmetic rather than a
 * cheaper approximation of it: a preview that disagreed with the number it
 * previews would be worse than no preview.
 */
export function pickImpact(
  data: Dataset,
  draft: DraftView,
  settings: Settings,
  slug: string,
  position: Position | null,
  side: "mine" | "enemy" = "mine",
): DraftImpact | null {
  if (draft[side].some((p) => p.slug === slug)) return null;

  const added: DraftPick = { slug, position };
  const next: DraftView =
    side === "mine"
      ? { ...draft, mine: [...draft.mine, added] }
      : { ...draft, enemy: [...draft.enemy, added] };

  const after = draftBalance(data, next, settings);
  if (!after) return null;
  const before = draftBalance(data, draft, settings);

  /**
   * Which front the pick moves most.
   *
   * Only computed when both boards can be split by lane at all — before the
   * first enemy hero there is nothing to compare a lane against, and naming
   * one anyway would be inventing a consequence.
   */
  let lane: DraftImpact["lane"] = null;
  const afterLanes = analyseDraft(data, next, settings);
  const beforeLanes = before ? analyseDraft(data, draft, settings) : null;
  if (afterLanes && beforeLanes) {
    // Moved with the card: "which lane does this pick change" has to be asked
    // of the number the card leads with, or the badge on a hero tile and the
    // lane row it points at can disagree about whether the pick helped.
    const was = new Map(beforeLanes.lanes.map((l) => [l.key, l.score]));
    for (const l of afterLanes.lanes) {
      if (l.key === "map" || !l.contested) continue;
      const delta = l.score - (was.get(l.key) ?? 0);
      if (Math.abs(delta) < NOISE) continue;
      if (!lane || Math.abs(delta) > Math.abs(lane.delta)) {
        lane = { label: l.label, delta, after: l.score };
      }
    }
  }

  if (data.calibration) {
    const calibration = data.calibration;
    const was = before ? winRead(data, draft, calibration) : null;
    const now = winRead(data, next, calibration);
    return {
      unit: "chance",
      before: was ? was.chance * 100 : null,
      after: now.chance * 100,
      // `short`, the top-bar chip's form: the card has as little room.
      shown: {
        before: was?.short ?? null,
        after: now.short,
        inRange: now.inRange && (was?.inRange ?? true),
      },
      lane,
    };
  }
  return { unit: "points", before: before?.advantage ?? null, after: after.advantage, lane };
}

/** "1 Safe carry" — or just the hero name when no position is booked. */
export const slotLabel = (s: LineupSlot): string =>
  s.position ? `${s.name} (${s.position} ${POSITION_LABEL[s.position].toLowerCase()})` : s.name;

const signed = (n: number, digits = 1) =>
  `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(digits)}`;

/**
 * The read, reduced to things worth saying out loud before the horn.
 *
 * A captain has about twenty seconds of everyone's attention. Tables are for
 * afterwards; this is what goes in those twenty seconds, so it is ordered by
 * what changes behaviour — where we are losing, when we are supposed to win,
 * and who to watch — and it stops at five.
 */
export function talkingPoints(analysis: DraftAnalysis): string[] {
  const out: string[] = [];
  /**
   * Seats nobody on the side plays, said before anything else: the one line
   * here that means the draft itself is broken rather than one fight in it,
   * priced by the same model as the headline.
   */
  const roles = analysis.win?.parts.find((p) => p.group === "roles");
  if (roles && roles.points <= -ROLES_TALK && analysis.win?.reasons.roles) {
    out.push(`Fix the roles: ${analysis.win.reasons.roles} (${signed(roles.points)} points of win chance)`);
  }
  const contested = analysis.lanes.filter((l) => l.key !== "map" && l.contested && l.covered);
  // Ranked by the lane read, not the matchup mean: the whole point of the
  // blend is that a lane can be the one we are losing worst while the raw
  // head-to-head figures put it mid-table.
  const byLane = [...contested].sort((a, b) => a.score - b.score);
  const worstLane = byLane[0];
  const bestLane = byLane.at(-1);

  /**
   * A lane the matchups like and the lane data does not, said first.
   *
   * This is the one a captain most needs and the old list could never produce:
   * it only ever ranked lanes by `advantage`, so a lane sitting at +0.1 was
   * simply not a talking point, however far behind the two heroes standing in
   * it actually were from that lane. Losing a lane you were told was even is
   * worse than losing one you planned for.
   */
  /**
   * The structural warning, said before any lane.
   *
   * A lane note tells a captain how one fight goes; this tells them the draft
   * has no first half, which outranks all three of them — it is the only line
   * here that means "do not take this line-up", and it is the one the list
   * could not produce at all before. Gated on the penalty rather than on the
   * cover, so it fires exactly when the headline is actually being charged.
   */
  const stages = analysis.stages;
  if (stages && stages.penalty >= NOISE && stages.cover !== null) {
    out.push(
      `We have ${stages.cover.toFixed(1)} of ${TARGET_EARLY_COVER} heroes who work before the ` +
        `median game (${signed(-stages.penalty)}) — nothing to hold the map with while we scale`,
    );
  }

  /**
   * The lane we lose the laning stage of, by the one reading measured on the
   * laning stage. Said early: it is the thing the four of them have to plan
   * around in the first ten minutes, whatever the lane is worth later.
   */
  const lostLane = contested
    .filter((l) => l.outcome && l.outcome.result <= -LANING_TALK)
    .sort((a, b) => a.outcome!.result - b.outcome!.result)[0];
  if (lostLane) {
    out.push(
      `${lostLane.label}: they take about ${Math.round(50 - lostLane.outcome!.result)}% of the laning ` +
        `stage — plan to survive it, not to win it`,
    );
  }

  const split = contested
    .filter((l) => l.notes.some((n) => n.kind === "split") && (l.formEdge ?? 0) <= -NOISE)
    .sort((a, b) => (a.formEdge ?? 0) - (b.formEdge ?? 0))[0];
  if (split) {
    out.push(
      `${split.label} reads ${signed(split.advantage)} on matchups but our heroes are ` +
        `${signed(split.formEdge!)} from that lane — it is weaker than the matchups make it look`,
    );
  }

  if (worstLane && worstLane !== split && worstLane.score < -NOISE) {
    // The note is left exactly as written: it starts with a hero name, and
    // lower-casing a sentence that opens with one turns Axe into axe.
    //
    // "unmeasured" is skipped rather than ranked: it is a caveat about how the
    // figure was arrived at, not a reason the lane is weak, and it is two lines
    // long — in a list that gets twenty seconds of everyone's attention it
    // would push out the pairing that actually loses the lane.
    const why = worstLane.notes.find(
      (n) => n.kind !== "split" && n.kind !== "unmeasured" && !(n.kind === "laning" && worstLane === lostLane),
    );
    out.push(
      `${worstLane.label} is our weak side (${signed(worstLane.score)})` +
        (why ? ` — ${why.text}` : ""),
    );
  }
  if (
    bestLane &&
    bestLane !== worstLane &&
    bestLane !== split &&
    bestLane.score > NOISE &&
    // Belt and braces now that the score already carries the form term: a lane
    // is never offered as one to play through while its own lane data says we
    // lose it, however the matchups net out.
    (bestLane.formEdge ?? 0) > -NOISE &&
    (bestLane.outcome?.result ?? 0) > -LANING_NOTE
  ) {
    out.push(`${bestLane.label} is ours (${signed(bestLane.score)}) — play through it`);
  }

  if (analysis.stages?.summary && analysis.stages.best !== analysis.stages.worst) {
    out.push(analysis.stages.summary);
  }

  const weakest = analysis.heroes.at(-1);
  if (weakest && analysis.heroes.length > 1 && weakest.total < -NOISE) {
    // `worst` is already gated on NOISE, so "X is the problem" only appears
    // when there is one. A hero can be the weakest of five purely on cohesion.
    out.push(
      `${weakest.hero.name} has the hardest game of our five (${signed(weakest.total)})` +
        (weakest.worst ? ` — ${weakest.worst.theirs.name} is the problem` : ""),
    );
  }

  const threat = analysis.threats[0];
  if (threat && threat.advantage < -2 && !out.some((line) => line.includes(threat.theirs.name))) {
    out.push(
      `Watch ${threat.theirs.name} into our ${threat.mine.name} (${signed(threat.advantage)})`,
    );
  }

  if (out.length < 3 && Math.abs(analysis.synergyEdge) > NOISE) {
    out.push(
      analysis.synergyEdge > 0
        ? `Our five work together better than theirs (${signed(analysis.mySynergy)} vs ${signed(analysis.theirSynergy)}) — fight as a group`
        : `Their line-up is more cohesive than ours (${signed(analysis.theirSynergy)} vs ${signed(analysis.mySynergy)}) — avoid five-on-five`,
    );
  }

  return out.slice(0, 5);
}
