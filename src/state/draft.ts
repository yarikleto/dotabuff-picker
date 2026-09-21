import { useCallback, useEffect, useMemo, useReducer } from "react";
import type { Ban, BanSide, DraftPick, LanePlan, Position, Slot } from "../types";

export const TEAM_SIZE = 5;
/** Captains Mode bans 14 heroes; leave a little headroom. */
export const MAX_BANS = 16;

export interface DraftState {
  mine: DraftPick[];
  enemy: DraftPick[];
  /**
   * Every hero off the board, each carrying who took them off it.
   *
   * One list rather than two, because availability is one question and the
   * order bans were entered in is worth keeping — a captain reading their own
   * board back wants to see the draft as it happened. `bansBy` splits it for
   * the two panels, and `readIntent` reads only the enemy's half.
   */
  banned: Ban[];
  /** How the duos are deployed — see `LanePlan`. */
  lanePlan: LanePlan;
}

type Action =
  | { type: "assign"; slug: string; slot: Slot; position?: Position | null; by?: BanSide | null }
  /** Re-attribute a ban already on the board, without moving it. */
  | { type: "setBanSide"; slug: string; by: BanSide | null }
  | { type: "setPosition"; slug: string; position: Position | null }
  /**
   * Book my whole line-up at once.
   *
   * `setPosition` cannot do this. It is deliberately exclusive — whoever held
   * the position gives it up — so replaying a permutation through it one hero
   * at a time knocks each previous hero back out again, and a three-way rotation
   * ends up with two heroes on nothing. A rearrangement is one move and has to
   * be applied as one.
   */
  | { type: "reorder"; picks: DraftPick[]; lanePlan?: LanePlan }
  | { type: "setLanePlan"; lanePlan: LanePlan }
  | { type: "remove"; slug: string }
  | { type: "clearSlot"; slot: Slot }
  | { type: "swapTeams" }
  | { type: "reset" };

const EMPTY: DraftState = { mine: [], enemy: [], banned: [], lanePlan: "standard" };

const capacity: Record<Slot, number> = {
  mine: TEAM_SIZE,
  enemy: TEAM_SIZE,
  banned: MAX_BANS,
};

const dropPick = (list: DraftPick[], slug: string) => list.filter((p) => p.slug !== slug);
const dropBan = (list: Ban[], slug: string) => list.filter((b) => b.slug !== slug);

function reducer(state: DraftState, action: Action): DraftState {
  switch (action.type) {
    case "assign": {
      const { slug, slot, position = null, by = null } = action;
      const existing = slot === "banned" ? state.banned.find((b) => b.slug === slug) : undefined;
      const alreadyHere =
        slot === "banned" ? Boolean(existing) : state[slot].some((p) => p.slug === slug);
      if (alreadyHere) {
        /**
         * Banning a hero the *other* side already banned re-attributes them
         * rather than un-banning them.
         *
         * Without this the two ban panels would be a trap: clicking a hero into
         * "their bans" when they are sitting in mine reads as a correction and
         * would instead have silently removed them from the board, and the
         * mistake is invisible — the hero simply reappears in the pool a few
         * clicks later with no explanation.
         */
        if (slot === "banned" && by !== null && existing!.by !== by) {
          return {
            ...state,
            banned: state.banned.map((b) => (b.slug === slug ? { ...b, by } : b)),
          };
        }
        // Otherwise clicking a hero that already sits in the target slot removes
        // them, so a mis-click is undone by clicking again.
        return slot === "banned"
          ? { ...state, banned: dropBan(state.banned, slug) }
          : { ...state, [slot]: dropPick(state[slot], slug) };
      }
      const current = slot === "banned" ? state.banned : state[slot];
      if (current.length >= capacity[slot]) return state;

      const base: DraftState = {
        ...state,
        mine: dropPick(state.mine, slug),
        enemy: dropPick(state.enemy, slug),
        banned: dropBan(state.banned, slug),
      };
      return slot === "banned"
        ? { ...base, banned: [...base.banned, { slug, by }] }
        : { ...base, [slot]: [...base[slot], { slug, position }] };
    }
    case "setBanSide":
      return {
        ...state,
        banned: state.banned.map((b) => (b.slug === action.slug ? { ...b, by: action.by } : b)),
      };
    case "setPosition": {
      const reassign = (list: DraftPick[]) => {
        if (!list.some((p) => p.slug === action.slug)) return list;
        return list.map((p) => {
          if (p.slug === action.slug) return { ...p, position: action.position };
          // A position is exclusive within a team: whoever held it gives it up.
          if (action.position !== null && p.position === action.position) {
            return { ...p, position: null };
          }
          return p;
        });
      };
      return { ...state, mine: reassign(state.mine), enemy: reassign(state.enemy) };
    }
    case "reorder": {
      // Only heroes actually on my side are re-seated, and only positions the
      // caller booked. An arrangement built against a stale board — a hero
      // removed between the panel rendering and the click — must not resurrect
      // them or drop anyone it forgot to mention.
      const booked = new Map(action.picks.map((p) => [p.slug, p.position]));
      return {
        ...state,
        mine: state.mine.map((p) => (booked.has(p.slug) ? { ...p, position: booked.get(p.slug)! } : p)),
        lanePlan: action.lanePlan ?? state.lanePlan,
      };
    }
    case "setLanePlan":
      return { ...state, lanePlan: action.lanePlan };
    case "remove":
      return {
        ...state,
        mine: dropPick(state.mine, action.slug),
        enemy: dropPick(state.enemy, action.slug),
        banned: dropBan(state.banned, action.slug),
      };
    case "clearSlot":
      return { ...state, [action.slot]: [] };
    case "swapTeams":
      // `lanePlan` is untouched on purpose: it describes how the four duos meet,
      // which is the same fact from either seat. See `LanePlan`.
      //
      // Bans, unlike the lane plan, do change hands. "Who banned this" is a
      // statement about a seat, so taking the other seat makes my bans theirs —
      // and it has to, or swapping would hand the intent reading my own bans as
      // though they were evidence about the enemy.
      return {
        ...state,
        mine: state.enemy,
        enemy: state.mine,
        banned: state.banned.map((b) => ({
          ...b,
          by: b.by === null ? null : b.by === "mine" ? "enemy" : "mine",
        })),
      };
    case "reset":
      return EMPTY;
    default:
      return state;
  }
}

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
  return EMPTY;
}

export function useDraft() {
  const [state, dispatch] = useReducer(reducer, EMPTY, readStored);

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
    total,
  };
}

export type DraftApi = ReturnType<typeof useDraft>;
