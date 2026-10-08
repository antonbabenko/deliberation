"use strict";
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { resolveOrientationFiles, orientationFilesFor, PER_FILE_MAX } = require("../core/orientation.js");
const { inlineFiles } = require("../server/openrouter/files.js"); // real bridge, local-only (no network)
const grok = require("../server/grok/index.js");

/** Throwaway dirs created by tmpRepo, removed after the run. */
/** @type {string[]} */
const tmpDirs = [];

/** Make a throwaway dir; `files` maps name -> byte size (default 1). */
function tmpRepo(/** @type {Record<string, number>|string[]} */ files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orient-"));
  tmpDirs.push(dir);
  const entries = Array.isArray(files) ? files.map((n) => [n, 1]) : Object.entries(files);
  for (const [n, size] of entries) fs.writeFileSync(path.join(dir, String(n)), "x".repeat(Number(size)));
  return dir;
}
const names = (/** @type {{path?:string}[]} */ out) => out.map((f) => path.basename(f.path ?? ""));
const whole = (/** @type {string} */ dir, /** @type {string} */ n, /** @type {number} */ size) => ({ path: path.join(dir, n), headBytes: size, mode: "inline" });

after(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

test("ORI1: returns existing files as absolute paths in priority order, each bounded and inline", () => {
  const dir = tmpRepo(["README.md", "package.json", "CLAUDE.md"]); // created out of priority order on purpose
  assert.deepEqual(resolveOrientationFiles(dir), [whole(dir, "CLAUDE.md", 1), whole(dir, "package.json", 1), whole(dir, "README.md", 1)]);
});

test("ORI2: skips missing candidates, never throws on an empty dir", () => {
  assert.deepEqual(resolveOrientationFiles(tmpRepo([])), []);
});

test("ORI3: caps the result at maxFiles", () => {
  const dir = tmpRepo(["CLAUDE.md", "README.md", "package.json", "go.mod"]);
  assert.deepEqual(names(resolveOrientationFiles(dir, { maxFiles: 2 })), ["CLAUDE.md", "package.json"]);
});

test("ORI4: orientationFilesFor returns undefined when config orientation is off/absent", () => {
  const dir = tmpRepo(["CLAUDE.md"]);
  assert.equal(orientationFilesFor(undefined, dir), undefined);
  assert.equal(orientationFilesFor({}, dir), undefined);
  assert.equal(orientationFilesFor({ orientation: { enabled: false } }, dir), undefined);
});

test("ORI5: orientationFilesFor resolves the bundle when enabled, honoring maxFiles and maxBytes", () => {
  const dir = tmpRepo({ "CLAUDE.md": 10, "README.md": 10 });
  assert.deepEqual(orientationFilesFor({ orientation: { enabled: true, maxFiles: 1 } }, dir), [whole(dir, "CLAUDE.md", 10)]);
  const capped = orientationFilesFor({ orientation: { enabled: true, maxBytes: 15 } }, dir);
  assert.deepEqual(names(capped || []), ["CLAUDE.md"], "README does not fit and the remainder is under the partial floor");
});

test("ORI6: resolver output inlines through the real openrouter bridge (absolute path under cwd resolves, no skip note)", () => {
  const dir = tmpRepo(["CLAUDE.md"]);
  const { blocks, notes } = inlineFiles(resolveOrientationFiles(dir), { roots: [dir] });
  assert.equal(blocks.length, 1, "orientation file inlined to a content block");
  assert.deepEqual(notes, [], "no skip / not-found-under-roots notes");
});

test("ORI7: AGENTS.md wins over CLAUDE.md; never both", () => {
  const dir = tmpRepo(["CLAUDE.md", "AGENTS.md"]);
  assert.deepEqual(names(resolveOrientationFiles(dir)), ["AGENTS.md"]);
});

test("ORI8: a 60 KB CLAUDE.md alone under the default budget becomes one partial entry", () => {
  const dir = tmpRepo({ "CLAUDE.md": 60000 });
  assert.deepEqual(resolveOrientationFiles(dir), [{ path: path.join(dir, "CLAUDE.md"), headBytes: 15936, mode: "inline" }]);
});

test("ORI9: a 15 KB AGENTS.md fits whole; README that no longer fits gets no fragment under 2048", () => {
  const dir = tmpRepo({ "AGENTS.md": 15000, "README.md": 28000 });
  assert.deepEqual(resolveOrientationFiles(dir), [whole(dir, "AGENTS.md", 15000)]);
});

test("ORI10: a large file that does not fit is followed by a small one that does; the large one takes the rest", () => {
  const dir = tmpRepo({ "CLAUDE.md": 60000, "package.json": 808 });
  assert.deepEqual(resolveOrientationFiles(dir), [
    { path: path.join(dir, "CLAUDE.md"), headBytes: 16000 - 808 - 64, mode: "inline" },
    whole(dir, "package.json", 808),
  ]);
});

test("ORI11: maxBytes 0 means no budget, but every file stays under the per-file cap", () => {
  const dir = tmpRepo({ "CLAUDE.md": PER_FILE_MAX + 5000, "README.md": 30000 });
  assert.deepEqual(resolveOrientationFiles(dir, { maxBytes: 0 }), [whole(dir, "CLAUDE.md", PER_FILE_MAX), whole(dir, "README.md", 30000)]);
});

test("ORI12: empty candidates are skipped, and every generated entry passes both bridges' validation", () => {
  const dir = tmpRepo({ "CLAUDE.md": 0, "package.json": 5, "README.md": 60000 });
  const out = resolveOrientationFiles(dir);
  assert.deepEqual(names(out), ["package.json", "README.md"]);
  assert.equal(grok.validateFiles(out), null);
  const { blocks, notes } = inlineFiles(out, { roots: [dir] });
  assert.deepEqual(notes, []);
  assert.equal(blocks.length, 2);
  assert.match(blocks[1], /\[truncated: first \d+ of 60000 bytes\]$/);
});

test("ORI13: an oversized instruction file evicts lower-priority whole files to keep its partial", () => {
  const dir = tmpRepo({ "AGENTS.md": 60000, "package.json": 808, "README.md": 15000 });
  assert.deepEqual(resolveOrientationFiles(dir), [
    { path: path.join(dir, "AGENTS.md"), headBytes: 16000 - 808 - 64, mode: "inline" },
    whole(dir, "package.json", 808),
  ]);
});

test("ORI14: when maxFiles is full, the lowest-priority whole file makes room for the partial", () => {
  const dir = tmpRepo({ "AGENTS.md": 60000, "package.json": 100, "go.mod": 100 });
  assert.deepEqual(names(resolveOrientationFiles(dir, { maxFiles: 2 })), ["AGENTS.md", "package.json"]);
});

test("ORI15: nothing is evicted when even that would not leave room for a partial", () => {
  const dir = tmpRepo({ "AGENTS.md": 60000, "package.json": 2000 });
  assert.deepEqual(resolveOrientationFiles(dir, { maxBytes: 2100 }), [whole(dir, "package.json", 2000)]);
});

test("ORI16: a file over the per-file max is charged its marker against the budget", () => {
  const dir = tmpRepo({ "CLAUDE.md": PER_FILE_MAX + 10, "README.md": 64 });
  const out = resolveOrientationFiles(dir, { maxBytes: PER_FILE_MAX + 64 });
  assert.deepEqual(out, [whole(dir, "CLAUDE.md", PER_FILE_MAX)], "README does not fit once the marker is charged");
});
