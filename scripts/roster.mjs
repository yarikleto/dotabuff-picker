#!/usr/bin/env node
/**
 * Keeps src/data/heroes.ts in step with the game: a hero OpenDota lists and
 * the roster lacks is added, in the file's own format and alphabetical order.
 *
 *   npm run roster
 *
 * Every collector except the Dotabuff scrape finds heroes through this roster,
 * by Valve's internal name, so a hero missing from it has no positions, lanes,
 * synergies, timings or portrait. The scrape falls back to it too when
 * Dotabuff's hero list is blocked. Existing entries are never changed or
 * removed; OpenDota needs no token.
 */

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROSTER_FILE = join(ROOT, "src", "data", "heroes.ts");
const HEROES_URL = "https://api.opendota.com/api/heroes";

/** Anything shorter is a broken response, not a game with fewer heroes. */
const MIN_HEROES = 100;

const ENTRY = /^(\s*)\{\s*slug:\s*"([^"]+)",\s*name:\s*"([^"]+)",\s*attr:\s*"([^"]+)",\s*steam:\s*"([^"]+)"\s*\},?\s*$/;

/** OpenDota's `primary_attr` to the roster's; universal heroes are "all" there. */
const ATTR = { str: "str", agi: "agi", int: "int", all: "uni" };

/** Dotabuff's slug for a hero name — it holds for every hero in the roster today. */
export const slugFromName = (name) =>
  name
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

export function parseEntries(source) {
  const entries = [];
  for (const line of source.split("\n")) {
    const m = ENTRY.exec(line);
    if (m) entries.push({ slug: m[2], name: m[3], attr: m[4], steam: m[5] });
  }
  return entries;
}

/** A roster entry for one of OpenDota's heroes, or null when the row is unusable. */
export function entryFor(hero) {
  const steam = String(hero?.name ?? "").replace(/^npc_dota_hero_/, "");
  const name = String(hero?.localized_name ?? "").trim();
  const attr = ATTR[hero?.primary_attr];
  if (!steam || !name || !attr) return null;
  return { slug: slugFromName(name), name, attr, steam };
}

const formatEntry = (indent, e) =>
  `${indent}{ slug: ${JSON.stringify(e.slug)}, name: ${JSON.stringify(e.name)}, ` +
  `attr: ${JSON.stringify(e.attr)}, steam: ${JSON.stringify(e.steam)} },`;

/**
 * The roster source with `additions` merged into its entry block, sorted by
 * name as the file already is. Everything outside the block is left as it was.
 */
export function addEntries(source, additions) {
  if (!additions.length) return source;
  const lines = source.split("\n");
  const at = lines.map((line, i) => (ENTRY.test(line) ? i : -1)).filter((i) => i >= 0);
  if (!at.length || at.at(-1) - at[0] + 1 !== at.length) {
    throw new Error("src/data/heroes.ts has no single block of hero entries — has its format changed?");
  }
  const indent = ENTRY.exec(lines[at[0]])[1];
  const merged = [...parseEntries(source), ...additions].sort((a, b) => a.name.localeCompare(b.name));
  return [
    ...lines.slice(0, at[0]),
    ...merged.map((e) => formatEntry(indent, e)),
    ...lines.slice(at.at(-1) + 1),
  ].join("\n");
}

/** OpenDota's heroes that the roster lacks, matched on Valve's internal name. */
export function missingHeroes(apiHeroes, entries) {
  const known = new Set(entries.map((e) => e.steam));
  const slugs = new Set(entries.map((e) => e.slug));
  const out = [];
  for (const hero of apiHeroes) {
    const entry = entryFor(hero);
    if (!entry || known.has(entry.steam)) continue;
    // A slug clash would merge two heroes into one tile in the app.
    if (slugs.has(entry.slug)) throw new Error(`new hero ${entry.name} would reuse the slug "${entry.slug}"`);
    out.push(entry);
  }
  return out;
}

export async function main() {
  const res = await fetch(HEROES_URL, {
    headers: { Accept: "application/json", "User-Agent": "dotabuff-picker/1.0" },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`OpenDota answered HTTP ${res.status}`);
  const heroes = await res.json();
  if (!Array.isArray(heroes) || heroes.length < MIN_HEROES) {
    throw new Error(`OpenDota listed ${Array.isArray(heroes) ? heroes.length : "no"} heroes — not trusting that`);
  }

  const source = await readFile(ROSTER_FILE, "utf8");
  const entries = parseEntries(source);
  const additions = missingHeroes(heroes, entries);
  if (!additions.length) {
    console.log(`\nRoster up to date: ${entries.length} heroes in src/data/heroes.ts\n`);
    return 0;
  }
  await writeFile(ROSTER_FILE, addEntries(source, additions), "utf8");
  console.log(`\nAdded to src/data/heroes.ts: ${additions.map((e) => `${e.name} (${e.slug})`).join(", ")}`);
  console.log(`  ${entries.length + additions.length} heroes now; the collectors after this step include them\n`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(`\nRoster update failed: ${err.message}\n`);
      process.exit(1);
    },
  );
}
