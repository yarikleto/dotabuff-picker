import test from "node:test";
import assert from "node:assert/strict";
import { describeFetchError, explainFailure } from "./scrape.mjs";

const joined = (reason) => explainFailure(reason).join("\n");

test("importing the scraper does not start a run", () => {
  // The module guards main() behind an "invoked directly" check; if that
  // regresses, this file would hang or hammer Dotabuff on every test run.
  assert.equal(typeof explainFailure, "function");
});

test("a 403 points at the browser route, not just a cookie", () => {
  const advice = joined("HTTP 403 for /heroes/axe/matchups");
  assert.match(advice, /403/);
  assert.match(advice, /Cloudflare/);
  assert.match(advice, /--browser/, "the route that actually gets past Cloudflare");
  assert.match(advice, /TLS/, "say why a copied cookie is usually not enough");
  assert.match(advice, /--cookie=/, "still mention the cookie as a secondary option");
});

test("network errors are told apart from blocks", () => {
  for (const reason of [
    "fetch failed (ENOTFOUND)",
    "fetch failed (EAI_AGAIN) — getaddrinfo",
    "connect ECONNREFUSED 1.2.3.4:443",
    "fetch failed (UND_ERR_CONNECT_TIMEOUT)",
  ]) {
    const advice = joined(reason);
    assert.match(advice, /network problem|VPN|proxy/i, `unhelpful advice for: ${reason}`);
    assert.doesNotMatch(advice, /--cookie=/, `a cookie will not fix: ${reason}`);
  }
});

test("rate limiting suggests slowing down", () => {
  assert.match(joined("HTTP 429"), /--delay=/);
});

test("an unrecognised failure points at --diagnose", () => {
  assert.match(joined("something odd"), /--diagnose/);
  assert.match(joined(""), /--diagnose/);
  assert.match(joined(undefined), /--diagnose/);
});

test("describeFetchError surfaces the underlying cause code", () => {
  const err = new Error("fetch failed");
  err.cause = Object.assign(new Error("getaddrinfo ENOTFOUND www.dotabuff.com"), {
    code: "ENOTFOUND",
  });
  const described = describeFetchError(err);
  assert.match(described, /ENOTFOUND/);
  assert.match(described, /getaddrinfo/, "the cause message is the useful part");

  // A bare error must still round-trip without inventing detail.
  assert.equal(describeFetchError(new Error("HTTP 500 for /x")), "HTTP 500 for /x");
});
