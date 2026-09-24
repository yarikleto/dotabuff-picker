# Win Chance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Draft analysis headline — a lane-weighted mean of matchups plus synergy and early cover, blind to roles and hero strength — with a win chance from a logistic model whose weights are fitted on real ranked games by a new `npm run calibrate` refresh step.

**Architecture:** `src/lib/winModel.ts` is the one place the model lives: features read off a board, the calibration file's shape, the chance, its Shapley parts, the verdict and the roles read. `scripts/calibrate-math.mjs` is pure fitting maths (IRLS, held-out τ selection, reliability, guardrails); `scripts/calibrate.mjs` fetches OpenDota games older than the synergy/timing samples, runs `winModel.ts` over them through the TypeScript loader, fits, and writes `public/data/calibration.json`. The app loads that file beside the others; the analysis, the hero card preview and the Rebalance objective read the chance when it is present and fall back to today's arithmetic when it is not.

**Tech Stack:** TypeScript + React 18 + Vite (the site), Node 22 ESM scripts, `node --test` with type stripping and `scripts/register-ts-resolve.mjs` for `src/lib/*.test.ts`, OpenDota explorer SQL.

**Spec:** [`docs/superpowers/specs/2026-09-23-win-chance-design.md`](../specs/2026-09-23-win-chance-design.md)

## Global Constraints

- Features, all mine minus theirs: `matchups`, `cohesion`, `heroes`, `seatPenalty`, `seatBonus`, `roleDeficit`, `timing` — defined exactly as in the spec's feature table.
- `WIN_MODEL_FLOORS = { minMatches: 200, minSynergyMatches: 200 }`; the Tuning sliders never move the win chance.
- `roleDeficit` per side is `min(0, S / 5 + τ)²` with `S` the side's summed seat deltas; its weight is never positive.
- Verdict by distance `d` of the chance from 50 points: `d < 5` coin flip, `5 ≤ d < 10` slight edge, `10 ≤ d < 17` favoured, `17 ≤ d < 25` well ahead, `d ≥ 25` run over / dominant — the same labels `verdictFor` uses.
- The chance prints as a whole percent; outside `calibration.range` it prints `under 15%` / `over 85%` (whatever the range is) with the model's own figure beside it.
- Calibration games: ranked All Pick (`lobby_type 7`, `game_mode 22`), match ids strictly below the lower bound of both `synergies.json`'s and `timings.json`'s `matchIdRange`; default 300,000; τ from `[0.5, 1, 1.5, 2, 2.5, 3]` by two-fold held-out log-loss, folds by match id parity.
- Guardrails (write nothing, exit non-zero): fewer than 100,000 games; held-out log-loss not at least 0.005 below the side term alone; a reliability bin of ≥ 1,000 team-games off by more than 3 points; `matchups`, `cohesion`, `heroes`, `seatPenalty` or `seatBonus` not positive; no calibrated range.
- Rebalance with a calibration: ranked on the chance, qualifies at `CHANCE_GAIN = 1` point, a seat fix may cost up to `MAX_SEAT_COST = 2` points; the lane read stays a reason, not a term.
- Out of scope: the pick and ban rankings, the Tuning sliders, the early-game penalty inside the pick score.
- From AGENTS.md: data changes go through `npm run refresh` and nothing else; push only when the user asks; a new data file gets a NOTICE.md row before it is committed; README blocks are written by `npm run readme`, never by hand.
- `src/` imports are extensionless; test files import with `.ts`. Node strips types rather than compiling them, so no `enum`, `namespace` or parameter properties. `tsconfig` is strict with `noUncheckedIndexedAccess`, `noUnusedLocals` and `noUnusedParameters`.
- This checkout is Windows with `core.autocrlf=true`: `scripts/roster.test.mjs` can fail on CRLF and, because `npm test` chains its halves with `&&`, hide every `src/lib` test. Run the halves separately (commands in Task 13).
- UI copy is English, and heroes are "they/them".

## Test commands

```bash
# one TypeScript test file
node --test --experimental-strip-types --no-warnings --import ./scripts/register-ts-resolve.mjs src/lib/winModel.test.ts
# one script test file
node --test scripts/calibrate-math.test.mjs
```

## File map

| File | Responsibility |
| --- | --- |
| `src/lib/winModel.ts` (new) | Features, calibration shape and validation, chance, Shapley parts, verdict, display, roles read |
| `src/lib/winModel.test.ts` (new) | Its tests |
| `scripts/calibrate-math.mjs` (new) | Pure fitting maths and guardrails |
| `scripts/calibrate-math.test.mjs` (new) | Its tests, on simulated games |
| `scripts/calibrate.mjs` (new) | OpenDota fetch, cache, features via `winModel.ts`, fit, write, report |
| `scripts/refresh.mjs` | `calibrate` step with loader flags |
| `package.json` | `calibrate` script |
| `scripts/readme-status.mjs`, `scripts/readme.mjs`, `scripts/readme-sync.test.mjs`, `scripts/readme-status.test.mjs` | Win model row in the README data table |
| `NOTICE.md` | `calibration.json` on the OpenDota row |
| `public/data/calibration.json` (generated) | The fitted weights |
| `src/types.ts` | `Dataset.calibration`, `DraftImpact.unit` |
| `src/lib/dataset.ts`, `src/lib/dataset.test.ts` | Load and validate the file |
| `src/lib/analysis.ts`, `src/lib/analysis.test.ts` | `DraftAnalysis.win`, reasons, copy briefing, talking points, pick preview |
| `src/lib/draftInsights.ts`, `src/lib/draftInsights.test.ts` | Roles headline and playbook item |
| `src/components/DraftBriefing.tsx`, `src/components/DraftAnalysis.tsx`, `src/App.tsx`, `src/components/HeroCard.tsx`, `src/styles.css` | The interface |
| `src/lib/rebalance.ts`, `src/lib/rebalanceCopy.ts`, `src/components/Rebalance.tsx`, `src/lib/rebalance.test.ts` | Rebalance on the chance |
| `docs/scoring.md`, `docs/ui.md`, `README.md`, `docs/refreshing-data.md`, `.claude/skills/refresh-data/SKILL.md`, `AGENTS.md` | Documentation |

---

### Task 0: Branch and baseline

**Files:**
- Commit: `docs/superpowers/specs/2026-09-23-win-chance-design.md`, `docs/superpowers/plans/2026-09-23-win-chance.md`
- Possibly commit (user's call): `public/data/synergies.json`, `public/data/timings.json`, `README.md`

**Interfaces:** none.

- [ ] **Step 1: Branch off main**

```bash
git switch -c win-chance
git status --short
```

Expected: `M README.md`, `M public/data/synergies.json`, `M public/data/timings.json` (the user's `npm run refresh` of 2026-09-23, where `counters`, `positions` and `lanes` failed on Windows) and `?? docs/superpowers/`.

- [ ] **Step 2: Ask the user about the refreshed data**

The calibration records the `generatedAt` of the data files it was fitted against, so it has to be fitted against the files that will be committed. Ask the user whether to commit their refreshed synergies and timings. If yes:

```bash
node --test scripts/readme-sync.test.mjs
git add public/data/synergies.json public/data/timings.json README.md
git commit -m "Refresh synergies and timings"
```

Expected: the sync test passes (`# pass 1`). If the user says no, run `git stash push public/data/synergies.json public/data/timings.json README.md` so every later step works from the committed files, and tell the user the stash exists.

- [ ] **Step 3: Commit the design and this plan**

```bash
git add docs/superpowers
git commit -m "Add the win-chance design and plan"
```

---

### Task 1: The model's features

**Files:**
- Create: `src/lib/winModel.ts`
- Create: `src/lib/winModel.test.ts`
- Modify: `src/types.ts` (import at the top, `Dataset`)

**Interfaces:**
- Consumes: `matchup`, `synergy`, `DraftView` from `./scoring`; `positionWinRate` from `./roles`; `earlyCoverPenalty`, `teamCover` from `./timing`.
- Produces:
  - `WIN_FEATURES` (readonly tuple) and `type WinFeature`
  - `WIN_MODEL_FLOORS = { minMatches: 200, minSynergyMatches: 200 }`
  - `type Board = Pick<DraftView, "mine" | "enemy">`
  - `interface DraftFeatures { matchups; cohesion; heroes; seatPenalty; seatBonus; timing: number; seatTotal: { mine: number; theirs: number } }`
  - `draftFeatures(data: Dataset, board: Board): DraftFeatures`
  - `roleDeficit(seatTotal: number, tau: number): number`
  - `winFeatures(features: DraftFeatures, tau: number): Record<WinFeature, number>`
  - `CALIBRATION_INPUTS`, `type CalibrationInput`, `interface Calibration`, `readCalibration(raw: unknown): Calibration | null`
  - `calibrationDrift(data: Dataset): CalibrationInput[]`
  - `Dataset.calibration?: Calibration | null` in `src/types.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/winModel.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import {
  WIN_FEATURES,
  WIN_MODEL_FLOORS,
  calibrationDrift,
  draftFeatures,
  readCalibration,
  roleDeficit,
  winFeatures,
} from "./winModel.ts";
import type { Calibration } from "./winModel.ts";
import type { Dataset, DraftPick, Hero, MatchupTable, Position, SynergyTable } from "../types.ts";

// Run with: node --test --experimental-strip-types --import ./scripts/register-ts-resolve.mjs src/lib/winModel.test.ts

const SEATS: Position[] = [1, 2, 3, 4, 5];

/**
 * A hero who plays `main` in 90% of their games and every other seat in 2.5%,
 * winning `winRate` in their own seat and `offBy` points less anywhere else.
 */
function hero(slug: string, winRate: number, main: Position, offBy = 8): Hero {
  return {
    slug,
    name: slug.toUpperCase(),
    attr: "uni",
    steam: slug,
    winRate,
    positions: Object.fromEntries(SEATS.map((p) => [p, p === main ? 0.9 : 0.025])),
    positionWinRate: Object.fromEntries(SEATS.map((p) => [p, p === main ? winRate : winRate - offBy])),
  };
}

const pick = (slug: string, position: Position | null): DraftPick => ({ slug, position });
const seated = (heroes: Hero[]): DraftPick[] => heroes.map((h, i) => pick(h.slug, SEATS[i]!));
/** A matchup row from the page hero's side, `advantage` points in their favour. */
const row = (advantage: number, matches = 5_000) => ({
  disadvantage: -advantage,
  winRate: 50 + advantage,
  matches,
});
const pair = (synergy: number, matches = 5_000) => ({ synergy, matches, winRate: 50 + synergy });

function dataset(heroes: Hero[], matchups: MatchupTable = {}, synergies: SynergyTable = {}): Dataset {
  return {
    heroes,
    bySlug: new Map(heroes.map((h) => [h.slug, h])),
    matchups,
    synergies,
    generatedAt: "2026-09-19T00:00:00.000Z",
    hasData: true,
    hasPositions: true,
    hasSynergies: Object.keys(synergies).length > 0,
    synergyMatches: 0,
    hasTimings: false,
    timingBuckets: [],
    timingShape: null,
    timingMatches: 0,
    error: null,
  };
}

/** Five heroes who all play position 1, a sound line-up, and a sound enemy. */
const CARRIES = ["c1", "c2", "c3", "c4", "c5"].map((slug) => hero(slug, 52, 1));
const SOUND = SEATS.map((p) => hero(`s${p}`, 50, p));
const ENEMY = SEATS.map((p) => hero(`e${p}`, 50, p));

const CALIBRATION: Calibration = {
  generatedAt: "2026-09-23T00:00:00.000Z",
  matches: 300_000,
  matchIdRange: [9_000_000_000, 9_009_000_000],
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
  inputs: { matchups: "2026-09-19T00:00:00.000Z" },
  holdout: { logLoss: 0.672, baseline: 0.691, auc: 0.61 },
  reliability: [
    [0.35, 0.4, 74_115, 0.377, 0.378],
    [0.4, 0.45, 117_615, 0.426, 0.427],
    [0.45, 0.5, 146_917, 0.475, 0.477],
    [0.5, 0.55, 146_917, 0.525, 0.523],
  ],
};

test("matchups add up over every pairing, read under the model's own sample floor", () => {
  const data = dataset([...SOUND, ...ENEMY], {
    s1: { e1: row(2), e2: row(-1) },
    s2: { e1: row(3, WIN_MODEL_FLOORS.minMatches - 1) },
  });
  const f = draftFeatures(data, {
    mine: [pick("s1", 1), pick("s2", 2)],
    enemy: [pick("e1", 1), pick("e2", 2)],
  });
  assert.equal(f.matchups, 1, "s1 is +2 into e1 and −1 into e2; s2's thin row is left out");
});

test("swapping the line-ups negates every feature", () => {
  const data = dataset(
    [...SOUND, ...CARRIES],
    { s1: { c1: row(2) }, c3: { s4: row(-1.5) } },
    {
      s1: { s2: pair(1.2) },
      s2: { s1: pair(1.2) },
      c1: { c2: pair(-0.4) },
      c2: { c1: pair(-0.4) },
    },
  );
  const a = winFeatures(draftFeatures(data, { mine: seated(SOUND), enemy: seated(CARRIES) }), 1.5);
  const b = winFeatures(draftFeatures(data, { mine: seated(CARRIES), enemy: seated(SOUND) }), 1.5);
  for (const key of WIN_FEATURES) {
    assert.ok(Math.abs(a[key] + b[key]) < 1e-12, `${key}: ${a[key]} against ${b[key]}`);
  }
});

test("strength counts once per hero and an off-role seat counts as a penalty", () => {
  const data = dataset([...SOUND, ...CARRIES]);
  const f = draftFeatures(data, { mine: seated(CARRIES), enemy: seated(SOUND) });
  assert.equal(f.heroes, 10, "five 52% heroes against five 50% heroes");
  assert.equal(f.seatPenalty, -32, "four carries out of position 1, eight points each");
  assert.equal(f.seatBonus, 0);
  assert.deepEqual(f.seatTotal, { mine: -32, theirs: 0 });
});

test("a hero with no seat booked counts for strength and not for a seat", () => {
  const f = draftFeatures(dataset([hero("x", 54, 1)]), { mine: [pick("x", null)], enemy: [] });
  assert.equal(f.heroes, 4);
  assert.equal(f.seatPenalty, 0);
  assert.equal(f.seatBonus, 0);
});

test("an empty board measures nothing", () => {
  const f = draftFeatures(dataset(SOUND), { mine: [], enemy: [] });
  assert.deepEqual(f, {
    matchups: 0,
    cohesion: 0,
    heroes: 0,
    seatPenalty: 0,
    seatBonus: 0,
    timing: 0,
    seatTotal: { mine: 0, theirs: 0 },
  });
});

test("the role deficit is silent inside τ and convex beyond it", () => {
  assert.equal(roleDeficit(0, 1.5), 0);
  assert.equal(roleDeficit(-7, 1.5), 0, "−1.4 a hero is inside the threshold");
  assert.ok(Math.abs(roleDeficit(-10, 1.5) - 0.25) < 1e-12, "−2 a hero is half a point past it");
  assert.ok(Math.abs(roleDeficit(-32, 1.5) - 4.9 ** 2) < 1e-12, "−6.4 a hero is 4.9 past it");
  assert.equal(roleDeficit(12, 1.5), 0, "bonuses never make a deficit");
});

test("a calibration file reads back whole, or not at all", () => {
  assert.deepEqual(readCalibration(JSON.parse(JSON.stringify(CALIBRATION))), CALIBRATION);
  const without = JSON.parse(JSON.stringify(CALIBRATION));
  delete without.weights.roleDeficit;
  assert.equal(readCalibration(without), null, "a missing weight was fitted for a different model");
  assert.equal(readCalibration({ ...CALIBRATION, range: [0.6, 0.4] }), null, "a range the wrong way round");
  assert.equal(readCalibration({ ...CALIBRATION, tau: -1 }), null);
  assert.equal(readCalibration({ ...CALIBRATION, matches: 0 }), null);
  assert.equal(readCalibration("calibration"), null);
  assert.equal(readCalibration(null), null);
});

test("drift names the data files that changed since the fit", () => {
  const data = { ...dataset(SOUND), calibration: CALIBRATION };
  assert.deepEqual(calibrationDrift(data), [], "matchups is the only input it recorded, and it matches");
  assert.deepEqual(calibrationDrift({ ...data, generatedAt: "2026-09-25T00:00:00.000Z" }), ["matchups"]);
  assert.deepEqual(calibrationDrift(dataset(SOUND)), [], "no calibration, nothing to drift from");
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `node --test --experimental-strip-types --no-warnings --import ./scripts/register-ts-resolve.mjs src/lib/winModel.test.ts`
Expected: FAIL — `Cannot find module …/src/lib/winModel.ts`.

- [ ] **Step 3: Add the calibration to the dataset type**

In `src/types.ts`, replace the first line:

```ts
import type { CounterModel, LaneModel } from "./lib/lanes";
```

with:

```ts
import type { CounterModel, LaneModel } from "./lib/lanes";
import type { Calibration } from "./lib/winModel";
```

and in `interface Dataset`, replace:

```ts
  /** How many matches the timing numbers were built from. */
  timingMatches: number;
  /** Populated when the dataset failed to load. */
  error: string | null;
}
```

with:

```ts
  /** How many matches the timing numbers were built from. */
  timingMatches: number;
  /**
   * The win-chance model's weights, from public/data/calibration.json — see
   * `readCalibration`. Null or absent without the file, and the analysis then
   * falls back to the comparison signal.
   */
  calibration?: Calibration | null;
  /** Populated when the dataset failed to load. */
  error: string | null;
}
```

- [ ] **Step 4: Write the features half of `winModel.ts`**

Create `src/lib/winModel.ts`:

```ts
import { matchup, synergy } from "./scoring";
import type { DraftView } from "./scoring";
import { positionWinRate } from "./roles";
import { earlyCoverPenalty, teamCover } from "./timing";
import type { Dataset, DraftPick } from "../types";

/**
 * The draft on the board as a chance of winning.
 *
 * The one place the model is written down. The app reads it for the Draft
 * analysis headline, the hero card's preview and the Rebalance search, and
 * `scripts/calibrate.mjs` fits its weights by running this same code over real
 * ranked games — so the figure a draft is shown and the figure its weights were
 * fitted against cannot drift apart. See docs/scoring.md, "Win chance".
 */

/** The features the model weighs, in the order `calibration.json` lists them. */
export const WIN_FEATURES = [
  "matchups",
  "cohesion",
  "heroes",
  "seatPenalty",
  "seatBonus",
  "roleDeficit",
  "timing",
] as const;
export type WinFeature = (typeof WIN_FEATURES)[number];

/**
 * Sample floors the features are read under.
 *
 * Fixed here rather than taken from the Tuning sliders: the weights were fitted
 * under these floors, and a chance computed under others would no longer be the
 * calibrated one. The sliders go on tuning the pick list.
 */
export const WIN_MODEL_FLOORS = { minMatches: 200, minSynergyMatches: 200 } as const;

const TEAM_SIZE = 5;

/** The two line-ups, and nothing else a win chance needs. */
export type Board = Pick<DraftView, "mine" | "enemy">;

/**
 * One board, measured. Every figure is mine minus theirs, so swapping the two
 * line-ups negates all of them; `seatTotal` keeps each side's summed seat delta
 * apart because the role deficit is convex in it and has to be taken per side
 * before it is differenced.
 */
export interface DraftFeatures {
  /** Σ of every cross pairing's damped advantage, in points. */
  matchups: number;
  /** My pairs' synergy minus theirs, in points. */
  cohesion: number;
  /** Σ (win rate − 50) over my heroes, minus theirs. */
  heroes: number;
  /** Σ of the seats booked below a hero's own record, mine minus theirs. */
  seatPenalty: number;
  /** Σ of the seats booked above it, mine minus theirs. */
  seatBonus: number;
  /** Their early-cover shortfall minus mine, at unit weight. */
  timing: number;
  seatTotal: { mine: number; theirs: number };
}

interface SideRead {
  heroes: number;
  penalty: number;
  bonus: number;
}

/**
 * A side's strength and seats.
 *
 * A hero with no win rate adds nothing — unknown is not average — and a hero
 * with no seat booked counts for their strength but not for a seat.
 */
function readSide(data: Dataset, picks: DraftPick[]): SideRead {
  let heroes = 0;
  let penalty = 0;
  let bonus = 0;
  for (const pick of picks) {
    const hero = data.bySlug.get(pick.slug);
    if (!hero || hero.winRate === undefined) continue;
    heroes += hero.winRate - 50;
    if (!pick.position) continue;
    const delta = positionWinRate(hero, pick.position) - hero.winRate;
    if (delta < 0) penalty += delta;
    else bonus += delta;
  }
  return { heroes, penalty, bonus };
}

/** Σ of a side's pair synergies, read with the positions as booked. */
function sideCohesion(data: Dataset, picks: DraftPick[]): number {
  let total = 0;
  for (let i = 0; i < picks.length; i++) {
    for (let j = i + 1; j < picks.length; j++) {
      const a = picks[i]!;
      const b = picks[j]!;
      const s = synergy(data, a.slug, b.slug, a.position, b.position, WIN_MODEL_FLOORS.minSynergyMatches);
      if (s && s.matches >= WIN_MODEL_FLOORS.minSynergyMatches) total += s.synergy;
    }
  }
  return total;
}

