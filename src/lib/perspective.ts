/**
 * The app's one rule about signs, in one place.
 *
 * Every number on screen is what it does to *your* draft, so green always means
 * good for you. Ban candidates are ranked from the enemy's seat — the score
 * measures how well the hero serves *them* — so a raw +6 there is six points
 * off your draft and has to be read back as −6 before it is printed.
 *
 * This lived as three separate copies of `mode === "ban" ? -1 : 1`: one in the
 * suggestion panel, one in the hover card, and a third spelled differently
 * again in the grid's badge. Three copies of a convention is three chances for
 * one of them to be missed, and the symptom is the worst kind this app has —
 * two panels quoting the same arithmetic at the same hero with opposite signs,
 * which reads as a broken model rather than as a missing minus.
 */
import type { ScoreMode } from "../types";

export interface Perspective {
  /** A score read from your side of the board, whichever seat produced it. */
  mine: (n: number) => number;
  /** The colour that follows: green when the number helps you, red when it does not. */
  tone: (n: number) => "good" | "bad";
}

export function fromYourSide(mode: ScoreMode): Perspective {
  const side = mode === "ban" ? -1 : 1;
  const mine = (n: number) => side * n;
  return { mine, tone: (n) => (mine(n) >= 0 ? "good" : "bad") };
}
