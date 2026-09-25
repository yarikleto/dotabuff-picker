import test from "node:test";
import assert from "node:assert/strict";
import { BASE_HEROES } from "../data/heroes.ts";
import { TYPO, buildSearchIndex, searchHeroes, topHit } from "./search.ts";

const index = buildSearchIndex(BASE_HEROES.map((h) => ({ ...h })));
const slugFor = (query: string) => topHit(index, query)?.hero.slug ?? null;

test("a typo of a name or nickname finds the hero", () => {
  assert.equal(slugFor("lnia"), "lina");
  assert.equal(slugFor("invokr"), "invoker");
  assert.equal(slugFor("pudgde"), "pudge");
  assert.equal(slugFor("sniepr"), "sniper");
  assert.equal(slugFor("phantm lancr"), "phantom-lancer");
  assert.equal(slugFor("crystal maden"), "crystal-maiden");
  assert.equal(slugFor("kotl"), "keeper-of-the-light");
  assert.equal(topHit(index, "lnia")?.score, TYPO);
});

test("the grid shows the closest names when nothing matches as typed", () => {
  assert.deepEqual(
    searchHeroes(index, "lnia").map((h) => h.slug),
    ["lina"],
  );
  assert.deepEqual(searchHeroes(index, "zzzz"), []);
});

test("typos are the last resort: anything that matches as typed wins", () => {
  assert.equal(slugFor("lion"), "lion");
  assert.equal(slugFor("pa"), "phantom-assassin");
  assert.notEqual(topHit(index, "shadow")?.score, TYPO);
});

test("short words count only a swapped pair, and never a slip on the first letter", () => {
  assert.equal(slugFor("razr"), null);
  assert.equal(slugFor("ilna"), null);
  assert.equal(slugFor("lcih"), "lich");
});

test("everyday words are not read as typos of a hero", () => {
  const words = [
    "line", "door", "bank", "base", "when", "then", "seen", "seem", "kept", "find", "make", "said",
    "send", "love", "long", "best", "store", "march", "large", "money", "friend", "field", "watch",
    "seven", "task", "draw", "broad", "weather", "paid", "plain", "kind", "tony", "lung",
  ];
  for (const word of words) assert.notEqual(topHit(index, word)?.score, TYPO, word);
});
