import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SETTINGS,
  counters,
  draftBalance,
  estimateMatchupSpread,
  formatSigned,
  heroDetail,
  matchup,
  offRolePicks,
  partners,
  rankAll,
  robustPicks,
  scoreParts,
  sharesLane,
  suggestBans,
  suggestPicks,
  synergy,
} from "./scoring.ts";
import { guessPosition, missingPositions, playsRole } from "./roles.ts";
import type { Calibration } from "./winModel.ts";
import { deriveTimingShape } from "./timing.ts";
import type { CounterModel } from "./lanes.ts";
import type {
  Dataset,
  DraftPick,
  Hero,
  MatchupTable,
  Position,
  SynergyTable,
} from "../types.ts";

// Run with: node --test --experimental-strip-types src/lib/*.test.ts

interface HeroSpec {
  winRate: number;
  pickRate?: number;
  positions?: Partial<Record<Position, number>>;
  positionWinRate?: Partial<Record<Position, number>>;
}

const hero = (slug: string, spec: HeroSpec): Hero => ({
  slug,
  name: slug.toUpperCase(),
  attr: "uni",
  steam: slug,
  winRate: spec.winRate,
  pickRate: spec.pickRate ?? 5,
  ...(spec.positions
    ? {
        positions: spec.positions,
        positionWinRate: spec.positionWinRate,
        topPositions: (Object.keys(spec.positions) as unknown as string[])
          .map(Number)
          .filter((p) => (spec.positions![p as Position] ?? 0) >= 0.12) as Position[],
      }
    : {}),
});

const pick = (slug: string, position: Position | null = null): DraftPick => ({ slug, position });

/**
 * Fixture world:
 *   counter    a pos 3 that hard-counters villain (+8)
 *   support4   a pos 4 that also counters villain, but less (+4)
 *   filler     neutral, best overall win rate, plays pos 1 only
 *   villain    a pos 1 that beats ally (+6) and loses to counter
 *   ally       my pos 1
 */
function makeDataset(): Dataset {
  const heroes = [
    // A pos 3 who is worse in the 4 slot than the hero who lives there, which is
    // what the live pipeline reads off a thin seat — see `estimateSeatPrior`.
    hero("counter", {
      winRate: 50,
      positions: { 3: 0.85, 4: 0.15 },
      positionWinRate: { 3: 51, 4: 48 },
    }),
    hero("support4", { winRate: 50, positions: { 4: 0.9, 5: 0.1 }, positionWinRate: { 4: 50, 5: 46 } }),
    hero("filler", { winRate: 54, positions: { 1: 1 } }),
    hero("villain", { winRate: 51, pickRate: 30, positions: { 1: 0.95 } }),
    hero("ally", { winRate: 50, positions: { 1: 0.9 } }),
    hero("midlaner", { winRate: 50, positions: { 2: 1 } }),
    hero("noise", { winRate: 50, positions: { 3: 1 } }),
  ];
  const matchups: MatchupTable = {
    counter: {
      villain: { disadvantage: -8, winRate: 58, matches: 50_000 },
      // Slightly unfavourable, and never in the same lane as a pos 2.
      midlaner: { disadvantage: 2, winRate: 49, matches: 30_000 },
    },
    support4: { villain: { disadvantage: -4, winRate: 54, matches: 50_000 } },
    villain: {
      counter: { disadvantage: 8, winRate: 42, matches: 50_000 },
      support4: { disadvantage: 4, winRate: 46, matches: 50_000 },
      ally: { disadvantage: -6, winRate: 57, matches: 40_000 },
    },
    ally: { villain: { disadvantage: 6, winRate: 43, matches: 40_000 } },
    noise: { villain: { disadvantage: -30, winRate: 80, matches: 12 } },
    filler: {},
  };
  /**
   * Same-team chemistry, mirrored the way the loader delivers it.
   *
   * `support4` is the one who makes `ally` work; `filler` actively gets in
   * their way despite having the best win rate in the fixture. `midlaner` has
   * a huge number attached to a sample too small to believe.
   */
  const synergies: SynergyTable = {
    ally: {
      support4: { synergy: 6, matches: 5_000, winRate: 56 },
      filler: { synergy: -4, matches: 5_000, winRate: 48 },
      midlaner: { synergy: 20, matches: 40, winRate: 70 },
    },
    support4: { ally: { synergy: 6, matches: 5_000, winRate: 56 } },
    filler: { ally: { synergy: -4, matches: 5_000, winRate: 48 } },
    midlaner: { ally: { synergy: 20, matches: 40, winRate: 70 } },
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
    hasTimings: false,
    timingBuckets: [],
    timingShape: null,
    timingMatches: 0,
    error: null,
  };
}

const data = makeDataset();
const settings = DEFAULT_SETTINGS;

test("matchup() averages both heroes' pages and flips the sign", () => {
  const m = matchup(data, "counter", "villain");
  assert.ok(m);
  assert.equal(m.advantage, 8);
  assert.equal(m.bothSides, true);
  assert.equal(matchup(data, "villain", "counter")?.advantage, -8);
});

test("matchup() works one-sided and returns null for unknown pairs", () => {
  assert.equal(matchup(data, "noise", "villain")?.advantage, 30);
  assert.equal(matchup(data, "noise", "villain")?.bothSides, false);
  assert.equal(matchup(data, "filler", "ally"), null);
  assert.equal(matchup(data, "counter", "counter"), null);
});

test("counters() ranks a hero's answers hardest first, over the sample floor", () => {
  const worst = counters(data, "villain", settings);
  assert.deepEqual(
    worst.map((c) => c.hero.slug),
    ["counter", "support4"],
    "the +8 comes before the +4, and the 12-game blowout is not evidence",
  );
  assert.equal(worst[0]?.advantage, 8);
  assert.equal(
    worst[0]?.advantage,
    matchup(data, "counter", "villain")?.advantage,
    "the same figure the matchup breakdown will show once they are on the board",
  );

  const loose = counters(data, "villain", { ...settings, minMatches: 10 });
  assert.equal(loose[0]?.hero.slug, "noise", "lowering the floor lets the thin pairing in");
});

test("counters() quotes the subject's win rate, from either page", () => {
  // Both pages read: villain wins 42% of the games against counter, and
  // counter's own page says 58% the other way. They must agree.
  assert.equal(counters(data, "villain", settings)[0]?.winRate, 42);
  assert.equal(counters(data, "villain", settings)[0]?.bothSides, true);

  // Only counter's page carries the midlaner row, so the figure comes from it.
  const [worst] = counters(data, "counter", settings);
  assert.equal(worst?.hero.slug, "midlaner");
  assert.equal(worst?.winRate, 49);
  assert.equal(worst?.bothSides, false);
});

test("counters() stays empty rather than padding the row with non-counters", () => {
  assert.deepEqual(counters(data, "filler", settings), [], "nothing in the table beats filler");

  /**
   * A pairing that is well sampled, real, and worth nothing.
   *
   * This is the case the list exists to *not* show. Five faces is a row a
   * captain will spend bans off, and a hero who takes a third of a point off
   * you — inside the disagreement between Dotabuff's own two pages — has no
   * business on it just because the row had space.
   */
  const graze: Dataset = {
    ...data,
    matchups: {
      ...data.matchups,
      midlaner: {
        ...(data.matchups.midlaner ?? {}),
        filler: { disadvantage: -0.3, winRate: 50.3, matches: 40_000 },
      },
    },
  };
  assert.equal(matchup(graze, "midlaner", "filler")?.advantage, 0.3, "the edge is real");
  assert.deepEqual(counters(graze, "filler", settings), [], "and still not a counter");

  assert.equal(counters(data, "villain", settings, 1).length, 1, "the limit is honoured");
});

