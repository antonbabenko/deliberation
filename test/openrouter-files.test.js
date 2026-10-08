"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { inlineFiles } = require("../server/openrouter/files.js");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cdg-orf-"));
}

test("F1: a {path} entry is inlined as a labeled text block", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "a.txt"), "hello world");
  const { blocks, notes } = inlineFiles([{ path: "a.txt", mode: "upload" }], { roots: [dir] });
  assert.equal(blocks.length, 1);
  assert.match(blocks[0], /a\.txt/);
  assert.match(blocks[0], /hello world/);
  assert.deepEqual(notes, []);
});

test("F2: a {dir} entry inlines each text file via the glob walker", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "a.txt"), "AAA");
  fs.writeFileSync(path.join(dir, "b.txt"), "BBB");
  const { blocks } = inlineFiles([{ dir: ".", include: ["**/*.txt"] }], { roots: [dir] });
  assert.equal(blocks.length, 2);
  assert.ok(blocks.join("\n").includes("AAA"));
  assert.ok(blocks.join("\n").includes("BBB"));
});

test("F3: file_id / file_url are rejected", () => {
  assert.throws(() => inlineFiles([{ file_id: "x" }], { roots: [tmpDir()] }), /file_id|file_url|not supported/i);
  assert.throws(() => inlineFiles([{ file_url: "http://x" }], { roots: [tmpDir()] }), /file_id|file_url|not supported/i);
});

test("F4: a file over the per-file cap is skipped with a note", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "big.txt"), "x".repeat(5000));
  const { blocks, notes } = inlineFiles([{ path: "big.txt" }], { roots: [dir], perFileCap: 1000 });
  assert.equal(blocks.length, 0);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /big\.txt/);
  assert.match(notes[0], /skipped/i);
});

test("F5: aggregate cap stops adding further files and notes the omission", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "a.txt"), "x".repeat(800));
  fs.writeFileSync(path.join(dir, "b.txt"), "y".repeat(800));
  const { blocks, notes } = inlineFiles([{ dir: ".", include: ["**/*.txt"] }], { roots: [dir], perFileCap: 2000, totalCap: 1000 });
  assert.equal(blocks.length, 1);
  assert.ok(notes.some((n) => /omitted|aggregate|budget/i.test(n)));
});

test("F6: glob.walk maxFiles overflow becomes a note, not a throw", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "a.txt"), "A");
  fs.writeFileSync(path.join(dir, "b.txt"), "B");
  fs.writeFileSync(path.join(dir, "c.txt"), "C");
  let res;
  assert.doesNotThrow(() => { res = inlineFiles([{ dir: ".", include: ["**/*.txt"], maxFiles: 1 }], { roots: [dir] }); });
  assert.ok(res.notes.some((n) => /skipped/i.test(n)));
});

test("F7: over-cap {path} is skipped via stat without reading (size in note)", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "big.txt"), "x".repeat(5000));
  const { blocks, notes } = inlineFiles([{ path: "big.txt" }], { roots: [dir], perFileCap: 1000 });
  assert.equal(blocks.length, 0);
  assert.match(notes[0], /5000 bytes/);
});

test("F-head1: a path entry with headBytes is truncated, not skipped, even over the per-file cap", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "big.md"), "x".repeat(300 * 1024));
  const { blocks, notes } = inlineFiles([{ path: "big.md", headBytes: 1 << 30 }], { roots: [dir] });
  assert.deepEqual(notes, []);
  assert.equal(blocks.length, 1);
  assert.match(blocks[0], /\[truncated: first \d+ of 307200 bytes\]$/);
  assert.ok(blocks[0].length <= 256 * 1024 + "=== big.md ===\n".length);
});

test("F-head2: headBytes is rejected on dir entries and when not a positive integer; dir maxBytes still caps the walk", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "a.txt"), "AAA");
  fs.writeFileSync(path.join(dir, "b.txt"), "BBB");
  assert.throws(() => inlineFiles([{ dir: ".", headBytes: 10 }], { roots: [dir] }), /only to path/);
  assert.throws(() => inlineFiles([{ path: "a.txt", headBytes: 0 }], { roots: [dir] }), /positive integer/);
  assert.throws(() => inlineFiles([{ path: "a.txt", headBytes: 10, mode: "upload" }], { roots: [dir] }), /upload/);
  const { blocks, notes } = inlineFiles([{ dir: ".", include: ["**/*.txt"], maxBytes: 3 }], { roots: [dir] });
  assert.equal(blocks.length, 0, "dir maxBytes keeps its walk-cap meaning (overflow refuses the walk)");
  assert.equal(notes.length, 1);
});

test("F-head3: headBytes on a path outside roots is still refused", () => {
  const dir = tmpDir();
  const other = tmpDir();
  fs.writeFileSync(path.join(other, "secret.txt"), "S");
  const { blocks, notes } = inlineFiles([{ path: path.join(other, "secret.txt"), headBytes: 10 }], { roots: [dir] });
  assert.equal(blocks.length, 0);
  assert.match(notes[0], /not found under roots/);
});
