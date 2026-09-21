#!/usr/bin/env node
/**
 * Bundles the in-page collector into one self-contained script.
 *
 * `scripts/parse.mjs` and `scripts/roles.mjs` are already dependency-free, so
 * "bundling" is just stripping their `export` keywords and wrapping each in an
 * IIFE that hands back its exports. The point is that the script injected into
 * the browser and the Node scraper share the same unit-tested parser instead of
 * drifting apart.
 *
 * Nothing is written to disk: scripts/scrape-electron.mjs calls buildCollector()
 * and injects the string straight into the page.
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Comment stripper that respects strings, template literals and — crucially —
 * regex literals, of which parse.mjs has plenty. A naive `//` strip would eat
 * half of `/<table[^>]*>/gi`.
 */
function stripComments(source) {
  let out = "";
  let i = 0;
  // What can precede a `/` that starts a regex rather than a division.
  const regexAllowedAfter = /[([{,;:!&|?+\-*/%=~^<>]\s*$|\b(return|typeof|instanceof|in|of|new|delete|void|case|do|else|yield|await)\s*$/;

  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];

    if (ch === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      out += ch;
      i++;
      while (i < source.length) {
        out += source[i];
        if (source[i] === "\\") {
          out += source[i + 1] ?? "";
          i += 2;
          continue;
        }
        if (source[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (ch === "/" && regexAllowedAfter.test(out)) {
      out += ch;
      i++;
      let inClass = false;
      while (i < source.length) {
        out += source[i];
        if (source[i] === "\\") {
          out += source[i + 1] ?? "";
          i += 2;
          continue;
        }
        if (source[i] === "[") inClass = true;
        else if (source[i] === "]") inClass = false;
        else if (source[i] === "/" && !inClass) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    out += ch;
    i++;
  }

  return out
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim())
    .join("\n");
}

const EXPORT_RE = /^export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/gm;

/** Wrap a module so its exports are reachable as `<alias>.name`. */
async function inline(file, alias, compact) {
  const source = await readFile(join(HERE, file), "utf8");
  const names = [...source.matchAll(EXPORT_RE)].map((m) => m[1]);
  if (!names.length) throw new Error(`${file}: found no exports to inline`);

  let body = source
    .replace(/^import[\s\S]*?from\s+["'][^"']+["'];?$/gm, "")
    .replace(/^export\s+/gm, "");
  if (compact) body = stripComments(body);

  return `const ${alias} = (() => {\n${body}\nreturn { ${names.join(", ")} };\n})();\n`;
}

/**
 * The collector as a string, ready for `webContents.executeJavaScript`.
 *
 * `compact` strips comments and blank lines — that is the build that actually
 * gets injected. The readable one exists so a failure can be read.
 */
export async function buildCollector({ compact = false } = {}) {
  const [parse, roles, rawBody] = await Promise.all([
    inline("parse.mjs", "P", compact),
    inline("roles.mjs", "R", compact),
    readFile(join(HERE, "collector-body.js"), "utf8"),
  ]);
  const body = compact ? stripComments(rawBody) : rawBody;

  // Kept to one line in both builds: the compact-build tests count on being
  // able to skip exactly one line before asserting that no comments survive.
  const banner = compact
    ? "// Dotabuff collector (compact build) — generated from scripts/collector-body.js."
    : "// Dotabuff collector — generated from scripts/collector-body.js. Do not edit.";

  return `${banner}\n(async () => {\n${parse}\n${roles}\n${body}\n})();\n`;
}
