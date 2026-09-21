/**
 * Writing public/data/matchups.json.
 *
 * Two collection paths end up here — the Node scraper and the Electron browser
 * run — and the file they produce has to be identical, carry-over rule
 * included: a run never publishes less than the run before it. Heroes it did
 * not reach keep their tables, and derived fields it could not compute keep
 * their old values.
 *
 * That second half matters more than it looks. The lane pages are a separate
 * request from the matchup pages, so a run can lose *only* them — offline,
 * --no-lanes, or a partial block — and still write a complete-looking file with
 * every position silently gone, which switches the app's role filters off. The
 * dataset is a merge, not a snapshot.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Shipped inside the JSON so the file explains itself to whoever opens it. */
export const NOTE =
  "matchups[a][b] = [disadvantage, winRate, matches] from hero A's page. " +
  "disadvantage > 0 means A performs worse than usual against B. " +
  "hero.positions[1..5] is the share of that hero's games spent in each " +
  "position, reconstructed from lane presence and GPM.";

/**
 * Hero fields that come from somewhere other than the hero's own matchup page:
 * the lane tables, and the stats column on /heroes. These are the ones a run
 * can lose on its own.
 */
export const DERIVED_HERO_FIELDS = [
  "lanes",
  "positions",
  "topPositions",
  "winRate",
  "pickRate",
  "banRate",
  "tier",
];

/** The previous file, or null when there isn't a usable one. */
export async function readPrevious(outFile) {
  try {
    const previous = JSON.parse(await readFile(outFile, "utf8"));
    return previous && typeof previous === "object" ? previous : null;
  } catch {
    return null; // first run, or the old file is unreadable
  }
}

/**
 * Fold the previous file into what this run collected. Both arguments are
 * mutated in place — that is what every caller wants — and the counts come back
 * so the run summary can say what was reused rather than freshly fetched.
 */
export async function carryOver(outFile, { heroes, matchups }) {
  const previous = await readPrevious(outFile);
  if (!previous) return { matchups: 0, fields: 0 };

  let carriedTables = 0;
  for (const [slug, table] of Object.entries(previous.matchups ?? {})) {
    if (!matchups[slug] && table && Object.keys(table).length) {
      matchups[slug] = table;
      carriedTables++;
    }
  }

  const before = new Map((previous.heroes ?? []).map((h) => [h.slug, h]));
  let restored = 0;
  for (const hero of heroes ?? []) {
    const old = before.get(hero.slug);
    if (!old) continue;
    let touched = false;
    for (const field of DERIVED_HERO_FIELDS) {
      if (hero[field] === undefined && old[field] !== undefined) {
        hero[field] = old[field];
        touched = true;
      }
    }
    if (touched) restored++;
  }

  return { matchups: carriedTables, fields: restored };
}

/** Individual matchup cells across every hero, for the run summary. */
export const countCells = (matchups) =>
  Object.values(matchups).reduce((n, t) => n + Object.keys(t).length, 0);

export async function writeMatchups(outFile, { heroes, matchups, source }) {
  const payload = {
    generatedAt: new Date().toISOString(),
    source,
    note: NOTE,
    heroes,
    matchups,
  };
  await mkdir(dirname(outFile), { recursive: true });
  await writeFile(outFile, JSON.stringify(payload), "utf8");
  return payload;
}