/** Everything the model reads off a board. */
export function draftFeatures(data: Dataset, board: Board): DraftFeatures {
  let matchups = 0;
  for (const a of board.mine) {
    for (const b of board.enemy) {
      const m = matchup(data, a.slug, b.slug);
      if (m && m.matches >= WIN_MODEL_FLOORS.minMatches) matchups += m.advantage;
    }
  }
  const mine = readSide(data, board.mine);
  const theirs = readSide(data, board.enemy);
  const cover = (picks: DraftPick[]) =>
    teamCover(picks.map((p) => data.bySlug.get(p.slug)), data.timingShape);

  return {
    matchups,
    cohesion: sideCohesion(data, board.mine) - sideCohesion(data, board.enemy),
    heroes: mine.heroes - theirs.heroes,
    seatPenalty: mine.penalty - theirs.penalty,
    seatBonus: mine.bonus - theirs.bonus,
    timing: earlyCoverPenalty(cover(board.enemy), 1) - earlyCoverPenalty(cover(board.mine), 1),
    seatTotal: { mine: mine.penalty + mine.bonus, theirs: theirs.penalty + theirs.bonus },
  };
}

/**
 * What a side's seats cost it beyond the seats themselves.
 *
 * Zero until the side's mean seat delta passes `−tau`, then the square of the
 * excess. Divided by five whatever is on the board, so an undrafted hero counts
 * as seated where they belong. Bonuses never create a deficit.
 */
export const roleDeficit = (seatTotal: number, tau: number): number =>
  Math.min(0, seatTotal / TEAM_SIZE + tau) ** 2;

/** The model's inputs for one board at one threshold. */
export function winFeatures(features: DraftFeatures, tau: number): Record<WinFeature, number> {
  return {
    matchups: features.matchups,
    cohesion: features.cohesion,
    heroes: features.heroes,
    seatPenalty: features.seatPenalty,
    seatBonus: features.seatBonus,
    roleDeficit:
      roleDeficit(features.seatTotal.mine, tau) - roleDeficit(features.seatTotal.theirs, tau),
    timing: features.timing,
  };
}

// --------------------------------------------------------------- calibration

/** The data files the features are read from, whose dates a calibration records. */
export const CALIBRATION_INPUTS = ["matchups", "positions", "synergies", "timings"] as const;
export type CalibrationInput = (typeof CALIBRATION_INPUTS)[number];

/** `public/data/calibration.json`, validated. */
export interface Calibration {
  generatedAt: string | null;
  /** Games the weights were fitted on. */
  matches: number;
  matchIdRange: [number, number] | null;
  /** The role-deficit threshold, in points per hero. */
  tau: number;
  /** Log-odds per unit of each feature. */
  weights: Record<WinFeature, number>;
  /** The span of chances the reliability table can vouch for. */
  range: [number, number];
  /** `generatedAt` of each data file the features were read from. */
  inputs: Partial<Record<CalibrationInput, string>>;
  holdout: { logLoss: number; baseline: number; auc: number } | null;
  /** `[from, to, team-games, mean predicted, actual]`, out of fold and read from both seats. */
  reliability: Array<[number, number, number, number, number]>;
}

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/**
 * The file, or null when it is anything short of usable.
 *
 * Every feature needs a weight: a calibration missing one was fitted for a
 * different model, and filling the gap with zero would be inventing a fit.
 */
export function readCalibration(raw: unknown): Calibration | null {
  if (!raw || typeof raw !== "object") return null;
  const file = raw as Record<string, unknown>;

  const rawWeights = file.weights;
  if (!rawWeights || typeof rawWeights !== "object") return null;
  const weights = {} as Record<WinFeature, number>;
  for (const key of WIN_FEATURES) {
    const value = (rawWeights as Record<string, unknown>)[key];
    if (!finite(value)) return null;
    weights[key] = value;
  }

  const { tau, matches, range } = file;
  if (!finite(tau) || tau < 0) return null;
  if (!finite(matches) || matches <= 0) return null;
  if (!Array.isArray(range) || range.length !== 2) return null;
  const [low, high] = range as unknown[];
  if (!finite(low) || !finite(high)) return null;
  if (!(low > 0 && low < 0.5 && high > 0.5 && high < 1)) return null;

  const inputs: Calibration["inputs"] = {};
  if (file.inputs && typeof file.inputs === "object") {
    for (const key of CALIBRATION_INPUTS) {
      const value = (file.inputs as Record<string, unknown>)[key];
      if (typeof value === "string") inputs[key] = value;
    }
  }

  const reliability = Array.isArray(file.reliability)
    ? file.reliability.filter(
        (row): row is [number, number, number, number, number] =>
          Array.isArray(row) && row.length === 5 && row.every(finite),
      )
    : [];

  const h = file.holdout as Record<string, unknown> | null | undefined;
  const holdout =
    h && finite(h.logLoss) && finite(h.baseline) && finite(h.auc)
      ? { logLoss: h.logLoss, baseline: h.baseline, auc: h.auc }
      : null;

  const ids = file.matchIdRange;
  const matchIdRange: [number, number] | null =
    Array.isArray(ids) && ids.length === 2 && finite(ids[0]) && finite(ids[1])
      ? [ids[0], ids[1]]
      : null;

  return {
    generatedAt: typeof file.generatedAt === "string" ? file.generatedAt : null,
    matches,
    matchIdRange,
    tau,
    weights,
    range: [low, high],
    inputs,
    holdout,
    reliability,
  };
}

/**
 * Data files loaded now that differ from the ones the weights were fitted on.
 *
 * Not a reason to hide the chance — a refresh that re-collects synergies moves
 * the weights a little, not wholesale — but a reason to say so.
 */
export function calibrationDrift(data: Dataset): CalibrationInput[] {
  const calibration = data.calibration;
  if (!calibration) return [];
  const loaded: Record<CalibrationInput, string | null | undefined> = {
    matchups: data.generatedAt,
    positions: data.positionsGeneratedAt,
    synergies: data.synergyGeneratedAt,
    timings: data.timingGeneratedAt,
  };
  return CALIBRATION_INPUTS.filter((key) => {
    const fitted = calibration.inputs[key];
    return fitted !== undefined && fitted !== (loaded[key] ?? null);
  });
}
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `node --test --experimental-strip-types --no-warnings --import ./scripts/register-ts-resolve.mjs src/lib/winModel.test.ts`
Expected: PASS, `# pass 8`, `# fail 0`.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: exits 0 with no output.

- [ ] **Step 7: Commit**

```bash
git add src/lib/winModel.ts src/lib/winModel.test.ts src/types.ts
git commit -m "Read a board into the win-chance model's features"
```

---

### Task 2: The chance, its parts, the verdict and the roles

**Files:**
- Modify: `src/lib/winModel.ts` (imports; append the read)
- Modify: `src/lib/winModel.test.ts` (imports; append tests)

**Interfaces:**
- Consumes: everything Task 1 produced; `positionFit` from `./roles`.
- Produces:
  - `WIN_GROUPS = ["roles", "matchups", "cohesion", "heroes", "timing"]`, `type WinGroup`, `GROUP_LABEL: Record<WinGroup, string>`
  - `sigmoid(z: number): number`, `shapley(values: number[]): number[]`
  - `interface WinVerdict { label: string; side: "mine" | "enemy" | "even"; strength: number }`, `verdictForChance(chance: number): WinVerdict`
  - `showChance(chance: number, range: readonly [number, number]): { shown: string; short: string; inRange: boolean }`
  - `interface WinPart { group: WinGroup; label: string; points: number }`, `interface WinEvidence { from; to; games; actual: number }`
  - `interface SeatReport { slug; name; position: Position | null; share: number | null; seatWinRate: number | null; winRate: number | null; delta: number }`, `interface SideRoles { seats; total; offRole: SeatReport[]; noSupports: boolean; noCores: boolean }`, `interface RolesRead { mine: SideRoles; theirs: SideRoles }`
  - `ROLE_REASON_SHARE = 0.05`, `rolesRead(data, board): RolesRead`, `rolesReason(roles: RolesRead): string | null`
  - `interface WinRead { chance; logOdds; shown; short; inRange; verdict: WinVerdict; parts: WinPart[]; roles: RolesRead; evidence: WinEvidence | null; matches: number }`
  - `winRead(data: Dataset, board: Board, calibration: Calibration): WinRead`

- [ ] **Step 1: Write the failing tests**

In `src/lib/winModel.test.ts`, replace the import block:

```ts
import {
  WIN_FEATURES,
  WIN_MODEL_FLOORS,
  calibrationDrift,
  draftFeatures,
  readCalibration,
  roleDeficit,
  winFeatures,
} from "./winModel.ts";
```

with:

```ts
import {
  GROUP_LABEL,
  WIN_FEATURES,
  WIN_MODEL_FLOORS,
  calibrationDrift,
  draftFeatures,
  readCalibration,
  roleDeficit,
  rolesReason,
  shapley,
  showChance,
  sigmoid,
  verdictForChance,
  winFeatures,
  winRead,
} from "./winModel.ts";
```

Append to the end of the file:

```ts
// ------------------------------------------------------------------ the read

test("Shapley parts add up to the chance exactly, and a silent group gets nothing", () => {
  const parts = shapley([-1.8, -0.7, 0, 0.2, 0.05]);
  const total = parts.reduce((sum, p) => sum + p, 0);
  assert.ok(Math.abs(total - (100 * sigmoid(-2.25) - 50)) < 1e-9);
  assert.equal(parts[2], 0);
  const even = shapley([0.4, 0.4]);
  assert.ok(Math.abs(even[0]! - even[1]!) < 1e-12, "equal inputs, equal shares");
});

test("the verdict reads the distance from even", () => {
  assert.equal(verdictForChance(0.5).label, "Coin flip");
  assert.equal(verdictForChance(0.53).label, "Coin flip");
  assert.equal(verdictForChance(0.57).label, "Slight edge to you");
  assert.equal(verdictForChance(0.38).label, "They are favoured");
  assert.equal(verdictForChance(0.38).side, "enemy");
  assert.equal(verdictForChance(0.3).label, "They are well ahead");
  assert.equal(verdictForChance(0.2).label, "You are being run over");
  assert.equal(verdictForChance(0.8).label, "Dominant draft");
});

test("outside the calibrated range the headline gives a bound, not a figure", () => {
  assert.deepEqual(showChance(0.384, [0.15, 0.85]), { shown: "38%", short: "38%", inRange: true });
  assert.deepEqual(showChance(0.064, [0.15, 0.85]), { shown: "under 15%", short: "<15%", inRange: false });
  assert.deepEqual(showChance(0.9, [0.15, 0.85]), { shown: "over 85%", short: ">85%", inRange: false });
});

test("an empty board is an even game with nothing to explain", () => {
  const win = winRead(dataset(SOUND), { mine: [], enemy: [] }, CALIBRATION);
  assert.equal(win.chance, 0.5);
  assert.ok(win.parts.every((p) => p.points === 0));
  assert.equal(win.verdict.label, "Coin flip");
});

test("five cores against a sound five is run over, and the roles say why", () => {
  const data = dataset([...SOUND, ...CARRIES]);
  const win = winRead(data, { mine: seated(CARRIES), enemy: seated(SOUND) }, CALIBRATION);
  // heroes +10 × 0.052, seats −32 × 0.028, deficit (−6.4 + 1.5)² × −0.08
  const z = 10 * 0.052 - 32 * 0.028 - 0.08 * 4.9 ** 2;
  assert.ok(Math.abs(win.chance - sigmoid(z)) < 1e-12);
  assert.equal(win.shown, "under 15%");
  assert.equal(win.verdict.label, "You are being run over");
  const roles = win.parts.find((p) => p.group === "roles")!;
  assert.ok(win.parts.every((p) => p.points >= roles.points), "roles is the largest cost");
  assert.equal(roles.label, GROUP_LABEL.roles);
  const sum = win.parts.reduce((s, p) => s + p.points, 0);
  assert.ok(Math.abs(sum - (win.chance * 100 - 50)) < 1e-9, "the parts add up to the figure");
  assert.equal(win.evidence, null, "no bin vouches for a figure out of range");
  assert.equal(
    rolesReason(win.roles),
    "Nobody on your side supports: C2 at 2 (2.5% of their games), C3 at 3 (2.5% of their games), " +
      "C4 at 4 (2.5% of their games), C5 at 5 (2.5% of their games)",
  );
});

test("swapping the line-ups gives the other side the rest of the chance", () => {
  const data = dataset([...SOUND, ...CARRIES], { s1: { c1: row(2) } }, { s1: { s2: pair(1.2) }, s2: { s1: pair(1.2) } });
  const a = winRead(data, { mine: seated(SOUND), enemy: seated(CARRIES) }, CALIBRATION);
  const b = winRead(data, { mine: seated(CARRIES), enemy: seated(SOUND) }, CALIBRATION);
  assert.ok(Math.abs(a.chance + b.chance - 1) < 1e-12);
});

test("an ordinary flex costs a fraction of a point", () => {
  // A hero who mids in 26% of their games and wins a point less there.
  const flex: Hero = {
    ...hero("flex", 50, 4),
    positions: { 2: 0.26, 4: 0.6, 5: 0.14 },
    positionWinRate: { 2: 49, 4: 50, 5: 50 },
  };
  const data = dataset([...SOUND, ...ENEMY, flex]);
  const lineup = [pick("s1", 1), pick("flex", 2), pick("s3", 3), pick("s4", 4), pick("s5", 5)];
  const win = winRead(data, { mine: lineup, enemy: seated(ENEMY) }, CALIBRATION);
  const roles = win.parts.find((p) => p.group === "roles")!;
  assert.ok(Math.abs(roles.points) < 2, `roles moved ${roles.points}`);
  assert.equal(rolesReason(win.roles), null, "nobody is off-role and no seat costs three points");
});

test("five supports are told nobody farms, and the enemy's stretch is good news", () => {
  const supports = ["p1", "p2", "p3", "p4", "p5"].map((slug) => hero(slug, 51, 5));
  const data = dataset([...supports, ...ENEMY, hero("wanderer", 50, 1)]);
  const enemy = [pick("e1", 1), pick("e2", 2), pick("e3", 3), pick("wanderer", 4), pick("e5", 5)];
  const reason = rolesReason(winRead(data, { mine: seated(supports), enemy }, CALIBRATION).roles)!;
  assert.match(reason, /^Nobody on your side farms: P1 at 1 \(2\.5% of their games\)/);
  assert.match(reason, /their WANDERER at 4 \(2\.5% of their games\) is off-role$/);
});

test("inside the range the evidence is the bin the chance falls in", () => {
  const data = dataset([...SOUND, ...ENEMY], { s1: { e1: row(-3) } });
  const win = winRead(data, { mine: seated(SOUND), enemy: seated(ENEMY) }, CALIBRATION);
  // −3 points of matchups: σ(−0.138) ≈ 46.6%.
  assert.equal(win.shown, "47%");
  assert.deepEqual(win.evidence, { from: 0.45, to: 0.5, games: 146_917, actual: 0.477 });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `node --test --experimental-strip-types --no-warnings --import ./scripts/register-ts-resolve.mjs src/lib/winModel.test.ts`
Expected: FAIL — `does not provide an export named 'GROUP_LABEL'`.

- [ ] **Step 3: Extend the imports in `winModel.ts`**

Replace:

```ts
import { positionWinRate } from "./roles";
import { earlyCoverPenalty, teamCover } from "./timing";
import type { Dataset, DraftPick } from "../types";
```

with:

```ts
import { positionFit, positionWinRate } from "./roles";
import { earlyCoverPenalty, teamCover } from "./timing";
import type { Dataset, DraftPick, Position } from "../types";
```

- [ ] **Step 4: Append the read to `winModel.ts`**

```ts
// ------------------------------------------------------------------ the read

/** How the parts are shown: the seat terms together, everything else on its own. */
export const WIN_GROUPS = ["roles", "matchups", "cohesion", "heroes", "timing"] as const;
export type WinGroup = (typeof WIN_GROUPS)[number];

export const GROUP_LABEL: Record<WinGroup, string> = {
  roles: "Roles",
  matchups: "Matchups",
  cohesion: "Cohesion",
  heroes: "Heroes",
  timing: "Timing",
};

const GROUP_OF: Record<WinFeature, WinGroup> = {
  matchups: "matchups",
  cohesion: "cohesion",
  heroes: "heroes",
  seatPenalty: "roles",
  seatBonus: "roles",
  roleDeficit: "roles",
  timing: "timing",
};

export const sigmoid = (z: number): number => 1 / (1 + Math.exp(-z));

/**
 * Each group's exact Shapley value, in points of win chance.
 *
 * `values` are the groups' log-odds. A chance is not additive in them, so a
 * plain split would leave a remainder nobody could account for; the Shapley
 * value averages each group's effect over every order the groups could be
 * added in, and the parts then add up to `100·σ(Σ values) − 50` exactly. Five
 * groups are 32 evaluations.
 */
export function shapley(values: number[]): number[] {
  const n = values.length;
  const factorial = [1];
  for (let i = 1; i <= n; i++) factorial.push(factorial[i - 1]! * i);
  const parts = values.map(() => 0);
  for (let mask = 0; mask < 1 << n; mask++) {
    let z = 0;
    let size = 0;
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) {
        z += values[i]!;
        size++;
      }
    }
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) continue;
      const weight = (factorial[size]! * factorial[n - size - 1]!) / factorial[n]!;
      parts[i] = (parts[i] ?? 0) + weight * (sigmoid(z + values[i]!) - sigmoid(z)) * 100;
    }
  }
  return parts;
}

/** The verdict, in the same words the comparison signal used. */
export interface WinVerdict {
  label: string;
  side: "mine" | "enemy" | "even";
  /** 0..4, for the strength of the colour. */
  strength: number;
}

/** Bands by distance from an even game, in points of win chance. */
export function verdictForChance(chance: number): WinVerdict {
  const distance = Math.abs(chance * 100 - 50);
  const mine = chance >= 0.5;
  if (distance < 5) return { label: "Coin flip", side: "even", strength: 0 };
  const side = mine ? "mine" : "enemy";
  if (distance < 10) return { label: mine ? "Slight edge to you" : "Slight edge to them", side, strength: 1 };
  if (distance < 17) return { label: mine ? "You are favoured" : "They are favoured", side, strength: 2 };
  if (distance < 25) return { label: mine ? "You are well ahead" : "They are well ahead", side, strength: 3 };
  return { label: mine ? "Dominant draft" : "You are being run over", side, strength: 4 };
}

/**
 * The chance as printed: a whole percent inside the span the calibration can
 * vouch for, and a bound beyond it — the model's own figure there is an
 * extrapolation past the last bin with enough games to check it against.
 */
export function showChance(
  chance: number,
  range: readonly [number, number],
): { shown: string; short: string; inRange: boolean } {
  const [low, high] = range;
  const pct = (n: number) => Math.round(n * 100);
  if (chance < low) return { shown: `under ${pct(low)}%`, short: `<${pct(low)}%`, inRange: false };
  if (chance > high) return { shown: `over ${pct(high)}%`, short: `>${pct(high)}%`, inRange: false };
  return { shown: `${pct(chance)}%`, short: `${pct(chance)}%`, inRange: true };
}

/** One group of the model, in points of win chance. */
export interface WinPart {
  group: WinGroup;
  label: string;
  points: number;
}

/** The reliability bin a chance falls in: what drafts rated like this actually did. */
export interface WinEvidence {
  from: number;
  to: number;
  games: number;
  actual: number;
}

/** One hero's seat, for the Roles card and the reasons. */
export interface SeatReport {
  slug: string;
  name: string;
  position: Position | null;
  /** Share of their games in this seat, or null without position data. */
  share: number | null;
  /** Their win rate in this seat, and overall; null when either is unknown. */
  seatWinRate: number | null;
  winRate: number | null;
  /** `seatWinRate − winRate`, 0 when either is unknown. */
  delta: number;
}

export interface SideRoles {
  seats: SeatReport[];
  /** Σ delta. */
  total: number;
  /** Seats under `ROLE_REASON_SHARE` of the hero's games, rarest first. */
  offRole: SeatReport[];
  /** A complete side whose summed position-4 and -5 shares are under half a hero. */
  noSupports: boolean;
  /** A complete side whose summed position-1 to -3 shares are under half a hero. */
  noCores: boolean;
}

export interface RolesRead {
  mine: SideRoles;
  theirs: SideRoles;
}

/** Below this share of a hero's games, a seat is named as off-role in the reasons. */
export const ROLE_REASON_SHARE = 0.05;

