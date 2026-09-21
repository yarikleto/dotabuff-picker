import type { DraftPick, Hero, Lane, LanePlan, Position } from "../types";

export const POSITIONS: Position[] = [1, 2, 3, 4, 5];

export const POSITION_LABEL: Record<Position, string> = {
  1: "Safe carry",
  2: "Mid",
  3: "Offlane",
  4: "Soft support",
  5: "Hard support",
};

/**
 * Who you stand against in the lane. Positions 1 and 5 share the safe lane and
 * face the enemy offlane duo (3 and 4); mid faces mid.
 */
export const LANE_OPPONENTS: Record<Position, Position[]> = {
  1: [3, 4],
  2: [2],
  3: [1, 5],
  4: [1, 5],
  5: [3, 4],
};

/**
 * The same question after a lane swap: the safe duos meet each other and the
 * offlane duos meet each other, so a carry's lane opponent is the enemy carry.
 *
 * Mid is untouched — there is only one mid lane and nobody can swap out of it.
 */
const LANE_OPPONENTS_SWAPPED: Record<Position, Position[]> = {
  1: [1, 5],
  2: [2],
  3: [3, 4],
  4: [3, 4],
  5: [1, 5],
};

/** The lane-opposition map for a deployment. */
export const laneOpponents = (plan: LanePlan = "standard"): Record<Position, Position[]> =>
  plan === "swapped" ? LANE_OPPONENTS_SWAPPED : LANE_OPPONENTS;

/**
 * Which of Dotabuff's lanes a position physically stands in.
 *
 * Under a swap the two are no longer the same thing, and keeping them apart is
 * the point: a carry who walks into the off lane is read against Dotabuff's
 * *offlane* row, which is the only place the cost of standing there shows up.
 * Position says what a hero is doing with the farm; this says where they are
 * doing it.
 */
const LANE_FOR_POSITION: Record<LanePlan, Record<Position, Lane>> = {
  standard: { 1: "safe", 2: "mid", 3: "off", 4: "off", 5: "safe" },
  swapped: { 1: "off", 2: "mid", 3: "safe", 4: "safe", 5: "off" },
};

export const laneForPosition = (position: Position, plan: LanePlan = "standard"): Lane =>
  LANE_FOR_POSITION[plan][position];

/**
 * Positions 1-3 take farm, 4-5 do not — the line the synergy table is cut on.
 * Kept in step with `CORE_POSITIONS` in `scripts/assign.mjs`.
 */
export const isCore = (position: Position): boolean => position <= 3;

/** Share of this hero's games spent in `position`, 0..1. */
export const positionFit = (hero: Hero | undefined, position: Position | null): number =>
  hero && position ? (hero.positions?.[position] ?? 0) : 0;

/** Position-specific win rate where we have one, otherwise the overall figure. */
export const positionWinRate = (hero: Hero, position: Position | null): number =>
  (position ? hero.positionWinRate?.[position] : undefined) ?? hero.winRate ?? 50;

/**
 * Whether a hero is a plausible pick for a position.
 *
 * Heroes without position data pass — a missing scrape should not empty the
 * suggestion list.
 */
export function canPlay(hero: Hero, position: Position | null, minFit: number): boolean {
  if (!position) return true;
  if (!hero.positions) return true;
  return positionFit(hero, position) >= minFit;
}

/**
 * The share of a hero's games below which a position is not a seat they are ever
 * picked in. Kept in step with `MIN_POSITION_WEIGHT` in `scripts/roles.mjs`, so
 * the set of positions this agrees a hero plays is the same set `topPositions`
 * lists and the tile summary prints.
 */
const ROLE_SHARE = 0.12;

/**
 * And how much of their *main* role that has to be, which is the test no
 * absolute floor can do on its own. Slark spends 17% of his games in the
 * safe-lane support slot and 76% as the carry — over any sane floor, and still
 * not an answer to "give me a pos 5", because those 17% are the same hero doing
 * the same thing in a game that went differently.
 */
const ROLE_SHARE_OF_MAIN = 0.25;

/**
 * Whether a hero is one of the heroes you would *pick* for a position.
 *
 * Deliberately stricter than `canPlay`, because the two questions point opposite
 * ways. `canPlay` guards a ranking, where the cost of a mistake is dropping a
 * hero who would have been the right pick — so its floor is low, 8% of games by
 * default, and it errs towards letting heroes in. This guards a filtered list
 * that claims to be the answer to "who counters them from the 4 slot", where the
 * cost of a mistake is the opposite: Viper spends 8.4% of his games at pos 5, so
 * the loose floor put a mid in a row of supports and made the filter useless.
 *
 * Heroes the scrape has no positions for still pass, for the same reason they
 * pass `canPlay` — a missing column should not empty the row.
 */
export function playsRole(hero: Hero, position: Position | null): boolean {
  if (!position) return true;
  if (!hero.positions) return true;

  const share = positionFit(hero, position);
  if (share < ROLE_SHARE) return false;

  const main = Math.max(...POSITIONS.map((p) => positionFit(hero, p)));
  return main <= 0 || share >= ROLE_SHARE_OF_MAIN * main;
}

/** Positions a team has not filled yet, in draft order. */
export function missingPositions(picks: DraftPick[]): Position[] {
  const taken = new Set(picks.map((p) => p.position).filter(Boolean) as Position[]);
  return POSITIONS.filter((p) => !taken.has(p));
}

/**
 * Best guess at what a hero is doing in this draft: their most-played position
 * among the ones the team still needs.
 *
 * The answer is always a *free* slot, and that is the whole of the fix here.
 * The old fallback, for a hero none of whose positions are still open, was to
 * hand back their overall main — which is already taken by definition, so the
 * team ended up with two heroes on one position and the real gap unfilled.
 * Every lane figure downstream is cut on position, so one duplicate quietly
 * corrupts the entire read: a lane with three heroes in it, another with none.
 *
 * Seating them somewhere they never play is the lesser wrong, and it is not
 * silent — the position dropdown shows the share, and the lane card now names
 * an off-role hero on either side.
 */
export function guessPosition(hero: Hero | undefined, taken: DraftPick[]): Position | null {
  if (!hero) return null;
  const free = POSITIONS.filter((p) => missingPositions(taken).includes(p));

  const best = free.reduce<{ position: Position | null; fit: number }>(
    (found, p) => {
      const fit = positionFit(hero, p);
      return fit > found.fit ? { position: p, fit } : found;
    },
    { position: null, fit: 0 },
  );

  // No position data, or none of the open slots is one this hero ever plays:
  // take the first gap the team has rather than a seat somebody is sitting in.
  return best.position ?? free[0] ?? null;
}

/** Compact "1/3" style summary of the positions a hero actually plays. */
export const positionSummary = (hero: Hero): string =>
  hero.topPositions?.length ? hero.topPositions.join("/") : "";
