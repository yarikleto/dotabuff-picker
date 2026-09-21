import test from "node:test";
import assert from "node:assert/strict";
import { attachPositionCounts, emptyDataset } from "./dataset.ts";
import {
  effectiveBand,
  estimateSeatPrior,
  positionsFromCounts,
  readPositionCells,
  seatPriorAt,
  withRankBand,
} from "./positions.ts";
import { POSITIONS as POSITION_LIST } from "./roles.ts";
import type { Dataset, Hero } from "../types.ts";

// Dragon Knight, four weeks of ranked All Pick on STRATZ, rounded.
const DK_ALL: Array<[number, number]> = [
  [137_000, 67_000],
  [350_000, 188_000],
  [607_000, 311_000],
  [51_000, 25_000],
  [29_000, 14_000],
];
const DK_DIVINE: Array<[number, number]> = [
  [8_600, 4_100],
  [52_700, 27_700],
  [48_200, 24_800],
  [900, 400],
  [600, 300],
];

function dataset(heroes: Hero[], bands: Dataset["positionBands"] = ["all", "divine"]): Dataset {
  return {
    ...emptyDataset(),
    heroes,
    bySlug: new Map(heroes.map((h) => [h.slug, h])),
    hasPositions: heroes.some((h) => h.positions),
    positionBands: bands,
  };
}

/** Dotabuff's reconstruction of Dragon Knight: mostly an offlaner. */
const dragonKnight = (): Hero => ({
  slug: "dragon-knight",
  name: "Dragon Knight",
  attr: "uni",
  steam: "dragon_knight",
  winRate: 51.61,
  positions: { 1: 0.19, 2: 0.22, 3: 0.55, 4: 0.03, 5: 0.01 },
  positionWinRate: { 1: 50, 2: 51.11, 3: 49.12, 4: 51.19, 5: 51.49 },
  topPositions: [3, 2, 1],
  positionCounts: { all: DK_ALL, divine: DK_DIVINE },
});

test("shares are games in the position over all games, and they sum to one", () => {
  const derived = positionsFromCounts(DK_ALL)!;
  const total = DK_ALL.reduce((n, [g]) => n + g, 0);
  assert.ok(Math.abs(derived.positions[2]! - 350_000 / total) < 1e-12);
  const sum = Object.values(derived.positions).reduce((n, s) => n + s, 0);
  assert.ok(Math.abs(sum - 1) < 1e-12);
});

/**
 * A table big enough to measure a prior from, built so there is something to
 * measure: 50 heroes whose five seats span the share range, and whose record in
 * a seat falls with how rarely they are put in it — the effect
 * `estimateSeatPrior` exists to find. Each *seat* is offset a couple of points
 * so the bands have a real spread to separate from noise — a per-hero offset
 * would cancel out of the gap to their own figure and leave none.
 */
const SHARES = [0.45, 0.25, 0.15, 0.1, 0.05];

function syntheticTable(total = 40_000): Hero[] {
  return Array.from({ length: 50 }, (_, i) => {
    const cells = POSITION_LIST.map((p): [number, number] => {
      const share = SHARES[(p - 1 + i) % 5]!;
      const games = Math.round(total * share);
      const wr = 50 + 12 * (share - 0.25) + ((((i * 7 + p * 3) % 5) - 2) * 1.2);
      return [games, Math.round((games * wr) / 100)];
    });
    return { ...dragonKnight(), slug: `h${i}`, positionCounts: { all: cells } };
  });
}

