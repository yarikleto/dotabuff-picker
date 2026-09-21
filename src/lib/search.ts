import type { Hero } from "../types";

/**
 * Shorthand people actually type mid-draft. Valve's internal names (nevermore,
 * furion, wisp, zuus, …) come along for free via `hero.steam`, so this table
 * only needs the community abbreviations.
 */
const ALIASES: Record<string, string[]> = {
  "anti-mage": ["am", "magina"],
  "ancient-apparition": ["aa"],
  "arc-warden": ["aw"],
  "bounty-hunter": ["bh"],
  "bloodseeker": ["bs"],
  "bristleback": ["bb"],
  "broodmother": ["brood"],
  "centaur-warrunner": ["cent"],
  "chaos-knight": ["ck"],
  "crystal-maiden": ["cm"],
  "dark-seer": ["ds"],
  "dark-willow": ["dw"],
  "death-prophet": ["dp"],
  "dragon-knight": ["dk"],
  "drow-ranger": ["drow"],
  "earth-spirit": ["es", "earth"],
  "earthshaker": ["es", "shaker"],
  "elder-titan": ["et"],
  "ember-spirit": ["ember"],
  "faceless-void": ["fv", "void"],
  "keeper-of-the-light": ["kotl"],
  "legion-commander": ["lc", "legion"],
  "lifestealer": ["naix"],
  "lone-druid": ["ld"],
  "magnus": ["magnus", "rp"],
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
  "void-spirit": ["void spirit"],
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
      aliases: [normalize(hero.steam), ...(ALIASES[hero.slug] ?? []).map(normalize)],
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

export function searchHeroes(index: SearchIndexEntry[], rawQuery: string): Hero[] {
  const query = normalize(rawQuery);
  if (!query) return index.map((e) => e.hero);

  const hits: Array<{ hero: Hero; score: number; name: string }> = [];
  for (const entry of index) {
    const score = scoreEntry(entry, query);
    if (score !== null) hits.push({ hero: entry.hero, score, name: entry.name });
  }
  hits.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));
  return hits.map((h) => h.hero);
}
