import test from "node:test";
import assert from "node:assert/strict";
import { BASE_HEROES } from "../data/heroes.ts";
import { planCommand, readCommand, type CommandAction, type CommandContext } from "./command.ts";
import { EMPTY_DRAFT, draftReducer, type DraftState } from "./draftState.ts";
import { buildSearchIndex, topHit } from "./search.ts";
import type { Hero } from "../types.ts";

const heroes: Hero[] = BASE_HEROES.map((h) => ({ ...h }));
const index = buildSearchIndex(heroes);
const bySlug = new Map(heroes.map((h) => [h.slug, h]));
const read = (text: string) => readCommand(index, text);

const ctx = (over: Partial<CommandContext> = {}): CommandContext => ({
  armed: "mine",
  banSide: "mine",
  heroOf: (slug) => bySlug.get(slug),
  ...over,
});

const act = (slug: string, verb: CommandAction["verb"], team: CommandAction["team"] = null, seat: CommandAction["seat"] = null): CommandAction => ({
  verb,
  team,
  slug,
  seat,
});

const board = (over: Partial<DraftState>): DraftState => ({ ...EMPTY_DRAFT, ...over });

// Every way the search box knows a hero: the name as written, and each normalised name and nickname.
const namesOf = (entry: (typeof index)[number]) => [entry.hero.name, entry.hero.steam, entry.name, ...entry.aliases];

test("every hero name and nickname on its own is still a search", () => {
  for (const entry of index) {
    for (const query of namesOf(entry)) {
      const got = read(query);
      assert.equal(got.isCommand, false, `"${query}" read as a command`);
      assert.equal(got.searchText, query, `"${query}" searched for something else`);
    }
  }
});

test("every hero name and nickname in a sentence names the hero Enter would take", () => {
  for (const entry of index) {
    const hero = entry.hero;
    for (const query of namesOf(entry)) {
      const expected = topHit(index, query)?.hero.slug;
      const got = read(`they banned ${query}`);
      assert.deepEqual(
        got.actions,
        [act(expected!, "ban", "enemy")],
        `"they banned ${query}" did not ban ${expected}`,
      );
      assert.deepEqual(got.unknown, []);
    }
    const byName = read(`we picked ${hero.name}`);
    assert.equal(byName.actions[0]?.slug, hero.slug, `"${hero.name}" found somebody else`);
  }
});

test("the phrasings from the request", () => {
  assert.deepEqual(read("they banned lina").actions, [act("lina", "ban", "enemy")]);
  assert.deepEqual(read("I pick pl").actions, [act("phantom-lancer", "pick", "mine")]);
  assert.deepEqual(read("we ban bruda").actions, [act("broodmother", "ban", "mine")]);
});

test("side and action carry across a list", () => {
  assert.deepEqual(read("they banned lina, pl and am").actions, [
    act("lina", "ban", "enemy"),
    act("phantom-lancer", "ban", "enemy"),
    act("anti-mage", "ban", "enemy"),
  ]);
  assert.deepEqual(read("they picked lina mid, we banned am").actions, [
    act("lina", "pick", "enemy", 2),
    act("anti-mage", "ban", "mine"),
  ]);
  assert.deepEqual(read("they picked lina, we sf").actions, [
    act("lina", "pick", "enemy"),
    act("shadow-fiend", "pick", "mine"),
  ]);
});

test("seats are read wherever they sit", () => {
  assert.deepEqual(read("enemy mid is sf").actions, [act("shadow-fiend", null, "enemy", 2)]);
  assert.deepEqual(read("cm hard support for us").actions, [act("crystal-maiden", null, "mine", 5)]);
  assert.deepEqual(read("pos 1 am").actions, [act("anti-mage", null, null, 1)]);
  assert.deepEqual(read("they took lion support").actions, [act("lion", "pick", "enemy", "support")]);
  assert.deepEqual(read("axe off-lane").actions, [act("axe", null, null, 3)]);
});