test("the seat prior measures what a seat of each share is worth, noise removed", () => {
  const prior = estimateSeatPrior(syntheticTable())!;
  assert.ok(prior, "50 heroes is table enough to measure one");

  const thin = seatPriorAt(prior, 0.01);
  const main = seatPriorAt(prior, 0.9);
  // Built so a 5% seat wins 47.6% and a 45% one 52.4%, against a hero figure of
  // 50.6 — so the rare seat reads below its hero and the usual seat above it.
  assert.ok(thin.mean < -2, `a rarely-used seat reads below the hero: ${thin.mean}`);
  assert.ok(main.mean > 1, `a hero's usual seat reads above: ${main.mean}`);
  // Off the ends the prior holds its last measured value rather than running on.
  assert.equal(seatPriorAt(prior, 0).mean, thin.mean);
  assert.equal(seatPriorAt(prior, 1).mean, main.mean);

  // Spread is the ±2pp the heroes were built to differ by, not the sampling
  // noise of the cells it was read off.
  assert.ok(main.spread > 0.5 && main.spread < 10, `real spread survives: ${main.spread}`);

  assert.equal(estimateSeatPrior([dragonKnight()]), null, "one hero measures nothing");
});

test("a seat's win rate is pulled to what its share is worth, by how well it is measured", () => {
  const prior = estimateSeatPrior(syntheticTable())!;
  const total = DK_ALL.reduce((n, [g]) => n + g, 0);
  const overall = (DK_ALL.reduce((n, [, w]) => n + w, 0) / total) * 100;
  const raw = (188_000 / 350_000) * 100;

  // No prior: the reading is the reading. The same fallback an advantage gets
  // when the table is too small to estimate `matchupSpread` from.
  assert.ok(Math.abs(positionsFromCounts(DK_ALL)!.positionWinRate[2]! - raw) < 0.006);

  // With one: 350,000 games is measured far past any doubt, so only the pull
  // towards what a seat of that share is worth moves it, and barely.
  const shrunk = positionsFromCounts(DK_ALL, prior)!.positionWinRate[2]!;
  assert.ok(Math.abs(shrunk - raw) < 1.5, `a well-measured seat keeps its reading: ${shrunk}`);

  // A seat read off 40 games cannot move itself, whatever it claims.
  const thin: Array<[number, number]> = [[400_000, 200_000], [40, 40], [0, 0], [0, 0], [0, 0]];
  const claimed = positionsFromCounts(thin, prior)!.positionWinRate[2]!;
  assert.ok(claimed < 60, `40 games do not make a 100% seat: ${claimed}`);

  // The hero's own figure is never touched: it is the whole of their record.
  assert.ok(Math.abs(positionsFromCounts(DK_ALL, prior)!.winRate - overall) < 0.006);
});

test("top positions are the seats with 12% or more of the games, commonest first", () => {
  assert.deepEqual(positionsFromCounts(DK_ALL)!.topPositions, [3, 2]);
  assert.deepEqual(positionsFromCounts(DK_DIVINE)!.topPositions, [2, 3]);
  // Nobody is left role-less, however thinly they are spread.
  const spread: Array<[number, number]> = [[11, 5], [11, 5], [11, 5], [11, 5], [56, 30]];
  assert.deepEqual(positionsFromCounts(spread)!.topPositions, [5]);
  const flat: Array<[number, number]> = [[20, 10], [20, 10], [20, 10], [20, 10], [20, 10]];
  assert.equal(positionsFromCounts(flat)!.topPositions.length, 5);
});

test("a band with no games says nothing", () => {
  assert.equal(positionsFromCounts([[0, 0], [0, 0], [0, 0], [0, 0], [0, 0]]), null);
});

test("malformed bands are refused whole", () => {
  assert.deepEqual(readPositionCells([[1, 1], [2, 1], [3, 1], [4, 1], [5, 1]])?.length, 5);
  assert.equal(readPositionCells([[1, 1]]), null, "five positions or nothing");
  assert.equal(readPositionCells([[1, 2], [2, 1], [3, 1], [4, 1], [5, 1]]), null, "more wins than games");
  assert.equal(readPositionCells([[-1, 0], [2, 1], [3, 1], [4, 1], [5, 1]]), null);
  assert.equal(readPositionCells([["1", 1], [2, 1], [3, 1], [4, 1], [5, 1]]), null);
  assert.equal(readPositionCells(undefined), null);
});

