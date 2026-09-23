import test from "node:test";
import assert from "node:assert/strict";
import {
  NOISE,
  analyseDraft,
  pickImpact,
  talkingPoints,
  toMarkdown,
  verdictFor,
} from "./analysis.ts";
import type { LaneModel } from "./lanes.ts";
import type { Calibration } from "./winModel.ts";
import { DEFAULT_SETTINGS } from "./scoring.ts";
import { deriveTimingShape } from "./timing.ts";
import type {
  Dataset,
  DraftPick,
  Hero,
  HeroTiming,
  Lane,
  LaneStats,
  MatchupTable,
  Position,
  SynergyTable,
  TimingBucket,
} from "../types.ts";

// Run with: node --test --experimental-strip-types src/lib/*.test.ts

const BUCKETS: TimingBucket[] = [
  { key: "early", label: "Before 25′", short: "<25", maxSeconds: 1500 },
  { key: "mid", label: "25–35′", short: "25–35", maxSeconds: 2100 },
  { key: "late", label: "35–45′", short: "35–45", maxSeconds: 2700 },
  { key: "veryLate", label: "45′ and up", short: "45+", maxSeconds: null },
];

/** Four buckets of timing data from four skews, with a believable sample. */
const timings = (...skews: number[]): HeroTiming[] =>
  skews.map((skew) => ({ games: 5_000, winRate: 50 + skew, skew }));

const lane = (winRate: number): LaneStats => ({
  presence: 80,
  winRate,
  kda: 3,
  gpm: 400,
  xpm: 500,
});

interface HeroSpec {
  positions?: Partial<Record<Position, number>>;
  lanes?: Partial<Record<Lane, LaneStats>>;
  timings?: HeroTiming[];
}

const hero = (slug: string, spec: HeroSpec = {}): Hero => ({
  slug,
  name: slug.toUpperCase(),
  attr: "uni",
  steam: slug,
  winRate: 50,
  ...spec,
});

const pick = (slug: string, position: Position | null = null): DraftPick => ({ slug, position });

/**
 * A full 5v5 with every position booked, so the lane split is exercised for
 * real rather than through the "positions missing" fallback.
 *
 *   mine   ally 1 · midlaner 2 · counter 3 · support4 4 · warden 5
 *   enemy  villain 1 · midking 2 · bruiser 3 · roamer 4 · harass 5
 *
 * My safe lane (1 + 5) faces their offlane pair (3 + 4) and loses it; my mid
 * wins comfortably; my own offlane pair (3 + 4) beats their safe lane. That
 * spread is the point — it nets out near zero, which is exactly the draft the
 * single headline number describes uselessly.
 */
function makeDataset(): Dataset {
  const heroes = [
    // 10% of ALLY's games are at pos 1 — an off-role note should fire — and
    // their safe-lane record is poor before any opponent is considered.
    hero("ally", { positions: { 1: 0.1, 5: 0.9 }, lanes: { safe: lane(47.5) }, timings: timings(2, 1, -1, -3) }),
    hero("midlaner", { positions: { 2: 1 }, lanes: { mid: lane(52) }, timings: timings(3, 1, -1, -2) }),
    hero("counter", { positions: { 3: 0.9 }, timings: timings(1, 0, 0, -1) }),
    hero("support4", { positions: { 4: 0.9 }, timings: timings(1, 0, 0, -1) }),
    hero("warden", { positions: { 5: 0.9 }, timings: timings(0, 0, 0, 0) }),

    hero("villain", { positions: { 1: 0.95 }, timings: timings(-3, -1, 1, 4) }),
    hero("midking", { positions: { 2: 1 }, timings: timings(-2, 0, 1, 2) }),
    hero("bruiser", { positions: { 3: 0.9 }, timings: timings(-1, 0, 1, 2) }),
    hero("roamer", { positions: { 4: 0.9 }, timings: timings(-1, 0, 0, 1) }),
    hero("harass", { positions: { 5: 0.9 }, timings: timings(-1, 0, 0, 1) }),
  ];

  const big = (disadvantage: number) => ({ disadvantage, winRate: 50 - disadvantage, matches: 20_000 });

  const matchups: MatchupTable = {
    // Safe lane: −4, −2 and +2 across the three pairings with data.
    ally: { bruiser: big(4), roamer: big(2), villain: big(6) },
    warden: {
      bruiser: big(-2),
      // Under the 500-match floor, so it must be left out rather than counted.
      roamer: { disadvantage: -30, winRate: 80, matches: 40 },
    },
    // Mid.
    midlaner: { midking: big(-6) },
    // My offlane pair against their safe lane.
    counter: { villain: big(-8) },
    support4: { villain: big(-4), harass: big(1) },
  };

  const synergies: SynergyTable = {
    ally: { warden: { synergy: 3, matches: 4_000, winRate: 53 } },
    warden: { ally: { synergy: 3, matches: 4_000, winRate: 53 } },
    villain: { harass: { synergy: 1, matches: 4_000, winRate: 51 } },
    harass: { villain: { synergy: 1, matches: 4_000, winRate: 51 } },
  };

  return {
    heroes,
    bySlug: new Map(heroes.map((h) => [h.slug, h])),
    matchups,
    synergies,
    generatedAt: null,
    hasData: true,
    hasPositions: true,
    hasSynergies: true,
    synergyMatches: 100_000,
    hasTimings: true,
    timingBuckets: BUCKETS,
    timingShape: deriveTimingShape(heroes, BUCKETS.length),
    timingMatches: 300_000,
    error: null,
  };
}

const data = makeDataset();
const settings = DEFAULT_SETTINGS;

const fullDraft = {
  mine: [pick("ally", 1), pick("midlaner", 2), pick("counter", 3), pick("support4", 4), pick("warden", 5)],
  enemy: [pick("villain", 1), pick("midking", 2), pick("bruiser", 3), pick("roamer", 4), pick("harass", 5)],
  banned: [],
};

