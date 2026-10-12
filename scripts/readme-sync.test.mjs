import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { overviewBadges, overviewTable, projectLinks, replaceBlock } from "./readme-status.mjs";

test("README overview matches the source descriptions and project links", async () => {
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  let expected = replaceBlock(readme, "badges", overviewBadges(projectLinks(pkg)));
  expected = replaceBlock(expected, "data", overviewTable());
  assert.equal(readme, expected, "Run npm run readme to update the overview");
});
