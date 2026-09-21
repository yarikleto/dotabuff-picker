import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS, suggestBans, suggestPicks } from "./scoring.ts";
import {
  ANSWER_POOL,
  MIN_ANSWERS_GONE,
  MIN_CLEARED_SHARE,
  intentScores,
  readIntent,
  readNearMisses,
} from "./intent.ts";
import { banSide, banSlug, banSlugs, bansBy, toBan } from "./bans.ts";
import type { Ban, Dataset, Hero, MatchupTable } from "../types.ts";

// Run with: node --test --experimental-strip-types src/lib/*.test.ts

const hero = (slug: string, winRate = 50, pickRate = 5): Hero => ({
  slug,
  name: slug.toUpperCase(),
  attr: "uni",
  steam: slug,
  winRate,
  pickRate,
});

/**
 * Fixture world, built around the case this reading exists for.
 *
 * `prize` is the hero with few answers and each of them decisive — three heroes
 * beat them by 7, 6 and 5 points and nobody else touches them. That shape is
 * what makes a ban list readable: removing two of three answers is a plan, and
 * it is visible as a plan precisely because there were only three.
 *
 * `bruiser` is the confound. They beat *everybody* by around 4, including
 * `prize`, so a naive reading would count a `bruiser` ban as evidence for
 * whatever hero you happened to ask about. Their general edge is subtracted
 * before anything counts, which is what makes them worth nothing here.
 *
 * `common` has eight mediocre answers instead of three good ones — the other
 * shape a hero can have, and the one the share test exists to keep quiet.
 */
function makeDataset(): Dataset {
  const heroes = [
    hero("prize", 52, 20),
    // Picked twice as often, so the ban list wants them first on the numbers
    // alone — which is what makes it visible when the reading moves `prize` past
    // them.
    hero("common", 52, 40),
    hero("answer1"),
    hero("answer2"),
    hero("answer3"),
    hero("bruiser", 54),
    hero("bystander"),
    ...Array.from({ length: 8 }, (_, i) => hero(`mild${i}`)),
  ];

  const matchups: MatchupTable = {};
  const edge = (a: string, b: string, advantage: number, matches = 40_000) => {
    (matchups[a] ??= {})[b] = { disadvantage: -advantage, winRate: 50 + advantage, matches };
    (matchups[b] ??= {})[a] = { disadvantage: advantage, winRate: 50 - advantage, matches };
  };

  edge("answer1", "prize", 7);
  edge("answer2", "prize", 6);
  edge("answer3", "prize", 5);

  // The generically strong hero: ahead of the entire pool by about the same
  // amount, `prize` included.
  for (const h of heroes) {
    if (h.slug === "bruiser") continue;
    edge("bruiser", h.slug, 4);
  }

  // Eight mild answers to `common`, none of them decisive, and graded so that
  // no two of them land exactly on the share threshold — a fixture sitting on a
  // boundary tests the boundary rather than the idea.
  for (let i = 0; i < 8; i++) edge(`mild${i}`, "common", 1 + i * 0.2);

  return {
    heroes,
    bySlug: new Map(heroes.map((h) => [h.slug, h])),
    matchups,
    synergies: {},
    generatedAt: null,
    hasData: true,
    hasPositions: false,
    hasSynergies: false,
    synergyMatches: 0,
    hasTimings: false,
    timingBuckets: [],
    timingShape: null,
    timingMatches: 0,
    error: null,
  };
}

const data = makeDataset();
const settings = DEFAULT_SETTINGS;

const bans = (...entries: Array<[string, Ban["by"]]>): Ban[] =>
  entries.map(([slug, by]) => ({ slug, by }));

const board = (banned: Ban[]) => ({ mine: [], enemy: [], banned });

test("banSlug/banSide read both shapes, and a bare slug is attributed to nobody", () => {
  assert.equal(banSlug("axe"), "axe");
  assert.equal(banSlug({ slug: "axe", by: "enemy" }), "axe");
  assert.equal(banSide("axe"), null);
  assert.equal(banSide({ slug: "axe", by: "enemy" }), "enemy");
  assert.deepEqual(toBan("axe"), { slug: "axe", by: null });
  assert.deepEqual(banSlugs(["axe", { slug: "pudge", by: "mine" }]), ["axe", "pudge"]);
});

test("bansBy leaves unattributed bans out rather than sharing them", () => {
  const list = ["loose", { slug: "a", by: "mine" as const }, { slug: "b", by: "enemy" as const }];
  assert.deepEqual(bansBy(list, "mine"), ["a"]);
  assert.deepEqual(bansBy(list, "enemy"), ["b"]);
});

test("two of their bans on one hero's answers surface that hero", () => {
  const reading = readIntent(data, board(bans(["answer1", "enemy"], ["answer2", "enemy"])), settings);

  assert.equal(reading[0]?.hero.slug, "prize", "the hero whose answers they removed leads");
  assert.equal(reading[0]?.answersGone, 2);
  assert.deepEqual(
    reading[0]?.evidence.map((e) => e.slug),
    ["answer1", "answer2"],
    "and the panel names the bans it built the claim from",
  );
});