test("a hero list without separators splits into heroes", () => {
  assert.deepEqual(read("ban am pa sf").actions, [
    act("anti-mage", "ban"),
    act("phantom-assassin", "ban"),
    act("shadow-fiend", "ban"),
  ]);
  assert.deepEqual(read("lina pl").actions, [act("lina", null), act("phantom-lancer", null)]);
  assert.deepEqual(read("they banned shadow fiend lina").actions, [
    act("shadow-fiend", "ban", "enemy"),
    act("lina", "ban", "enemy"),
  ]);
});

test("the stronger verb in a clause wins", () => {
  assert.deepEqual(read("we have to ban lina").actions, [act("lina", "ban", "mine")]);
  assert.deepEqual(read("lina got banned").actions, [act("lina", "ban")]);
  assert.deepEqual(read("oops, remove sniper").actions, [act("sniper", "remove")]);
  assert.deepEqual(read("oops, remove sniper").unknown, []);
  assert.deepEqual(read("move lion to 4").actions, [act("lion", null, null, 4)]);
});

test("'am' after 'I' is the verb, anywhere else it is Anti-Mage", () => {
  assert.deepEqual(read("i am playing pl").actions, [act("phantom-lancer", "pick", "mine")]);
  assert.deepEqual(read("they took am").actions, [act("anti-mage", "pick", "enemy")]);
});

test("a lone keyword is a search, and a keyword with nothing after it shows the whole pool", () => {
  for (const query of ["we", "i", "ban", "me"]) {
    const got = read(query);
    assert.equal(got.isCommand, false, query);
    assert.equal(got.searchText, query);
  }
  const started = read("they banned ");
  assert.equal(started.isCommand, true);
  assert.deepEqual(started.actions, []);
  assert.equal(started.searchText, "");
});

test("the grid follows the hero being typed", () => {
  assert.equal(read("they banned lina and p").searchText, "p");
  assert.equal(read("they banned lina mid").searchText, "lina");
  assert.equal(read("ban am pa s").searchText, "s");
  assert.equal(read("they banned lina and ").searchText, "");
});

test("words that name nobody are reported, not guessed at", () => {
  const got = read("they took the spider lady");
  assert.equal(got.isCommand, true);
  assert.deepEqual(got.actions, []);
  assert.deepEqual(got.unknown, ["spider lady"]);
  assert.equal(got.searchText, "spider lady");

  assert.equal(read("spider lady").isCommand, false);
  assert.deepEqual(read("they banned лину").unknown, ["лину"]);
});

test("a stray word is skipped without sinking the heroes around it", () => {
  const before = read("they instantly banned lina");
  assert.deepEqual(before.actions, [act("lina", "ban", "enemy")]);
  assert.deepEqual(before.unknown, ["instantly"]);

  const inside = read("lina instantly got banned");
  assert.deepEqual(inside.actions, [act("lina", "ban")]);
  assert.deepEqual(inside.unknown, ["instantly"]);
});

test("everyday words next to a hero stay words", () => {
  const words = ["line", "door", "bank", "when", "seen", "kept", "find", "make", "said", "love", "best"];
  const partial = ["back", "more", "night", "light", "king", "fire", "master", "or", "do", "of", "too", "already"];
  for (const word of [...words, ...partial]) {
    const got = read(`they banned lina ${word}`);
    assert.deepEqual(got.actions, [act("lina", "ban", "enemy")], word);
    assert.deepEqual(got.unknown, [word], word);
  }
});

test("a clause with no action and a word it cannot read does nothing", () => {
  const typo = read("bannned lina");
  assert.deepEqual(typo.actions, []);
  assert.deepEqual(typo.held, ["lina"]);
  assert.deepEqual(typo.unknown, ["bannned"]);

  assert.deepEqual(read("they bannned lina").held, ["lina"]);
  // A carried action is not enough: the unknown word may be a different action misspelled.
  const carried = read("they banned lina, pickd am");
  assert.deepEqual(carried.actions, [act("lina", "ban", "enemy")]);
  assert.deepEqual(carried.held, ["anti-mage"]);
  const unpunctuated = read("they banned lina we pickd pl");
  assert.deepEqual(unpunctuated.actions, [act("lina", "ban", "enemy")]);
  assert.deepEqual(unpunctuated.held, ["phantom-lancer"]);
  // Without an unknown word the carried action is the whole point of a list.
  assert.deepEqual(read("they banned lina, pl and am").held, []);
});

