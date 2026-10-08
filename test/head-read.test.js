"use strict";
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { readHead, cutHead, MARKER_RESERVE } = require("../core/head-read.js");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "headread-"));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const write = (/** @type {string} */ n, /** @type {string|Buffer} */ c) => { const p = path.join(dir, n); fs.writeFileSync(p, c); return p; };

test("HR1: a file shorter than headBytes is returned whole, no marker", () => {
  const r = readHead(write("a.txt", "line1\nline2\n"), 1000, 262144);
  assert.equal(r.truncated, false);
  assert.equal(r.buf.toString(), "line1\nline2\n");
});

test("HR2: a longer file is cut at the last newline and marked", () => {
  const r = readHead(write("b.txt", "aaaa\nbbbb\ncccc\n"), 12, 262144);
  assert.equal(r.truncated, true);
  assert.equal(r.buf.toString(), "aaaa\nbbbb\n[truncated: first 9 of 15 bytes]");
});

test("HR3: with no newline, the cut never splits a multi-byte character", () => {
  const p = write("c.txt", "é".repeat(10)); // 2 bytes each
  const r = readHead(p, 5, 262144);
  const text = r.buf.toString("utf8");
  assert.ok(!text.includes("�"), "valid UTF-8");
  assert.match(text, /^éé\n\[truncated: first 4 of 20 bytes\]$/);
  assert.equal(cutHead(Buffer.from("ab€", "utf8").subarray(0, 4)).toString(), "ab");
});

test("HR4: content plus marker stays within the per-file cap (newline-free file over the cap)", () => {
  const cap = 1024;
  const r = readHead(write("d.txt", "x".repeat(5000)), 100000, cap);
  assert.equal(r.truncated, true);
  assert.ok(r.buf.length <= cap, `${r.buf.length} <= ${cap}`);
  assert.ok(r.buf.length > cap - MARKER_RESERVE);
});

test("HR5: invalid headBytes and non-regular files are refused", () => {
  const p = write("e.txt", "x");
  for (const v of [0, -1, 1.5, "10", undefined]) assert.throws(() => readHead(p, /** @type {any} */ (v), 1024), /positive integer/);
  assert.throws(() => readHead(dir, 10, 1024), /regular file|EISDIR/);
  assert.throws(() => readHead(p, 10, MARKER_RESERVE), /too small/, "a cap that cannot hold the marker is refused");
});

test("HR6: a FIFO with no writer is refused without hanging", { skip: process.platform === "win32" }, () => {
  const fifo = path.join(dir, "pipe");
  if (spawnSync("mkfifo", [fifo]).status !== 0) return;
  const script = `try{require(${JSON.stringify(path.resolve(__dirname, "../core/head-read.js"))}).readHead(${JSON.stringify(fifo)},10,1024);process.exit(2)}catch(e){process.exit(/regular file/.test(e.message)?0:3)}`;
  const r = spawnSync(process.execPath, ["-e", script], { timeout: 5000 });
  assert.equal(r.status, 0, `exit ${r.status} signal ${r.signal}`);
});