function sideRoles(data: Dataset, picks: DraftPick[]): SideRoles {
  const seats: SeatReport[] = picks.map((pick) => {
    const hero = data.bySlug.get(pick.slug);
    const winRate = hero?.winRate ?? null;
    const share = hero?.positions && pick.position ? positionFit(hero, pick.position) : null;
    const seatWinRate =
      hero && pick.position && winRate !== null ? positionWinRate(hero, pick.position) : null;
    return {
      slug: pick.slug,
      name: hero?.name ?? pick.slug,
      position: pick.position,
      share,
      seatWinRate,
      winRate,
      delta: seatWinRate !== null && winRate !== null ? seatWinRate - winRate : 0,
    };
  });
  const complete =
    picks.length >= TEAM_SIZE && picks.every((p) => data.bySlug.get(p.slug)?.positions);
  const summed = (from: Position[]) =>
    picks.reduce((total, p) => {
      const positions = data.bySlug.get(p.slug)?.positions;
      return total + from.reduce((n, position) => n + (positions?.[position] ?? 0), 0);
    }, 0);
  return {
    seats,
    total: seats.reduce((n, s) => n + s.delta, 0),
    offRole: seats
      .filter((s) => s.share !== null && s.share < ROLE_REASON_SHARE)
      .sort((a, b) => (a.share ?? 0) - (b.share ?? 0)),
    noSupports: complete && summed([4, 5]) < 0.5,
    noCores: complete && summed([1, 2, 3]) < 0.5,
  };
}

/** Both sides' seats, for the Roles card and `rolesReason`. */
export function rolesRead(data: Dataset, board: Board): RolesRead {
  return { mine: sideRoles(data, board.mine), theirs: sideRoles(data, board.enemy) };
}

const sharePct = (share: number) =>
  `${share < 0.1 ? (share * 100).toFixed(1) : Math.round(share * 100)}%`;
const seatText = (seat: SeatReport) =>
  `${seat.name} at ${seat.position} (${sharePct(seat.share ?? 0)} of their games)`;

/**
 * The Roles part in words: what is wrong with our seats, and what is wrong with
 * theirs, which is good news. Null when neither side has anything to say.
 */
export function rolesReason(roles: RolesRead): string | null {
  const ours = roles.mine;
  const lead = ours.noSupports
    ? "Nobody on your side supports"
    : ours.noCores
      ? "Nobody on your side farms"
      : null;
  const named = ours.offRole.map(seatText).join(", ");
  let text: string | null = lead ? (named ? `${lead}: ${named}` : lead) : named || null;
  if (!text) {
    // Nobody is somewhere they never play, but a seat can still cost a lot.
    const worst = [...ours.seats].sort((a, b) => a.delta - b.delta)[0];
    if (worst && worst.delta <= -3 && worst.seatWinRate !== null && worst.winRate !== null) {
      text =
        `${worst.name} wins ${worst.seatWinRate.toFixed(1)}% at ${worst.position} ` +
        `against ${worst.winRate.toFixed(1)}% overall`;
    }
  }
  const theirs = roles.theirs.offRole;
  if (theirs.length) {
    const news = `their ${theirs.map(seatText).join(", ")} ${theirs.length === 1 ? "is" : "are"} off-role`;
    text = text ? `${text}; ${news}` : `${news.charAt(0).toUpperCase()}${news.slice(1)}`;
  }
  return text;
}

/** The board as a win chance, with its parts and the seats behind the roles part. */
export interface WinRead {
  /** 0..1, the model's own figure. */
  chance: number;
  logOdds: number;
  /** "38%", "under 15%". */
  shown: string;
  /** "38%", "<15%" — for the top-bar chip. */
  short: string;
  inRange: boolean;
  verdict: WinVerdict;
  /** In `WIN_GROUPS` order; they add up to `100·chance − 50`. */
  parts: WinPart[];
  roles: RolesRead;
  /** What drafts rated like this won, when the chance is inside the calibrated range. */
  evidence: WinEvidence | null;
  /** Games the weights were fitted on. */
  matches: number;
}

export function winRead(data: Dataset, board: Board, calibration: Calibration): WinRead {
  const vector = winFeatures(draftFeatures(data, board), calibration.tau);
  const byGroup = new Map<WinGroup, number>(WIN_GROUPS.map((group) => [group, 0]));
  for (const key of WIN_FEATURES) {
    const group = GROUP_OF[key];
    byGroup.set(group, (byGroup.get(group) ?? 0) + calibration.weights[key] * vector[key]);
  }
  const values = WIN_GROUPS.map((group) => byGroup.get(group) ?? 0);
  const logOdds = values.reduce((sum, v) => sum + v, 0);
  const chance = sigmoid(logOdds);
  const points = shapley(values);
  const display = showChance(chance, calibration.range);
  const bin = display.inRange
    ? calibration.reliability.find(([from, to]) => chance >= from && chance < to)
    : undefined;
  return {
    chance,
    logOdds,
    ...display,
    verdict: verdictForChance(chance),
    parts: WIN_GROUPS.map((group, i) => ({ group, label: GROUP_LABEL[group], points: points[i] ?? 0 })),
    roles: rolesRead(data, board),
    evidence: bin ? { from: bin[0], to: bin[1], games: bin[2], actual: bin[4] } : null,
    matches: calibration.matches,
  };
}
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `node --test --experimental-strip-types --no-warnings --import ./scripts/register-ts-resolve.mjs src/lib/winModel.test.ts`
Expected: PASS, `# pass 17`, `# fail 0`.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 7: Commit**

```bash
git add src/lib/winModel.ts src/lib/winModel.test.ts
git commit -m "Turn the features into a win chance with parts, verdict and roles"
```

---

### Task 3: Calibration maths

**Files:**
- Create: `scripts/calibrate-math.mjs`
- Create: `scripts/calibrate-math.test.mjs`

**Interfaces:**
- Consumes: nothing from the app — the model arrives as a `vectorize` callback.
- Produces:
  - `sigmoid(z)`, `solve(A, b)`, `fitLogistic(X, y) → { weights: number[], se: number[], iterations: number }`
  - `logLoss(zs, ys)`, `auc(scores, ys)`
  - `reliability(predictions: {p, y}[], width = 0.05) → Array<[from, to, games, predicted, actual]>`
  - `calibratedRange(table, minGames = 200) → [low, high] | null`
  - `fitCalibration(samples, { keys, taus, vectorize, nonPositive }) → { matches, tau, grid, side, weights, se, holdout: { logLoss, baseline, auc }, reliability, range }` where `se[key]` is `null` for a pinned weight
  - `calibrationProblems(result, { minMatches, minGain, maxBinError, minBinGames, positive }) → string[]`
  - `calibrationWindow(synergies, timings) → number | null`

- [ ] **Step 1: Write the failing tests**

Create `scripts/calibrate-math.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import {
  auc,
  calibratedRange,
  calibrationProblems,
  calibrationWindow,
  fitCalibration,
  fitLogistic,
  logLoss,
  reliability,
  sigmoid,
  solve,
} from "./calibrate-math.mjs";

/** A seeded generator, so the simulated games are the same on every run. */
function random(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const normal = (rand) => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());

test("solve inverts a small system", () => {
  const [a, b] = solve([[2, 1], [1, 3]], [3, 5]);
  assert.ok(Math.abs(a - 0.8) < 1e-12 && Math.abs(b - 1.4) < 1e-12);
});

test("logistic regression recovers the weights the games were drawn from", () => {
  const rand = random(7);
  const X = [];
  const y = [];
  for (let i = 0; i < 20_000; i++) {
    const row = [1, normal(rand), rand() * 2 - 1];
    X.push(row);
    y.push(rand() < sigmoid(0.1 + 0.8 * row[1] - 0.5 * row[2]) ? 1 : 0);
  }
  const { weights, se } = fitLogistic(X, y);
  [0.1, 0.8, -0.5].forEach((truth, j) => {
    assert.ok(Math.abs(weights[j] - truth) < 4 * se[j], `weight ${j}: ${weights[j]} ± ${se[j]} against ${truth}`);
  });
  assert.ok(se.every((s) => s > 0 && s < 0.1), "and it knows roughly how sure it is");
});

test("log-loss and AUC score what they should", () => {
  assert.ok(Math.abs(logLoss([0, 0], [1, 0]) - Math.log(2)) < 1e-12, "a coin flip costs ln 2");
  assert.equal(auc([0.1, 0.2, 0.8, 0.9], [0, 0, 1, 1]), 1);
  assert.equal(auc([0.5, 0.5, 0.5, 0.5], [0, 1, 0, 1]), 0.5, "ties count as a coin flip");
});

test("the reliability table bins, averages and keeps its shape", () => {
  const table = reliability([...Array(100)].map((_, i) => ({ p: 0.12, y: i < 12 ? 1 : 0 })));
  assert.equal(table.length, 20);
  const bin = table.find(([from]) => from === 0.1);
  assert.equal(bin[1], 0.15);
  assert.equal(bin[2], 100);
  assert.ok(Math.abs(bin[3] - 0.12) < 1e-12);
  assert.equal(bin[4], 0.12);
  assert.equal(table.filter(([, , n]) => n > 0).length, 1);
  const edge = reliability([{ p: 0.15, y: 1 }]).find(([, , n]) => n > 0);
  assert.deepEqual(edge.slice(0, 2), [0.15, 0.2], "an edge belongs to the bin it opens");
});

test("the calibrated range is the span around even where every bin has the games", () => {
  const table = reliability([]).map(([from, to]) => [from, to, from >= 0.15 && to <= 0.85 ? 500 : 50, 0, 0]);
  assert.deepEqual(calibratedRange(table), [0.15, 0.85]);
  const thin = table.map((row) => (row[0] === 0.45 ? [row[0], row[1], 10, 0, 0] : row));
  assert.equal(calibratedRange(thin), null, "nothing next to even, nothing to vouch for");
});

/** Games drawn from a model with a convex role deficit past a known threshold. */
function simulated(n, { tau = 2, deficit = -0.3, seed = 11 } = {}) {
  const rand = random(seed);
  return Array.from({ length: n }, (_, id) => {
    const a = normal(rand);
    const seats = -rand() * 6;
    const z = 0.1 + 0.5 * a + deficit * Math.min(0, seats + tau) ** 2;
    return { id, y: rand() < sigmoid(z) ? 1 : 0, a, seats };
  });
}

const spec = {
  keys: ["a", "d"],
  taus: [0.5, 1, 2, 3],
  vectorize: (sample, tau) => ({ a: sample.a, d: Math.min(0, sample.seats + tau) ** 2 }),
  nonPositive: ["d"],
};

test("the fit finds the threshold and the weights it was planted with", () => {
  const result = fitCalibration(simulated(60_000), spec);
  assert.equal(result.tau, 2);
  assert.ok(Math.abs(result.weights.a - 0.5) < 0.05, `a ${result.weights.a}`);
  assert.ok(Math.abs(result.weights.d + 0.3) < 0.05, `d ${result.weights.d}`);
  assert.ok(result.holdout.logLoss < result.holdout.baseline - 0.005, "better than knowing the side");
  assert.ok(result.range, "and there is a range to show figures in");
  assert.equal(result.matches, 60_000);
});

test("a weight that can only cost is pinned at zero when the games point the other way", () => {
  const result = fitCalibration(simulated(20_000, { deficit: 0.05 }), { ...spec, taus: [2] });
  assert.equal(result.weights.d, 0);
  assert.equal(result.se.d, null);
  assert.ok(Math.abs(result.weights.a - 0.5) < 0.06);
});

test("each guardrail stops the write it exists for", () => {
  const good = {
    matches: 300_000,
    holdout: { logLoss: 0.672, baseline: 0.691, auc: 0.61 },
    reliability: [[0.4, 0.45, 5_000, 0.425, 0.43]],
    weights: { matchups: 0.046, roleDeficit: -0.08 },
    range: [0.15, 0.85],
  };
  const check = (result) => calibrationProblems(result, { positive: ["matchups"] });
  assert.deepEqual(check(good), []);
  assert.match(check({ ...good, matches: 50_000 })[0], /usable games/);
  assert.match(check({ ...good, holdout: { ...good.holdout, logLoss: 0.689 } })[0], /log-loss/);
  assert.match(
    check({ ...good, reliability: [[0.4, 0.45, 5_000, 0.425, 0.47]] })[0],
    /were predicted 42\.5% and won 47\.0%/,
  );
  assert.match(check({ ...good, weights: { ...good.weights, matchups: -0.01 } })[0], /can only be positive/);
  assert.match(check({ ...good, range: null })[0], /vouch/);
});

test("the calibration window starts below both samples", () => {
  assert.equal(
    calibrationWindow(
      { matchIdRange: [9_010_415_463, 9_011_795_463] },
      { matchIdRange: [9_009_935_463, 9_011_795_463] },
    ),
    9_009_935_463,
  );
  assert.equal(calibrationWindow({ matchIdRange: [500, 900] }, null), 500);
  assert.equal(calibrationWindow(null, {}), null);
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `node --test scripts/calibrate-math.test.mjs`
Expected: FAIL — `Cannot find module …/scripts/calibrate-math.mjs`.

- [ ] **Step 3: Write `scripts/calibrate-math.mjs`**

```js
/**
 * The arithmetic behind public/data/calibration.json — pure, no network, no
 * files, so it can be tested against simulated games with known answers.
 *
 * `scripts/calibrate.mjs` hands it one sample per real game, from Radiant's
 * side, and a `vectorize` that turns a sample into the model's features at a
 * given role-deficit threshold. The model itself lives in src/lib/winModel.ts;
 * nothing here knows what a feature means.
 */

export const sigmoid = (z) => 1 / (1 + Math.exp(-z));

