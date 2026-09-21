import { canPlay, isCore, laneOpponents, playsRole, positionFit, positionWinRate } from "./roles";
import { earlyCover, earlyCoverPenalty, teamCover } from "./timing";
import { banSlugs } from "./bans";
import { laneCounter } from "./lanes";
import type { CounterReading } from "./lanes";
import type {
  BanEntry,
  Counter,
  Dataset,
  DraftPick,
  Hero,
  LanePlan,
  MatchupTable,
  Partner,
  Position,
  ScoreContribution,
  ScoreMode,
  ScorePart,
  Settings,
  Suggestion,
  SynergyCell,
  SynergyContribution,
  SynergyRow,
} from "../types";

/**
 * Percentage points below which a figure anywhere in this app is not worth a
 * colour, a word, or a decision.
 *
 * One constant for all of it, because the alternative is what the read-out
 * panel used to do: call −0.3 a coin flip in the headline and paint +0.1 green
 * two inches below it. The two numbers came from different noise floors — 0.5
 * for the verdict, 0.05 for everything else — and a reader has no way to know
 * that, so the panel was quietly contradicting itself in its own type.
 *
 * 0.5 is the honest floor. Dotabuff's two pages disagree by more than this on
 * roughly one pairing in ten, so anything smaller is inside the measurement
 * error of the source, never mind the model.
 *
 * It lives here rather than with the read-out because the same question is
 * asked of raw pairings — see `counters`, which will not call a hero an answer
 * to another on less than this.
 */
export const NOISE = 0.5;

export const DEFAULT_SETTINGS: Settings = {
  metaWeight: 0.5,
  synergyWeight: 1,
  laneWeight: 1,
  /**
   * Was 500 when the floor was the only defence against thin samples — a pair
   * seen 499 times was thrown away and one seen 501 times was trusted raw.
   * Advantages are now damped towards zero by their own sampling noise (see
   * `matchup`), so the cliff can sit lower and the shrinkage does the grading:
   * a 200-game edge arrives at roughly half size instead of not at all.
   */
  minMatches: 200,
  minSynergyMatches: 200,
  minWinRate: 0,
  /**
   * The share of a hero's games in a seat below which they are not offered for
   * it at all.
   *
   * Was 8%, and had to be while the score could not tell a rare seat from a bad
   * one: without a floor the pos 1 list filled with supports holding a good
   * matchup and no way to farm. `positionWinRate` now prices the seat itself —
   * Crystal Maiden reads 39.5% at pos 1, Treant 36.0%, which is −5 and −7 score
   * points before any matchup is counted — so the floor no longer has to do the
   * scoring's job, and at 5% it stops hiding the heroes it was never aimed at:
   * Leshrac safe-lanes in 7.6% of his games and wins 60.2% of them.
   */
  minRoleFit: 0.05,
  /**
   * See `Settings.intentWeight`. Half a point per point of counter-play the
   * enemy's bans cleared, so a loud signal — four of a hero's eight answers
   * gone — is worth a couple of score points and a quiet one is worth almost
   * nothing.
   */
  intentWeight: 0.5,
  /**
   * See `Settings.earlyWeight`. Two points at full shortfall — the same order
   * as a bad matchup, and reached only by a draft with nobody at all who
   * functions before the median game length.
   */
  earlyWeight: 2,
  /**
   * All ranks by default, the population every other figure in the app is
   * drawn from; a player who lives in a higher bracket should pick theirs.
   */
  rankBand: "all",
};

/** How much of a hero's pick rate feeds the "worth banning" score. */
const BAN_POPULARITY_WEIGHT = 0.2;

/**
 * A hero seated where they rarely go is charged by `positionWinRate`, which
 * carries the measured worth of a seat of that share — see `estimateSeatPrior`
 * in positions.ts. There is no second term for it, and there should not be:
 * a hand-set stretch cost added to a measured one is the same effect priced
 * twice, and the two disagreed. Leshrac wins 60.2% of 16,311 safe-lane games
 * and the pair of them together scored that seat at −0.12.
 *
 * What the old term got right is still true and still holds: a hero earns
 * nothing for being the *usual* occupant of a seat. That was a symmetric bonus
 * once, and it ranked the pos 1 list by how stereotyped a carry is — Spectre,
 * Juggernaut, Phantom Lancer, Anti-Mage, with the best safe-lane record in the
 * pool ninth. The seat prior cannot bring it back: above roughly a fifth of a
 * hero's games its mean is flat, so being played somewhere 95% of the time
 * rather than 40% is worth nothing at all.
 */

export interface Matchup {
  /**
   * Percentage points. Positive = `a` is favoured against `b`.
   *
   * Measured over games where the two were in the same match on opposite
   * sides — *not* over games where they stood in the same lane. Nothing in
   * this figure is lane-specific, whatever the caller groups it under.
   */
  advantage: number;
  matches: number;
  /** True when both heroes' pages agreed, so the number is averaged. */
  bothSides: boolean;
  /**
   * How far apart the two readings were, in percentage points.
   *
   * Dotabuff's two pages are scraped minutes apart from a rounded figure, so
   * they rarely land on the same number — and across the live table 1,556 of
   * 16,002 two-sided pairings disagree by more than half a point, which is the
   * same size as the edges this picker calls meaningful. Averaging hides that;
   * carrying it lets the read-out show how firm a number really is instead of
   * printing every one of them to one decimal as if they were equal.
   */
  spread: number;
}

/**
 * Sampling variance of an advantage figure, in pp².
 *
 * An advantage is a win-rate deviation measured over `matches` games, so its
 * noise is binomial: 100²·p(1−p)/n. When both pages were read, p(1−p) is
 * averaged across the two — they describe the *same* games, so averaging the
 * readings cancels rounding, not sampling, and the count must not be doubled.
 * Symmetric in the two heroes by construction, so `matchup(a,b)` and
 * `matchup(b,a)` damp by exactly the same factor.
 */
