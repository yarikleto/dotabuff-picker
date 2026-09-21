import test from "node:test";
import assert from "node:assert/strict";
import { bandForMinRank, sharesFromCounts } from "./synergy.mjs";

// Run with: node --test scripts/*.test.mjs

test("the rank band follows the run's own rank floor", () => {
  assert.equal(bandForMinRank(0), "all");
  assert.equal(bandForMinRank(60), "all");
  assert.equal(bandForMinRank(70), "divine");
  assert.equal(bandForMinRank(75), "divine");
  assert.equal(bandForMinRank(80), "immortal");
});

test("shares come from the band's game counts and sum to one", () => {
  const payload = {
    heroes: {
      "dragon-knight": {
        all: [[10, 5], [30, 16], [50, 25], [5, 2], [5, 2]],
        divine: [[5, 2], [50, 26], [45, 22], [0, 0], [0, 0]],
      },
      ghost: { all: [[0, 0], [0, 0], [0, 0], [0, 0], [0, 0]] },
      broken: { all: [[1, 1]] },
    },
  };
  const all = sharesFromCounts(payload, "all");
  assert.deepEqual([...all.keys()], ["dragon-knight"], "empty and malformed rows are left out");
  assert.deepEqual(all.get("dragon-knight"), { 1: 0.1, 2: 0.3, 3: 0.5, 4: 0.05, 5: 0.05 });
  assert.equal(sharesFromCounts(payload, "divine").get("dragon-knight")[2], 0.5);
  assert.equal(sharesFromCounts(payload, "immortal").size, 0);
  assert.equal(sharesFromCounts(null, "all").size, 0);
});
