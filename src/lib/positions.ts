import { POSITIONS } from "./roles";
import type { Dataset, Hero, Position, RankBand } from "../types";

/**
 * Positions and pick rates as STRATZ counts them, per rank band, from
 * public/data/positions.json.
 *
 * Without that file every position figure in the app is the Dotabuff
 * reconstruction from lane presence and GPM, which misfiles about 15% of a
 * typical hero's games — docs/scoring.md, "Where positions come from".
 *
 * The reconstruction shrinks a thin seat's win rate by its share, and should:
 * Dotabuff publishes one win rate per *lane*, so the figure a thin seat starts
 * from describes whoever else stands in that lane — see `POSITION_WR_PRIOR` in
 * scripts/roles.mjs. These counts are per position already, so nothing here is
 * borrowed and share is not what a reading should be judged by.
 */

export const RANK_BANDS: RankBand[] = ["all", "divine", "immortal"];

export const RANK_BAND_LABEL: Record<RankBand, string> = {
  all: "All ranks",
  divine: "Divine+",
  immortal: "Immortal",
};

/**
 * Share bands the seat prior is measured in.
 *
 * Narrow where the effect moves fastest — nearly all of it is spent below a
 * tenth of a hero's games — and wide above that, where it has flattened and a
 * finer grid would only be fitting noise.
 */
const SEAT_PRIOR_BINS = [0, 0.02, 0.05, 0.1, 0.18, 0.3, 0.45, 1.01];

/**
 * Below this many `(hero, position)` cells the moments are noise about noise —
 * the same guard, for the same reason, as `MIN_PAIRS_FOR_MATCHUP_SHRINK`.
 * A unit-test fixture or a one-hero scrape falls back to the raw reading.
 */
const MIN_CELLS_FOR_SEAT_PRIOR = 200;

/** One share band's measured seat effect. */
export interface SeatPriorBin {
  /** Mean share of the cells this was measured over. */
  share: number;
  /** Mean of `seat win rate − hero overall`, in percentage points. */
  mean: number;
  /** Spread of the *real* effect at this share, in pp², sampling noise removed. */
  spread: number;
}

/**
 * Sampling variance of a seat's win rate, in pp² — binomial over its games,
 * the same shape as `advantageNoiseVar` in scoring.ts.
 */
const seatNoiseVar = (winRate: number, games: number): number => {
  const p = Math.min(0.85, Math.max(0.15, winRate / 100));
  return (1e4 * p * (1 - p)) / Math.max(1, games);
};

/**
 * How a seat's record relates to its share of a hero's games, measured across
 * the whole table: per share band, the mean gap to the hero's overall win rate
 * and the spread of that gap once sampling noise is taken out.
 *
 * This is the off-role effect itself, in the units it is actually observed in.
 * On the live table the mean runs from −7.4pp in the thinnest band to +0.4pp
 * above 45%, and it is flat from roughly a fifth of a hero's games upward — so
 * a hero seated somewhere they rarely go is charged by what such seats are
 * measured to be worth, rather than by a constant chosen to feel right.
 *
 * Always read from the all-ranks band, whichever band is being applied. Divine
 * and Immortal cells run down to a dozen games, where `E[noise]` swamps the
 * moments; all-ranks cells never fall below a few hundred, so its moments are
 * clean and the effect it measures is the same one.
 */
