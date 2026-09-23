import type { CounterModel, LaneModel } from "./lib/lanes";
import type { Calibration } from "./lib/winModel";

export type HeroAttr = "str" | "agi" | "int" | "uni";

/** Where a hero sits in the current draft. */
export type Slot = "mine" | "enemy" | "banned";

/**
 * Which side spent a ban.
 *
 * Kept apart from `Slot` on purpose. A ban puts a hero in exactly one place —
 * off the board — so as far as availability goes there is nothing to
 * distinguish; but *who* removed them is the only thing in a draft that says
 * anything about the enemy's plan, and a flat ban list throws it away. See
 * `readIntent`.
 */
export type BanSide = "mine" | "enemy";

export interface Ban {
  slug: string;
  /**
   * Null when the side was never recorded — every draft saved before bans had
   * sides reads back this way, and so does a ban entered in a hurry. Nothing
   * downstream may guess: an unattributed ban is evidence about nobody.
   */
  by: BanSide | null;
}

/**
 * A ban as any caller may express it: a bare slug where the side is unknown or
 * beside the point, or a full entry where it matters.
 *
 * The union is what lets the scoring layer keep taking `banned: ["spectre"]`
 * from callers that only ever cared which heroes were gone, while the app hands
 * it the attributed list. Read it through `banSlug`/`banSide` rather than by
 * type-testing at the call site.
 */
export type BanEntry = string | Ban;

/** Standard Dota positions: 1 safe carry … 5 hard support. */
export type Position = 1 | 2 | 3 | 4 | 5;

/**
 * Whose games positions, position win rates and the meta term are read from:
 * every rank, Divine and Immortal, or Immortal alone. Matchups, synergies and
 * timings are all-rank figures whichever is chosen.
 */
export type RankBand = "all" | "divine" | "immortal";

/**
 * How the hero grid is ordered. `attr` is the default browse view (grouped by
 * primary attribute); `pick` and `ban` reuse the suggestion scores so the grid
 * and the side panels always agree on what is good.
 */
export type SortMode = "attr" | "pick" | "ban";

/**
 * Which seat a score was worked out from.
 *
 * `SortMode` minus the browse view, and named separately because it is asked of
 * things that have no sort: the hover card, the suggestion panels, the sign
 * rule in `perspective.ts`. Picking scores a hero in your five; banning scores
 * the same hero in theirs, which is why every number carrying this has to be
 * read back to your side before it is printed.
 */
export type ScoreMode = "pick" | "ban";

/**
 * The terms the final score is the sum of.
 *
 * Named rather than positional so the read-out can label them without
 * restating the arithmetic — see `scoreParts`, which is the only place the list
 * exists and the only place a new term has to be added.
 */
export type ScoreTerm = "matchups" | "synergy" | "meta" | "intent" | "early";

/** One term of the score, already weighted, from the scoring side's point of view. */
export interface ScorePart {
  term: ScoreTerm;
  value: number;
}

export type Lane = "mid" | "safe" | "off" | "jungle" | "roaming";

/**
 * How the four duos meet at minute zero.
 *
 * `standard` is the arrangement every other number in this app assumes: my
 * safe duo (1 and 5) stands in the lane the enemy offlane duo (3 and 4) walks
 * into, and vice versa. `swapped` is the lane swap — one side sends its safe
 * duo up against the other's, so carry meets carry and offlane meets offlane.
 *
 * Deliberately a property of the *match* rather than of one team, because it
 * cannot be anything else: my safe lane is physically the enemy's off lane, so
 * the moment either side walks the other way both sides' pairings change
 * together. That is also why `swapTeams` leaves it alone — seen from the other
 * seat, safe-versus-safe is still safe-versus-safe.
 */
export type LanePlan = "standard" | "swapped";

export interface LaneStats {
  /** Share of this hero's games spent in the lane, in percent. */
  presence: number;
  winRate: number;
  kda: number;
  gpm: number;
  xpm: number;
}

/**
 * One length-of-game window, from public/data/timings.json.
 *
 * Counters say who beats whom and synergies say who belongs together; neither
 * says *when* a line-up is meant to win, which is the thing a captain has to
 * say out loud before the horn.
 */
export interface TimingBucket {
  key: string;
  /** "Before 25′" */
  label: string;
  /** "<25" — for axis ticks and chips, where the long label will not fit. */
  short: string;
  /** Upper bound in seconds; null on the open-ended last bucket. */
  maxSeconds: number | null;
}

