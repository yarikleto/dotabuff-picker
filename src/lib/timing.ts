import type { Hero, TimingShape } from "../types";

/**
 * When a draft is meant to win, treated as something it can be *wrong* about.
 *
 * The game-length card already reads out four windows and names the one that
 * is yours. What it could not do — and what nothing in the score could do — is
 * notice that a line-up has arranged for all of its value to arrive after the
 * point where most games are already over. Five heroes who are excellent at
 * fifty minutes have a mean matchup edge, a mean synergy edge and a meta score
 * like any other five, so the picker recommended them one at a time and never
 * once mentioned that the draft they added up to has no first half.
 *
 * Two facts out of the timing table make that sayable:
 *
 * 1. **Games do not end uniformly.** In the live sample 2.1% finish before
 *    25′, 24.2% between 25 and 35, 41.1% between 35 and 45 and 32.6% after
 *    that. The card weighted all four windows the same, so a draft could read
 *    as "+1.8 in the last window, −4.0 in the first" and look net positive
 *    while the honest weighted figure was zero.
 *
 * 2. **Scaling is very nearly one-dimensional.** Across the pool a hero's skew
 *    in the 25–35 window correlates −0.93 with their skew after 45 minutes.
 *    Stacking heroes who are good late is therefore not a neutral act with a
 *    late-game upside; it is a purchase, and the price is paid in the windows
 *    where a quarter of games are decided.
 *
 * The mean is the wrong statistic for the second point, which is why this is a
 * separate module rather than another row on the stage card. Five heroes at
 * −3 and one hero at −15 beside four at zero have the same mean and are not
 * the same draft: the second can still hold two lanes. What matters is how
 * many bodies function early — a floor, not an average — so the figures here
 * are built by counting, and only then averaged.
 */

/**
 * Percentage points of early skew that buy one whole "body" of early-game
 * cover, measured from an average hero.
 *
 * Set from the pool's own spread rather than taste: blended early skew across
 * the 127 heroes in the live table has a median of +0.4 and a standard
 * deviation of 4.0, so ±3 puts the saturation points near the 15th and 85th
 * percentiles. Wider and almost nobody counts as a full body; narrower and a
 * third of the pool saturates at each end and the measure stops discriminating
 * between "fine early" and "wins the game in fifteen minutes".
 */
export const EARLY_SCALE = 3;

/**
 * How many heroes a line-up needs who function before the median game length.
 *
 * This is a judgement, not a fit, and it is the one number here that a reader
 * should feel free to disagree with — the data can say how heroes differ, but
 * nothing in `public_matches` says how much early-game cover a draft needs,
 * because that would take per-draft outcomes joined to composition and the
 * sample per composition is one.
 *
 * Two is the defensible answer: three lanes, and a draft that cannot contest
 * two of them is choosing to be behind everywhere at once. The pool average
 * hero is worth 0.51 of a body, so five random heroes come to roughly 2.6 and
 * pay nothing at all — which is the intent. This penalty is meant to be silent
 * on ordinary drafts and to speak only when a line-up has genuinely stacked.
 */
export const TARGET_EARLY_COVER = 2;

/** Heroes on a full side, for projecting a part-finished draft forward. */
const TEAM_SIZE = 5;

/**
 * Share of games ending in each window, derived from the table itself.
 *
 * Every match contributes one row per hero to each window it could have ended
 * in, so summing the per-hero game counts down a column and normalising gives
 * the duration distribution without the collector having to record it — which
 * matters because it means an existing `timings.json` gains this for free, and
 * a re-scrape with different bucket boundaries is picked up automatically.
 *
 * Thin heroes are included on purpose. Their *skews* are shrunk towards zero
 * because a small sample cannot support a strong claim, but their game counts
 * are the sample, and dropping them would bias the distribution towards
 * whatever the popular heroes' games look like.
 */
