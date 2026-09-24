import { BASE_HEROES } from "../data/heroes";
import { buildLaneModel, fitLaneCounters } from "./lanes";
import { RANK_BANDS, readPositionCells } from "./positions";
import { estimateMatchupSpread, matchup } from "./scoring";
import { deriveTimingShape } from "./timing";
import { readCalibration } from "./winModel";
import type {
  Dataset,
  Hero,
  HeroAttr,
  HeroTiming,
  Lane,
  MatchupTable,
  Position,
  RankBand,
  SynergyRow,
  SynergyTable,
  TimingBucket,
} from "../types";

/** Shape of public/data/matchups.json, as written by scripts/scrape.mjs. */
interface RawPayload {
  generatedAt?: string;
  heroes?: Array<{
    slug: string;
    name: string;
    attr?: string;
    steam?: string;
    winRate?: number;
    pickRate?: number;
    banRate?: number;
    tier?: string;
    lanes?: Partial<Record<Lane, unknown>>;
    positions?: Record<string, number>;
    positionWinRate?: Record<string, number>;
    topPositions?: number[];
  }>;
  /** slug -> opponent slug -> [disadvantage, winRate, matches] */
  matchups?: Record<string, Record<string, [number, number, number]>>;
}

/** Shape of public/data/synergies.json, as written by scripts/synergy.mjs. */
interface RawSynergyPayload {
  generatedAt?: string;
  matches?: number;
  /**
   * slug -> teammate slug -> [synergy, matches, winRate, cells?]; stored once,
   * a < b. `cells` splits the pairing by whether each hero farmed and is only
   * written where it disagrees with the blended figure.
   */
  synergies?: Record<
    string,
    Record<string, [number, number, number] | [number, number, number, unknown]>
  >;
}

/** Shape of public/data/timings.json, as written by scripts/timings.mjs. */
interface RawTimingPayload {
  generatedAt?: string;
  matches?: number;
  buckets?: TimingBucket[];
  /** slug -> one [games, winRate, skew] tuple per bucket, in bucket order. */
  timings?: Record<string, Array<[number, number, number]>>;
}

/** Shape of public/data/positions.json, as written by scripts/positions.mjs. */
interface RawPositionPayload {
  generatedAt?: string;
  /** slug -> band -> [games, wins] per position; see `attachPositionCounts`. */
  heroes?: Record<string, Record<string, unknown>>;
}

/** Shape of public/data/lanes.json, as written by scripts/lanes.mjs. */
type RawLanePayload = Parameters<typeof buildLaneModel>[0];

const ATTRS = new Set<HeroAttr>(["str", "agi", "int", "uni"]);
const asAttr = (value: unknown): HeroAttr =>
  typeof value === "string" && ATTRS.has(value as HeroAttr) ? (value as HeroAttr) : "uni";

const asPosition = (value: unknown): Position | null => {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 5 ? (n as Position) : null;
};

/** `{ "1": 0.8, "5": 0.2 }` -> a typed, validated position map. */
function readPositionMap(raw: Record<string, number> | undefined) {
  if (!raw) return undefined;
  const out: Partial<Record<Position, number>> = {};
  let found = false;
  for (const [key, value] of Object.entries(raw)) {
    const position = asPosition(key);
    if (position === null || !Number.isFinite(value)) continue;
    out[position] = value;
    found = true;
  }
  return found ? out : undefined;
}

/** Baseline roster, used before (or instead of) a scrape. */
export function baselineHeroes(): Hero[] {
  return BASE_HEROES.map((h) => ({ ...h }));
}

export function emptyDataset(error: string | null = null): Dataset {
  const heroes = baselineHeroes();
  return {
    heroes,
    bySlug: new Map(heroes.map((h) => [h.slug, h])),
    matchups: {},
    synergies: {},
    generatedAt: null,
    matchupSpread: null,
    synergyGeneratedAt: null,
    timingGeneratedAt: null,
    hasData: false,
    hasPositions: false,
    positionBands: [],
    rankBand: null,
    positionsGeneratedAt: null,
    laneOutcomes: null,
    lanesGeneratedAt: null,
    hasSynergies: false,
    synergyMatches: 0,
    hasTimings: false,
    timingBuckets: [],
    timingShape: null,
    timingMatches: 0,
    calibration: null,
    error,
  };
}

