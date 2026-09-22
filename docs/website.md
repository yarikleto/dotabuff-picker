# The website

The picker is a static site. `npm run build` writes the page, the bundle, the
five data files and the hero portraits into `dist/`; the browser does
everything else. The data files are fetched at runtime rather than compiled
into the bundle, so new numbers are new JSON files and nothing more.

`.github/workflows/pages.yml` publishes `dist/` to GitHub Pages on every push
to `main`, and on demand from the Actions tab: `npm ci`, `npm test`,
`npm run build`, deploy. A failing test ends the run before the deploy, so the
last good version stays live.

## One-time setup

1. Create the repository on GitHub and push `main`. GitHub Pages on the free
   plan needs a public repository.
2. **Settings → Pages → Build and deployment → Source: GitHub Actions.** The
   same from a terminal:

   ```bash
   gh api -X POST repos/OWNER/REPO/pages -f build_type=workflow
   ```

3. **Actions → Website → Run workflow**, or push to `main`. A run that started
   before step 2 fails at the deploy job; re-run it.

The site is then at `https://OWNER.github.io/REPO/`.

## Publishing new data

```bash
npm run refresh
git add public/data public/heroes src/data/heroes.ts README.md
git commit -m "Refresh data"
git push
```

That is the whole release. `refresh` rewrites the files in `public/data/`, adds
any new hero to `src/data/heroes.ts`, downloads its portrait into
`public/heroes/` and rewrites the README's badges and data table to match; the
push runs the workflow, and the site serves the new numbers a few minutes
later. The date in the top bar is `generatedAt` from `matchups.json` — the
quickest check that a deploy went out. The full routine, with the checks before
the commit, is in [refreshing-data.md](refreshing-data.md#the-routine).

GitHub Pages sends every file with a ten-minute cache lifetime. The app
requests its data files with `cache: "no-cache"`, so a browser revalidates them
on every load instead of trusting its own copy, but for up to ten minutes after
a deploy GitHub's CDN may still answer with the previous version.

## Paths are relative

`base: "./"` in `vite.config.ts` makes every URL in the build relative —
`./assets/…`, `./data/matchups.json`, `./heroes/axe.png` — so one build runs at
`https://OWNER.github.io/REPO/` and at the root of a custom domain without
knowing which. There is no client-side routing, so there is no `404.html`
fallback either.

A root-absolute path such as `/data/matchups.json` works under `npm run dev`
and breaks on Pages, where `/` belongs to `OWNER.github.io` rather than this
site. Asset URLs in code are built on `import.meta.env.BASE_URL`, as
`src/lib/dataset.ts` does.

## Storage

Every project site under `OWNER.github.io` shares one origin, and with it one
`localStorage`. The draft and the settings live under keys prefixed
`dotabuff-picker.`, which keeps them apart from any other project's.

## Local check

```bash
npm run build
npm run preview -- --base /dotabuff-picker/   # http://localhost:4173/dotabuff-picker/
```

`--base` mounts the finished build under a sub-path, the way Pages does, and
the preview server answers anything outside it with a 404 — so a root-absolute
URL fails here just as it would on the live site. Plain `npm run preview`
serves from `/`, where that mistake still works.
