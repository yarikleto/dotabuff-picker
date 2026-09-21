import test from "node:test";
import assert from "node:assert/strict";
import { MAX_SEAT_COST, arrangementId, rebalance, rebalanceReadiness, scoreArrangement } from "./rebalance.ts";
import { buttonLabel, costOf, describeOption, headlineFor } from "./rebalanceCopy.ts";
import { laneScoreboard } from "./analysis.ts";
import { POSITIONS } from "./roles.ts";
import { DEFAULT_SETTINGS, NOISE } from "./scoring.ts";
import type { DraftView } from "./scoring.ts";
import type { RebalanceReport } from "./rebalance.ts";
import type {
  Dataset,
  DraftPick,
  Hero,
  Lane,
  LaneStats,
  MatchupTable,
  Position,
} from "../types.ts";

// Run with: node --test --experimental-strip-types src/lib/*.test.ts

const laneStats = (winRate: number): LaneStats => ({
  presence: 80,
  winRate,
  kda: 3,
  gpm: 400,
  xpm: 500,
});

/**
 * A seat's record as the live pipeline builds it — see `estimateSeatPrior`,
 * whose measured mean runs from about −7.4pp in the seats a hero is almost
 * never put in to nothing at all above a fifth of their games.
 *
 * The shape, not a second copy of the curve: the prior itself is pinned in
 * positions.test.ts. What it buys here is that seating a hero somewhere they
 * never go costs something, which is the whole of what this panel weighs.
 */
const seatWinRate = (share: number) => 50 - 7.4 * Math.max(0, 1 - share / 0.2);

const hero = (
  slug: string,
  positions: Partial<Record<Position, number>>,
  lanes?: Partial<Record<Lane, LaneStats>>,
  positionWinRate: Partial<Record<Position, number>> = Object.fromEntries(
    POSITIONS.map((p) => [p, seatWinRate(positions[p] ?? 0)]),
  ),
): Hero => ({
  slug,
  name: slug.toUpperCase(),
  attr: "uni",
  steam: slug,
  winRate: 50,
  positions,
  positionWinRate,
  ...(lanes ? { lanes } : {}),
});

const pick = (slug: string, position: Position | null = null): DraftPick => ({ slug, position });

/** A row read from the page hero's side: positive `disadvantage` means they lose it. */
const row = (disadvantage: number) => ({
  disadvantage,
  winRate: 50 - disadvantage,
  matches: 20_000,
});

/**
 * A board built so the arithmetic of a reshuffle can be checked by hand.
 *
 * Only two of my five can move: `alpha` and `beta` both play mid and offlane,
 * everyone else is pinned to one position by the role threshold. That leaves
 * exactly two seatings and two lane plans — four arrangements, three of them
 * alternatives to the board — and every figure below can be worked out on paper.
 *
 * Three pairings carry data, and they are chosen so the lane weighting has
 * something to do: `nemesis` takes ten points off `alpha`, my 5 wins his own
 * matchup by six, and `beta` is two ahead of their carry. Which of those counts
 * double depends entirely on who is standing where, which is the thing being
 * tested.
 *
 * No synergies, no timings, no lane rows: the headline is then the head-to-head
 * term alone, and every hero's win rate is 50, so the meta term is zero too.
 * What is left is lane weighting and role fit — the two things a rearrangement
 * can actually move.
 */