export function deriveTimingShape(heroes: Hero[], bucketCount: number): TimingShape | null {
  if (bucketCount <= 0) return null;

  const totals = new Array<number>(bucketCount).fill(0);
  for (const hero of heroes) {
    const rows = hero.timings;
    if (!rows || rows.length !== bucketCount) continue;
    for (let i = 0; i < bucketCount; i++) totals[i] = (totals[i] ?? 0) + (rows[i]?.games ?? 0);
  }

  const sum = totals.reduce((a, b) => a + b, 0);
  if (!(sum > 0)) return null;
  const shares = totals.map((t) => t / sum);

  /**
   * The windows that close before the median game — the ones a draft has to
   * survive rather than win in. Read off the cumulative distribution rather
   * than hard-coded as "the first two", so a collector run with different
   * boundaries relabels this correctly instead of silently measuring the wrong
   * stretch of the game.
   */
  const earlyWindows: number[] = [];
  let cumulative = 0;
  for (let i = 0; i < bucketCount; i++) {
    if (cumulative + shares[i]! >= 0.5) break;
    earlyWindows.push(i);
    cumulative += shares[i]!;
  }

  // A degenerate table where the first window already holds half the games
  // leaves nothing to average over; fall back to that window alone rather than
  // returning a shape whose early figures are all null.
  if (!earlyWindows.length) {
    earlyWindows.push(0);
    cumulative = shares[0]!;
  }

  const earlyWeights = earlyWindows.map((i) => shares[i]! / cumulative);
  const shape: TimingShape = {
    shares,
    earlyWindows,
    earlyWeights,
    earlyMass: cumulative,
    poolCover: 0.5,
  };

  // The value of a slot not yet drafted, needed to project a part-finished
  // side forward. Measured, not assumed to be 0.5: the pool is not symmetric
  // about the saturation points and the figure drifts with the patch.
  const covers: number[] = [];
  for (const hero of heroes) {
    const cover = earlyCover(hero, shape);
    if (cover !== null) covers.push(cover);
  }
  if (covers.length) {
    shape.poolCover = covers.reduce((a, b) => a + b, 0) / covers.length;
  }

  return shape;
}

/**
 * How a hero does in the windows that close before the median game, in
 * percentage points either side of their own baseline.
 *
 * Weighted by how often games actually end in each of those windows, so the
 * 25–35 window — a quarter of all games — carries eleven times the 2% that end
 * before 25 minutes. Weighting them equally is what let a hero look "fine
 * early" on the strength of the rarest window on the board.
 *
 * Null when the collector never saw the hero, which is different from zero and
 * has to stay different: a hero with no timing row is unknown, not average,
 * and counting them as average would quietly fill a draft's early-game hole
 * with heroes nobody has measured.
 */
export function earlySkew(hero: Hero, shape: TimingShape | null): number | null {
  if (!shape || !hero.timings) return null;
  let total = 0;
  let weight = 0;
  shape.earlyWindows.forEach((bucket, k) => {
    const row = hero.timings?.[bucket];
    if (!row || !(row.games > 0)) return;
    total += row.skew * shape.earlyWeights[k]!;
    weight += shape.earlyWeights[k]!;
  });
  if (!(weight > 0)) return null;
  // Renormalised over the windows actually present, so a hero missing the
  // thinnest window is read from the rest rather than dragged towards zero.
  return total / weight;
}

/**
 * How much of an early-game body a hero is worth, 0 to 1.
 *
 * An average hero is half a body, a hero `EARLY_SCALE` points better than
 * average is a whole one, and the same distance below is none. The clamp is
 * the point: Sniper being extraordinary before 35 minutes does not excuse four
 * heroes who are not there, and without a ceiling one outlier would paper over
 * exactly the draft this measure exists to catch.
 */
export function earlyCover(hero: Hero, shape: TimingShape | null): number | null {
  const skew = earlySkew(hero, shape);
  if (skew === null) return null;
  return Math.max(0, Math.min(1, 0.5 + skew / (2 * EARLY_SCALE)));
}

/**
 * A side's early-game cover, counted in bodies, with undrafted slots valued at
 * the pool average.
 *
 * The projection is what makes this usable during a draft rather than only
 * after it. Scored on the heroes present alone, a first pick would carry the
 * whole shortfall of an empty board and every candidate would be judged as if
 * the other four slots were already wasted. Filling the empty slots with the
 * average hero says the honest thing instead: nothing is wrong yet, and a
 * candidate is measured by what they do to a draft that otherwise turns out
 * ordinary.
 *
 * Heroes with no timing row are also valued at the pool average, for the same
 * reason and with the same effect — they neither create nor fill a hole.
 */
