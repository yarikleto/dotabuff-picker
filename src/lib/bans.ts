import type { Ban, BanEntry, BanSide } from "../types";

/**
 * Reading a ban, whichever of its two shapes the caller used.
 *
 * `BanEntry` is a union so the scoring layer could keep accepting a plain list
 * of slugs, which is all most of its callers ever had. Everything that consumes
 * a ban list goes through these two functions instead of narrowing the union in
 * place — one type test, in one file, rather than the same `typeof b ===
 * "string"` scattered across the app.
 */
export const banSlug = (ban: BanEntry): string => (typeof ban === "string" ? ban : ban.slug);

/** Null for a bare slug: an unattributed ban is evidence about nobody. */
export const banSide = (ban: BanEntry): BanSide | null =>
  typeof ban === "string" ? null : ban.by;

export const banSlugs = (bans: readonly BanEntry[]): string[] => bans.map(banSlug);

/**
 * The heroes one side removed.
 *
 * Bans with no recorded side are left out rather than shared between the two.
 * Splitting them evenly, or defaulting them to "mine", would put words in the
 * enemy's mouth — and the whole reason for tracking the side is that the
 * enemy's bans are read as a statement of intent.
 */
export const bansBy = (bans: readonly BanEntry[], side: BanSide): string[] =>
  bans.filter((b) => banSide(b) === side).map(banSlug);

/**
 * The same ban in its full shape, whichever way it arrived.
 *
 * The completion of the pair above: `banSlug` and `banSide` each answer half
 * the question, and a caller that wants both would otherwise narrow the union
 * itself or call both and rebuild the object — which is the one thing this
 * module exists to stop.
 *
 * Distinct from `readBans` in `state/draft.ts`, which looks similar and is not.
 * That one parses `unknown` off localStorage and must be free to reject a
 * malformed entry; this takes an already-typed `BanEntry` and cannot fail.
 */
export const toBan = (ban: BanEntry): Ban =>
  typeof ban === "string" ? { slug: ban, by: null } : ban;
