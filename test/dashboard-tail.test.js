// test/dashboard-tail.test.js
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");

const { createTailer } = require("../server/dashboard/tail.js");

/** @param {string} [prefix] */
function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix || "delib-dashtail-"));
}

/** A `watch` stub that never fires - forces delivery through the sweep timer only. */
function neverFires() {
  return { close() {} };
}

/** @param {number} ms */
function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const line = (/** @type {string} */ runId, /** @type {Record<string, unknown>} */ over) =>
  JSON.stringify({ v: 1, runId, at: 1, seq: 0, kind: "call_start", ...over });

test("TL1: append 2 lines -> subscriber gets 2 messages with byte-offset ids", async () => {
  const dir = tmpDir();
  const file = path.join(dir, "r1.jsonl");
  fs.writeFileSync(file, "");
  const tailer = createTailer({ runsDir: dir, sweepMs: 50, watch: neverFires });
  /** @type {{id: string, event: object}[]} */
  const received = [];
  tailer.subscribe((msg) => received.push(msg));

  const l1 = line("r1", { kind: "run_start" }) + "\n";
  fs.appendFileSync(file, l1);
  const l2 = line("r1", { kind: "run_end" }) + "\n";
  fs.appendFileSync(file, l2);

  await wait(120);
  tailer.close();

  assert.equal(received.length, 2);
  assert.equal(received[0].id, `r1:${Buffer.byteLength(l1)}`);
  assert.equal(received[1].id, `r1:${Buffer.byteLength(l1) + Buffer.byteLength(l2)}`);
  assert.equal(/** @type {any} */ (received[0].event).kind, "run_start");
  assert.equal(/** @type {any} */ (received[1].event).kind, "run_end");
});

test("TL2: a partial line delivers nothing; completing it delivers exactly 1 message", async () => {
  const dir = tmpDir();
  const file = path.join(dir, "r1.jsonl");
  fs.writeFileSync(file, "");
  const tailer = createTailer({ runsDir: dir, sweepMs: 50, watch: neverFires });
  /** @type {{id: string, event: object}[]} */
  const received = [];
  tailer.subscribe((msg) => received.push(msg));

  const full = line("r1", { kind: "run_start" });
  const cut = Math.floor(full.length / 2);
  fs.appendFileSync(file, full.slice(0, cut)); // no trailing newline: partial

  await wait(120);
  assert.equal(received.length, 0, "no message for a partial trailing line");

  fs.appendFileSync(file, full.slice(cut) + "\n"); // complete it
  await wait(120);
  tailer.close();

  assert.equal(received.length, 1);
  assert.equal(/** @type {any} */ (received[0].event).kind, "run_start");
});

test("TL3: since resume replays only lines after the offset, other runs tail from their end", async () => {
  const dir = tmpDir();
  const r1 = path.join(dir, "r1.jsonl");
  const r2 = path.join(dir, "r2.jsonl");
  const r1l1 = line("r1", { kind: "run_start" }) + "\n";
  const r1l2 = line("r1", { kind: "state" }) + "\n";
  fs.writeFileSync(r1, r1l1 + r1l2); // 2 lines already on disk before subscribe
  fs.writeFileSync(r2, line("r2", { kind: "run_start" }) + "\n"); // pre-existing r2 content

  const tailer = createTailer({ runsDir: dir, sweepMs: 50, watch: neverFires });
  /** @type {{id: string, event: object}[]} */
  const received = [];
  // Resume r1 right after its first line - only the 2nd line should replay.
  tailer.subscribe((msg) => received.push(msg), `r1:${Buffer.byteLength(r1l1)}`);

  await wait(120);
  assert.equal(received.length, 1);
  assert.equal(received[0].id, `r1:${Buffer.byteLength(r1l1) + Buffer.byteLength(r1l2)}`);
  assert.equal(/** @type {any} */ (received[0].event).kind, "state");

  // r2's pre-existing content is not replayed (no `since` for it) - only new appends.
  const r2l2 = line("r2", { kind: "call_end" }) + "\n";
  fs.appendFileSync(r2, r2l2);
  await wait(120);
  tailer.close();

  assert.equal(received.length, 2);
  assert.equal(/** @type {any} */ (received[1].event).kind, "call_end");
});

test("TL4: injected watch that never fires -> sweep timer still delivers within sweepMs", async () => {
  const dir = tmpDir();
  const file = path.join(dir, "r1.jsonl");
  fs.writeFileSync(file, "");
  const tailer = createTailer({ runsDir: dir, sweepMs: 40, watch: neverFires });
  /** @type {{id: string, event: object}[]} */
  const received = [];
  tailer.subscribe((msg) => received.push(msg));

  fs.appendFileSync(file, line("r1", {}) + "\n");
  await wait(150);
  tailer.close();

  assert.equal(received.length, 1);
});

test("TL5: a new run file created after subscribe is picked up", async () => {
  const dir = tmpDir();
  const tailer = createTailer({ runsDir: dir, sweepMs: 50, watch: neverFires });
  /** @type {{id: string, event: object}[]} */
  const received = [];
  tailer.subscribe((msg) => received.push(msg));

  const file = path.join(dir, "r9.jsonl");
  fs.writeFileSync(file, line("r9", { kind: "run_start" }) + "\n");
  await wait(120);
  tailer.close();

  assert.equal(received.length, 1);
  assert.equal(/** @type {any} */ (received[0].event).runId, "r9");
});

test("runs directory missing at subscribe time never throws; picked up once created", async () => {
  const dir = tmpDir();
  const missing = path.join(dir, "does-not-exist-yet");
  const tailer = createTailer({ runsDir: missing, sweepMs: 40, watch: neverFires });
  /** @type {{id: string, event: object}[]} */
  const received = [];
  assert.doesNotThrow(() => tailer.subscribe((msg) => received.push(msg)));

  fs.mkdirSync(missing, { recursive: true });
  fs.writeFileSync(path.join(missing, "r1.jsonl"), line("r1", {}) + "\n");
  await wait(150);
  tailer.close();

  assert.equal(received.length, 1);
});

test("close() stops delivery: no callbacks fire after close", async () => {
  const dir = tmpDir();
  const file = path.join(dir, "r1.jsonl");
  fs.writeFileSync(file, "");
  const tailer = createTailer({ runsDir: dir, sweepMs: 30, watch: neverFires });
  /** @type {{id: string, event: object}[]} */
  const received = [];
  tailer.subscribe((msg) => received.push(msg));
  tailer.close();

  fs.appendFileSync(file, line("r1", {}) + "\n");
  await wait(120);

  assert.equal(received.length, 0);
});

test("a pruned (deleted) run file drops its offset; recreated file starts at 0", async () => {
  const dir = tmpDir();
  const file = path.join(dir, "r1.jsonl");
  fs.writeFileSync(file, line("r1", { kind: "run_start" }) + "\n");
  const tailer = createTailer({ runsDir: dir, sweepMs: 40, watch: neverFires });
  /** @type {{id: string, event: object}[]} */
  const received = [];
  tailer.subscribe((msg) => received.push(msg));
  await wait(100);
  assert.equal(received.length, 0, "pre-existing content is not replayed with no `since`");

  fs.unlinkSync(file);
  await wait(100);
  fs.writeFileSync(file, line("r1", { kind: "run_start" }) + "\n"); // recreated, same id
  await wait(150);
  tailer.close();

  assert.equal(received.length, 1, "recreated file is read from 0, not skipped as already-seen");
});
