# Working in this repository

A Dota 2 pick/ban assistant: a static React + Vite site, also packaged with
Electron, that ranks heroes from data files committed under `public/data/`.
[README.md](README.md) is the overview and `docs/` has the detail.

## Commands

```bash
npm install
npm run dev             # http://localhost:5180
npm test                # scripts/, electron/ and src/lib/ under node --test
npm run build           # typecheck + production bundle into dist/
npm run refresh         # recollect every data set, then the README blocks
npm run readme          # the README blocks alone, from public/data/
npm run readme:images   # re-render docs/assets/banner.jpg and screenshot.jpg
```

## Data

- Data changes go through `npm run refresh` and nothing else. The procedure,
  written for agents, is [`.claude/skills/refresh-data/SKILL.md`](.claude/skills/refresh-data/SKILL.md);
  the same routine for people is
  [docs/refreshing-data.md](docs/refreshing-data.md#the-routine).
- The STRATZ token never appears in output, files, arguments or environment
  variables you set. The collectors read it from the macOS Keychain; check it
  exists with `security find-generic-password -s stratz-api-token >/dev/null`.
- A Cloudflare check on Dotabuff is for the user to clear. Do not work around
  it, and do not collect Dotabuff through a browser extension.
- Nothing from dota2protracker.com: its terms forbid scraping and using its
  data in apps.
- The README blocks between `<!-- badges:start … -->` and
  `<!-- data:start … -->` and their `:end` markers are written by
  `npm run readme`; change `scripts/readme-status.mjs`, not the blocks.
  `scripts/readme-sync.test.mjs` fails `npm test`, and with it the deploy,
  whenever they no longer describe `public/data/`.

## Code

- Every URL in the build is relative (`base: "./"` in `vite.config.ts`): the
  site is served from a sub-path on GitHub Pages and from `app://bundle/` in the
  desktop app. Build asset URLs on `import.meta.env.BASE_URL`, never on `/`.
- `localStorage` keys start with `dotabuff-picker.` — every project site under
  one `github.io` account shares an origin.
- Pure logic sits in modules with a test file beside them (`scripts/parse.mjs`,
  `scripts/*-math.mjs`, `scripts/readme-status.mjs`, `src/lib/*.ts`); network
  and file access stay in the scripts that call them.
- `src/lib/*.test.ts` runs straight off the TypeScript: Node strips the types
  and `scripts/ts-resolve.mjs` resolves the extensionless imports.

## Licensing

The code is MIT ([LICENSE](LICENSE)). The data in `public/data/`, the fixtures
in `scripts/fixtures/` and the hero portraits are not the project's to license;
[NOTICE.md](NOTICE.md) says who owns each. A new data source or asset gets a
row there before it is committed.

## Publishing

A push to `main` deploys the site (`.github/workflows/pages.yml`) and builds the
desktop apps (`.github/workflows/release.yml`); a `v*` tag also drafts a GitHub
release. Push and tag only when the user asks.