test("counters() can be asked about one position at a time", () => {
  const slugs = (position: Position | null) =>
    counters(data, "villain", settings, 5, position).map((c) => c.hero.slug);

  assert.deepEqual(slugs(null), ["counter", "support4"], "unfiltered: both answers");
  assert.deepEqual(slugs(3), ["counter"], "support4 never plays 3");
  assert.deepEqual(slugs(4), ["support4"], "and 4 is what support4 plays");
  assert.deepEqual(slugs(1), [], "nothing that beats villain plays the safe lane");

  /**
   * The two halves of `playsRole`, which is the whole reason this filter is not
   * the ranking's own `minRoleFit`:
   *
   * - support4 spends 10% of their games at 5, over the 8% a suggestion needs
   *   and under the 12% a seat does, so the pos 5 row is empty rather than
   *   offering a pos 4 as a hard support;
   * - counter spends 15% at 4 — over that floor — and 85% at 3, so those 15% are
   *   an offlaner in an unusual game, not a soft support. Viper's 8.4% at pos 5
   *   is the live version of the same mistake.
   */
  assert.deepEqual(slugs(5), [], "10% of games is not a seat");
  assert.equal(slugs(4).includes("counter"), false, "nor is a quarter of a hero's main role");
});

test("playsRole reads a seat, not a share", () => {
  // The live rows behind the rule, so a future change to either threshold has to
  // say out loud which of these it is willing to break.
  const shares = (positions: Partial<Record<Position, number>>): Hero =>
    hero("probe", { winRate: 50, positions });

  const viper = shares({ 1: 0.04, 2: 0.366, 3: 0.39, 4: 0.12, 5: 0.084 });
  assert.equal(playsRole(viper, 5), false, "8.4% of games is not a hard support");
  assert.equal(playsRole(viper, 3), true);
  assert.equal(playsRole(viper, 4), true, "12% of a 39% main is a seat he is picked in");

  const slark = shares({ 1: 0.765, 3: 0.055, 4: 0.012, 5: 0.169 });
  assert.equal(playsRole(slark, 5), false, "over the floor, under a quarter of the carry games");
  assert.equal(playsRole(slark, 1), true);

  const hoodwink = shares({ 2: 0.063, 3: 0.112, 4: 0.506, 5: 0.303 });
  assert.equal(playsRole(hoodwink, 5), true, "a genuine flex keeps both of its seats");
  assert.equal(playsRole(hoodwink, 4), true);

  assert.equal(playsRole(viper, null), true, "no filter, no test");
  assert.equal(
    playsRole(hero("blind", { winRate: 50 }), 5),
    true,
    "and a hero with no position data is never filtered out by position",
  );
});

test("the role filter keeps heroes the scrape has no position data for", () => {
  // A missing column must not empty the row — same rule the grid follows when it
  // declines to dim a hero it knows nothing about.
  const blind = makeDataset();
  const i = blind.heroes.findIndex((h) => h.slug === "counter");
  const bare: Hero = { ...blind.heroes[i]!, positions: undefined, topPositions: undefined };
  blind.heroes[i] = bare;
  blind.bySlug.set(bare.slug, bare);

  assert.deepEqual(
    counters(blind, "villain", settings, 5, 1).map((c) => c.hero.slug),
    ["counter"],
    "listed under every filter rather than under none",
  );
});

test("partners() can be asked about one position at a time", () => {
  const slugs = (position: Position | null) =>
    partners(data, "ally", settings, 5, position).map((p) => p.hero.slug);

  assert.deepEqual(slugs(null), ["support4"]);
  assert.deepEqual(slugs(4), ["support4"], "which is what support4 plays");
  assert.deepEqual(slugs(2), [], "and nobody ally pairs with plays mid");

  assert.equal(
    partners(data, "ally", settings, 5, 4)[0]?.synergy,
    partners(data, "ally", settings)[0]?.synergy,
    "the filter changes which pairings are offered, never what one is worth",
  );
});

test("partners() ranks a hero's pairings best first, over the sample floor", () => {
  const best = partners(data, "ally", settings);
  assert.deepEqual(
    best.map((p) => p.hero.slug),
    ["support4"],
    "the +6 pairing; filler is negative and midlaner's +20 rests on 40 games",
  );
  assert.equal(best[0]?.synergy, 6);
  assert.equal(best[0]?.winRate, 56, "the pair's own win rate, shown for context");
  assert.equal(best[0]?.matches, 5_000);

  const loose = partners(data, "ally", { ...settings, minSynergyMatches: 10 });
  assert.equal(loose[0]?.hero.slug, "midlaner", "lowering the floor lets the 40-game pair in");
});

test("partners() reads the blended figure, not a core/support cell", () => {
  /**
   * The cells answer "what are these two worth played this way round", and
   * this row is read before either hero has a position — quoting a cell here
   * would mean inventing the arrangement it describes. The score and the
   * breakdown do use the cell once both are drafted, and may differ.
   */
  const celled: Dataset = {
    ...data,
    synergies: {
      ...data.synergies,
      ally: {
        ...data.synergies.ally,
        support4: {
          synergy: 6,
          matches: 5_000,
          winRate: 56,
          cells: { cs: { synergy: 11, matches: 4_000 } },
        },
      },
    },
  };
  assert.equal(partners(celled, "ally", settings)[0]?.synergy, 6, "the blend, not the 11");
  assert.equal(
    synergy(celled, "ally", "support4", 1, 4, settings.minSynergyMatches)?.synergy,
    11,
    "while asking with both positions still gets the cell",
  );
});

test("partners() reads the role cell once the hero's own seat is known too", () => {
  /**
   * `ally` is drafted at pos 1. support4's cell is stronger than its blend;
   * midlaner's blend sits under the noise floor while the core-core cell is
   * strong; counter's blend clears it only on games where one of them
   * supported. Mirrored the way `expandSynergies` delivers them, so the pick
   * list reading from the candidate's side sees the same cells.
   */
  const support4 = { synergy: 6, matches: 5_000, winRate: 56 };
  const midlaner = { synergy: 0.2, matches: 3_000, winRate: 51 };
  const counter = { synergy: 1.5, matches: 3_000, winRate: 52 };
  const celled: Dataset = {
    ...data,
    synergies: {
      ...data.synergies,
      ally: {
        ...data.synergies.ally,
        support4: { ...support4, cells: { cs: { synergy: 11, matches: 4_000 } } },
        midlaner: { ...midlaner, cells: { cc: { synergy: 2, matches: 2_500 } } },
        counter: { ...counter, cells: { cc: { synergy: -0.4, matches: 2_000 } } },
      },
      support4: { ally: { ...support4, cells: { sc: { synergy: 11, matches: 4_000 } } } },
      midlaner: { ally: { ...midlaner, cells: { cc: { synergy: 2, matches: 2_500 } } } },
      counter: { ally: { ...counter, cells: { cc: { synergy: -0.4, matches: 2_000 } } } },
    },
  };
  const row = (position: Position, own: Position | null) =>
    partners(celled, "ally", settings, 5, position, own);

  const [support] = row(4, 1);
  assert.equal(support?.synergy, 11, "the cell for ally at 1 and support4 at 4");
  assert.equal(support?.matches, 4_000, "with the cell's own game count");
  assert.equal(support?.positional, true);
  assert.equal(row(4, null)[0]?.synergy, 6, "no seat of its own, so still the blend");
  assert.equal(row(4, null)[0]?.positional, false);

  assert.deepEqual(row(2, null), [], "midlaner's blend is under the floor");
  assert.equal(row(2, 1)[0]?.synergy, 2, "its core-core cell is not");
  assert.equal(row(3, null)[0]?.hero.slug, "counter", "counter's blend clears the floor");
  assert.deepEqual(row(3, 1), [], "played core beside a pos 1 it does not pair at all");

  const thin: Dataset = {
    ...celled,
    synergies: {
      ...celled.synergies,
      ally: { ...celled.synergies.ally, midlaner: { ...support4, cells: { cc: { synergy: 5, matches: 50 } } } },
    },
  };
  const [fallback] = partners(thin, "ally", settings, 5, 2, 1);
  assert.equal(fallback?.synergy, 6, "a cell under the sample floor falls back to the blend");
  assert.equal(fallback?.positional, false, "and is not captioned as a by-role figure");

  /**
   * The point of the whole reading: hover the drafted hero, filter a seat, and
   * each partner carries the number the pick list scores them on beside it.
   */
  const board = { mine: [pick("ally", 1)], enemy: [], banned: [] };
  for (const [slug, position] of [["support4", 4], ["midlaner", 2]] as const) {
    const listed = rankAll(celled, board, settings, position, "pick").find(
      (s) => s.hero.slug === slug,
    );
    assert.equal(
      listed?.synergyContributions[0]?.synergy,
      row(position, 1)[0]?.synergy,
      `${slug} at pos ${position}: the card and the pick list agree`,
    );
  }
});

