import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { contentType, resolveRequest } from "./app-scheme.mjs";

const ROOT = path.resolve("/tmp/app/dist");
const at = (...parts) => path.join(ROOT, ...parts);

test("the bare origin is index.html", () => {
  assert.equal(resolveRequest("app://bundle/", ROOT).file, at("index.html"));
  assert.equal(resolveRequest("app://bundle", ROOT).file, at("index.html"));
});

test("nested assets resolve under the root", () => {
  assert.equal(resolveRequest("app://bundle/data/matchups.json", ROOT).file, at("data", "matchups.json"));
  assert.equal(resolveRequest("app://bundle/heroes/anti-mage.png", ROOT).file, at("heroes", "anti-mage.png"));
});

test("a query string is not part of the path", () => {
  assert.equal(resolveRequest("app://bundle/index.html?v=2#top", ROOT).file, at("index.html"));
});

test("percent-encoding is decoded once", () => {
  assert.equal(resolveRequest("app://bundle/data/my%20file.json", ROOT).file, at("data", "my file.json"));
});

test("traversal is refused however it is spelled", () => {
  for (const url of [
    "app://bundle/..%2F..%2Fpackage.json",
    "app://bundle/data/..%2f..%2f..%2fetc%2fpasswd",
    "app://bundle/%2e%2e%2fpackage.json",
  ]) {
    const resolved = resolveRequest(url, ROOT);
    assert.equal(resolved.file, undefined, url);
    assert.match(resolved.error, /outside/);
  }
});

test("dot segments are normalised away by the URL parser", () => {
  // Chromium does this before a handler ever runs; asserted here so the
  // encoded cases above are understood as the ones that actually need guarding.
  assert.equal(resolveRequest("app://bundle/.", ROOT).file, at("index.html"));
  assert.equal(resolveRequest("app://bundle/data/../index.html", ROOT).file, at("index.html"));
});

test("another origin gets nothing", () => {
  assert.ok(resolveRequest("app://evil/index.html", ROOT).error);
  assert.ok(resolveRequest("file:///etc/passwd", ROOT).error);
  assert.ok(resolveRequest("https://bundle/index.html", ROOT).error);
  assert.ok(resolveRequest("not a url", ROOT).error);
});

test("content types cover what the build emits", () => {
  assert.equal(contentType("/x/index.html"), "text/html; charset=utf-8");
  assert.equal(contentType("/x/assets/index-a1b2.js"), "text/javascript; charset=utf-8");
  assert.equal(contentType("/x/data/matchups.json"), "application/json; charset=utf-8");
  assert.equal(contentType("/x/heroes/AXE.PNG"), "image/png");
  assert.equal(contentType("/x/unknown.bin"), "application/octet-stream");
  assert.equal(contentType("/x/noext"), "application/octet-stream");
});