function advantageNoiseVar(matches: number, winRateA?: number, winRateB?: number): number {
  const pq = (wr: number | undefined) => {
    const p = Number.isFinite(wr) ? Math.min(0.85, Math.max(0.15, (wr as number) / 100)) : 0.5;
    return p * (1 - p);
  };
  const mean =
    winRateB === undefined ? pq(winRateA) : (pq(winRateA) + pq(winRateB)) / 2;
  return (10_000 * mean) / Math.max(1, matches);
}

/**
 * The table must hold at least this many distinct pairings before the spread
 * of real edges can be estimated from it. Below this — unit-test fixtures, a
 * `--only=axe,pudge` scrape — the method-of-moments number would be noise
 * about noise, and every advantage passes through undamped instead.
 */
export const MIN_PAIRS_FOR_MATCHUP_SHRINK = 500;

/**
 * How much *real* matchup edge exists across the table, in pp² — the same
 * method of moments the synergy pipeline uses: the observed spread of
 * advantages is signal plus sampling noise, and the noise part is known from
 * each pairing's sample size.
 *
 * Advantages are symmetric around zero by construction (every pairing reads
 * as +x from one side and −x from the other), so no mean needs estimating.
 */
export function estimateMatchupSpread(matchups: MatchupTable): number | null {
  const seen = new Set<string>();
  let n = 0;
  let sumSq = 0;
  let sumVar = 0;

  for (const [a, row] of Object.entries(matchups)) {
    for (const [b, forward] of Object.entries(row)) {
      if (a === b) continue;
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const reverse = matchups[b]?.[a];
      const advantage = reverse
        ? (-forward.disadvantage + reverse.disadvantage) / 2
        : -forward.disadvantage;
      const matches = reverse ? Math.min(forward.matches, reverse.matches) : forward.matches;
      if (!Number.isFinite(advantage) || !(matches > 0)) continue;

      n++;
      sumSq += advantage ** 2;
      sumVar += advantageNoiseVar(matches, forward.winRate, reverse?.winRate);
    }
  }

  if (n < MIN_PAIRS_FOR_MATCHUP_SHRINK) return null;
  return Math.max(0, sumSq / n - sumVar / n);
}

/**
 * Head-to-head advantage of `a` over `b`, in percentage points.
 *
 * Dotabuff publishes the same pairing on both heroes' pages with opposite
 * signs. Averaging the two readings cancels most of the rounding noise and
 * still works when only one page was scraped.
 *
 * When the dataset carries a `matchupSpread`, the figure is damped towards
 * zero by its own sampling noise — `signal / (signal + noise)`, the same
 * empirical-Bayes factor the synergy numbers already get. A 50,000-game
 * pairing keeps essentially all of what Dotabuff printed; a 300-game one
 * keeps the share its sample has earned. This is what lets `minMatches` sit
 * at 200 instead of 500 without handing thin noise a full vote.
 */
export function matchup(
  data: Pick<Dataset, "matchups" | "matchupSpread">,
  a: string,
  b: string,
): Matchup | null {
  if (a === b) return null;
  const forward = data.matchups[a]?.[b];
  const reverse = data.matchups[b]?.[a];

  const damp = (advantage: number, matches: number, wrA?: number, wrB?: number) => {
    const spread = data.matchupSpread;
    if (spread === null || spread === undefined) return advantage;
    if (spread <= 0) return 0;
    return advantage * (spread / (spread + advantageNoiseVar(matches, wrA, wrB)));
  };

  if (forward && reverse) {
    // The smaller of the two counts: both pages describe the same set of
    // games, so where they disagree the lower count is the one both readings
    // support. Quoting the larger inflates the sample behind a number that was
    // partly built from the smaller.
    const matches = Math.min(forward.matches, reverse.matches);
    return {
      advantage: damp(
        (-forward.disadvantage + reverse.disadvantage) / 2,
        matches,
        forward.winRate,
        reverse.winRate,
      ),
      matches,
      bothSides: true,
      spread: Math.abs(-forward.disadvantage - reverse.disadvantage),
    };
  }
  if (forward) {
    return {
      advantage: damp(-forward.disadvantage, forward.matches, forward.winRate),
      matches: forward.matches,
      bothSides: false,
      spread: 0,
    };
  }
  if (reverse) {
    return {
      advantage: damp(reverse.disadvantage, reverse.matches, reverse.winRate),
      matches: reverse.matches,
      bothSides: false,
      spread: 0,
    };
  }
  return null;
}

/**
 * `slug`'s own win rate against `against`, in percent.
 *
 * Dotabuff prints this on the hero's own page. The opponent's page carries the
 * same games from the other side, and with no draws in Dota the two readings
 * must sum to 100 — so where both were scraped they are averaged, for the same
 * reason `matchup` averages the advantages: rounding is the only thing that can
 * separate them, and averaging cancels most of it.
 */
function pairWinRate(data: Dataset, slug: string, against: string): number | null {
  const forward = data.matchups[slug]?.[against]?.winRate;
  const reverse = data.matchups[against]?.[slug]?.winRate;
  const mine = Number.isFinite(forward) ? (forward as number) : null;
  const theirs = Number.isFinite(reverse) ? 100 - (reverse as number) : null;
  if (mine !== null && theirs !== null) return (mine + theirs) / 2;
  return mine ?? theirs;
}