test("partners() stays empty rather than padding the row with non-pairings", () => {
  assert.deepEqual(partners(data, "villain", settings), [], "villain has no synergy row at all");
  assert.deepEqual(
    partners(data, "filler", settings),
    [],
    "and a pairing that actively hurts is not a partner",
  );
  assert.equal(partners(data, "ally", settings, 0).length, 0, "the limit is honoured");
});

test("sharesLane models the standard lane pairings", () => {
  assert.equal(sharesLane(1, 3), true, "safe carry meets the offlane");
  assert.equal(sharesLane(1, 4), true);
  assert.equal(sharesLane(5, 3), true, "hard support stands with the carry");
  assert.equal(sharesLane(2, 2), true, "mid meets mid");
  assert.equal(sharesLane(1, 1), false, "two carries never lane against each other");
  assert.equal(sharesLane(1, null), false, "an unassigned position never matches");
  assert.equal(sharesLane(null, 3), false);
});

test("suggestPicks puts the hard counter first once the enemy is known", () => {
  const picks = suggestPicks(data, { mine: [], enemy: [pick("villain")], banned: [] }, settings);
  assert.equal(picks[0]?.hero.slug, "counter");
  assert.equal(picks[0]?.matchupScore, 8);
});

test("asking for a position only offers heroes who play it", () => {
  const draft = { mine: [], enemy: [pick("villain")], banned: [] };

  const slugs4 = suggestPicks(data, draft, settings, 4).map((p) => p.hero.slug);
  assert.ok(slugs4.includes("support4"), "a pos 4 belongs in the pos 4 list");
  assert.ok(!slugs4.includes("filler"), "a pure pos 1 must not be offered as pos 4");
  assert.ok(!slugs4.includes("villain"), "and neither must a pos 1 carry");

  // Only the two heroes that actually play the safe lane, best win rate first.
  const pos1 = suggestPicks(data, draft, settings, 1);
  assert.deepEqual(pos1.map((p) => p.hero.slug), ["filler", "ally"]);
});

test("the seat record breaks ties but does not override a real counter-pick", () => {
  const draft = { mine: [], enemy: [pick("villain")], banned: [] };

  // `counter` plays pos 4 only 15% of the time, and wins 48% there against the
  // 50% the dedicated `support4` manages — but is +8 into their carry where
  // `support4` is +4. Countering harder still wins, and the suggestion carries
  // the position share so the stretch is visible.
  const pos4 = suggestPicks(data, draft, settings, 4);
  assert.equal(pos4[0]?.hero.slug, "counter");
  assert.equal(pos4[0]?.roleFit, 0.15);
  assert.equal(pos4[1]?.hero.slug, "support4");

  // With no enemy to counter, the specialist is ahead on the seat record alone.
  const blind = suggestPicks(data, { mine: [], enemy: [], banned: [] }, settings, 4);
  assert.equal(blind[0]?.hero.slug, "support4");
});

test("the role threshold controls how much of a specialist is required", () => {
  const draft = { mine: [], enemy: [], banned: [] };
  // `counter` plays pos 4 in 15% of its games.
  const loose = suggestPicks(data, draft, { ...settings, minRoleFit: 0.1 }, 4);
  assert.ok(loose.some((p) => p.hero.slug === "counter"));

  const strict = suggestPicks(data, draft, { ...settings, minRoleFit: 0.25 }, 4);
  assert.ok(!strict.some((p) => p.hero.slug === "counter"), "15% is below a 25% threshold");
});

test("lane opponents outweigh the rest of the enemy team", () => {
  // An offlaner (pos 3) faces their safe lane, not their mid. Here the lane
  // matchup is good (+8 into their carry) and the off-lane one is not (−2).
  const draft = { mine: [], enemy: [pick("villain", 1), pick("midlaner", 2)], banned: [] };

  const flat = suggestPicks(data, draft, { ...settings, laneWeight: 0 }, 3)[0];
  const weighted = suggestPicks(data, draft, { ...settings, laneWeight: 1 }, 3)[0];

  assert.equal(flat?.hero.slug, "counter");
  assert.equal(weighted?.hero.slug, "counter");
  assert.equal(flat!.matchupScore, 3, "unweighted: (+8 and −2) / 2");
  assert.ok(
    Math.abs(weighted!.matchupScore - 14 / 3) < 1e-9,
    `lane opponent counted double: (+8·2 and −2·1) / 3, got ${weighted!.matchupScore}`,
  );

  assert.equal(weighted!.contributions.find((c) => c.slug === "villain")?.sameLane, true);
  assert.equal(weighted!.contributions.find((c) => c.slug === "midlaner")?.sameLane, false);
  assert.equal(weighted!.contributions[0]?.slug, "villain", "lane matchups are listed first");
});

test("a pos 3 lanes against both enemy supports and their carry", () => {
  const draft = { mine: [], enemy: [pick("villain", 1), pick("ally", 5)], banned: [] };
  const offlane = suggestPicks(data, draft, settings, 3)[0];
  // LANE_OPPONENTS[3] is [1, 5]: the whole enemy safe lane, so both count.
  assert.equal(offlane!.contributions.every((c) => c.sameLane), true);
});

/*
 * ------------------------------------------------------- position-aware synergy
 *
 * A pairing's headline figure averages over every way the two were played, and
 * on live data that mixture is genuinely mixed. Where the collector found a
 * core/support cell that disagrees, the score has to use it — and where it did
 * not, nothing may change.
 */
function withCells(): Dataset {
  const data = makeDataset();
  // `flexer` is worth a lot beside `ally` when farming and nothing when not.
  const flexer = hero("flexer", {
    winRate: 50,
    positions: { 2: 0.5, 4: 0.5 },
    positionWinRate: { 2: 50, 4: 50 },
  });
  data.heroes = [...data.heroes, flexer];
  data.bySlug.set("flexer", flexer);

  const cells = { cc: { synergy: 8, matches: 3_000 }, cs: { synergy: -6, matches: 3_000 } };
  // Mirrored the way the loader delivers it: the mixed cells swap sides.
  data.synergies.ally = {
    ...data.synergies.ally,
    flexer: { synergy: 1, matches: 6_000, winRate: 51, cells },
  };
  data.synergies.flexer = {
    ally: {
      synergy: 1,
      matches: 6_000,
      winRate: 51,
      cells: { cc: cells.cc, sc: cells.cs },
    },
  };
  return data;
}

