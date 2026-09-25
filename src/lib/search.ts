import type { Hero } from "../types";

/**
 * Shorthand people actually type mid-draft. Valve's internal names (nevermore,
 * furion, wisp, zuus, …) come along for free via `hero.steam`, so this table
 * only needs the community abbreviations.
 */
const ALIASES: Record<string, string[]> = {
  "anti-mage": ["am", "magina"],
  "ancient-apparition": ["aa"],
  "arc-warden": ["aw", "arc"],
  "bounty-hunter": ["bh"],
  "bloodseeker": ["bs", "seeker"],
  "bristleback": ["bb", "brist"],
  "broodmother": ["brood", "bruda", "brud"],
  "centaur-warrunner": ["cent", "kent"],
  "chaos-knight": ["ck"],
  "crystal-maiden": ["cm"],
  "dark-seer": ["ds", "seer"],
  "dark-willow": ["dw", "wilow", "willow"],
  "death-prophet": ["dp"],
  "dragon-knight": ["dk"],
  "drow-ranger": ["drow"],
  "earth-spirit": ["es", "earth"],
  "earthshaker": ["shaker"],
  "elder-titan": ["et", "titan"],
  "ember-spirit": ["ember"],
  "faceless-void": ["fv", "void"],
  "keeper-of-the-light": ["kotl"],
  "legion-commander": ["lc", "legion"],
  "lifestealer": ["naix"],
  "lone-druid": ["ld", "druid"],
  "magnus": ["magnus", "rp"],
  "medusa": ["dusa"],
  "mirana": ["potm"],
  "monkey-king": ["mk"],
  "naga-siren": ["naga"],
  "natures-prophet": ["np"],
  "necrophos": ["necro"],
  "night-stalker": ["ns"],
  "nyx-assassin": ["nyx"],
  "outworld-destroyer": ["od"],
  "phantom-assassin": ["pa"],
  "phantom-lancer": ["pl"],
  "primal-beast": ["pb"],
  "queen-of-pain": ["qop"],
  "sand-king": ["sk"],
  "shadow-demon": ["sd"],
  "shadow-fiend": ["sf"],
  "shadow-shaman": ["ss", "rhasta"],
  "skywrath-mage": ["sky", "swm"],
  "spirit-breaker": ["sb", "bara"],
  "storm-spirit": ["storm"],
  "templar-assassin": ["ta"],
  "terrorblade": ["tb"],
  "treant-protector": ["treant"],
  "troll-warlord": ["troll"],
  "vengeful-spirit": ["vs", "venge"],
  "venomancer": ["veno"],
  "wraith-king": ["wk"],
  "windranger": ["wr"],
  "winter-wyvern": ["ww", "wyvern"],
  "witch-doctor": ["wd"],
};

const normalize = (s: string) => s.toLowerCase().replace(/['’-]/g, "").replace(/\s+/g, " ").trim();

export interface SearchIndexEntry {
  hero: Hero;
  name: string;
  initials: string;
  tokens: string[];
  aliases: string[];
}

export function buildSearchIndex(heroes: Hero[]): SearchIndexEntry[] {
  return heroes.map((hero) => {
    const name = normalize(hero.name);
    const tokens = name.split(" ").filter(Boolean);
    return {
      hero,
      name,
      initials: tokens.map((t) => t[0] ?? "").join(""),
      tokens,
      aliases: [
        normalize(hero.steam),
        normalize(hero.steam.replace(/_/g, " ")),
        ...(ALIASES[hero.slug] ?? []).map(normalize),
      ],
    };
  });
}

/**
 * Rank heroes for a query. Lower score = better match; `null` = no match.
 * Ordering: exact > prefix > alias > initials > word-start > substring.
 */
function scoreEntry(entry: SearchIndexEntry, query: string): number | null {
  if (entry.name === query) return 0;
  if (entry.aliases.includes(query)) return 1;
  if (entry.name.startsWith(query)) return 2;
  if (entry.initials === query) return 3;
  if (entry.tokens.some((t) => t.startsWith(query))) return 4;
  if (entry.aliases.some((a) => a.startsWith(query))) return 5;
  if (entry.name.includes(query)) return 6;
  if (entry.aliases.some((a) => a.includes(query))) return 7;
  return null;
}

/** A typo of a whole name or nickname: "phantm lancr", "invokr", "lnia". */
export const TYPO = 8;

export interface SearchHit {
  hero: Hero;
  /** 0 exact name, 1 exact alias, up to 7 for a substring of an alias — see `scoreEntry` — or `TYPO`. */
  score: number;
}

/**
 * Optimal string alignment distance, so a swapped pair costs one edit like any
 * other slip. Gives up with `max + 1` as soon as it cannot come back under.
 */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let before: number[] = [];
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let rowBest = i;
    for (let j = 1; j <= b.length; j++) {
      const substitution = previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1);
      let d = Math.min(previous[j]! + 1, current[j - 1]! + 1, substitution);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d = Math.min(d, before[j - 2]! + 1);
      }
      current[j] = d;
      rowBest = Math.min(rowBest, d);
    }
    if (rowBest > max) return max + 1;
    before = previous;
    previous = current;
  }
  return previous[b.length]!;
}

/** "lnia" for "lina": the same letters with one neighbouring pair swapped. */
function isSwap(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return i < a.length - 1 && a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2);
}

/**
 * How many slips a query may hold and still read as a hero's name, or -1 when it
 * cannot be one. Measured against the 10,000 most common English words: short
 * words sit one letter from too many of them (line/Lina, door/Doom, bank/Bane),
 * so up to five letters only a swapped pair counts. A slip on the first letter is
 * never allowed; it is rare, and allowing it lets "when" read as Chen.
 */
function typoEdits(query: string, candidate: string): number {
  if (query.length < 4 || candidate[0] !== query[0]) return -1;
  if (query.length < 6) return isSwap(query, candidate) ? 1 : -1;
  const max = query.length < 10 ? 1 : 2;
  const edits = editDistance(query, candidate, max);
  return edits <= max ? edits : -1;
}

/** Heroes whose whole name or nickname the query is a typo of, closest first. */
function typoHits(index: SearchIndexEntry[], query: string): Array<SearchHit & { name: string }> {
  const hits: Array<SearchHit & { name: string; edits: number }> = [];
  for (const entry of index) {
    const edits = [entry.name, ...entry.aliases]
      .map((candidate) => typoEdits(query, candidate))
      .filter((n) => n >= 0);
    if (edits.length) hits.push({ hero: entry.hero, score: TYPO, name: entry.name, edits: Math.min(...edits) });
  }
  return hits.sort((a, b) => a.edits - b.edits || a.name.localeCompare(b.name));
}

function rankHeroes(index: SearchIndexEntry[], query: string): SearchHit[] {
  const hits: Array<SearchHit & { name: string }> = [];
  for (const entry of index) {
    const score = scoreEntry(entry, query);
    if (score !== null) hits.push({ hero: entry.hero, score, name: entry.name });
  }
  if (!hits.length) return typoHits(index, query);
  hits.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));
  return hits;
}

export function searchHeroes(index: SearchIndexEntry[], rawQuery: string): Hero[] {
  const query = normalize(rawQuery);
  if (!query) return index.map((e) => e.hero);
  return rankHeroes(index, query).map((h) => h.hero);
}

/** The hit `Enter` would take for this query, with how closely it matched. */
export function topHit(index: SearchIndexEntry[], rawQuery: string): SearchHit | null {
  const query = normalize(rawQuery);
  return query ? (rankHeroes(index, query)[0] ?? null) : null;
}