function makeDataset(lanes?: Partial<Record<Lane, LaneStats>>): Dataset {
  const heroes = [
    // What a seat is worth is a hero's record in it — the live pipeline builds
    // that from their own counts and what seats of that share are measured to
    // be worth, see `estimateSeatPrior`. Stated outright here: each of these
    // two is a quarter of a point worse in their second seat, which is what
    // gives the panel something to weigh a rearrangement against.
    hero("alpha", { 2: 0.5, 3: 0.3 }, undefined, { 2: 50, 3: 48.75 }),
    hero("beta", { 3: 0.5, 2: 0.3 }, undefined, { 3: 50, 2: 48.75 }),
    hero("carry", { 1: 1 }, lanes),
    hero("sup4", { 4: 1 }),
    hero("sup5", { 5: 1 }),

    hero("theirCarry", { 1: 1 }),
    hero("nemesis", { 2: 1 }),
    hero("theirOff", { 3: 1 }),
    hero("theirRoam", { 4: 1 }),
    hero("theirSup", { 5: 1 }),
  ];

  const matchups: MatchupTable = {
    alpha: { nemesis: row(10) },
    beta: { theirCarry: row(-2) },
    sup5: { theirSup: row(-6) },
  };

  return {
    heroes,
    bySlug: new Map(heroes.map((h) => [h.slug, h])),
    matchups,
    synergies: {},
    generatedAt: null,
    // Null rather than a number: the shrinkage is not what is under test here,
    // and with it on none of the figures below would be round.
    matchupSpread: null,
    hasData: true,
    hasPositions: true,
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

/** alpha holds mid, where `nemesis` is waiting for him. */
const draft: DraftView = {
  mine: [pick("alpha", 2), pick("beta", 3), pick("carry", 1), pick("sup4", 4), pick("sup5", 5)],
  enemy: [
    pick("theirCarry", 1),
    pick("nemesis", 2),
    pick("theirOff", 3),
    pick("theirRoam", 4),
    pick("theirSup", 5),
  ],
  banned: [],
};

const near = (actual: number, expected: number, what: string) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${what}: expected ${expected}, got ${actual}`);

const bySize = (report: RebalanceReport) =>
  Object.fromEntries(report.options.map((o) => [o.size, o]));

// ----------------------------------------------------------------- readiness

test("the question is not asked until the line-up is complete and seated", () => {
  const reasons = (view: Partial<DraftView>) => rebalanceReadiness({ ...draft, ...view }).reason;

  assert.equal(reasons({ mine: [] }), "no-team");
  assert.equal(reasons({ enemy: [] }), "no-enemy");
  assert.equal(reasons({ mine: draft.mine.slice(0, 2) }), "short-team");
  assert.equal(
    reasons({ mine: [...draft.mine.slice(0, 4), pick("sup5", null)] }),
    "unseated",
    "a hero with no seat cannot be re-seated",
  );
  assert.equal(rebalanceReadiness(draft).reason, null);
});

test("a partial board is refused outright rather than answered badly", () => {
  // The bug this gate exists for. Two heroes on my side gave 20 "seatings" of a
  // team that does not exist yet, a fit term averaged over a different number of
  // heroes than the board it was being compared against, and — the visible
  // nonsense — an offer to swap the lanes of duos nobody had drafted.
  assert.equal(rebalance(data, { ...draft, mine: draft.mine.slice(0, 2) }, settings), null);
  assert.equal(rebalance(data, { ...draft, enemy: [] }, settings), null);
  assert.equal(
    rebalance(data, { ...draft, mine: [...draft.mine.slice(0, 4), pick("sup5", null)] }, settings),
    null,
  );
});

test("the readiness check says what is missing, for the disabled button to quote", () => {
  const short = rebalanceReadiness({ ...draft, mine: draft.mine.slice(0, 3) });
  assert.match(short.detail, /2 more/, "and it counts them");

  const unseated = rebalanceReadiness({
    ...draft,
    mine: [...draft.mine.slice(0, 4), pick("sup5", null)],
  });
  assert.deepEqual(unseated.unseated, ["sup5"], "named, so the caller can point at them");
});

// ------------------------------------------------------------------- finding

test("the hero the enemy answered is offered a different seat", () => {
  const report = rebalance(data, draft, settings)!;
  const swap = bySize(report)[2]!;

  assert.deepEqual(
    swap.moves.map((m) => `${m.name} ${m.from}→${m.to}`),
    ["BETA 3→2", "ALPHA 2→3"],
    "alpha steps out of mid and beta takes it",
  );
  assert.equal(swap.swapsLanes, false, "the seats alone are enough for this one");
});

test("the board is held to the same role threshold as the arrangements it is compared against", () => {
  // The bug this exists for, from a real draft: Earth Spirit booked at position
  // 1 — 0.15% of his games, flagged in red in the read-out, and a seat this very
  // search would refuse to offer anybody — and the panel answered "no
  // arrangement beats the board". It was right about the figure and silent about
  // the only thing wrong with the draft, because the threshold was applied to
  // every candidate and never to the board in front of the reader.
  //
  // `carry` is the fixture's only position-1 hero, so putting `sup5` there is
  // exactly that board: legal nowhere, and fixable only at a cost.
  const stranded: DraftView = {
    ...draft,
    mine: [pick("alpha", 2), pick("beta", 3), pick("sup5", 1), pick("sup4", 4), pick("carry", 5)],
  };
  const report = rebalance(data, stranded, settings)!;

  assert.deepEqual(
    report.offRole.map((seat) => `${seat.name}@${seat.position}`),
    ["SUP5@1", "CARRY@5"],
    "both heroes in seats they never play, worst first",
  );
  assert.ok(report.seatFixes.length > 0, "and the way out is offered rather than scored away");

  const fix = report.seatFixes[0]!;
  assert.equal(fix.reason, "seat");
  assert.equal(fix.offRole, 0, "the best one strands nobody");
  assert.deepEqual(
    fix.repairedSeats.map((seat) => seat.name).sort(),
    ["CARRY", "SUP5"],
    "and it names whose problem it fixed",
  );
  assert.ok(
    fix.moves.some((m) => m.slug === "carry" && m.to === 1),
    "the one hero who plays position 1 ends up in it",
  );
});

test("a seat repair may cost score, but only up to what the stretch it undoes is priced at", () => {
  // The rule that keeps this from becoming "wreck the draft to satisfy a
  // slider". Everything else on the panel is forbidden to lose score; this is
  // the exception, and `MAX_SEAT_COST` is the ceiling on it. The live table
  // does not reach that ceiling — see the constant — so what this pins is the
  // rule, not a boundary any real board sits against.
  const stranded: DraftView = {
    ...draft,
    mine: [pick("alpha", 2), pick("beta", 3), pick("sup5", 1), pick("sup4", 4), pick("carry", 5)],
  };
  const report = rebalance(data, stranded, settings)!;

  for (const fix of report.seatFixes) {
    assert.ok(fix.repairedSeats.length > 0, "every entry frees somebody the board had stranded");
    assert.ok(fix.gain.total > -MAX_SEAT_COST, "and none of them costs more than the bound");
    for (const seat of fix.repairedSeats) {
      assert.ok(
        !report.offRole.every((was) => was.slug !== seat.slug),
        "and only heroes the board itself had stranded are counted as repaired",
      );
    }
  }

  // A correctly seated board has nothing to repair and says so with an empty
  // list rather than by offering the reader arrangements that lose score.
  const fine = rebalance(data, draft, settings)!;
  assert.deepEqual(fine.offRole, []);
  assert.deepEqual(fine.seatFixes, []);
  for (const option of [...fine.options, ...fine.laneFixes, ...fine.swaps]) {
    assert.ok(option.gain.total > -NOISE, "nothing else here is allowed to lose score");
  }
});

test("an off-role board leads the button with the fact, not with a figure", () => {
  // The figure for a seat repair is usually negative, and a top bar reading
  // "Rebalance −0.5 overall" invites exactly the wrong conclusion about the one
  // arrangement on the panel worth taking.
  const stranded: DraftView = {
    ...draft,
    mine: [pick("alpha", 2), pick("beta", 3), pick("sup5", 1), pick("sup4", 4), pick("carry", 5)],
  };
  const report = rebalance(data, stranded, settings)!;

  assert.equal(buttonLabel(report), "Rebalance — 2 off-role");
  assert.equal(report.best, report.seatFixes[0], "and the repair leads the panel");
});

test("the small-move list is one trade at a time, and nothing else", () => {
  // The list exists because the biggest number on the panel is almost always a
  // four-way rotation nobody acts on. Anything that is not a single trade or the
  // deployment on its own belongs on the other list, whatever it is worth.
  const report = rebalance(data, draft, settings)!;
  assert.ok(report.swaps.length > 0, "this board has small moves worth making");

  for (const swap of report.swaps) {
    if (swap.moves.length === 0) {
      assert.equal(swap.swapsLanes, true, "the only move that reseats nobody is the deployment");
      continue;
    }
    const [a, b] = swap.moves;
    assert.equal(swap.moves.length, 2, "a seat cannot be vacated without someone taking it");
    assert.equal(swap.swapsLanes, false, "and a trade is not bundled with a change of deployment");
    assert.ok(a!.from === b!.to && b!.from === a!.to, "the two heroes trade with each other");
    assert.ok(swap.gain.total >= NOISE, "and it clears the noise floor, or it is not advice");
  }

  // Legal first, then by size of gain within each half. The three trades that
  // move ALPHA out of mid onto a seat he never plays are all worth more to the
  // score than swapping the lanes — he is dodging a ten-point matchup — and
  // every one of them is nonsense to act on without knowing the player. They
  // stay on the list, under the ones that ask nothing of anybody.
  assert.deepEqual(
    report.swaps.map((s) => `${s.legal ? "" : "! "}${describeOption(s)}`),
    [
      "Swap BETA and ALPHA",
      "Swap lanes — nobody changes position",
      "! Swap ALPHA and CARRY",
      "! Swap SUP4 and ALPHA",
      "! Swap SUP5 and ALPHA",
    ],
  );
  assert.ok(
    report.swaps.filter((s) => !s.legal).some((s) => s.gain.total > report.swaps[1]!.gain.total),
    "and the ordering really is legality first, not the figure",
  );
});

test("every single trade that helps is offered — the list is not a curve", () => {
  // The trade-off curve is a device for making 120 seatings choosable, and
  // applying it here would be answering a question nobody asked: these all cost
  // the same trivial amount of upheaval, so there is nothing to trade off. The
  // check is against the arithmetic rather than against a fixture, so it keeps
  // holding when the weights move.
  const report = rebalance(data, draft, settings)!;
  const plan = draft.lanePlan ?? "standard";

  const expected = new Set<string>();
  const consider = (picks: DraftPick[], lanePlan: typeof plan) => {
    const score = scoreArrangement(data, draft, settings, { picks, lanePlan });
    if (score.total - report.current.total >= NOISE) {
      expected.add(arrangementId({ picks, lanePlan }));
    }
  };

  consider(draft.mine, plan === "standard" ? "swapped" : "standard");
  for (let i = 0; i < draft.mine.length; i++) {
    for (let j = i + 1; j < draft.mine.length; j++) {
      const picks = draft.mine.map((p) => ({ ...p }));
      picks[i] = { ...draft.mine[i]!, position: draft.mine[j]!.position };
      picks[j] = { ...draft.mine[j]!, position: draft.mine[i]!.position };
      consider(picks, plan);
    }
  }

  assert.deepEqual(
    new Set(report.swaps.map((s) => s.id)),
    expected,
    "every neighbour above the floor is on the list, and nothing else is",
  );
});

test("a small move and the big arrangement that contains it are never shown twice over", () => {
  // The two lists overlap by construction — the cheap end of the curve is
  // usually a single trade — and the lane read behind a card must be bought once
  // however many lists it lands in.
  const report = rebalance(data, draft, settings)!;
  const shared = report.options.filter((o) => report.swaps.some((s) => s.id === o.id));
  assert.ok(shared.length > 0, "the fixture actually exercises the overlap");
  for (const option of shared) {
    const swap = report.swaps.find((s) => s.id === option.id)!;
    assert.equal(swap, option, "the same decorated arrangement, not a second read of it");
  }
});

test("the whole search is scored, and every part of it adds up", () => {
  const report = rebalance(data, draft, settings)!;

  // Board as it stands: alpha eats −10 at double weight in mid, beta's +2 also
  // counts double against their carry, my 5's +6 counts once.
  near(report.current.advantage, -2, "current head-to-head");
  // Seating: every hero is on their main seat, where each of them wins 50%, so
  // the term is zero. A board that is already correctly seated scores nothing
  // here rather than a number that grows with how stereotyped its heroes are —
  // the seat effect is flat above a fifth of a hero's games.
  near(report.current.fit, 0, "current fit");
  near(report.current.total, -2, "current total");

  const sizes = bySize(report);
  // Lanes alone: nobody moves, but my 5's matchup becomes a lane pairing and
  // beta's stops being one.
  near(sizes[1]!.gain.total, 0.8, "swap lanes only");
  // Seats alone: alpha dodges the pairing that was counting double, at the cost
  // of two heroes standing in their second seat, where each wins 48.75% rather
  // than 50% — half a point of meta weight each, averaged over five: −0.25.
  near(sizes[2]!.gain.total, 4 / 3 - 0.25, "swap seats only");
  // Both: the −10 is de-weighted *and* the +6 doubled, less the same stretch.
  near(sizes[3]!.gain.total, 3 - 0.25, "both");

  // Every arrangement is scored, legal or not — the threshold decides which list
  // one lands in, not whether it exists. 120 seatings, two plans, less the board.
  assert.equal(report.counts.arrangements, 239);
  assert.equal(report.counts.seatings, 120);
  assert.equal(report.counts.legalSeatings, 2, "only two seatings clear the role threshold");
  assert.equal(report.pinned, false);
  assert.equal(report.best, sizes[3], "the biggest gain leads");
});

test("the gain is reported in its two parts, and they add to the whole", () => {
  // The panel led with the sum under the word "board" and printed the draft
  // figure below it under the word "draft" — two quantities three points apart,
  // one of them labelled as the other.
  const report = rebalance(data, draft, settings)!;

  for (const option of report.options) {
    near(
      option.gain.advantage + option.gain.fit,
      option.gain.total,
      "the halves make the whole",
    );
    near(
      option.score.advantage - report.current.advantage,
      option.gain.advantage,
      "and the draft half is a difference of two draft figures",
    );
  }
});

test("every option is a real permutation of the same five heroes", () => {
  const report = rebalance(data, draft, settings)!;
  const mine = draft.mine.map((p) => p.slug).sort();

  for (const option of report.options) {
    assert.deepEqual(option.picks.map((p) => p.slug).sort(), mine, "same heroes");
    const positions = option.picks.map((p) => p.position);
    assert.equal(new Set(positions).size, positions.length, "no two heroes on one position");
    assert.ok(positions.every((p) => p !== null), "everyone is booked somewhere");
  }
});

test("an option names the lane it moves, worst swing first", () => {
  const report = rebalance(data, draft, settings)!;
  const shifts = bySize(report)[2]!.laneShifts;

  assert.equal(shifts[0]!.key, "mid", "mid is what the move was for");
  near(shifts[0]!.delta, 10, "alpha's −10 is no longer the mid read");
  near(shifts[0]!.after, shifts[0]!.before + shifts[0]!.delta, "before and after are both reported");
  assert.ok(
    shifts.every((s) => Math.abs(s.delta) >= NOISE),
    "lanes that barely move are not reported",
  );
});

test("an option's id survives a reordering of the same booking", () => {
  const report = rebalance(data, draft, settings)!;
  const option = report.options[0]!;

  assert.equal(
    arrangementId(option),
    arrangementId({ picks: [...option.picks].reverse(), lanePlan: option.lanePlan }),
  );
  assert.equal(new Set(report.options.map((o) => o.id)).size, report.options.length, "and it is unique");
});

// -------------------------------------------------------------- the shortlist

test("one arrangement per amount of upheaval, so the cheap fix is never buried", () => {
  const report = rebalance(data, draft, settings)!;
  const sizes = report.options.map((o) => o.size);
  assert.deepEqual(sizes, [3, 2, 1], "biggest gain first, but every size represented");
  assert.equal(new Set(sizes).size, sizes.length, "no size appears twice");
});

test("the shortlist is a trade-off curve: more upheaval always buys more", () => {
  // The property the old slice-then-patch could not guarantee. It took the top N
  // by gain and then overwrote the last slot with the cheapest entry, which
  // could discard a better arrangement and leave the list out of order.
  const report = rebalance(data, draft, settings)!;
  const curve = [...report.options].sort((a, b) => a.size - b.size);

  for (let i = 1; i < curve.length; i++) {
    assert.ok(
      curve[i]!.gain.total > curve[i - 1]!.gain.total,
      "a costlier arrangement is only on the list if it is worth more",
    );
  }
  assert.deepEqual(
    report.options.map((o) => o.gain.total),
    [...report.options].sort((a, b) => b.gain.total - a.gain.total).map((o) => o.gain.total),
    "and it is presented best-first",
  );
});

test("both ends of the curve survive a limit that cannot hold all of it", () => {
  const full = rebalance(data, draft, settings)!;
  const clipped = rebalance(data, draft, settings, 2)!;
  const sizes = (r: RebalanceReport) => r.options.map((o) => o.size).sort((a, b) => a - b);

  assert.deepEqual(sizes(full), [1, 2, 3]);
  assert.deepEqual(sizes(clipped), [1, 3], "the cheapest fix and the biggest gain — the middle goes");
});

// ---------------------------------------------------------------- restraint

test("nothing is offered on the score when nothing clears the noise floor", () => {
  // With the lane weight at zero every pairing counts once whoever stands where,
  // so the only thing left to move is role fit — and moving two heroes off their
  // main position to *lose* 0.25 is exactly the advice this app should not give.
  const report = rebalance(data, draft, { ...settings, laneWeight: 0 })!;

  assert.deepEqual(report.options, [], "no arrangement is worth more overall");
  assert.ok(
    report.laneFixes.every((o) => o.reason === "lane"),
    "anything still listed is there for a lane, and says so",
  );
});

test("an arrangement that rescues a losing lane is offered even when the board barely moves", () => {
  // The whole reason this rule exists. At laneWeight 0 the seat swap is worth
  // −0.25 overall — inside the noise floor — while mid goes from −10 to level, because
  // alpha stops standing in front of the hero who answers him. The scalar cannot
  // see that and the lane read can.
  const report = rebalance(data, draft, { ...settings, laneWeight: 0 })!;
  const repair = report.laneFixes[0]!;

  assert.ok(repair, "the lane rule found it");
  assert.equal(repair.reason, "lane");
  assert.equal(repair.repairedLane!.key, "mid");
  near(repair.repairedLane!.delta, 10, "mid stops being a −10 read");
  assert.ok(repair.repairedLane!.before <= -NOISE, "and it was a lane we were losing");
  assert.ok(repair.gain.total < NOISE, "and it is emphatically not offered on the score");
  assert.ok(repair.gain.total > -NOISE, "but it does not cost anything either");
  assert.deepEqual(
    repair.moves.map((m) => `${m.name} ${m.from}→${m.to}`),
    ["BETA 3→2", "ALPHA 2→3"],
  );
});

test("a lane that was never losing cannot be rescued", () => {
  // Mid is +10 from my side here, so an arrangement that moves it further is
  // improving something that was not a problem — not a repair, and not a reason
  // to reshuffle a draft.
  const kind = makeDataset();
  kind.matchups = { ...kind.matchups, alpha: { nemesis: row(-10) } };
  const report = rebalance(kind, draft, { ...settings, laneWeight: 0 })!;

  assert.deepEqual(report.laneFixes, []);
  assert.deepEqual(report.losing, [], "and the report says so, rather than staying silent");
});

test("every arrangement is read in the lanes exactly once", () => {
  // This used to be the opposite property. A lane read was something the search
  // bought *on top of* scoring, so it was rationed: an exact rule decided,
  // without touching the dataset, whether an arrangement could possibly have
  // moved a lane we were losing, and only those were read.
  //
  // The lane read is now part of the score, because who wins the three lanes is
  // the thing seating decides and the objective could not see it. So the ration
  // is gone and the property to hold is the other one — one read per
  // arrangement, never two. Buying the same read twice is how the figure on a
  // card and the lane shifts under it drift apart.
  const report = rebalance(data, draft, settings)!;

  assert.equal(
    report.counts.laneReads,
    report.counts.arrangements,
    "one read each, and no arrangement read a second time for its shortlist",
  );
  assert.ok(report.counts.arrangements > 200, "over the full search");
});

test("the lane shifts on a card come from the read the card was scored by", () => {
  // The reason the read moved into the score rather than being bought twice.
  // "+1.4 overall, mid −2.1" has to be one board evaluated once; two reads of
  // the same arrangement are two chances for the headline and its explanation to
  // disagree, and nothing downstream could tell which was wrong.
  const report = rebalance(data, draft, settings)!;
  const shown = [...report.seatFixes, ...report.swaps, ...report.options, ...report.laneFixes];
  assert.ok(shown.length > 0, "the fixture puts something on the screen");

  for (const option of shown) {
    const board = laneScoreboard(
      data,
      { ...draft, mine: option.picks, lanePlan: option.lanePlan },
      settings,
    );
    for (const shift of option.laneShifts) {
      near(shift.after, board.get(shift.key)!.score, `${shift.key} after`);
      near(
        shift.after - shift.before,
        shift.delta,
        `${shift.key} moves by the difference it reports`,
      );
    }
  }
});

test("a change of deployment cannot move the mid read", () => {
  // The fact the lane-read pruning rests on, tested where it is true rather than
  // through the search that exploits it. There is one mid lane: mid meets mid
  // under either plan and position 2 stands in it under either plan, so every
  // term of the mid read is identical across a swap — which is why a candidate
  // that only changes the deployment is never read on a board losing mid. If
  // `LANE_SIDES` or `LANE_FOR_POSITION` ever stop agreeing about that, this
  // fails and the rule's justification goes with it.
  const standard = laneScoreboard(data, draft, settings);
  const swapped = laneScoreboard(data, { ...draft, lanePlan: "swapped" }, settings);

  near(swapped.get("mid")!.score, standard.get("mid")!.score, "mid is untouched by a swap");
  assert.notEqual(
    swapped.get("safe")!.score,
    standard.get("safe")!.score,
    "while the lanes a swap really does re-point are not",
  );
});

// ----------------------------------------------------------- role threshold

test("the role threshold is the only thing allowed to pin a hero", () => {
  // alpha plays offlane in 30% of his games and beta mid in 30% of theirs, so a
  // threshold above that leaves nowhere for either to go.
  const report = rebalance(data, draft, { ...settings, minRoleFit: 0.5 })!;

  assert.equal(report.pinned, true, "one seating survived — the board's own");
  assert.ok(
    report.options.every((o) => o.moves.length === 0),
    "with the seats fixed, only the lane plan is on the table",
  );
});

test("an arrangement the threshold rules out is set aside, not silently dropped", () => {
  // The failure this list exists for: a line-up whose only mid-capable hero is
  // pinned there has *no legal* way to move him, and the panel used to report
  // that as the draft already being correctly seated.
  const report = rebalance(data, draft, { ...settings, minRoleFit: 0.5 })!;
  const beyond = report.beyondThreshold[0];

  assert.ok(beyond, "the arrangement still exists and is still worth something");
  assert.equal(beyond!.legal, false, "and it is marked as what it is");
  assert.ok(beyond!.gain.total >= NOISE);
  assert.ok(
    beyond!.moves.some((m) => m.fit < 0.5),
    "and it is on this list precisely because somebody is below the threshold",
  );
  assert.ok(beyond!.stretch, "with the hero it asks the most of named");
  assert.equal(beyond!.stretch!.fit, 0.3);

  assert.equal(report.counts.seatings, 120);
  assert.equal(report.counts.legalSeatings, 1, "everything but the board's own seating");
  assert.equal(report.minRoleFit, 0.5, "the report carries the threshold it used");
});

test("the seats only one hero can take are reported, since they explain the rest", () => {
  const report = rebalance(data, draft, settings)!;
  const forced = Object.fromEntries(report.forced.map((f) => [f.position, f.name]));

  // carry, sup4 and sup5 each play exactly one position; alpha and beta both
  // clear the threshold at 2 and at 3, so neither of those seats is forced.
  assert.deepEqual(forced, { 1: "CARRY", 4: "SUP4", 5: "SUP5" });
});

test("a line-up with one mid-capable hero says so instead of blaming the draft", () => {
  // beta can only play offlane now, so alpha is nailed to mid however badly it
  // goes — the shape of the board in the bug report.
  const pinnedData = makeDataset();
  const beta = pinnedData.bySlug.get("beta")!;
  beta.positions = { 3: 1 };
  const report = rebalance(pinnedData, draft, settings)!;

  assert.ok(
    report.forced.some((f) => f.position === 2 && f.name === "ALPHA"),
    "mid is the seat nobody else can take",
  );
  assert.equal(report.pinned, true);
  assert.ok(
    report.beyondThreshold.length > 0,
    "and the arrangement that would move him is offered as an aside",
  );
});

// ------------------------------------------------------------- lane swaps

test("a lane swap is priced by the lane each hero would actually stand in", () => {
  // A carry who is ten points better from the off lane than from his own — the
  // fixture equivalent of a safe lane that cannot be held. Sending him to the
  // off lane has to show up, and it has to show up in the term that is about
  // lanes: `fit` is what a hero is worth in a *seat*, and a swap changes no
  // seats at all.
  // A lane edge needs two sides, so the enemy is given a flat 50 everywhere:
  // their reading is the same whichever of my heroes walks into them, and the
  // whole difference between the two boards is my carry's own record.
  const withLanes = makeDataset({ safe: laneStats(45), off: laneStats(55) });
  const flat = { safe: laneStats(50), off: laneStats(50), mid: laneStats(50) };
  withLanes.heroes = withLanes.heroes.map((h) =>
    h.slug.startsWith("their") || h.slug === "nemesis" ? { ...h, lanes: flat } : h,
  );
  withLanes.bySlug = new Map(withLanes.heroes.map((h) => [h.slug, h]));
  const swapped = { ...draft, lanePlan: "swapped" as const };

  const standard = scoreArrangement(withLanes, draft, settings, {
    picks: draft.mine,
    lanePlan: "standard",
  });
  const swap = scoreArrangement(withLanes, swapped, settings, {
    picks: draft.mine,
    lanePlan: "swapped",
  });

  near(swap.fit, standard.fit, "nobody changed position, so nobody changed seat");
  assert.ok(swap.lanes > standard.lanes, "but the safe lane is no longer being held by the carry");

  // 10 points of lane record, shrunk by presence (80 / (80 + 12)). The safe lane
  // is the only one of the three with a reading on both sides — my offlane pair
  // and my mid have no rows — so it is the whole of the term, and the form
  // weighting cancels out of a blend with one term in it.
  near(swap.lanes - standard.lanes, 10 * (80 / 92), "and that is what moved");
});

test("standing where your position says you stand costs nothing", () => {
  // Lane rows are read from the ground a hero is standing on, so under the
  // standard plan the safe-lane row is the one the carry's position already
  // implied. The fixture's other four heroes have no rows at all, so the whole
  // difference between these two boards is the carry's — and it is confined to
  // the lane term. `fit` must not move: it is the seat, and the seats are
  // identical.
  const withLanes = makeDataset({ safe: laneStats(45), off: laneStats(55) });
  const arrangement = { picks: draft.mine, lanePlan: "standard" as const };

  near(
    scoreArrangement(withLanes, draft, settings, arrangement).fit,
    scoreArrangement(data, draft, settings, arrangement).fit,
    "a lane record is not a second opinion on the record positionWinRate gave",
  );
  assert.equal(
    scoreArrangement(data, draft, settings, arrangement).lanes,
    0,
    "and a scrape with no lane rows anywhere leaves the term exactly where it was before it existed",
  );
});

test("a board already on a swap is offered the way back", () => {
  // The same fixture with my 5 losing his matchup instead of winning it. A swap
  // doubles that pairing, so undoing the swap is now the move — and it is one no
  // reshuffle of the seats can reach.
  const hostile = makeDataset();
  hostile.matchups = { ...hostile.matchups, sup5: { theirSup: row(6) } };
  const report = rebalance(hostile, { ...draft, lanePlan: "swapped" }, settings)!;

  const back = report.options.find((o) => o.lanePlan === "standard");
  assert.ok(back?.swapsLanes, "returning to normal lanes is an arrangement like any other");
  assert.deepEqual(back!.moves, [], "and it moves nobody");
  near(bySize(report)[1]!.gain.total, 1.6, "worth 1.6 on its own");
});

// ------------------------------------------------------------------- wording

test("the button and the panel are handed the same words about the same option", () => {
  const report = rebalance(data, draft, settings)!;
  const best = report.best!;

  assert.equal(buttonLabel(report), `Rebalance +2.8 overall`);
  assert.equal(
    headlineFor(best).unit,
    "overall",
    "the sum of draft and seats is never called the board figure",
  );
  assert.equal(headlineFor(best).value, "+2.8");
});

test("a two-hero rotation is called a swap, because that is what a captain calls it", () => {
  const report = rebalance(data, draft, settings)!;
  const sizes = bySize(report);

  assert.equal(describeOption(sizes[2]!), "Swap BETA and ALPHA");
  assert.equal(describeOption(sizes[1]!), "Swap lanes — nobody changes position");
  assert.equal(describeOption(sizes[3]!), "Swap BETA and ALPHA and walk the duos the other way");

  assert.equal(costOf(sizes[1]!), "lanes only");
  assert.equal(costOf(sizes[2]!), "2 moves");
  assert.equal(costOf(sizes[3]!), "2 moves + lanes");
});

test("the button falls back to a plain label when there is nothing to report", () => {
  assert.equal(buttonLabel(null), "Rebalance");
});

test("a seat reading moves what an arrangement is worth", () => {
  // beta at 3 stands opposite their carry; at mid he never meets them.
  const seatAware: Dataset = {
    ...data,
    laneCounters: {
      cells: { beta: { 3: { theirCarry: { raw: 6, noise: 0.02, lanes: 20_000 } } } },
      signalVar: 1,
      slope: 1,
      pairs: 600,
    },
  };
  const board = { picks: draft.mine, lanePlan: "standard" as const };
  const swap = {
    picks: [pick("alpha", 3), pick("beta", 2), pick("carry", 1), pick("sup4", 4), pick("sup5", 5)],
    lanePlan: "standard" as const,
  };
  const edge = 6 / 1.02;
  const advantage = (set: Dataset, arrangement: typeof board) =>
    scoreArrangement(set, draft, settings, arrangement).advantage;

  // One of five pairings, counted double for sharing a lane.
  near(advantage(seatAware, board) - advantage(data, board), (2 * edge) / 5, "the board");
  near(advantage(seatAware, swap), advantage(data, swap), "beta at mid");
  assert.ok(
    advantage(seatAware, board) - advantage(seatAware, swap) >
      advantage(data, board) - advantage(data, swap),
    "the seat reading is an argument for leaving beta where he is",
  );
});