test("my own bans are not evidence about their plan", () => {
  const theirs = readIntent(data, board(bans(["answer1", "enemy"], ["answer2", "enemy"])), settings);
  const mine = readIntent(data, board(bans(["answer1", "mine"], ["answer2", "mine"])), settings);
  const loose = readIntent(data, board(bans(["answer1", null], ["answer2", null])), settings);

  assert.ok(theirs.length > 0);
  assert.equal(mine.length, 0, "the same two heroes are gone and it means nothing about them");
  assert.equal(loose.length, 0, "an unattributed ban is evidence about nobody");
});

test("one ban is a coincidence, not a plan", () => {
  assert.equal(readIntent(data, board(bans(["answer1", "enemy"])), settings).length, 0);
  assert.ok(MIN_ANSWERS_GONE === 2, "and the constant is what says so");
});

test("a blanket-strong hero's ban is not evidence for anybody", () => {
  // `bruiser` beats the whole pool by 4, so a naive reading would count this
  // ban towards every candidate at once.
  const reading = readIntent(
    data,
    board(bans(["bruiser", "enemy"], ["answer3", "enemy"])),
    settings,
  );
  assert.equal(
    reading.length,
    0,
    "one real answer plus one hero who beats everyone is still one real answer",
  );
});

test("a hero whose answers are many and mild is not what a ban list points at", () => {
  // Two of `common`'s eight mild answers, against two of `prize`'s three
  // decisive ones. Both clear a share of a road; only one of them clears a road
  // worth walking down.
  const both = readIntent(
    data,
    board(bans(["mild0", "enemy"], ["mild1", "enemy"], ["answer1", "enemy"], ["answer2", "enemy"])),
    settings,
  );

  assert.equal(both[0]?.hero.slug, "prize");
  const prize = both[0]!;
  const common = both.find((r) => r.hero.slug === "common");
  assert.ok(
    !common || prize.cleared > common.cleared * 3,
    "removing two mediocre answers is not the same act as removing two real ones",
  );

  // And on their own, the mild bans say nothing at all: a quarter of a road
  // nobody was blocking is not a plan.
  assert.equal(
    readIntent(data, board(bans(["mild0", "enemy"], ["mild1", "enemy"])), settings).length,
    0,
  );
});

test("the reading names the answer still on the board, and says when there is none", () => {
  const partial = readIntent(
    data,
    board(bans(["answer1", "enemy"], ["answer2", "enemy"])),
    settings,
  );
  assert.equal(partial[0]?.answerLeft?.slug, "answer3", "the hardest answer they have not removed");
  assert.equal(partial[0]?.answerLeft?.advantage, 5);

  const total = readIntent(
    data,
    board(bans(["answer1", "enemy"], ["answer2", "enemy"], ["answer3", "enemy"])),
    settings,
  );
  assert.equal(total[0]?.share, 1, "every answer gone");
  assert.equal(total[0]?.answerLeft, null, "and nothing left to suggest");
});

test("a hero already on the board is not a hero anyone is clearing the way for", () => {
  const banned = bans(["answer1", "enemy"], ["answer2", "enemy"]);
  assert.equal(readIntent(data, { mine: [], enemy: [], banned }, settings)[0]?.hero.slug, "prize");
  assert.equal(
    readIntent(data, { mine: [], enemy: [{ slug: "prize" }], banned }, settings).length,
    0,
    "they already took them — that is history, not a prediction",
  );
  assert.equal(
    readIntent(data, { mine: [{ slug: "prize" }], enemy: [], banned }, settings).length,
    0,
    "and I took them, so their plan is already dead",
  );
});

test("cleared points are in the same units as a matchup edge, and the share is a fraction of them", () => {
  const two = readIntent(data, board(bans(["answer1", "enemy"], ["answer2", "enemy"])), settings)[0]!;
  const all = readIntent(
    data,
    board(bans(["answer1", "enemy"], ["answer2", "enemy"], ["answer3", "enemy"])),
    settings,
  )[0]!;

  // The 7 and the 6, less what those two heroes are generally ahead by — so
  // under 13 and well over the 5 the remaining answer is worth.
  assert.ok(two.cleared > 8 && two.cleared < 13, `cleared was ${two.cleared}`);
  assert.equal(
    two.cleared,
    two.evidence.reduce((sum, e) => sum + e.specific, 0),
    "the headline is exactly the evidence it lists, added up",
  );
  // `all` removes the same two plus the third, so its cleared figure is the
  // whole mass — which is what the two-ban share is measured against.
  assert.ok(Math.abs(two.share - two.cleared / all.cleared) < 1e-9);
  assert.ok(two.share > 0.25 && two.share < 1);
});