export function teamCover(
  heroes: Array<Hero | undefined>,
  shape: TimingShape | null,
  teamSize = TEAM_SIZE,
): number | null {
  if (!shape) return null;
  let total = 0;
  let slots = 0;
  let measured = 0;

  for (const hero of heroes) {
    if (slots >= teamSize) break;
    slots++;
    const cover = hero ? earlyCover(hero, shape) : null;
    if (cover === null) {
      total += shape.poolCover;
      continue;
    }
    total += cover;
    measured++;
  }

  if (!measured) return null;
  total += Math.max(0, teamSize - slots) * shape.poolCover;
  return total;
}

/**
 * What a side's early-game shortfall costs it, in percentage points.
 *
 * Convex, and zero until the shortfall is real. A draft's first scaling hero
 * is free and its second nearly so — they are supposed to be there, and a
 * linear penalty would have the picker talking you out of the one carry every
 * line-up needs. The cost then grows as the square of the gap, so the third,
 * fourth and fifth cost 2.25, 4 and 6.25 times what the second did, which is
 * the shape the complaint actually has: nobody loses a game for owning a
 * Medusa, they lose it for owning a Medusa and four heroes who cannot buy her
 * the twenty minutes.
 *
 * Squared rather than any steeper power because this is one input to a draft
 * and not a rule. At full shortfall it is worth `weight` points — comparable
 * to a large matchup edge, and deliberately not larger than one.
 */
export function earlyCoverPenalty(cover: number | null, weight: number): number {
  if (cover === null || !(weight > 0)) return 0;
  const shortfall = Math.max(0, TARGET_EARLY_COVER - cover);
  return weight * (shortfall / TARGET_EARLY_COVER) ** 2;
}

/**
 * A side's timing edge weighted by how often games actually reach each window.
 *
 * The number the stage card should have led with. An unweighted mean of the
 * four window edges treats the 2% of games that end before 25 minutes as
 * mattering exactly as much as the 41% that end between 35 and 45, and a draft
 * built to win late scores well on that mean by being enormous in a window
 * that a third of games reach.
 *
 * The weights are the population's, not this draft's, and that is a real
 * approximation: a side that dominates early ends games early, so duration is
 * partly an outcome of the very thing being measured. Correcting for it would
 * need per-draft durations, which the table does not carry. The population
 * distribution is a much better prior than the flat one it replaces, and the
 * bias it leaves runs *against* late-heavy drafts being flattered, which is
 * the safe direction for a figure whose job is to warn about them.
 */
export function weightedEdge(edges: number[], shape: TimingShape | null): number | null {
  if (!shape || edges.length !== shape.shares.length) return null;
  return edges.reduce((sum, edge, i) => sum + edge * shape.shares[i]!, 0);
}

/**
 * The share of games that finish before this draft is ahead.
 *
 * The one figure here a captain can act on directly. Scanning the windows in
 * order and stopping at the first whose edge clears the noise floor answers
 * "how much of the distribution do we have to survive to reach the game we
 * drafted for" — and for a line-up whose edge only arrives after 45 minutes
 * the answer is most of it.
 *
 * Returns 1 when no window is ever clearly yours, which is the honest reading
 * of a draft that is behind at every length: there is no point to survive to.
 *
 * `floor` is passed in rather than imported so this module stays free of any
 * dependency on the scorer — `scoring.ts` imports the penalty from here, and a
 * cycle between the two would work right up until one of them grew a constant
 * that was read at module load.
 */
export function exposure(
  edges: number[],
  shape: TimingShape | null,
  floor: number,
): number | null {
  if (!shape || edges.length !== shape.shares.length) return null;
  let share = 0;
  for (let i = 0; i < edges.length; i++) {
    if (edges[i]! >= floor) return share;
    share += shape.shares[i]!;
  }
  return 1;
}