test("synergy narrows to the core/support cell when both positions are known", () => {
  const data = withCells();
  // ally is pos 1, so the cell turns on what flexer is doing.
  assert.equal(synergy(data, "flexer", "ally", 2, 1)?.synergy, 8, "two cores");
  assert.equal(synergy(data, "flexer", "ally", 4, 1)?.synergy, -6, "support beside a carry");
  // Read from the other end the answer must be identical.
  assert.equal(synergy(data, "ally", "flexer", 1, 2)?.synergy, 8);
  assert.equal(synergy(data, "ally", "flexer", 1, 4)?.synergy, -6);
});

test("without positions, or without cells, the blended figure is used", () => {
  const data = withCells();
  assert.equal(synergy(data, "flexer", "ally")?.synergy, 1, "no positions given");
  assert.equal(synergy(data, "flexer", "ally", 2, null)?.synergy, 1, "only one position known");
  // A pair the collector found nothing position-specific for is untouched.
  assert.equal(synergy(data, "support4", "ally", 4, 1)?.synergy, 6);
  assert.equal(synergy(data, "support4", "ally")?.synergy, 6);
});

test("a cell carries its own sample size, so the floor judges the right number", () => {
  const data = withCells();
  assert.equal(synergy(data, "flexer", "ally", 2, 1)?.matches, 3_000);
  assert.equal(synergy(data, "flexer", "ally")?.matches, 6_000);
});

test("the same hero is ranked differently for two positions it both plays", () => {
  const data = withCells();
  const draft = { mine: [pick("ally", 1)], enemy: [], banned: [] };
  const settings = { ...DEFAULT_SETTINGS, minRoleFit: 0.1 };

  const asCore = rankAll(data, draft, settings, 2, "pick").find((s) => s.hero.slug === "flexer");
  const asSupport = rankAll(data, draft, settings, 4, "pick").find((s) => s.hero.slug === "flexer");

  assert.equal(asCore?.synergyScore, 8, "mid beside the carry uses the two-cores cell");
  assert.equal(asSupport?.synergyScore, -6, "pos 4 beside the carry uses the other one");
  assert.ok(
    (asCore?.score ?? 0) > (asSupport?.score ?? 0),
    "and that has to move the ranking, not just the read-out",
  );
});

test("contributions record whether a cell was used", () => {
  const data = withCells();
  const draft = { mine: [pick("ally", 1)], enemy: [], banned: [] };
  const detail = heroDetail(data, draft, DEFAULT_SETTINGS, "flexer", 2, "pick");
  const [contribution] = detail?.synergyContributions ?? [];

  assert.equal(contribution?.slug, "ally");
  assert.equal(contribution?.positional, true);

  // The pairing with no cells must not claim to be position-specific.
  const plain = heroDetail(data, draft, DEFAULT_SETTINGS, "support4", 4, "pick");
  assert.equal(plain?.synergyContributions[0]?.positional, false);
});

test("a read that fell back to the blend does not claim to be positional", () => {
  const data = withCells();
  // flexer/ally carries cells, but not one for two supports — this ask is
  // answered from the blended figure and has to say so. The flag used to be
  // "does the row have cells at all", which called this read positional.
  const reading = synergy(data, "flexer", "ally", 4, 5);
  assert.equal(reading?.synergy, 1, "the blend answers");
  assert.ok(!reading?.fromCell, "and the reading must not claim the cell did");

  const draft = { mine: [pick("ally", 5)], enemy: [], banned: [] };
  const detail = heroDetail(data, draft, DEFAULT_SETTINGS, "flexer", 4, "pick");
  assert.equal(detail?.synergyContributions[0]?.positional, false);

  // The genuine cell read still identifies itself.
  assert.equal(synergy(data, "flexer", "ally", 2, 1)?.fromCell, true);
});

test("position-specific win rates feed the meta term", () => {
  // counter wins 51% as a pos 3 but 50% overall.
  const asPos3 = suggestPicks(data, { mine: [], enemy: [], banned: [] }, settings, 3)
    .find((p) => p.hero.slug === "counter");
  assert.equal(asPos3?.metaScore, 1, "51% in the lane means +1 over the 50% baseline");
});

test("suggestPicks ranks by win rate when no enemy is drafted", () => {
  const picks = suggestPicks(data, { mine: [], enemy: [], banned: [] }, settings);
  assert.equal(picks[0]?.hero.slug, "filler");
  assert.equal(picks[0]?.matchupScore, 0);
});

test("suggestPicks never offers a drafted or banned hero", () => {
  const picks = suggestPicks(
    data,
    { mine: [pick("filler")], enemy: [pick("villain")], banned: ["counter"] },
    settings,
  );
  const slugs = picks.map((p) => p.hero.slug);
  assert.ok(!slugs.includes("counter"));
  assert.ok(!slugs.includes("filler"));
  assert.ok(!slugs.includes("villain"));
});

test("low-sample matchups are ignored at the default threshold", () => {
  const draft = { mine: [], enemy: [pick("villain")], banned: [] };
  const noise = suggestPicks(data, draft, settings).find((p) => p.hero.slug === "noise");
  assert.equal(noise?.matchupScore, 0, "a 12-match sample must not drive a +30 score");

  const loose = suggestPicks(data, draft, { ...settings, minMatches: 0 });
  assert.equal(loose[0]?.hero.slug, "noise");
});

test("suggestBans surfaces the hero that beats my line-up, and can be role-filtered", () => {
  const draft = { mine: [pick("ally", 1)], enemy: [], banned: [] };
  assert.equal(suggestBans(data, draft, settings)[0]?.hero.slug, "villain");

  const pos4Bans = suggestBans(data, draft, settings, 4).map((b) => b.hero.slug);
  assert.ok(!pos4Bans.includes("villain"), "villain is a pos 1, not a ban candidate for pos 4");
});

test("rankAll returns the whole eligible pool in the same order as the top-N view", () => {
  const draft = { mine: [], enemy: [pick("villain")], banned: [] };

  const all = rankAll(data, draft, settings, null, "pick");
  assert.equal(all.length, data.heroes.length - 1, "everyone but the drafted villain");
  assert.deepEqual(
    all.slice(0, 3).map((s) => s.hero.slug),
    suggestPicks(data, draft, settings, null, 3).map((s) => s.hero.slug),
    "the suggestion list is just the head of this",
  );
  assert.ok(
    all.every((s, i) => i === 0 || all[i - 1]!.score >= s.score),
    "scores never go back up",
  );

  // Ban mode measures against my own heroes instead of theirs.
  const bans = rankAll(data, { mine: [pick("ally", 1)], enemy: [], banned: [] }, settings, null, "ban");
  assert.equal(bans[0]?.hero.slug, "villain");
});

test("rankAll drops heroes the filters exclude, so the grid must place them itself", () => {
  const draft = { mine: [pick("filler")], enemy: [], banned: ["noise"] };
  const slugs = rankAll(data, draft, settings, 4, "pick").map((s) => s.hero.slug);

  assert.ok(!slugs.includes("filler"), "already on my team");
  assert.ok(!slugs.includes("noise"), "already banned");
  assert.ok(!slugs.includes("villain"), "a pos 1 does not clear the pos 4 role threshold");
  assert.deepEqual(slugs, ["support4", "counter"]);
});

test("draftBalance weights the lane matchups it knows about", () => {
  const flat = draftBalance(
    data,
    { mine: [pick("counter"), pick("ally")], enemy: [pick("villain")], banned: [] },
    settings,
  );
  assert.equal(flat?.pairs, 2);
  assert.equal(flat?.advantage, 1, "(+8 and −6) / 2");

  // Same heroes, but now counter and villain are lane opponents.
  const laned = draftBalance(
    data,
    { mine: [pick("counter", 3), pick("ally", 1)], enemy: [pick("villain", 1)], banned: [] },
    settings,
  );
  assert.ok(laned!.advantage > flat!.advantage, "winning your lane counts for more");
  assert.equal(draftBalance(data, { mine: [], enemy: [pick("villain")], banned: [] }, settings), null);
});