/** How a hero does in one of those windows. */
export interface HeroTiming {
  games: number;
  /** Raw win rate inside the window. */
  winRate: number;
  /**
   * Percentage points away from this hero's own overall win rate, shrunk
   * towards zero by sample size. Positive = better than usual at this length.
   *
   * The skew rather than the raw rate is what makes the read comparable: a hero
   * who wins 54% everywhere is not a late-game hero, and only the difference
   * from their own baseline shows that.
   */
  skew: number;
}

/**
 * How long games actually run, and which part of that a draft has to survive.
 *
 * Derived from the timing table rather than collected, so it costs no extra
 * scrape and follows the bucket boundaries whatever they are set to. Null on a
 * dataset with no `timings.json`, which is what makes every early-game figure
 * in the app optional rather than silently zero.
 */
export interface TimingShape {
  /** Share of games ending in each window; sums to 1, aligned with the buckets. */
  shares: number[];
  /** Indices of the windows that close before the median game. */
  earlyWindows: number[];
  /** `shares` restricted to `earlyWindows` and renormalised to sum to 1. */
  earlyWeights: number[];
  /** Share of all games decided in those early windows. */
  earlyMass: number;
  /** Mean early-game cover across the hero pool — what an undrafted slot is worth. */
  poolCover: number;
}

export interface Hero {
  slug: string;
  name: string;
  attr: HeroAttr;
  /** Valve internal short name, used for the Steam CDN portrait fallback. */
  steam: string;
  /**
   * Overall win rate and pick rate: STRATZ's for the chosen rank band when
   * positions.json is loaded, Dotabuff's otherwise. Ban rate is always
   * Dotabuff's, across every rank.
   */
  winRate?: number;
  pickRate?: number;
  banRate?: number;
  tier?: string;
  /** Per-lane presence/economy, from /heroes/lanes. */
  lanes?: Partial<Record<Lane, LaneStats>>;
  /** Share of this hero's games in each position; sums to 1. */
  positions?: Partial<Record<Position, number>>;
  /** Win rate in each position, shrunk towards `winRate` where the position is a small share. */
  positionWinRate?: Partial<Record<Position, number>>;
  /** Positions the hero plays often enough to be worth suggesting. */
  topPositions?: Position[];
  /**
   * STRATZ's `[games, wins]` per position, 1 to 5, for each rank band in
   * positions.json. `withRankBand` turns the chosen band into `positions`,
   * `positionWinRate`, `topPositions`, `winRate` and `pickRate`.
   */
  positionCounts?: Partial<Record<RankBand, Array<[number, number]>>>;
  /** Win rate by length of game, aligned with `Dataset.timingBuckets`. */
  timings?: HeroTiming[];
}

/** A hero on the board, plus the position you have them down for. */
export interface DraftPick {
  slug: string;
  position: Position | null;
}

/**
 * One row of Dotabuff's matchup table, from the perspective of the page's hero.
 * `disadvantage > 0` means the page hero performs WORSE than usual against `vs`.
 */
export interface MatchupRow {
  /** Page hero's disadvantage vs the opponent, in percentage points. */
  disadvantage: number;
  /** Page hero's win rate in those games. */
  winRate: number;
  /** Sample size. */
  matches: number;
}

/** slug -> (opponent slug -> row) */
export type MatchupTable = Record<string, Record<string, MatchupRow>>;

/**
 * How a pair of heroes does on the *same* team, from public/data/synergies.json.
 *
 * Counters answer "who beats whom"; this answers the other half of drafting —
 * which of your own heroes make each other better.
 */
/**
 * A pairing's chemistry split by whether each hero farmed, keyed `cc`/`cs`/
 * `sc`/`ss` and read in the order the row itself is stored.
 *
 * Only the cells that disagreed with the blended figure are present — most
 * pairings do the same thing however they are played, and the collector leaves
 * those out rather than restating the overall number four times.
 */
export type SynergyCell = "cc" | "cs" | "sc" | "ss";

export interface SynergyRow {
  /**
   * Percentage points of win rate the pairing adds beyond what both heroes
   * contribute individually, already shrunk towards zero by sample size.
   */
  synergy: number;
  matches: number;
  /** Raw win rate of the pair, before any adjustment. Shown for context only. */
  winRate: number;
  /**
   * Per core/support cell, where the games said something the blended figure
   * does not. Absent cells fall back to `synergy`.
   */
  cells?: Partial<Record<SynergyCell, { synergy: number; matches: number }>>;
}

/** slug -> (teammate slug -> row). Mirrored on load, so both directions exist. */
export type SynergyTable = Record<string, Record<string, SynergyRow>>;

