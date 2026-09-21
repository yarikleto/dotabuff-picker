# The desktop build

The picker as a native window, via Electron. Nothing in `src/` knows about it:
the same Vite build that `npm run dev` serves is what the window loads, so a
change made in the browser is a change made in the app.

```bash
npm install        # pulls Electron (~100 MB) the first time
npm run desktop    # Vite + a window, with hot reload
npm run dist       # a packaged app for the machine you are on -> release/
```

The window opens full screen — View -> Toggle Full Screen (`Ctrl+Cmd+F`, or
`F11` off macOS) drops it back to 1440x920, which is what `fullscreen: true` in
`electron/main.mjs` sits next to.

## Why not just open the file

The obvious shape — `win.loadFile("dist/index.html")` — does not work here.
`src/lib/dataset.ts` reads its three data files with `fetch`, and Chromium
refuses `fetch` over `file://`. Rather than rewrite the loader for one host, or
run a localhost server inside the app, the build is served over a custom
scheme, `app://bundle/`.

Registered as `standard` and `secure`, it behaves like a real origin: relative
URLs resolve, `localStorage` persists (settings and the draft survive a
restart), and it is a secure context. `electron/bundle.mjs` turns a request URL
into a path inside `dist/`, refuses anything that lands outside it, and is
unit-tested under plain `node --test` along with the rest of the pure logic:

```bash
npm test
```

The window itself is as closed as a window can be while still showing this app:
no Node in the renderer, no preload bridge, sandboxed, and a CSP that allows
exactly one outside host — Valve's CDN, for the portraits `npm run refresh` has
not downloaded yet. Hero links open in the real browser rather than navigating the
app away from itself.

## The glass

The window is a macOS vibrancy material (`vibrancy: "under-window"`), which
only shows if the page above it stays translucent — so the surfaces in
`src/styles.css` are translucent too, and the panes that a person would call a
pane get a `backdrop-filter`. Four variables carry almost all of it:
`--bg-raised`, `--bg-tile`, `--line` and `--line-soft` became `rgba()`, and
every panel, tile and chip in the app inherited the material without being
touched.

Blur is deliberately not universal. The hero grid alone is 127 tiles, each one
composited separately; they are translucent and let the pane behind them do the
work. The one place the blur earns its cost is the hero card, which floats over
that grid — and it is also the most opaque surface here, because a popover is
for reading.

Full screen has nothing behind the window to sample, so the page carries its
own backdrop: a soft field in the team colours that the glass reads against
either way. In a browser tab the same stylesheet is fully opaque; the
translucent variant is scoped to `html[data-shell="desktop"][data-os="mac"]`,
which `src/main.tsx` sets from the user agent.

## Data is baked in

`public/data/*.json` ships inside the package. There is no in-app refresh: new
numbers mean re-running the collectors, committing the files, and cutting a new
version.

```bash
npm run refresh                  # all four data sets; see docs/refreshing-data.md
npm test
npm version minor && git push --follow-tags
```

## Releasing

`.github/workflows/release.yml` builds all three platforms on every push and
pull request, so a packaging break shows up before a tag exists. Pushing a
`v*` tag additionally publishes: electron-builder uploads the artifacts to a
**draft** GitHub release, which you then edit and publish by hand.

| Platform | Artifact | Built on |
| --- | --- | --- |
| macOS | `.dmg`, arm64 + x64 | `macos-latest` |
| Windows | `.exe` (NSIS installer) | `windows-latest` |
| Linux | `.AppImage`, x64 | `ubuntu-latest` |

Locally, `npm run dist` builds for the current OS only. `npm run dist:all`
exists but cross-building Windows from macOS needs wine and cross-building
macOS anywhere else is not possible at all — that is what CI is for.

Nothing is signed or notarised, and there is no auto-updater. A new version is
a new download.

## First launch of an unsigned build

**macOS** refuses it outright — "damaged and can't be opened" is Gatekeeper
talking about the missing signature, not a corrupt file:

```bash
xattr -dr com.apple.quarantine "/Applications/Dota 2 Draft Picker.app"
```

**Windows** shows a SmartScreen warning: *More info* -> *Run anyway*.

**Linux** needs the AppImage marked executable: `chmod +x *.AppImage`.

Signing removes all three, and costs an Apple Developer account ($99/yr) plus a
Windows code-signing certificate. Worth it if this is ever handed to strangers;
not worth it for a picker on your own machines.

## Layout

```
electron/main.mjs       window, protocol handler, CSP, external links
electron/bundle.mjs     app:// URL -> file in dist/ (pure, unit-tested)
electron/menu.mjs       the native menu, built from platform roles
scripts/desktop-dev.mjs starts Vite in-process, then Electron against it
electron-builder.yml    what gets packaged, and into what
build/icon.png          1024², converted to .icns/.ico at build time
```

`appId` in `electron-builder.yml` is fixed once a release is out: macOS and the
Windows installer treat a different one as a different app, so an update would
install beside the old version instead of replacing it.