// ------------------------------------------------------------------- synergy

test("synergy() reads the same number from either side", () => {
  assert.equal(synergy(data, "ally", "support4")?.synergy, 6);
  assert.equal(synergy(data, "support4", "ally")?.synergy, 6);
  assert.equal(synergy(data, "ally", "ally"), null);
  assert.equal(synergy(data, "ally", "villain"), null, "an unrecorded pairing is not zero");
});

test("a hero who fits the team beats a stronger hero who does not", () => {
  const draft = { mine: [pick("ally")], enemy: [], banned: [] };

  // filler has the best win rate in the fixture (54% vs 50%) and no matchup
  // data pulling it down, so without synergy it leads comfortably.
  const withoutSynergy = suggestPicks(data, draft, { ...settings, synergyWeight: 0 });
  assert.equal(withoutSynergy[0]?.hero.slug, "filler");

  // +6 alongside ally against filler's −4 is a ten-point swing, which is more
  // than filler's four points of raw win rate.
  const withSynergy = suggestPicks(data, draft, settings);
  assert.equal(withSynergy[0]?.hero.slug, "support4");
  assert.equal(withSynergy[0]?.synergyScore, 6);
  assert.deepEqual(
    withSynergy[0]?.synergyContributions.map((c) => [c.slug, c.synergy]),
    [["ally", 6]],
  );
});

test("a pairing with too small a sample is ignored", () => {
  const draft = { mine: [pick("ally")], enemy: [], banned: [] };

  // midlaner's +20 comes from 40 games; the default floor is 200.
  const guarded = suggestPicks(data, draft, settings).find((s) => s.hero.slug === "midlaner");
  assert.equal(guarded?.synergyScore, 0);
  assert.equal(guarded?.synergyContributions.length, 0);

  // Drop the floor and the same suggestion changes its mind entirely.
  const trusting = suggestPicks(data, draft, { ...settings, minSynergyMatches: 0 });
  assert.equal(trusting[0]?.hero.slug, "midlaner");
});

test("bans are the enemy's best next pick, not just your worst matchup", () => {
  // The enemy holds ally. support4 barely interacts with my line-up, but it is
  // exactly the hero that makes their ally work — so it is the one to take away.
  const draft = { mine: [pick("counter")], enemy: [pick("ally")], banned: [] };

  const blind = suggestBans(data, draft, { ...settings, synergyWeight: 0 }).map((s) => s.hero.slug);
  assert.ok(
    blind.indexOf("support4") > 0,
    "without synergy the pairing is invisible and support4 is not the top threat",
  );

  const aware = suggestBans(data, draft, settings);
  assert.equal(aware[0]?.hero.slug, "support4");
  assert.equal(aware[0]?.synergyScore, 6, "measured against their line-up, not mine");
});

test("draftBalance reports matchups and cohesion separately", () => {
  const balance = draftBalance(
    data,
    {
      mine: [pick("ally"), pick("support4")],
      enemy: [pick("villain"), pick("filler")],
      banned: [],
    },
    settings,
  );

  assert.equal(balance?.pairs, 2, "ally loses to villain, support4 beats it; filler is unknown");
  assert.equal(balance?.counter, -1, "(−6 and +4) / 2");
  assert.equal(balance?.mySynergy, 6, "ally and support4 belong together");
  assert.equal(balance?.theirSynergy, 0, "villain and filler have no recorded pairing");
  assert.equal(balance?.synergyEdge, 6);
  assert.equal(balance?.advantage, 5, "cohesion turns a losing matchup read into a winning draft");
});

test("draftBalance still reports when only synergy is known", () => {
  const balance = draftBalance(
    data,
    { mine: [pick("ally"), pick("support4")], enemy: [pick("noise")], banned: [] },
    settings,
  );
  assert.equal(balance?.pairs, 0, "no usable head-to-head data");
  assert.equal(balance?.advantage, 6, "but the pairing still says something");
});

test("missingPositions lists what the team has not covered", () => {
  assert.deepEqual(missingPositions([]), [1, 2, 3, 4, 5]);
  assert.deepEqual(missingPositions([pick("a", 1), pick("b", 4)]), [2, 3, 5]);
  assert.deepEqual(missingPositions([pick("a", null)]), [1, 2, 3, 4, 5]);
});

test("guessPosition books a hero into the best slot the team still needs", () => {
  const counter = data.bySlug.get("counter")!;
  assert.equal(guessPosition(counter, []), 3, "its main position when everything is free");
  assert.equal(
    guessPosition(counter, [pick("x", 3)]),
    4,
    "falls back to its secondary once pos 3 is taken",
  );
  /**
   * Every position it plays is gone. This used to hand back its overall main —
   * pos 3 — which `x` is already sitting on, so the team came away with two
   * heroes on one position and pos 1 still empty. Every lane figure in the app
   * is cut on position, so that one duplicate put three heroes in a lane and
   * nobody in another, and nothing said so.
   *
   * The answer has to be a free slot. Off-role is visible — the dropdown shows
   * the share and the lane card names it — while a duplicate is not.
   */
  assert.equal(guessPosition(counter, [pick("x", 3), pick("y", 4)]), 1);
  assert.equal(guessPosition(counter, [pick("x", 3), pick("y", 4), pick("z", 1)]), 2);
  assert.equal(guessPosition(undefined, []), null);
  assert.equal(
    guessPosition(counter, [pick("v", 1), pick("w", 2), pick("x", 3), pick("y", 4), pick("z", 5)]),
    null,
    "a full team has no seat to offer",
  );
});

test("guessPosition fills gaps in order for heroes without position data", () => {
  const unknown: Hero = { slug: "unknown", name: "Unknown", attr: "uni", steam: "unknown" };
  assert.equal(guessPosition(unknown, []), 1);
  assert.equal(guessPosition(unknown, [pick("a", 1), pick("b", 2)]), 3);
});

// ------------------------------------------------- honesty of the raw figures

test("a two-sided matchup quotes the sample both readings support", () => {
  const world: Dataset = {
    ...data,
    matchups: {
      ...data.matchups,
      alpha: { beta: { disadvantage: 2, winRate: 48, matches: 9_000 } },
      beta: { alpha: { disadvantage: -3, winRate: 52, matches: 11_000 } },
    },
  };
  const m = matchup(world, "alpha", "beta")!;

  assert.equal(m.advantage, -2.5, "the two readings are averaged as before");
  assert.equal(
    m.matches,
    9_000,
    "the smaller count — quoting 11,000 inflates a number half-built from 9,000",
  );
  assert.equal(m.spread, 1, "and the disagreement between the pages is carried, not hidden");
  assert.equal(m.bothSides, true);
});

test("a one-sided matchup has nothing to disagree with", () => {
  const world: Dataset = {
    ...data,
    matchups: { ...data.matchups, alpha: { gamma: { disadvantage: 4, winRate: 46, matches: 800 } } },
  };
  const m = matchup(world, "alpha", "gamma")!;
  assert.equal(m.advantage, -4);
  assert.equal(m.matches, 800);
  assert.equal(m.spread, 0);
  assert.equal(m.bothSides, false);
});

test("asking synergy with positions is never worse than asking without", () => {
  const row = {
    synergy: 5,
    matches: 8_000,
    winRate: 55,
    // Carved from the same pairing, but on a sample nobody should trust.
    cells: { cc: { synergy: -9, matches: 30 } },
  };
  const world: Dataset = { ...data, synergies: { one: { two: row }, two: { one: row } } };

  assert.equal(synergy(world, "one", "two", 1, 2, 200)?.synergy, 5, "thin cell, blended answer");
  assert.equal(synergy(world, "one", "two", 1, 2, 200)?.matches, 8_000);
  assert.equal(
    synergy(world, "one", "two", 1, 2)?.synergy,
    -9,
    "without a floor the cell is still returned as before",
  );
  assert.equal(synergy(world, "one", "two", 4, 5, 200)?.synergy, 5, "no cell for two supports");
});

