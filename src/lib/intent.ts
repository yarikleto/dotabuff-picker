import { NOISE, matchup } from "./scoring";
import { banSlugs, bansBy } from "./bans";
import type { BanEntry, Dataset, Hero, Settings } from "../types";

/**
 * Reading the enemy's bans as a statement about their next pick.
 *
 * Everything else in this app is a read on heroes that are on the board. This
 * is the one read on heroes that are *not* — and it exists because a ban list
 * is not just a list of heroes who are gone. A captain who spends three bans on
 * Earthshaker, Legion Commander and Axe has told you something, and the thing
 * they have told you is what they intend to pick. The picker could not see it
 * before, because it kept one flat ban list and could not say whose bans they
 * were: my own bans have exactly the same effect on availability and say
 * nothing whatsoever about their plan.
 *
 * The reading is deliberately conservative. Most bans are not part of a plan —
 * they are the same six overpowered heroes every draft removes — so the
 * arithmetic below spends most of its effort on *not* finding a signal.
 */

/**
 * How many heroes count as "the answers to" a hero.
 *
 * The denominator of the share, so it decides what fraction of a road counts as
 * cleared. Eight is about where a counter row stops being answers and starts
 * being heroes who are mildly ahead: past it the marginal entry is worth well
 * under a point and banning it would not have been a plan.
 */
export const ANSWER_POOL = 8;

/**
 * Two bans, or it did not happen.
 *
 * One ban landing on a hero's counter list is a coincidence — every hero worth
 * banning counters *someone*, and with 120-odd candidates the top of a
 * single-ban ranking is guaranteed to look meaningful. Two independent bans
 * agreeing is the smallest thing that is actually evidence.
 */
export const MIN_ANSWERS_GONE = 2;

/**
 * And they must be a real share of the hero's answers.
 *
 * Without this the list fills with heroes who have thirty mediocre counters and
 * happened to lose two of them. The heroes this reading exists to catch are the
 * opposite kind — few answers, each of them decisive — so requiring a quarter
 * of the road to be clear costs nothing there and silences the rest.
 */
export const MIN_CLEARED_SHARE = 0.25;

/** One banned hero who would have been an answer, and how much of one. */
export interface ClearedAnswer {
  slug: string;
  name: string;
  /** The banned hero's raw edge over the candidate, in percentage points. */
  advantage: number;
  /**
   * That edge net of how far ahead this hero runs against the pool at large —
   * the part that is actually about the candidate. See `generalEdge`.
   */
  specific: number;
  matches: number;
}

export interface Intent {
  hero: Hero;
  /**
   * Percentage points of specific counter-play the enemy's bans took off this
   * hero's path. The headline figure, and the one that feeds the ban score.
   *
   * In the same units as a matchup edge, and readable the same way: 6 points
   * cleared means the answers they removed were worth six points of
   * disadvantage to this hero between them.
   */
  cleared: number;
  /** Share of the hero's `ANSWER_POOL` answers now off the board, 0..1. */
  share: number;
  /** How many of their bans point here. */
  answersGone: number;
  /**
   * How many answers the share is measured over. Usually `ANSWER_POOL`, but a
   * high sample floor can leave a hero with fewer qualifying counters.
   */
  answerPool: number;
  /** Those bans, biggest first. */
  evidence: ClearedAnswer[];
  /**
   * The best answer to this hero still available to pick — the actionable half.
   * Null when they have cleared the road completely, which is the loudest thing
   * this panel can say.
   */
  answerLeft: { slug: string; name: string; advantage: number } | null;
}

/**
 * How far ahead a hero runs against the pool at large, in percentage points.
 *
 * The correction that keeps this from being a popularity contest. Wraith King
 * is banned in every draft and beats most of the hero pool, so without
 * subtracting his general strength he would read as evidence for whatever
 * candidate you asked about. What is evidence is the *excess* — that he is 6
 * points up on this hero and only 1.2 points up on an average one.
 */
function generalEdge(data: Dataset, settings: Settings): Map<string, number> {
  const out = new Map<string, number>();
  for (const hero of data.heroes) {
    let total = 0;
    let seen = 0;
    for (const other of data.heroes) {
      if (other.slug === hero.slug) continue;
      const m = matchup(data, hero.slug, other.slug);
      if (!m || m.matches < settings.minMatches) continue;
      total += m.advantage;
      seen++;
    }
    out.set(hero.slug, seen ? total / seen : 0);
  }
  return out;
}