/** Solve `A x = b` by Gaussian elimination with partial pivoting. `A` is k×k. */
export function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    [M[col], M[pivot]] = [M[pivot], M[col]];
    if (M[col][col] === 0) throw new Error("singular system — a feature is constant or duplicated");
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / M[col][col];
      if (f === 0) continue;
      for (let k = col; k <= n; k++) M[r][k] -= f * M[col][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

/**
 * Logistic regression by iteratively reweighted least squares.
 *
 * @param {number[][]} X one row per game; the caller includes any intercept
 * @param {number[]} y 1 for a win, 0 for a loss
 * @returns {{ weights: number[], se: number[], iterations: number }}
 */
export function fitLogistic(X, y, { maxIterations = 50, tolerance = 1e-10 } = {}) {
  const k = X[0].length;
  let w = new Array(k).fill(0);
  let H = null;
  let iterations = 0;
  while (iterations < maxIterations) {
    iterations++;
    const g = new Array(k).fill(0);
    H = Array.from({ length: k }, () => new Array(k).fill(0));
    for (let i = 0; i < X.length; i++) {
      const x = X[i];
      let z = 0;
      for (let j = 0; j < k; j++) z += w[j] * x[j];
      const p = sigmoid(z);
      const v = p * (1 - p);
      const e = y[i] - p;
      for (let j = 0; j < k; j++) {
        g[j] += e * x[j];
        const vx = v * x[j];
        for (let l = 0; l <= j; l++) H[j][l] += vx * x[l];
      }
    }
    for (let j = 0; j < k; j++) for (let l = 0; l < j; l++) H[l][j] = H[j][l];
    const step = solve(H, g);
    w = w.map((value, j) => value + step[j]);
    if (Math.max(...step.map(Math.abs)) < tolerance) break;
  }
  // Standard errors from the inverse of the information matrix at the fit.
  const se = w.map((_, j) => {
    const unit = new Array(k).fill(0);
    unit[j] = 1;
    return Math.sqrt(solve(H, unit)[j]);
  });
  return { weights: w, se, iterations };
}

/** Mean log-loss of log-odds `zs` against outcomes `ys`. */
export function logLoss(zs, ys) {
  let total = 0;
  for (let i = 0; i < zs.length; i++) {
    const p = Math.min(1 - 1e-12, Math.max(1e-12, sigmoid(zs[i])));
    total -= ys[i] ? Math.log(p) : Math.log(1 - p);
  }
  return total / zs.length;
}

/** Area under the ROC curve: the chance a random win is scored above a random loss. */
export function auc(scores, ys) {
  const order = scores.map((s, i) => [s, ys[i]]).sort((a, b) => a[0] - b[0]);
  let rankSum = 0;
  let positives = 0;
  // Average ranks across ties, so equal scores count as a coin flip.
  for (let i = 0; i < order.length; ) {
    let j = i;
    while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
    const rank = (i + j) / 2 + 1;
    for (let r = i; r <= j; r++) {
      if (order[r][1]) {
        rankSum += rank;
        positives++;
      }
    }
    i = j + 1;
  }
  const negatives = order.length - positives;
  if (!positives || !negatives) return 0.5;
  return (rankSum - (positives * (positives + 1)) / 2) / (positives * negatives);
}

const round6 = (n) => Math.round(n * 1e6) / 1e6;

/**
 * The reliability table: predictions binned by `width`, each bin's games, mean
 * prediction and actual win rate. Empty bins are kept, so the table always has
 * the same shape.
 *
 * @param {Array<{ p: number, y: number }>} predictions
 * @returns {Array<[number, number, number, number, number]>} `[from, to, games, predicted, actual]`
 */
export function reliability(predictions, width = 0.05) {
  const bins = Math.round(1 / width);
  const table = Array.from({ length: bins }, () => ({ n: 0, p: 0, y: 0 }));
  for (const { p, y } of predictions) {
    // The epsilon puts a prediction sitting on an edge in the bin that edge opens.
    const i = Math.min(bins - 1, Math.max(0, Math.floor(p * bins + 1e-9)));
    table[i].n++;
    table[i].p += p;
    table[i].y += y;
  }
  return table.map((b, i) => [
    round6(i * width),
    round6((i + 1) * width),
    b.n,
    b.n ? b.p / b.n : 0,
    b.n ? b.y / b.n : 0,
  ]);
}

/**
 * The widest span around an even game in which every bin holds at least
 * `minGames`, or null when the bins next to even do not. The table is read from
 * both seats, so the span comes out symmetric.
 */
export function calibratedRange(table, minGames = 200) {
  const below = table.findIndex(([, to]) => Math.abs(to - 0.5) < 1e-9);
  if (below < 0 || below + 1 >= table.length) return null;
  let low = null;
  for (let i = below; i >= 0 && table[i][2] >= minGames; i--) low = table[i][0];
  let high = null;
  for (let i = below + 1; i < table.length && table[i][2] >= minGames; i++) high = table[i][1];
  if (low === null || high === null) return null;
  // Never all the way to the ends: 0% and 100% are not chances.
  return [Math.max(low, 0.01), Math.min(high, 0.99)];
}

/**
 * The whole fit: τ by two-fold held-out log-loss, then the weights on every game.
 *
 * @param {Array<{ id: number, y: number }>} samples one per game, from Radiant's side
 * @param {{
 *   keys: string[],
 *   taus: number[],
 *   vectorize: (sample: object, tau: number) => Record<string, number>,
 *   nonPositive?: string[],
 * }} spec
 */
export function fitCalibration(samples, { keys, taus, vectorize, nonPositive = [] }) {
  const folds = [samples.filter((s) => s.id % 2 === 0), samples.filter((s) => s.id % 2 !== 0)];
  const pairs = [
    [folds[0], folds[1]],
    [folds[1], folds[0]],
  ];

  /**
   * A fit with the side term and every key — except that a weight that may not
   * be positive and comes out positive anyway is pinned at zero and the rest
   * refitted. That is the constrained maximum, and what a one-sided effect's
   * estimate should be when the sample points the impossible way.
   */
  const fit = (rows, tau) => {
    const pinned = new Set();
    const vectors = rows.map((s) => vectorize(s, tau));
    const outcomes = rows.map((s) => s.y);
    for (;;) {
      const free = keys.filter((key) => !pinned.has(key));
      const X = vectors.map((v) => [1, ...free.map((key) => v[key])]);
      const result = fitLogistic(X, outcomes);
      const offending = free.find((key, i) => nonPositive.includes(key) && result.weights[i + 1] > 0);
      if (offending) {
        pinned.add(offending);
        continue;
      }
      const weights = {};
      const se = {};
      for (const key of keys) {
        const i = free.indexOf(key);
        weights[key] = i < 0 ? 0 : result.weights[i + 1];
        se[key] = i < 0 ? null : result.se[i + 1];
      }
      return { side: result.weights[0], weights, se };
    }
  };
  const predict = (model, vector) => keys.reduce((z, key) => z + model.weights[key] * vector[key], 0);

  const heldOut = (tau) => {
    const zs = [];
    const ys = [];
    for (const [train, test] of pairs) {
      const model = fit(train, tau);
      for (const s of test) {
        zs.push(model.side + predict(model, vectorize(s, tau)));
        ys.push(s.y);
      }
    }
    return logLoss(zs, ys);
  };

  const grid = taus.map((tau) => ({ tau, logLoss: heldOut(tau) }));
  const best = grid.reduce((a, b) => (b.logLoss < a.logLoss ? b : a));

  // The side term alone: the baseline any draft read has to beat.
  const baselineZ = [];
  const baselineY = [];
  for (const [train, test] of pairs) {
    const side = fitLogistic(train.map(() => [1]), train.map((s) => s.y)).weights[0];
    for (const s of test) {
      baselineZ.push(side);
      baselineY.push(s.y);
    }
  }

  // Out-of-fold predictions at the chosen τ, for the reliability table and AUC.
  const neutral = [];
  const withSide = [];
  const outcomes = [];
  for (const [train, test] of pairs) {
    const model = fit(train, best.tau);
    for (const s of test) {
      const z = predict(model, vectorize(s, best.tau));
      neutral.push(z);
      withSide.push(z + model.side);
      outcomes.push(s.y);
    }
  }
  // Read from both seats: the table is about drafts, not about which side of the map they started on.
  const table = reliability(
    neutral.flatMap((z, i) => [
      { p: sigmoid(z), y: outcomes[i] },
      { p: sigmoid(-z), y: 1 - outcomes[i] },
    ]),
  );

  const final = fit(samples, best.tau);
  return {
    matches: samples.length,
    tau: best.tau,
    grid,
    side: final.side,
    weights: final.weights,
    se: final.se,
    holdout: {
      logLoss: best.logLoss,
      baseline: logLoss(baselineZ, baselineY),
      auc: auc(withSide, outcomes),
    },
    reliability: table,
    range: calibratedRange(table),
  };
}

/**
 * Why a fit must not be written, or an empty list when it may.
 *
 * Each check answers a different way the step could quietly ship a bad file: a
 * thin sample, a model no better than knowing which side you are on, a table
 * that says the chances are wrong where it has the games to say so, and a
 * weight whose sign no draft could explain.
 */
export function calibrationProblems(
  result,
  { minMatches = 100_000, minGain = 0.005, maxBinError = 0.03, minBinGames = 1_000, positive = [] } = {},
) {
  const problems = [];
  const pct = (n) => `${(n * 100).toFixed(1)}%`;
  if (result.matches < minMatches) {
    problems.push(
      `only ${result.matches.toLocaleString("en-US")} usable games; at least ` +
        `${minMatches.toLocaleString("en-US")} are needed`,
    );
  }
  if (!(result.holdout.logLoss <= result.holdout.baseline - minGain)) {
    problems.push(
      `held-out log-loss ${result.holdout.logLoss.toFixed(5)} is not ${minGain} below ` +
        `the side term's ${result.holdout.baseline.toFixed(5)}`,
    );
  }
  for (const [from, to, games, predicted, actual] of result.reliability) {
    if (games >= minBinGames && Math.abs(predicted - actual) > maxBinError) {
      problems.push(
        `drafts rated ${pct(from)}–${pct(to)} were predicted ${pct(predicted)} and won ` +
          `${pct(actual)} over ${games.toLocaleString("en-US")} team-games`,
      );
    }
  }
  for (const [key, weight] of Object.entries(result.weights)) {
    if (!Number.isFinite(weight)) problems.push(`the ${key} weight is not a number`);
  }
  for (const key of positive) {
    if (!(result.weights[key] > 0)) {
      problems.push(`the ${key} weight came out ${result.weights[key]}, and it can only be positive`);
    }
  }
  if (!result.range) problems.push("no bin next to an even game holds enough games to vouch for any figure");
  return problems;
}

/**
 * The highest match id the calibration may use, exclusive: the lower edge of
 * the synergy and the timing samples, whichever is older. Null when neither
 * file records one.
 */
export function calibrationWindow(synergies, timings) {
  const lows = [synergies?.matchIdRange?.[0], timings?.matchIdRange?.[0]]
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0);
  return lows.length ? Math.min(...lows) : null;
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `node --test scripts/calibrate-math.test.mjs`
Expected: PASS, `# pass 9`, `# fail 0`. If "the fit finds the threshold" picks a neighbouring τ, raise the sample to 100,000 in that test rather than loosening the assertion; do not change the seed to hunt for a pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/calibrate-math.mjs scripts/calibrate-math.test.mjs
git commit -m "Add the calibration maths: logistic fit, threshold, reliability, guardrails"
```

---

### Task 4: The calibrate step

**Files:**
- Create: `scripts/calibrate.mjs`
- Modify: `package.json` (`scripts`)
- Modify: `scripts/refresh.mjs` (imports, loader flags, the step, `runStep`)

**Interfaces:**
- Consumes: `calibrationProblems`, `calibrationWindow`, `fitCalibration` from `./calibrate-math.mjs`; `assignPositions` from `./assign.mjs`; `BASE_HEROES` from `../src/data/heroes.ts`; `buildDataset` from `../src/lib/dataset.ts`; `withRankBand` from `../src/lib/positions.ts`; `WIN_FEATURES`, `draftFeatures`, `readCalibration`, `winFeatures`, `winRead` from `../src/lib/winModel.ts`.
- Produces: `public/data/calibration.json` in the shape `readCalibration` accepts, plus `se`, `side`, `note`, `source`, `rankBand`; `scripts/.cache/calibration-matches.json` (git-ignored); the `calibrate` refresh step.

- [ ] **Step 1: Write `scripts/calibrate.mjs`**

```js
#!/usr/bin/env node
/**
 * Builds public/data/calibration.json — the weights that turn a draft into a
 * win chance, fitted on real games.
 *
 *   npm run calibrate                      # ~300k ranked games older than the synergy and timing samples
 *   npm run calibrate -- --matches=500000  # a bigger sample
 *   npm run calibrate -- --fresh           # ignore the cached line-ups
 *   npm run calibrate -- --dry-run         # fit and report, write nothing
 *
 * The features come from src/lib/winModel.ts — the arithmetic the app runs — so
 * this script needs the TypeScript loader, which `npm run calibrate` supplies.
 * The games are the ones just older than the synergy and timing samples, so no
 * weight is fitted on the games those figures were measured on. See
 * docs/scoring.md, "Win chance".
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assignPositions } from "./assign.mjs";
import { calibrationProblems, calibrationWindow, fitCalibration } from "./calibrate-math.mjs";
import { BASE_HEROES } from "../src/data/heroes.ts";
import { buildDataset } from "../src/lib/dataset.ts";
import { withRankBand } from "../src/lib/positions.ts";
import { WIN_FEATURES, draftFeatures, readCalibration, winFeatures, winRead } from "../src/lib/winModel.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(ROOT, "public", "data");
const OUT_FILE = join(DATA, "calibration.json");
const CACHE_FILE = join(ROOT, "scripts", ".cache", "calibration-matches.json");
const API = "https://api.opendota.com/api";

// ---------------------------------------------------------------- CLI options

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const options = {
  matches: Number(opt("matches", 300_000)),
  window: Number(opt("window", 400_000)),
  delay: Number(opt("delay", 1500)),
  timeout: Number(opt("timeout", 120_000)),
  fresh: flag("fresh"),
  dryRun: flag("dry-run"),
  key: opt("key", process.env.OPENDOTA_API_KEY || ""),
};

/** Candidates for the role-deficit threshold, in points per hero. */
const TAUS = [0.5, 1, 1.5, 2, 2.5, 3];
/** Weights no draft could explain the negative of: more of these never loses games. */
const POSITIVE = ["matchups", "cohesion", "heroes", "seatPenalty", "seatBonus"];

/**
 * Drafts printed after every fit, so a refresh shows what the model now says
 * about cases a player can judge. Booked in the order listed, positions 1 to 5.
 * They are the spec's sanity cases; nothing asserts on them here.
 */
const SANITY = [
  ["Five cores, as booked", ["anti-mage", "meepo", "sven", "lifestealer", "arc-warden"], ["leshrac", "lina", "enigma", "bounty-hunter", "earthshaker"]],
  ["Same enemy, a sound five", ["anti-mage", "meepo", "axe", "rubick", "crystal-maiden"], ["leshrac", "lina", "enigma", "bounty-hunter", "earthshaker"]],
  ["The early-game case", ["phantom-lancer", "arc-warden", "axe", "silencer", "ancient-apparition"], ["sniper", "lion", "bristleback", "enigma", "lich"]],
  ["Five supports", ["shadow-shaman", "lion", "dazzle", "witch-doctor", "crystal-maiden"], ["juggernaut", "invoker", "mars", "tusk", "lich"]],
  ["A sound pub draft", ["faceless-void", "storm-spirit", "centaur-warrunner", "hoodwink", "warlock"], ["phantom-assassin", "puck", "underlord", "nyx-assassin", "jakiro"]],
  ["The same, Snapfire mid", ["faceless-void", "snapfire", "centaur-warrunner", "hoodwink", "warlock"], ["phantom-assassin", "puck", "underlord", "nyx-assassin", "jakiro"]],
  ["The same, Slark mid", ["faceless-void", "slark", "centaur-warrunner", "hoodwink", "warlock"], ["phantom-assassin", "puck", "underlord", "nyx-assassin", "jakiro"]],
];

const log = (...a) => console.log(...a);
const warn = (...a) => console.warn("  !", ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------- fetching

async function getJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json", "User-Agent": "dotabuff-picker/1.0" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Run one SQL statement against OpenDota's explorer. Returns its rows. */
async function explorer(sql) {
  const url =
    `${API}/explorer?sql=${encodeURIComponent(sql.replace(/\s+/g, " ").trim())}` +
    (options.key ? `&api_key=${encodeURIComponent(options.key)}` : "");
  const body = await getJson(url);
  if (body?.err) throw new Error(String(body.err));
  if (!Array.isArray(body?.rows)) throw new Error("no rows in response");
  return body.rows;
}

/** OpenDota hero id -> our slug, matched on Valve's internal name. */
async function heroIds() {
  const bySteam = new Map(BASE_HEROES.map((h) => [h.steam, h.slug]));
  const out = new Map();
  for (const hero of await getJson(`${API}/heroes`)) {
    const slug = bySteam.get(String(hero.name ?? "").replace(/^npc_dota_hero_/, ""));
    if (slug) out.set(Number(hero.id), slug);
  }
  return out;
}

const windowSql = (lo, hi) => `
  SELECT match_id AS id, radiant_team AS r, dire_team AS d, radiant_win AS w
  FROM public_matches
  WHERE match_id > ${lo} AND match_id <= ${hi}
    AND lobby_type = 7 AND game_mode = 22
    AND array_length(radiant_team, 1) = 5 AND array_length(dire_team, 1) = 5`;

/** Postgres int arrays arrive as arrays already, but text is worth tolerating. */
const asTeam = (t) => {
  const list = Array.isArray(t) ? t : typeof t === "string" ? t.replace(/[{}]/g, "").split(",") : null;
  if (!list || list.length !== 5) return null;
  const team = list.map(Number);
  return team.every(Number.isFinite) ? team : null;
};

/** Line-ups strictly below `below`, newest first, from the cache when it still fits. */
async function collect(below) {
  const cached = options.fresh ? null : await readJson(CACHE_FILE);
  if (cached?.below === below && Array.isArray(cached.rows) && cached.rows.length >= options.matches) {
    log(`  ${cached.rows.length.toLocaleString()} line-ups from the cache`);
    return cached.rows;
  }

  const rows = [];
  let hi = below - 1;
  let width = options.window;
  while (rows.length < options.matches) {
    const lo = Math.max(0, hi - width);
    if (lo <= 0) {
      warn("reached the start of the table");
      break;
    }
    const started = Date.now();
    let found;
    try {
      found = await explorer(windowSql(lo, hi));
    } catch (err) {
      const narrower = Math.max(20_000, Math.floor(width / 2));
      if (narrower === width) throw err;
      warn(`window of ${width.toLocaleString()} ids failed (${err.message}); retrying at ${narrower.toLocaleString()}`);
      width = narrower;
      await sleep(options.delay * 2);
      continue;
    }
    for (const m of found) {
      const r = asTeam(m.r);
      const d = asTeam(m.d);
      if (!r || !d) continue;
      rows.push([Number(m.id), r, d, m.w === true || m.w === "t" || m.w === 1 ? 1 : 0]);
    }
    const elapsed = Date.now() - started;
    log(
      `  ${rows.length.toLocaleString().padStart(9)} line-ups · ids ${lo.toLocaleString()}–${hi.toLocaleString()} · ` +
        `${(elapsed / 1000).toFixed(1)}s`,
    );
    hi = lo;
    if (elapsed < 5_000) width = Math.min(width * 2, 3_000_000);
    else if (elapsed > 30_000) width = Math.max(20_000, Math.floor(width / 2));
    await sleep(options.delay);
  }

  await mkdir(dirname(CACHE_FILE), { recursive: true });
  await writeFile(CACHE_FILE, JSON.stringify({ below, rows }));
  return rows;
}

// ------------------------------------------------------------------- the fit

/** Every usable line-up as the model's features, from Radiant's side. */
function samplesFrom(rows, data, idToSlug, priors) {
  const samples = [];
  let skipped = 0;
  const seat = (slugs) => {
    const { positions } = assignPositions(slugs, priors);
    return slugs.map((slug, i) => ({ slug, position: positions[i] }));
  };
  for (const [id, r, d, won] of rows) {
    const radiant = r.map((h) => idToSlug.get(h));
    const dire = d.map((h) => idToSlug.get(h));
    if ([...radiant, ...dire].some((slug) => !slug || !priors.has(slug))) {
      skipped++;
      continue;
    }
    samples.push({ id, y: won, features: draftFeatures(data, { mine: seat(radiant), enemy: seat(dire) }) });
  }
  return { samples, skipped };
}

const pct = (n) => `${(n * 100).toFixed(1)}%`;
const signed = (n, digits = 4) => `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(digits)}`;

function report(result) {
  log(`\n  τ = ${result.tau}  (held-out log-loss by τ: ${result.grid.map((g) => `${g.tau} ${g.logLoss.toFixed(5)}`).join(", ")})`);
  log(
    `  held-out log-loss ${result.holdout.logLoss.toFixed(5)} against ${result.holdout.baseline.toFixed(5)} ` +
      `for the side term alone · AUC ${result.holdout.auc.toFixed(3)}`,
  );
  log("  weights, log-odds per point:");
  for (const [key, weight] of Object.entries(result.weights)) {
    const se = result.se[key];
    log(`    ${key.padEnd(12)} ${signed(weight)}${se === null ? "  (pinned at 0)" : ` ± ${se.toFixed(4)}`}`);
  }
  log("  calibration, out of fold, both seats (predicted → won):");
  for (const [from, to, games, predicted, actual] of result.reliability) {
    if (!games) continue;
    log(`    ${pct(from).padStart(6)}–${pct(to).padEnd(6)} ${String(games).padStart(8)} team-games  ${pct(predicted).padStart(6)} → ${pct(actual)}`);
  }
  if (result.range) log(`  figures shown between ${pct(result.range[0])} and ${pct(result.range[1])}`);
}

function sanity(data, calibration) {
  log("  sanity drafts (spec, \"Sanity cases\"):");
  const seated = (slugs) => slugs.map((slug, i) => ({ slug, position: i + 1 }));
  for (const [label, mine, theirs] of SANITY) {
    if ([...mine, ...theirs].some((slug) => !data.bySlug.has(slug))) {
      log(`    ${label.padEnd(26)} a hero is missing from the data`);
      continue;
    }
    const win = winRead(data, { mine: seated(mine), enemy: seated(theirs) }, calibration);
    const lead = [...win.parts].sort((a, b) => Math.abs(b.points) - Math.abs(a.points))[0];
    const roles = win.parts.find((p) => p.group === "roles");
    log(
      `    ${label.padEnd(26)} ${win.shown.padEnd(10)} ${win.verdict.label.padEnd(24)} ` +
        `leads: ${lead.label} ${signed(lead.points, 1)} · roles ${signed(roles.points, 1)}`,
    );
  }
}

async function main() {
  const started = Date.now();
  log("Win-chance calibration");

  const files = {
    matchups: await readJson(join(DATA, "matchups.json")),
    synergies: await readJson(join(DATA, "synergies.json")),
    timings: await readJson(join(DATA, "timings.json")),
    positions: await readJson(join(DATA, "positions.json")),
    lanes: await readJson(join(DATA, "lanes.json")),
  };
  if (!files.matchups) throw new Error("public/data/matchups.json is missing — run the counters step first");
  const below = calibrationWindow(files.synergies, files.timings);
  if (below === null) {
    throw new Error("synergies.json and timings.json record no matchIdRange — run the synergies and timings steps first");
  }

  const data = withRankBand(
    buildDataset({
      matchupFile: { data: files.matchups },
      synergyFile: { data: files.synergies },
      timingFile: { data: files.timings },
      positionFile: { data: files.positions },
      laneFile: { data: files.lanes },
    }),
    "all",
  );
  const priors = new Map(data.heroes.filter((h) => h.positions).map((h) => [h.slug, h.positions]));
  const idToSlug = await heroIds();
  log(`  ${priors.size} heroes with positions, ${idToSlug.size} OpenDota ids mapped`);
  log(`  games strictly below match ${below.toLocaleString()}, the older edge of the synergy and timing samples\n`);

  const rows = await collect(below);
  const { samples, skipped } = samplesFrom(rows, data, idToSlug, priors);
  log(`\n  ${samples.length.toLocaleString()} line-ups scored, ${skipped.toLocaleString()} skipped for a hero the data does not know`);

  const result = fitCalibration(samples, {
    keys: [...WIN_FEATURES],
    taus: TAUS,
    vectorize: (sample, tau) => winFeatures(sample.features, tau),
    nonPositive: ["roleDeficit"],
  });
  report(result);

  const problems = calibrationProblems(result, { positive: POSITIVE });
  if (problems.length) {
    for (const problem of problems) warn(problem);
    throw new Error("the fit failed its checks; calibration.json was left as it was");
  }

  const ids = samples.map((s) => s.id);
  const lo = ids.reduce((m, id) => Math.min(m, id), Infinity);
  const hi = ids.reduce((m, id) => Math.max(m, id), -Infinity);
  const round = (n, digits) => Math.round(n * 10 ** digits) / 10 ** digits;
  const payload = {
    generatedAt: new Date().toISOString(),
    source: "https://api.opendota.com/api/explorer (public_matches)",
    note:
      "weights are log-odds per unit of each feature of src/lib/winModel.ts, fitted by logistic " +
      "regression on ranked All Pick games (lobby_type 7, game_mode 22) strictly older than the " +
      "synergy and timing samples; se are their standard errors, null where a sign constraint " +
      "pinned the weight at zero. side is the Radiant term, which the app leaves out. tau is the " +
      "role-deficit threshold in points per hero, chosen by two-fold held-out log-loss. " +
      "reliability rows are [from, to, team-games, mean predicted, actual win rate], out of fold " +
      "and read from both seats; range is the span of bins with at least 200 team-games. inputs " +
      "are the generatedAt of the data files the features were read from.",
    matches: result.matches,
    matchIdRange: [lo, hi],
    rankBand: "all",
    inputs: {
      matchups: files.matchups.generatedAt ?? null,
      positions: files.positions?.generatedAt ?? null,
      synergies: files.synergies?.generatedAt ?? null,
      timings: files.timings?.generatedAt ?? null,
    },
    tau: result.tau,
    weights: Object.fromEntries(Object.entries(result.weights).map(([k, w]) => [k, round(w, 6)])),
    se: Object.fromEntries(Object.entries(result.se).map(([k, s]) => [k, s === null ? null : round(s, 6)])),
    side: round(result.side, 6),
    holdout: {
      logLoss: round(result.holdout.logLoss, 6),
      baseline: round(result.holdout.baseline, 6),
      auc: round(result.holdout.auc, 4),
    },
    reliability: result.reliability.map(([from, to, games, predicted, actual]) => [
      from,
      to,
      games,
      round(predicted, 4),
      round(actual, 4),
    ]),
    range: result.range,
  };

  // Read back exactly as the app will read it: a file the app would refuse is not written.
  const calibration = readCalibration(payload);
  if (!calibration) throw new Error("the payload does not pass the app's own validation");
  sanity(data, calibration);

  if (options.dryRun) {
    log("\n  --dry-run: nothing written\n");
    return;
  }
  await writeFile(OUT_FILE, JSON.stringify(payload), "utf8");
  log(`\nWrote public/data/calibration.json`);
  log(`  ${((Date.now() - started) / 1000) | 0}s\n`);
}

main().catch((err) => {
  console.error(`\nCalibration failed: ${err.message}\n`);
  if (/HTTP 429|rate/i.test(err.message)) {
    console.error("  OpenDota rate-limited the run. Wait a minute and rerun — the line-ups fetched");
    console.error("  so far are not kept until a run finishes, so a free API key helps:");
    console.error("    OPENDOTA_API_KEY=... npm run calibrate\n");
  }
  process.exit(1);
});
```

- [ ] **Step 2: Add the npm script**

In `package.json`, replace:

```json
    "lanes": "node scripts/lanes.mjs",
```

with:

```json
    "lanes": "node scripts/lanes.mjs",
    "calibrate": "node --experimental-strip-types --no-warnings --import ./scripts/register-ts-resolve.mjs scripts/calibrate.mjs",
```

- [ ] **Step 3: Add the refresh step**

In `scripts/refresh.mjs`, replace:

```js
import { fileURLToPath } from "node:url";
```

with:

```js
import { fileURLToPath, pathToFileURL } from "node:url";
```

Replace:

```js
const SCRIPTS = join(ROOT, "scripts");
```

with:

```js
const SCRIPTS = join(ROOT, "scripts");

/**
 * Node flags for a step that runs the app's own TypeScript — see
 * scripts/ts-resolve.mjs. A file URL rather than a path, because `--import`
 * refuses a bare Windows path.
 */
const TS_NODE_ARGS = [
  "--experimental-strip-types",
  "--no-warnings",
  "--import",
  pathToFileURL(join(SCRIPTS, "register-ts-resolve.mjs")).href,
];
```

Replace:

```js
  {
    key: "readme",
    what: "the README's badges and data table, from the files above",
```

with:

```js
  {
    key: "calibrate",
    what: "what a draft is worth — the win-chance model, fitted on OpenDota games",
    script: "calibrate.mjs",
    args: [],
    nodeArgs: TS_NODE_ARGS,
    // After every collector: it fits the model on the files they just wrote,
    // from games older than the synergy and timing samples.
    describe: () =>
      describeJson("calibration.json", (d) => [
        `${thousands(d.matches)} matches`,
        `log-loss ${Number(d.holdout?.logLoss).toFixed(4)} vs ${Number(d.holdout?.baseline).toFixed(4)}`,
        `range ${Math.round((d.range?.[0] ?? 0) * 100)}–${Math.round((d.range?.[1] ?? 0) * 100)}%`,
      ]),
  },
  {
    key: "readme",
    what: "the README's badges and data table, from the files above",
```

Replace:

```js
    const child = spawn(
      process.execPath,
      [join(SCRIPTS, step.script), ...step.args, ...forwarded],
      { stdio: "inherit" },
    );
```

with:

```js
    const child = spawn(
      process.execPath,
      [...(step.nodeArgs ?? []), join(SCRIPTS, step.script), ...step.args, ...forwarded],
      { stdio: "inherit" },
    );
```

- [ ] **Step 4: Check the step list**

Run: `npm run refresh -- --list`
Expected: nine steps, with `calibrate   what a draft is worth — the win-chance model, fitted on OpenDota games` between `portraits` and `readme`.

- [ ] **Step 5: Dry-run the fit against real games**

Run: `npm run calibrate -- --dry-run` (network, one to three explorer requests, a minute or two).
Expected, in order:
- `games strictly below match 9,009,935,463` (or the lower edge of whatever synergy and timing samples are committed);
- a few hundred thousand line-ups scored;
- held-out log-loss about 0.672 against about 0.691, AUC about 0.61;
- every weight in `POSITIVE` positive and `roleDeficit` negative or pinned;
- calibration rows where predicted and won agree within about a point from 20% to 80%;
- figures shown between about 15% and 85%;
- sanity drafts, with "Five cores, as booked" under 15% and led by Roles, and "Five supports" at 33% or below and led by Roles;
- `--dry-run: nothing written`, exit code 0.

If a guardrail fires instead, stop and report it with the printed problems. Do not loosen a guardrail to get past it.

- [ ] **Step 6: Commit**

```bash
git add scripts/calibrate.mjs scripts/refresh.mjs package.json
git commit -m "Add the calibrate step: fit the win-chance model on OpenDota games"
```

---

### Task 5: The README row and NOTICE

**Files:**
- Modify: `scripts/readme-status.mjs` (`describeData`)
- Modify: `scripts/readme.mjs` (`main`)
- Modify: `scripts/readme-sync.test.mjs`
- Modify: `scripts/readme-status.test.mjs` (append a test)
- Modify: `NOTICE.md`
- Regenerate: `README.md` via `npm run readme`

**Interfaces:**
- Consumes: `calibration.json`'s `generatedAt`, `matches`, `matchIdRange`.
- Produces: a `calibration` row in `describeData`, `what: "Win model"`, `source: "OpenDota"`.

- [ ] **Step 1: Write the failing test**

Append to `scripts/readme-status.test.mjs`:

```js
test("the win model is dated by its match ids, like the other OpenDota samples", () => {
  const withModel = {
    ...FILES,
    calibration: { generatedAt: "2026-09-23T10:00:00.000Z", matches: 301_000, matchIdRange: [50, 99] },
  };
  const windows = { ...WINDOWS, "50-99": { from: at("2026-09-16T00:00:00Z"), to: at("2026-09-17T00:00:00Z") } };
  const row = describeData(withModel, { sampleWindows: windows }).find((r) => r.key === "calibration");
  assert.equal(row.what, "Win model");
  assert.equal(row.source, "OpenDota");
  assert.equal(row.sample, "301,000 matches");
  assert.equal(row.window.from, windows["50-99"].from);
  assert.match(
    dataTable(describeData(FILES, { sampleWindows: WINDOWS }), PATCHES),
    /\| Win model \| OpenDota \| not collected yet \|/,
  );
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test scripts/readme-status.test.mjs`
Expected: FAIL — `Cannot read properties of undefined (reading 'what')`.

- [ ] **Step 3: Add the row**

In `scripts/readme-status.mjs`, replace:

```js
  const { matchups, positions, lanes, synergies, timings } = files;
```

with:

```js
  const { matchups, positions, lanes, synergies, timings, calibration } = files;
```

and replace:

```js
  rows.push({
    key: "timings",
    what: "Game length",
    source: "OpenDota",
    file: timings,
    window: sampleWindow(timings),
    read: read(timings),
    sample: timings ? `${amount(timings.matches)} matches` : null,
  });

  return rows;
```

with:

```js
  rows.push({
    key: "timings",
    what: "Game length",
    source: "OpenDota",
    file: timings,
    window: sampleWindow(timings),
    read: read(timings),
    sample: timings ? `${amount(timings.matches)} matches` : null,
  });
  // Fitted from games older than the two samples above, so it is dated the same way.
  rows.push({
    key: "calibration",
    what: "Win model",
    source: "OpenDota",
    file: calibration,
    window: sampleWindow(calibration),
    read: read(calibration),
    sample: calibration ? `${amount(calibration.matches)} matches` : null,
  });

  return rows;
```

In `scripts/readme.mjs`, replace:

```js
  const names = ["matchups", "positions", "lanes", "synergies", "timings"];
```

with:

```js
  const names = ["matchups", "positions", "lanes", "synergies", "timings", "calibration"];
```

and replace:

```js
    loadSampleWindows([files.synergies, files.timings], problems),
```

with:

```js
    loadSampleWindows([files.synergies, files.timings, files.calibration], problems),
```

In `scripts/readme-sync.test.mjs`, replace:

```js
  const names = ["matchups", "positions", "lanes", "synergies", "timings"];
```

with:

```js
  const names = ["matchups", "positions", "lanes", "synergies", "timings", "calibration"];
```

- [ ] **Step 4: Run the README tests**

Run: `node --test scripts/readme-status.test.mjs`
Expected: PASS.

Run: `node --test scripts/readme-sync.test.mjs`
Expected: FAIL — `the data table has no Win model row`. The README has not been regenerated yet.

- [ ] **Step 5: Credit the file in NOTICE.md**

Replace:

```markdown
| Synergies and win rate by game length, from public match records | `public/data/synergies.json`, `public/data/timings.json` | [OpenDota](https://www.opendota.com/) |
```

with:

```markdown
| Synergies, win rate by game length and the win-chance model's weights, from public match records | `public/data/synergies.json`, `public/data/timings.json`, `public/data/calibration.json` | [OpenDota](https://www.opendota.com/) |
```

- [ ] **Step 6: Regenerate the README blocks and re-run the sync test**

Run: `npm run readme`
Expected: `README.md updated from the data files`, and a `calibration  no file` line.

Run: `node --test scripts/readme-sync.test.mjs`
Expected: PASS. `git diff README.md` shows one new row, `| Win model | OpenDota | not collected yet | | |`.

- [ ] **Step 7: Commit**

```bash
git add scripts/readme-status.mjs scripts/readme.mjs scripts/readme-sync.test.mjs scripts/readme-status.test.mjs NOTICE.md README.md
git commit -m "List the win model in the README data table and NOTICE"
```

---

### Task 6: Fit and commit `calibration.json`

**Files:**
- Generate: `public/data/calibration.json`, `README.md` (through `npm run refresh`)

**Interfaces:**
- Produces: the committed calibration every later task's browser checks read.

- [ ] **Step 1: Start from a clean tree**

Run: `git status --short`
Expected: no output. Anything listed stays out of this commit.

- [ ] **Step 2: Run the step through refresh**

Run: `npm run refresh -- --steps=calibrate`
Expected: the calibrate output as in Task 4 Step 5, ending `Wrote public/data/calibration.json`; then the `readme` step; then a summary with `ok  calibrate  … matches, log-loss 0.67xx vs 0.69xx, range 15–85%` and `ok  readme`. Exit code 0. The line-ups come from the Task 4 cache, so this should take seconds.

- [ ] **Step 3: Check the file and the README**

Run: `node --test scripts/readme-sync.test.mjs`
Expected: PASS.

Run: `git diff --stat`
Expected: `README.md` (the Win model row now shows its window, sample and patch) and `public/data/calibration.json` (new).

- [ ] **Step 4: Commit**

```bash
git add public/data/calibration.json README.md
git commit -m "Calibrate the win-chance model"
```

---

### Task 7: Load the calibration in the app

**Files:**
- Modify: `src/lib/dataset.ts` (import, `emptyDataset`, `loadDataset`, `DataFiles`, `buildDataset`)
- Modify: `src/lib/dataset.test.ts` (import, append tests)

**Interfaces:**
- Consumes: `readCalibration` from `./winModel`.
- Produces: `Dataset.calibration` on every dataset `buildDataset` and `emptyDataset` return; `DataFiles.calibrationFile?: { data: unknown }`.

- [ ] **Step 1: Write the failing tests**

In `src/lib/dataset.test.ts`, replace:

```ts
import { expandSynergies } from "./dataset.ts";
```

with:

```ts
import { buildDataset, expandSynergies } from "./dataset.ts";
```

Append:

```ts
const CALIBRATION_FILE = {
  generatedAt: "2026-09-23T00:00:00.000Z",
  matches: 300_000,
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
};

const files = (calibration?: unknown) =>
  ({
    matchupFile: {
      data: {
        generatedAt: "2026-09-19T00:00:00.000Z",
        heroes: [{ slug: "axe", name: "Axe" }],
        matchups: { axe: { lion: [1, 49, 5000] } },
      },
    },
    synergyFile: { data: null },
    timingFile: { data: null },
    positionFile: { data: null },
    laneFile: { data: null },
    ...(calibration === undefined ? {} : { calibrationFile: { data: calibration } }),
  }) as unknown as Parameters<typeof buildDataset>[0];

test("a calibration file is read, and a broken one is not", () => {
  assert.equal(buildDataset(files(CALIBRATION_FILE)).calibration?.tau, 1.5);
  assert.equal(buildDataset(files({ ...CALIBRATION_FILE, weights: {} })).calibration, null);
  assert.equal(buildDataset(files()).calibration, null, "no file, no calibration");
});

test("the calibration survives a dataset with no matchups", () => {
  const empty = { ...files(CALIBRATION_FILE), matchupFile: { data: null } } as Parameters<typeof buildDataset>[0];
  assert.equal(buildDataset(empty).calibration?.matches, 300_000);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test --experimental-strip-types --no-warnings --import ./scripts/register-ts-resolve.mjs src/lib/dataset.test.ts`
Expected: FAIL — `undefined !== 1.5`.

- [ ] **Step 3: Load it**

In `src/lib/dataset.ts`, replace:

```ts
import { deriveTimingShape } from "./timing";
```

with:

```ts
import { deriveTimingShape } from "./timing";
import { readCalibration } from "./winModel";
```

In `emptyDataset`, replace:

```ts
    timingMatches: 0,
    error,
  };
}
```

with:

```ts
    timingMatches: 0,
    calibration: null,
    error,
  };
}
```

In `loadDataset`, replace:

```ts
  const [matchupFile, synergyFile, timingFile, positionFile, laneFile] = await Promise.all([
    loadJson<RawPayload>("data/matchups.json", signal),
    loadJson<RawSynergyPayload>("data/synergies.json", signal),
    loadJson<RawTimingPayload>("data/timings.json", signal),
    loadJson<RawPositionPayload>("data/positions.json", signal),
    loadJson<RawLanePayload>("data/lanes.json", signal),
  ]);
  return buildDataset({ matchupFile, synergyFile, timingFile, positionFile, laneFile });
```

with:

```ts
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
```

In `interface DataFiles`, replace:

```ts
  laneFile: { data: RawLanePayload | null };
}
```

with:

```ts
  laneFile: { data: RawLanePayload | null };
  /** The win-chance model's weights. Optional: without it the analysis falls back to the comparison signal. */
  calibrationFile?: { data: unknown };
}
```

In `buildDataset`, replace:

```ts
  laneFile,
}: DataFiles): Dataset {
  const positionPayload = positionFile.data;
```

with:

```ts
  laneFile,
  calibrationFile,
}: DataFiles): Dataset {
  const positionPayload = positionFile.data;
  const calibration = readCalibration(calibrationFile?.data ?? null);
```

Replace:

```ts
    return {
      ...empty,
      positionBands,
```

with:

```ts
    return {
      ...empty,
      calibration,
      positionBands,
```

Replace:

```ts
    timingMatches,
    error: hasData ? null : "Matchup file loaded but contained no rows.",
  };
}
```

with:

```ts
    timingMatches,
    calibration,
    error: hasData ? null : "Matchup file loaded but contained no rows.",
  };
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `node --test --experimental-strip-types --no-warnings --import ./scripts/register-ts-resolve.mjs src/lib/dataset.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`
Expected: exits 0.

