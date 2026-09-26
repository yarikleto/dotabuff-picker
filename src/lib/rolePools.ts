import { heroDetail, type DraftView } from "./scoring";
import { POSITIONS, missingPositions, positionFit } from "./roles";
import { banSlugs } from "./bans";
import type { Dataset, DraftPick, Hero, Position, Settings, Suggestion } from "../types";

/**
 * The heroes each teammate can play, one list per position.
 *
 * Kept apart from the draft and from the tuning on purpose: a Battle Cup is
 * several games with the same five players, so the pools have to outlive a
 * draft reset and a "Restore defaults".
 */
export type RolePools = Record<Position, string[]>;

export const EMPTY_POOLS: RolePools = { 1: [], 2: [], 3: [], 4: [], 5: [] };

/** More than any teammate's pool; stops a corrupt stored value from growing without bound. */
export const MAX_POOL = 16;

/**
 * Heroes from outside the pools the pick list always keeps, so a long pool never
 * pushes the best of everyone else off the panel.
 */
export const MIN_OTHERS = 5;

export function readRolePools(raw: unknown): RolePools {
  const out: RolePools = { 1: [], 2: [], 3: [], 4: [], 5: [] };
  if (!raw || typeof raw !== "object") return out;
  for (const position of POSITIONS) {
    const list = (raw as Record<string, unknown>)[position];
    if (!Array.isArray(list)) continue;
    const slugs = list.filter((s): s is string => typeof s === "string" && s.length > 0);
    out[position] = [...new Set(slugs)].slice(0, MAX_POOL);
  }
  return out;
}

export function togglePoolHero(pools: RolePools, position: Position, slug: string): RolePools {
  const list = pools[position];
  if (list.includes(slug)) return { ...pools, [position]: list.filter((s) => s !== slug) };
  if (list.length >= MAX_POOL) return pools;
  return { ...pools, [position]: [...list, slug] };
}

export function addPoolHero(pools: RolePools, position: Position, slug: string): RolePools {
  return pools[position].includes(slug) ? pools : togglePoolHero(pools, position, slug);
}

/** Empties one role's pool, or every pool when `position` is null. */
export function clearPools(pools: RolePools, position: Position | null): RolePools {
  return position === null ? EMPTY_POOLS : { ...pools, [position]: [] };
}

export const poolSize = (pools: RolePools): number =>
  POSITIONS.reduce((total, position) => total + pools[position].length, 0);

export const poolSeats = (pools: RolePools, slug: string): Position[] =>
  POSITIONS.filter((position) => pools[position].includes(slug));

export function poolIndex(pools: RolePools): Map<string, Position[]> {
  const index = new Map<string, Position[]>();
  for (const position of POSITIONS) {
    for (const slug of pools[position]) index.set(slug, [...(index.get(slug) ?? []), position]);
  }
  return index;
}

/**
 * An open role whose pool lists the hero, preferring the one being drafted for.
 * Without it a pos 3 teammate's Pudge is booked at his usual 5, and every lane
 * and synergy read after that describes the wrong draft.
 */
export function poolSeat(
  pools: RolePools,
  hero: Hero | undefined,
  team: DraftPick[],
  focus: Position | null,
): Position | null {
  if (!hero) return null;
  const open = missingPositions(team);
  const seats = poolSeats(pools, hero.slug).filter((position) => open.includes(position));
  if (!seats.length) return null;
  if (focus !== null && seats.includes(focus)) return focus;
  return seats.reduce((best, position) =>
    positionFit(hero, position) > positionFit(hero, best) ? position : best,
  );
}

/** The roles whose pools the pick list reads: the seat it drafts for, or every seat still open. */
export const poolRoles = (position: Position | null, mine: DraftPick[]): Position[] =>
  position !== null ? [position] : missingPositions(mine);

export interface PickRow {
  suggestion: Suggestion;
  /** 1-based place in the seat's ranking by score, pooled heroes included. */
  place: number;
  /** The roles whose pool put this hero first; empty for everyone else. */
  pooled: Position[];
  /**
   * False for a pooled hero the role threshold or the win-rate floor keeps out
   * of the ranking proper. Their place is where their score would put them.
   */
  ranked: boolean;
}

/**
 * The pick list: pooled heroes first, best to worst, then the best of everyone
 * else. Each keeps their true place, so a weak pool hero leads without looking
 * good. The role threshold is skipped for them because the teammate's pool is
 * evidence the population figures lack. `ranking` is `rankAll` for this seat.
 */
export function poolFirst(
  data: Dataset,
  draft: DraftView,
  settings: Settings,
  position: Position | null,
  ranking: Suggestion[],
  pools: RolePools,
  limit: number,
): PickRow[] {
  const roles = new Map<string, Position[]>();
  for (const role of poolRoles(position, draft.mine)) {
    for (const slug of pools[role]) roles.set(slug, [...(roles.get(slug) ?? []), role]);
  }

  const taken = new Set([
    ...draft.mine.map((p) => p.slug),
    ...draft.enemy.map((p) => p.slug),
    ...banSlugs(draft.banned),
  ]);
  const index = new Map(ranking.map((s, i) => [s.hero.slug, i]));

  const pooled: PickRow[] = [];
  for (const [slug, seats] of roles) {
    if (taken.has(slug)) continue;
    const i = index.get(slug);
    const suggestion =
      i !== undefined ? ranking[i]! : heroDetail(data, draft, settings, slug, position, "pick");
    if (!suggestion) continue;
    pooled.push({
      suggestion,
      place: i !== undefined ? i + 1 : 1 + ranking.filter((r) => r.score > suggestion.score).length,
      pooled: seats,
      ranked: i !== undefined,
    });
  }
  pooled.sort((a, b) => b.suggestion.score - a.suggestion.score || a.place - b.place);

  const others = ranking
    .map((suggestion, i) => ({ suggestion, place: i + 1, pooled: [], ranked: true }))
    .filter((row) => !roles.has(row.suggestion.hero.slug))
    .slice(0, Math.max(MIN_OTHERS, limit - pooled.length));

  return [...pooled, ...others];
}
