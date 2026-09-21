import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  ENDPOINT,
  StratzError,
  budget,
  checkTokenShape,
  completeWeeks,
  createClient,
  mapHeroIds,
  parseRoster,
  readToken,
  redact,
  retryAfter,
  weekEndMs,
  weekOf,
  weekStartMs,
} from "./stratz.mjs";

// Run with: node --test scripts/*.test.mjs

/** Shaped like a real STRATZ token: three base64url segments, long enough to truncate. */
const TOKEN = `${"a".repeat(36)}.${"b".repeat(250)}.${"c".repeat(43)}`;

function reply(status, body, headers = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return { status, ok: status >= 200 && status < 300, headers: new Headers(headers), text: async () => text };
}

/** A fetch that hands out canned replies in order and remembers what it was asked. */
function scripted(...replies) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    const next = replies.shift();
    if (!next) throw new Error("no reply scripted for this request");
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetch, calls };
}

const waits = () => {
  const list = [];
  return { list, sleep: async (ms) => void list.push(ms) };
};

test("the environment wins over the Keychain, so a one-off run can swap tokens", () => {
  const token = readToken({
    env: { STRATZ_TOKEN: TOKEN },
    platform: "darwin",
    exec: () => assert.fail("the Keychain should not be read"),
  });
  assert.equal(token, TOKEN);
});

test("on macOS the token comes from the Keychain item the docs tell you to create", () => {
  let asked;
  const token = readToken({
    env: {},
    platform: "darwin",
    exec: (cmd, args) => {
      asked = [cmd, ...args];
      return `${TOKEN}\n`;
    },
  });
  assert.equal(token, TOKEN);
  assert.deepEqual(asked, ["security", "find-generic-password", "-s", "stratz-api-token", "-w"]);
});

test("no token anywhere is a fatal error that says how to add one", () => {
  const missing = () => {
    throw new Error("The specified item could not be found in the keychain.");
  };
  for (const platform of ["darwin", "linux"]) {
    assert.throws(
      () => readToken({ env: {}, platform, exec: missing }),
      (err) => err instanceof StratzError && err.fatal && /No STRATZ API token/.test(err.message) &&
        /STRATZ_TOKEN/.test(err.message),
    );
  }
});

test("a token cut at 128 characters is named as the Keychain prompt's doing, without printing it", () => {
  const truncated = TOKEN.slice(0, 128);
  assert.equal(truncated.split(".").length, 2, "the fixture has to lose its signature at 128");
  assert.throws(
    () => checkTokenShape(truncated, "the Keychain"),
    (err) =>
      err.fatal &&
      /2 of 3 parts, 128 characters/.test(err.message) &&
      /prompt cuts input there/.test(err.message) &&
      !err.message.includes(truncated),
  );
  assert.doesNotThrow(() => checkTokenShape(TOKEN, "the Keychain"));
});

test("redact removes every copy of the token", () => {
  assert.equal(redact(`a ${TOKEN} b ${TOKEN}`, TOKEN), "a <token> b <token>");
  assert.equal(redact("nothing here", TOKEN), "nothing here");
});

test("the per-second and per-minute budgets are waited out; the hour and day are not", () => {
  const h = (remaining) =>
    new Headers(Object.fromEntries(Object.entries(remaining).map(([k, v]) => [`x-ratelimit-remaining-${k}`, String(v)])));
  assert.deepEqual(budget(h({ second: 5, minute: 100, hour: 900, day: 9000 })), { waitMs: 0, stop: null });
  assert.deepEqual(budget(h({ second: 0, minute: 100 })), { waitMs: 1000, stop: null });
  assert.deepEqual(budget(h({ second: 3, minute: 0 })), { waitMs: 60_000, stop: null });
  assert.equal(budget(h({ hour: 0 })).stop, "hour");
  assert.equal(budget(h({ hour: 10, day: 0 })).stop, "day");
  assert.deepEqual(budget(new Headers()), { waitMs: 0, stop: null }, "no headers, no opinion");
});

test("retry-after is read in seconds, falling back to the reset header", () => {
  assert.equal(retryAfter(new Headers({ "retry-after": "3" })), 3000);
  assert.equal(retryAfter(new Headers({ "ratelimit-reset": "1" })), 1000);
  assert.equal(retryAfter(new Headers()), null);
});

test("a query is a POST with the bearer token and the User-Agent STRATZ requires", async () => {
  const { fetch, calls } = scripted(reply(200, { data: { ok: true } }));
  const client = createClient({ token: TOKEN, fetch, spacing: 0 });
  assert.deepEqual(await client.query("{ ok }", { a: 1 }), { ok: true });

  const [{ url, init }] = calls;
  assert.equal(url, ENDPOINT);
  assert.equal(init.method, "POST");
  assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(init.headers["User-Agent"], "STRATZ_API");
  assert.deepEqual(JSON.parse(init.body), { query: "{ ok }", variables: { a: 1 } });
});

