import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  DIRECTIONS,
  POSITIONS,
  buildLanes,
  compactRows,
  foldLanes,
  isReusable,
  isSettled,
  laneVariables,
  parseBrackets,
  planRequests,
  readOptions,
} from "./lanes.mjs";
import { weekEndMs } from "./stratz.mjs";

// Run with: node --test scripts/*.test.mjs

const DAY = 24 * 60 * 60 * 1000;

/** A real laneOutcome response, trimmed: week 2958, position 3, against, every rank. */
const fixture = async () =>
  JSON.parse(await readFile(new URL("./fixtures/stratz-lane-outcome.json", import.meta.url), "utf8")).data
    .heroStats.laneOutcome;

const HEROES = new Map([
  [1, "anti-mage"],
  [2, "axe"],
  [8, "juggernaut"],
  [48, "luna"],
  [54, "lifestealer"],
]);

test("a week settles a week after it ends", () => {
  assert.equal(isSettled(2958, weekEndMs(2958) + 3 * DAY), false);
  assert.equal(isSettled(2958, weekEndMs(2958) + 8 * DAY), true);
});

test("one request per week, position and direction, each named for its cache file", () => {
  const requests = planRequests([2957, 2958], []);
  assert.equal(requests.length, 2 * POSITIONS.length * DIRECTIONS.length);
  assert.equal(new Set(requests.map((r) => r.cacheKey)).size, requests.length, "cache keys are unique");
  assert.ok(requests.some((r) => r.cacheKey === "lanes-all-w2958-p3-against"));

  const divine = planRequests([2958], ["DIVINE_IMMORTAL"]);
  assert.ok(divine.every((r) => r.cacheKey.startsWith("lanes-divine_immortal-")), "a rank band gets its own cache");
});

test("the request sends the week as epoch seconds and the filters as enums", () => {
  assert.deepEqual(laneVariables({ week: 2958, position: 3, direction: "against", brackets: [] }), {
    week: 1_788_998_400,
    isWith: false,
    positions: ["POSITION_3"],
    brackets: null,
  });
  assert.equal(laneVariables({ week: 2958, position: 5, direction: "with", brackets: [] }).isWith, true);
  assert.deepEqual(
    laneVariables({ week: 2958, position: 1, direction: "with", brackets: ["DIVINE_IMMORTAL"] }).brackets,
    ["DIVINE_IMMORTAL"],
  );
});

test("real rows are filed under the position that was asked for, not the one they claim", async () => {
  const rows = await fixture();
  // Fetched for position 3; every row says POSITION_1 anyway.
  assert.ok(rows.every((r) => r.position === "POSITION_1"));

  const totals = new Map();
  foldLanes(totals, { position: 3, direction: "against" }, compactRows(rows));
  const { against } = buildLanes(totals, HEROES, { minLanes: 50 });

  assert.deepEqual(against.axe[3]["anti-mage"], [12078, 3890, 3229, 3568, 6774]);
  assert.deepEqual(against.axe[3].lifestealer, [34528, 11150, 9135, 10168, 14901]);
  assert.equal(against.axe[1], undefined, "nothing was filed under position 1");
});

test("malformed rows are dropped, missing extras default to zero", () => {
  const rows = compactRows([
    { heroId1: 2, heroId2: 1, matchCount: 10, winCount: 4, drawCount: 3, lossCount: 2 },
    { heroId1: 2, heroId2: null, matchCount: 10, winCount: 4, drawCount: 3, lossCount: 2 },
    { heroId1: 2, heroId2: 8, matchCount: "10", winCount: 4, drawCount: 3, lossCount: 2 },
    { heroId1: 2, heroId2: 8, matchCount: 10, winCount: -1, drawCount: 3, lossCount: 2 },
  ]);
  assert.deepEqual(rows, [[2, 1, 10, 4, 3, 2, 0, 0, 0]]);
  assert.deepEqual(compactRows(undefined), []);
});

test("weeks add up, and the two directions never mix", () => {
  const totals = new Map();
  foldLanes(totals, { position: 3, direction: "against" }, [[2, 1, 100, 40, 30, 20, 55]]);
  foldLanes(totals, { position: 3, direction: "against" }, [[2, 1, 50, 20, 10, 10, 24]]);
  foldLanes(totals, { position: 3, direction: "with" }, [[2, 1, 60, 30, 20, 5, 33]]);
  const built = buildLanes(totals, HEROES, { minLanes: 0 });

  assert.deepEqual(built.against.axe[3]["anti-mage"], [150, 60, 40, 30, 79]);
  assert.deepEqual(built.with.axe[3]["anti-mage"], [60, 30, 20, 5, 33]);
});