test("intentScores and readIntent cannot disagree about who is being cleared for", () => {
  const draft = board(bans(["answer1", "enemy"], ["answer2", "enemy"]));
  const named = readIntent(data, draft, settings, Number.POSITIVE_INFINITY);
  const scored = intentScores(data, draft, settings);

  assert.equal(scored.size, named.length);
  for (const r of named) assert.equal(scored.get(r.hero.slug), r.cleared);
  assert.equal(
    scored.get("bystander"),
    undefined,
    "a hero the panel declines to name earns no ban points either",
  );
});

test("the ban list moves the cleared-for hero up, and zero weight restores the old order", () => {
  const draft = board(bans(["answer1", "enemy"], ["answer2", "enemy"]));
  const intent = intentScores(data, draft, settings);

  const blind = suggestBans(data, draft, settings, null, 12);
  const reading = suggestBans(data, draft, settings, null, 12, intent);
  const place = (list: typeof blind) => list.findIndex((s) => s.hero.slug === "prize");

  assert.ok(place(reading) < place(blind), "knowing their plan moves the hero they want up the list");

  const off = suggestBans(data, draft, { ...settings, intentWeight: 0 }, null, 12, intent);
  assert.deepEqual(
    off.map((s) => s.hero.slug),
    blind.map((s) => s.hero.slug),
    "and turning the weight off reproduces the previous ranking exactly",
  );
});

test("the intent term is confined to ban mode and to heroes with a reading", () => {
  const draft = board(bans(["answer1", "enemy"], ["answer2", "enemy"]));
  const intent = intentScores(data, draft, settings);

  const banned = suggestBans(data, draft, settings, null, 20, intent);
  assert.ok((banned.find((s) => s.hero.slug === "prize")?.intentScore ?? 0) > 0);
  assert.equal(banned.find((s) => s.hero.slug === "bystander")?.intentScore, 0);

  // Picking asks what a hero is worth in my five; their plan has no bearing.
  const picked = suggestPicks(data, draft, settings, null, 20);
  for (const s of picked) assert.equal(s.intentScore, 0);
});

test("ANSWER_POOL is what the share is measured against", () => {
  // Eight mild answers exist for `common`; removing all of them is the whole
  // road, and the pool constant is the reason that is exactly 100%.
  const all = Array.from({ length: ANSWER_POOL }, (_, i) => [`mild${i}`, "enemy"] as const);
  const reading = readIntent(data, board(bans(...all)), settings);
  const common = reading.find((r) => r.hero.slug === "common");
  assert.equal(common?.answersGone, ANSWER_POOL);
  assert.equal(common?.share, 1);
});

test("the share is measured over the answers a hero actually has", () => {
  const reading = readIntent(data, board(bans(["answer1", "enemy"], ["answer2", "enemy"])), settings);
  assert.equal(reading[0]?.hero.slug, "prize");
  assert.equal(reading[0]?.answerPool, 3, "prize has three answers, fewer than ANSWER_POOL");
});

test("a quiet reading names its closest miss when one ban lands on a hero's answers", () => {
  // `bruiser` answers nobody in particular, so only `answer1` counts.
  const misses = readNearMisses(data, board(bans(["answer1", "enemy"], ["bruiser", "enemy"])), settings);

  assert.equal(misses[0]?.hero.slug, "prize");
  assert.equal(misses[0]?.answersGone, 1, "short on the count");
  assert.deepEqual(misses[0]?.evidence.map((e) => e.slug), ["answer1"]);
});

test("a quiet reading names its closest miss when two bans land on a hero's minor answers", () => {
  const draft = board(bans(["mild0", "enemy"], ["mild1", "enemy"]));
  assert.equal(readIntent(data, draft, settings).length, 0);

  const misses = readNearMisses(data, draft, settings);
  assert.equal(misses[0]?.hero.slug, "common");
  assert.equal(misses[0]?.answersGone, 2, "the count clears");
  assert.equal(misses[0]?.answerPool, ANSWER_POOL);
  assert.ok(misses[0]!.share < MIN_CLEARED_SHARE, "and the share does not");
});

test("near misses stay silent beside a real reading, below two of their bans, and on taken heroes", () => {
  // `common` lost `mild0` on this board, which on a quiet one would make it the
  // closest miss.
  const reading = board(bans(["answer1", "enemy"], ["answer2", "enemy"], ["mild0", "enemy"]));
  assert.ok(readIntent(data, reading, settings).length > 0);
  assert.deepEqual(readNearMisses(data, reading, settings), []);

  assert.deepEqual(readNearMisses(data, board(bans(["answer1", "enemy"])), settings), []);
  assert.deepEqual(
    readNearMisses(data, board(bans(["answer1", "mine"], ["answer2", "mine"])), settings),
    [],
  );

  const banned = bans(["answer1", "enemy"], ["bruiser", "enemy"]);
  assert.deepEqual(readNearMisses(data, { mine: [], enemy: [{ slug: "prize" }], banned }, settings), []);
});

test("a near miss earns no ban points", () => {
  const draft = board(bans(["answer1", "enemy"], ["bruiser", "enemy"]));
  assert.ok(readNearMisses(data, draft, settings).length > 0);
  assert.equal(intentScores(data, draft, settings).size, 0);
});
