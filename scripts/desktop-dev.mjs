/**
 * `npm run desktop` — the dev loop for the Electron shell.
 *
 * Starts Vite in this process and points Electron at it, so the window gets
 * hot reload and there is no second terminal to keep alive. Vite is already a
 * dependency, which is what keeps `concurrently` and `wait-on` out of the tree.
 *
 * The packaged app never runs this: it reads the built bundle over app://.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createServer } from "vite";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The `electron` package exports the path to its binary, not an API. */
let electronBinary;
try {
  electronBinary = (await import("electron")).default;
} catch {
  electronBinary = null;
}
if (typeof electronBinary !== "string") {
  console.error("Electron is not installed. Run `npm install` first.");
  process.exit(1);
}

// `open: true` in vite.config.ts is for `npm run dev`; a browser tab would be
// noise here, the window is the point.
const server = await createServer({ root, server: { open: false } });
await server.listen();

const url = server.resolvedUrls?.local?.[0] ?? `http://localhost:${server.config.server.port}/`;
server.config.logger.info(`\n  ➜  desktop:  ${url}\n`);

const child = spawn(electronBinary, [root], {
  stdio: "inherit",
  env: { ...process.env, VITE_DEV_SERVER_URL: url },
});

let stopping = false;
async function stop(code) {
  if (stopping) return;
  stopping = true;
  await server.close().catch(() => {});
  process.exit(code);
}

child.on("close", (code, signal) => stop(signal ? 1 : (code ?? 0)));
child.on("error", (err) => {
  console.error("Could not start Electron:", err.message);
  stop(1);
});

// Ctrl+C should take the window with it, then let the close handler tidy Vite.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal);
  });
}