```bash
git add src/lib/dataset.ts src/lib/dataset.test.ts
git commit -m "Load the win-chance calibration beside the other data files"
```

---

### Task 8: The analysis reads the win chance

**Files:**
- Modify: `src/types.ts` (`DraftImpact`)
- Modify: `src/lib/analysis.ts` (imports, `DraftWin`, `DraftAnalysis.win`, `explainWin`, `analyseDraft`, `toMarkdown`, `talkingPoints`, `pickImpact`)
- Modify: `src/lib/analysis.test.ts` (imports, append tests)

**Interfaces:**
- Consumes: `winRead`, `rolesReason`, `WinRead`, `WinGroup` from `./winModel`.
- Produces:
  - `interface DraftWin extends WinRead { reasons: Record<WinGroup, string | null> }`
  - `DraftAnalysis.win: DraftWin | null`
  - `DraftImpact.unit: "chance" | "points"`; with `"chance"`, `before` and `after` are 0–100.

- [ ] **Step 1: Write the failing tests**

In `src/lib/analysis.test.ts`, replace:

```ts
import type { LaneModel } from "./lanes.ts";
```

with:

```ts
import type { LaneModel } from "./lanes.ts";
import type { Calibration } from "./winModel.ts";
```

Append to the end of the file:

```ts
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
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test --experimental-strip-types --no-warnings --import ./scripts/register-ts-resolve.mjs src/lib/analysis.test.ts`
Expected: FAIL — `a.win` is `undefined` ("calibrated").

- [ ] **Step 3: Give the preview a unit**

In `src/types.ts`, replace:

```ts
export interface DraftImpact {
  /** Headline advantage before the pick; null when there was nothing to read. */
  before: number | null;
  /** Headline advantage with the hero on the board. */
  after: number;
```

with:

```ts
export interface DraftImpact {
  /**
   * What `before` and `after` are measured in: points of win chance (0–100)
   * when the dataset carries a calibration, the signed comparison signal
   * otherwise.
   */
  unit: "chance" | "points";
  /** Headline figure before the pick; null when there was nothing to read. */
  before: number | null;
  /** Headline figure with the hero on the board. */
  after: number;
```

- [ ] **Step 4: Import the model in `analysis.ts`**

Replace:

```ts
import { NOISE, draftBalance, matchup, sharesLane, synergy } from "./scoring";
```

with:

```ts
import { NOISE, draftBalance, matchup, sharesLane, synergy } from "./scoring";
import { rolesReason, winRead } from "./winModel";
import type { WinGroup, WinRead } from "./winModel";
```

- [ ] **Step 5: Declare `DraftWin` and the field**

Replace:

```ts
export interface DraftAnalysis {
  lineups: { mine: LineupSlot[]; enemy: LineupSlot[] };
```

with:

```ts
/**
 * The win chance, with each part's reason in words.
 *
 * The model says how much each part moves the chance; this says *why*, from the
 * same board — the pairing behind the matchups, the pair behind the cohesion,
 * the hero behind the strength, the seats behind the roles.
 */
export interface DraftWin extends WinRead {
  reasons: Record<WinGroup, string | null>;
}

export interface DraftAnalysis {
  lineups: { mine: LineupSlot[]; enemy: LineupSlot[] };
  /**
   * The headline: the board as a calibrated win chance, from
   * public/data/calibration.json. Null without that file, and every consumer
   * then shows `advantage` and `verdict` as before. See docs/scoring.md,
   * "Win chance".
   */
  win: DraftWin | null;
```

- [ ] **Step 6: Write `explainWin`**

Immediately above:

```ts
/**
 * Break a draft down into the parts a player can act on.
```

insert:

```ts
/** Parts smaller than this, in points of win chance, get no reason: there is nothing to explain. */
const WIN_REASON_FLOOR = 0.5;

/** The reasons behind each part of the win chance, read off the same board. */
function explainWin(
  data: Dataset,
  win: WinRead,
  board: Pick<DraftAnalysis, "threats" | "edges" | "mySynergyPairs" | "theirSynergyPairs" | "stages" | "lineups">,
): DraftWin {
  const part = (group: WinGroup) => win.parts.find((p) => p.group === group)?.points ?? 0;
  const strongest = (slots: LineupSlot[]) =>
    slots
      .map((slot) => ({ slot, winRate: data.bySlug.get(slot.slug)?.winRate }))
      .filter((x): x is { slot: LineupSlot; winRate: number } => typeof x.winRate === "number")
      .sort((a, b) => b.winRate - a.winRate)[0];

  const matchups = part("matchups");
  const threat = board.threats[0];
  const edge = board.edges[0];
  const cohesion = part("cohesion");
  const theirPair = board.theirSynergyPairs.find((p) => p.synergy >= NOISE);
  const ourPair = board.mySynergyPairs.find((p) => p.synergy >= NOISE);
  const heroes = part("heroes");
  const theirBest = strongest(board.lineups.enemy);
  const ourBest = strongest(board.lineups.mine);
  const timing = part("timing");
  const stages = board.stages;

  return {
    ...win,
    reasons: {
      roles: rolesReason(win.roles),
      matchups:
        matchups <= -WIN_REASON_FLOOR && threat
          ? `${threat.theirs.name} beats ${threat.mine.name} by ${Math.abs(threat.advantage).toFixed(1)}`
          : matchups >= WIN_REASON_FLOOR && edge
            ? `${edge.mine.name} beats ${edge.theirs.name} by ${edge.advantage.toFixed(1)}`
            : null,
      cohesion:
        cohesion <= -WIN_REASON_FLOOR && theirPair
          ? `their ${theirPair.a.name} + ${theirPair.b.name} (${signed(theirPair.synergy)})`
          : cohesion >= WIN_REASON_FLOOR && ourPair
            ? `our ${ourPair.a.name} + ${ourPair.b.name} (${signed(ourPair.synergy)})`
            : null,
      heroes:
        heroes <= -WIN_REASON_FLOOR && theirBest
          ? `their ${theirBest.slot.name} wins ${theirBest.winRate.toFixed(1)}% of games`
          : heroes >= WIN_REASON_FLOOR && ourBest
            ? `our ${ourBest.slot.name} wins ${ourBest.winRate.toFixed(1)}% of games`
            : null,
      timing:
        Math.abs(timing) >= WIN_REASON_FLOOR && stages?.cover != null
          ? `heroes who work before the median game: us ${stages.cover.toFixed(1)}, them ` +
            `${stages.theirCover?.toFixed(1) ?? "unknown"}, of ${TARGET_EARLY_COVER} needed`
          : null,
    },
  };
}

```

- [ ] **Step 7: Compute `win` in `analyseDraft`**

Replace:

```ts
  const byAdvantage = [...pairs].sort((a, b) => a.advantage - b.advantage);

  return {
    lineups: { mine: draft.mine.map((p) => slot(data, p)), enemy: draft.enemy.map((p) => slot(data, p)) },
```

with:

```ts
  const byAdvantage = [...pairs].sort((a, b) => a.advantage - b.advantage);
  // "Pairings that matter" has to mean it. Any sign at all used to qualify,
  // so a +0.05 pairing could be listed as an edge by the same panel that had
  // just called half a point a coin flip.
  const threats = byAdvantage.filter((p) => p.advantage <= -NOISE).slice(0, 5);
  const edges = byAdvantage.filter((p) => p.advantage >= NOISE).reverse().slice(0, 5);
  const stages = stageRead(data, draft, settings);
  const lineups = {
    mine: draft.mine.map((p) => slot(data, p)),
    enemy: draft.enemy.map((p) => slot(data, p)),
  };
  const win = data.calibration
    ? explainWin(data, winRead(data, draft, data.calibration), {
        threats,
        edges,
        mySynergyPairs: mineSyn.pairs,
        theirSynergyPairs: theirSyn.pairs,
        stages,
        lineups,
      })
    : null;

  return {
    lineups,
    win,
```

and replace:

```ts
    // "Pairings that matter" has to mean it. Any sign at all used to qualify,
    // so a +0.05 pairing could be listed as an edge by the same panel that had
    // just called half a point a coin flip.
    threats: byAdvantage.filter((p) => p.advantage <= -NOISE).slice(0, 5),
    edges: byAdvantage.filter((p) => p.advantage >= NOISE).reverse().slice(0, 5),
    mySynergyPairs: mineSyn.pairs,
    theirSynergyPairs: theirSyn.pairs,
    stages: stageRead(data, draft, settings),
```

with:

```ts
    threats,
    edges,
    mySynergyPairs: mineSyn.pairs,
    theirSynergyPairs: theirSyn.pairs,
    stages,
```

- [ ] **Step 8: Lead the copy briefing with the chance**

In `toMarkdown`, replace:

```ts
  out.push(`**Draft ${pct(analysis.advantage)} — ${analysis.verdict.label.toLowerCase()}**`);
  out.push(
    `matchups ${pct(analysis.counter)} · cohesion ${pct(analysis.cohesionContribution)} · early cover ${pct(analysis.earlyEdge)}` +
      (analysis.complete ? "" : ` · draft in progress (${analysis.sides.mine}v${analysis.sides.enemy})`),
  );
```

with:

```ts
  const progress = analysis.complete ? "" : ` · draft in progress (${analysis.sides.mine}v${analysis.sides.enemy})`;
  if (analysis.win) {
    const win = analysis.win;
    out.push(`**Win chance ${win.shown} — ${win.verdict.label.toLowerCase()}**`);
    out.push(
      [...win.parts]
        .sort((a, b) => Math.abs(b.points) - Math.abs(a.points))
        .map((p) => `${p.label.toLowerCase()} ${pct(p.points)}`)
        .join(" · ") + progress,
    );
    if (win.reasons.roles) out.push(`Roles: ${win.reasons.roles}`);
  } else {
    out.push(`**Draft ${pct(analysis.advantage)} — ${analysis.verdict.label.toLowerCase()}**`);
    out.push(
      `matchups ${pct(analysis.counter)} · cohesion ${pct(analysis.cohesionContribution)} · early cover ${pct(analysis.earlyEdge)}` +
        progress,
    );
  }
```

and replace:

```ts
      `sample. Percentage points of win rate; anything under ${NOISE.toFixed(1)} is noise._`,
  );

  return out.join("\n");
}
```

with:

```ts
      `sample. Percentage points of win rate; anything under ${NOISE.toFixed(1)} is noise._`,
  );
  if (analysis.win) {
    out.push(
      `_Win chance from a model calibrated on ${analysis.win.matches.toLocaleString()} ranked games; ` +
        `each part is points of win chance against an even draft._`,
    );
  }

  return out.join("\n");
}
```

- [ ] **Step 9: Say the roles first in the talking points**

Replace:

```ts
const LANING_TALK = 5;
```

with:

```ts
const LANING_TALK = 5;

/**
 * Points of win chance the seats have to cost before the roles lead the talking
 * points: the size of a lost laning stage, and a line the other four have to
 * change their plan for.
 */
const ROLES_TALK = 5;
```

Replace:

```ts
export function talkingPoints(analysis: DraftAnalysis): string[] {
  const out: string[] = [];
  const contested = analysis.lanes.filter((l) => l.key !== "map" && l.contested && l.covered);
```

with:

```ts
export function talkingPoints(analysis: DraftAnalysis): string[] {
  const out: string[] = [];
  /**
   * Seats nobody on the side plays, said before anything else: the one line
   * here that means the draft itself is broken rather than one fight in it,
   * priced by the same model as the headline.
   */
  const roles = analysis.win?.parts.find((p) => p.group === "roles");
  if (roles && roles.points <= -ROLES_TALK && analysis.win?.reasons.roles) {
    out.push(`Fix the roles: ${analysis.win.reasons.roles} (${signed(roles.points)} points of win chance)`);
  }
  const contested = analysis.lanes.filter((l) => l.key !== "map" && l.contested && l.covered);
```

- [ ] **Step 10: Preview the chance on the hero card**

In `pickImpact`, replace:

```ts
  return { before: before?.advantage ?? null, after: after.advantage, lane };
}
```

with:

```ts
  if (data.calibration) {
    const calibration = data.calibration;
    const chance = (view: DraftView) => winRead(data, view, calibration).chance * 100;
    return { unit: "chance", before: before ? chance(draft) : null, after: chance(next), lane };
  }
  return { unit: "points", before: before?.advantage ?? null, after: after.advantage, lane };
}
```

- [ ] **Step 11: Run the analysis tests**

Run: `node --test --experimental-strip-types --no-warnings --import ./scripts/register-ts-resolve.mjs src/lib/analysis.test.ts`
Expected: PASS, including every test that predates this task.

- [ ] **Step 12: Typecheck**

Run: `npm run typecheck`
Expected: exits 0. `DraftImpact` gained a required field and `pickImpact` is the only place that builds one; if the typecheck names another, add `unit: "points"` there and nothing else.

- [ ] **Step 13: Commit**

```bash
git add src/types.ts src/lib/analysis.ts src/lib/analysis.test.ts
git commit -m "Read the draft as a win chance with a reason for every part"
```

---

### Task 9: The briefing leads with the roles

**Files:**
- Modify: `src/lib/draftInsights.ts`
- Modify: `src/lib/draftInsights.test.ts` (imports, append tests)

**Interfaces:**
- Consumes: `DraftAnalysis.win` (Task 8).
- Produces: `DraftInsight.kind` gains `"roles"`; the title `"Fix the roles first."` when Roles is the largest cost and at least 5 points; a `roles` insight first in the playbook when Roles costs 2 points or more.

- [ ] **Step 1: Write the failing tests**

In `src/lib/draftInsights.test.ts`, replace:

```ts
import type { Dataset, DraftPick, Hero, Position } from "../types.ts";
```

with:

```ts
import type { Dataset, DraftPick, Hero, Position } from "../types.ts";
import type { Calibration } from "./winModel.ts";

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
```

Append:

```ts
test("a draft whose seats cost the most leads with the roles", () => {
  const f = fixture();
  for (const h of f.data.heroes.filter((x) => x.slug.startsWith("ours"))) {
    h.positions = { 1: 0.02, 2: 0.02, 3: 0.02, 4: 0.02, 5: 0.92 };
    h.positionWinRate = { 1: 42, 2: 42, 3: 42, 4: 42, 5: 50 };
  }
  f.data.calibration = CALIBRATION;
  const b = buildBriefing(f.analyse());
  assert.equal(b.title, "Fix the roles first.");
  assert.match(b.description, /ours1 at 1 \(2\.0% of their games\)/);
  assert.match(b.description, /points of win chance — more than anything else on the board\.$/);
  assert.equal(b.insights[0]!.id, "roles");
  assert.match(b.insights[0]!.evidence, /wins 42\.0% at 1 against 50\.0% overall/);
});

test("without a calibration the briefing leads as it did", () => {
  const b = buildBriefing(fixture().analyse());
  assert.notEqual(b.title, "Fix the roles first.");
  assert.equal(b.insights.some((i) => i.id === "roles"), false);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test --experimental-strip-types --no-warnings --import ./scripts/register-ts-resolve.mjs src/lib/draftInsights.test.ts`
Expected: FAIL — the title is still `Survive the pressure. Play for your window.`.

- [ ] **Step 3: Add the kind and the thresholds**

In `src/lib/draftInsights.ts`, replace:

```ts
  kind: "timing" | "lane" | "threat" | "opportunity" | "synergy";
```

with:

```ts
  kind: "roles" | "timing" | "lane" | "threat" | "opportunity" | "synergy";
```

Replace:

```ts
const signed = (n: number) => formatSigned(n, 1);
```

with:

```ts
const signed = (n: number) => formatSigned(n, 1);

/** Points of win chance the seats must cost before the headline leads with them. */
const ROLES_HEADLINE = 5;
/** And before the playbook names them. */
const ROLES_INSIGHT = 2;
```

- [ ] **Step 4: Lead with the roles**

Replace:

```ts
  let title = "Find your edge. Make a plan.";
  let description = "Use the individual matchups to choose your fights; the draft score alone cannot tell you how to play.";
  if (!a.complete) {
```

with:

```ts
  // The seats, from the same model as the headline: when they are the largest
  // cost on the board, no lane or timing plan is the first thing to say.
  const roles = a.win?.parts.find((p) => p.group === "roles") ?? null;
  const rolesLead =
    roles !== null &&
    roles.points <= -ROLES_HEADLINE &&
    (a.win?.parts.every((p) => p.points >= roles.points) ?? false);

  let title = "Find your edge. Make a plan.";
  let description = "Use the individual matchups to choose your fights; the draft score alone cannot tell you how to play.";
  if (rolesLead && roles) {
    const reason = a.win?.reasons.roles ?? "Your heroes are booked into seats they rarely play";
    title = "Fix the roles first.";
    description =
      `${reason}. That costs about ${Math.round(-roles.points)} points of win chance — ` +
      "more than anything else on the board.";
  } else if (!a.complete) {
```

- [ ] **Step 5: Put the roles first in the playbook**

Replace:

```ts
  if (timingComplete && bestWindow && firstWindow) {
    const earlyBehind = buckets[0]!.edge <= -NOISE;
```

with:

```ts
  if (roles && roles.points <= -ROLES_INSIGHT && a.win) {
    const worst = [...a.win.roles.mine.seats].sort((x, y) => x.delta - y.delta)[0];
    insights.push({
      id: "roles",
      kind: "roles",
      tone: "bad",
      label: "ROLES",
      title: worst?.position ? `${worst.name} is out of position at ${worst.position}` : "Your seats are costing you",
      action:
        "Open Rebalance for seatings they actually play. If nobody can move, expect that seat to lose more of its games and plan support around it.",
      evidence:
        (worst && worst.seatWinRate !== null && worst.winRate !== null
          ? `${worst.name} wins ${worst.seatWinRate.toFixed(1)}% at ${worst.position} against ${worst.winRate.toFixed(1)}% overall. `
          : "") + `The win-chance model prices your seats at ${signed(roles.points)} points.`,
    });
  }

  if (timingComplete && bestWindow && firstWindow) {
    const earlyBehind = buckets[0]!.edge <= -NOISE;
```

- [ ] **Step 6: Run the tests to see them pass**

Run: `node --test --experimental-strip-types --no-warnings --import ./scripts/register-ts-resolve.mjs src/lib/draftInsights.test.ts`
Expected: PASS, including the three tests that predate this task.

- [ ] **Step 7: Typecheck and commit**

Run: `npm run typecheck`
Expected: exits 0.

```bash
git add src/lib/draftInsights.ts src/lib/draftInsights.test.ts
git commit -m "Lead the game plan with the roles when the seats cost the most"
```

---

### Task 10: The interface

**Files:**
- Modify: `src/components/DraftBriefing.tsx` (import, helpers, `GamePlan`)
- Modify: `src/components/DraftAnalysis.tsx` (imports, `SeatRow`, drift, tags, Roles card, footer)
- Modify: `src/App.tsx` (headline memo, the Draft analysis button)
- Modify: `src/components/HeroCard.tsx` (`Impact`)
- Modify: `src/styles.css`

**Interfaces:**
- Consumes: `DraftAnalysis.win`, `DraftWin` (Task 8); `calibrationDrift`, `SeatReport` (Tasks 1–2); `DraftImpact.unit` (Task 8).
- Produces: no new exports.

- [ ] **Step 1: The Game plan's headline and parts**

In `src/components/DraftBriefing.tsx`, replace:

```ts
import type { DraftAnalysis, LineupSlot, StageReport } from "../lib/analysis";
```

with:

```ts
import type { DraftAnalysis, DraftWin, LineupSlot, StageReport } from "../lib/analysis";
```

Replace:

```ts
type Heroes = Map<string, Hero>;
```

with:

```ts
type Heroes = Map<string, Hero>;

const winTone = (side: DraftWin["verdict"]["side"]) => (side === "even" ? "even" : side === "mine" ? "good" : "bad");
const wholePct = (n: number) => `${Math.round(n * 100)}%`;

/** The line under the chance: what drafts rated like this actually did, or why there is no such line. */
function winEvidence(win: DraftWin): string {
  if (!win.inRange) return `Model ${wholePct(win.chance)} · beyond the range the calibration can vouch for`;
  if (win.evidence) {
    return (
      `Drafts rated ${wholePct(win.evidence.from)}–${wholePct(win.evidence.to)} won ` +
      `${(win.evidence.actual * 100).toFixed(1)}% of ${win.evidence.games.toLocaleString()} line-ups it was not fitted on`
    );
  }
  return `Calibrated on ${win.matches.toLocaleString()} ranked games`;
}
```

In `GamePlan`, replace:

```tsx
  const threat = b.threats[0];
  return <div className="intel-overview">
```

with:

```tsx
  const threat = b.threats[0];
  const win = a.win;
  return <div className="intel-overview">
```

Replace:

```tsx
      <div className="intel-draft-score"><span className="intel-label">Draft edge</span><strong className={hasMatchups ? tone(a.advantage) : "even"}>{hasMatchups ? signed(a.advantage) : "—"}</strong><span>{hasMatchups ? a.verdict.label : "Insufficient matchup data"}</span><small>Comparison signal · not win probability</small></div>
```

with:

```tsx
      {win ? (
        <div className="intel-draft-score"><span className="intel-label">Win chance</span><strong className={winTone(win.verdict.side)}>{win.shown}</strong><span>{win.verdict.label}</span><small>{winEvidence(win)}</small></div>
      ) : (
        <div className="intel-draft-score"><span className="intel-label">Draft edge</span><strong className={hasMatchups ? tone(a.advantage) : "even"}>{hasMatchups ? signed(a.advantage) : "—"}</strong><span>{hasMatchups ? a.verdict.label : "Insufficient matchup data"}</span><small>Comparison signal · not win probability</small></div>
      )}
```

Replace:

```tsx
        <div className="intel-score-parts"><h4 className="intel-label">What moves the draft score</h4>{[
          ["Matchups", a.counter], ["Team chemistry", a.cohesionContribution], ["Early cover", a.earlyEdge],
        ].map(([label, value]) => <div key={label}><span>{label}</span><strong className={tone(value as number)}>{signed(value as number)}</strong></div>)}<small>Weighted contributions; totals may differ by 0.1 after rounding.</small></div>
```

with:

```tsx
        {win ? (
          <div className="intel-score-parts"><h4 className="intel-label">What moves the win chance</h4>{[...win.parts].sort((x, y) => Math.abs(y.points) - Math.abs(x.points)).map((p) => (
            <div key={p.group}><span>{p.label}{win.reasons[p.group] && <span className="intel-part-reason">{win.reasons[p.group]}</span>}</span><strong className={tone(p.points)}>{signed(p.points)}</strong></div>
          ))}<small>Points of win chance against an even draft; together they make {Math.round(win.chance * 100)}%.</small></div>
        ) : (
          <div className="intel-score-parts"><h4 className="intel-label">What moves the draft score</h4>{[
            ["Matchups", a.counter], ["Team chemistry", a.cohesionContribution], ["Early cover", a.earlyEdge],
          ].map(([label, value]) => <div key={label}><span>{label}</span><strong className={tone(value as number)}>{signed(value as number)}</strong></div>)}<small>Weighted contributions; totals may differ by 0.1 after rounding.</small></div>
        )}
```

- [ ] **Step 2: Styles for the reasons**

In `src/styles.css`, replace:

```css
.intel-score-parts small {
  display: block;
  margin-top: 6px;
  color: var(--text-dim);
  font-size: 10.5px;
}
```

with:

```css
.intel-score-parts small {
  display: block;
  margin-top: 6px;
  color: var(--text-dim);
  font-size: 10.5px;
}

.intel-score-parts > div > span {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.intel-part-reason {
  color: var(--text-dim);
  font-size: 10.5px;
  opacity: 0.85;
}
```

- [ ] **Step 3: The Deep dive's tags, Roles card and footer**

In `src/components/DraftAnalysis.tsx`, replace:

```ts
import type { Dataset } from "../types";
```

with:

```ts
import type { Dataset, Hero } from "../types";
import { calibrationDrift } from "../lib/winModel";
import type { SeatReport } from "../lib/winModel";
```

Immediately above:

```ts
/**
 * The draft taken apart.
```

insert:

```tsx
/** One hero's seat: where they are booked, how often they play there, and what it does to their record. */
function SeatRow({ seat, hero }: { seat: SeatReport; hero: Hero | undefined }) {
  const share =
    seat.share === null
      ? null
      : seat.share < 0.1
        ? (seat.share * 100).toFixed(1)
        : String(Math.round(seat.share * 100));
  return (
    <div className="hero-row">
      {hero && <HeroPortrait hero={hero} className="portrait-sm" />}
      <div className="hero-row-body">
        <div className="lane-top">
          <span className="lane-name">
            {seat.name}
            {seat.position ? <span className="muted"> · {seat.position}</span> : null}
          </span>
          <span className={`lane-value ${tone(seat.delta)}`}>{formatSigned(seat.delta, 1)}</span>
        </div>
        <p className="lane-note muted">
          {share === null ? "no position data" : `${share}% of their games`}
          {seat.seatWinRate !== null && seat.winRate !== null
            ? ` · ${seat.seatWinRate.toFixed(1)}% here, ${seat.winRate.toFixed(1)}% overall`
            : ""}
        </p>
      </div>
    </div>
  );
}

```

Replace:

```ts
  const briefing = useMemo(() => buildBriefing(analysis), [analysis]);
```

with:

```ts
  const briefing = useMemo(() => buildBriefing(analysis), [analysis]);
  const drift = useMemo(() => calibrationDrift(data), [data]);
```

Replace:

```tsx
              lanes swapped
            </span>
          )}
          <span
            className={`tag ${thin ? "tag-bad" : ""}`}
```

with:

```tsx
              lanes swapped
            </span>
          )}
          {!analysis.win && (
            <span
              className="tag tag-warn"
              title="public/data/calibration.json is missing or unreadable, so the headline is a comparison signal between the two line-ups rather than a win chance. `npm run calibrate` builds it."
            >
              uncalibrated
            </span>
          )}
          {analysis.win && drift.length > 0 && (
            <span
              className="tag tag-warn"
              title={`The win-chance weights were fitted against different ${drift.join(", ")} files from the ones loaded now. \`npm run calibrate\` refits them.`}
            >
              calibration predates data
            </span>
          )}
          <span
            className={`tag ${thin ? "tag-bad" : ""}`}
```

Replace:

```tsx
            </div>
          ))}
        </article>

        <article className="analysis-card">
          <h3>Pairings that matter</h3>
```

with:

```tsx
            </div>
          ))}
        </article>

        {analysis.win && (
          <article className="analysis-card">
            <h3>Roles</h3>
            <p className="analysis-card-sub muted">
              {"Each hero's seat, the share of their games played there, and their win rate there against their own. "}
              {`Seats move the win chance by ${formatSigned(
                analysis.win.parts.find((p) => p.group === "roles")?.points ?? 0,
                1,
              )} points.`}
            </p>
            <h4 className="analysis-sub-head">
              {`Ours${
                analysis.win.roles.mine.noSupports
                  ? " — nobody supports"
                  : analysis.win.roles.mine.noCores
                    ? " — nobody farms"
                    : ""
              }`}
            </h4>
            {analysis.win.roles.mine.seats.map((seat) => (
              <SeatRow key={seat.slug} seat={seat} hero={data.bySlug.get(seat.slug)} />
            ))}
            <h4 className="analysis-sub-head">
              {`Theirs${
                analysis.win.roles.theirs.noSupports
                  ? " — nobody supports"
                  : analysis.win.roles.theirs.noCores
                    ? " — nobody farms"
                    : ""
              }`}
            </h4>
            {analysis.win.roles.theirs.seats.map((seat) => (
              <SeatRow key={`them-${seat.slug}`} seat={seat} hero={data.bySlug.get(seat.slug)} />
            ))}
          </article>
        )}

        <article className="analysis-card">
          <h3>Pairings that matter</h3>
```

Replace the footer (the apostrophe in "hero’s" is U+2019, and the blank line before `</p>` is part of the text):

```tsx
      <p className="analysis-foot muted" hidden={compact || view !== "details"}>
        Matchup and synergy edges are measured over whole games. Lane share describes lane wins
        plus half of draws; form describes game results from that lane. Timing skews are relative
        to each hero’s own baseline. The composite draft score is a comparison signal, not a win
        probability. Edges below {NOISE.toFixed(1)} points are treated as noise.

      </p>
```

with:

```tsx
      <p className="analysis-foot muted" hidden={compact || view !== "details"}>
        Matchup and synergy edges are measured over whole games. Lane share describes lane wins
        plus half of draws; form describes game results from that lane. Timing skews are relative
        to each hero’s own baseline.{" "}
        {analysis.win
          ? `The win chance comes from a model fitted on ${analysis.win.matches.toLocaleString()} ranked games and checked on games it was not fitted on; it prices roles, matchups, cohesion, hero strength and timing, and nothing about the players.`
          : "The composite draft score is a comparison signal, not a win probability."}{" "}
        Edges below {NOISE.toFixed(1)} points are treated as noise.
      </p>
```

- [ ] **Step 4: The top-bar button**

In `src/App.tsx`, replace:

```ts
  const analysis = useMemo(
    () => (dataset.hasData ? analyseDraft(dataset, draft, settings, TEAM_SIZE) : null),
    [dataset, draft, settings],
  );