/**
 * The heroes who beat `slug`, worst matchup first.
 *
 * Read through the same `matchup` as everything else rather than off the raw
 * table, so a hero listed here as 3.2 ahead is the same 3.2 that will appear in
 * the matchup breakdown once they are actually on the board — same sample
 * floor, same shrinkage, same averaging of Dotabuff's two pages.
 *
 * The list is deliberately allowed to come back short, or empty. A hero whose
 * worst matchup is a fifth of a point does not have a counter, and padding the
 * row out to five icons would say they did — the whole value of this list is
 * that the heroes on it are worth spending a ban on.
 *
 * `position` narrows the field to heroes who actually play that role. The five
 * hardest answers to a hero are usually five cores, which is the wrong list for
 * the seat you are filling: a captain looking for a pos 4 cannot use a row of
 * carries, and the honest answer to "who counters this from the support slot" is
 * a different set of five heroes, not the same set with the numbers re-sorted.
 * That is why the filter has to happen here rather than over the finished row —
 * `slice(0, limit)` has already thrown the pos 4s away by then.
 */
export function counters(
  data: Dataset,
  slug: string,
  settings: Settings,
  limit = 5,
  position: Position | null = null,
): Counter[] {
  const out: Counter[] = [];

  for (const hero of data.heroes) {
    if (hero.slug === slug) continue;
    // `playsRole` rather than the ranking's own `minRoleFit`: this row claims to
    // be the answer for one seat, so a hero who merely turns up there sometimes
    // is a wrong answer, not a generous one. See `playsRole`.
    if (!playsRole(hero, position)) continue;
    const m = matchup(data, hero.slug, slug);
    // Written as a positive test so a non-finite advantage falls out here
    // rather than sorting to an arbitrary place in a list of five faces.
    if (!m || m.matches < settings.minMatches || !(m.advantage >= NOISE)) continue;
    out.push({
      hero,
      advantage: m.advantage,
      matches: m.matches,
      winRate: pairWinRate(data, slug, hero.slug),
      bothSides: m.bothSides,
      spread: m.spread,
    });
  }

  // Sample size breaks ties: between two heroes who both take 2.1 points off
  // this one, the one Dotabuff has watched more often is the firmer read.
  out.sort((a, b) => b.advantage - a.advantage || b.matches - a.matches);
  return out.slice(0, limit);
}

/**
 * The heroes `slug` belongs beside, best first — the mirror of `counters`.
 *
 * Synergies live on a much smaller scale than matchups — a full point is around
 * the 99th percentile of the table, where matchup edges routinely run past five
 * — so the same `NOISE` floor cuts far deeper here. That is the intent: it
 * leaves 10–25 candidates for a typical hero, and it lets the row come back
 * short for the fourteen or so heroes who genuinely have no standout partner.
 *
 * `position` narrows it to partners who play that role, for the same reason it
 * does in `counters`: "who does this hero want next" is a question about a seat.
 *
 * `ownPosition` is where `slug` already sits in the draft. With both seats
 * known the arrangement is a fact rather than a guess, so each pairing is read
 * through `synergy` exactly as `scoreWith` reads it when the pick list scores
 * the partner beside this hero — the row and the list print the same number
 * for the same pair. With either seat missing it is the blended figure, since
 * choosing a cell would mean inventing the arrangement it describes.
 *
 * The floors, the sort and the cut to `limit` all run on the figure actually
 * read. A pair whose blend clears `NOISE` only because of games played another
 * way round has to drop out here, and one whose blend hides a strong cell has
 * to get in.
 */
export function partners(
  data: Dataset,
  slug: string,
  settings: Settings,
  limit = 5,
  position: Position | null = null,
  ownPosition: Position | null = null,
): Partner[] {
  const out: Partner[] = [];
  // synergies.json is an optional download; without it there is nothing to say.
  const row = data.synergies?.[slug];
  if (!row) return out;

  for (const teammate of Object.keys(row)) {
    if (teammate === slug) continue;
    const hero = data.bySlug.get(teammate);
    // The same seat test the counter row uses — see `playsRole`.
    if (!hero || !playsRole(hero, position)) continue;
    const s = synergy(data, slug, teammate, ownPosition, position, settings.minSynergyMatches);
    if (!s || s.matches < settings.minSynergyMatches) continue;
    if (!(s.synergy >= NOISE)) continue;
    out.push({
      hero,
      synergy: s.synergy,
      matches: s.matches,
      winRate: s.winRate,
      positional: Boolean(s.fromCell),
    });
  }

  out.sort((a, b) => b.synergy - a.synergy || b.matches - a.matches);
  return out.slice(0, limit);
}

/**
 * A synergy row as read for one specific ask. `fromCell` says whether the
 * number actually came from the requested core/support cell — a row can carry
 * cells and still answer from the blend, when the cell asked for is absent or
 * under-sampled, and the read-out must not call that "scored by role".
 */
export interface SynergyReading extends SynergyRow {
  fromCell?: boolean;
}

/**
 * How much better `a` and `b` do on the same team than the two of them do
 * apart, in percentage points. Symmetric, and null when the pair was never
 * seen often enough to say.
 *
 * Passing both positions narrows the answer to the games where the two were
 * played that way round. It is worth doing wherever the positions are known:
 * across the live table a pairing's blended figure averages 3.45 different
 * position arrangements, and only 0.3% of pairs are as much as 90% one of them.
 * A pair with nothing position-specific to say returns its blended figure.
 *
 * `minMatches` is what makes the "never worse than asking without positions"
 * promise true rather than merely intended. Without it a thin cell is returned
 * on its own tiny sample, the caller's own floor rejects it, and the pairing
 * drops out of the score entirely — even though the blended figure it was
 * carved from would have sailed through. Pass the floor in and a cell too small
 * to trust falls back to the blend instead of taking the pairing down with it.
 */