// ------------------------------------------------------------- robust picks

/**
 * The fixture has six pickable heroes, so a depth of 5 marks nearly all of
 * them and proves nothing. Two is the discriminating depth here; the app uses
 * five against a pool of 120-odd.
 */
const DEPTH = 2;

test("a hero the weights cannot dislodge is marked, a weight-dependent one is not", () => {
  const draft = { mine: [], enemy: [pick("villain", 1)], banned: [] };
  const robust = robustPicks(data, draft, DEFAULT_SETTINGS, null, "pick", DEPTH);

  // counter beats villain by 8 — no plausible weighting demotes that.
  assert.ok(robust.has("counter"), "a hard counter survives every corner");

  // filler has the best win rate in the fixture and no matchup data at all, so
  // it leads only while the meta term is weighted — turn that down and it is
  // nothing. That is exactly the claim the mark exists to withhold.
  assert.ok(!robust.has("filler"), "a meta-only hero is not called robust");
});

test("robustness reflects the weights, so a changed evidence bar changes it", () => {
  const draft = { mine: [], enemy: [pick("villain", 1)], banned: [] };
  const normal = robustPicks(data, draft, DEFAULT_SETTINGS, null, "pick", DEPTH);
  // Raise the floor past every sample and the matchups stop counting: what is
  // left is the meta term, and filler — the best raw win rate in the fixture —
  // becomes the hero no weighting can dislodge. The mark tracks the evidence
  // the user chose to admit rather than overriding it.
  const strict = { ...DEFAULT_SETTINGS, minMatches: 1_000_000 };
  const filtered = robustPicks(data, draft, strict, null, "pick", DEPTH);

  assert.ok(!normal.has("filler"), "with matchups counted, filler is not robust");
  assert.ok(filtered.has("filler"), "with them excluded, the meta hero is all that is left");
});

test("ban robustness asks the question from the enemy's seat", () => {
  const draft = { mine: [pick("ally", 1)], enemy: [], banned: [] };
  const robust = robustPicks(data, draft, DEFAULT_SETTINGS, null, "ban", DEPTH);
  // villain beats our ally by 6 and is picked 30% of the time — the enemy
  // wants them under any weighting.
  assert.ok(robust.has("villain"), "the hero the enemy always wants is always worth banning");
});

test("nothing is marked when the corners cannot agree at all", () => {
  // An empty board: no matchups, no allies, so only the meta term separates
  // heroes — and at metaWeight 0 every hero ties. A tie is not agreement, and
  // marking the arbitrary winner of one would be the exact overclaim the star
  // exists to avoid.
  const empty = { mine: [], enemy: [], banned: [] };
  const robust = robustPicks(data, empty, DEFAULT_SETTINGS, null, "pick", 1);
  assert.ok(robust.size <= 1, `at most the one hero every corner agrees on (${[...robust]})`);
});

// -------------------------------------------------------- matchup shrinkage

/** Deterministic PRNG, so a failure here is always reproducible. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A table big enough for the spread to be estimated: 1,225 pairings whose
 * *real* edges are ±`truth` pp, observed through the sampling noise a sample
 * of `matches` games actually carries (sd = 50/√n points).
 *
 * The noise is the point. The estimator's whole job is to subtract the noise
 * it knows must be in a reading, so feeding it noise-free numbers would make
 * it look broken when it is behaving exactly as designed — it would net off a
 * variance that was never added.
 */
function spreadWorld(matches: number, truth = 2, seed = 99): MatchupTable {
  const table: MatchupTable = {};
  const random = mulberry32(seed);
  const gauss = () =>
    Math.sqrt(-2 * Math.log(random() || 1e-9)) * Math.cos(2 * Math.PI * random());
  const noiseSd = 50 / Math.sqrt(matches); // sd of a win-rate reading, in points

  const n = 50; // 50 heroes -> 1,225 pairings, over the estimator's floor
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      // Alternating signs, so the table is symmetric around zero as real ones are.
      const edge = ((i + j) % 2 ? truth : -truth) + noiseSd * gauss();
      (table[`h${i}`] ??= {})[`h${j}`] = { disadvantage: edge, winRate: 50 - edge, matches };
      (table[`h${j}`] ??= {})[`h${i}`] = { disadvantage: -edge, winRate: 50 + edge, matches };
    }
  }
  return table;
}

const withSpread = (matchups: MatchupTable): Dataset => ({
  ...data,
  matchups,
  matchupSpread: estimateMatchupSpread(matchups),
});

test("the matchup spread recovers the real edge and nets off the noise", () => {
  // Truth is ±2pp, so the signal variance is 4 — whatever the sample size.
  const big = estimateMatchupSpread(spreadWorld(200_000))!;
  const small = estimateMatchupSpread(spreadWorld(2_000))!;
  assert.ok(Math.abs(Math.sqrt(big) - 2) < 0.05, `large sample: ${Math.sqrt(big).toFixed(3)}`);
  assert.ok(Math.abs(Math.sqrt(small) - 2) < 0.2, `small sample: ${Math.sqrt(small).toFixed(3)}`);
});

test("a table too small to estimate from leaves every advantage untouched", () => {
  assert.equal(estimateMatchupSpread(data.matchups), null, "the fixture is far too small");
  // …and a null spread must not damp anything, which is what keeps a partial
  // scrape scoring exactly as it did before shrinkage existed.
  assert.equal(matchup(data, "counter", "villain")?.advantage, 8);
});

test("thin pairings are damped towards zero, fat ones are not", () => {
  const fat = withSpread(spreadWorld(200_000));
  const thin = withSpread(spreadWorld(400));

  const fatEdge = matchup(fat, "h0", "h1")!.advantage;
  const thinEdge = matchup(thin, "h0", "h1")!.advantage;

  assert.ok(Math.abs(fatEdge) > 1.95, `a huge sample keeps its edge (${fatEdge.toFixed(2)})`);
  assert.ok(Math.abs(thinEdge) < 1.4, `a 400-game edge is pulled in (${thinEdge.toFixed(2)})`);
  assert.ok(Math.abs(thinEdge) > 0.3, "but not silenced — that is what the floor is for");
  assert.equal(Math.sign(thinEdge), Math.sign(fatEdge), "damping never flips a sign");
});

test("damping is symmetric, so the two sides still cancel exactly", () => {
  const world = withSpread(spreadWorld(800));
  for (const [a, b] of [["h0", "h1"], ["h3", "h20"], ["h11", "h49"]] as const) {
    const ab = matchup(world, a, b)!;
    const ba = matchup(world, b, a)!;
    assert.ok(Math.abs(ab.advantage + ba.advantage) < 1e-12, `${a}/${b} antisymmetry`);
    assert.equal(ab.matches, ba.matches);
  }
});

test("a table with no real signal collapses to no advantage at all", () => {
  // Every pairing dead even: the observed spread is pure noise, so the honest
  // estimate of the real spread is zero and nothing may be claimed from it.
  const flat = withSpread(spreadWorld(1_000, 0));
  assert.equal(flat.matchupSpread, 0);
  assert.equal(matchup(flat, "h0", "h1")?.advantage, 0);
});

test("formatSigned never prints a minus the rounding erased", () => {
  assert.equal(formatSigned(1.234, 2), "+1.23");
  assert.equal(formatSigned(-1.234, 2), "−1.23");
  assert.equal(formatSigned(0), "+0.00");
  // −0.004 rounds to 0.00 at two digits; the sign has to round with it.
  assert.equal(formatSigned(-0.004), "+0.00");
  assert.equal(formatSigned(-0.06, 1), "−0.1");
});