/**
 * How much of `counter`'s edge over `hero` is about `hero` specifically.
 *
 * Zero unless the pairing is a real counter on its own terms *and* meaningfully
 * harder than this hero's usual day. Both tests are needed: the raw floor stops
 * a hero with a badly negative general edge from manufacturing evidence out of
 * a pairing they actually lose, and the excess stops a blanket-strong hero from
 * being read as a targeted ban.
 */
function specificEdge(
  data: Dataset,
  counter: string,
  hero: string,
  settings: Settings,
  general: Map<string, number>,
): { specific: number; advantage: number; matches: number } | null {
  const m = matchup(data, counter, hero);
  if (!m || m.matches < settings.minMatches) return null;
  if (!(m.advantage >= NOISE)) return null;
  /**
   * Only *positive* general strength is subtracted.
   *
   * The correction exists to stop a hero who beats everybody from reading as a
   * targeted ban. Applied symmetrically it does the opposite at the other end:
   * a hero who loses to most of the pool has a negative general edge, and
   * subtracting it would credit them with more targeted counter-play than
   * counter-play — a hero 1.2 points up on this matchup and 1.4 down on average
   * would score 2.6, which is not a quantity that exists. Specific edge can
   * never exceed the edge it is carved out of.
   */
  const specific = m.advantage - Math.max(0, general.get(counter) ?? 0);
  if (!(specific >= NOISE)) return null;
  return { specific, advantage: m.advantage, matches: m.matches };
}

interface Answer {
  slug: string;
  name: string;
  specific: number;
  advantage: number;
  matches: number;
}

/** A hero's `ANSWER_POOL` hardest specific counters, hardest first. */
function answersTo(
  data: Dataset,
  hero: Hero,
  settings: Settings,
  general: Map<string, number>,
): Answer[] {
  const out: Answer[] = [];
  for (const other of data.heroes) {
    if (other.slug === hero.slug) continue;
    const edge = specificEdge(data, other.slug, hero.slug, settings, general);
    if (!edge) continue;
    out.push({ slug: other.slug, name: other.name, ...edge });
  }
  out.sort((a, b) => b.specific - a.specific || b.matches - a.matches);
  return out.slice(0, ANSWER_POOL);
}

/**
 * Who answers whom, for the whole pool — the expensive half, cached.
 *
 * Two full passes over the matchup table: one for the general edges, one to
 * rank every hero's counters against them. Around 32,000 pairings on a live
 * table, which is nothing once but ruinous on every keystroke — the ban ranking
 * alone is re-run seven times per board change, once for the list and six more
 * for the robustness check.
 *
 * None of it depends on the draft. It depends on the dataset and on the sample
 * floor, so those are the key: a `WeakMap` on the dataset, holding one entry
 * per `minMatches` the session has actually used, and dropped whole when the
 * dataset is replaced.
 */
const answerBookCache = new WeakMap<Dataset, Map<number, Map<string, Answer[]>>>();

function answerBook(data: Dataset, settings: Settings): Map<string, Answer[]> {
  let perFloor = answerBookCache.get(data);
  if (!perFloor) {
    perFloor = new Map();
    answerBookCache.set(data, perFloor);
  }
  const cached = perFloor.get(settings.minMatches);
  if (cached) return cached;

  const general = generalEdge(data, settings);
  const book = new Map<string, Answer[]>();
  for (const hero of data.heroes) {
    book.set(hero.slug, answersTo(data, hero, settings, general));
  }
  perFloor.set(settings.minMatches, book);
  return book;
}

export interface IntentDraft {
  mine: { slug: string }[];
  enemy: { slug: string }[];
  banned: readonly BanEntry[];
}

/**
 * Every hero still available that their bans took at least one answer from,
 * split by the two tests into plans and near misses. One scan feeds both, so
 * the panel's explanation of a quiet board can never name a hero the reading
 * would have named.
 */