test("the sample floor counts wins, draws and losses, not matchCount", () => {
  const totals = new Map();
  // matchCount 80, but only 45 won, drawn or lost: below a floor of 50.
  foldLanes(totals, { position: 3, direction: "against" }, [[2, 1, 80, 20, 15, 10]]);
  foldLanes(totals, { position: 3, direction: "against" }, [[2, 8, 60, 20, 20, 10]]);
  const built = buildLanes(totals, HEROES, { minLanes: 50 });

  assert.deepEqual(Object.keys(built.against.axe[3]), ["juggernaut"]);
  assert.equal(built.kept, 1);
  assert.equal(built.thin, 1);
});

test("heroes the roster does not know are skipped and reported; a hero never faces itself", () => {
  const totals = new Map();
  foldLanes(totals, { position: 2, direction: "against" }, [
    [2, 999, 500, 200, 100, 100],
    [2, 2, 500, 200, 100, 100],
    [2, 8, 500, 200, 100, 100],
  ]);
  const built = buildLanes(totals, HEROES, { minLanes: 0 });
  assert.deepEqual(Object.keys(built.against.axe[2]), ["juggernaut"]);
  assert.deepEqual(built.unknown, [999]);
});

test("the published tables are sorted, so reruns diff cleanly", () => {
  const totals = new Map();
  foldLanes(totals, { position: 3, direction: "against" }, [
    [8, 54, 500, 200, 100, 100],
    [2, 54, 500, 200, 100, 100],
    [2, 1, 500, 200, 100, 100],
  ]);
  const { against } = buildLanes(totals, HEROES, { minLanes: 0 });
  assert.deepEqual(Object.keys(against), ["axe", "juggernaut"]);
  assert.deepEqual(Object.keys(against.axe[3]), ["anti-mage", "lifestealer"]);
});

test("a settled week is reused forever; a settling one only briefly; an empty one never", () => {
  const entry = (week, fetchedAt, rows = [[2, 1, 10, 4, 3, 2]]) => ({ week, fetchedAt, rows });
  const now = weekEndMs(2958) + 3 * DAY;

  assert.equal(isReusable(entry(2950, "2026-01-01T00:00:00Z"), now), true, "settled, however old the fetch");
  assert.equal(isReusable(entry(2958, new Date(now - 2 * 3600e3).toISOString()), now), true, "settling, fetched 2h ago");
  assert.equal(isReusable(entry(2958, new Date(now - 13 * 3600e3).toISOString()), now), false, "settling, fetched 13h ago");
  assert.equal(isReusable(entry(2950, "2026-01-01T00:00:00Z", []), now), false);
  assert.equal(isReusable(null, now), false);
});

test("rank bands are validated, case-insensitive and put in a stable order", () => {
  assert.deepEqual(parseBrackets(""), []);
  assert.deepEqual(parseBrackets("divine_immortal, legend_ancient,DIVINE_IMMORTAL"), [
    "LEGEND_ANCIENT",
    "DIVINE_IMMORTAL",
  ]);
  assert.throws(() => parseBrackets("IMMORTAL"), /unknown --bracket "IMMORTAL"/);
});

test("options default to four weeks and a floor of fifty, and reject nonsense", () => {
  const options = readOptions([]);
  assert.equal(options.weeks, 4);
  assert.equal(options.minLanes, 50);
  assert.deepEqual(options.brackets, []);
  assert.equal(readOptions(["--weeks=8", "--offline"]).weeks, 8);
  assert.equal(readOptions(["--offline"]).offline, true);
  for (const bad of ["--weeks=0", "--weeks=27", "--weeks=2.5", "--min-lanes=-1"]) {
    assert.throws(() => readOptions([bad]), /must be a whole number/, bad);
  }
});

test("--probe needs the network, so it refuses --offline instead of crashing", () => {
  assert.throws(() => readOptions(["--probe", "--offline"]), /cannot run --offline/);
});

test("flags meant for other refresh steps are ignored", () => {
  // `npm run refresh` forwards everything; --timeout means seconds to one script and ms to another.
  assert.doesNotThrow(() => readOptions(["--headed", "--timeout=1800", "--matches=800000", "--min-rank=70"]));
});
