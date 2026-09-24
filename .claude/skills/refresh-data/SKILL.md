---
name: refresh-data
description: Refresh, verify and publish this repository's draft-picker data — the hero roster, Dotabuff counters, STRATZ positions and lane outcomes, OpenDota synergies and game lengths, hero portraits and the README's data badges — with `npm run refresh`, then commit it for the GitHub Pages site. Use when asked to update or refresh the data or the heroes, after a Dota 2 patch or a new hero, when the README's data patch badge disagrees with the latest patch, or when the site shows old numbers.
---

# Refresh the picker's data

The data is five JSON files in `public/data/`, the portraits in `public/heroes/`
and the roster in `src/data/heroes.ts`, all committed with the code. Refreshing
them is one command, a round of checks and one commit; pushing that commit to
`main` publishes the site. In this repository Dotabuff is collected by
`npm run refresh` through the project's own Electron window — this procedure
replaces any browser-driven Dotabuff scraping skill.

## Rules

- **Never print the STRATZ token.** It sits in the macOS Keychain under the
  service `stratz-api-token`, and the collectors read it themselves. Never run
  `security find-generic-password … -w`, never echo `$STRATZ_TOKEN`, never
  write it to a file, an `.env`, a `VITE_*` variable or a command line. The
  safe existence check is
  `security find-generic-password -s stratz-api-token >/dev/null && echo stored`.
  When a STRATZ step says the token is missing, cut short or refused, stop and
  point the user at `docs/refreshing-data.md#the-stratz-token`; never ask them
  to paste it into the conversation.
- **A Cloudflare check is the user's to clear.** The counters step may open a
  window with one; never click through it or work around it. If the run
  reports the challenge was not cleared, ask the user to run
  `npm run scrape -- --browser --headed`, clear it, and then retry with
  `npm run refresh -- --steps=counters`.
- **Collect Dotabuff only through `npm run refresh` or `npm run scrape`.** No
  browser extension, copied cookies or changed user agents —
  `docs/refreshing-data.md` explains why none of them get past Cloudflare.
- **Nothing from dota2protracker.com.** Its terms forbid scraping it and using
  its data in apps.
- **Never hand-edit** `public/data/*.json` or the README blocks between
  `<!-- badges:start … -->` / `<!-- data:start … -->` and their `:end` markers.
  Rerun the step that writes them.
- **Commit when the checks pass; push only when the user says so.** A push to
  `main` deploys the public site.

## Procedure

1. **Note the starting state.** `git status --short`. Anything already modified
   that is not data stays out of the data commit.
2. **Collect.** `npm run refresh`. The steps run in order — `roster`,
   `counters` (Dotabuff), `positions` (STRATZ), `synergies` and `timings`
   (OpenDota), `lanes` (STRATZ), `portraits`, `calibrate` (the win-chance
   model, fitted on OpenDota games), `readme` — each in its own
   process, and one failing does not stop the rest. The OpenDota passes are the
   slow ones: give the command a long timeout, or run it in the background and
   wait for it to exit. Tell the user a Cloudflare window may appear for them.
3. **Read every line of the summary.** It lists every data file with its age,
   including files this run did not touch. Every step should be `ok` and every
   age in minutes. For each `FAIL`, read that step's own output above the
   summary, match it against "When something fails" and "Troubleshooting" in
   `docs/refreshing-data.md`, and retry with the command the summary prints
   (`npm run refresh -- --steps=<keys>`; the `readme` step rejoins on its own):
   - 403 or "challenge was not cleared" → the Cloudflare rule above.
   - "STRATZ refused the token" → the token rule above.
   - "hourly STRATZ budget is spent" → retry after the top of the hour; what
     was fetched is cached.
   - OpenDota timeouts or rate limits → retry within a day; the pass resumes
     from `scripts/.cache/*-progress.json`.
   - `calibrate` "failed its checks" → it names the check and leaves the old
     `calibration.json`; retry once the OpenDota steps are `ok`, and never edit
     the file or loosen a guardrail to get past it.
   - `readme` could not reach Valve or OpenDota → retry `npm run readme` later.
     Until then the README says "unknown" where the lookup failed.
4. **Verify against the files, not the summary.** Quote these figures in the
   report:
   - `npm run scrape -- --recompute-roles` ends with a sanity line close to
     `Anti-Mage 1, Crystal Maiden 5/4, Invoker 2/4, Axe 3, Shadow Fiend 2/1,
     Lion 5/4`. Two or more heroes off means incomplete lane pages: recollect
     `counters`.
   - The matchups check from `docs/refreshing-data.md#verify`: as many heroes as
     `src/data/heroes.ts` lists, close to n × (n − 1) cells for n heroes
     (16,002 for 127), and every hero with positions.
   - `git diff README.md`: each row's window has moved forward and each sample
     is in the range it was before. A sample that halved is a collection that
     broke part-way — retry that step instead of committing.
   - The data patch badge's label and colour. Gold (letter patches of one
     version) is normal. Orange right after a major patch is expected, see
     below. Red means the data predates the latest patch: something did not
     refresh.
5. **Check new heroes.** When `git diff src/data/heroes.ts` shows an entry, its
   slug should be the hero's name the way Dotabuff writes it in
   `dotabuff.com/heroes/<slug>` (lowercase, hyphenated), and
   `public/heroes/<slug>.png` should exist. Name the new heroes in the report.
6. **Test and build.** `npm test && npm run build`. Both must pass. `npm test`
   includes `scripts/readme-sync.test.mjs`, which fails when README.md no
   longer describes `public/data/` — the fix is `npm run readme`, never an edit
   to the test or the blocks.
7. **Commit the data and what describes it, nothing else.**

   ```bash
   git add public/data public/heroes src/data/heroes.ts README.md
   git commit -m "Refresh data: <data patch from the badge>"
   ```

8. **Report, then ask about pushing.** Give the data patch, the collection
   windows, the sample sizes, any new heroes and anything that failed. After the
   user approves a push, follow the deploy with
   `gh run list --workflow pages.yml --limit 1` and `gh run watch <id>`, then
   read the live file's first bytes —
   `curl -s <homepage from package.json>data/matchups.json | head -c 60` — and
   confirm its `generatedAt` is the committed one.

## Right after a major patch

The two STRATZ steps read the last four complete weeks, so for up to a month
after a major patch most of their rows come from the previous version and the
data patch badge turns orange. `npm run refresh -- --weeks=1` narrows both to
the last complete week, once the new patch has one, at a quarter of the sample.
That trade is the user's call: ask before narrowing.

## Other upkeep

- A visible UI change, and only that: `npm run readme:images` re-renders
  `docs/assets/banner.jpg` and `docs/assets/screenshot.jpg`; commit them with
  the change. It is not part of a data refresh — every run rewrites both JPEGs,
  about 1.2 MB of history each time.
- A new site address or repository name: edit `homepage` and `repository` in
  `package.json`, then `npm run readme`.
- README prose outside the generated blocks is ordinary text. The blocks
  themselves come from `scripts/readme-status.mjs`.

## Further reading

- `docs/refreshing-data.md` — every collector, flag, failure and file format.
- `docs/website.md` — how the site is deployed and cached.
- `docs/scoring.md` — what the app does with each data set.
