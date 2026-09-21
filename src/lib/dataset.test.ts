import test from "node:test";
import assert from "node:assert/strict";
import { expandSynergies } from "./dataset.ts";
import { synergy, synergyCell } from "./scoring.ts";
import type { Dataset } from "../types.ts";

// Run with: node --test --experimental-strip-types src/lib/*.test.ts

/**
 * The collector writes each pairing once, under whichever slug sorts first, and
 * labels its core/support cells in that same order. The reader mirrors the row
 * so both directions exist — which means the two *mixed* cells have to swap on
 * the way, and getting that backwards would silently hand every lookup the
 * wrong half of the pairing.
 *
 * `"ally" < "flexer"`, so in the payload below `cs` reads "ally farmed, flexer
 * did not".
 */
const payload = {
  ally: {
    flexer: [1, 6_000, 51, { cc: [8, 3_000], cs: [-6, 2_500] }],
    plain: [3, 4_000, 53],
  },
} as unknown as Parameters<typeof expandSynergies>[0];

const asDataset = (synergies: ReturnType<typeof expandSynergies>): Dataset =>
  ({ synergies }) as Dataset;

test("expandSynergies mirrors a pairing into both directions", () => {
  const table = expandSynergies(payload);
  assert.ok(table.ally?.flexer, "the stored direction");
  assert.ok(table.flexer?.ally, "and the mirrored one");
  assert.equal(table.ally.flexer.synergy, 1);
  assert.equal(table.flexer.ally.synergy, 1);
  assert.equal(table.flexer.ally.matches, 6_000);
});

test("mirroring swaps the mixed cells and leaves the matched ones alone", () => {
  const { ally, flexer } = expandSynergies(payload);

  assert.equal(ally.flexer.cells?.cc?.synergy, 8);
  assert.equal(ally.flexer.cells?.cs?.synergy, -6, "ally farmed, flexer did not");
  assert.equal(ally.flexer.cells?.sc, undefined, "cells the collector left out stay out");

  assert.equal(flexer.ally.cells?.cc?.synergy, 8, "two cores reads the same either way");
  assert.equal(flexer.ally.cells?.sc?.synergy, -6, "read backwards it is now sc");
  assert.equal(flexer.ally.cells?.cs, undefined);

  // Sample sizes travel with the cell they belong to.
  assert.equal(flexer.ally.cells?.sc?.matches, 2_500);
});

test("a pairing with no cells is passed through untouched", () => {
  const table = expandSynergies(payload);
  assert.equal(table.ally.plain.cells, undefined);
  assert.equal(table.plain.ally.cells, undefined);
  assert.equal(table.plain.ally.synergy, 3);
});

test("malformed cells are dropped rather than trusted", () => {
  const table = expandSynergies({
    a: {
      b: [1, 100, 50, { cc: [2, 50], cs: ["nonsense"], sc: null, ss: [Number.NaN, 10] }],
      c: [1, 100, 50, "not an object"],
    },
  } as unknown as Parameters<typeof expandSynergies>[0]);

  assert.equal(table.a.b.cells?.cc?.synergy, 2, "the good cell survives");
  assert.equal(table.a.b.cells?.cs, undefined);
  assert.equal(table.a.b.cells?.sc, undefined);
  assert.equal(table.a.b.cells?.ss, undefined, "NaN is not a synergy");
  assert.equal(table.a.c.cells, undefined, "a non-object cells field is ignored");
});

/**
 * The end the app actually uses: the same question asked from either hero must
 * give the same answer, whichever way the row happened to be stored.
 */
test("the scoring lookup agrees from both ends of a pairing", () => {
  const data = asDataset(expandSynergies(payload));

  // ally as pos 1 (core) with flexer as pos 2 (core) -> cc
  assert.equal(synergyCell(1, 2), "cc");
  assert.equal(synergy(data, "ally", "flexer", 1, 2)?.synergy, 8);
  assert.equal(synergy(data, "flexer", "ally", 2, 1)?.synergy, 8);

  // ally as pos 1 (core) with flexer as pos 4 (support) -> cs stored, sc mirrored
  assert.equal(synergy(data, "ally", "flexer", 1, 4)?.synergy, -6);
  assert.equal(synergy(data, "flexer", "ally", 4, 1)?.synergy, -6);

  // And the cell's own sample size comes with it, from either side.
  assert.equal(synergy(data, "ally", "flexer", 1, 4)?.matches, 2_500);
  assert.equal(synergy(data, "flexer", "ally", 4, 1)?.matches, 2_500);
});

test("a cell the collector omitted falls back to the blended figure", () => {
  const data = asDataset(expandSynergies(payload));
  // Both supports: no `ss` cell was written, so the pairing's own number stands.
  assert.equal(synergyCell(4, 5), "ss");
  assert.equal(synergy(data, "ally", "flexer", 4, 5)?.synergy, 1);
  assert.equal(synergy(data, "ally", "flexer", 4, 5)?.matches, 6_000);
});
