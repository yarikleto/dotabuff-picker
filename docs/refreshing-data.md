# Refreshing the data

Six data sets from four sources feed the picker, and a seventh file — the
win-chance model's weights — is fitted from them. One command brings the hero
roster up to date and then rebuilds all of it:

```bash
npm run refresh
```

Read this after a patch when the numbers have gone stale, or when one of the
steps is misbehaving and you want to drive it by hand.

| Step | Source | Output | Blocked? |
| --- | --- | --- | --- |
| `roster` | OpenDota `/heroes` | new heroes into `src/data/heroes.ts` | No |
| `counters` | Dotabuff matchup + lane tables | `public/data/matchups.json` | Cloudflare — handled, see below |
| `positions` | STRATZ `heroStats.winWeek` | `public/data/positions.json` | Needs a free API token — [see below](#the-stratz-token) |
| `synergies` | OpenDota `public_matches` | `public/data/synergies.json` | No |
| `timings` | OpenDota `public_matches` | `public/data/timings.json` | No |
| `lanes` | STRATZ `heroStats.laneOutcome` | `public/data/lanes.json` | Needs a free API token — [see below](#the-stratz-token) |
| `portraits` | Valve's CDN | `public/heroes/*.png` | No |
| `calibrate` | OpenDota `public_matches`, the files above | `public/data/calibration.json` | No |
| `readme` | the files above, Valve's patch list | the badges and data table in `README.md` | No |

They run in that order: the synergy pass reads positions out of `positions.json`,
or out of `matchups.json` when that file is missing, and `calibrate` fits the
win-chance model on the files every step before it wrote, from games older than
the synergy and timing samples. `readme` goes last and joins
any run that includes another step, `--steps` or not, so the README always
describes the files beside it; `--skip=readme` leaves it out.
A failing step does not stop the rest, an interrupted step picks up from its
own cache, and the exit code is non-zero if anything failed. Every step
collects current data on every run: the OpenDota passes continue a saved run
only when it was interrupted less than a day ago, never one that finished.

```bash
npm run refresh -- --list             # the steps, in order
npm run refresh -- --steps=timings    # one of them (comma-separated)
npm run refresh -- --skip=synergies   # all but one
```

Unrecognised flags are forwarded to every step, and each script reads only what
it knows — so `--headed` lands on the scrape and `--matches=800000` on the two
OpenDota passes.

The summary at the end lists the age of *every* file, including ones this run
did not touch. That is deliberate: the failure mode this command exists to
prevent is a `timings.json` that quietly sat out six patches because nobody
remembered it was a separate script.

## The routine

1. **Collect.** `npm run refresh`, and let it finish.
2. **Read the whole summary.** Every step should say `ok` and every file should
   be minutes old. A `FAIL` line is followed by the command that retries just
   that step; [When something fails](#when-something-fails) says why steps fail.
3. **Check the numbers.** `npm run scrape -- --recompute-roles` prints positions
   for heroes nobody argues about ([Verify](#verify)). Then `git diff README.md`:
   the table should show the new windows and sample sizes close to the previous
   ones. A sample that halved is a collection that broke part-way, not a quiet
   week.
4. **Look at new heroes.** When `roster` added one, `git diff src/data/heroes.ts`
   shows the entry: its slug should match the hero's Dotabuff URL, and
   `public/heroes/<slug>.png` should exist.
5. **Test and build.** `npm test && npm run build`. `npm test` also fails when
   `README.md` no longer describes the files in `public/data/`; `npm run readme`
   brings it back in line.
6. **Commit and push.**

   ```bash
   git add public/data public/heroes src/data/heroes.ts README.md
   git commit -m "Refresh data"
   git push
   ```

   The push runs the Pages workflow, and a few minutes later the date in the
   site's top bar moves — see [website.md](website.md#publishing-new-data).

**Right after a major patch** the two STRATZ steps still read the last four
complete weeks, mostly from the previous version, and the README's data patch
badge turns orange to say so. `npm run refresh -- --weeks=1` narrows both to the
last complete week once the new patch has one, at a quarter of the sample; the
app damps thin readings by their sample size either way. Dotabuff and OpenDota
follow the game on their own.

## The hero roster

`src/data/heroes.ts` is the list every other step finds heroes through: STRATZ
and OpenDota by Valve's internal name, the portraits by it, and the Dotabuff
scrape whenever Dotabuff's own hero list is blocked. A hero missing from it
gets no positions, lanes, synergies, timings or portrait. So `roster` runs
first and adds any hero OpenDota lists that the file lacks — name, Dotabuff
slug, primary attribute and internal name — in the file's own format and
alphabetical order. It never changes or removes an existing entry, and it needs
no token. The slug comes from the hero's name the way Dotabuff builds it, which
holds for every hero in the file today.

```bash
npm run roster
```

## Why plain Node cannot read Dotabuff

A run that has been blocked opens like this:

```
! could not load /heroes (HTTP 403 for /heroes); using the bundled roster
```

Dotabuff sits behind Cloudflare, and Cloudflare is not just checking cookies —
it fingerprints the TLS handshake itself, and Node's handshake does not look
like a browser's. So the usual fixes do not work:

- **Copying a `Cookie` header** from a logged-in browser: no. `--cookie` exists
  in `scrape.mjs` and is worth a try, but it does not address the fingerprint.
- **Changing the User-Agent**: no, for the same reason.
- **Slowing the run down** (`--delay=5000`): no. This is not a rate limit, and
  403 on the very first request proves it.

The fix is a different engine, not a better header. On the first 403 the scraper
hands the run to `scripts/scrape-electron.mjs`, which opens dotabuff.com in an
offscreen Electron window and injects `scripts/collector-body.js` — the same
parser the Node path uses, inlined by `scripts/build-collector.mjs`. A real
Chromium means a real handshake and a real cookie jar, so the requests go
through as ordinary browsing. You do not have to ask for any of this.

Electron is a devDependency, so `npm install` sets up the browser route with
everything else. The site itself never loads it.

## Driving it by hand

```bash
npm run scrape -- --browser --headed   # watch the window; clear a challenge yourself
npm run scrape -- --browser            # straight to the browser, no Node attempt
npm run scrape -- --node               # Node only — "is Node still blocked?"
npm run scrape -- --diagnose           # one request, fully explained
```

`--headed` is the one to reach for when a run reports that the challenge was not
cleared in time. Solve it once in the visible window; the cookie lives in a
persistent session partition, so later runs are silent again.

Pacing, if Dotabuff starts throttling:

```bash
npm run scrape -- --browser --spacing=800 --concurrency=1
# defaults: 400ms between requests, 2 at a time
```

The whole browser pass takes about two minutes and expects **~127 heroes and
~16,000 cells**.

## Every scraper flag

`scripts/scrape.mjs` walks `dotabuff.com/heroes/{hero}/matchups` for every hero
and writes `public/data/matchups.json`.

```bash
npm run scrape                    # Node first, browser on 403; resumes from cache
npm run scrape -- --browser       # skip Node, go straight to the hidden Chromium
npm run scrape -- --headed        # show that window, to clear a challenge by hand
npm run scrape -- --node          # Node only; fail on 403 rather than fall back
npm run scrape -- --images        # …and hero portraits afterwards, for offline use
npm run images                    # portraits only, no Dotabuff request at all
npm run scrape -- --force         # ignore the cache, refetch everything
npm run scrape -- --only=axe,pudge
npm run scrape -- --offline       # rebuild the JSON from cache, no network
npm run scrape -- --dump-roles    # print the derived positions and stop
npm run scrape -- --no-lanes      # skip the lane pages (no position data)
npm run scrape -- --delay=3000    # slow down if you get rate-limited
npm run scrape -- --recompute-roles   # re-derive positions from the saved file
```

`npm run images` reads the roster out of `src/data/heroes.ts` and never touches
dotabuff.com, so it works on a blocked day. It skips whatever is already in
`public/heroes/`; add `--force` to refetch, or `--only=zeus` for one hero.

`--recompute-roles` is the useful one after changing `scripts/roles.mjs`: the
lane stats are already stored inside `matchups.json`, so positions can be
rebuilt with no network at all. It prints every hero whose position changed.

The Node path makes one request roughly every 1.5s on a single connection, backs
off exponentially on 429/5xx, and caches raw HTML in `scripts/.cache/` so an
interrupted run resumes for free.

Neither path ever shrinks the dataset. Heroes a run could not reach keep their
previous tables, and — because the lane pages are a separate request that can
fail on its own — heroes whose positions it could not derive keep the ones
already on file. Without that second rule an `--offline` or `--no-lanes` run
would write a complete-looking dataset with every position missing, which
silently switches the role filters off.

## Positions from STRATZ

`scripts/positions.mjs` asks STRATZ how many ranked All Pick games each hero
played in each position over the last four complete weeks, and how many they
won, for three rank bands: every rank, Divine and Immortal, and Immortal alone.
That is 15 requests and about 15 seconds. All three bands ship in the file, so
the rank switch in the app's top bar moves between them without a new collection.

```bash
npm run positions               # the last 4 complete weeks
npm run positions -- --weeks=8  # up to 12
npm run positions -- --offline  # rebuild the file from the last run's cache
```

Unfiltered, STRATZ also counts Turbo and unranked All Pick — about a fifth of
Dragon Knight's mid games in one week — so the query asks for ranked All Pick
only. The run ends with a sanity line for heroes nobody argues about:

```
all       anti-mage 1(91%), crystal-maiden 5(71%)/4(27%), invoker 2(71%)/4(18%), axe 3(92%), shadow-fiend 1(58%)/2(39%), lion 5(54%)/4(33%)
```

Without the file, and for any hero it does not cover, the app reconstructs
positions from the Dotabuff lane tables instead. How the two compare, and why
the counts win, is in [docs/scoring.md](scoring.md#where-positions-come-from).

The synergy collector assigns positions from this file too. A saved synergy run
resumes only under the same position source, so moving between this file and
the reconstruction — or to a `--min-rank` in a different band — starts it over.

## Lane outcomes from STRATZ

`scripts/lanes.mjs` asks STRATZ how the laning stage went for every pair of
heroes who met in a lane — won, drawn or lost, by STRATZ's own lane formula, and
how many of those games each side went on to win. It also fetches the same for
every pair who *shared* a lane; that half is cached but not published, because
nothing in the app reads it yet. The lane card's **laning** row reads the rest; how, and what it is allowed to
move, is in [docs/scoring.md](scoring.md#lane-outcomes). STRATZ offers no
game-mode filter on lane outcomes, so unlike every other data set this one
includes Turbo.

```bash
npm run lanes                               # the last 4 complete weeks, every rank
npm run lanes -- --weeks=8                  # up to 26
npm run lanes -- --bracket=DIVINE_IMMORTAL  # one rank band; comma-separate several
npm run lanes -- --min-lanes=200            # leave out thinner pairs (default 50)
npm run lanes -- --probe                    # one request, print what came back, stop
npm run lanes -- --offline                  # rebuild the file from cache, no network
npm run lanes -- --fresh                    # ignore the cache and refetch every week
```

One request covers every hero at one position, in one direction, for one week,
so four weeks is 40 requests. The week in progress is left out: two days in, it
held 7% of a full week's lanes. Responses are cached in `scripts/.cache/stratz/`.
A week more than seven days past its end is read from there for good; a younger
one is refetched on each run, because it can still be filling in. A routine
refresh therefore costs about ten requests, and a fresh four-week run takes under
a minute and writes about 54,000 pairs, 1.8 MB.

A run writes the whole file or nothing. If any request fails, `lanes.json` stays
as it was and the next run fetches only what is missing. A closed week that comes
back empty counts as a failure rather than a quiet week.

The collector paces itself from STRATZ's rate-limit headers — 8 calls a second,
150 a minute, 1,500 an hour and 15,000 a day at the time of writing — waits out
the first two when they run dry and stops on the last two.

## The STRATZ token

The `positions` and `lanes` steps need a personal STRATZ API token. It is free:
log in with Steam at <https://stratz.com/api> and the page shows one.

On macOS it lives in the login Keychain and only the collector reads it. Copy
the token, then:

```bash
security add-generic-password -U -a "$USER" -s stratz-api-token -w "$(pbpaste)"
pbcopy < /dev/null
```

Pass it as an argument like this rather than typing it at the prompt `-w` offers
on its own: that prompt keeps the first 128 characters and drops the rest, and a
STRATZ token is around 300. The collector recognises a token cut that way and
says so. To check it is there without printing it:

```bash
security find-generic-password -s stratz-api-token >/dev/null && echo stored
```

Anywhere but macOS, set `STRATZ_TOKEN` in the environment of the one command;
when set, it also takes precedence over the Keychain. Keep the token out of the
repository, shell profiles and anything named `VITE_*` — Vite inlines those into
the app bundle.

## Verify

Re-derive positions from the lane stats now in the file. No network:

```bash
npm run scrape -- --recompute-roles
```

It prints a sanity line for heroes nobody argues about:

```
Anti-Mage 1, Crystal Maiden 5/4, Invoker 2/4, Axe 3, Shadow Fiend 2/1, Lion 5/4
```

If two or more look wrong, the lane pages came back incomplete. Collect again
rather than shipping bad positions — the role filters and every seat reading in
the score depend on this.

Then confirm the file parses and is complete:

```bash
node -e "
const d = require('./public/data/matchups.json');
console.log(d.generatedAt, d.heroes.length, 'heroes,',
  Object.values(d.matchups).reduce((n,t)=>n+Object.keys(t).length,0), 'cells,',
  d.heroes.filter(h=>h.topPositions?.length).length, 'with positions');
"
```

Reloading the app picks up the new files. To publish them, commit
`public/data/`, `public/heroes/`, `src/data/heroes.ts` and `README.md` and push
to `main`; the Pages workflow does the rest — see
[website.md](website.md#publishing-new-data).

## When something fails

Start here:

```bash
npm run scrape -- --diagnose
```

It makes one request and reports exactly what came back: HTTP status, whether
the body is a bot-challenge page rather than the hero page, and how many matchup
rows the parser found. That distinguishes the three failures that look identical
from the outside.

**`HTTP 403`, `server: cloudflare`, body looks like a challenge page** — the
common one, and the one `npm run scrape` already routes around by itself. You
only see it as a failure if the browser route also gave up: rerun with
`--browser --headed` and clear the challenge by hand.

**`fetch failed` / `ENOTFOUND` / `ECONNREFUSED`** — the requests never arrived.
Check that dotabuff.com loads in your browser, and whether a VPN, proxy or DNS
filter is in the way. A cookie will not help here.

**Page loads, zero rows parsed** — Dotabuff changed its markup. Only
`scripts/parse.mjs` needs fixing; `scripts/fixtures/` pins the structure it
expects, so start by updating a fixture and running `npm test`.

**`calibrate`: "the fit failed its checks"** — the lines above it name the
check: too few games, a fit no better than knowing the side, a calibration bin
that misses, or a weight with an impossible sign. The previous
`calibration.json` stays, and the app keeps showing the win chance with a
*calibration predates data* tag. Rerun `npm run refresh -- --steps=calibrate`
once the OpenDota steps are `ok`; never edit the file by hand.

## Troubleshooting

**The browser run says the challenge was not cleared.** Rerun with `--headed`
and clear it yourself. If the window shows the hero list but the run still
stalls, `--timeout=1800` gives it half an hour.

**A run wrote a file with no positions.** It cannot: heroes whose positions a
run could not derive keep the ones already on file (`scripts/matchups-file.mjs`,
covered by `scripts/matchups-file.test.mjs`). If positions really are missing,
they were never collected — check the lane pages with `--diagnose`.

**A hero sits in an odd position.** `npm run scrape -- --dump-roles` prints the
full derivation. The maths is in `scripts/roles.mjs` and `npm test` covers it,
including regressions on real Dotabuff numbers.

**Thin or empty matchup tables.** Dotabuff changed its markup. Only
`scripts/parse.mjs` needs fixing, and `scripts/fixtures/` pins the structure it
expects. Update a fixture, make `npm test` fail, then fix the parser — both
collection routes inline that same parser, so fixing it once fixes both.

**`STRATZ refused the token (HTTP 403 …)`.** The token is incomplete, expired
or revoked. If it was cut at 128 characters the collector says so; otherwise
store a fresh one from <https://stratz.com/api> as in
[The STRATZ token](#the-stratz-token).

**`The token's hourly STRATZ budget is spent`.** Rerun after the top of the
hour. Everything fetched before the stop is cached.

**`STRATZ returned no lane rows` for a week.** An outage upstream; rerun later.
The previous `lanes.json` is untouched.

**OpenDota times out or rate-limits.** Not a block, just load. The two OpenDota
passes shrink their query window when it happens and resume from
`scripts/.cache/*-progress.json`, so rerun within a day and they continue.
`--fresh` starts over.

## The data files

```jsonc
// public/data/matchups.json
{
  "generatedAt": "2026-08-16T…",
  "heroes": [{
    "slug": "axe", "name": "Axe", "attr": "str", "steam": "axe",
    "winRate": 50.25, "pickRate": 17.41, "banRate": 2.79, "tier": "A",
    "lanes": { "off": { "presence": 71.2, "winRate": 50.8, "kda": 2.9, "gpm": 402, "xpm": 560 } },
    // Share of this hero's games in each position; sums to 1.
    "positions": { "3": 0.78, "4": 0.22 },
    "positionWinRate": { "3": 50.8, "4": 49.4 },
    "topPositions": [3, 4]
  }],
  // matchups[a][b] = [disadvantage, winRate, matchesPlayed], read from A's page.
  // disadvantage > 0  =>  A performs worse than usual against B.
  "matchups": { "axe": { "pudge": [-1.2, 51.4, 240118] } }
}
```

```jsonc
// public/data/positions.json
{
  "generatedAt": "2026-09-19T…",
  "source": "https://api.stratz.com/graphql (heroStats.winWeek)",
  "weeks": [2955, 2956, 2957, 2958],
  "period": ["2026-08-20", "2026-09-16"],
  "gameModes": ["ALL_PICK_RANKED"],
  // The STRATZ rank brackets behind each band key; null means no filter.
  "bands": { "all": null, "divine": ["DIVINE", "IMMORTAL"], "immortal": ["IMMORTAL"] },
  // heroes[slug][band] = one [games, wins] pair per position, 1 to 5.
  "heroes": {
    "dragon-knight": {
      "all": [[65799, 31879], [245102, 130672], [434910, 220193], [9781, 4406], [4212, 1847]]
    }
  }
}
```

```jsonc
// public/data/lanes.json — the lane card's laning row
{
  "generatedAt": "2026-09-19T…",
  "source": "https://api.stratz.com/graphql (heroStats.laneOutcome)",
  // STRATZ week numbers: whole weeks since 1970-01-01, the first one Thursday.
  "weeks": [2955, 2956, 2957, 2958],
  "period": ["2026-08-20", "2026-09-16"],
  "brackets": null,  // null = every rank
  "minLanes": 50,
  // against[a][pos][b] = [lanes, wins, draws, losses, gameWins]: a playing pos,
  // b in the same lane on the other side, counted from a's side. b's position
  // is not recorded.
  "against": { "axe": { "3": { "anti-mage": [53458, 17398, 14345, 15655, 30210] } } }
}
```

`lanes` is STRATZ's `matchCount` for the pair and `gameWins` the games `a` won
out of them. Wins, draws and losses come to about 86% of `lanes`, between 70%
and 95% depending on the pair, and STRATZ does not document the rest. A lane win rate is therefore `(wins + draws / 2) / (wins +
draws + losses)`, and `minLanes` is a floor on that denominator.

The table covers about half of each hero's games. In week 2957 STRATZ counted
650,681 games for offlane Axe, and the lane table holds 0.54 lane partners and
1.10 lane opponents per game — one partner and two opponents, in roughly 55% of
them.

```jsonc
// public/data/synergies.json — separate, optional
{
  "generatedAt": "2026-08-16T…",
  "source": "https://api.opendota.com/api/explorer (public_matches)",
  "matches": 312044,
  "minRank": null,
  // synergies[a][b] = [synergy, matchesPlayed, rawWinRate], stored once with a < b
  // and mirrored on load. synergy is percentage points beyond what both heroes
  // are worth apart, already shrunk towards zero by sample size.
  "synergies": { "io": { "wraith-king": [2.14, 8421, 55.6] } }
}
```
