"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { resolveOrientationFiles, orientationFilesFor } = require("../core/orientation.js");
const { inlineFiles } = require("../server/openrouter/files.js"); // real bridge, local-only (no network)

/** Make a throwaway dir with the given files, return its path. */
function tmpRepo(/** @type {string[]} */ names) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orient-"));
  for (const n of names) fs.writeFileSync(path.join(dir, n), "x");
  return dir;
}

test("ORI1: returns existing high-signal files as absolute paths, priority order", () => {
  const dir = tmpRepo(["package.json", "CLAUDE.md"]); // created out of priority order on purpose
  const out = resolveOrientationFiles(dir);
  assert.deepEqual(out, [{ path: path.join(dir, "CLAUDE.md") }, { path: path.join(dir, "package.json") }]);
});

test("ORI2: skips missing candidates, never throws on an empty dir", () => {
  const dir = tmpRepo([]);
  assert.deepEqual(resolveOrientationFiles(dir), []);
});

test("ORI3: caps the result at maxFiles", () => {
  const dir = tmpRepo(["CLAUDE.md", "AGENTS.md", "README.md", "package.json"]);
  const out = resolveOrientationFiles(dir, { maxFiles: 2 });
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((f) => path.basename(f.path ?? "")), ["CLAUDE.md", "AGENTS.md"]);
});

test("ORI4: orientationFilesFor returns undefined when config orientation is off/absent", () => {
  const dir = tmpRepo(["CLAUDE.md"]);
  assert.equal(orientationFilesFor(undefined, dir), undefined);
  assert.equal(orientationFilesFor({}, dir), undefined);
  assert.equal(orientationFilesFor({ orientation: { enabled: false } }, dir), undefined);
});

test("ORI5: orientationFilesFor resolves the bundle when enabled, honoring maxFiles", () => {
  const dir = tmpRepo(["CLAUDE.md", "README.md"]);
  const out = orientationFilesFor({ orientation: { enabled: true, maxFiles: 1 } }, dir);
  assert.deepEqual(out, [{ path: path.join(dir, "CLAUDE.md") }]);
});

// INTEGRATION: prove the resolver's ABSOLUTE paths actually inline through the REAL
// openrouter bridge (the file-blind delivery path) - closing the "fake-provider only"
// gap. inlineFiles is local + deterministic (no network). For Grok, the same
// absolute-path-under-roots resolution is covered by test/grok-roots.test.js.
test("ORI6: resolver output inlines through the real openrouter bridge (absolute path under cwd resolves, no skip note)", () => {
  const dir = tmpRepo(["CLAUDE.md"]);
  const files = resolveOrientationFiles(dir); // [{ path: "<dir>/CLAUDE.md" }]
  const { blocks, notes } = inlineFiles(files, { roots: [dir] });
  assert.equal(blocks.length, 1, "orientation file inlined to a content block");
  assert.deepEqual(notes, [], "no skip / not-found-under-roots notes");
});