// ----------------------------------------------------------- early-game cover

/**
 * A world where the only thing separating the candidates is when they win.
 *
 * Every hero here has the same win rate, the same (absent) matchups and the
 * same (absent) synergies, so the suggestion list is decided by the timing term
 * alone. That is the point: it isolates a signal the picker previously did not
 * have at all, and it makes the reordering it causes unambiguous rather than a
 * side effect of some pairing.
 */
function timingWorld(): Dataset {
  const curve = (skews: number[]): Hero["timings"] =>
    skews.map((skew) => ({ games: 5_000, winRate: 50 + skew, skew }));
  const shaped = (slug: string, skews: number[]): Hero => ({
    ...hero(slug, { winRate: 50, positions: { 1: 1 } }),
    timings: curve(skews),
  });
  const LATE = [-6, -5, 1, 5];
  const EARLY = [5, 4, 0, -4];
  const FLAT = [0, 0, 0, 0];

  /**
   * Balanced on purpose: five heroes who only work late, five who only work
   * early, four who are neither. That makes the pool average exactly half a
   * body, so five undrafted slots project to 2.5 and an untouched board is
   * charged nothing — which is the behaviour being tested, and it would be
   * trivially true in a pool that happened to be full of early heroes.
   *
   * The fifth scaler exists so that "another one of the same" is still an
   * available candidate once four are on the board; without it the test could
   * not ask what the term does to the pick that actually breaks the draft.
   */
  const heroes: Hero[] = [
    shaped("scaler-a", LATE),
    shaped("scaler-b", LATE),
    shaped("scaler-c", LATE),
    shaped("scaler-d", LATE),
    shaped("scaler-e", LATE),
    shaped("laner", EARLY),
    shaped("laner-b", EARLY),
    shaped("laner-c", EARLY),
    shaped("laner-d", EARLY),
    shaped("laner-e", EARLY),
    shaped("neutral", FLAT),
    shaped("neutral-b", FLAT),
    shaped("neutral-c", FLAT),
    shaped("neutral-d", FLAT),
  ];

  return {
    heroes,
    bySlug: new Map(heroes.map((h) => [h.slug, h])),
    matchups: {},
    synergies: {},
    generatedAt: null,
    hasData: true,
    hasPositions: true,
    hasSynergies: false,
    synergyMatches: 0,
    hasTimings: true,
    timingBuckets: [
      { key: "early", label: "Before 25\u2032", short: "<25", maxSeconds: 1500 },
      { key: "mid", label: "25\u201335\u2032", short: "25\u201335", maxSeconds: 2100 },
      { key: "late", label: "35\u201345\u2032", short: "35\u201345", maxSeconds: 2700 },
      { key: "veryLate", label: "45\u2032 and up", short: "45+", maxSeconds: null },
    ],
    timingShape: deriveTimingShape(heroes, 4),
    timingMatches: 300_000,
    error: null,
  };
}

const STACKED = {
  mine: [pick("scaler-a", 1), pick("scaler-b", 1), pick("scaler-c", 1), pick("scaler-d", 1)],
  enemy: [],
  banned: [],
};

test("the first scaling hero is free — the term must not talk you out of a carry", () => {
  const world = timingWorld();
  const empty = { mine: [], enemy: [], banned: [] };
  const top = suggestPicks(world, empty, settings, null, 20);

  assert.ok(top.every((s) => s.earlyPenalty === 0), "an empty board is charged nothing at all");
  assert.equal(top[0]?.hero.slug !== undefined, true);
});

test("the fifth scaling hero is not — stacking is what gets caught", () => {
  const world = timingWorld();
  const ranked = suggestPicks(world, STACKED, settings, null, 20);
  assert.equal(
    ranked[0]?.hero.slug,
    "laner",
    "with four scaling heroes down, the hero who plays early leads the list",
  );

  const laner = ranked.find((s) => s.hero.slug === "laner")!;
  const neutral = ranked.find((s) => s.hero.slug === "neutral")!;
  const scaler = ranked.find((s) => s.hero.slug === "scaler-e")!;

  // Nobody escapes a hole this deep — four heroes who do nothing early cannot
  // be undone by the fifth pick, and a term that pretended otherwise would be
  // telling you the draft is fine when it is not. What it can do is rank the
  // damage: the early hero pays least, the average hero more, another scaling
  // hero most.
  assert.ok(laner.earlyPenalty < 0, "even the right pick cannot repair four wrong ones");
  assert.ok(neutral.earlyPenalty < laner.earlyPenalty);
  assert.ok(scaler.earlyPenalty < neutral.earlyPenalty, "the fifth scaling hero pays the most");
  assert.ok(laner.score > neutral.score && neutral.score > scaler.score);
});

test("the same board with the weight off ranks the candidates level again", () => {
  const world = timingWorld();
  const off = { ...settings, earlyWeight: 0 };
  const ranked = suggestPicks(world, STACKED, settings, null, 20);
  const level = suggestPicks(world, STACKED, off, null, 20);

  assert.ok(level.every((s) => s.earlyPenalty === 0));
  const spread = (xs: typeof level) => Math.max(...xs.map((s) => s.score)) - Math.min(...xs.map((s) => s.score));
  assert.equal(spread(level), 0, "nothing else in this world separates them");
  assert.ok(spread(ranked) > 0, "so every point of separation came from the timing term");
});

test("a hero the timing collector never saw is not counted as filling the hole", () => {
  const world = timingWorld();
  const unknown: Hero = { slug: "unknown", name: "UNKNOWN", attr: "uni", steam: "unknown", winRate: 50 };
  const heroes = [...world.heroes, unknown];
  const withUnknown: Dataset = {
    ...world,
    heroes,
    bySlug: new Map(heroes.map((h) => [h.slug, h])),
  };
  const ranked = suggestPicks(withUnknown, STACKED, settings, null, 20);
  const laner = ranked.find((s) => s.hero.slug === "laner")!;
  const mystery = ranked.find((s) => s.hero.slug === "unknown")!;
  assert.equal(mystery.earlyCover, null, "unknown is unknown, not zero and not average");
  assert.ok(
    mystery.score < laner.score,
    "an unmeasured hero cannot be credited with fixing a hole they were never seen in",
  );
});

test("draftBalance carries the shortfall as its own term, not folded into the others", () => {
  const world = timingWorld();
  const draft = {
    mine: [pick("scaler-a", 1), pick("scaler-b", 1), pick("scaler-c", 1), pick("scaler-d", 1), pick("neutral", 1)],
    enemy: [pick("laner", 1), pick("laner-b", 1), pick("neutral", 1), pick("neutral-b", 1), pick("neutral-c", 1)],
    banned: [],
  };
  const balance = draftBalance(world, draft, settings)!;
  assert.ok(balance.earlyEdge < 0, "my four scaling heroes are the ones paying");
  assert.equal(balance.counter, 0, "no matchups exist in this world");
  assert.equal(balance.synergyEdge, 0, "nor synergies");
  assert.equal(
    Number(balance.advantage.toFixed(9)),
    Number(balance.earlyEdge.toFixed(9)),
    "so the headline is the timing term and nothing else",
  );
  assert.ok(balance.myEarlyCover! < balance.theirEarlyCover!);
});


/**
 * The invariant the hover card rests on.
 *
 * The card exists to show its working, and for a while it did not: the rows
 * were assembled by hand from the same fields `evaluate` added up, so when
 * `intentScore` joined the sum and nobody added a row for it, the card printed
 * a breakdown coming to +0.18 under a headline of +4.83 and offered no account
 * of the missing 4.65. Both now come off `scoreParts`, and this is the test
 * that says so — it fails the moment a term is added to one and not the other.
 */
