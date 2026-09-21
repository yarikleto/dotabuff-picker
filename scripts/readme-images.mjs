/**
 * Renders the README's two images with the Electron behind `npm run desktop`:
 *
 *   npm run readme:images      # builds, then writes docs/assets/*.jpg
 *
 *   banner.jpg      scripts/readme-banner.html, 1280×640
 *   screenshot.jpg  the production build mid-draft, 1440×900
 *
 * Both are captured at twice their CSS size through the DevTools protocol
 * rather than `capturePage`, so the result is the same on any display. The app
 * is served over the same app:// origin the desktop build uses, in an
 * in-memory session: the sample draft never lands in anyone's saved state.
 */

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { BrowserWindow, app, protocol, session } from "electron";

import { INDEX, SCHEME, contentType, resolveRequest } from "../electron/bundle.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");
const OUT = path.join(ROOT, "docs", "assets");
const SCALE = 2;

/** Three enemies and two of ours in: every panel has something to say. */
const DRAFT = {
  mine: [
    { slug: "faceless-void", position: 1 },
    { slug: "crystal-maiden", position: 5 },
  ],
  enemy: [
    { slug: "axe", position: 3 },
    { slug: "invoker", position: 2 },
    { slug: "lion", position: 4 },
  ],
  banned: [
    { slug: "pudge", by: "enemy" },
    { slug: "phantom-assassin", by: "mine" },
  ],
  lanePlan: "standard",
};

protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
app.dock?.hide();
// Each image gets its own window, and closing one must not end the run.
app.on("window-all-closed", () => {});

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(win, expression, what, ms = 30_000) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (await win.webContents.executeJavaScript(expression)) return;
    await pause(150);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const IMAGES_DONE = "[...document.images].every((img) => img.complete)";

/**
 * Loads `url` and then switches the page to SCALE. The override has to follow
 * the first navigation: sent to a webContents that has not loaded anything,
 * it crashes Electron 43 outright.
 */
async function openAt(ses, url, width, height) {
  const win = new BrowserWindow({
    show: false,
    width,
    height,
    webPreferences: { session: ses, sandbox: true, contextIsolation: true },
  });
  await win.loadURL(url);
  win.webContents.debugger.attach("1.3");
  await win.webContents.debugger.sendCommand("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: SCALE,
    mobile: false,
  });
  return win;
}

/** JPEG: portraits are photographs, and PNG makes both images several megabytes. */
async function capture(win, name) {
  const { data } = await win.webContents.debugger.sendCommand("Page.captureScreenshot", {
    format: "jpeg",
    quality: 88,
  });
  const file = path.join(OUT, name);
  await writeFile(file, Buffer.from(data, "base64"));
  const kb = Math.round((await stat(file)).size / 1024);
  console.log(`  ${path.relative(ROOT, file)}  ${kb} KB`);
}

async function screenshot(ses) {
  const win = await openAt(ses, INDEX, 1440, 900);
  await win.webContents.executeJavaScript(
    `localStorage.setItem("dotabuff-picker.draft.v3", ${JSON.stringify(JSON.stringify(DRAFT))})`,
  );
  await win.loadURL(INDEX);
  await until(win, `!!document.querySelector(".tag-good") && ${IMAGES_DONE}`, "the data and portraits");
  // The pick list animates in; let it settle before the shutter.
  await pause(800);
  await capture(win, "screenshot.jpg");
  win.destroy();
}

async function banner(ses) {
  const win = await openAt(ses, pathToFileURL(path.join(ROOT, "scripts", "readme-banner.html")).href, 1280, 640);
  await until(win, `${IMAGES_DONE} && document.fonts.status === "loaded"`, "the banner's images");
  await capture(win, "banner.jpg");
  win.destroy();
}

async function run() {
  try {
    await stat(path.join(DIST, "index.html"));
  } catch {
    throw new Error("dist/ has no build — run `npm run readme:images`, which builds first");
  }
  await mkdir(OUT, { recursive: true });

  // No "persist:" prefix: the partition lives in memory and dies with the run.
  const ses = session.fromPartition("readme-images");
  // src/main.tsx turns on the desktop glass when it sees Electron in the user
  // agent; the README shows the site.
  ses.setUserAgent(ses.getUserAgent().replace(/\s?Electron\/\S+/, ""));
  ses.protocol.handle(SCHEME, async (request) => {
    const { file, error } = resolveRequest(request.url, DIST);
    if (!file) return new Response(error, { status: 404 });
    try {
      return new Response(await readFile(file), { headers: { "content-type": contentType(file) } });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });

  console.log("Rendering the README images:");
  await screenshot(ses);
  await banner(ses);
}

app
  .whenReady()
  .then(run)
  .then(
    () => app.quit(),
    (err) => {
      console.error(`\nREADME images failed: ${err.message}\n`);
      app.exit(1);
    },
  );
