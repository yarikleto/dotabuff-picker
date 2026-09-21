/**
 * Lets `node --test` run the app's TypeScript directly.
 *
 * Vite resolves extensionless relative imports (`./roles`); Node's ESM loader
 * does not. This hook fills that gap so the scoring and role logic can be
 * unit-tested without a bundler or a build step. Node strips the types itself.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CANDIDATES = [".ts", ".tsx", "/index.ts", "/index.tsx"];

export async function resolve(specifier, context, next) {
  const relative = specifier.startsWith("./") || specifier.startsWith("../");
  if (relative && !/\.[mc]?[jt]sx?$/.test(specifier) && context.parentURL) {
    const base = new URL(specifier, context.parentURL).href;
    for (const ext of CANDIDATES) {
      if (existsSync(fileURLToPath(base + ext))) return next(base + ext, context);
    }
  }
  return next(specifier, context);
}
