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

export type DraftAction =
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
  | { type: "reset" }
  /** A whole board at once: a typed command lands as one change and undoes as one. */
  | { type: "replace"; state: DraftState };

export const EMPTY_DRAFT: DraftState = { mine: [], enemy: [], banned: [], lanePlan: "standard" };

const capacity: Record<Slot, number> = {
  mine: TEAM_SIZE,
  enemy: TEAM_SIZE,
  banned: MAX_BANS,
};

const dropPick = (list: DraftPick[], slug: string) => list.filter((p) => p.slug !== slug);
const dropBan = (list: Ban[], slug: string) => list.filter((b) => b.slug !== slug);

export function draftReducer(state: DraftState, action: DraftAction): DraftState {
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
      return EMPTY_DRAFT;
    case "replace":
      return action.state;
    default:
      return state;
  }
}