export interface Dataset {
  heroes: Hero[];
  bySlug: Map<string, Hero>;
  matchups: MatchupTable;
  synergies: SynergyTable;
  generatedAt: string | null;
  /**
   * Variance of *real* matchup edges across the table, in pp² — the prior that
   * lets a thin pairing be damped instead of either trusted raw or thrown
   * away. Absent (or null) on small tables, where it cannot be estimated, and
   * every advantage passes through untouched.
   */
  matchupSpread?: number | null;
  /** When synergies.json / timings.json were built, for staleness warnings. */
  synergyGeneratedAt?: string | null;
  timingGeneratedAt?: string | null;
  /** True when public/data/matchups.json was found and parsed. */
  hasData: boolean;
  /** True when that file also carried position data. */
  hasPositions: boolean;
  /** Rank bands positions.json carries; absent or empty without the file. */
  positionBands?: RankBand[];
  /** The band whose positions are in place, or null for the Dotabuff reconstruction. */
  rankBand?: RankBand | null;
  positionsGeneratedAt?: string | null;
  /**
   * STRATZ's lane outcomes, fitted once at load — see `buildLaneModel`. Absent
   * or null without lanes.json, and every laning read in the app then says so.
   */
  laneOutcomes?: LaneModel | null;
  /**
   * The same file read for a different question: what a seat is worth against
   * a *particular* opponent, beyond the whole-game matchup — see
   * `fitLaneCounters`. Null without lanes.json or without matchups to fit
   * against, and the ranking then has no seat-specific counter term.
   */
  laneCounters?: CounterModel | null;
  lanesGeneratedAt?: string | null;
  /** True when public/data/synergies.json was found and parsed. */
  hasSynergies: boolean;
  /** How many matches the synergy numbers were built from. */
  synergyMatches: number;
  /** True when public/data/timings.json was found and parsed. */
  hasTimings: boolean;
  /** The length-of-game windows `Hero.timings` is indexed by. */
  timingBuckets: TimingBucket[];
  /**
   * How long games run and which windows count as early, derived from the
   * table. Null without timings, and every read that needs it says so.
   */
  timingShape: TimingShape | null;
  /** How many matches the timing numbers were built from. */
  timingMatches: number;
  /**
   * The win-chance model's weights, from public/data/calibration.json — see
   * `readCalibration`. Null or absent without the file, and the analysis then
   * falls back to the comparison signal.
   */
  calibration?: Calibration | null;
  /** Populated when the dataset failed to load. */
  error: string | null;
}

export interface ScoreContribution {
  /** The drafted hero this contribution is measured against. */
  slug: string;
  name: string;
  /** Advantage in percentage points; positive = candidate is favoured. */
  advantage: number;
  matches: number;
  /** True when the two heroes would share a lane. */
  sameLane: boolean;
  /**
   * Win-rate points this pairing is worth *at these two seats*, on top of
   * `advantage`, from STRATZ's lane outcomes — see `laneCounter`. Present only
   * on a lane confrontation the table has a row for; `advantage` already
   * includes it where it is.
   */
  laneEdge?: number;
  /** Lanes behind `laneEdge`. */
  laneLanes?: number;
}

/**
 * A hero who beats the one being looked at, and by how much.
 *
 * Everything else in the app is a read on the board in front of you. This is
 * the one question with nothing on the board in it — "if I take this hero,
 * what is the answer to them?" — and it is asked before the enemy has picked,
 * which is exactly when a ban can still stop the answer being available.
 */
export interface Counter {
  hero: Hero;
  /** Percentage points the counter is ahead by. Always positive. */
  advantage: number;
  matches: number;
  /**
   * The *subject's* own win rate in those games, in percent, or null when the
   * scrape carries neither side of the row.
   */
  winRate: number | null;
  /** True when both heroes' pages were read, so the figure is an average. */
  bothSides: boolean;
  /** How far apart those two readings were. */
  spread: number;
}

/**
 * A hero this one belongs beside, and by how much.
 *
 * The mirror of `Counter`, and asked at the same moment: the hero at the top of
 * the pick list tells you nothing about who to take *next*, and the answer is
 * knowable before either of them is on the board.
 */
export interface Partner {
  hero: Hero;
  /**
   * Percentage points the pairing adds beyond what the two heroes are worth
   * apart. Always positive. Not a win rate, and much smaller than a matchup
   * edge — a full point of synergy is roughly the 99th percentile of the table.
   */
  synergy: number;
  /** Games behind `synergy` — the cell's own count when `positional`. */
  matches: number;
  /**
   * Raw win rate of the pair over every arrangement, which can sit either side
   * of 50. The core/support cells carry no win rate of their own, so under a
   * `positional` figure this describes a wider set of games than `matches`.
   */
  winRate: number;
  /** True when `synergy` is the figure for the two seats asked about, not the blend. */
  positional: boolean;
}