function mergeHeroes(raw: RawPayload["heroes"]): Hero[] {
  const merged = new Map<string, Hero>(baselineHeroes().map((h) => [h.slug, h]));
  for (const entry of raw ?? []) {
    if (!entry?.slug) continue;
    const existing = merged.get(entry.slug);
    const hero: Hero = {
      slug: entry.slug,
      name: entry.name || existing?.name || entry.slug,
      // The roster's attribute comes from OpenDota; the file's is scraped off
      // Dotabuff's page layout, so it only fills in for a hero the roster lacks.
      attr: existing?.attr ?? asAttr(entry.attr),
      steam: entry.steam || existing?.steam || entry.slug.replace(/-/g, "_"),
    };
    if (typeof entry.winRate === "number") hero.winRate = entry.winRate;
    if (typeof entry.pickRate === "number") hero.pickRate = entry.pickRate;
    if (typeof entry.banRate === "number") hero.banRate = entry.banRate;
    if (entry.tier) hero.tier = entry.tier;

    const positions = readPositionMap(entry.positions);
    if (positions) {
      hero.positions = positions;
      hero.positionWinRate = readPositionMap(entry.positionWinRate);
      const top = (entry.topPositions ?? [])
        .map(asPosition)
        .filter((p): p is Position => p !== null);
      hero.topPositions = top.length
        ? top
        : (Object.keys(positions)
            .map(asPosition)
            .filter((p): p is Position => p !== null)
            .sort((a, b) => (positions[b] ?? 0) - (positions[a] ?? 0))
            .slice(0, 2));
    }
    if (entry.lanes) hero.lanes = entry.lanes as Hero["lanes"];

    merged.set(hero.slug, hero);
  }
  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function expandMatchups(raw: RawPayload["matchups"]): MatchupTable {
  const out: MatchupTable = {};
  for (const [slug, row] of Object.entries(raw ?? {})) {
    const table: MatchupTable[string] = {};
    for (const [opponent, tuple] of Object.entries(row)) {
      if (!Array.isArray(tuple) || tuple.length < 3) continue;
      const [disadvantage, winRate, matches] = tuple;
      if (!Number.isFinite(disadvantage)) continue;
      table[opponent] = { disadvantage, winRate, matches };
    }
    out[slug] = table;
  }
  return out;
}

/**
 * The collector stores each pair once, under whichever slug sorts first.
 * Synergy is symmetric, so mirror it here and every lookup becomes a plain
 * `synergies[a][b]` with no ordering to remember at the call site.
 */
export function expandSynergies(raw: RawSynergyPayload["synergies"]): SynergyTable {
  const out: SynergyTable = {};
  const put = (
    a: string,
    b: string,
    synergy: number,
    matches: number,
    winRate: number,
    cells: SynergyRow["cells"],
  ) => {
    (out[a] ??= {})[b] = cells ? { synergy, matches, winRate, cells } : { synergy, matches, winRate };
  };

  /**
   * Cells are labelled in the stored `a`-then-`b` order, so the mirrored copy
   * has to swap the two mixed ones. `cc` and `ss` say the same thing from
   * either end; `cs` — a farmed, b did not — becomes `sc` read backwards.
   */
  const mirror = (cells: SynergyRow["cells"]): SynergyRow["cells"] => {
    if (!cells) return undefined;
    const { cc, cs, sc, ss } = cells;
    const flipped: SynergyRow["cells"] = {};
    if (cc) flipped.cc = cc;
    if (sc) flipped.cs = sc;
    if (cs) flipped.sc = cs;
    if (ss) flipped.ss = ss;
    return flipped;
  };

  const readCells = (value: unknown): SynergyRow["cells"] => {
    if (!value || typeof value !== "object") return undefined;
    const cells: SynergyRow["cells"] = {};
    for (const key of ["cc", "cs", "sc", "ss"] as const) {
      const tuple = (value as Record<string, unknown>)[key];
      if (!Array.isArray(tuple) || tuple.length < 2) continue;
      const [synergy, matches] = tuple as [number, number];
      if (Number.isFinite(synergy)) cells[key] = { synergy, matches };
    }
    return Object.keys(cells).length ? cells : undefined;
  };

  for (const [slug, row] of Object.entries(raw ?? {})) {
    for (const [other, tuple] of Object.entries(row)) {
      if (!Array.isArray(tuple) || tuple.length < 3) continue;
      const [synergy, matches, winRate, rawCells] = tuple;
      if (!Number.isFinite(synergy) || slug === other) continue;
      const cells = readCells(rawCells);
      put(slug, other, synergy, matches, winRate, cells);
      put(other, slug, synergy, matches, winRate, mirror(cells));
    }
  }
  return out;
}

/**
 * Attach the timing rows to the heroes they belong to.
 *
 * Stored positionally, one tuple per bucket, so a hero the collector never saw
 * simply keeps no `timings` field and every read-out that needs one has to say
 * so rather than quietly scoring them as average.
 */
function attachTimings(heroes: Hero[], raw: RawTimingPayload | null, buckets: TimingBucket[]) {
  if (!raw?.timings || !buckets.length) return 0;
  let matched = 0;

  for (const hero of heroes) {
    const rows = raw.timings[hero.slug];
    if (!Array.isArray(rows) || rows.length !== buckets.length) continue;

    const timings: HeroTiming[] = [];
    let usable = false;
    for (const tuple of rows) {
      if (!Array.isArray(tuple) || tuple.length < 3) break;
      const [games, winRate, skew] = tuple;
      if (!Number.isFinite(games) || !Number.isFinite(skew)) break;
      if (games > 0) usable = true;
      timings.push({ games, winRate, skew });
    }
    if (!usable || timings.length !== buckets.length) continue;

    hero.timings = timings;
    matched++;
  }
  return matched;
}

/**
 * Give each hero STRATZ's per-band position counts. Returns the bands the file
 * actually carried, so the rank switch only offers what can be applied.
 */
export function attachPositionCounts(heroes: Hero[], raw: RawPositionPayload | null): RankBand[] {
  const found = new Set<RankBand>();
  if (!raw?.heroes) return [];
  for (const hero of heroes) {
    const bands = raw.heroes[hero.slug];
    if (!bands || typeof bands !== "object") continue;
    const counts: NonNullable<Hero["positionCounts"]> = {};
    for (const band of RANK_BANDS) {
      const cells = readPositionCells(bands[band]);
      if (!cells) continue;
      counts[band] = cells;
      found.add(band);
    }
    if (Object.keys(counts).length) hero.positionCounts = counts;
  }
  return RANK_BANDS.filter((band) => found.has(band));
}

/**
 * Fetch and parse one JSON file.
 *
 * A 404 is not a failure — both data files are built by scripts the user may
 * not have run yet — but a 500 is worth saying out loud, so the two are kept
 * apart rather than both reported as "missing".
 */
async function loadJson<T>(
  path: string,
  signal?: AbortSignal,
): Promise<{ data: T | null; error: string | null }> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}${path}`, { signal, cache: "no-cache" });
    if (res.status === 404) return { data: null, error: null };
    if (!res.ok) return { data: null, error: `Could not load ${path} (HTTP ${res.status}).` };
    return { data: (await res.json()) as T, error: null };
  } catch (err) {
    if ((err as Error)?.name === "AbortError") throw err;
    return { data: null, error: null };
  }
}

/**
 * Load the scraped dataset. A missing file is not an error — the app still
 * works as a plain draft board, it just cannot recommend anything yet.
 *
 * Synergies live in their own file because they come from a different source
 * (OpenDota rather than Dotabuff) and are collected separately; the picker
 * degrades to pure counter-picking when that file is absent.
 */
export async function loadDataset(signal?: AbortSignal): Promise<Dataset> {
  const [matchupFile, synergyFile, timingFile, positionFile, laneFile, calibrationFile] =
    await Promise.all([
      loadJson<RawPayload>("data/matchups.json", signal),
      loadJson<RawSynergyPayload>("data/synergies.json", signal),
      loadJson<RawTimingPayload>("data/timings.json", signal),
      loadJson<RawPositionPayload>("data/positions.json", signal),
      loadJson<RawLanePayload>("data/lanes.json", signal),
      loadJson<unknown>("data/calibration.json", signal),
    ]);
  return buildDataset({ matchupFile, synergyFile, timingFile, positionFile, laneFile, calibrationFile });
}

/** What `loadDataset` fetched, or what a test or a script read off disk. */
export interface DataFiles {
  matchupFile: { data: RawPayload | null; error?: string | null };
  synergyFile: { data: RawSynergyPayload | null };
  timingFile: { data: RawTimingPayload | null };
  positionFile: { data: RawPositionPayload | null };
  laneFile: { data: RawLanePayload | null };
  /** The win-chance model's weights. Optional: without it the analysis falls back to the comparison signal. */
  calibrationFile?: { data: unknown };
}

/**
 * The five files into one dataset, fitting the models that are fitted once per
 * load. Separate from `loadDataset` because everything above this line is
 * `fetch`, which a Node script or a test has no use for.
 */
export function buildDataset({
  matchupFile,
  synergyFile,
  timingFile,
  positionFile,
  laneFile,
  calibrationFile,
}: DataFiles): Dataset {
  const positionPayload = positionFile.data;
  const calibration = readCalibration(calibrationFile?.data ?? null);
  const laneOutcomes = buildLaneModel(laneFile.data);
  const lanesGeneratedAt = laneOutcomes?.generatedAt ?? null;

  const payload = matchupFile.data;
  const synergyPayload = synergyFile.data;
  const synergies = expandSynergies(synergyPayload?.synergies);
  const hasSynergies = Object.keys(synergies).length > 0;
  const synergyMatches = synergyPayload?.matches ?? 0;

  const timingPayload = timingFile.data;
  const timingBuckets = Array.isArray(timingPayload?.buckets) ? timingPayload.buckets : [];
  const timingMatches = timingPayload?.matches ?? 0;

  if (!payload) {
    const empty = emptyDataset(matchupFile.error ?? null);
    const matched = attachTimings(empty.heroes, timingPayload, timingBuckets);
    const positionBands = attachPositionCounts(empty.heroes, positionPayload);
    return {
      ...empty,
      calibration,
      positionBands,
      positionsGeneratedAt: positionBands.length ? (positionPayload?.generatedAt ?? null) : null,
      laneOutcomes,
      laneCounters: null,
      lanesGeneratedAt,
      synergies,
      hasSynergies,
      synergyMatches,
      synergyGeneratedAt: synergyPayload?.generatedAt ?? null,
      timingGeneratedAt: timingPayload?.generatedAt ?? null,
      hasTimings: matched > 0,
      timingBuckets: matched > 0 ? timingBuckets : [],
      timingShape: matched > 0 ? deriveTimingShape(empty.heroes, timingBuckets.length) : null,
      timingMatches,
    };
  }

  const heroes = mergeHeroes(payload.heroes);
  const matchups = expandMatchups(payload.matchups);
  const hasData = Object.keys(matchups).length > 0;
  const matchupSpread = estimateMatchupSpread(matchups);
  // Fitted here rather than in `buildLaneModel` because it needs the matchup
  // table: what it measures is defined as whatever the lane rows say *beyond*
  // the figure the score already adds, damped exactly as the score damps it.
  const laneCounters = laneOutcomes
    ? fitLaneCounters(
        laneOutcomes,
        (a, b) => matchup({ matchups, matchupSpread }, a, b)?.advantage ?? null,
      )
    : null;
  const timed = attachTimings(heroes, timingPayload, timingBuckets);
  const positionBands = attachPositionCounts(heroes, positionPayload);

  return {
    heroes,
    bySlug: new Map(heroes.map((h) => [h.slug, h])),
    matchups,
    synergies,
    generatedAt: payload.generatedAt ?? null,
    // One pass over the table at load, so every later matchup() read can damp
    // its figure by sample size without recomputing the prior.
    matchupSpread,
    synergyGeneratedAt: synergyPayload?.generatedAt ?? null,
    timingGeneratedAt: timingPayload?.generatedAt ?? null,
    hasData,
    hasPositions: heroes.some((h) => h.positions),
    // The counts are attached, not applied: `withRankBand` puts a band in place.
    positionBands,
    rankBand: null,
    positionsGeneratedAt: positionBands.length ? (positionPayload?.generatedAt ?? null) : null,
    laneOutcomes,
    laneCounters,
    lanesGeneratedAt,
    hasSynergies,
    synergyMatches,
    hasTimings: timed > 0,
    timingBuckets: timed > 0 ? timingBuckets : [],
    // Derived once at load: the duration distribution and the pool's average
    // early-game cover are properties of the whole table, and recomputing them
    // per candidate would mean 127 passes over it for every keystroke.
    timingShape: timed > 0 ? deriveTimingShape(heroes, timingBuckets.length) : null,
    timingMatches,
    calibration,
    error: hasData ? null : "Matchup file loaded but contained no rows.",
  };
}

/** Local portrait first (written by `npm run images`). */
export const localPortrait = (hero: Hero) =>
  `${import.meta.env.BASE_URL}heroes/${hero.slug}.png`;

/** Steam CDN fallback, works without any scraping. */
export const cdnPortrait = (hero: Hero) =>
  `https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/heroes/${hero.steam}.png`;