export function estimateSeatPrior(heroes: ReadonlyArray<Hero>): SeatPriorBin[] | null {
  const cells: Array<{ share: number; delta: number; noise: number }> = [];
  for (const hero of heroes) {
    const counts = hero.positionCounts?.all;
    if (!counts) continue;
    const total = counts.reduce((n, cell) => n + cell[0], 0);
    if (!total) continue;
    const overall = (counts.reduce((n, cell) => n + cell[1], 0) / total) * 100;
    for (const [games, wins] of counts) {
      if (!games) continue;
      const raw = (wins / games) * 100;
      cells.push({ share: games / total, delta: raw - overall, noise: seatNoiseVar(raw, games) });
    }
  }
  if (cells.length < MIN_CELLS_FOR_SEAT_PRIOR) return null;

  const bins: SeatPriorBin[] = [];
  for (let i = 0; i < SEAT_PRIOR_BINS.length - 1; i++) {
    const band = cells.filter((c) => c.share >= SEAT_PRIOR_BINS[i]! && c.share < SEAT_PRIOR_BINS[i + 1]!);
    if (band.length < 5) continue;
    const n = band.length;
    const mean = band.reduce((s, c) => s + c.delta, 0) / n;
    // Variance about the band's own mean, not about zero: these gaps are not
    // centred — thin seats are worse as a group — and `E[d²]` would report
    // that offset as spread and leave every thin reading undamped.
    const observed = band.reduce((s, c) => s + (c.delta - mean) ** 2, 0) / (n - 1);
    const noise = band.reduce((s, c) => s + c.noise, 0) / n;
    bins.push({
      share: band.reduce((s, c) => s + c.share, 0) / n,
      mean,
      // Floored rather than zeroed: a band whose whole spread reads as noise
      // still must not pin every hero in it to the mean.
      spread: Math.max(0.05, observed - noise),
    });
  }
  return bins.length >= 3 ? bins : null;
}

/** The prior at one share, linear between the bands it was measured in. */
export function seatPriorAt(bins: ReadonlyArray<SeatPriorBin>, share: number): SeatPriorBin {
  const first = bins[0]!;
  const last = bins[bins.length - 1]!;
  if (share <= first.share) return first;
  if (share >= last.share) return last;
  for (let i = 0; i < bins.length - 1; i++) {
    const a = bins[i]!;
    const b = bins[i + 1]!;
    if (share <= b.share) {
      const t = (share - a.share) / (b.share - a.share);
      return { share, mean: a.mean + t * (b.mean - a.mean), spread: a.spread + t * (b.spread - a.spread) };
    }
  }
  return last;
}

/** Kept in step with `ROLE_SHARE` in roles.ts and `MIN_POSITION_WEIGHT` in scripts/roles.mjs. */
const TOP_POSITION_SHARE = 0.12;

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface DerivedPositions {
  positions: Partial<Record<Position, number>>;
  positionWinRate: Partial<Record<Position, number>>;
  topPositions: Position[];
  winRate: number;
}

/**
 * One band's `[games, wins]` per position, turned into the fields the rest of
 * the app reads.
 *
 * A seat's win rate is the hero's overall figure, plus what seats of that share
 * are measured to be worth, plus whatever this hero's own reading says beyond
 * that — the last part weighted `spread / (spread + noise)`, the same
 * empirical-Bayes factor `matchup` damps an advantage by. So the two things
 * that used to be conflated are now separated: how *rare* a seat is sets where
 * the estimate is pulled towards, and how *well measured* it is sets how far.
 *
 * That distinction is the whole of the fix. Pulling by share alone threw away
 * 61% of Necrophos's pos 1 record — 207,113 games, known to a tenth of a point
 * — because 10% is a small share, and it reported Meepo's 31-game pos 5 at the
 * hero's overall figure because share and sample size were being read off the
 * same number. Leshrac wins 60.2% of 16,311 games in the safe lane and 51.1%
 * of 146,360 in the mid lane; the seat he is good at is the one he is rarely
 * put in, and no amount of games could say so while share was the only weight.
 *
 * `prior` is table-level — see `estimateSeatPrior`. Without it the readings
 * pass through raw, exactly as an advantage does when `matchupSpread` is null.
 */