```

with:

```ts
  const analysis = useMemo(
    () => (dataset.hasData ? analyseDraft(dataset, draft, settings, TEAM_SIZE) : null),
    [dataset, draft, settings],
  );

  /**
   * The figure on the Draft analysis button and what it says on hover: the win
   * chance when the data carries a calibration, the signed comparison signal
   * otherwise. Worked out once so the chip and its tooltip cannot disagree.
   */
  const headline = useMemo(() => {
    if (!analysis) return null;
    const opens = "Opens the game plan, the matchup map and the full breakdown.";
    const win = analysis.win;
    if (win) {
      const parts = [...win.parts]
        .sort((a, b) => Math.abs(b.points) - Math.abs(a.points))
        .filter((p) => Math.abs(p.points) >= 0.05)
        .map((p) => `${p.label.toLowerCase()} ${formatSigned(p.points, 1)}`)
        .join(", ");
      return {
        text: win.short,
        side: win.verdict.side,
        title:
          `${win.verdict.label} — win chance ${win.shown}${parts ? ` (${parts})` : ""}. ` +
          `Calibrated on ${win.matches.toLocaleString()} ranked games. ${opens}`,
      };
    }
    return {
      text: formatSigned(analysis.advantage, 1),
      side: analysis.verdict.side,
      title:
        `${analysis.verdict.label} — matchups ${formatSigned(analysis.counter, 1)}, ` +
        `cohesion ${formatSigned(analysis.synergyEdge, 1)}. ${opens}`,
    };
  }, [analysis]);
```

Replace:

```tsx
              title={
                analysis
                  ? `${analysis.verdict.label} — matchups ${formatSigned(analysis.counter, 1)}, ` +
                    `cohesion ${formatSigned(analysis.synergyEdge, 1)}. ` +
                    "Opens the game plan, the matchup map and the full breakdown."
                  : "Put a hero on each team to analyse the draft"
              }
            >
              Draft analysis
              {analysis && (
                <span
                  className={`num-chip ${
                    analysis.verdict.side === "even"
                      ? ""
                      : analysis.verdict.side === "mine"
                        ? "good"
                        : "bad"
                  }`}
                >
                  {formatSigned(analysis.advantage, 1)}
                </span>
              )}
            </button>
```

with:

```tsx
              title={headline ? headline.title : "Put a hero on each team to analyse the draft"}
            >
              Draft analysis
              {headline && (
                <span
                  className={`num-chip ${
                    headline.side === "even" ? "" : headline.side === "mine" ? "good" : "bad"
                  }`}
                >
                  {headline.text}
                </span>
              )}
            </button>
```

- [ ] **Step 5: The hero card's preview**

In `src/components/HeroCard.tsx`, replace the whole `Impact` function, from `function Impact({ impact, mode }: { impact: DraftImpact; mode: ScoreMode }) {` to its closing `}` just above `/** One face in a row: a hero, the figure under them, and what it means. */`, with:

```tsx
function Impact({ impact, mode }: { impact: DraftImpact; mode: ScoreMode }) {
  const chance = impact.unit === "chance";
  const move = impact.after - (impact.before ?? 0);
  const shownMove = chance ? Math.round(move) : move;
  const arrow = mode === "ban" ? "if they take them" : "if you take them";
  const label = chance ? "win chance " : "draft ";
  const figure = (n: number) => (chance ? `${Math.round(n)}%` : formatSigned(n, 1));
  const good = (n: number) => (chance ? n >= 50 : n >= 0);
  return (
    <section className="hc-section hc-impact">
      <h4>The board afterwards</h4>
      <p className="hc-impact-line">
        {impact.before === null ? (
          <>
            <span className="muted">{label}</span>
            <strong className={good(impact.after) ? "good" : "bad"}>{figure(impact.after)}</strong>
          </>
        ) : (
          <>
            <span className="muted">{label}</span>
            <span className="hc-impact-from">{figure(impact.before)}</span>
            <span className="muted" aria-label="becomes">
              {" → "}
            </span>
            <strong className={good(impact.after) ? "good" : "bad"}>{figure(impact.after)}</strong>
            <span className={`hc-impact-move ${shownMove >= 0 ? "good" : "bad"}`}>
              {`(${formatSigned(shownMove, chance ? 0 : 1)})`}
            </span>
          </>
        )}
        <span className="muted"> {arrow}</span>
      </p>
      {impact.lane && (
        <p className="hc-impact-lane muted">
          {`${impact.lane.label} ${formatSigned(impact.lane.delta, 1)} → ${formatSigned(
            impact.lane.after,
            1,
          )}`}
          {" · the front this pick moves most"}
        </p>
      )}
    </section>
  );
}
```

- [ ] **Step 6: Typecheck and build**

Run: `npm run typecheck`
Expected: exits 0.

Run: `npm run build`
Expected: `✓ built in …`, no errors.

- [ ] **Step 7: Verify in the browser**

Start the preview with `preview_start {name: "picker"}` (`.claude/launch.json` already defines it). Put the problem draft on the board through `javascript_tool`, then reload:

```js
localStorage.setItem("dotabuff-picker.draft.v3", JSON.stringify({
  mine: [["anti-mage", 1], ["meepo", 2], ["sven", 3], ["lifestealer", 4], ["arc-warden", 5]].map(([slug, position]) => ({ slug, position })),
  enemy: [["leshrac", 1], ["lina", 2], ["enigma", 3], ["bounty-hunter", 4], ["earthshaker", 5]].map(([slug, position]) => ({ slug, position })),
  banned: [],
  lanePlan: "standard",
}));
location.reload();
```

Check with `read_page` or `find`:
- the Draft analysis chip reads `<15%` and is red, and its tooltip begins `You are being run over — win chance under 15% (roles …`;
- clicking Draft analysis shows, on Game plan, `Win chance`, `under 15%`, `You are being run over`, `Model …% · beyond the range the calibration can vouch for`, and the title `Fix the roles first.` with `Nobody on your side supports: Lifestealer at 4 …`;
- the first playbook item is `ROLES`, `Lifestealer is out of position at 4`;
- "What moves the win chance" lists Roles first, with its reason, and the note says the parts make the model's percentage;
- Deep dive has a Roles card, `Ours — nobody supports`, with Lifestealer at 4 showing about `0.5% of their games · 39.6% here, 53.3% overall`;
- `read_console_messages` with `onlyErrors: true` is empty.

Take a `computer` screenshot of Game plan and one of the Roles card for the report. Reset any viewport change afterwards.

- [ ] **Step 8: Commit**

```bash
git add src/components/DraftBriefing.tsx src/components/DraftAnalysis.tsx src/App.tsx src/components/HeroCard.tsx src/styles.css
git commit -m "Show the win chance, its parts and the roles in the analysis"
```

---

### Task 11: Rebalance ranks by win chance

**Files:**
- Modify: `src/lib/rebalance.ts` (imports, `ArrangementScore`, `Gain`, `RebalanceReport.threshold` doc, `CHANCE_GAIN`, `readArrangement`, `rebalance`)
- Modify: `src/lib/rebalanceCopy.ts` (imports, unit and figure helpers, `headlineFor`, `breakdownOf`, `buttonLabel`, `buttonTitle`)
- Modify: `src/components/Rebalance.tsx` (import, three strings)
- Modify: `src/lib/rebalance.test.ts` (imports, append tests)

**Interfaces:**
- Consumes: `winRead`, `verdictForChance`, `WIN_GROUPS`, `WinGroup`, `GROUP_LABEL` from `./winModel`.
- Produces:
  - `ArrangementScore.chance: number | null`, `ArrangementScore.shown: string | null` (the chance as the headline prints it, `under 15%` beyond the range), `ArrangementScore.parts: Record<WinGroup, number> | null`; `total = chance` when calibrated
  - `Gain.chance`, `Gain.parts`
  - `CHANCE_GAIN = 1`
  - `CHANCE_UNIT = "win chance"`, `unitOf(option)`, `boardFigure(score)`, `thresholdText(report)` from `rebalanceCopy.ts`

- [ ] **Step 1: Write the failing tests**

In `src/lib/rebalance.test.ts`, replace:

```ts
import { MAX_SEAT_COST, arrangementId, rebalance, rebalanceReadiness, scoreArrangement } from "./rebalance.ts";
```

with:

```ts
import {
  CHANCE_GAIN,
  MAX_SEAT_COST,
  arrangementId,
  rebalance,
  rebalanceReadiness,
  scoreArrangement,
} from "./rebalance.ts";
import type { Calibration } from "./winModel.ts";
```

Append:

```ts
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

test("with a calibration an arrangement is scored by its win chance", () => {
  const calibrated: Dataset = { ...makeDataset(), calibration: CALIBRATION };
  const score = scoreArrangement(calibrated, draft, settings, { picks: draft.mine, lanePlan: "standard" });
  assert.ok(score.chance !== null && score.chance > 0 && score.chance < 100);
  assert.equal(score.total, score.chance);
  const plain = scoreArrangement(data, draft, settings, { picks: draft.mine, lanePlan: "standard" });
  assert.equal(plain.chance, null, "without one it is the objective it always was");
  assert.ok(Math.abs(plain.total - (plain.advantage + plain.fit + plain.lanes)) < 1e-12);
});

test("a lane swap leaves the win chance where it was", () => {
  const calibrated: Dataset = { ...makeDataset(), calibration: CALIBRATION };
  const standard = scoreArrangement(calibrated, draft, settings, { picks: draft.mine, lanePlan: "standard" });
  const swapped = scoreArrangement(calibrated, draft, settings, { picks: draft.mine, lanePlan: "swapped" });
  assert.equal(swapped.chance, standard.chance);
});

test("a stranded carry is put back, and the gain is counted in points of win chance", () => {
  const calibrated: Dataset = { ...makeDataset(), calibration: CALIBRATION };
  const stranded: DraftView = {
    ...draft,
    mine: [pick("alpha", 2), pick("beta", 3), pick("carry", 4), pick("sup4", 1), pick("sup5", 5)],
  };
  const report = rebalance(calibrated, stranded, settings)!;
  assert.ok(report.current.chance! < 50, `the board reads ${report.current.chance}`);
  assert.equal(report.threshold, CHANCE_GAIN);
  assert.equal(report.best?.reason, "seat");
  assert.ok(report.best!.gain.total > 5, `putting them back is worth ${report.best!.gain.total}`);
  assert.equal(report.best!.gain.total, report.best!.gain.chance);
  assert.equal(headlineFor(report.best!).unit, "win chance");
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test --experimental-strip-types --no-warnings --import ./scripts/register-ts-resolve.mjs src/lib/rebalance.test.ts`
Expected: FAIL — `does not provide an export named 'CHANCE_GAIN'`.

- [ ] **Step 3: Score arrangements by the chance**

In `src/lib/rebalance.ts`, replace:

```ts
import { POSITIONS, canPlay, positionFit, positionWinRate } from "./roles";
```

with:

```ts
import { POSITIONS, canPlay, positionFit, positionWinRate } from "./roles";
import { WIN_GROUPS, verdictForChance, winRead } from "./winModel";
import type { WinGroup } from "./winModel";
```

Replace:

```ts
  lanes: number;
  /** `advantage + fit + lanes` — what arrangements are ranked on. */
  total: number;
}
```

with:

```ts
  lanes: number;
  /**
   * The win chance of the board arranged this way, in points (0–100), when the
   * dataset carries a calibration; null otherwise. With it, this is what
   * arrangements are ranked on: seats and the role deficit are inside the
   * model, fitted on how seats actually go, and the lane read measured nothing
   * on real games. See docs/scoring.md, "Scoring an arrangement".
   */
  chance: number | null;
  /** `chance` as the headline prints it — "38%", or "under 15%" beyond the calibrated range. */
  shown: string | null;
  /** `chance` by group, in points; null without a calibration. */
  parts: Record<WinGroup, number> | null;
  /** What arrangements are ranked on: `chance` when calibrated, `advantage + fit + lanes` otherwise. */
  total: number;
}
```

Replace:

```ts
export interface Gain {
  advantage: number;
  fit: number;
  lanes: number;
  total: number;
}
```

with:

```ts
export interface Gain {
  advantage: number;
  fit: number;
  lanes: number;
  /** Points of win chance, when calibrated. */
  chance: number | null;
  /** That change by group; the parts add up to `chance`. */
  parts: Record<WinGroup, number> | null;
  total: number;
}
```

Replace:

```ts
  /** The noise floor this search used, so nothing downstream has to restate it. */
  threshold: number;
```

with:

```ts
  /**
   * The qualifying floor this search used — a point of win chance when
   * calibrated, the noise floor otherwise — so nothing downstream has to
   * restate it.
   */
  threshold: number;
```

Replace:

```ts
export const MAX_SEAT_COST = 2;
```

with:

```ts
export const MAX_SEAT_COST = 2;

/**
 * Points of win chance an arrangement has to add to be offered on its figure
 * alone, when the dataset carries a calibration. The comparison signal's half
 * point was worth about four and a half points of win chance on real games; one
 * is the smallest change worth asking a player to move for. `MAX_SEAT_COST` is
 * read in the same points when calibrated.
 */
export const CHANCE_GAIN = 1;
```

Replace:

```ts
  const advantage = draftBalance(data, view, settings)?.advantage ?? 0;
  const fit = lineupFit(data, arrangement.picks, settings);
  const board = laneScoreboard(data, view, settings);
  const lanes = laningEdge(board);
  return { score: { advantage, fit, lanes, total: advantage + fit + lanes }, board };
```

with:

```ts
  const advantage = draftBalance(data, view, settings)?.advantage ?? 0;
  const fit = lineupFit(data, arrangement.picks, settings);
  const board = laneScoreboard(data, view, settings);
  const lanes = laningEdge(board);
  const win = data.calibration ? winRead(data, view, data.calibration) : null;
  const chance = win ? win.chance * 100 : null;
  const parts = win
    ? (Object.fromEntries(win.parts.map((p) => [p.group, p.points])) as Record<WinGroup, number>)
    : null;
  return {
    score: {
      advantage,
      fit,
      lanes,
      chance,
      shown: win ? win.shown : null,
      parts,
      total: chance ?? advantage + fit + lanes,
    },
    board,
  };
```

- [ ] **Step 4: Search on the chance's floor**

Replace:

```ts
  const current = board.score;
  const currentLanes = board.board;
```

with:

```ts
  const current = board.score;
  const currentLanes = board.board;
  /**
   * The qualifying floor, in the units `total` is in: a point of win chance
   * when calibrated, the app's half-point noise floor on the comparison signal
   * otherwise.
   */
  const floor = current.chance !== null ? CHANCE_GAIN : NOISE;
  const verdictOf = (score: ArrangementScore) =>
    score.chance !== null ? verdictForChance(score.chance / 100).label : verdictFor(score.advantage).label;
```

Replace:

```ts
      const gain: Gain = {
        advantage: score.advantage - current.advantage,
        fit: score.fit - current.fit,
        lanes: score.lanes - current.lanes,
        total: score.total - current.total,
      };
```

with:

```ts
      const gain: Gain = {
        advantage: score.advantage - current.advantage,
        fit: score.fit - current.fit,
        lanes: score.lanes - current.lanes,
        chance: score.chance !== null && current.chance !== null ? score.chance - current.chance : null,
        parts:
          score.parts && current.parts
            ? (Object.fromEntries(
                WIN_GROUPS.map((group) => [group, score.parts![group] - current.parts![group]]),
              ) as Record<WinGroup, number>)
            : null,
        total: score.total - current.total,
      };
```

Replace:

```ts
      if (gain.total <= -NOISE && !fixesSeats) continue;
      const qualifies = gain.total >= NOISE;
```

with:

```ts
      if (gain.total <= -floor && !fixesSeats) continue;
      const qualifies = gain.total >= floor;
```

Replace:

```ts
        verdict: verdictFor(score.advantage).label,
```

with:

```ts
        verdict: verdictOf(score),
```

Replace:

```ts
    .filter((c) => oneMoveAway.has(c.id) && (c.gain.total >= NOISE || c.reason === "seat"))
```

with:

```ts
    .filter((c) => oneMoveAway.has(c.id) && (c.gain.total >= floor || c.reason === "seat"))
```

Replace:

```ts
    currentVerdict: verdictFor(current.advantage).label,
```

with:

```ts
    currentVerdict: verdictOf(current),
```

Replace:

```ts
    threshold: NOISE,
```

with:

```ts
    threshold: floor,
```

- [ ] **Step 5: Word it in win chance**

In `src/lib/rebalanceCopy.ts`, replace:

```ts
import { POSITION_LABEL } from "./roles";
import { formatSigned } from "./scoring";
import type { Readiness, RebalanceOption, RebalanceReport } from "./rebalance";
```

with:

```ts
import { POSITION_LABEL } from "./roles";
import { formatSigned } from "./scoring";
import { GROUP_LABEL, WIN_GROUPS } from "./winModel";
import type { ArrangementScore, Readiness, RebalanceOption, RebalanceReport } from "./rebalance";
```

Replace:

```ts
export const TOTAL_UNIT = "overall";
```

with:

```ts
export const TOTAL_UNIT = "overall";

/** The unit of `total` when the dataset carries a calibration. */
export const CHANCE_UNIT = "win chance";

/** What an option's figures are points *of*. */
export const unitOf = (option: RebalanceOption): string =>
  option.score.chance !== null ? CHANCE_UNIT : TOTAL_UNIT;

/**
 * A board's headline figure as the panel prints it: the win chance exactly as
 * the Draft analysis headline shows it — a bound beyond the calibrated range —
 * or the signed comparison signal.
 */
export const boardFigure = (score: ArrangementScore): string =>
  score.shown !== null ? `${score.shown} to win` : formatSigned(score.advantage, 1);

/** The qualifying floor, with its unit. */
export const thresholdText = (report: RebalanceReport): string =>
  report.current.chance !== null
    ? `${report.threshold} point${report.threshold === 1 ? "" : "s"} of win chance`
    : `${report.threshold.toFixed(1)} points`;
```

In `headlineFor`, replace:

```ts
    const cost = option.gain.total;
    return {
      // The cost, not the count. A seat repair is the one thing on this panel
      // that can be worth taking at a loss, so the figure the reader needs is
      // what it costs — the reason it is on the list is the sentence next to it.
      value: formatSigned(cost, 1),
      unit: TOTAL_UNIT,
      tone: cost >= 0 ? "good" : "warn",
      title:
        `${who} ${option.repairedSeats.length === 1 ? "is" : "are"} booked into a position ` +
        `they hardly ever play. This puts them somewhere they do, and ` +
        (cost >= 0
          ? `costs nothing — the board is worth ${formatSigned(cost, 1)} more arranged this way.`
          : `costs ${formatSigned(-cost, 1)} points of the overall figure to do it.`),
    };
  }
  if (option.reason === "score") {
    return {
      value: formatSigned(option.gain.total, 1),
      unit: TOTAL_UNIT,
      tone: "good",
      title:
        "What this arrangement is worth all told: the change to the draft figure plus the " +
        "change in how well your five suit the seats they would take. Both halves are broken " +
        "out below.",
    };
  }
```

with:

```ts
    const cost = option.gain.total;
    const calibrated = option.score.chance !== null;
    return {
      // The cost, not the count. A seat repair is the one thing on this panel
      // that can be worth taking at a loss, so the figure the reader needs is
      // what it costs — the reason it is on the list is the sentence next to it.
      value: formatSigned(cost, 1),
      unit: unitOf(option),
      tone: cost >= 0 ? "good" : "warn",
      title:
        `${who} ${option.repairedSeats.length === 1 ? "is" : "are"} booked into a position ` +
        `they hardly ever play. This puts them somewhere they do, and ` +
        (cost >= 0
          ? calibrated
            ? `costs nothing — the win chance is ${formatSigned(cost, 1)} points higher arranged this way.`
            : `costs nothing — the board is worth ${formatSigned(cost, 1)} more arranged this way.`
          : calibrated
            ? `costs ${formatSigned(-cost, 1)} points of win chance to do it.`
            : `costs ${formatSigned(-cost, 1)} points of the overall figure to do it.`),
    };
  }
  if (option.reason === "score") {
    return {
      value: formatSigned(option.gain.total, 1),
      unit: unitOf(option),
      tone: "good",
      title:
        option.score.chance !== null
          ? "How much this arrangement adds to the win chance, in points. The parts that moved are " +
            "listed below; the lane read beside them is for information and is not in the figure."
          : "What this arrangement is worth all told: the change to the draft figure plus the " +
            "change in how well your five suit the seats they would take. Both halves are broken " +
            "out below.",
    };
  }
```

Replace:

```ts
export const breakdownOf = (option: RebalanceOption): string =>
  `draft ${formatSigned(option.gain.advantage, 1)} · lanes ${formatSigned(
    option.gain.lanes,
    1,
  )} · seats ${formatSigned(option.gain.fit, 1)}`;
```

with:

```ts
export const breakdownOf = (option: RebalanceOption): string => {
  const parts = option.gain.parts;
  if (!parts) {
    return `draft ${formatSigned(option.gain.advantage, 1)} · lanes ${formatSigned(
      option.gain.lanes,
      1,
    )} · seats ${formatSigned(option.gain.fit, 1)}`;
  }
  // The parts that moved, then the lane read, which is not in the figure but
  // is the one thing on this line a captain can check against what they see.
  const moved = WIN_GROUPS.filter((group) => Math.abs(parts[group]) >= 0.05).map(
    (group) => `${GROUP_LABEL[group].toLowerCase()} ${formatSigned(parts[group], 1)}`,
  );
  return [...moved, `lane read ${formatSigned(option.gain.lanes, 1)}`].join(" · ");
};
```

Replace:

```ts
  if (best?.reason === "score") {
    return `Rebalance ${formatSigned(best.gain.total, 1)} ${TOTAL_UNIT}`;
  }
