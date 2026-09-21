/**
 * The desktop shell.
 *
 * Nothing about the picker changes here: the same Vite build that runs in a
 * browser is loaded into a window, over the `app://` scheme rather than
 * `file://` (see electron/bundle.mjs for why). The renderer stays sandboxed
 * with no Node access and no preload — it only ever reads three JSON files and
 * some PNGs, so there is nothing for a bridge to carry.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { BrowserWindow, Menu, app, protocol, shell } from "electron";

const isMac = process.platform === "darwin";

import { HOST, INDEX, SCHEME, contentType, resolveRequest } from "./bundle.mjs";
import { buildMenu } from "./menu.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
/** The Vite build. Lives inside the asar once packaged; `fs` reads through it. */
const BUNDLE = path.join(here, "..", "dist");

/** Set by scripts/desktop-dev.mjs. Never set in a packaged app. */
const DEV_SERVER = process.env.VITE_DEV_SERVER_URL || null;

/**
 * Two things legitimately come from outside the bundle: portraits fall back to
 * Valve's CDN when a local one is missing, and `data:` URIs show up in inline
 * SVG. Everything else is denied, so a page that somehow got hold of untrusted
 * markup has nowhere to send anything.
 */
const CSP = [
  "default-src 'self'",
  "img-src 'self' data: https://cdn.cloudflare.steamstatic.com",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

// Must run before the app is ready. `standard` gives the scheme a real origin
// (so relative URLs and localStorage behave), `secure` keeps it a secure
// context, and `supportFetchAPI` is the whole reason for the exercise.
protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

app.setName("Dota 2 Draft Picker");

const text = (body, status) =>
  new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

function serveBundle() {
  protocol.handle(SCHEME, async (request) => {
    const resolved = resolveRequest(request.url, BUNDLE);
    if (!resolved.file) return text(`Refused: ${resolved.error}`, 404);

    try {
      const body = await readFile(resolved.file);
      const type = contentType(resolved.file);
      const headers = { "content-type": type };
      // Only the document carries the policy; it governs everything it loads.
      if (type.startsWith("text/html")) headers["content-security-policy"] = CSP;
      return new Response(body, { headers });
    } catch (err) {
      // A missing data file is normal — the picker degrades to a plain draft
      // board and says so — so 404 has to stay distinguishable from a real
      // read failure, which the renderer surfaces as an error instead.
      if (err.code === "ENOENT" || err.code === "EISDIR") return text("Not found", 404);
      console.error(`app://${HOST} could not read ${resolved.file}:`, err);
      return text("Read failed", 500);
    }
  });
}

/** Links out of the app (hero pages on Dotabuff and Dota2ProTracker) belong in the real browser. */
function openExternally(url) {
  try {
    if (/^https?:$/.test(new URL(url).protocol)) shell.openExternal(url);
  } catch {
    /* not a URL we can hand to anyone */
  }
}

/** The two origins that are this app: the bundle, and the dev server. */
function isOwnOrigin(url) {
  try {
    const target = new URL(url);
    if (target.protocol === `${SCHEME}:` && target.hostname === HOST) return true;
    return DEV_SERVER !== null && target.origin === new URL(DEV_SERVER).origin;
  } catch {
    return false;
  }
}

function createWindow() {
  const window = new BrowserWindow({
    // Drafting is the only thing you are doing while this is open, and the
    // grid has more heroes than any window smaller than the screen can show.
    fullscreen: true,
    // What it returns to on Ctrl+Cmd+F (Windows and Linux: F11).
    width: 1440,
    height: 920,
    // Below this the three-column layout folds to one; the app still works,
    // it just stops being the thing you keep beside a Dota client.
    minWidth: 960,
    minHeight: 680,
    title: app.getName(),
    /*
     * On macOS the window is a vibrancy material and the page is translucent
     * over it (see the glass section of src/styles.css), so the background has
     * to be genuinely transparent — an opaque colour here would sit in front
     * of the material and there would be nothing to see through.
     *
     * `visualEffectState: "active"` keeps it lit when the window is not
     * focused, which is most of the time: the picker is the thing you glance
     * at while the Dota client has the keyboard.
     *
     * Elsewhere there is no such material, so the window opens on --bg from
     * src/styles.css rather than flashing white while the bundle parses.
     */
    backgroundColor: isMac ? "#00000000" : "#0f1419",
    ...(isMac ? { vibrancy: "under-window", visualEffectState: "active" } : {}),
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  window.once("ready-to-show", () => window.show());

  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternally(url);
    return { action: "deny" };
  });

  // Belt and braces: the window shows one document and never navigates away
  // from it, so anything that tries is either a target-less external link or a
  // mistake. Either way it leaves rather than replacing the app.
  window.webContents.on("will-navigate", (event, url) => {
    if (isOwnOrigin(url)) return;
    event.preventDefault();
    openExternally(url);
  });

  if (DEV_SERVER) window.loadURL(DEV_SERVER);
  else window.loadURL(INDEX);

  return window;
}

// One picker at a time: a second launch focuses the window that already exists.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const [window] = BrowserWindow.getAllWindows();
    if (!window) return createWindow();
    if (window.isMinimized()) window.restore();
    window.focus();
  });

  app.whenReady().then(() => {
    serveBundle();
    Menu.setApplicationMenu(buildMenu());
    createWindow();

    // macOS keeps the process alive with no windows; the dock icon reopens one.
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
