#!/usr/bin/env node
/** Regenerate the README's stable source overview and project links, offline. */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { overviewBadges, overviewTable, projectLinks, replaceBlock } from "./readme-status.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const path = join(root, "README.md");
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const before = await readFile(path, "utf8");
let after = replaceBlock(before, "badges", overviewBadges(projectLinks(pkg)));
after = replaceBlock(after, "data", overviewTable());
if (after !== before) await writeFile(path, after);
console.log(`README.md ${after === before ? "already matched" : "updated from"} the source overview and project links`);
