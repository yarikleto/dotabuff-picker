import test from "node:test";
import assert from "node:assert/strict";
import { analyseDraft, toMarkdown } from "./analysis.ts";
import { allMatchups, buildBriefing } from "./draftInsights.ts";
import { DEFAULT_SETTINGS } from "./scoring.ts";
import { deriveTimingShape } from "./timing.ts";
import type { Dataset, DraftPick, Hero, Position } from "../types.ts";

function fixture() {
  const team = (prefix: string): DraftPick[] => Array.from({ length: 5 }, (_, i) => ({ slug: `${prefix}${i + 1}`, position: i + 1 as Position }));
  const draft = { mine: team("ours"), enemy: team("enemy"), banned: [] };
  const heroes: Hero[] = [...draft.mine, ...draft.enemy].map((p) => ({
    slug: p.slug, name: p.slug, steam: p.slug, attr: "uni", winRate: 50,
    timings: (p.slug.startsWith("ours") ? [-3, -1, 1, 3] : [1, 1, 0, -1]).map((skew) => ({ skew, games: 1000, winRate: 50 + skew })),
  }));
  const data: Dataset = {
    heroes, bySlug: new Map(heroes.map((h) => [h.slug, h])),
    matchups: Object.fromEntries(draft.mine.map((p) => [p.slug, Object.fromEntries(draft.enemy.map((e) => [e.slug, { disadvantage: 0, matches: 5000, winRate: 50 }]))])),
    synergies: {}, hasData: true, hasPositions: true, hasSynergies: false, hasTimings: true,
    generatedAt: null, synergyMatches: 0, timingMatches: 10000, error: null,
    timingBuckets: [
      { key: "early", short: "<25", label: "Before 25′", maxSeconds: 1500 },
      { key: "mid", short: "25–35", label: "25–35′", maxSeconds: 2100 },
      { key: "late", short: "35–45", label: "35–45′", maxSeconds: 2700 },
      { key: "veryLate", short: "45+", label: "45′ and up", maxSeconds: null },
    ],
    timingShape: deriveTimingShape(heroes, 4),
  };
  return { data, draft, analyse: () => analyseDraft(data, draft, DEFAULT_SETTINGS)! };
}

test("distinguishes the first favorable window from the peak and prices the wait", () => {
  const b = buildBriefing(fixture().analyse());
  assert.equal(b.firstWindow?.key, "late");
  assert.equal(b.bestWindow?.key, "veryLate");
  assert.equal(b.exposure, 0.5);
  assert.match(b.title, /Survive/);
  assert.match(b.insights[0]!.evidence, /50% of sampled games/);
});

test("never recommends outscaling when every window favors the enemy", () => {
  const f = fixture();
  f.data.heroes.filter((h) => h.slug.startsWith("ours")).forEach((h) => h.timings!.forEach((t) => { t.skew = -3; }));
  const b = buildBriefing(f.analyse());
  assert.equal(b.firstWindow, null);
  assert.equal(b.bestWindow, null);
  assert.equal(b.exposure, null);
  assert.match(b.title, /Waiting is not the plan/);
  assert.match(b.insights[0]!.title, /Time alone does not solve/);
});

test("an unmeasured enemy never becomes a neutral timing opponent", () => {
  const f = fixture();
  f.data.heroes.filter((h) => h.slug.startsWith("enemy")).forEach((h) => { delete h.timings; });
  const a = f.analyse();
  const b = buildBriefing(a);
  assert.equal(b.timingComplete, false);
  assert.equal(b.bestWindow, null);
  assert.equal(b.insights.some((i) => i.kind === "timing"), false);
  assert.equal(a.stages!.best, null);
  assert.equal(a.stages!.weightedEdge, null);
  assert.equal(a.stages!.exposure, null);
  assert.match(toMarkdown(a), /them unknown/);
});

test("one missing hero-window blocks whole-draft timing claims", () => {
  const f = fixture();
  f.data.heroes[7]!.timings![2]!.games = 0;
  const a = f.analyse();
  const b = buildBriefing(a);
  assert.equal(b.timingComplete, false);
  assert.equal(b.firstWindow, null);
  assert.equal(a.stages!.weightedEdge, null);
});

test("threat reach uses all pairings, including those outside the old top-five shortlist", () => {
  const f = fixture();
  for (const p of f.draft.mine) {
    f.data.matchups[p.slug]!.enemy1!.disadvantage = 2;
    f.data.matchups[p.slug]!.enemy2!.disadvantage = 4;
  }
  // One stronger answer does not erase the threat to four other teammates.
  f.data.matchups.ours5!.enemy1!.disadvantage = -3;
  const a = f.analyse();
  assert.equal(a.threats.length, 5);
  const b = buildBriefing(a);
  assert.equal(b.threats.length, 2);
  assert.equal(b.threats[0]!.hero.slug, "enemy2");
  assert.equal(b.threats[1]!.victims.length, 4);
  assert.equal(b.threats[1]!.answers[0]!.mine.slug, "ours5");
  assert.equal(b.threats[1]!.pressure, 1);
  assert.equal(allMatchups(a).length, 25);
});