export function synergy(
  data: Dataset,
  a: string,
  b: string,
  positionA: Position | null = null,
  positionB: Position | null = null,
  minMatches = 0,
): SynergyReading | null {
  if (a === b) return null;
  // Optional chaining on the table itself: synergies.json is a separate,
  // optional download, so a dataset without one must still score cleanly.
  const row = data.synergies?.[a]?.[b] ?? null;
  if (!row?.cells || !positionA || !positionB) return row;

  const cell = row.cells[synergyCell(positionA, positionB)];
  if (!cell || cell.matches < minMatches) return row;
  // The cell's own game count, so the sample floor judges the number actually
  // being used rather than the wider pool it was carved out of.
  return { ...row, synergy: cell.synergy, matches: cell.matches, fromCell: true };
}

/**
 * Which cell of the synergy table two positions land in, read in the order
 * given. `cs` means the first hero farmed and the second did not.
 */
export const synergyCell = (a: Position, b: Position): SynergyCell =>
  `${isCore(a) ? "c" : "s"}${isCore(b) ? "c" : "s"}` as SynergyCell;

/**
 * Would a hero in `position` share a lane with one in `against`?
 *
 * `plan` is the deployment: under a lane swap the safe duos meet each other
 * instead of the offlane duos, which is the whole content of the move — no
 * matchup number changes, only which of them are being fought over at minute
 * one, and therefore which of them the lane weight doubles.
 */
export function sharesLane(
  position: Position | null,
  against: Position | null,
  plan: LanePlan = "standard",
): boolean {
  if (!position || !against) return false;
  return laneOpponents(plan)[position].includes(against);
}

/**
 * Mean advantage of `candidate` against every hero in `opponents`.
 *
 * Opponents you would actually stand next to for the first ten minutes count
 * for more: losing your lane is a concrete, immediate problem, while a bad
 * matchup against their pos 5 across the map is a slower one.
 *
 * A lane confrontation is also the one place the advantage stops being a
 * whole-game average over every seat the two heroes play. STRATZ records what
 * happened to the *games* of a hero who stood in a particular seat against a
 * particular opponent, so where the board puts two heroes in the same lane and
 * that row exists, `laneCounter` adds what it says beyond Dotabuff's figure.
 * It is added into the pairing rather than kept as a term of its own: it is an
 * advantage, in the same points, about the same two heroes, and one lane pair
 * has no business swinging a score five times harder than the other four
 * matchups put together.
 */
/**
 * One pairing as the board has it deployed: the whole-game advantage, plus
 * whatever the lane table says about these two heroes at these two seats.
 *
 * The one place that sum is written down. `scoreAgainst` ranks candidates with
 * it and `draftBalance` reads the board with it, and the hero card prints both
 * two inches apart — so a second copy of this arithmetic would be a pair of
 * numbers that disagree about the same pairing in the same panel.
 */
function pairEdge(
  data: Dataset,
  mine: { slug: string; position: Position | null },
  theirs: DraftPick,
  settings: Settings,
  plan: LanePlan,
): { advantage: number; matches: number; sameLane: boolean; counter: CounterReading | null } | null {
  const m = matchup(data, mine.slug, theirs.slug);
  if (!m || m.matches < settings.minMatches) return null;
  const sameLane = sharesLane(mine.position, theirs.position, plan);
  const counter =
    sameLane && data.laneCounters && mine.position && theirs.position
      ? laneCounter(data.laneCounters, mine.slug, mine.position, theirs.slug, theirs.position)
      : null;
  return {
    advantage: m.advantage + (counter?.edge ?? 0),
    matches: m.matches,
    sameLane,
    counter,
  };
}

function scoreAgainst(
  data: Dataset,
  candidate: Hero,
  candidatePosition: Position | null,
  opponents: DraftPick[],
  settings: Settings,
  plan: LanePlan = "standard",
): { mean: number; contributions: ScoreContribution[] } {
  const contributions: ScoreContribution[] = [];
  let weighted = 0;
  let totalWeight = 0;

  for (const opponent of opponents) {
    const edge = pairEdge(
      data,
      { slug: candidate.slug, position: candidatePosition },
      opponent,
      settings,
      plan,
    );
    if (!edge) continue;
    const weight = edge.sameLane ? 1 + settings.laneWeight : 1;

    weighted += edge.advantage * weight;
    totalWeight += weight;
    contributions.push({
      slug: opponent.slug,
      name: data.bySlug.get(opponent.slug)?.name ?? opponent.slug,
      advantage: edge.advantage,
      matches: edge.matches,
      sameLane: edge.sameLane,
      ...(edge.counter ? { laneEdge: edge.counter.edge, laneLanes: edge.counter.lanes } : {}),
    });
  }

  // Lane opponents first, then by how favourable the matchup is.
  contributions.sort(
    (x, y) => Number(y.sameLane) - Number(x.sameLane) || y.advantage - x.advantage,
  );
  return { mean: totalWeight ? weighted / totalWeight : 0, contributions };
}

/**
 * Mean synergy of `candidate` with the heroes already on its own side.
 *
 * Not lane-weighted, unlike the matchup term: a support who makes your carry's
 * fights work does so at 30 minutes, wherever they stood at minute one. It is
 * still position-*aware* though, which is a different thing — what two heroes
 * are worth together depends on who is farming, and the table is cut on exactly
 * that. Where a pairing has nothing position-specific to say, this is the same
 * number it always was.
 */
function scoreWith(
  data: Dataset,
  candidate: Hero,
  candidatePosition: Position | null,
  allies: DraftPick[],
  settings: Settings,
): { mean: number; contributions: SynergyContribution[] } {
  const contributions: SynergyContribution[] = [];
  let total = 0;

  for (const ally of allies) {
    const s = synergy(
      data,
      candidate.slug,
      ally.slug,
      candidatePosition,
      ally.position,
      settings.minSynergyMatches,
    );
    if (!s || s.matches < settings.minSynergyMatches) continue;
    total += s.synergy;
    contributions.push({
      slug: ally.slug,
      name: data.bySlug.get(ally.slug)?.name ?? ally.slug,
      synergy: s.synergy,
      matches: s.matches,
      /**
       * True when this came from a core/support cell rather than the blend —
       * read off the reading itself, not off the row *having* cells: a row can
       * carry cells for other arrangements and still answer this ask from the
       * blend, and the card would have counted it as "scored by role" anyway.
       */
      positional: Boolean(s.fromCell),
    });
  }

  contributions.sort((x, y) => y.synergy - x.synergy);
  return { mean: contributions.length ? total / contributions.length : 0, contributions };
}