test("the chosen band replaces the reconstruction, and makes Dragon Knight a mid at Divine+", () => {
  const data = dataset([dragonKnight()]);
  const all = withRankBand(data, "all").bySlug.get("dragon-knight")!;
  const divine = withRankBand(data, "divine").bySlug.get("dragon-knight")!;

  assert.ok(all.positions![2]! > 0.29 && all.positions![2]! < 0.31);
  assert.ok(divine.positions![2]! > 0.46);
  assert.equal(divine.topPositions![0], 2);
  assert.equal(withRankBand(data, "divine").rankBand, "divine");
});

test("switching bands never edits the loaded dataset", () => {
  const data = dataset([dragonKnight()]);
  withRankBand(data, "divine");
  const loaded = data.bySlug.get("dragon-knight")!;
  assert.equal(loaded.positions![2], 0.22, "the reconstruction is still there to fall back on");
  assert.equal(loaded.winRate, 51.61);
});

test("a band the file lacks falls back to all ranks, and no file means no change at all", () => {
  const data = dataset([dragonKnight()], ["all"]);
  assert.equal(effectiveBand(data, "immortal"), "all");
  assert.equal(withRankBand(data, "immortal").rankBand, "all");

  const noFile = dataset([dragonKnight()], []);
  assert.equal(withRankBand(noFile, "divine"), noFile, "the very same object, so memoised readers keep their results");
});

test("pick rate is each hero's share of the band's matches, ten heroes a match", () => {
  const mids = (games: number): Array<[number, number]> => [[0, 0], [games, games / 2], [0, 0], [0, 0], [0, 0]];
  const pool: Hero[] = Array.from({ length: 20 }, (_, i) => ({
    ...dragonKnight(),
    slug: `hero-${i}`,
    positionCounts: { all: mids(1_000), divine: mids(1_000) },
  }));
  // Popular at all ranks and rare at Divine+, the way Sniper is.
  pool[0]!.positionCounts = { all: mids(1_500), divine: mids(500) };
  const stranger: Hero = { ...dragonKnight(), slug: "stranger", positionCounts: undefined, pickRate: 12.5 };
  const data = dataset([...pool, stranger]);

  const all = withRankBand(data, "all");
  const divine = withRankBand(data, "divine");
  // 20,500 hero-games are 2,050 matches at all ranks; 19,500 are 1,950 at Divine+.
  assert.equal(all.bySlug.get("hero-0")!.pickRate, 73.17);
  assert.equal(divine.bySlug.get("hero-0")!.pickRate, 25.64);
  assert.equal(divine.bySlug.get("hero-1")!.pickRate, 51.28);
  for (const applied of [all, divine]) {
    const counted = applied.heroes.filter((h) => h.positionCounts);
    assert.ok(Math.abs(counted.reduce((n, h) => n + h.pickRate!, 0) - 1000) < 0.1);
    assert.equal(applied.bySlug.get("stranger")!.pickRate, 12.5, "not in the file, so Dotabuff's figure stays");
  }
});

test("a hero the file does not cover keeps the Dotabuff figures", () => {
  const stranger: Hero = { ...dragonKnight(), slug: "stranger", positionCounts: undefined };
  const data = dataset([dragonKnight(), stranger]);
  const applied = withRankBand(data, "all");
  assert.equal(applied.bySlug.get("stranger")!.positions![2], 0.22);
  assert.equal(applied.hasPositions, true);
});

test("the loader attaches every well-formed band and reports which it found", () => {
  const heroes: Hero[] = [dragonKnight(), { slug: "axe", name: "Axe", attr: "str", steam: "axe" }];
  for (const h of heroes) delete h.positionCounts;
  const bands = attachPositionCounts(heroes, {
    heroes: {
      "dragon-knight": { all: DK_ALL, immortal: [[1, 2]] },
      axe: { all: DK_ALL, divine: DK_DIVINE },
    },
  });
  assert.deepEqual(bands, ["all", "divine"], "immortal was malformed everywhere, so it is not offered");
  assert.deepEqual(Object.keys(heroes[0]!.positionCounts!), ["all"]);
  assert.deepEqual(Object.keys(heroes[1]!.positionCounts!), ["all", "divine"]);
  assert.deepEqual(attachPositionCounts(heroes, null), []);
});
