import { POSITION_LABEL } from "./roles";
import { formatSigned } from "./scoring";
import type { Readiness, RebalanceOption, RebalanceReport } from "./rebalance";

/**
 * How a rearrangement is put into words.
 *
 * Its own module because two places say the same thing about the same option and
 * they must not drift: the top-bar button, which is often the only part of this
 * feature anyone reads, and the panel it opens. They used to phrase it
 * separately — the button said "Rebalance +1.4 board", the panel heading said
 * "+1.4 across the board", the option row said "+1.4 BOARD" and the line under
 * it said "draft −1.9" — four wordings of two different quantities, none of
 * which named itself accurately.
 *
 * Pure functions over the report, no JSX, so both callers and the tests can use
 * them.
 */

/** The lead figure of an option, and what it is a figure *of*. */
export interface Headline {
  value: string;
  /**
   * The unit, printed under the number. Not decoration: the two kinds of option
   * lead with different quantities — a whole-board gain and a single lane's
   * swing — and that difference was once carried by colour alone, which
   * survives neither a cropped screenshot nor a colour-blind reader.
   */
  unit: string;
  tone: "good" | "warn";
  title: string;
}

/**
 * `overall`, never `board`, and the distinction is the point.
 *
 * What an arrangement is ranked on is the draft figure *plus* how well the five
 * suit the seats they would take. Only the first half is the number the rest of
 * the app prints, so calling the sum "board" put a figure three points away from
 * the draft score under a word that claimed to be the draft score.
 */
export const TOTAL_UNIT = "overall";

/** "Earth Spirit", "Earth Spirit and Undying", "3 heroes". */
const nameList = (names: string[]): string =>
  names.length <= 1
    ? (names[0] ?? "")
    : names.length === 2
      ? `${names[0]} and ${names[1]}`
      : `${names.length} heroes`;

export function headlineFor(option: RebalanceOption): Headline {
  if (option.reason === "seat") {
    const who = nameList(option.repairedSeats.map((seat) => seat.name));
    const cost = option.gain.total;
    return {
      // The cost, not the count. A seat repair is the one thing on this panel
      // that can be worth taking at a loss, so the figure the reader needs is
      // what it costs — the reason it is on the list is the sentence next to it.
      value: formatSigned(cost, 1),
      unit: TOTAL_UNIT,
      tone: cost >= 0 ? "good" : "warn",
      title:
        `${who} ${option.repairedSeats.length === 1 ? "is" : "are"} booked into a position ` +
        `they hardly ever play. This puts them somewhere they do, and ` +
        (cost >= 0
          ? `costs nothing — the board is worth ${formatSigned(cost, 1)} more arranged this way.`
          : `costs ${formatSigned(-cost, 1)} points of the overall figure to do it.`),
    };
  }
  if (option.reason === "score") {
    return {
      value: formatSigned(option.gain.total, 1),
      unit: TOTAL_UNIT,
      tone: "good",
      title:
        "What this arrangement is worth all told: the change to the draft figure plus the " +
        "change in how well your five suit the seats they would take. Both halves are broken " +
        "out below.",
    };
  }
  const lane = option.repairedLane!;
  return {
    value: formatSigned(lane.delta, 1),
    unit: lane.short,
    tone: "warn",
    title:
      `${lane.label} goes from ${formatSigned(lane.before, 1)} to ${formatSigned(lane.after, 1)}. ` +
      `This arrangement is on the list for that lane, not for the board — the whole-board ` +
      `figure is on the line below, and it is small by construction.`,
  };
}

/**
 * What the arrangement is, in the words a captain would use.
 *
 * Two heroes trading seats is by far the most common thing anyone does mid-
 * draft — carry and mid, mid and offlane, the two supports — and "Move 2 heroes"
 * describes it as though it were a reorganisation. It is a swap, and saying so
 * is the difference between a suggestion someone acts on and one they skim past.
 */
