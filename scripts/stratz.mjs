/**
 * The STRATZ GraphQL API: where the token comes from, how fast to ask, and
 * which of our heroes each STRATZ hero id is.
 *
 * The token is a personal credential. Nothing in here prints it, and every
 * message that could carry text from the server goes through `redact` first.
 */

import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const ENDPOINT = "https://api.stratz.com/graphql";
export const KEYCHAIN_SERVICE = "stratz-api-token";
export const TOKEN_ENV = "STRATZ_TOKEN";

const SETUP =
  "Get a token at https://stratz.com/api (log in with Steam), copy it, then run:\n" +
  `    security add-generic-password -U -a "$USER" -s ${KEYCHAIN_SERVICE} -w "$(pbpaste)"\n` +
  "    pbcopy < /dev/null\n" +
  `  Anywhere but macOS, set ${TOKEN_ENV} for the one command instead. Details: docs/refreshing-data.md`;

/** `fatal` means every later request would fail the same way, so a run should stop asking. */
export class StratzError extends Error {
  constructor(message, { fatal = false } = {}) {
    super(message);
    this.fatal = fatal;
  }
}

/** Every occurrence of the token replaced, for anything that might reach a terminal. */
export const redact = (text, token) =>
  token ? String(text).split(token).join("<token>") : String(text);

/**
 * STRATZ tokens are JWTs: three dot-separated base64url segments.
 *
 * Checked before the first request because a mangled token earns a 403 that
 * reads exactly like a revoked one. The case worth naming is the interactive
 * `security add-generic-password -w` prompt, which silently keeps the first
 * 128 characters (`_PASSWORD_LEN`) — two segments and no signature.
 */
export function checkTokenShape(token, source) {
  const segments = token.split(".");
  if (segments.length === 3 && segments.every((s) => /^[A-Za-z0-9_-]+$/.test(s))) return;
  const truncated =
    token.length === 128 && segments.length === 2
      ? "\n  That is exactly 128 characters: the interactive `security ... -w` prompt cuts input there."
      : "";
  throw new StratzError(
    `The STRATZ token in ${source} is not a complete JWT ` +
      `(${segments.length} of 3 parts, ${token.length} characters).${truncated}\n  ${SETUP}`,
    { fatal: true },
  );
}

/**
 * The token, from $STRATZ_TOKEN or the macOS Keychain.
 *
 * The environment wins when set, so a one-off run can use a different token
 * without touching the Keychain entry.
 */
export function readToken({ env = process.env, platform = process.platform, exec = execFileSync } = {}) {
  const fromEnv = String(env[TOKEN_ENV] ?? "").trim();
  if (fromEnv) {
    checkTokenShape(fromEnv, `$${TOKEN_ENV}`);
    return fromEnv;
  }
  if (platform === "darwin") {
    let stored = "";
    try {
      stored = exec("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"], {
        encoding: "utf8",
        // A miss prints to stderr; keep it off the terminal and report it ourselves.
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      stored = "";
    }
    if (stored) {
      checkTokenShape(stored, `the Keychain item "${KEYCHAIN_SERVICE}"`);
      return stored;
    }
  }
  throw new StratzError(`No STRATZ API token found.\n  ${SETUP}`, { fatal: true });
}

const headerNumber = (headers, name) => {
  const raw = headers.get(name);
  if (raw === null || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
};

/**
 * What the rate-limit headers on the last response say about the next request.
 *
 * STRATZ budgets calls per second, minute, hour and day. The first two refill
 * soon enough to wait out; an empty hour or day is not worth sleeping through,
 * so the run stops and says so, and its cache lets the next run carry on.
 */
export function budget(headers) {
  if (headerNumber(headers, "x-ratelimit-remaining-day") === 0) return { waitMs: 0, stop: "day" };
  if (headerNumber(headers, "x-ratelimit-remaining-hour") === 0) return { waitMs: 0, stop: "hour" };
  if (headerNumber(headers, "x-ratelimit-remaining-minute") === 0) return { waitMs: 60_000, stop: null };
  if (headerNumber(headers, "x-ratelimit-remaining-second") === 0) return { waitMs: 1_000, stop: null };
  return { waitMs: 0, stop: null };
}

/** Seconds the server asked us to hold off after a 429, as milliseconds. */
export function retryAfter(headers) {
  const seconds = headerNumber(headers, "retry-after") ?? headerNumber(headers, "ratelimit-reset");
  return seconds === null ? null : Math.max(1, seconds) * 1000;
}

const budgetSpent = (window) =>
  new StratzError(
    `The token's ${window === "day" ? "daily" : "hourly"} STRATZ budget is spent. ` +
      "Everything fetched so far is cached; rerun later.",
    { fatal: true },
  );

const backoff = (attempt) => Math.min(30_000, 1000 * 2 ** attempt);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A 401/403 has two unrelated causes that look alike from here: Cloudflare
 * challenging the request (an HTML page) or STRATZ refusing the token (JSON).
 */
function refusal(res, text) {
  const html = /text\/html/i.test(res.headers.get("content-type") ?? "");
  if (html || res.headers.get("cf-mitigated") === "challenge") {
    return `Cloudflare challenged the request (HTTP ${res.status}) before it reached STRATZ.`;
  }
  let message = "";
  try {
    message = JSON.parse(text)?.message ?? "";
  } catch {
    message = "";
  }
  return (
    `STRATZ refused the token (HTTP ${res.status}${message ? `: ${message}` : ""}).\n` +
    `  Check it is still listed at https://stratz.com/api, or store a fresh one.\n  ${SETUP}`
  );
}

export function createClient({
  token,
  fetch: fetchImpl = globalThis.fetch,
  spacing = 400,
  retries = 4,
  timeoutMs = 60_000,
  sleep = pause,
} = {}) {
  let readyAt = 0;
  let spent = null;

  async function send(body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(ENDPOINT, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          // STRATZ asks every API client to identify itself with exactly this.
          "User-Agent": "STRATZ_API",
        },
        body,
      });
      return { res, text: await res.text() };
    } finally {
      clearTimeout(timer);
    }
  }

  async function query(document, variables = {}) {
    if (spent) throw budgetSpent(spent);
    const body = JSON.stringify({ query: document, variables });

    for (let attempt = 1; ; attempt++) {
      const gap = readyAt - Date.now();
      if (gap > 0) await sleep(gap);

      let res;
      let text;
      try {
        ({ res, text } = await send(body));
      } catch (err) {
        readyAt = Date.now() + spacing;
        if (attempt > retries) {
          throw new StratzError(redact(`STRATZ did not answer (${err.message}).`, token));
        }
        await sleep(backoff(attempt));
        continue;
      }

      const next = budget(res.headers);
      readyAt = Date.now() + Math.max(spacing, next.waitMs);

      if (res.status === 429 && next.stop) {
        spent = next.stop;
        throw budgetSpent(spent);
      }
      if (res.status === 429 || res.status >= 500) {
        if (attempt > retries) throw new StratzError(`STRATZ kept answering HTTP ${res.status}.`);
        await sleep(retryAfter(res.headers) ?? backoff(attempt));
        continue;
      }
      if (res.status === 401 || res.status === 403) {
        throw new StratzError(redact(refusal(res, text), token), { fatal: true });
      }
      if (!res.ok) throw new StratzError(`STRATZ answered HTTP ${res.status}.`);

      let json;
      try {
        json = JSON.parse(text);
      } catch {
        throw new StratzError(`STRATZ answered HTTP ${res.status} with something that is not JSON.`);
      }
      if (Array.isArray(json?.errors) && json.errors.length) {
        const messages = json.errors.map((e) => e?.message ?? String(e)).join("; ");
        throw new StratzError(redact(`STRATZ rejected the query: ${messages}`, token));
      }
      // The data in hand is good; only the calls after it are out of budget.
      spent = next.stop;
      return json?.data ?? null;
    }
  }

  return { query };
}