function scanIntent(
  data: Dataset,
  draft: IntentDraft,
  settings: Settings,
): { plans: Intent[]; misses: Intent[] } {
  const banned = new Set(bansBy(draft.banned, "enemy"));
  const taken = new Set([
    ...draft.mine.map((p) => p.slug),
    ...draft.enemy.map((p) => p.slug),
    ...banSlugs(draft.banned),
  ]);

  const book = answerBook(data, settings);
  const plans: Intent[] = [];
  const misses: Intent[] = [];

  for (const hero of data.heroes) {
    // A hero already on a team or in the ban list is not the pick anyone is
    // clearing the way for — including their own picks, which are evidence the
    // plan already happened rather than a prediction that it will.
    if (taken.has(hero.slug)) continue;

    const answers = book.get(hero.slug) ?? [];
    const gone = answers.filter((a) => banned.has(a.slug));
    if (!gone.length) continue;

    const mass = answers.reduce((sum, a) => sum + a.specific, 0);
    const cleared = gone.reduce((sum, a) => sum + a.specific, 0);
    const share = mass > 0 ? cleared / mass : 0;

    // The hardest answer they have *not* removed. Read off the same list, so
    // the hero named here is always one of the eight the share was measured
    // over — a captain can act on it directly.
    const left = answers.find((a) => !taken.has(a.slug)) ?? null;

    const intent: Intent = {
      hero,
      cleared,
      share,
      answersGone: gone.length,
      answerPool: answers.length,
      evidence: gone.map((a) => ({
        slug: a.slug,
        name: a.name,
        advantage: a.advantage,
        specific: a.specific,
        matches: a.matches,
      })),
      answerLeft: left && { slug: left.slug, name: left.name, advantage: left.advantage },
    };
    const isPlan = gone.length >= MIN_ANSWERS_GONE && share >= MIN_CLEARED_SHARE;
    (isPlan ? plans : misses).push(intent);
  }

  // Cleared points first, then the share, so between two heroes whose roads are
  // equally clear in absolute terms the one with fewer answers left leads.
  const byCleared = (a: Intent, b: Intent) => b.cleared - a.cleared || b.share - a.share;
  plans.sort(byCleared);
  misses.sort(byCleared);
  return { plans, misses };
}

/**
 * Which heroes the enemy has been clearing the way for, most cleared first.
 *
 * Reads only *their* bans. Mine remove the same heroes from the pool and are
 * deliberately ignored: they are evidence about my plan, and I already know it.
 *
 * Comes back empty far more often than not, and that is the design. It needs
 * two of their bans to land inside one hero's answer list and to account for a
 * quarter of it before it will say anything at all — see `MIN_ANSWERS_GONE`
 * and `MIN_CLEARED_SHARE`. A panel that always has an opinion about what the
 * enemy is planning is a panel that is guessing.
 */
export function readIntent(
  data: Dataset,
  draft: IntentDraft,
  settings: Settings,
  limit = 6,
): Intent[] {
  if (bansBy(draft.banned, "enemy").length < MIN_ANSWERS_GONE) return [];
  return scanIntent(data, draft, settings).plans.slice(0, limit);
}

/**
 * The heroes their bans came closest to clearing the way for, so a quiet panel
 * can say why it is quiet instead of guessing at a reason.
 *
 * Empty beside a real reading, where a near miss would read as a second, weaker
 * prediction, and below two bans, where the rule on its own is the explanation.
 */
export function readNearMisses(
  data: Dataset,
  draft: IntentDraft,
  settings: Settings,
  limit = 2,
): Intent[] {
  if (bansBy(draft.banned, "enemy").length < MIN_ANSWERS_GONE) return [];
  const { plans, misses } = scanIntent(data, draft, settings);
  return plans.length ? [] : misses.slice(0, limit);
}

/**
 * The same reading as a lookup, for the scorer and the grid badges.
 *
 * Deliberately built from `readIntent` rather than beside it: a hero the panel
 * declines to name must not quietly earn ban points anyway, and the only way to
 * guarantee that is for both to come out of one function.
 */
export function intentScores(
  data: Dataset,
  draft: IntentDraft,
  settings: Settings,
): Map<string, number> {
  return new Map(
    readIntent(data, draft, settings, Number.POSITIVE_INFINITY).map((i) => [i.hero.slug, i.cleared]),
  );
}