export function describeOption(option: RebalanceOption): string {
  const [a, b] = option.moves;
  // Not "and swap lanes": the seat trade below is already called a swap, and
  // "Swap Shadow Fiend and Earth Spirit and swap lanes" reads as one sentence
  // about one thing. The duos walking the other way is a second, separate move.
  const tail = option.swapsLanes ? " and walk the duos the other way" : "";

  if (!a) return "Swap lanes — nobody changes position";
  if (!b) return `Move ${a.name} to ${POSITION_LABEL[a.to].toLowerCase()}${tail}`;
  // A permutation that moves exactly two heroes can only be a straight trade,
  // but the check is cheap and it documents why the wording is safe.
  if (option.moves.length === 2 && a.from === b.to && b.from === a.to) {
    return `Swap ${a.name} and ${b.name}${tail}`;
  }
  return `Reseat ${option.moves.length} heroes${tail}`;
}

/**
 * The price of an option, in the same unit the shortlist is cut on.
 *
 * The list is a trade-off curve — one arrangement per amount of upheaval — and a
 * curve is unreadable if only one of its two axes is printed. The reward is the
 * big figure on the left; this is the cost, and it belongs next to the title.
 */
export function costOf(option: RebalanceOption): string {
  const moves = option.moves.length;
  if (!moves) return "lanes only";
  const heroes = `${moves} ${moves === 1 ? "move" : "moves"}`;
  return option.swapsLanes ? `${heroes} + lanes` : heroes;
}

/**
 * The gain broken back into the three things it is made of.
 *
 * All three, always. The panel is ranked on a sum, and a sum shown without its
 * parts is a number the reader has to take on trust — which is exactly the
 * position they were in when "board" was printed over a figure three points away
 * from the badge in the top bar. `lanes` joined them because it is usually the
 * term that moved: seating is what decides the laning stage, and it is the only
 * one of the three a captain can check against what they can see.
 */
export const breakdownOf = (option: RebalanceOption): string =>
  `draft ${formatSigned(option.gain.advantage, 1)} · lanes ${formatSigned(
    option.gain.lanes,
    1,
  )} · seats ${formatSigned(option.gain.fit, 1)}`;

/**
 * The top-bar button.
 *
 * It carries a figure because the case this feature exists for is the case you
 * would never think to click it in: the enemy answers your first pick and the
 * fix is one seat away. The figure never appears without the word that says what
 * it measures.
 */
export function buttonLabel(report: RebalanceReport | null): string {
  const best = report?.best;
  // A hero in a seat they do not play is a fact about the board, not a figure,
  // and it outranks one — the button says what is wrong rather than what the
  // fix is worth, because what the fix is worth is often negative.
  if (report?.offRole.length) {
    const n = report.offRole.length;
    return `Rebalance — ${n} off-role`;
  }
  if (best?.reason === "score") {
    return `Rebalance ${formatSigned(best.gain.total, 1)} ${TOTAL_UNIT}`;
  }
  if (best) return `Rebalance ${formatSigned(best.repairedLane!.delta, 1)} ${best.repairedLane!.short}`;
  return "Rebalance";
}

export function buttonTitle(report: RebalanceReport | null, readiness: Readiness): string {
  if (!readiness.ready) return `Rebalance — ${readiness.detail}`;
  if (!report) return "Check whether your heroes would be better off in other seats or lanes";

  const best = report.best;
  if (report.offRole.length) {
    const worst = report.offRole[0]!;
    const share = (worst.fit * 100).toFixed(worst.fit < 0.01 ? 2 : 0);
    const seats =
      `${nameList(report.offRole.map((seat) => seat.name))} ` +
      `${report.offRole.length === 1 ? "is" : "are"} in a position they play ${share}% of the time`;
    return best?.reason === "seat"
      ? `${seats} — open for the seatings that put them back`
      : `${seats}, and no rearrangement of these five fixes it — open for the detail`;
  }
  if (best?.reason === "score") {
    return (
      `Your five are worth ${formatSigned(best.gain.total, 1)} more arranged differently ` +
      `(${breakdownOf(best)}) — click for the options`
    );
  }
  if (best) {
    const lane = best.repairedLane!;
    return (
      `A seat change takes ${lane.label.toLowerCase()} from ${formatSigned(lane.before, 1)} to ` +
      `${formatSigned(lane.after, 1)} without costing the board anything`
    );
  }
  if (report.beyondThreshold.length) {
    return (
      `${report.beyondThreshold.length} arrangement(s) would help but need somebody below your ` +
      `role threshold — open to see them`
    );
  }
  return "Your five are already in the best seats the data can find";
}