/**
 * Everything one hero is worth to a draft: the final score and every part that
 * went into it.
 *
 * Split out of `rank` so a single hero can be explained on demand — the grid
 * needs a read-out for tiles the suggestion lists filtered away, and it must be
 * the same arithmetic, not a second implementation of it.
 */
function evaluate(
  data: Dataset,
  hero: Hero,
  opponents: DraftPick[],
  allies: DraftPick[],
  position: Position | null,
  settings: Settings,
  mode: ScoreMode,
  plan: LanePlan = "standard",
  intent: Map<string, number> | null = null,
): Suggestion {
  const winRate = positionWinRate(hero, position);
  const { mean, contributions } = scoreAgainst(data, hero, position, opponents, settings, plan);
  const withTeam = scoreWith(data, hero, position, allies, settings);
  const roleFit = positionFit(hero, position);
  const metaScore =
    mode === "ban" ? winRate - 50 + BAN_POPULARITY_WEIGHT * (hero.pickRate ?? 0) : winRate - 50;

  /**
   * The one term that comes from the opponent rather than from the table.
   *
   * Everything else here is a fact about heroes, and facts about heroes are the
   * same in every draft. This is a fact about the captain on the other side:
   * they spent their own bans clearing this hero's answers off the board, which
   * is the only statement of intent a draft ever makes out loud. See
   * `readIntent`.
   *
   * Ban mode only. Picking asks what a hero is worth in *my* five, and a hero
   * the enemy has been angling for is not thereby better in my hands — the
   * conclusion to draw from their plan is that I should take the hero away, and
   * that is exactly the list this term is added to.
   *
   * Never negative: a hero their bans say nothing about scores zero rather than
   * being marked down, because "no evidence" and "evidence against" are
   * different claims and only one of them is in a ban list.
   */
  const intentScore = mode === "ban" ? intent?.get(hero.slug) ?? 0 : 0;

  /**
   * The one term that is about the line-up rather than the hero.
   *
   * Everything above asks what this hero is worth: their matchups, their
   * pairings, their record. None of it can see that the four heroes already on
   * the board have between them nothing that works before the median game
   * length — so the picker would go on recommending the fifth scaling hero,
   * each pick defensible on its own and the five together a draft that has to
   * survive a quarter of the duration distribution before it is allowed to
   * start winning.
   *
   * Charged against the *projected* five rather than the heroes present, so an
   * empty board costs nothing and the term arrives gradually as the hole is
   * actually dug.
   *
   * A consequence worth stating, because it used to be documented backwards:
   * on a genuinely empty board this term is identically zero for every
   * candidate and cannot order them at all. Four unfilled slots are worth
   * `4 × poolCover` — 2.06 on the live table — which already clears
   * `TARGET_EARLY_COVER` before the candidate is counted, so the shortfall is
   * zero whatever they bring. It first has something to say on the second pick,
   * where only three slots are projected. That is the intended shape — one hero
   * cannot yet have ruined a draft's timing — but the first-pick list is
   * therefore built from the other terms alone.
   */
  const teamEarlyCover = teamCover(
    [...allies.map((a) => data.bySlug.get(a.slug)), hero],
    data.timingShape,
  );
  const earlyPenalty = -earlyCoverPenalty(teamEarlyCover, settings.earlyWeight);

  const suggestion: Suggestion = {
    hero,
    // Filled in below, once the parts exist to add up. Left out of the literal
    // rather than given a placeholder so the type still demands it.
    score: 0,
    matchupScore: mean,
    synergyScore: withTeam.mean,
    metaScore,
    intentScore,
    roleFit,
    earlyCover: earlyCover(hero, data.timingShape),
    teamEarlyCover,
    earlyPenalty,
    winRate,
    position,
    contributions,
    synergyContributions: withTeam.contributions,
    covered: contributions.length,
  };

  suggestion.score = totalScore(suggestion, settings);
  return suggestion;
}

/**
 * The score taken apart into the terms it is the sum of, already weighted.
 *
 * The one place the composition of the score is written down. It used to be
 * written twice — once as the sum inside `evaluate`, once again as a list of
 * rows the hover card built by hand — and the two drifted apart the moment a
 * term was added. `intentScore` went into the sum and never got a row, so on a
 * hero the enemy's bans had been clearing the way for, the card's rows came to
 * +0.18 under a headline of +4.83 and offered no account of the missing 4.65.
 * A read-out whose own arithmetic does not close is worse than no read-out: it
 * teaches the reader that the numbers are made up.
 *
 * So the card now renders *this*, and `evaluate` sums *this*, and there is no
 * third place a term can hide. Adding one means adding it here, and both the
 * headline and the breakdown pick it up together.
 *
 * Every term is in score points and every term is from the scoring side's seat
 * — see `fromYourSide` for the flip that puts them on screen.
 */
export function scoreParts(s: Suggestion, settings: Settings): ScorePart[] {
  return [
    { term: "matchups", value: s.matchupScore },
    { term: "synergy", value: settings.synergyWeight * s.synergyScore },
    { term: "meta", value: settings.metaWeight * s.metaScore },
    { term: "intent", value: settings.intentWeight * s.intentScore },
    { term: "early", value: s.earlyPenalty },
  ];
}

