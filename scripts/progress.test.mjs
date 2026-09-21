import test from "node:test";
import assert from "node:assert/strict";
import { RESUME_WINDOW_HOURS, staleProgress } from "./progress.mjs";

// Run with: node --test scripts/*.test.mjs

const now = Date.parse("2026-09-19T12:00:00Z");
const hoursAgo = (h) => new Date(now - h * 3_600_000).toISOString();

test("an interrupted run from today is resumed", () => {
  assert.equal(staleProgress({ matches: 120_000, savedAt: hoursAgo(2) }, { target: 300_000, now }), null);
  assert.equal(staleProgress(null, { target: 300_000, now }), null, "nothing saved, nothing to refuse");
});

test("a finished run is never resumed, however recent", () => {
  // Resuming it collects nothing and rewrites the same matches with today's date.
  assert.match(staleProgress({ matches: 300_000, savedAt: hoursAgo(1) }, { target: 300_000, now }), /finished/);
  assert.match(staleProgress({ matches: 589_922, savedAt: hoursAgo(1) }, { target: 300_000, now }), /finished/);
});

test("a run left for more than a day starts over", () => {
  assert.match(
    staleProgress({ matches: 120_000, savedAt: hoursAgo(RESUME_WINDOW_HOURS + 1) }, { target: 300_000, now }),
    /25 hours old/,
  );
});

test("progress saved before it was dated is not trusted", () => {
  assert.match(staleProgress({ matches: 120_000 }, { target: 300_000, now }), /no date/);
});
