import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { countHeroes, readmeDrift } from "./readme-status.mjs";
import { parseEntries } from "./roster.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * The badges are only worth anything if README.md was regenerated for the data
 * it ships beside. A data commit that leaves README.md out fails here, and in
 * CI that stops the site from deploying numbers its README does not describe.
 */
test("README.md describes the data files committed beside it", async () => {
  const names = ["matchups", "positions", "lanes", "synergies", "timings"];
  const files = Object.fromEntries(
    await Promise.all(names.map(async (name) => [name, await readJson(join(ROOT, "public", "data", `${name}.json`))])),
  );
  const roster = parseEntries(await readFile(join(ROOT, "src", "data", "heroes.ts"), "utf8")).length;
  const readme = await readFile(join(ROOT, "README.md"), "utf8");

  const drift = readmeDrift(readme, { files, heroes: countHeroes(files.matchups, roster) });
  assert.deepEqual(
    drift,
    [],
    `README.md does not describe public/data — run \`npm run readme\` and commit README.md:\n  ${drift.join("\n  ")}`,
  );
});
