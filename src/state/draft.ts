import { useCallback, useEffect, useMemo, useReducer } from "react";
import {
  EMPTY_DRAFT,
  MAX_BANS,
  TEAM_SIZE,
  draftReducer,
  type DraftState,
} from "../lib/draftState";
import type { Ban, BanSide, DraftPick, LanePlan, Position, Slot } from "../types";

export { MAX_BANS, TEAM_SIZE, type DraftState };

const STORAGE_KEY = "dotabuff-picker.draft.v3";
/** Bans as a flat list of slugs, with positions on the picks. */
const V2_KEY = "dotabuff-picker.draft.v2";
/** Bans as a flat list of slugs, no positions anywhere. */
const V1_KEY = "dotabuff-picker.draft.v1";

const isPosition = (v: unknown): v is Position =>
  typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 5;

/**
 * Anything that is not the word "swapped" is the standard deployment, which is
 * also what every draft saved before lane plans existed reads back as — so the
 * v2 key did not need bumping for this.
 */
const readLanePlan = (v: unknown): LanePlan => (v === "swapped" ? "swapped" : "standard");

const isSide = (v: unknown): v is BanSide => v === "mine" || v === "enemy";

/**
 * Bans as stored under the current key: entries carrying a side, and tolerant
 * of a bare slug so a hand-edited or half-written value still loads.
 */
const readBans = (v: unknown): Ban[] =>
  Array.isArray(v)
    ? v
        .map((x): Ban | null => {
          if (typeof x === "string") return { slug: x, by: null };
          if (!x || typeof (x as Ban).slug !== "string") return null;
          return { slug: (x as Ban).slug, by: isSide((x as Ban).by) ? (x as Ban).by : null };
        })
        .filter((b): b is Ban => b !== null)
        .slice(0, MAX_BANS)
    : [];

function readStored(): DraftState {
  const strings = (v: unknown, max: number) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, max) : [];

  /**
   * Bans carried over from v1 and v2, which had no notion of a side.
   *
   * They come back unattributed rather than assigned to me. Guessing would be
   * cheap and wrong in the one direction that matters: an old ban list credited
   * to the enemy becomes evidence about a plan nobody ever had, and the reading
   * it feeds would open on a confident claim about a draft that finished weeks
   * ago. Unattributed bans still remove their heroes from the pool, which is
   * everything those saved drafts ever meant by them.
   */
  const legacyBans = (v: unknown): Ban[] =>
    strings(v, MAX_BANS).map((slug) => ({ slug, by: null }));

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<DraftState>;
      const picks = (v: unknown): DraftPick[] =>
        Array.isArray(v)
          ? v
              .filter((x): x is DraftPick => Boolean(x) && typeof (x as DraftPick).slug === "string")
              .slice(0, TEAM_SIZE)
              .map((p) => ({ slug: p.slug, position: isPosition(p.position) ? p.position : null }))
          : [];
      return {
        mine: picks(parsed.mine),
        enemy: picks(parsed.enemy),
        banned: readBans(parsed.banned),
        lanePlan: readLanePlan(parsed.lanePlan),
      };
    }

    // Drafts saved with positions but a flat ban list.
    const v2 = localStorage.getItem(V2_KEY);
    if (v2) {
      const parsed = JSON.parse(v2) as Record<string, unknown>;
      const picks = (v: unknown): DraftPick[] =>
        Array.isArray(v)
          ? v
              .filter((x): x is DraftPick => Boolean(x) && typeof (x as DraftPick).slug === "string")
              .slice(0, TEAM_SIZE)
              .map((p) => ({ slug: p.slug, position: isPosition(p.position) ? p.position : null }))
          : [];
      return {
        mine: picks(parsed.mine),
        enemy: picks(parsed.enemy),
        banned: legacyBans(parsed.banned),
        lanePlan: readLanePlan(parsed.lanePlan),
      };
    }

    // Drafts saved before positions existed.
    const v1 = localStorage.getItem(V1_KEY);
    if (v1) {
      const parsed = JSON.parse(v1) as Record<string, unknown>;
      const toPicks = (v: unknown): DraftPick[] =>
        strings(v, TEAM_SIZE).map((slug) => ({ slug, position: null }));
      return {
        mine: toPicks(parsed.mine),
        enemy: toPicks(parsed.enemy),
        banned: legacyBans(parsed.banned),
        lanePlan: "standard",
      };
    }
  } catch {
    /* corrupt or unavailable storage — start clean */
  }
  return EMPTY_DRAFT;
}

export function useDraft() {
  const [state, dispatch] = useReducer(draftReducer, EMPTY_DRAFT, readStored);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      /* private browsing, quota, ... — persistence is a nicety, not a feature */
    }
  }, [state]);

  const slotOf = useMemo(() => {
    const map = new Map<string, Slot>();
    for (const ban of state.banned) map.set(ban.slug, "banned");
    for (const pick of state.enemy) map.set(pick.slug, "enemy");
    for (const pick of state.mine) map.set(pick.slug, "mine");
    return map;
  }, [state]);

  /**
   * Whose ban a banned hero was, for the tiles.
   *
   * Kept apart from `slotOf` rather than folded into it. The slot answers "can I
   * still take this hero", which is one bit and the same bit for both sides;
   * this answers "who took them away", which the grid draws differently and
   * nothing else in the app needs at all.
   */
  const banSideOf = useMemo(() => {
    const map = new Map<string, BanSide>();
    for (const ban of state.banned) if (ban.by) map.set(ban.slug, ban.by);
    return map;
  }, [state.banned]);

  const positionOf = useMemo(() => {
    const map = new Map<string, Position>();
    for (const pick of [...state.mine, ...state.enemy]) {
      if (pick.position) map.set(pick.slug, pick.position);
    }
    return map;
  }, [state]);

  const assign = useCallback(
    (slug: string, slot: Slot, position: Position | null = null, by: BanSide | null = null) =>
      dispatch({ type: "assign", slug, slot, position, by }),
    [],
  );
  const setBanSide = useCallback(
    (slug: string, by: BanSide | null) => dispatch({ type: "setBanSide", slug, by }),
    [],
  );
  const setPosition = useCallback(
    (slug: string, position: Position | null) => dispatch({ type: "setPosition", slug, position }),
    [],
  );
  const reorder = useCallback(
    (picks: DraftPick[], lanePlan?: LanePlan) => dispatch({ type: "reorder", picks, lanePlan }),
    [],
  );
  const setLanePlan = useCallback(
    (lanePlan: LanePlan) => dispatch({ type: "setLanePlan", lanePlan }),
    [],
  );
  const remove = useCallback((slug: string) => dispatch({ type: "remove", slug }), []);
  const clearSlot = useCallback((slot: Slot) => dispatch({ type: "clearSlot", slot }), []);
  const swapTeams = useCallback(() => dispatch({ type: "swapTeams" }), []);
  const reset = useCallback(() => dispatch({ type: "reset" }), []);
  const replace = useCallback((next: DraftState) => dispatch({ type: "replace", state: next }), []);

  const total = state.mine.length + state.enemy.length + state.banned.length;

  return {
    draft: state,
    slotOf,
    banSideOf,
    positionOf,
    assign,
    setBanSide,
    setPosition,
    reorder,
    setLanePlan,
    remove,
    clearSlot,
    swapTeams,
    reset,
    replace,
    total,
  };
}

export type DraftApi = ReturnType<typeof useDraft>;