const near = (actual: number, expected: number, what: string) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${what}: expected ${expected}, got ${actual}`);

// --------------------------------------------------------------------- lanes

test("pairings land on the lane the two heroes would actually stand in", () => {
  const a = analyseDraft(data, fullDraft, settings)!;
  const byKey = Object.fromEntries(a.lanes.map((l) => [l.key, l]));

  assert.deepEqual(
    byKey.safe!.mine.map((s) => s.slug).sort(),
    ["ally", "warden"],
    "my 1 and 5 hold the safe lane",
  );
  assert.deepEqual(
    byKey.safe!.theirs.map((s) => s.slug).sort(),
    ["bruiser", "roamer"],
    "and face their offlane pair",
  );
  assert.deepEqual(byKey.mid!.mine.map((s) => s.slug), ["midlaner"]);
  assert.deepEqual(
    byKey.off!.theirs.map((s) => s.slug).sort(),
    ["harass", "villain"],
    "my offlane pair faces their whole safe lane",
  );

  // ally vs villain is carry against carry: never a lane, so it sits apart.
  assert.ok(
    byKey.map!.pairs.some((p) => p.mine.slug === "ally" && p.theirs.slug === "villain"),
    "two carries meet across the map, not in a lane",
  );
});

test("a lane's number is the mean of the pairings it actually has data for", () => {
  const a = analyseDraft(data, fullDraft, settings)!;
  const byKey = Object.fromEntries(a.lanes.map((l) => [l.key, l]));

  // −4 (ally/bruiser), −2 (ally/roamer), +2 (warden/bruiser). The fourth
  // pairing is below the match floor and must not be counted as a zero.
  near(byKey.safe!.advantage, -4 / 3, "safe lane");
  assert.equal(byKey.safe!.covered, 3);
  assert.equal(byKey.safe!.possible, 4, "four pairings on the board, three usable");

  near(byKey.mid!.advantage, 6, "mid");
  near(byKey.off!.advantage, (8 + 4 - 1) / 3, "off lane");
  assert.equal(byKey.off!.contested, true);
});

test("a lane explains itself, worst reason first", () => {
  const a = analyseDraft(data, fullDraft, settings)!;
  const safe = a.lanes.find((l) => l.key === "safe")!;
  const kinds = safe.notes.map((n) => n.kind);

  assert.ok(kinds.includes("pair"), "the losing pairing is named");
  assert.ok(kinds.includes("off-role"), "so is the hero standing somewhere they never stand");

  assert.match(safe.notes.find((n) => n.kind === "pair")!.text, /BRUISER beats ALLY by 4\.0/);
  assert.match(safe.notes.find((n) => n.kind === "off-role")!.text, /ALLY is off-role at 1 — only 10%/);

  const values = safe.notes.map((n) => n.value ?? 0);
  assert.deepEqual([...values].sort((x, y) => x - y), values, "bad news is listed first");
});

test("a lane with nothing lane-measured says so rather than printing a lane verdict", () => {
  // One hero a side, and their mid has no lane row: no form edge, no duo. The
  // score is then the whole-game head-to-head under the lane's name, and a
  // reader has no way to tell that from a real lane reading.
  const mid = analyseDraft(data, fullDraft, settings)!.lanes.find((l) => l.key === "mid")!;

  assert.equal(mid.measured, false);
  near(mid.score, mid.advantage, "the score is the matchup mean under another name");

  const note = mid.notes.find((n) => n.kind === "unmeasured");
  assert.ok(note, "and the card admits it");
  assert.match(note!.text, /Nothing here was measured in a lane/);
  assert.match(
    note!.text,
    /Their side has no record from this lane at all/,
    "including which side is missing, since only one of them is",
  );
});

test("an enemy standing somewhere they never stand is named too", () => {
  // Their pos 1 booked at mid — the Enigma-at-mid case in miniature. The lane
  // has a figure that prices this at exactly zero, so the note is the only
  // thing in the card that can say the enemy is out of position.
  const board = {
    ...fullDraft,
    enemy: [
      pick("midking", 1),
      pick("villain", 2),
      pick("bruiser", 3),
      pick("roamer", 4),
      pick("harass", 5),
    ],
  };
  const mid = analyseDraft(data, board, settings)!.lanes.find((l) => l.key === "mid")!;
  const offRole = mid.notes.filter((n) => n.kind === "off-role");

  assert.equal(offRole.length, 1, "only the hero actually standing in this lane");
  assert.match(offRole[0]!.text, /Their VILLAIN is off-role at 2 — 0% of their games/);
  assert.match(offRole[0]!.text, /no figure in this card prices/);
});

test("an off-role note is still only ever about the heroes in that lane", () => {
  const board = {
    ...fullDraft,
    enemy: [
      pick("midking", 1),
      pick("villain", 2),
      pick("bruiser", 3),
      pick("roamer", 4),
      pick("harass", 5),
    ],
  };
  const a = analyseDraft(data, board, settings)!;
  // MIDKING is off-role at 1, and pos 1 is contested by my offlane front — so
  // the note belongs there and nowhere else.
  const off = a.lanes.find((l) => l.key === "off")!;
  assert.ok(
    off.notes.some((n) => n.kind === "off-role" && /Their MIDKING is off-role at 1/.test(n.text)),
  );
  assert.equal(
    a.lanes.find((l) => l.key === "mid")!.notes.some((n) => /MIDKING/.test(n.text)),
    false,
  );
});

test("lane form reads the heroes' own record from the lane they stand in", () => {
  const a = analyseDraft(data, fullDraft, settings)!;
  const byKey = Object.fromEntries(a.lanes.map((l) => [l.key, l]));

  // ALLY: 47.5% from the safe lane at 80% presence, shrunk towards their own
  // 50% overall — 47.5·(80/92) + 50·(12/92) = 47.826. WARDEN has no lane row,
  // so the side average is ALLY alone and says so.
  const safe = byKey.safe!.myForm!;
  assert.ok(Math.abs(safe.value - (47.5 * (80 / 92) + 50 * (12 / 92) - 50)) < 1e-9);
  assert.equal(safe.covered, 1);
  assert.equal(safe.possible, 2, "the other hero has no lane data");
  assert.equal(safe.worst, null, "one hero is not a weak half");

  assert.equal(byKey.safe!.theirForm, null, "nothing scraped for their side");
  assert.ok(byKey.mid!.myForm!.value > 0, "MIDLANER wins 52% from mid");
});

test("a rarely played lane is pulled back towards the hero's overall record", () => {
  // Same 44% lane win rate, but one hero lives there and the other visits.
  const heroes = [
    hero("resident", { positions: { 1: 1 }, lanes: { safe: lane(44) } }),
    hero("tourist", { positions: { 1: 1 }, lanes: { safe: { ...lane(44), presence: 3 } } }),
    hero("target", { positions: { 3: 1 } }),
  ];
  const world: Dataset = {
    ...data,
    heroes,
    bySlug: new Map(heroes.map((h) => [h.slug, h])),
    // Something for `draftBalance` to chew on, so the analysis exists at all.
    matchups: {
      resident: { target: { disadvantage: 0, winRate: 50, matches: 20_000 } },
      tourist: { target: { disadvantage: 0, winRate: 50, matches: 20_000 } },
    },
  };
  const formFor = (slug: string) =>
    analyseDraft(world, { mine: [pick(slug, 1)], enemy: [pick("target", 3)], banned: [] }, settings)
      ?.lanes.find((l) => l.key === "safe")!.myForm!.value;

  assert.ok(formFor("resident")! < -5, "80% presence keeps most of a 44% lane record");
  assert.ok(formFor("tourist")! > -2, "3% presence keeps almost none of it");
});

test("a lane carries the chemistry of the two heroes standing in it", () => {
  const a = analyseDraft(data, fullDraft, settings)!;
  const byKey = Object.fromEntries(a.lanes.map((l) => [l.key, l]));

  // The cohesion list ranks a team's pairings by value; this is the pair that
  // actually shares the lane, whatever it is worth.
  assert.deepEqual(
    [byKey.safe!.myDuo?.a.slug, byKey.safe!.myDuo?.b.slug].sort(),
    ["ally", "warden"],
    "my 1 and 5 are a duo",
  );
  assert.equal(byKey.safe!.myDuo?.synergy, 3);
  assert.equal(byKey.safe!.theirDuo, null, "their 3 and 4 have no recorded pairing");

  assert.deepEqual(
    [byKey.off!.theirDuo?.a.slug, byKey.off!.theirDuo?.b.slug].sort(),
    ["harass", "villain"],
    "and their safe lane is a duo of theirs",
  );
  assert.equal(byKey.mid!.myDuo, null, "one hero a side is not a duo");
});

test("an uncontested lane is reported as such rather than as even", () => {
  const a = analyseDraft(data, { ...fullDraft, enemy: [pick("villain", 1)] }, settings)!;
  const mid = a.lanes.find((l) => l.key === "mid")!;
  assert.equal(mid.contested, false, "nobody is booked opposite my mid");
  assert.equal(mid.covered, 0);
  assert.equal(mid.advantage, 0);
});

// ----------------------------------------------------------------- our five

test("each of my heroes is scored against their five and beside my own", () => {
  const a = analyseDraft(data, fullDraft, settings)!;
  const byName = Object.fromEntries(a.heroes.map((h) => [h.hero.slug, h]));

  // counter meets villain in the lane (weight 2) and nobody else.
  near(byName.counter!.matchup, 8, "counter's only matchup is its lane");
  assert.equal(byName.counter!.covered, 1);

  // ally: −6 across the map, −4 and −2 in the lane at double weight.
  near(byName.ally!.matchup, (-6 - 8 - 4) / 5, "ally, lane pairings weighted double");
  near(byName.ally!.synergy, 3, "one recorded pairing, with warden");

  assert.equal(a.heroes[0]?.hero.slug, "counter", "best contributor leads");
  assert.equal(a.heroes.at(-1)?.hero.slug, "ally", "and the hardest game is last");
  assert.equal(byName.ally!.worst?.theirs.slug, "villain");
});

test("threats and edges are the sharpest pairings, from my side", () => {
  const a = analyseDraft(data, fullDraft, settings)!;

  assert.equal(a.threats[0]?.theirs.slug, "villain");
  assert.equal(a.threats[0]?.mine.slug, "ally");
  near(a.threats[0]!.advantage, -6, "worst pairing first");
  assert.ok(a.threats.every((p) => p.advantage < 0), "threats are only what I am losing");

  assert.equal(a.edges[0]?.mine.slug, "counter");
  near(a.edges[0]!.advantage, 8, "best pairing first");
  assert.ok(a.edges.every((p) => p.advantage > 0));
});

// ---------------------------------------------------------------- game stage

test("the stage read compares the two curves window by window", () => {
  const a = analyseDraft(data, fullDraft, settings)!;
  const stages = a.stages!;
  assert.equal(stages.buckets.length, 4);

  const early = stages.buckets[0]!;
  near(early.mine, (2 + 3 + 1 + 1 + 0) / 5, "my early skew");
  near(early.theirs, (-3 - 2 - 1 - 1 - 1) / 5, "their early skew");
  near(early.edge, early.mine - early.theirs, "the edge is just the difference");

  assert.equal(stages.best?.key, "early", "we are an early-game draft");
  assert.equal(stages.worst?.key, "veryLate", "and we lose the long game");
  assert.match(stages.summary, /before 25/i);
  assert.equal(stages.mostEarly?.name, "ALLY", "ally falls off hardest of my five");
});

test("no timing file means no stage read, not a fabricated one", () => {
  const bare: Dataset = { ...data, hasTimings: false, timingBuckets: [], timingShape: null };
  assert.equal(analyseDraft(bare, fullDraft, settings)!.stages, null);
});

test("a draft behind in every window is not told it owns one", () => {
  // Their hero is ahead in all four buckets; my best is merely least bad.
  // "Your window is X (−1.0 on them)" is the sentence this used to produce.
  const heroes = [
    hero("mine", { positions: { 1: 1 }, timings: timings(0, 0, 0, -2) }),
    hero("theirs", { positions: { 1: 1 }, timings: timings(1, 1, 1, 2) }),
  ];
  const lopsided: Dataset = {
    ...data,
    heroes,
    bySlug: new Map(heroes.map((h) => [h.slug, h])),
    matchups: { mine: { theirs: { disadvantage: 0, winRate: 50, matches: 20_000 } } },
    synergies: {},
    timingShape: deriveTimingShape(heroes, BUCKETS.length),
  };
  const draft = { mine: [pick("mine", 1)], enemy: [pick("theirs", 1)], banned: [] };

  const stages = analyseDraft(lopsided, draft, settings)!.stages!;
  assert.ok(stages.buckets.every((b) => b.edge <= -1), "every window is theirs");
  assert.match(stages.summary, /no part of the game is truly yours/i);
  assert.doesNotMatch(stages.summary, /your window is/i);

  // Read from the other side, the same board owns every window and nothing
  // may be conceded to an opponent who clears the floor nowhere.
  const flipped = { mine: draft.enemy, enemy: draft.mine, banned: [] };
  const theirs = analyseDraft(lopsided, flipped, settings)!.stages!;
  assert.match(theirs.summary, /your window is/i);
  assert.match(theirs.summary, /no part of the game is clearly theirs/i);
});

// --------------------------------------------------------------- the export

test("the markdown export carries the same numbers the panel shows", () => {
  const a = analyseDraft(data, fullDraft, settings)!;
  const md = toMarkdown(a);

  // The headline, verbatim — an export that rounds differently from the screen
  // is a second implementation waiting to disagree.
  assert.match(md, new RegExp(`Draft \\${a.advantage >= 0 ? "+" : "−"}`));
  assert.ok(md.includes(a.verdict.label.toLowerCase()), "the verdict is stated");
  assert.ok(md.includes("matchups"), "and both halves of it");
  assert.ok(md.includes("cohesion"));

  for (const line of talkingPoints(a)) {
    assert.ok(md.includes(line), `talking point survived the export: ${line}`);
  }

  // Coverage has to travel with the numbers: the reader of a paste cannot ask
  // how many pairings were behind them.
  assert.match(md, /\d+\/\d+ matchups and \d+\/\d+ pairings/);
});

test("the export degrades with the board rather than inventing sections", () => {
  const partial = { mine: [pick("counter", 3)], enemy: [pick("villain", 1)], banned: [] };
  const md = toMarkdown(analyseDraft(data, partial, settings)!);

  assert.match(md, /draft in progress \(1v1\)/, "an unfinished draft says so");
  assert.ok(!md.includes("**Watch out for**"), "no threats section without threats");
  assert.ok(md.includes("Off lane"), "but the lane that does read is included");
});

// ------------------------------------------------------------ what-if picks

/** A board with a readable "before": our mid out-matches theirs by 6. */
const midOnly = {
  mine: [pick("midlaner", 2)],
  enemy: [pick("villain", 1), pick("midking", 2)],
  banned: [] as string[],
};

test("the pick preview runs the real read, so it agrees with the panel", () => {
  const impact = pickImpact(data, midOnly, settings, "counter", 3)!;
  assert.ok(impact);

  // The preview must be the same arithmetic the panel would show afterwards,
  // not an approximation of it — a preview that disagrees with the number it
  // previews is worse than none.
  const before = analyseDraft(data, midOnly, settings)!;
  const after = analyseDraft(
    data,
    { ...midOnly, mine: [...midOnly.mine, pick("counter", 3)] },
    settings,
  )!;
  near(impact.before!, before.advantage, "before matches the live panel");
  near(impact.after, after.advantage, "after matches the panel it becomes");

  // counter beats villain by 8, so taking them has to move the board our way.
  assert.ok(impact.after > impact.before!, "a hard counter improves the draft");
});

test("the preview names the front the pick actually moves", () => {
  // counter is our pos 3, so it stands against their pos 1 — the off lane.
  const impact = pickImpact(data, midOnly, settings, "counter", 3)!;
  assert.equal(impact.lane?.label, "Off lane");
  assert.ok(impact.lane!.delta > NOISE, "and the move clears the noise floor");
  near(impact.lane!.after, 8, "the front reads the pairing it just gained");

  // A hero with no pairing against either of their two moves nothing, and must
  // not be credited with a front it never touched.
  assert.equal(pickImpact(data, midOnly, settings, "warden", 5)!.lane, null);
});

test("the preview reads the enemy's seat for bans, and refuses a repeat", () => {
  // Our safe carry is on the board and their pos 1 slot is open.
  const board = {
    mine: [pick("ally", 1), pick("midlaner", 2)],
    enemy: [pick("midking", 2)],
    banned: [] as string[],
  };

  // villain beats our ally by 6, so the enemy taking them costs us.
  const theirs = pickImpact(data, board, settings, "villain", 1, "enemy")!;
  assert.ok(theirs.before !== null, "the board already reads");
  assert.ok(theirs.after < theirs.before!, "an enemy counter-pick costs us");

  // Asking about a hero already on that side has no answer to give.
  assert.equal(pickImpact(data, board, settings, "ally", 1, "mine"), null);
  // …but the same hero on the *other* side is a real question.
  assert.ok(pickImpact(data, board, settings, "ally", 1, "enemy"));
});

test("the first hero on an empty board has no before to compare against", () => {
  const empty = { mine: [] as ReturnType<typeof pick>[], enemy: [pick("villain", 1)], banned: [] };
  const impact = pickImpact(data, empty, settings, "counter", 3)!;
  assert.equal(impact.before, null, "nothing was on the board to read");
  assert.ok(Number.isFinite(impact.after));
  assert.equal(impact.lane, null, "and no lane can have moved");
});

// ------------------------------------------------------- verdict & coverage

test("verdicts stay quiet inside the noise and get louder outside it", () => {
  assert.equal(verdictFor(0.2).side, "even");
  assert.equal(verdictFor(0.2).label, "Coin flip");
  assert.equal(verdictFor(-0.4).side, "even", "half a point either way is nothing");

  assert.equal(verdictFor(1).side, "mine");
  assert.equal(verdictFor(-1).side, "enemy");
  assert.ok(verdictFor(6).strength > verdictFor(2).strength);
  assert.equal(verdictFor(-6).strength, 4);
});

test("coverage counts what was usable, not what was asked for", () => {
  const a = analyseDraft(data, fullDraft, settings)!;
  assert.equal(a.coverage.matchupsPossible, 25, "five against five");
  assert.equal(a.coverage.matchups, 8, "the rest were missing or below the sample floor");
  assert.equal(a.coverage.synergiesPossible, 20, "ten pairings a side");
  assert.equal(a.coverage.synergies, 2);
  assert.equal(a.complete, true);
  assert.equal(a.lanesResolved, true);
});

test("an incomplete draft still reports, and says that it is incomplete", () => {
  const partial = { mine: [pick("counter", 3)], enemy: [pick("villain", 1)], banned: [] };
  const a = analyseDraft(data, partial, settings)!;
  assert.equal(a.complete, false);
  near(a.counter, 8, "one pairing, and it is the whole head-to-head half");
  // The headline is no longer only that pairing: one hero in five moves the
  // projected early-game cover a little, and the timing term reads it. What it
  // must not do on a two-hero board is move the headline *noticeably* — the
  // four empty slots are valued at the pool average precisely so that an
  // unfinished draft is not charged for a hole nobody has dug yet.
  assert.ok(
    Math.abs(a.advantage - 8) < 0.05,
    `two heroes must not swing the headline: got ${a.advantage}`,
  );
  assert.equal(a.heroes.length, 1);

  assert.equal(analyseDraft(data, { mine: [], enemy: [], banned: [] }, settings), null);
  assert.equal(analyseDraft(data, { mine: [pick("ally", 1)], enemy: [], banned: [] }, settings), null);
});

test("positions left unset are reported rather than guessed into a lane", () => {
  const loose = {
    mine: [pick("ally"), pick("counter", 3)],
    enemy: [pick("villain", 1)],
    banned: [],
  };
  const a = analyseDraft(data, loose, settings)!;
  assert.equal(a.lanesResolved, false);
  assert.ok(
    a.lanes.find((l) => l.key === "map")!.pairs.some((p) => p.mine.slug === "ally"),
    "an unplaced hero contests nothing in particular",
  );
});

// ------------------------------------------------------------ talking points

test("talking points name the weak lane, the window and the threat", () => {
  const points = talkingPoints(analyseDraft(data, fullDraft, settings)!);
  assert.ok(points.length >= 3 && points.length <= 5);

  const joined = points.join(" | ");
  assert.match(joined, /Safe lane is our weak side \(−1\.3\)/);
  assert.match(joined, /BRUISER beats ALLY/, "the weak lane comes with its reason");
  assert.match(joined, /Mid is ours/);
  assert.match(joined, /before 25/i, "when we are supposed to win");
});

test("a level draft is not talked up into having a plan", () => {
  const flat = {
    mine: [pick("warden", 5)],
    enemy: [pick("bruiser", 3)],
    banned: [],
  };
  const a = analyseDraft(data, flat, settings)!;
  // +2 in one lane pairing and nothing else known: no weak lane, no weak link.
  assert.ok(!talkingPoints(a).some((line) => /weak side/.test(line)));
});

// ---------------------------------------------- honesty of the read-out
//
// Every test below fixes a place where the panel said more than the data
// supported. They are grouped because they share a cause rather than a
// mechanism: each number was correct, and each was presented as something it
// was not.

test("there is no expected win rate, because the model cannot produce one", () => {
  const a = analyseDraft(data, fullDraft, settings)!;
  assert.equal(
    "winProbability" in a,
    false,
    "`50 + advantage` is a mean of marginal effects, not a probability",
  );
});

test("a hero whose worst pairing is inside the noise has no problem hero", () => {
  // FLAT is level against one opponent and a shade behind another. Nothing here
  // is worth naming, but something always sorts last.
  const heroes = [hero("flat", { positions: { 3: 1 } }), hero("a", { positions: { 1: 1 } }), hero("b", { positions: { 5: 1 } })];
  const world: Dataset = {
    ...data,
    heroes,
    bySlug: new Map(heroes.map((h) => [h.slug, h])),
    matchups: {
      flat: {
        a: { disadvantage: 0.1, winRate: 50, matches: 20_000 },
        b: { disadvantage: -0.2, winRate: 50, matches: 20_000 },
      },
    },
    synergies: {},
  };
  const a = analyseDraft(
    world,
    { mine: [pick("flat", 3)], enemy: [pick("a", 1), pick("b", 5)], banned: [] },
    settings,
  )!;

  const report = a.heroes[0]!;
  assert.equal(report.covered, 2, "both pairings were usable");
  assert.equal(report.worst, null, "−0.1 is not a hero to fear");
  assert.equal(report.best, null, "and +0.2 is not an edge to plan around");
});

test("pairings that matter have to clear the same floor as the verdict", () => {
  // Two pairings inside the noise and one outside it on each side. The card is
  // headed "Pairings that matter", and the panel it sits in calls half a point
  // a coin flip — so ±0.2 cannot appear here at any position in the list.
  const heroes = [
    hero("mine1", { positions: { 1: 1 } }),
    hero("mine2", { positions: { 5: 1 } }),
    hero("them1", { positions: { 3: 1 } }),
    hero("them2", { positions: { 4: 1 } }),
  ];
  const at = (d: number) => ({ disadvantage: d, winRate: 50 - d, matches: 20_000 });
  const world: Dataset = {
    ...data,
    heroes,
    bySlug: new Map(heroes.map((h) => [h.slug, h])),
    matchups: {
      mine1: { them1: at(3), them2: at(0.2) },
      mine2: { them1: at(-0.2), them2: at(-3) },
    },
    synergies: {},
  };
  const a = analyseDraft(
    world,
    {
      mine: [pick("mine1", 1), pick("mine2", 5)],
      enemy: [pick("them1", 3), pick("them2", 4)],
      banned: [],
    },
    settings,
  )!;

  assert.equal(a.coverage.matchups, 4, "all four pairings were usable");
  assert.deepEqual(
    a.threats.map((p) => p.advantage),
    [-3],
    "the −0.2 is not a threat, it is a rounding artefact",
  );
  assert.deepEqual(a.edges.map((p) => p.advantage), [3], "and +0.2 is not an edge");
  assert.ok(
    a.lanes.flatMap((l) => l.notes).every((n) => n.value === null || Math.abs(n.value) >= NOISE),
    "no note is written about a number too small to mean anything either",
  );
});

test("the across-the-map bucket reports a real denominator", () => {
  const a = analyseDraft(data, fullDraft, settings)!;
  const map = a.lanes.find((l) => l.key === "map")!;

  // 25 pairings on the board, 9 of which meet in a lane (4 safe, 1 mid, 4 off).
  assert.equal(map.possible, 16, "everything that never meets in a lane");
  assert.ok(map.covered < map.possible, "and it is not covered by definition");

  const laneTotals = a.lanes.reduce((sum, l) => sum + l.possible, 0);
  assert.equal(laneTotals, a.coverage.matchupsPossible, "the fronts account for every pairing");
  assert.equal(
    a.lanes.reduce((sum, l) => sum + l.covered, 0),
    a.coverage.matchups,
    "and for every usable one",
  );
});

test("a lane whose matchups and lane record disagree says so, and says which to believe", () => {
  // The shape that started all this: three of four pairings are fine, one
  // support-versus-support number carries the average positive, and the two
  // heroes actually standing there are far worse from that lane than the two
  // opposite. The old panel printed "+1.5" in green and said nothing else.
  const heroes = [
    hero("sf", { positions: { 1: 1 }, lanes: { safe: lane(47) } }),
    hero("willow", { positions: { 5: 1 }, lanes: { safe: lane(47) } }),
    hero("brist", { positions: { 3: 1 }, lanes: { off: lane(52) } }),
    hero("frost", { positions: { 4: 1 }, lanes: { off: lane(52) } }),
  ];
  const even = (d: number) => ({ disadvantage: d, winRate: 50 - d, matches: 20_000 });
  const world: Dataset = {
    ...data,
    heroes,
    bySlug: new Map(heroes.map((h) => [h.slug, h])),
    matchups: {
      sf: { brist: even(0.2), frost: even(0.2) },
      willow: { brist: even(0.2), frost: even(-6) },
    },
    synergies: {},
  };
  const a = analyseDraft(
    world,
    { mine: [pick("sf", 1), pick("willow", 5)], enemy: [pick("brist", 3), pick("frost", 4)], banned: [] },
    settings,
  )!;
  const safe = a.lanes.find((l) => l.key === "safe")!;

  assert.ok(safe.advantage > NOISE, "the matchups average out in our favour");
  assert.ok(safe.formEdge! < -NOISE, "while the lane data has us well behind");

  const split = safe.notes.find((n) => n.kind === "split");
  assert.ok(split, "the disagreement is called out");
  // The lane record is a game figure, so the note says what it measured and
  // stops short of predicting the laning stage, which it does not track.
  assert.match(split!.text, /games played from this lane/);
  assert.match(split!.text, /weaker than the matchups say/);
  assert.doesNotMatch(split!.text, /first ten minutes/);
  assert.equal(split!.value, safe.formEdge, "coloured by the reading that was measured");

  // And it is the first thing a captain is told, ahead of any lane the
  // matchups happen to rank lower.
  assert.match(talkingPoints(a)[0]!, /reads .* on matchups but our heroes are/);
  assert.ok(
    !talkingPoints(a).some((l) => /Safe lane is ours/.test(l)),
    "a lane we are about to lose is never offered as one to play through",
  );
});

/**
 * A 2v2 safe lane with every input to the lane score dialled in by hand.
 *
 * The score blends three readings, and the only way to test the blend rather
 * than one draft's arithmetic is to move each reading on its own and check the
 * headline responds the way the weighting says it should. Nothing here is tuned
 * to a particular pair of heroes: `mine`/`theirs` are lane win rates, `edge` is
 * every cross pairing at once, and the synergies are the two duos.
 */
function laneWorld(opts: {
  /** Safe-lane win rates for my 1 and 5. A short array leaves a hero unscraped. */
  mine?: Array<number | null>;
  /** Offlane win rates for their 3 and 4. */
  theirs?: Array<number | null>;
  /** Points my way on every one of the four cross pairings. */
  edge?: number;
  mySyn?: number | null;
  theirSyn?: number | null;
}) {
  const { mine = [], theirs = [], edge = 0, mySyn = null, theirSyn = null } = opts;
  const safe = (wr: number | null | undefined) => (wr == null ? {} : { lanes: { safe: lane(wr) } });
  const off = (wr: number | null | undefined) => (wr == null ? {} : { lanes: { off: lane(wr) } });

  const heroes = [
    hero("one", { positions: { 1: 1 }, ...safe(mine[0]) }),
    hero("five", { positions: { 5: 1 }, ...safe(mine[1]) }),
    hero("three", { positions: { 3: 1 }, ...off(theirs[0]) }),
    hero("four", { positions: { 4: 1 }, ...off(theirs[1]) }),
  ];
  const cell = { disadvantage: -edge, winRate: 50 + edge, matches: 20_000 };
  const syn = (synergy: number) => ({ synergy, matches: 4_000, winRate: 50 + synergy });
  const synergies: SynergyTable = {};
  if (mySyn !== null) Object.assign(synergies, { one: { five: syn(mySyn) }, five: { one: syn(mySyn) } });
  if (theirSyn !== null) {
    Object.assign(synergies, { three: { four: syn(theirSyn) }, four: { three: syn(theirSyn) } });
  }

  const world: Dataset = {
    ...data,
    heroes,
    bySlug: new Map(heroes.map((h) => [h.slug, h])),
    matchups: { one: { three: cell, four: cell }, five: { three: cell, four: cell } },
    synergies,
  };
  const draft = {
    mine: [pick("one", 1), pick("five", 5)],
    enemy: [pick("three", 3), pick("four", 4)],
    banned: [],
  };
  const a = analyseDraft(world, draft, settings)!;
  return { world, draft, analysis: a, safe: a.lanes.find((l) => l.key === "safe")! };
}

test("with nothing measured in a lane, the score is the matchup mean and says so", () => {
  // The degenerate case has to be exact, not merely close: a scrape with no
  // lane rows and no synergy sample must leave the card reading precisely what
  // it read before the blend existed, or every number in it moved for nobody's
  // benefit.
  const { safe } = laneWorld({ edge: 3 });
  assert.equal(safe.formEdge, null, "no lane rows on either side");
  assert.equal(safe.duoEdge, null, "and no duo to compare");
  near(safe.score, safe.advantage, "so the score is the matchup mean untouched");
  assert.equal(safe.measured, false, "and the card is told not to claim otherwise");

  const map = analyseDraft(data, fullDraft, settings)!.lanes.find((l) => l.key === "map")!;
  near(map.score, map.advantage, "nobody stands across the map, so the same holds there");
  assert.equal(map.measured, false, "and it is never dressed up as a lane read");
});

test("the readings taken from a lane outweigh the whole-game matchups", () => {
  // The general shape of the bug: matchups that net out fine over whole games,
  // lane data that does not. Any hero pair, any patch — if the two disagree,
  // the headline follows the one measured in a lane.
  const { safe } = laneWorld({ mine: [47, 47], theirs: [52, 52], edge: 0.2 });

  assert.ok(safe.advantage > 0, "the matchups mildly favour us");
  assert.ok(safe.formEdge! < -NOISE, "the lane records clearly do not");
  assert.ok(safe.measured, "and the card knows a lane figure went in");
  assert.ok(safe.score < -NOISE, "so the headline calls the lane lost, not even");
  assert.ok(
    Math.abs(safe.score - safe.formEdge!) < Math.abs(safe.score - safe.advantage),
    "landing nearer the reading that was taken from a lane than the one that was not",
  );

  // It has to survive a matchup mean large enough to hide behind, too — this
  // is the case where three noisy pairings drown the one that matters.
  const loud = laneWorld({ mine: [47, 47], theirs: [52, 52], edge: 2 }).safe;
  assert.ok(loud.score < 0, "a two-point matchup mean does not buy back a lost lane");
});

test("a lane swap moves my heroes to another lane record and leaves theirs alone", () => {
  // A swap is something one team does. We walk our safe duo the other way;
  // they stand where they have always stood. Reading *their* heroes under the
  // swapped map priced the enemy carry on an offlane record for a lane he
  // never left — and in the direction that flatters the swap.
  //
  // Each side here carries exactly one lane row, so the assertion cannot be
  // satisfied by luck: my pair is scraped only in the off lane, theirs only in
  // the safe lane, and a side read against the wrong map has no figure at all.
  const heroes = [
    hero("mycarry", { positions: { 1: 1 }, lanes: { off: lane(55) } }),
    hero("mysup", { positions: { 5: 1 }, lanes: { off: lane(55) } }),
    hero("theircarry", { positions: { 1: 1 }, lanes: { safe: lane(44) } }),
    hero("theirsup", { positions: { 5: 1 }, lanes: { safe: lane(44) } }),
  ];
  const cell = { disadvantage: 0, winRate: 50, matches: 20_000 };
  const world: Dataset = {
    ...data,
    heroes,
    bySlug: new Map(heroes.map((h) => [h.slug, h])),
    matchups: {
      mycarry: { theircarry: cell, theirsup: cell },
      mysup: { theircarry: cell, theirsup: cell },
    },
    synergies: {},
  };
  const draft = {
    mine: [pick("mycarry", 1), pick("mysup", 5)],
    enemy: [pick("theircarry", 1), pick("theirsup", 5)],
    banned: [],
    lanePlan: "swapped" as const,
  };

  const safe = analyseDraft(world, draft, settings)!.lanes.find((l) => l.key === "safe")!;
  assert.deepEqual(
    safe.theirs.map((h) => h.slug),
    ["theircarry", "theirsup"],
    "the swap puts my safe duo against theirs",
  );
  assert.equal(safe.myForm!.covered, 2, "my pair is read against the lane they walked into");
  assert.ok(safe.myForm!.value > 0, "which is the only lane they are scraped in");
  assert.equal(safe.theirForm!.covered, 2, "their pair is read where they still are");
  assert.ok(safe.theirForm!.value < 0, "on the safe-lane record they never left");
  assert.ok(safe.formEdge! > NOISE, "so the edge follows the two records that were measured");

  // And the swap must not have quietly rewritten what a lane record means for
  // the side that did not move: under the standard plan those same heroes read
  // exactly the same, because standing still is standing still.
  const standing = analyseDraft(world, { ...draft, lanePlan: "standard" }, settings)!.lanes.find(
    (l) => l.key === "off",
  )!;
  near(standing.theirForm!.value, safe.theirForm!.value, "their lane record does not move with our feet");
});

test("a lane score is antisymmetric — the same draft from the other seat is its negative", () => {
  // Nothing in the blend may quietly favour the side asking. Mirroring the
  // board turns my safe lane into their offlane, so the two must be exact
  // opposites; a weighting that broke this would be reporting a house edge.
  const opts = { mine: [46, 51], theirs: [53, 48.5], edge: 1.4, mySyn: 2, theirSyn: -1 };
  const { world, draft, safe } = laneWorld(opts);
  const mirrored = analyseDraft(
    world,
    { mine: draft.enemy, enemy: draft.mine, banned: [] },
    settings,
  )!;
  const theirSide = mirrored.lanes.find((l) => l.key === "off")!;

  near(theirSide.score, -safe.score, "the same front read from the other side");
  near(theirSide.formEdge!, -safe.formEdge!, "and so is every input to it");
  near(theirSide.duoEdge!, -safe.duoEdge!, "including the duo");
});

test("the duo edge moves the lane, but never as far as the same edge measured in one", () => {
  // The ordering the weights encode: lane-measured first, 2v2 chemistry
  // second. Both are real; they are not equal, and a synergy point is not
  // allowed to speak as loudly as a point of lane win rate.
  const flat = laneWorld({ edge: 0 }).safe;
  const withDuo = laneWorld({ edge: 0, mySyn: 2, theirSyn: 0 }).safe;

  near(withDuo.duoEdge!, 2, "a two-point chemistry gap between the pairs");
  assert.ok(withDuo.score > flat.score, "which is worth something");
  assert.ok(
    withDuo.score < withDuo.duoEdge!,
    "but is diluted by the whole-game matchups it is blended with",
  );

  // Same nominal gap, measured in the lane instead: it must count for more.
  const asForm = laneWorld({ edge: 0, mine: [51, 51], theirs: [49, 49] }).safe;
  assert.ok(
    Math.abs(asForm.formEdge! - withDuo.duoEdge!) < 0.6,
    "a comparable gap, so the two are worth comparing",
  );
  assert.ok(asForm.score > withDuo.score, "and the lane-measured one moves the headline further");
});

test("a form edge built from half a side is trusted less than one built from all of it", () => {
  // Coverage is not confidence. "Both our heroes against both of theirs" and
  // "both of ours against one of theirs" are different claims, and the second
  // must not swing a lane as hard as the first.
  const full = laneWorld({ mine: [47, 47], theirs: [53, 53] }).safe;
  const half = laneWorld({ mine: [47, 47], theirs: [53] }).safe;

  near(half.formEdge!, full.formEdge!, "the same edge on the face of it");
  assert.equal(half.theirForm!.covered, 1, "but built from one of their two heroes");
  assert.equal(half.theirForm!.possible, 2);
  assert.ok(half.score > full.score, "so it is shrunk towards the rest of the read");
  assert.ok(half.score < -NOISE, "without being discarded — it is still the best lane data there is");
});

test("the lane a pick moves is judged by the lane read, not the matchup mean", () => {
  // `pickImpact` feeds the badge on a hero tile. It used to answer with the
  // matchup mean while the card it points at showed the blend, so a pick could
  // be advertised as fixing a lane the card still called lost.
  const { world } = laneWorld({ mine: [47, 47], theirs: [52, 52], edge: 0.2 });
  const impact = pickImpact(
    world,
    { mine: [pick("one", 1)], enemy: [pick("three", 3), pick("four", 4)], banned: [] },
    settings,
    "five",
    5,
    "mine",
  );
  if (impact?.lane) {
    const after = analyseDraft(
      world,
      { mine: [pick("one", 1), pick("five", 5)], enemy: [pick("three", 3), pick("four", 4)], banned: [] },
      settings,
    )!.lanes.find((l) => l.key === "safe")!;
    near(impact.lane.after, after.score, "the figure quoted is the one the card shows");
  }
});

test("form edge is null unless both sides were measured in the lane", () => {
  const a = analyseDraft(data, fullDraft, settings)!;
  const byKey = Object.fromEntries(a.lanes.map((l) => [l.key, l]));
  assert.equal(byKey.safe!.theirForm, null, "nothing scraped for their offlane pair");
  assert.equal(byKey.safe!.formEdge, null, "so there is no comparison to make");
  assert.equal(byKey.map!.formEdge, null, "and nobody stands across the map");
});

test("the latest and earliest hero are read from buckets that have games in them", () => {
  const blank = (skew: number): HeroTiming => ({ games: 0, winRate: 50, skew });
  const heroes = [
    // GHOST looks like a monstrous late-game hero and was never seen there.
    hero("ghost", { positions: { 1: 1 }, timings: [...timings(0, 0, 0), blank(9)] }),
    hero("real", { positions: { 5: 1 }, timings: timings(0, 0, 0, 2) }),
    hero("foe", { positions: { 3: 1 }, timings: timings(0, 0, 0, 0) }),
  ];
  const world: Dataset = {
    ...data,
    heroes,
    bySlug: new Map(heroes.map((h) => [h.slug, h])),
    matchups: { ghost: { foe: { disadvantage: 0, winRate: 50, matches: 20_000 } } },
    synergies: {},
    timingShape: deriveTimingShape(heroes, BUCKETS.length),
  };
  const stages = analyseDraft(
    world,
    { mine: [pick("ghost", 1), pick("real", 5)], enemy: [pick("foe", 3)], banned: [] },
    settings,
  )!.stages!;

  assert.equal(stages.mostLate?.name, "REAL", "an empty bucket is not a scaling curve");
  assert.equal(stages.buckets.at(-1)!.mine, 2, "and it is left out of the mean too");
});

test("the cohesion list is built from the same lookup as the headline it prints", () => {
  // A pairing worth +6 in general and −4 when both heroes farm. The headline
  // reads the cell; the card must read it too, or the card lists numbers that
  // do not average to the average above them.
  const heroes = [hero("one", { positions: { 1: 1 } }), hero("two", { positions: { 2: 1 } }), hero("foe", { positions: { 3: 1 } })];
  const row = {
    synergy: 6,
    matches: 9_000,
    winRate: 56,
    cells: { cc: { synergy: -4, matches: 4_000 } },
  };
  const world: Dataset = {
    ...data,
    heroes,
    bySlug: new Map(heroes.map((h) => [h.slug, h])),
    matchups: { one: { foe: { disadvantage: 0, winRate: 50, matches: 20_000 } } },
    synergies: { one: { two: row }, two: { one: row } },
  };
  const a = analyseDraft(
    world,
    { mine: [pick("one", 1), pick("two", 2)], enemy: [pick("foe", 3)], banned: [] },
    settings,
  )!;

  assert.equal(a.mySynergyPairs[0]?.synergy, -4, "two cores, so the core/core cell applies");
  assert.equal(a.mySynergy, -4, "and the headline agrees, because it asked the same question");
});

test("a position cell too thin to trust falls back to the pairing's own figure", () => {
  const heroes = [hero("one", { positions: { 1: 1 } }), hero("two", { positions: { 2: 1 } }), hero("foe", { positions: { 3: 1 } })];
  // Plenty of games overall, almost none with both heroes farming.
  const row = {
    synergy: 6,
    matches: 9_000,
    winRate: 56,
    cells: { cc: { synergy: -4, matches: 12 } },
  };
  const world: Dataset = {
    ...data,
    heroes,
    bySlug: new Map(heroes.map((h) => [h.slug, h])),
    matchups: { one: { foe: { disadvantage: 0, winRate: 50, matches: 20_000 } } },
    synergies: { one: { two: row }, two: { one: row } },
  };
  const a = analyseDraft(
    world,
    { mine: [pick("one", 1), pick("two", 2)], enemy: [pick("foe", 3)], banned: [] },
    settings,
  )!;

  assert.equal(a.mySynergyPairs.length, 1, "the pairing is not dropped for the cell's thinness");
  assert.equal(a.mySynergyPairs[0]?.synergy, 6, "it falls back to the blended figure");
  assert.equal(a.coverage.synergies, 1);
});

test("both sides' team size is reported, so every 'x of y' has a real y", () => {
  const a = analyseDraft(data, { ...fullDraft, enemy: fullDraft.enemy.slice(0, 2) }, settings)!;
  assert.deepEqual(a.sides, { mine: 5, enemy: 2 });
  assert.ok(a.heroes.every((h) => h.covered <= a.sides.enemy));
});

test("a lane sitting inside the noise still warns when the lane data does not", () => {
  // The case the first cut of this check missed. Nothing about `+0.1` looks
  // like a warning, which is precisely why it needs one: the headline is silent
  // rather than wrong, and silence is what gets read as "this lane is fine".
  const heroes = [
    hero("carry", { positions: { 1: 1 }, lanes: { safe: lane(47) } }),
    hero("sup", { positions: { 5: 1 }, lanes: { safe: lane(47) } }),
    hero("off", { positions: { 3: 1 }, lanes: { off: lane(52) } }),
    hero("rover", { positions: { 4: 1 }, lanes: { off: lane(52) } }),
  ];
  const at = (d: number) => ({ disadvantage: d, winRate: 50 - d, matches: 20_000 });
  const world: Dataset = {
    ...data,
    heroes,
    bySlug: new Map(heroes.map((h) => [h.slug, h])),
    // Three losing pairings and one support-versus-support number that carries
    // the mean back over zero — the shape from the game that prompted all this.
    matchups: {
      carry: { off: at(0.45), rover: at(0.24) },
      sup: { off: at(0.42), rover: at(-1.46) },
    },
    synergies: {},
  };
  const a = analyseDraft(
    world,
    { mine: [pick("carry", 1), pick("sup", 5)], enemy: [pick("off", 3), pick("rover", 4)], banned: [] },
    settings,
  )!;
  const safe = a.lanes.find((l) => l.key === "safe")!;

  assert.ok(Math.abs(safe.advantage) < NOISE, "the lane reads as even");
  assert.ok(safe.formEdge! <= -NOISE, "and the lane data does not agree");
  assert.ok(safe.notes.some((n) => n.kind === "split"), "silence is not an acceptable answer here");
  assert.match(talkingPoints(a)[0]!, /weaker than the matchups make it look/);
});

test("a lane the headline already calls bad is not warned about twice", () => {
  const heroes = [
    hero("carry", { positions: { 1: 1 }, lanes: { safe: lane(47) } }),
    hero("sup", { positions: { 5: 1 }, lanes: { safe: lane(47) } }),
    hero("off", { positions: { 3: 1 }, lanes: { off: lane(52) } }),
    hero("rover", { positions: { 4: 1 }, lanes: { off: lane(52) } }),
  ];
  const at = (d: number) => ({ disadvantage: d, winRate: 50 - d, matches: 20_000 });
  const world: Dataset = {
    ...data,
    heroes,
    bySlug: new Map(heroes.map((h) => [h.slug, h])),
    matchups: { carry: { off: at(4), rover: at(4) }, sup: { off: at(4), rover: at(4) } },
    synergies: {},
  };
  const a = analyseDraft(
    world,
    { mine: [pick("carry", 1), pick("sup", 5)], enemy: [pick("off", 3), pick("rover", 4)], banned: [] },
    settings,
  )!;
  const safe = a.lanes.find((l) => l.key === "safe")!;

  assert.ok(safe.advantage <= -NOISE, "the matchups already say we are losing it");
  assert.ok(safe.formEdge! <= -NOISE, "and so does the form");
  assert.equal(safe.notes.some((n) => n.kind === "split"), false, "they agree — no split to report");
  assert.match(talkingPoints(a)[0]!, /is our weak side/);
});

// ------------------------------------------------- game length, weighted

test("the stage card prices each window by how often games end in it", () => {
  const stages = analyseDraft(data, fullDraft, settings)!.stages!;
  assert.ok(stages.shares, "the card must know the duration distribution");
  near(
    stages.shares!.reduce((a, b) => a + b, 0),
    1,
    "shares are a distribution",
  );

  // The fixture gives every window the same number of games, so here — and
  // only here — the weighted figure and the flat mean must agree. A test world
  // with a flat distribution is the one case where the old reading was right,
  // and it is worth pinning: it proves the weighting is being applied rather
  // than a constant being added.
  const flat = stages.buckets.reduce((s, b) => s + b.edge, 0) / stages.buckets.length;
  near(stages.weightedEdge!, flat, "flat sample, flat weighting");
});

test("exposure says how much of the distribution has to be survived", () => {
  // My five are the early-game side in this fixture, so there is nothing to
  // wait for and nothing to survive.
  const stages = analyseDraft(data, fullDraft, settings)!.stages!;
  assert.equal(stages.exposure, 0, "ahead from the first window");
  assert.doesNotMatch(stages.summary, /games are over before you are ahead/i);

  // Flip the sides and the same board reads as the draft that has to hold on.
  const flipped = analyseDraft(
    data,
    { mine: fullDraft.enemy, enemy: fullDraft.mine, banned: [] },
    settings,
  )!.stages!;
  assert.ok(flipped.exposure! > 0, "the late-game side has to get there");
  assert.match(flipped.summary, /% of games are over before you are ahead/i);
});

test("cover counts bodies, and the penalty only bites when they are missing", () => {
  const a = analyseDraft(data, fullDraft, settings)!;
  const stages = a.stages!;
  assert.ok(stages.cover !== null && stages.theirCover !== null);
  assert.ok(
    stages.cover! > stages.theirCover!,
    "my early-game five must out-cover their late-game five",
  );
  assert.equal(stages.penalty, 0, "a side with early heroes is charged nothing");
  assert.ok(stages.theirPenalty > 0, "a side without them is");
  assert.ok(a.earlyEdge > 0, "and the difference lands in the headline, in my favour");
});

test("turning the weight off restores the old headline exactly", () => {
  const off = { ...settings, earlyWeight: 0 };
  const a = analyseDraft(data, fullDraft, off)!;
  assert.equal(a.earlyEdge, 0);
  near(a.advantage, a.counter + off.synergyWeight * a.synergyEdge, "no third term at all");
  assert.equal(a.stages!.penalty, 0);
  assert.equal(a.stages!.theirPenalty, 0);
});

test("without a timing file the whole early-game read is absent, not zero", () => {
  const bare: Dataset = { ...data, hasTimings: false, timingBuckets: [], timingShape: null };
  const a = analyseDraft(bare, fullDraft, settings)!;
  assert.equal(a.stages, null);
  assert.equal(a.earlyEdge, 0, "an unknown shape cannot charge either side");
});

/**
 * A board built to be the shape this whole feature exists for: five heroes on
 * my side who do nothing before the median game, five on theirs who do.
 *
 * Kept separate from `fullDraft` rather than bent out of it — that fixture is
 * load-bearing for a dozen lane tests, and a draft that is *mildly* late is
 * exactly the case the penalty is supposed to stay quiet about.
 */
function stackedWorld() {
  const heroes = [
    hero("late-1", { positions: { 1: 1 }, timings: timings(-8, -6, 1, 6) }),
    hero("late-2", { positions: { 2: 1 }, timings: timings(-8, -6, 1, 6) }),
    hero("late-3", { positions: { 3: 1 }, timings: timings(-7, -5, 1, 5) }),
    hero("late-4", { positions: { 4: 1 }, timings: timings(-7, -5, 1, 5) }),
    hero("late-5", { positions: { 5: 1 }, timings: timings(-6, -4, 1, 4) }),
    hero("soon-1", { positions: { 1: 1 }, timings: timings(6, 4, 0, -4) }),
    hero("soon-2", { positions: { 2: 1 }, timings: timings(6, 4, 0, -4) }),
    hero("soon-3", { positions: { 3: 1 }, timings: timings(5, 3, 0, -3) }),
    hero("soon-4", { positions: { 4: 1 }, timings: timings(5, 3, 0, -3) }),
    hero("soon-5", { positions: { 5: 1 }, timings: timings(4, 3, 0, -3) }),
  ];
  const world: Dataset = {
    ...data,
    heroes,
    bySlug: new Map(heroes.map((h) => [h.slug, h])),
    // One pairing, dead level, so nothing but the timing term can speak.
    matchups: { "late-1": { "soon-1": { disadvantage: 0, winRate: 50, matches: 20_000 } } },
    synergies: {},
    timingShape: deriveTimingShape(heroes, BUCKETS.length),
  };
  const draft = {
    mine: [1, 2, 3, 4, 5].map((p) => pick(`late-${p}`, p as Position)),
    enemy: [1, 2, 3, 4, 5].map((p) => pick(`soon-${p}`, p as Position)),
    banned: [],
  };
  return { world, draft };
}

test("the shortfall leads the talking points, ahead of any single lane", () => {
  const { world, draft } = stackedWorld();
  const a = analyseDraft(world, draft, settings)!;
  const points = talkingPoints(a);

  assert.ok(a.stages!.penalty >= NOISE, "five heroes with no early game are charged");
  assert.equal(a.stages!.theirPenalty, 0, "and the side that can play early is not");
  assert.match(points[0]!, /heroes who work before the median game/i);
  assert.match(points[0]!, /nothing to hold the map with/i);
  assert.ok(a.earlyEdge < 0 && a.advantage < 0, "a level board still reads as behind");
});

test("an ordinary draft is not told about a term it is not paying", () => {
  const a = analyseDraft(data, fullDraft, settings)!;
  assert.equal(a.stages!.penalty, 0);
  assert.ok(
    !talkingPoints(a).some((p) => /work before the median game/i.test(p)),
    "silence is the correct output when there is no shortfall",
  );
});

test("the copied read-out carries the weighted edge and the cover, not just the buckets", () => {
  const { world, draft } = stackedWorld();
  const md = toMarkdown(analyseDraft(world, draft, settings)!);
  assert.match(md, /Weighted by how long games actually run/);
  assert.match(md, /Heroes who work before the median game/);
});

test("the map row's weight share is computed from the slider, not asserted in prose", () => {
  // The card used to state its own importance: "they count once each in the
  // headline where lane pairings count twice, which on a full board is still
  // most of its weight". Lane pairings count `1 + laneWeight` times and that
  // slider is user-facing, so "twice" held at one setting; "most of its
  // weight" was false at that very setting; and the share was of the matchup
  // term, never of the headline. These are the numbers behind the replacement.
  const mapOf = (laneWeight: number) =>
    analyseDraft(data, fullDraft, { ...settings, laneWeight })!.lanes.find((l) => l.key === "map")!
      .weight!;

  const flat = mapOf(0);
  assert.equal(flat.laneMultiple, 1, "at zero nothing outweighs anything");
  assert.equal(flat.own, flat.total - lanePairCount(), "every pairing carries one unit");

  const doubled = mapOf(1);
  assert.equal(doubled.laneMultiple, 2);
  assert.equal(
    doubled.total,
    flat.total + lanePairCount(),
    "doubling adds one more unit per lane pairing and nothing else",
  );
  assert.ok(
    doubled.own / doubled.total < flat.own / flat.total,
    "leaning on the lanes can only shrink the map's share",
  );

  assert.equal(mapOf(3).laneMultiple, 4, "the share tracks the slider rather than a hard-coded 2");
});

/** Pairings in `fullDraft` that share a lane — the ones that get the multiplier. */
function lanePairCount(): number {
  const a = analyseDraft(data, fullDraft, settings)!;
  return a.lanes.filter((l) => l.key !== "map").reduce((n, l) => n + l.covered, 0);
}

/**
 * A lane model for `laneWorld`'s safe lane, built by hand: every seat at an
 * even baseline, each hero's lane record set directly, and the four cross
 * pairings optionally on record at a chosen share of the laning stage.
 */
function laneModelFor(opts: {
  /** Lane records at the seats booked, 0 to 1. */
  records?: Partial<Record<"one" | "five" | "three" | "four", number>>;
  /** Share of the lane my heroes took in every cross pairing, when on record. */
  pairShare?: number | null;
  gamePerLane?: number;
}): LaneModel {
  const { records = {}, pairShare = null, gamePerLane = 0.45 } = opts;
  const seatOf = { one: 1, five: 5, three: 3, four: 4 } as const;
  const record = (score: number) => ({ score, game: 0.5, decided: 100_000 });
  const seats: LaneModel["seats"] = {};
  for (const [slug, seat] of Object.entries(seatOf)) {
    seats[slug] = { [seat]: record(records[slug as keyof typeof seatOf] ?? 0.5) };
  }
  const against: LaneModel["against"] = {};
  if (pairShare !== null) {
    const cellAt = (share: number) => {
      const draws = 3_000;
      const wins = share * 10_000 - draws / 2;
      return { lanes: 11_500, wins, draws, losses: 10_000 - wins - draws, gameWins: 5_750 };
    };
    for (const mine of ["one", "five"] as const) {
      for (const theirs of ["three", "four"] as const) {
        ((against[mine] ??= {})[seatOf[mine]] ??= {})[theirs] = cellAt(pairShare);
        ((against[theirs] ??= {})[seatOf[theirs]] ??= {})[mine] = cellAt(1 - pairShare);
      }
    }
  }
  const fit = { mean: 0, signalVar: 0.0025, gamePerLane };
  return {
    against,
    seats,
    seatBaseline: { 1: 0, 3: 0, 4: 0, 5: 0 },
    fit: { 1: fit, 3: fit, 4: fit, 5: fit },
    weeks: [2958],
    generatedAt: null,
  };
}

function withLanes(world: Dataset, laneOutcomes: LaneModel): Dataset {
  return { ...world, laneOutcomes };
}

test("the laning stage is read from the pairings standing in the lane, and moves the score by what it is worth in games", () => {
  const plain = laneWorld({ mine: [50, 50], theirs: [50, 50], edge: 0.5 });
  assert.equal(plain.safe.outcome, null, "no lanes.json, no laning read");

  const withRead = analyseDraft(
    withLanes(plain.world, laneModelFor({ pairShare: 0.6 })),
    plain.draft,
    settings,
  )!.lanes.find((l) => l.key === "safe")!;
  const outcome = withRead.outcome!;

  assert.equal(outcome.covered, 4);
  assert.equal(outcome.possible, 4);
  assert.ok(outcome.result > 8 && outcome.result < 10.5, `we take ~60% of the lane, got ${outcome.result}`);
  // Only the pairings' own effect reaches the score, at the table's rate.
  near(outcome.gameEdge, (outcome.result / 100) * 0.45 * 100, "gameEdge is the residual in game points");
  assert.ok(withRead.score > plain.safe.score + NOISE, "and the lane score moves with it");
  assert.equal(withRead.measured, true);

  const note = withRead.notes.find((n) => n.kind === "laning");
  assert.ok(note, "a lopsided laning stage is said out loud");
  assert.match(note!.text, /We win the laning stage here — about 59% of it is ours|about 60% of it is ours/);
});

test("a hero's general lane strength shows in the laning read but never in the score", () => {
  // A lane bully and nothing on record about this particular pairing: the
  // card may say who wins the lane, but nothing here is evidence about games.
  const plain = laneWorld({ mine: [50, 50], theirs: [50, 50], edge: 1 });
  const bully = analyseDraft(
    withLanes(plain.world, laneModelFor({ records: { one: 0.65, five: 0.6 } })),
    plain.draft,
    settings,
  )!.lanes.find((l) => l.key === "safe")!;

  assert.ok(bully.outcome!.result > 5, "the lane result credits the bully");
  assert.equal(bully.outcome!.covered, 0, "no pairing of these four is on record");
  near(bully.score, plain.safe.score, "so the score is exactly what it was without the file");
});

test("a lost laning stage is the lane talking point, and the export says so", () => {
  const plain = laneWorld({ mine: [50, 50], theirs: [50, 50], edge: 0 });
  const a = analyseDraft(withLanes(plain.world, laneModelFor({ pairShare: 0.42 })), plain.draft, settings)!;
  const safe = a.lanes.find((l) => l.key === "safe")!;

  assert.ok(safe.outcome!.result <= -3);
  assert.ok(
    talkingPoints(a).some((line) => /they take about 5\d% of the laning stage/.test(line)),
    talkingPoints(a).join(" | "),
  );
  assert.match(toMarkdown(a), /laning 4\d% ours/);
});

// ---------------------------------------------------------------- win chance

const CALIBRATION: Calibration = {
  generatedAt: "2026-09-23T00:00:00.000Z",
  matches: 300_000,
  matchIdRange: null,
  tau: 1.5,
  weights: {
    matchups: 0.046,
    cohesion: 0.018,
    heroes: 0.052,
    seatPenalty: 0.028,
    seatBonus: 0.02,
    roleDeficit: -0.08,
    timing: 0.01,
  },
  range: [0.15, 0.85],
  inputs: {},
  holdout: null,
  reliability: [],
};

const calibrated = (): Dataset => ({ ...makeDataset(), calibration: CALIBRATION });

test("the headline is a win chance once the dataset carries a calibration", () => {
  const a = analyseDraft(calibrated(), fullDraft, settings)!;
  assert.ok(a.win, "calibrated");
  near(a.win.parts.reduce((s, p) => s + p.points, 0), a.win.chance * 100 - 50, "the parts add up to the figure");
  assert.equal(
    analyseDraft(makeDataset(), fullDraft, settings)!.win,
    null,
    "and without one it is the comparison signal it always was",
  );
});

test("the copied briefing leads with the win chance and its parts", () => {
  const lines = toMarkdown(analyseDraft(calibrated(), fullDraft, settings)!).split("\n");
  assert.match(lines[0]!, /^\*\*Win chance (\d+%|under \d+%|over \d+%) — /);
  assert.match(lines[1]!, /(roles|matchups|cohesion|heroes|timing) [+−]\d/);
  assert.match(toMarkdown(analyseDraft(makeDataset(), fullDraft, settings)!).split("\n")[0]!, /^\*\*Draft /);
});

test("the hero card previews the win chance when there is one", () => {
  const impact = pickImpact(calibrated(), midOnly, settings, "counter", 3)!;
  assert.equal(impact.unit, "chance");
  assert.ok(impact.before !== null && impact.after > 0 && impact.after < 100);
  assert.equal(pickImpact(makeDataset(), midOnly, settings, "counter", 3)!.unit, "points");
});

test("a line-up in seats it never plays says so before anything else", () => {
  const data = calibrated();
  // Every one of ours ten points worse in any seat than overall.
  for (const p of fullDraft.mine) {
    data.bySlug.get(p.slug)!.positionWinRate = { 1: 40, 2: 40, 3: 40, 4: 40, 5: 40 };
  }
  const a = analyseDraft(data, fullDraft, settings)!;
  const roles = a.win!.parts.find((p) => p.group === "roles")!;
  assert.ok(roles.points < -5, `roles ${roles.points}`);
  assert.match(a.win!.reasons.roles!, /^ALLY wins 40\.0% at 1 against 50\.0% overall/);
  assert.match(talkingPoints(a)[0]!, /^Fix the roles: /);
});