test("typos of a whole name or nickname are read", () => {
  assert.deepEqual(read("they banned lnia").actions, [act("lina", "ban", "enemy")]);
  assert.deepEqual(read("they banned phantm lancr").actions, [act("phantom-lancer", "ban", "enemy")]);
  assert.deepEqual(read("I pick invokr").actions, [act("invoker", "pick", "mine")]);
  assert.deepEqual(read("they took shadow feind mid").actions, [act("shadow-fiend", "pick", "enemy", 2)]);
  assert.deepEqual(read("we ban phantomlancer and crystal maden").actions, [
    act("phantom-lancer", "ban", "mine"),
    act("crystal-maiden", "ban", "mine"),
  ]);
});

test("a new side and action start a new clause without a comma", () => {
  assert.deepEqual(read("they banned lina we picked pl").actions, [
    act("lina", "ban", "enemy"),
    act("phantom-lancer", "pick", "mine"),
  ]);
  assert.deepEqual(read("they picked lina mid we will ban am").actions, [
    act("lina", "pick", "enemy", 2),
    act("anti-mage", "ban", "mine"),
  ]);
  assert.deepEqual(read("we banned lina because their mid is pl").actions, [
    act("lina", "ban", "mine"),
    act("phantom-lancer", null, "enemy", 2),
  ]);
  assert.deepEqual(read("ban lina for them").actions, [act("lina", "ban", "enemy")]);
  assert.deepEqual(read("ban lina for them please").actions, [act("lina", "ban", "enemy")]);
  assert.deepEqual(read("we take lion as our mid").actions, [act("lion", "pick", "mine", 2)]);
  assert.deepEqual(read("lina for us").actions, [act("lina", null, "mine")]);
  assert.deepEqual(read("lina got banned by them").actions, [act("lina", "ban", "enemy")]);
});

test("a new pick takes the named seat, from whoever held it", () => {
  const start = board({ mine: [{ slug: "anti-mage", position: 1 }] });
  const plan = planCommand(start, [act("phantom-lancer", "pick", "mine", 1)], ctx());
  assert.deepEqual(plan.next.mine, [
    { slug: "anti-mage", position: null },
    { slug: "phantom-lancer", position: 1 },
  ]);
  assert.deepEqual(plan.outcomes, [{ slug: "phantom-lancer", text: "Your pick: Phantom Lancer, pos 1", tone: "mine" }]);
});

test("a pick with no seat goes to the first open one", () => {
  const plan = planCommand(board({ enemy: [{ slug: "axe", position: 1 }] }), [act("lina", "pick", "enemy")], ctx());
  assert.deepEqual(plan.next.enemy[1], { slug: "lina", position: 2 });
});

test("naming a hero already in place never toggles them off", () => {
  const picked = board({ mine: [{ slug: "lina", position: 2 }] });
  const again = planCommand(picked, [act("lina", "pick", "mine")], ctx());
  assert.equal(again.next, picked);
  assert.equal(again.changed, false);
  assert.equal(again.outcomes[0]?.text, "Lina is already your pick");

  const banned = board({ banned: [{ slug: "lina", by: "enemy" }] });
  const reban = planCommand(banned, [act("lina", "ban", "enemy")], ctx());
  assert.equal(reban.next, banned);
  assert.equal(reban.outcomes[0]?.tone, null);
});

