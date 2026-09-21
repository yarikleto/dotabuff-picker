import test from "node:test";
import assert from "node:assert/strict";
import {
  BANDS,
  GAME_MODES,
  PAGE,
  describePositions,
  fetchAllRows,
  foldWinWeek,
  readOptions,
  sortTable,
} from "./positions.mjs";
import { WEEK_SECONDS } from "./stratz.mjs";

// Run with: node --test scripts/*.test.mjs

const byId = new Map([
  [2, "axe"],
  [49, "dragon-knight"],
]);
const row = (week, heroId, matchCount, winCount) => ({ week: week * WEEK_SECONDS, heroId, matchCount, winCount });

test("the bands are the three the app's rank switch offers", () => {
  assert.deepEqual(BANDS.map((b) => b.key), ["all", "divine", "immortal"]);
  assert.equal(BANDS[0].brackets, null, "all ranks means no bracket filter");
  assert.deepEqual(GAME_MODES, ["ALL_PICK_RANKED"]);
});

test("only the weeks asked for are counted, summed, under the requested position", () => {
  const table = {};
  const games = foldWinWeek(table, {
    band: "all",
    position: 2,
    weeks: [2957, 2958],
    byId,
    rows: [row(2957, 49, 100, 55), row(2958, 49, 50, 25), row(2940, 49, 999, 999), row(2958, 2, 10, 4)],
  });
  assert.equal(games, 160);
  assert.deepEqual(table["dragon-knight"].all, [[0, 0], [150, 80], [0, 0], [0, 0], [0, 0]]);
  assert.deepEqual(table.axe.all[1], [10, 4]);
});

test("rows for heroes the roster lacks, or with broken counts, are skipped", () => {
  const table = {};
  const games = foldWinWeek(table, {
    band: "divine",
    position: 3,
    weeks: [2958],
    byId,
    rows: [row(2958, 999, 100, 50), row(2958, 2, "10", 5), row(2958, 2, 10, -1), null],
  });
  assert.equal(games, 0);
  assert.deepEqual(table, {});
});

test("pages are fetched until a short one comes back", async () => {
  const sizes = [PAGE, PAGE, 3];
  const asked = [];
  const client = {
    query: async (_doc, variables) => {
      asked.push(variables);
      return { heroStats: { winWeek: Array.from({ length: sizes.shift() }, () => row(2958, 2, 1, 1)) } };
    },
  };
  const rows = await fetchAllRows(client, BANDS[1], 4);
  assert.equal(rows.length, 2 * PAGE + 3);
  assert.deepEqual(asked.map((v) => v.skip), [0, PAGE, 2 * PAGE]);
  assert.deepEqual(asked[0].positions, ["POSITION_4"]);
  assert.deepEqual(asked[0].brackets, ["DIVINE", "IMMORTAL"]);
  assert.deepEqual(asked[0].modes, ["ALL_PICK_RANKED"]);
});

test("positions are described the way the sanity line reads them", () => {
  assert.equal(describePositions([[10, 5], [60, 30], [30, 15], [0, 0], [0, 0]]), "2(60%)/3(30%)");
  assert.equal(describePositions([[0, 0], [0, 0], [0, 0], [0, 0], [0, 0]]), "no games");
});

test("the table is written in slug order", () => {
  assert.deepEqual(Object.keys(sortTable({ zeus: 1, axe: 2, lion: 3 })), ["axe", "lion", "zeus"]);
});

test("the window is 1 to 12 weeks", () => {
  assert.equal(readOptions([]).weeks, 4);
  assert.equal(readOptions([]).offline, false);
  assert.equal(readOptions(["--weeks=8", "--headed"]).weeks, 8);
  assert.equal(readOptions(["--offline"]).offline, true, "npm run refresh -- --offline reaches this step too");
  assert.throws(() => readOptions(["--weeks=0"]), /1 to 12/);
  assert.throws(() => readOptions(["--weeks=13"]), /1 to 12/);
});