/** The headline: the parts above, added up. */
export const totalScore = (s: Suggestion, settings: Settings): number =>
  scoreParts(s, settings).reduce((total, part) => total + part.value, 0);

interface RankOptions {
  data: Dataset;
  /** Heroes that cannot be suggested (already drafted or banned). */
  unavailable: Set<string>;
  /** Heroes the candidate is measured against. */
  opponents: DraftPick[];
  /** Heroes the candidate would be playing alongside. */
  allies: DraftPick[];
  /** The position being drafted for, or null for "any". */
  position: Position | null;
  settings: Settings;
  mode: ScoreMode;
  /** The deployment the board is currently on, for the lane weighting. */
  plan?: LanePlan;
  /**
   * Cleared counter-play per hero, read off the enemy's bans. Null in pick
   * mode and whenever their bans say nothing.
   */
  intent?: Map<string, number> | null;
  limit?: number;
}

function rank({
  data,
  unavailable,
  opponents,
  allies,
  position,
  settings,
  mode,
  plan = "standard",
  intent = null,
  limit = 12,
}: RankOptions): Suggestion[] {
  const out: Suggestion[] = [];

  for (const hero of data.heroes) {
    if (unavailable.has(hero.slug)) continue;
    if (!canPlay(hero, position, settings.minRoleFit)) continue;

    if (
      settings.minWinRate > 0 &&
      positionWinRate(hero, position) < settings.minWinRate
    ) {
      continue;
    }

    out.push(evaluate(data, hero, opponents, allies, position, settings, mode, plan, intent));
  }

  out.sort((a, b) => b.score - a.score || (b.hero.winRate ?? 0) - (a.hero.winRate ?? 0));
  return Number.isFinite(limit) ? out.slice(0, limit) : out;
}

export interface DraftView {
  mine: DraftPick[];
  enemy: DraftPick[];
  /**
   * Bans, as slugs or as attributed entries — see `BanEntry`.
   *
   * The union is here so that availability, which is all most of this file
   * cares about, never had to learn about sides. Only the ban ranking reads the
   * side, and it does so through `readIntent`; everything else asks the list
   * which heroes are gone and gets the same answer either way.
   */
  banned: readonly BanEntry[];
  /**
   * How the duos are deployed. Optional, and absent means `"standard"` — every
   * caller that predates lane swaps keeps the arrangement it was written for.
   */
  lanePlan?: LanePlan;
}

const takenSlugs = (draft: DraftView) =>
  new Set([
    ...draft.mine.map((p) => p.slug),
    ...draft.enemy.map((p) => p.slug),
    ...banSlugs(draft.banned),
  ]);

/**
 * The whole hero pool ranked for one mode, best first — no `limit`.
 *
 * `suggestPicks`/`suggestBans` are the top-N views of this; the grid uses the
 * full list to order every tile. Heroes that fail the role or win-rate filters
 * are still left out, so callers ordering the complete pool need a fallback for
 * the ones missing here.
 *
 * Both modes run the same ranking, just from opposite seats: picking asks "who
 * fits my team and beats theirs", banning asks the mirror question on the
 * enemy's behalf. Whatever comes out on top of *their* list is the hero you do
 * not want them to have.
 *
 * `intent` is the enemy's bans read as a statement about their next pick — see
 * `readIntent`. Handed in rather than worked out here, for two reasons: it is a
 * full pass over the matchup table and this function runs seven times per board
 * change, and the panel that *names* the heroes must be reading the same map
 * that scored them. Omitting it scores exactly as the picker did before the
 * reading existed.
 */
export function rankAll(
  data: Dataset,
  draft: DraftView,
  settings: Settings,
  position: Position | null,
  mode: ScoreMode,
  intent: Map<string, number> | null = null,
): Suggestion[] {
  return rank({
    data,
    unavailable: takenSlugs(draft),
    opponents: mode === "ban" ? draft.mine : draft.enemy,
    allies: mode === "ban" ? draft.enemy : draft.mine,
    position,
    settings,
    mode,
    plan: draft.lanePlan,
    intent,
    limit: Number.POSITIVE_INFINITY,
  });
}

/**
 * Heroes to pick: ranked by how well they match up into the enemy line-up,
 * blended with their win rate in the position you are drafting for.
 */
export function suggestPicks(
  data: Dataset,
  draft: DraftView,
  settings: Settings,
  position: Position | null = null,
  limit = 12,
) {
  return rankAll(data, draft, settings, position, "pick").slice(0, limit);
}

/**
 * Heroes to ban: the enemy's own best next pick. Ranked by how hard they
 * counter the heroes *you* have taken, how well they slot in beside the heroes
 * *they* have taken, win rate, how often the hero actually gets picked, and —
 * when `intent` is supplied — how visibly the enemy has been clearing this
 * hero's answers off the board with their own bans.
 */
export function suggestBans(
  data: Dataset,
  draft: DraftView,
  settings: Settings,
  position: Position | null = null,
  limit = 12,
  intent: Map<string, number> | null = null,
) {
  return rankAll(data, draft, settings, position, "ban", intent).slice(0, limit);
}

/**
 * The full read-out for one hero, whether or not the suggestion lists would
 * have offered them.
 *
 * `rankAll` drops heroes below the role and win-rate thresholds, and a drafted
 * hero is dropped from both lists outright — but you still want to know what
 * they are worth when you hover their tile, so this skips every filter and
 * scores them anyway.
 */
export function heroDetail(
  data: Dataset,
  draft: DraftView,
  settings: Settings,
  slug: string,
  position: Position | null,
  mode: ScoreMode,
  intent: Map<string, number> | null = null,
): Suggestion | null {
  const hero = data.bySlug.get(slug);
  if (!hero) return null;
  return evaluate(
    data,
    hero,
    // Banning asks the same question from the enemy's seat: their candidate is
    // measured against your line-up and beside theirs.
    mode === "ban" ? draft.mine : draft.enemy,
    mode === "ban" ? draft.enemy : draft.mine,
    position,
    settings,
    mode,
    draft.lanePlan,
    intent,
  );
}