```

with:

```ts
  if (best?.reason === "score") {
    return `Rebalance ${formatSigned(best.gain.total, 1)} ${unitOf(best)}`;
  }
```

Replace:

```ts
  if (best?.reason === "score") {
    return (
      `Your five are worth ${formatSigned(best.gain.total, 1)} more arranged differently ` +
      `(${breakdownOf(best)}) — click for the options`
    );
  }
```

with:

```ts
  if (best?.reason === "score") {
    return best.score.chance !== null
      ? `Your five gain ${formatSigned(best.gain.total, 1)} points of win chance arranged differently ` +
          `(${breakdownOf(best)}) — click for the options`
      : `Your five are worth ${formatSigned(best.gain.total, 1)} more arranged differently ` +
          `(${breakdownOf(best)}) — click for the options`;
  }
```

- [ ] **Step 6: The panel's three sentences**

In `src/components/Rebalance.tsx`, replace:

```ts
import { breakdownOf, costOf, describeOption, headlineFor } from "../lib/rebalanceCopy";
```

with:

```ts
import {
  boardFigure,
  breakdownOf,
  costOf,
  describeOption,
  headlineFor,
  thresholdText,
} from "../lib/rebalanceCopy";
```

Replace:

```tsx
          {` · leaves the draft at ${formatSigned(option.score.advantage, 1)}, ${option.verdict.toLowerCase()}`}
```

with:

```tsx
          {` · leaves the draft at ${boardFigure(option.score)}, ${option.verdict.toLowerCase()}`}
```

Replace:

```tsx
              {`Same five heroes, different seats. The draft reads ${formatSigned(
                report.current.advantage,
                1,
              )} — ${report.currentVerdict.toLowerCase()}.`}
```

with:

```tsx
              {`Same five heroes, different seats. The draft reads ${boardFigure(
                report.current,
              )} — ${report.currentVerdict.toLowerCase()}.`}
```

Replace:

```tsx
              : `No arrangement beats the board by more than ${report.threshold.toFixed(1)} points, and no lane you are losing is fixed by moving anyone.`}
```

with:

```tsx
              : `No arrangement beats the board by more than ${thresholdText(report)}, and no lane you are losing is fixed by moving anyone.`}
```

- [ ] **Step 7: Run the tests**

Run: `node --test --experimental-strip-types --no-warnings --import ./scripts/register-ts-resolve.mjs src/lib/rebalance.test.ts`
Expected: PASS, including every test that predates this task — they run on a dataset without a calibration, so they exercise the old objective unchanged.

- [ ] **Step 8: Typecheck, build, look**

Run: `npm run typecheck` then `npm run build`
Expected: both succeed. If `noUnusedLocals` flags `formatSigned` in `Rebalance.tsx`, it is still used elsewhere in that file (lane shifts) — check before removing anything.

With the preview from Task 10 still on the five-cores draft, open Rebalance. Expected: the header reads `The draft reads under 15% to win — you are being run over.`, the off-role heroes are named, and any option prints its gain as `+x.x win chance` with a breakdown like `roles +… · lane read +…`. Take a screenshot.

- [ ] **Step 9: Commit**

```bash
git add src/lib/rebalance.ts src/lib/rebalanceCopy.ts src/components/Rebalance.tsx src/lib/rebalance.test.ts
git commit -m "Rank Rebalance arrangements by win chance when calibrated"
```

---

### Task 12: Documentation

**Files:**
- Modify: `docs/scoring.md`, `docs/ui.md`, `README.md` (outside the generated blocks), `docs/refreshing-data.md`, `.claude/skills/refresh-data/SKILL.md`, `AGENTS.md`

**Interfaces:** none. Numbers quoted from the pilot stay the pilot's; numbers about the committed calibration are read from `public/data/calibration.json`, not invented. The one paragraph that quotes them has `{…}` slots; fill them from:

```bash
node -e "const c = require('./public/data/calibration.json'); console.log({ matches: c.matches, tau: c.tau, holdout: c.holdout, range: c.range })"
```

Print `matches` with thousands separators, `logLoss` and `baseline` to four decimals, `auc` to two, and the range bounds as whole percents.

- [ ] **Step 1: `docs/scoring.md` — a Win chance section**

Immediately above the line `## Early game`, insert:

```markdown
## Win chance

The Draft analysis headline is a chance of winning, and it is calibrated: a
model over a handful of draft features whose weights are fitted on real ranked
games and whose predictions are checked on games it was not fitted on. The
arithmetic is `src/lib/winModel.ts`; the fit is `npm run calibrate`, the last
data step of every refresh; its output is `public/data/calibration.json`.

It replaced a comparison signal — the lane-weighted mean matchup, plus the
synergy difference, plus the early-cover term — that could see neither roles
nor hero strength. The draft that retired it: Anti-Mage, Meepo, Sven,
Lifestealer and Arc Warden, five cores, against Leshrac, Lina, Enigma, Bounty
Hunter and Earthshaker. It read **−1.47, "Slight edge to them"**. Lifestealer at
4 wins 39.6% of his games there and Arc Warden at 5 45.3%, and nothing in the
headline knew. The calibrated model puts it under 15%.

### The features

Every feature is mine minus theirs, so swapping the line-ups turns `p` into
`1 − p` exactly.

| Feature | What it adds up |
| --- | --- |
| Matchups | every cross pairing's damped Dotabuff advantage, pairs with ≥ 200 matches |
| Cohesion | each side's pair synergies with the core/support cells as booked, pairs with ≥ 200 games |
| Heroes | each hero's win rate − 50, in the rank band on screen |
| Seat penalty, seat bonus | each hero's `positionWinRate` at the booked seat minus their own win rate, split by sign |
| Role deficit | `min(0, S/5 + τ)²` per side, `S` the side's summed seat deltas |
| Timing | the early-cover shortfall, theirs minus mine |

The chance is `σ(Σ weight × feature)`. Sums, not means: a pairwise edge is a
marginal effect, and the combined effect of 25 of them is their sum. Fitted
freely, the weights on summed matchups and summed hero strength land near 0.04
per point, which is what an additive log-odds model predicts for an even game.
The mean was what made the old figure grow calmer as the board filled.

The role deficit is the term that sees a line-up rather than five heroes. An
ordinary flex costs almost nothing — Snapfire mid moves the chance by a fraction
of a point — while a side whose heroes sit far from their seats loses steeply.
In real games, teams whose summed position-4 and -5 shares came to under a
quarter of a hero won 36% (261 team-games), and teams whose seats averaged four
points or more below their heroes' own records won 25%. Without the convex term
the model under-predicted every one of those bins; with it they fall within
noise.

Seat bonuses are weighted apart from seat penalties because STRATZ files
positions partly by outcome: a Leshrac who ends the game richest is a pos 1
Leshrac, so rare seats' win rates carry some of the result. Fitted separately, a
point of bonus is worth about 0.7 of a point of penalty, and bonuses from seats
under 15% of a hero's games are worth no less than the rest.

The Tuning sliders do not move the chance. The weights were fitted under fixed
sample floors (`WIN_MODEL_FLOORS`), and a probability computed under others
would no longer be the calibrated one. The sliders tune the pick list.

### The calibration

- **Games.** Ranked All Pick from OpenDota's `public_matches`, strictly older
  than both the synergy and the timing samples (their `matchIdRange`), so no
  weight is fitted on the games those figures were measured on. 300,000 by
  default.
- **Positions** for each line-up come from `scripts/assign.mjs`, as in the
  synergy collector.
- **Fit.** τ is chosen from 0.5 to 3 by two-fold held-out log-loss, folds by
  match id parity; the weights are then fitted on every game by logistic
  regression, with a Radiant term the app leaves out. A role-deficit weight that
  fits positive is pinned at zero.
- **Reliability.** Out of fold and read from both seats, in 5-point bins. The
  headline prints a figure only inside the span of bins holding at least 200
  team-games and says "under 15%" or "over 85%" beyond it, with the model's own
  figure beside.
- **Guardrails.** The step writes nothing when the sample is under 100,000
  games, when the held-out log-loss is not at least 0.005 below the Radiant term
  alone, when any bin of 1,000 or more team-games misses by more than 3 points,
  or when a weight that can only be positive is not.

The committed calibration: {N} games, τ = {τ}, held-out log-loss {logLoss}
against {baseline} for the Radiant term alone, AUC {auc}, figures shown between
{range low}% and {range high}%.

The breakdown under the headline gives each group — roles, matchups, cohesion,
heroes, timing — its exact Shapley value in points of win chance, so the parts
add up to the headline minus 50 with nothing left over.

### What was tried and left out

Measured on the pilot, 389,352 games from 2026-09-22 scored against the data
committed at `318fd00`:

- **Doubling lane pairings.** A lane pairing is worth 1.06 of a pairing across
  the map (0.0475 against 0.0447 per point), not two.
- **The seat counters inside the matchup sum.** Read from one side only, they
  made the held-out fit worse (0.67237 against 0.67187).
- **The lane cards' readings.** Laning game edge 0.0017 ± 0.0028, form −0.0002 ±
  0.0018, duo −0.0060 ± 0.0035. The cards still print all three; they do not
  move the verdict.
- **A count of support bodies.** Once the seat terms are in, it adds nothing.

The pilot's held-out log-loss was 0.69145 with the Radiant term alone, 0.68656
for the old headline and 0.67188 for this model; AUC 0.557 against about 0.61.
Out of fold, drafts rated 18% won 19.8%, 23% won 23.8%, 28% won 27.6%, 33% won
32.9% and 38% won 37.8%: a recalibration slope of 0.997.

### What it does not know

Positions in calibration are inferred from each line-up, where the board books
them; the weights are fitted at all ranks and applied to whichever band is on
screen; the games are public pubs; and the model sees pairs and seats, not
trios. Each is a reason the figure is a chance rather than a certainty.

```

- [ ] **Step 2: `docs/scoring.md` — what the calibration says about early game**

Immediately above the line that begins `Each pairing is read from both heroes' pages and averaged`, insert:

```markdown
**What the calibration says.** The win-chance model carries the early-cover
shortfall as a feature and fits its weight like any other. In the pilot it came
out indistinguishable from zero (0.015 ± 0.026), and the draft above — Phantom
Lancer, Ancient Apparition, Arc Warden, Silencer and Axe — reads about 72%: its
25 matchups add up to a lot, and in 389,352 real games a missing first half did
not predict losses. The penalty stays in the pick score, where it orders
candidates, and every calibration re-measures its weight in the verdict.

```

- [ ] **Step 3: `docs/scoring.md` — Scoring an arrangement**

Replace everything from the line `## Scoring an arrangement` up to, not including, the line `## Where positions come from` with:

```markdown
## Scoring an arrangement

The [Rebalance](ui.md#rebalancing-your-five) search ranks whole line-ups rather
than candidates, so it needs a figure for "what is this board worth arranged
*this* way". With a calibration it is the win chance of the board so arranged:
the same `winRead` the headline uses. Seat penalties, seat bonuses and the role
deficit are inside it, so where a hero sits is priced by the model that was
fitted on how seats actually go.

Nothing lane-shaped is in the model — the lane readings measured nothing on real
games — so a lane swap leaves the chance where it was. The panel still reads
every lane: an arrangement that takes a losing lane out of the fire while
costing less than a point of win chance is offered for that lane, and every
option prints the lane shifts under it.

An arrangement is offered on its figure when it adds at least one point of win
chance (`CHANCE_GAIN`); one that puts a stranded hero back on a seat they play
may cost up to two (`MAX_SEAT_COST`). Gains print as points of win chance with
the parts that moved.

Without `calibration.json` the search keeps the objective it had before: the
comparison signal, plus the lane cards' laning, form and duo readings averaged
over the contested lanes, plus each hero's seat record at the meta weight, with
the half-point noise floor as its threshold.

```

- [ ] **Step 4: `docs/ui.md`**

Replace:

```markdown
**Draft analysis** is the first of the top bar's actions. It carries the
draft's signed score and opens the analysis above the board; until both teams
have a hero it is greyed out and its tooltip says what it needs. The score is a
comparison signal built from weighted matchup, synergy and early-cover terms,
not a predicted win probability.
```

with:

```markdown
**Draft analysis** is the first of the top bar's actions. It carries the
draft's win chance and opens the analysis above the board; until both teams
have a hero it is greyed out and its tooltip says what it needs. The chance
comes from a model whose weights are fitted on real ranked games and checked on
games it was not fitted on — see [Win chance](scoring.md#win-chance). Without
`public/data/calibration.json` the button carries the older signed comparison
signal instead, and the panel is tagged `uncalibrated`.
```

Replace:

```markdown
- A draft-specific strategic headline, followed by the best timing window,
  opening lane pressure, widest enemy threat, and the share of sampled games
  ending before your first favorable timing window. First favorable and peak
  timing are deliberately separate.
```

with:

```markdown
- The win chance and its verdict, with what drafts rated like this actually won
  underneath. **What moves the win chance** gives each part — roles, matchups,
  cohesion, heroes, timing — in points of win chance, with the reason behind it;
  the parts add up to the figure.
- A draft-specific strategic headline, followed by the best timing window,
  opening lane pressure, widest enemy threat, and the share of sampled games
  ending before your first favorable timing window. First favorable and peak
  timing are deliberately separate. When the seats are the largest cost on the
  board the headline says so first: *Fix the roles first.*
```

Replace:

```markdown
- **Our five.** Every hero of yours scored against their line-up and beside
  your own, best contributor to hardest game — the strong link and the weak one.
```

with:

```markdown
- **Our five.** Every hero of yours scored against their line-up and beside
  your own, best contributor to hardest game — the strong link and the weak one.
- **Roles.** Every hero on both sides with the seat they are booked into, the
  share of their games played there, and their win rate there against their own.
  A side whose heroes between them hardly ever support, or hardly ever farm, is
  named in the heading.
```

Replace the paragraph that begins `**There is no expected win rate.**` and ends `not to predict a match.` with:

```markdown
**The win chance is calibrated.** For a while the panel printed `50 + advantage`
as an expected win rate, which it was not: the figure was a *mean* of pairwise
deltas, and a mean of marginal effects is not their combined effect. The fix at
the time was to stop calling it a probability. The fix now is to make it one:
the parts are summed, weighted by what real games say each is worth, and the
result is checked against games the weights never saw — drafts rated 38% won
37.8% of theirs. Outside the range the calibration can vouch for, the headline
says "under 15%" rather than printing a figure nobody has checked.
```

Replace:

```markdown
When the search finds an arrangement worth more than the noise floor it turns
amber and carries the figure: `Rebalance +1.4`. That is the warning half of the
feature — the case worth catching is the one you did not think to look for.
```

with:

```markdown
When the search finds an arrangement worth at least a point of win chance it
turns amber and carries the figure: `Rebalance +2.1 win chance`. That is the
warning half of the feature — the case worth catching is the one you did not
think to look for.
```

Replace:

```markdown
- **It is worth more overall** — `total` beats the board's by more than the
  [noise floor](#reading-the-draft).
```

with:

```markdown
- **It is worth more** — it adds at least a point of win chance. Seats and the
  role deficit are inside the win chance; the lane read is not, because it
  predicted nothing on real games, so a lane swap on its own never qualifies
  this way.
```

- [ ] **Step 5: `README.md` (outside the generated blocks)**

Replace:

```markdown
- **Rebalance** — the same five heroes in better seats, when a reshuffle beats a
  new pick.
```

with:

```markdown
- **Rebalance** — the same five heroes in better seats, when a reshuffle beats a
  new pick.
- **Win chance** — the board as one calibrated figure: a model whose weights are
  fitted on real ranked games at every refresh, so a 38% means drafts like it
  won about 38% of the time. Five cores and no supports reads under 15%.
```

Replace:

```markdown
| **Draft analysis** in the top bar | The game plan, matchup map and full breakdown of the draft on the board |
```

with:

```markdown
| **Draft analysis** in the top bar | The win chance, the game plan, the matchup map and the full breakdown of the draft on the board |
```

- [ ] **Step 6: `docs/refreshing-data.md`**

Replace:

```markdown
Six data sets from four sources feed the picker. One command brings the hero
roster up to date and then rebuilds all of them:
```

with:

```markdown
Six data sets from four sources feed the picker, and a seventh file — the
win-chance model's weights — is fitted from them. One command brings the hero
roster up to date and then rebuilds all of it:
```

Replace:

```markdown
| `portraits` | Valve's CDN | `public/heroes/*.png` | No |
```

with:

```markdown
| `portraits` | Valve's CDN | `public/heroes/*.png` | No |
| `calibrate` | OpenDota `public_matches`, the files above | `public/data/calibration.json` | No |
```

Replace:

```markdown
They run in that order: the synergy pass reads positions out of `positions.json`,
or out of `matchups.json` when that file is missing. `readme` goes last and joins
```

with:

```markdown
They run in that order: the synergy pass reads positions out of `positions.json`,
or out of `matchups.json` when that file is missing, and `calibrate` fits the
win-chance model on the files every step before it wrote, from games older than
the synergy and timing samples. `readme` goes last and joins
```

Immediately above the line `## Troubleshooting`, insert:

```markdown
**`calibrate`: "the fit failed its checks"** — the lines above it name the
check: too few games, a fit no better than knowing the side, a calibration bin
that misses, or a weight with an impossible sign. The previous
`calibration.json` stays, and the app keeps showing the win chance with a
*calibration predates data* tag. Rerun `npm run refresh -- --steps=calibrate`
once the OpenDota steps are `ok`; never edit the file by hand.

```

- [ ] **Step 7: `.claude/skills/refresh-data/SKILL.md`**

Replace:

```markdown
2. **Collect.** `npm run refresh`. The steps run in order — `roster`,
   `counters` (Dotabuff), `positions` (STRATZ), `synergies` and `timings`
   (OpenDota), `lanes` (STRATZ), `portraits`, `readme` — each in its own
```

with:

```markdown
2. **Collect.** `npm run refresh`. The steps run in order — `roster`,
   `counters` (Dotabuff), `positions` (STRATZ), `synergies` and `timings`
   (OpenDota), `lanes` (STRATZ), `portraits`, `calibrate` (the win-chance
   model, fitted on OpenDota games), `readme` — each in its own
```

Replace:

```markdown
   - `readme` could not reach Valve or OpenDota → retry `npm run readme` later.
```

with:

```markdown
   - `calibrate` "failed its checks" → it names the check and leaves the old
     `calibration.json`; retry once the OpenDota steps are `ok`, and never edit
     the file or loosen a guardrail to get past it.
   - `readme` could not reach Valve or OpenDota → retry `npm run readme` later.
```

- [ ] **Step 8: `AGENTS.md`**

Replace:

```bash
npm run refresh         # recollect every data set, then the README blocks
```

with:

```bash
npm run refresh         # recollect every data set, then the README blocks
npm run calibrate       # refit the win-chance model alone (refresh runs it)
```

- [ ] **Step 9: Check the README blocks and commit**

Run: `node --test scripts/readme-sync.test.mjs`
Expected: PASS. The edits in Step 5 are outside the generated blocks.

```bash
git add docs/scoring.md docs/ui.md README.md docs/refreshing-data.md .claude/skills/refresh-data/SKILL.md AGENTS.md
git commit -m "Document the win chance, its calibration and what it changed"
```

---

### Task 13: Final verification

**Files:**
- Regenerate, if the UI changed visibly: `docs/assets/banner.jpg`, `docs/assets/screenshot.jpg`

- [ ] **Step 1: Every test, both halves**

Run: `node --test scripts/*.test.mjs`
Expected: all pass, except possibly `scripts/roster.test.mjs` on this CRLF checkout, which is tracked separately and has nothing to do with this change. Any other failure is this change's.

Run: `node --test --experimental-strip-types --no-warnings --import ./scripts/register-ts-resolve.mjs src/lib/*.test.ts`
Expected: all pass.

- [ ] **Step 2: Typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: both succeed.

- [ ] **Step 3: The sanity cases**

Run: `npm run calibrate -- --dry-run`
Expected, against the spec's "Sanity cases" table:
- Five cores: under 15%, led by Roles;
- Five supports: 33% or below, led by Roles;
- The early-game case: above 50%;
- Snapfire mid and Slark mid: Roles within ±2;
- `--dry-run: nothing written`.

Quote the printed block in the report.

- [ ] **Step 4: The README images**

The top bar's chip now shows a percentage, so the README screenshot is out of date. Run: `npm run readme:images`. Then look at both images with `Read`, check that the chip shows a percentage and nothing else looks broken, and commit:

```bash
git add docs/assets/banner.jpg docs/assets/screenshot.jpg
git commit -m "Re-render the README images with the win chance"
```

- [ ] **Step 5: Report**

Summarise for the user:
- the branch and its commits;
- the committed calibration's τ, held-out log-loss against the baseline, AUC and range;
- the sanity block;
- the screenshots from Tasks 10 and 11.

Do not push: a push to `main` deploys the site, and pushing is the user's call.
