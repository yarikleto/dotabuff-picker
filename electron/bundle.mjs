/**
 * Serving the Vite build to the window.
 *
 * A packaged app cannot just `loadFile("dist/index.html")`: the picker reads
 * its three data files with `fetch`, and Chromium refuses `fetch` over
 * `file://`. So the build is handed out over a custom scheme instead — a real
 * origin, with a working fetch, and without a localhost port or a server.
 *
 * The path arithmetic lives here, clear of any Electron import, so it can be
 * unit-tested under plain `node --test` like the rest of the pure logic.
 */

import path from "node:path";

/** Every request the window makes is `app://bundle/...`. */
export const SCHEME = "app";
export const HOST = "bundle";
export const INDEX = `${SCHEME}://${HOST}/index.html`;

/**
 * Only the extensions a Vite build actually emits, plus the portraits. An
 * unknown extension is served as a byte stream rather than guessed at, which
 * fails visibly instead of quietly rendering as text.
 */
const TYPES = new Map(
  Object.entries({
    html: "text/html; charset=utf-8",
    js: "text/javascript; charset=utf-8",
    mjs: "text/javascript; charset=utf-8",
    css: "text/css; charset=utf-8",
    json: "application/json; charset=utf-8",
    map: "application/json; charset=utf-8",
    svg: "image/svg+xml",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    gif: "image/gif",
    ico: "image/x-icon",
    woff: "font/woff",
    woff2: "font/woff2",
    ttf: "font/ttf",
    txt: "text/plain; charset=utf-8",
  }),
);

export function contentType(file) {
  return TYPES.get(path.extname(file).slice(1).toLowerCase()) ?? "application/octet-stream";
}

/**
 * `app://bundle/data/matchups.json` -> an absolute path inside `root`.
 *
 * Chromium normalises `..` away before a handler ever sees the URL, but the
 * check is repeated here anyway: this function decides which bytes leave the
 * disk, so it does not get to assume anything about its caller. Anything that
 * resolves outside `root` — or is not addressed to this origin at all — comes
 * back as an error rather than a path.
 */
export function resolveRequest(requestUrl, root) {
  let url;
  try {
    url = new URL(requestUrl);
  } catch {
    return { error: "unparseable URL" };
  }
  if (url.protocol !== `${SCHEME}:`) return { error: `not the ${SCHEME}: scheme` };
  if (url.hostname !== HOST) return { error: `unknown host "${url.hostname}"` };

  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return { error: "bad percent-encoding" };
  }
  if (pathname.includes("\0")) return { error: "NUL in path" };

  // The bare origin is the app itself; everything else is read literally.
  const relative = pathname === "" || pathname === "/" ? "index.html" : pathname.slice(1);

  const base = path.resolve(root);
  const file = path.join(base, ...relative.split("/"));
  const inside = path.relative(base, file);
  if (!inside || inside.startsWith("..") || path.isAbsolute(inside)) {
    return { error: "outside the bundle" };
  }
  return { file };
}