/**
 * Per-hero read-out against a set of drafted heroes, and alongside your own —
 * used for the tile badges in the grid.
 */
export function explain(
  data: Dataset,
  slug: string,
  position: Position | null,
  opponents: DraftPick[],
  settings: Settings,
  allies: DraftPick[] = [],
  plan: LanePlan = "standard",
) {
  const hero = data.bySlug.get(slug);
  if (!hero) {
    return {
      mean: 0,
      contributions: [] as ScoreContribution[],
      synergyMean: 0,
      synergyContributions: [] as SynergyContribution[],
    };
  }
  const against = scoreAgainst(data, hero, position, opponents, settings, plan);
  const withTeam = scoreWith(data, hero, position, allies, settings);
  return {
    ...against,
    synergyMean: withTeam.mean,
    synergyContributions: withTeam.contributions,
  };
}

/** Mean synergy inside one line-up, in percentage points. */
function teamSynergy(data: Dataset, team: DraftPick[], settings: Settings) {
  let total = 0;
  let pairs = 0;
  for (let i = 0; i < team.length; i++) {
    for (let j = i + 1; j < team.length; j++) {
      const [a, b] = [team[i], team[j]];
      if (!a || !b) continue;
      // Both sides of the board are booked into positions, so the cells apply
      // here too — otherwise the balance read would disagree with the panel.
      const s = synergy(
        data,
        a.slug,
        b.slug,
        a.position,
        b.position,
        settings.minSynergyMatches,
      );
      if (!s || s.matches < settings.minSynergyMatches) continue;
      total += s.synergy;
      pairs++;
    }
  }
  return { mean: pairs ? total / pairs : 0, pairs };
}

/**
 * Where the draft stands, in percentage points.
 *
 * Two independent halves: how the head-to-head matchups fall, and how much
 * better your five work together than theirs do. A line-up can be losing every
 * individual matchup and still be ahead because it actually functions as a
 * team, which is precisely the read a counter-only picker cannot give you.
 */
export function draftBalance(data: Dataset, draft: DraftView, settings: Settings) {
  if (!draft.mine.length || !draft.enemy.length) return null;
  let weighted = 0;
  let totalWeight = 0;
  let pairs = 0;

  for (const a of draft.mine) {
    for (const b of draft.enemy) {
      const edge = pairEdge(data, a, b, settings, draft.lanePlan ?? "standard");
      if (!edge) continue;
      const weight = edge.sameLane ? 1 + settings.laneWeight : 1;
      weighted += edge.advantage * weight;
      totalWeight += weight;
      pairs++;
    }
  }

  const mine = teamSynergy(data, draft.mine, settings);
  const theirs = teamSynergy(data, draft.enemy, settings);
  const synergyEdge = mine.mean - theirs.mean;
  const counter = totalWeight ? weighted / totalWeight : 0;

  /**
   * The third half of the read: whether either side has drafted a game it has
   * to survive to reach.
   *
   * Matchups and synergy are both measured over whole games and are silent
   * about *when* within one they apply, so a draft can be ahead on both and
   * still be the one that gets closed out at thirty minutes. This is that
   * risk, differenced the same way synergy is — their shortfall is my gain —
   * and it is the only term here that can push the headline the other way
   * without a single pairing changing.
   */
  const myCover = teamCover(
    draft.mine.map((p) => data.bySlug.get(p.slug)),
    data.timingShape,
  );
  const theirCover = teamCover(
    draft.enemy.map((p) => data.bySlug.get(p.slug)),
    data.timingShape,
  );
  const earlyEdge =
    earlyCoverPenalty(theirCover, settings.earlyWeight) -
    earlyCoverPenalty(myCover, settings.earlyWeight);

  /**
   * Nothing to say only if *nothing* is known — and the timing shortfall now
   * counts as something. A board with no usable pairing and no usable synergy
   * used to read as null even when one side had visibly drafted five heroes
   * who cannot play before the median game, which is a real difference between
   * the two line-ups and the only one the data could see.
   */
  if (!pairs && !mine.pairs && !theirs.pairs && !earlyEdge) return null;
  return {
    /** The headline number: matchups, synergy and timing risk together. */
    advantage: counter + settings.synergyWeight * synergyEdge + earlyEdge,
    /** Head-to-head half, on its own. */
    counter,
    /** Team-cohesion half, on its own. */
    synergyEdge,
    mySynergy: mine.mean,
    theirSynergy: theirs.mean,
    /** Their early-game shortfall minus mine, in points; positive favours me. */
    earlyEdge,
    /** Bodies on each side that function before the median game length. */
    myEarlyCover: myCover,
    theirEarlyCover: theirCover,
    pairs,
    synergyPairs: mine.pairs + theirs.pairs,
  };
}

/**
 * The weightings a reasonable captain might plausibly be using.
 *
 * Not a grid search over everything the sliders allow — the ends of those
 * ranges are deliberate extremes ("ignore my own team entirely") and a hero
 * that survives *those* has proved nothing about the middle. These are the
 * corners of the region people actually sit in: counter-heavy, meta-heavy,
 * synergy-heavy, lane-blind, lane-obsessed, timing-blind, timing-obsessed.
 *
 * The last four matter more than they look. The timing penalty is the only term
 * that judges a candidate on the company they keep, so it is the one most
 * likely to be doing the work behind a recommendation the reader would not
 * otherwise expect — and a hero who survives both `earlyWeight: 0` and
 * `earlyWeight: 4` is one the timing read is not quietly responsible for.
 *
 * The intent term earns its own pair for a stronger reason still: it is the
 * only term built on an *inference about a person* rather than on a table of
 * games. A hero who leads the ban list at `intentWeight: 0` is one the data
 * wanted banned anyway; a hero who leads only at 1.5 is there because of a
 * guess about what the enemy is planning, and the star is exactly the mark that
 * should not be given to a guess.
 */