test("banning a hero the other side banned moves the ban, not the hero", () => {
  const plan = planCommand(board({ banned: [{ slug: "lina", by: "mine" }] }), [act("lina", "ban", "enemy")], ctx());
  assert.deepEqual(plan.next.banned, [{ slug: "lina", by: "enemy" }]);
  assert.equal(plan.outcomes[0]?.text, "Lina is now their ban");
});

test("a ban naming nobody is the armed side's", () => {
  const plan = planCommand(EMPTY_DRAFT, [act("lina", "ban")], ctx({ banSide: "enemy" }));
  assert.deepEqual(plan.next.banned, [{ slug: "lina", by: "enemy" }]);
});

test("a bare hero list follows the armed slot, bans included", () => {
  const plan = planCommand(EMPTY_DRAFT, [act("lina", null), act("axe", null)], ctx({ armed: "banned", banSide: "enemy" }));
  assert.deepEqual(plan.next.banned, [
    { slug: "lina", by: "enemy" },
    { slug: "axe", by: "enemy" },
  ]);
});

test("a seat for a hero already drafted moves them on their own team", () => {
  const start = board({ enemy: [{ slug: "lina", position: 1 }] });
  const plan = planCommand(start, [act("lina", null, null, 2)], ctx({ armed: "mine" }));
  assert.deepEqual(plan.next.enemy, [{ slug: "lina", position: 2 }]);
  assert.deepEqual(plan.next.mine, []);
  assert.equal(plan.outcomes[0]?.text, "Lina moved to pos 2");
});

test("a full team or ban list turns the action away and says so", () => {
  const five = ["axe", "lina", "lion", "sven", "tiny"].map((slug) => ({ slug, position: null }));
  const plan = planCommand(board({ mine: five }), [act("pudge", "pick", "mine")], ctx());
  assert.equal(plan.changed, false);
  assert.equal(plan.outcomes[0]?.text, "Your team is full");
});

test("remove takes a hero off wherever they are", () => {
  const start = board({ enemy: [{ slug: "lina", position: 2 }], banned: [{ slug: "axe", by: "mine" }] });
  const plan = planCommand(start, [act("lina", "remove"), act("axe", "remove"), act("pudge", "remove")], ctx());
  assert.deepEqual(plan.next.enemy, []);
  assert.deepEqual(plan.next.banned, []);
  assert.deepEqual(
    plan.outcomes.map((o) => o.text),
    ["Removed Lina", "Removed Axe", "Pudge is not on the board"],
  );
});

test("banning a drafted hero takes them off the team", () => {
  const plan = planCommand(board({ mine: [{ slug: "lina", position: 2 }] }), [act("lina", "ban", "enemy")], ctx());
  assert.deepEqual(plan.next.mine, []);
  assert.equal(plan.outcomes[0]?.text, "Their ban: Lina (taken off your team)");
});

test("'support' seats a hero at whichever of 4 and 5 they play more, if it is free", () => {
  const lion: Hero = { ...bySlug.get("lion")!, positions: { 4: 0.35, 5: 0.6 } };
  const heroOf = (slug: string) => (slug === "lion" ? lion : bySlug.get(slug));
  const open = planCommand(EMPTY_DRAFT, [act("lion", "pick", "enemy", "support")], ctx({ heroOf }));
  assert.equal(open.next.enemy[0]?.position, 5);

  const fiveTaken = board({ enemy: [{ slug: "crystal-maiden", position: 5 }] });
  const plan = planCommand(fiveTaken, [act("lion", "pick", "enemy", "support")], ctx({ heroOf }));
  assert.equal(plan.next.enemy[1]?.position, 4);
});

test("several actions see each other's seats", () => {
  const plan = planCommand(EMPTY_DRAFT, [act("lina", "pick", "mine"), act("lion", "pick", "mine")], ctx());
  const seats = plan.next.mine.map((p) => p.position);
  assert.equal(new Set(seats).size, 2);
});

test("replace swaps in a whole board", () => {
  const next = board({ mine: [{ slug: "lina", position: 2 }] });
  assert.equal(draftReducer(EMPTY_DRAFT, { type: "replace", state: next }), next);
});