test("lane plan respects the actual opening when the composite score disagrees", () => {
  const a = fixture().analyse();
  const lane = a.lanes.find((l) => l.key === "off")!;
  lane.score = 2;
  lane.outcome = { result: -8, gameEdge: -1, covered: 4, possible: 4, widest: null };
  const b = buildBriefing(a);
  assert.equal(b.favorableLanes.length, 0);
  assert.equal(b.pressuredLanes[0]!.key, "off");
  const insight = b.insights.find((i) => i.kind === "lane")!;
  assert.equal(insight.label, "HIDDEN TRADEOFF");
  assert.match(insight.evidence, /42% expected lane share/);
  assert.match(insight.evidence, /\+2.0 composite game outlook/);
});

test("unresolved positions cannot produce a confident lane plan", () => {
  const a = fixture().analyse();
  a.lanesResolved = false;
  a.lanes[0]!.outcome = { result: 12, gameEdge: 3, covered: 4, possible: 4, widest: null };
  const b = buildBriefing(a);
  assert.equal(b.insights.some((i) => i.kind === "lane"), false);
});

test("incomplete drafts stay provisional and use actual matchup denominators", () => {
  const f = fixture();
  f.draft.mine.splice(2);
  f.draft.enemy.splice(3);
  f.data.matchups.ours1!.enemy1!.disadvantage = 2;
  const a = f.analyse();
  const b = buildBriefing(a);
  assert.match(b.title, /still taking shape/);
  assert.match(b.description, /2 of your picks and 3 of theirs/);
  assert.match(b.insights.find((i) => i.kind === "threat")!.title, /1 of your 2/);
  assert.equal(allMatchups(a).length, 6);
});

test("unmeasured heroes remain in the matchup axes and missing cells stay missing", () => {
  const f = fixture();
  delete f.data.matchups.ours1!.enemy1;
  const a = f.analyse();
  assert.equal(a.lineups.mine.length, 5);
  assert.equal(a.lineups.enemy.length, 5);
  assert.equal(allMatchups(a).length, 24);
  assert.equal(allMatchups(a).some((p) => p.mine.slug === "ours1" && p.theirs.slug === "enemy1"), false);
});

test("score contributions reconcile with non-default synergy tuning and export the plan", () => {
  const f = fixture();
  f.data.synergies = { ours1: { ours2: { synergy: 2, matches: 5000, winRate: 52 } } };
  const a = analyseDraft(f.data, f.draft, { ...DEFAULT_SETTINGS, synergyWeight: 3 })!;
  assert.equal(a.cohesionContribution, 3 * a.synergyEdge);
  assert.ok(Math.abs(a.counter + a.cohesionContribution + a.earlyEdge - a.advantage) < 1e-9);
  const md = toMarkdown(a);
  assert.match(md, /Game plan/);
  assert.match(md, /early cover/);
  assert.match(md, /YOUR BEST PARTNERSHIP|ours1 \+ ours2/);
});

test("sub-noise pairings produce neither threats nor opportunities", () => {
  const f = fixture();
  f.data.matchups.ours1!.enemy1!.disadvantage = 0.1;
  const b = buildBriefing(f.analyse());
  assert.equal(b.threats.length, 0);
  assert.equal(b.insights.some((i) => i.kind === "opportunity"), false);
});

test("a severe individual counter survives beside an enemy with wider reach", () => {
  const f = fixture();
  for (const p of f.draft.mine) f.data.matchups[p.slug]!.enemy1!.disadvantage = 1;
  f.data.matchups.ours3!.enemy4!.disadvantage = 5;
  const b = buildBriefing(f.analyse());
  assert.equal(b.threats[0]!.hero.slug, "enemy1");
  const trap = b.insights.find((i) => i.id === "counter-trap");
  assert.match(trap!.title, /ours3 must respect enemy4/);
  assert.match(trap!.evidence, /−5.0/);
});

test("a lane swap updates which matchup cells are marked as lane opponents", () => {
  const f = fixture();
  const standard = allMatchups(f.analyse());
  const swapped = allMatchups(analyseDraft(f.data, { ...f.draft, lanePlan: "swapped" }, DEFAULT_SETTINGS)!);
  const carryMatch = (pairs: typeof standard) => pairs.find((p) => p.mine.slug === "ours1" && p.theirs.slug === "enemy1")!;
  assert.equal(carryMatch(standard).sameLane, false);
  assert.equal(carryMatch(swapped).sameLane, true);
  assert.equal(swapped.filter((p) => p.sameLane).length, 9);
});