const ROBUSTNESS_CORNERS: Array<Partial<Settings>> = [
  { metaWeight: 0, synergyWeight: 1, laneWeight: 1 },
  { metaWeight: 1, synergyWeight: 1, laneWeight: 1 },
  { metaWeight: 0.5, synergyWeight: 0, laneWeight: 1 },
  { metaWeight: 0.5, synergyWeight: 2, laneWeight: 1 },
  { metaWeight: 0.5, synergyWeight: 1, laneWeight: 0 },
  { metaWeight: 0.5, synergyWeight: 1, laneWeight: 2 },
  { metaWeight: 0.5, synergyWeight: 1, laneWeight: 1, earlyWeight: 0 },
  { metaWeight: 0.5, synergyWeight: 1, laneWeight: 1, earlyWeight: 4 },
  { metaWeight: 0.5, synergyWeight: 1, laneWeight: 1, intentWeight: 0 },
  { metaWeight: 0.5, synergyWeight: 1, laneWeight: 1, intentWeight: 1.5 },
];

/**
 * Heroes that stay near the top however the weights are set.
 *
 * A ranked list hides how much of itself is an artefact of the sliders. Two
 * heroes a tenth of a point apart look equally recommended, but one of them
 * may lead only because synergy happens to be weighted at 1 and drop twenty
 * places at 0.5 — and the reader has no way to see that. This re-runs the
 * ranking at each corner of the plausible weighting space and returns the
 * slugs that never leave the top `depth`.
 *
 * The point is honesty about which recommendations are conclusions and which
 * are settings. A hero marked robust is one the data likes; an unmarked hero
 * near the top is one *this configuration* likes.
 */
export function robustPicks(
  data: Dataset,
  draft: DraftView,
  settings: Settings,
  position: Position | null,
  mode: ScoreMode,
  depth = 5,
  intent: Map<string, number> | null = null,
): Set<string> {
  let survivors: Set<string> | null = null;

  for (const corner of ROBUSTNESS_CORNERS) {
    // Only the weights move. Sample floors and role thresholds are the user's
    // statement about what counts as evidence, not a taste to be second-guessed.
    // The intent map is a reading of the board rather than a weighting, so it is
    // the same at every corner — `intentWeight` is what varies across them.
    const top = rankAll(data, draft, { ...settings, ...corner }, position, mode, intent)
      .slice(0, depth)
      .map((s) => s.hero.slug);

    survivors = survivors
      ? new Set(top.filter((slug) => survivors!.has(slug)))
      : new Set(top);
    if (!survivors.size) break;
  }

  return survivors ?? new Set();
}

/**
 * A hero the role filter hides, kept back by a lane reading that says they
 * beat somebody in particular from a seat they hardly ever take.
 */
export interface OffRolePick {
  suggestion: Suggestion;
  /** The lane pairing that earns the stretch. */
  against: ScoreContribution;
}

/**
 * The counter-picks the suggestion list is not allowed to make.
 *
 * `minRoleFit` throws out every hero who plays a seat less than 5% of the time,
 * and it is right to: a hero nobody is ever put in a seat has no record there
 * worth ranking. But that floor is a statement about how heroes are *usually*
 * deployed, and the whole point of an off-meta counter-pick is that it is not
 * usual. Pudge is a pos 1 in 1.8% of his games, and in the 3,948 lanes where he
 * was one against an Axe he won 55.7% of the games — four points clear of what
 * his seat and their whole-game matchup predict.
 *
 * So the floor stays where it is, and this is the short list of what it is
 * hiding: heroes below it whose *seat-specific* reading against a hero already
 * on the board clears the app's noise floor, and who still score positively
 * with their record in that seat counted — which this thinly played is several
 * points below their own figure. Nothing here is a recommendation to lock a
 * support into the safe lane — it is the answer to "is there a strange pick
 * that beats what they have taken", which the main list cannot give.
 *
 * Pick mode only. The mirror question — whether the enemy might cheese *you* —
 * is not worth a ban: a hero nobody picks in a seat is not a hero to spend a
 * ban on.
 */
export function offRolePicks(
  data: Dataset,
  draft: DraftView,
  settings: Settings,
  position: Position | null,
  limit = 3,
): OffRolePick[] {
  if (!position || !data.laneCounters || settings.minRoleFit <= 0) return [];

  const lifted = { ...settings, minRoleFit: 0, minWinRate: 0 };
  const out: OffRolePick[] = [];
  for (const suggestion of rankAll(data, draft, lifted, position, "pick")) {
    // Only what the floor hides: everything above it is in the list already.
    if (canPlay(suggestion.hero, position, settings.minRoleFit)) continue;
    if (suggestion.score <= 0) continue;
    const against = suggestion.contributions
      .filter((c) => (c.laneEdge ?? 0) >= NOISE)
      .sort((x, y) => (y.laneEdge ?? 0) - (x.laneEdge ?? 0))[0];
    if (!against) continue;
    out.push({ suggestion, against });
    if (out.length >= limit) break;
  }
  return out;
}

export const formatSigned = (n: number, digits = 2) => {
  const abs = Math.abs(n).toFixed(digits);
  // Sign of the *printed* value: −0.004 at two digits is "+0.00", not "−0.00" —
  // a direction the rounding just erased must not survive in the sign.
  return `${n < 0 && Number(abs) !== 0 ? "−" : "+"}${abs}`;
};