/** One teammate's share of a candidate's synergy score. */
export interface SynergyContribution {
  slug: string;
  name: string;
  /** Percentage points; positive = the two make each other better. */
  synergy: number;
  matches: number;
  /**
   * True when this came from the core/support cell for the two positions
   * rather than the pairing's blended figure.
   */
  positional?: boolean;
}

export interface Suggestion {
  hero: Hero;
  /** Final ranking score. */
  score: number;
  /** Mean head-to-head advantage in percentage points, lane-weighted. */
  matchupScore: number;
  /** Mean synergy with the heroes already on the same side, in percentage points. */
  synergyScore: number;
  /** Meta component (win rate - 50), before weighting. */
  metaScore: number;
  /**
   * Percentage points of counter-play the enemy's own bans removed from this
   * hero's path — see `Intent.cleared`. Zero in pick mode, and zero for any
   * hero the enemy's bans say nothing about.
   */
  intentScore: number;
  /**
   * Share of this hero's games in the requested position, 0..1.
   *
   * A fact about the hero, not a term of the score: what the seat is worth is
   * inside `metaScore`, where `positionWinRate` put it. See `estimateSeatPrior`.
   */
  roleFit: number;
  /**
   * What this hero is worth before the median game length, 0 to 1 bodies.
   * Null when the timing collector never saw them.
   */
  earlyCover: number | null;
  /**
   * The side's projected early-game cover with this hero on it, undrafted
   * slots valued at the pool average.
   */
  teamEarlyCover: number | null;
  /**
   * Points already subtracted from `score` for the early-game shortfall that
   * cover implies. Zero or negative, never positive — this term can only ever
   * argue against a pick, because a draft is not better for having a *surplus*
   * of early heroes and pretending otherwise would just be a second meta term.
   */
  earlyPenalty: number;
  /** Win rate the meta term was built from — position-specific where known. */
  winRate: number;
  /** The position this suggestion is being made for, if any. */
  position: Position | null;
  contributions: ScoreContribution[];
  synergyContributions: SynergyContribution[];
  /** How many of the opposing heroes we actually had data for. */
  covered: number;
}

/** What one hypothetical pick does to the whole draft read. */
export interface DraftImpact {
  /** Headline advantage before the pick; null when there was nothing to read. */
  before: number | null;
  /** Headline advantage with the hero on the board. */
  after: number;
  /** The lane the pick moves most, when it moves one past the noise floor. */
  lane: { label: string; delta: number; after: number } | null;
}

export interface Settings {
  /** 0..1 — how much the hero's overall win rate matters next to matchups. */
  metaWeight: number;
  /**
   * How much team synergy counts next to countering the enemy. At 1 a
   * percentage point of synergy is worth exactly as much as a point of matchup
   * advantage; at 0 the picker ignores your own line-up entirely.
   */
  synergyWeight: number;
  /** Extra weight on opponents you would share a lane with. */
  laneWeight: number;
  /** Ignore matchups with fewer games than this. */
  minMatches: number;
  /** Ignore synergies with fewer games than this. */
  minSynergyMatches: number;
  /** Hide heroes below this overall win rate from suggestions. */
  minWinRate: number;
  /** Minimum share of games in a position before a hero is offered for it. */
  minRoleFit: number;
  /**
   * How much the enemy's own bans count as evidence about their next pick.
   *
   * Multiplies `Intent.cleared` — percentage points of counter-play their bans
   * took off this hero's path — straight into the ban score, so a hero they
   * have visibly been clearing the way for climbs the list of heroes to ban.
   *
   * Set against the other terms the same way `earlyWeight` is: a strong signal
   * is 4–8 points of cleared counter-play, so 0.5 makes it worth 2–4 score
   * points — the size of a large matchup edge, enough to reorder the list and
   * not enough to overrule it. Zero turns the reading off and restores the
   * previous ordering exactly.
   */
  intentWeight: number;
  /**
   * Points a line-up is charged for having nobody who functions before the
   * median game length, at the full shortfall.
   *
   * Set against the other terms rather than in the abstract: a large matchup
   * edge is worth about five points and the meta term about three, so two puts
   * a completely one-sided draft's timing risk on the order of a bad matchup —
   * enough to reorder a suggestion list, not enough to overrule one. Because
   * the penalty is convex it reaches this figure only at zero cover; an
   * ordinary draft projects to roughly 2.6 bodies and is charged nothing.
   *
   * Zero turns the whole idea off and restores the previous ranking exactly.
   */
  earlyWeight: number;
  /** See `RankBand`. */
  rankBand: RankBand;
}
