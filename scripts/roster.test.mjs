import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { addEntries, entryFor, missingHeroes, parseEntries, slugFromName } from "./roster.mjs";

// Run with: node --test scripts/*.test.mjs

const roster = () => readFile(new URL("../src/data/heroes.ts", import.meta.url), "utf8");

test("slugs follow Dotabuff's, apostrophes and all", () => {
  assert.equal(slugFromName("Nature's Prophet"), "natures-prophet");
  assert.equal(slugFromName("Anti-Mage"), "anti-mage");
  assert.equal(slugFromName("Queen of Pain"), "queen-of-pain");
  assert.equal(slugFromName("Io"), "io");
});

test("every entry already in the roster has the slug the rule would give it", async () => {
  const entries = parseEntries(await roster());
  assert.ok(entries.length >= 127);
  assert.deepEqual(entries.filter((e) => slugFromName(e.name) !== e.slug), []);
});

test("OpenDota's rows become roster entries; universal heroes are 'uni'", () => {
  assert.deepEqual(
    entryFor({ id: 155, name: "npc_dota_hero_largo", localized_name: "Largo", primary_attr: "all" }),
    { slug: "largo", name: "Largo", attr: "uni", steam: "largo" },
  );
  assert.equal(entryFor({ name: "npc_dota_hero_x", localized_name: "X", primary_attr: "mystery" }), null);
});

test("only heroes the roster lacks are added, matched on Valve's name", async () => {
  const entries = parseEntries(await roster());
  const api = [
    { name: "npc_dota_hero_axe", localized_name: "Axe", primary_attr: "str" },
    { name: "npc_dota_hero_brand_new", localized_name: "Brand New", primary_attr: "int" },
  ];
  assert.deepEqual(missingHeroes(api, entries), [
    { slug: "brand-new", name: "Brand New", attr: "int", steam: "brand_new" },
  ]);
  assert.throws(
    () => missingHeroes([{ name: "npc_dota_hero_axe_two", localized_name: "Axe", primary_attr: "str" }], entries),
    /would reuse the slug "axe"/,
  );
});

test("a new hero is written in place, in the file's own format, and nothing else moves", async () => {
  const source = await roster();
  const added = addEntries(source, [{ slug: "brand-new", name: "Brand New", attr: "int", steam: "brand_new" }]);
  const entries = parseEntries(added);

  assert.equal(entries.length, parseEntries(source).length + 1);
  const at = entries.findIndex((e) => e.slug === "brand-new");
  assert.ok(entries[at - 1].name.localeCompare("Brand New") < 0 && entries[at + 1].name.localeCompare("Brand New") > 0);
  assert.match(added, /\n {2}\{ slug: "brand-new", name: "Brand New", attr: "int", steam: "brand_new" \},\n/);
  // Only the one line is new: the header, the other entries and the closing bracket survive untouched.
  const before = source.split("\n");
  const after = added.split("\n");
  assert.equal(after.length, before.length + 1);
  assert.deepEqual(after.filter((line) => !line.includes("brand-new")), before);
  assert.equal(addEntries(source, []), source, "nothing to add, nothing written differently");
});