export function positionsFromCounts(
  cells: ReadonlyArray<readonly [number, number]>,
  prior: ReadonlyArray<SeatPriorBin> | null = null,
): DerivedPositions | null {
  const total = cells.reduce((n, cell) => n + cell[0], 0);
  if (!(total > 0)) return null;
  const overall = (cells.reduce((n, cell) => n + cell[1], 0) / total) * 100;

  const positions: Partial<Record<Position, number>> = {};
  const positionWinRate: Partial<Record<Position, number>> = {};
  for (const position of POSITIONS) {
    const [games, wins] = cells[position - 1] ?? [0, 0];
    const share = games / total;
    const raw = games ? (wins / games) * 100 : overall;
    positions[position] = share;
    if (!prior) {
      positionWinRate[position] = round2(raw);
      continue;
    }
    const { mean, spread } = seatPriorAt(prior, share);
    const kept = spread / (spread + seatNoiseVar(raw, games));
    positionWinRate[position] = round2(overall + mean + (raw - overall - mean) * kept);
  }

  const ranked = [...POSITIONS].sort((a, b) => (positions[b] ?? 0) - (positions[a] ?? 0));
  const topPositions = ranked.filter((p) => (positions[p] ?? 0) >= TOP_POSITION_SHARE);
  return {
    positions,
    positionWinRate,
    // Never role-less: a hero spread thinner than the floor everywhere keeps their commonest seat.
    topPositions: topPositions.length ? topPositions : ranked.slice(0, 1),
    winRate: round2(overall),
  };
}

/** A well-formed band: five `[games, wins]` pairs of non-negative numbers, wins never above games. */
export function readPositionCells(value: unknown): Array<[number, number]> | null {
  if (!Array.isArray(value) || value.length !== POSITIONS.length) return null;
  const cells: Array<[number, number]> = [];
  for (const cell of value) {
    if (!Array.isArray(cell) || cell.length < 2) return null;
    const [games, wins] = cell as [unknown, unknown];
    if (typeof games !== "number" || typeof wins !== "number") return null;
    if (!(games >= 0) || !(wins >= 0) || wins > games) return null;
    cells.push([games, wins]);
  }
  return cells;
}

/** The band to read: the one asked for when the file has it, all ranks otherwise. */
export function effectiveBand(data: Pick<Dataset, "positionBands">, band: RankBand): RankBand | null {
  const bands = data.positionBands ?? [];
  if (bands.includes(band)) return band;
  return bands.includes("all") ? "all" : null;
}

const bandGames = (hero: Hero, band: RankBand) =>
  hero.positionCounts?.[band]?.reduce((n, cell) => n + cell[0], 0) ?? 0;

/**
 * The dataset with one rank band's positions and pick rates in place of the
 * Dotabuff figures.
 *
 * Returns a new dataset rather than editing the loaded one, so switching bands
 * back and forth never compounds, and hands back the very same object when
 * there is nothing to apply so memoised readers do not recompute. A hero the
 * file does not cover keeps the Dotabuff figures — a band that fails to load
 * degrades to the reconstruction, never to no positions at all.
 *
 * Pick rate moves with the band because it is the most rank-dependent figure
 * the ban list reads: Sniper is in 19% of matches at all ranks and 7% at
 * Immortal.
 */
export function withRankBand(data: Dataset, band: RankBand): Dataset {
  const applied = effectiveBand(data, band);
  if (!applied) return data;

  // Ten heroes a match, so the band's matches are its hero-games over ten.
  const matches = data.heroes.reduce((n, hero) => n + bandGames(hero, applied), 0) / 10;
  // Measured here rather than carried on the dataset because this is the only
  // place it is applied, and a prior fitted to the very heroes it is about to
  // be used on cannot drift out of step with them.
  const prior = estimateSeatPrior(data.heroes);

  let changed = false;
  const heroes = data.heroes.map((hero): Hero => {
    const cells = hero.positionCounts?.[applied];
    const derived = cells ? positionsFromCounts(cells, prior) : null;
    if (!derived) return hero;
    changed = true;
    return { ...hero, ...derived, pickRate: round2((bandGames(hero, applied) / matches) * 100) };
  });
  if (!changed) return data;

  return {
    ...data,
    heroes,
    bySlug: new Map(heroes.map((h) => [h.slug, h])),
    hasPositions: heroes.some((h) => h.positions),
    rankBand: applied,
  };
}