export const HEROES_QUERY = "{ constants { heroes { id shortName displayName } } }";

/** Valve short name -> our slug, read from the roster the whole app is built on. */
export function parseRoster(source) {
  const bySteam = new Map();
  const re = /\{\s*slug:\s*"([^"]+)",\s*name:\s*"([^"]+)",\s*attr:\s*"[^"]+",\s*steam:\s*"([^"]+)"\s*\}/g;
  let m;
  while ((m = re.exec(source)) !== null) bySteam.set(m[3], m[1]);
  if (!bySteam.size) throw new StratzError("could not read src/data/heroes.ts — has its format changed?");
  return bySteam;
}

/** STRATZ hero id -> slug, joined on Valve's short name; the misses come back by name. */
export function mapHeroIds(apiHeroes, bySteam) {
  const byId = new Map();
  const unmatched = [];
  for (const hero of apiHeroes ?? []) {
    const id = Number(hero?.id);
    if (!Number.isInteger(id)) continue;
    const slug = bySteam.get(String(hero.shortName ?? ""));
    if (slug) byId.set(id, slug);
    else unmatched.push(hero.displayName ?? hero.shortName ?? String(id));
  }
  return { byId, unmatched };
}

/**
 * STRATZ id -> slug. The hero list is cached beside the collector's other
 * responses, so an --offline rebuild can still map ids without a token.
 */
export async function loadHeroIds({ client, rosterFile, cacheFile, warn = () => {} }) {
  let heroes;
  if (client) {
    heroes = (await client.query(HEROES_QUERY))?.constants?.heroes;
    if (!Array.isArray(heroes) || !heroes.length) throw new StratzError("STRATZ returned no hero list.");
    await mkdir(dirname(cacheFile), { recursive: true });
    await writeFile(cacheFile, JSON.stringify(heroes), "utf8");
  } else {
    try {
      heroes = JSON.parse(await readFile(cacheFile, "utf8"));
    } catch {
      throw new StratzError("--offline needs a cached hero list: run once online first.");
    }
  }
  const { byId, unmatched } = mapHeroIds(heroes, parseRoster(await readFile(rosterFile, "utf8")));
  if (unmatched.length) {
    warn(`${unmatched.length} hero(es) on STRATZ are missing from src/data/heroes.ts: ${unmatched.join(", ")}`);
    warn("they are skipped until they are added there");
  }
  return byId;
}

export const WEEK_SECONDS = 7 * 24 * 60 * 60;

/** STRATZ week numbers count whole weeks since the Unix epoch, which began on a Thursday. */
export const weekOf = (ms) => Math.floor(ms / 1000 / WEEK_SECONDS);
export const weekStartMs = (week) => week * WEEK_SECONDS * 1000;
export const weekEndMs = (week) => (week + 1) * WEEK_SECONDS * 1000;

/** The `count` most recent weeks that have ended; the one in progress is a sliver of a week. */
export function completeWeeks(nowMs, count) {
  const current = weekOf(nowMs);
  return Array.from({ length: count }, (_, i) => current - count + i);
}

export const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