test("a 429 waits as long as the server asks and then retries", async () => {
  const { fetch, calls } = scripted(
    reply(429, { message: "slow down" }, { "retry-after": "3" }),
    reply(200, { data: { ok: 1 } }),
  );
  const { list, sleep } = waits();
  const client = createClient({ token: TOKEN, fetch, spacing: 0, sleep });
  assert.deepEqual(await client.query("{ ok }"), { ok: 1 });
  assert.equal(calls.length, 2);
  assert.ok(list.includes(3000), `expected a 3s wait, saw ${JSON.stringify(list)}`);
});

test("a dropped connection is retried with backoff", async () => {
  const { fetch, calls } = scripted(new TypeError("fetch failed"), reply(200, { data: { ok: 1 } }));
  const { list, sleep } = waits();
  const client = createClient({ token: TOKEN, fetch, spacing: 0, sleep });
  assert.deepEqual(await client.query("{ ok }"), { ok: 1 });
  assert.equal(calls.length, 2);
  assert.ok(list.includes(2000));
});

test("a refused token is fatal and the message never carries the token", async () => {
  const { fetch } = scripted(reply(403, { message: `token ${TOKEN} is not valid` }, { "content-type": "application/json" }));
  const client = createClient({ token: TOKEN, fetch, spacing: 0 });
  await assert.rejects(client.query("{ ok }"), (err) =>
    err instanceof StratzError && err.fatal && /refused the token \(HTTP 403/.test(err.message) &&
    !err.message.includes(TOKEN),
  );
});

test("a Cloudflare challenge is told apart from a refused token", async () => {
  const { fetch } = scripted(
    reply(403, "<html>Just a moment...</html>", { "content-type": "text/html", "cf-mitigated": "challenge" }),
  );
  const client = createClient({ token: TOKEN, fetch, spacing: 0 });
  await assert.rejects(client.query("{ ok }"), /Cloudflare challenged the request/);
});

test("GraphQL errors surface as a StratzError with the server's words, redacted", async () => {
  const { fetch } = scripted(reply(200, { errors: [{ message: "Unknown argument" }, { message: `echo ${TOKEN}` }] }));
  const client = createClient({ token: TOKEN, fetch, spacing: 0 });
  await assert.rejects(client.query("{ ok }"), (err) =>
    /Unknown argument; echo <token>/.test(err.message) && !err.message.includes(TOKEN),
  );
});

test("once the hourly budget is spent the data in hand is kept and nothing more is sent", async () => {
  const { fetch, calls } = scripted(reply(200, { data: { ok: 1 } }, { "x-ratelimit-remaining-hour": "0" }));
  const client = createClient({ token: TOKEN, fetch, spacing: 0 });
  assert.deepEqual(await client.query("{ ok }"), { ok: 1 });
  await assert.rejects(client.query("{ ok }"), (err) => err.fatal && /hourly STRATZ budget is spent/.test(err.message));
  assert.equal(calls.length, 1);
});

test("the roster maps Valve short names to our slugs", async () => {
  const bySteam = parseRoster(await readFile(new URL("../src/data/heroes.ts", import.meta.url), "utf8"));
  assert.equal(bySteam.get("antimage"), "anti-mage");
  assert.equal(bySteam.get("axe"), "axe");
  assert.ok(bySteam.size >= 120);
});

test("STRATZ ids are joined on the short name and the misses come back by name", () => {
  const { byId, unmatched } = mapHeroIds(
    [
      { id: 1, shortName: "antimage", displayName: "Anti-Mage" },
      { id: 999, shortName: "brand_new", displayName: "Brand New" },
      { id: "x", shortName: "axe" },
    ],
    new Map([["antimage", "anti-mage"], ["axe", "axe"]]),
  );
  assert.deepEqual([...byId], [[1, "anti-mage"]]);
  assert.deepEqual(unmatched, ["Brand New"]);
});

test("week numbers match STRATZ's own", () => {
  // STRATZ reported week 2958 as starting at 1788998400 (seconds).
  assert.equal(weekStartMs(2958), 1_788_998_400_000);
  assert.equal(weekOf(weekStartMs(2958)), 2958);
  assert.equal(weekOf(weekEndMs(2958) - 1), 2958);
  assert.equal(weekOf(weekEndMs(2958)), 2959);
});

test("only complete weeks are collected; the one in progress is left out", () => {
  const DAY = 24 * 60 * 60 * 1000;
  assert.deepEqual(completeWeeks(weekStartMs(2959) + 2 * DAY, 4), [2955, 2956, 2957, 2958]);
  assert.deepEqual(completeWeeks(weekStartMs(2959), 1), [2958], "even a minute into the new week");
});