test("the score is exactly its parts, every term of it", () => {
  const intent = new Map([["villain", 6]]);
  const draft = { mine: [pick("ally", 4)], enemy: [pick("midlaner", 2)], banned: [] };

  for (const mode of ["pick", "ban"] as const) {
    for (const position of [null, 1, 4] as const) {
      const ranked = rankAll(data, draft, settings, position, mode, intent);
      assert.ok(ranked.length, `${mode} @ ${position} ranked nobody`);
      for (const suggestion of ranked) {
        const sum = scoreParts(suggestion, settings).reduce((t, p) => t + p.value, 0);
        assert.equal(
          Number(sum.toFixed(9)),
          Number(suggestion.score.toFixed(9)),
          `${suggestion.hero.slug} (${mode} @ ${position}) has a headline its rows cannot explain`,
        );
      }
    }
  }
});

test("the parts carry the intent term, weighted, where the enemy's bans point", () => {
  const intent = new Map([["villain", 6]]);
  const draft = { mine: [pick("ally", 4)], enemy: [], banned: [] };
  const banning = rankAll(data, draft, settings, null, "ban", intent);
  const villain = banning.find((s) => s.hero.slug === "villain")!;

  const term = scoreParts(villain, settings).find((p) => p.term === "intent")!;
  assert.equal(term.value, settings.intentWeight * 6, "the row is the weighted term, not the raw one");

  // And the same hero with nothing read off the bans has the row at zero, so a
  // card that hides it is hiding nothing.
  const quiet = rankAll(data, draft, settings, null, "ban").find((s) => s.hero.slug === "villain")!;
  assert.equal(scoreParts(quiet, settings).find((p) => p.term === "intent")!.value, 0);
  assert.ok(villain.score > quiet.score, "a read plan makes a hero worth taking away");
});

/**
 * The lane table's own reading, hand-built: `counter` is a pos 3 who does
 * better against `villain` from that seat than the whole-game figure says, and
 * `support4` — who never plays pos 3 at all — does better still.
 */
const seatReadings: CounterModel = {
  cells: {
    counter: { 3: { villain: { raw: 3, noise: 0.02, lanes: 20_000 } } },
    support4: { 3: { villain: { raw: 6, noise: 0.02, lanes: 20_000 } } },
    midlaner: { 2: { villain: { raw: 9, noise: 0.02, lanes: 20_000 } } },
  },
  signalVar: 1,
  slope: 1,
  pairs: 600,
};
const seatAware: Dataset = { ...data, laneCounters: seatReadings };
const versusVillain = { mine: [], enemy: [pick("villain", 1)], banned: [] };

test("a lane confrontation is scored from the seat, not only from the whole-game table", () => {
  const plain = heroDetail(data, versusVillain, settings, "counter", 3, "pick");
  const seated = heroDetail(seatAware, versusVillain, settings, "counter", 3, "pick");
  assert.equal(plain?.contributions[0].advantage, 8);
  assert.equal(plain?.contributions[0].laneEdge, undefined);
  // 3 points of seat-specific edge, damped by its own sample: 1/(1+0.02).
  assert.ok(Math.abs((seated?.contributions[0].laneEdge ?? 0) - 3 * (1 / 1.02)) < 1e-9);
  assert.ok(Math.abs((seated?.contributions[0].advantage ?? 0) - (8 + 3 / 1.02)) < 1e-9);
  assert.equal(seated?.contributions[0].laneLanes, 20_000);
  assert.ok((seated?.score ?? 0) > (plain?.score ?? 0));
});

test("heroes who would not meet in a lane are scored as they always were", () => {
  // midlaner has a reading at pos 2, but a pos 2 never faces a pos 1 in lane.
  const seated = heroDetail(seatAware, versusVillain, settings, "midlaner", 2, "pick");
  assert.equal(seated?.contributions.length, 0);
  const off = heroDetail(seatAware, versusVillain, settings, "counter", 4, "pick");
  assert.equal(off?.contributions[0].laneEdge, undefined, "pos 4 has no row of its own here");
});

test("offRolePicks offers the counter-pick the role threshold hides, and only that", () => {
  const found = offRolePicks(seatAware, versusVillain, settings, 3);
  assert.deepEqual(
    found.map((f) => f.suggestion.hero.slug),
    ["support4"],
  );
  assert.equal(found[0].against.slug, "villain");
  assert.ok((found[0].against.laneEdge ?? 0) > 5);
  // `counter` clears the threshold at pos 3, so he belongs to the main list.
  assert.ok(suggestPicks(seatAware, versusVillain, settings, 3).some((s) => s.hero.slug === "counter"));
});

test("offRolePicks says nothing without a seat, without lane readings, or with the floor lifted", () => {
  assert.deepEqual(offRolePicks(seatAware, versusVillain, settings, null), []);
  assert.deepEqual(offRolePicks(data, versusVillain, settings, 3), []);
  assert.deepEqual(offRolePicks(seatAware, versusVillain, { ...settings, minRoleFit: 0 }, 3), []);
  // Nothing on the board to counter, so nothing to justify the stretch.
  assert.deepEqual(offRolePicks(seatAware, { mine: [], enemy: [], banned: [] }, settings, 3), []);
});

test("the board read and the pick list agree about a lane pairing", () => {
  const board = { mine: [pick("counter", 3)], enemy: [pick("villain", 1)], banned: [] };
  const plain = draftBalance(data, board, settings);
  const seated = draftBalance(seatAware, board, settings);
  assert.equal(plain?.counter, 8);
  assert.ok(Math.abs((seated?.counter ?? 0) - (8 + 3 / 1.02)) < 1e-9);
  // The same figure the suggestion list would have shown for that pick.
  const suggested = heroDetail(seatAware, versusVillain, settings, "counter", 3, "pick");
  assert.ok(Math.abs((seated?.counter ?? 0) - (suggested?.matchupScore ?? 0)) < 1e-9);
});

const SEAT_CALIBRATION: Calibration = {
  generatedAt: null,
  matches: 300_000,
  matchIdRange: null,
  rankBand: "all",
  tau: 0.5,
  weights: {
    matchups: 0.046,
    cohesion: 0.02,
    heroes: 0.052,
    seatPenalty: 0.03,
    seatBonus: 0.013,
    roleDeficit: 0,
    timing: 0.09,
  },
  range: [0.15, 0.85],
  inputs: {},
  holdout: null,
  reliability: [],
};

test("a seat above the hero's own record is scored at the calibrated share", () => {
  const base = makeDataset();
  const flexer = hero("flexer", {
    winRate: 51,
    positions: { 1: 0.1, 2: 0.7, 4: 0.2 },
    positionWinRate: { 1: 60, 2: 51, 4: 46 },
  });
  const heroes = [...base.heroes, flexer];
  const data: Dataset = { ...base, heroes, bySlug: new Map(heroes.map((h) => [h.slug, h])) };
  const calibrated: Dataset = { ...data, calibration: SEAT_CALIBRATION };
  const draft = { mine: [], enemy: [], banned: [] };

  const raw = heroDetail(data, draft, DEFAULT_SETTINGS, "flexer", 1, "pick");
  assert.equal(raw?.seatWorth, 60, "without a calibration the seat record stands");

  const surplus = heroDetail(calibrated, draft, DEFAULT_SETTINGS, "flexer", 1, "pick");
  assert.equal(surplus?.winRate, 60, "the measured record is still what is shown");
  assert.equal(surplus?.seatWorth, 51 + 9 * 0.25);
  assert.equal(surplus?.metaScore, 51 + 9 * 0.25 - 50);

  const deficit = heroDetail(calibrated, draft, DEFAULT_SETTINGS, "flexer", 4, "pick");
  assert.equal(deficit?.seatWorth, 46, "a seat below the hero's record is charged in full");
});
