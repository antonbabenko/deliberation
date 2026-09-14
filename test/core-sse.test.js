// test/core-sse.test.js
"use strict";
// Framing only - what an event MEANS belongs to the provider bridge. These cases come
// from the SSE spec rather than from the parser, because a fixture that mirrors the
// implementation can never disagree with it (which is exactly how the CRLF bug shipped).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseSseFrame, readSseStream } = require("../core/sse.js");

/** @param {string} text @param {number} [chunkAt] @returns {AsyncIterable<Uint8Array>} */
function bodyOf(text, chunkAt) {
  const bytes = new TextEncoder().encode(text);
  const pieces = chunkAt ? [bytes.slice(0, chunkAt), bytes.slice(chunkAt)] : [bytes];
  return (async function* () { for (const p of pieces) yield p; })();
}

/** @param {string} text @param {number} [chunkAt] @returns {Promise<any[]>} */
async function collect(text, chunkAt) {
  /** @type {any[]} */
  const seen = [];
  await readSseStream(bodyOf(text, chunkAt), (ev) => seen.push(ev));
  return seen;
}

test("SSE1: parseSseFrame reads the data payload and the event name", () => {
  assert.deepEqual(parseSseFrame("event: ping\ndata: {\"a\":1}"), { event: "ping", data: '{"a":1}' });
  assert.deepEqual(parseSseFrame("data: hello"), { event: null, data: "hello" });
});

test("SSE2: comment keepalives and the [DONE] sentinel yield no event", () => {
  assert.equal(parseSseFrame(": keepalive"), null);
  assert.equal(parseSseFrame("data: [DONE]"), null);
  assert.equal(parseSseFrame(""), null);
});

test("SSE3: multi-line data fields concatenate", () => {
  const ev = parseSseFrame("data: {\"a\":\ndata: 1}");
  assert.equal(ev && ev.data, '{"a":1}');
});

for (const [name, eol] of [["LF", "\n"], ["CRLF", "\r\n"], ["CR", "\r"]]) {
  test(`SSE4-${name}: frames split on a blank line with ${name} endings`, async () => {
    const text = `data: one${eol}${eol}data: two${eol}${eol}`;
    assert.deepEqual((await collect(text)).map((e) => e.data), ["one", "two"]);
  });
}

test("SSE5: a frame split across chunk boundaries reassembles", async () => {
  const text = 'data: {"type":"x","v":1}\n\ndata: {"type":"y"}\n\n';
  assert.deepEqual((await collect(text, 12)).map((e) => e.data), ['{"type":"x","v":1}', '{"type":"y"}']);
});

test("SSE6: a trailing frame with no closing delimiter is still delivered", async () => {
  // A truncated stream's last frame is worth parsing, not discarding.
  assert.deepEqual((await collect("data: last")).map((e) => e.data), ["last"]);
});

test("SSE7: a multi-byte character split across chunks is decoded once, not twice", async () => {
  const bytes = new TextEncoder().encode("data: é\n\n");
  const body = (async function* () { yield bytes.slice(0, 7); yield bytes.slice(7); })();
  /** @type {any[]} */
  const seen = [];
  await readSseStream(body, (ev) => seen.push(ev));
  assert.deepEqual(seen.map((e) => e.data), ["é"]);
});

test("SSE8: an empty body produces no events and does not throw", async () => {
  assert.deepEqual(await collect(""), []);
});

// --- abort enforcement (the fetch signal does not reliably error a flowing body) ---------
test("SSE-abort-1: with a signal, the reader is cancelled on abort even when the body keeps flowing", async () => {
  const { readSseStream } = require("../core/sse.js");
  let cancelled = false; let reads = 0;
  // A body that never ends and never honours the fetch signal - the observed Node 22 behaviour.
  const body = /** @type {any} */ ({
    getReader() {
      return {
        read: () => new Promise((resolve) => { reads++; setTimeout(() => resolve({ value: new TextEncoder().encode("data: {\"type\":\"response.in_progress\"}\n\n"), done: false }), 30); }),
        cancel: async () => { cancelled = true; },
        releaseLock() {},
      };
    },
  });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);
  /** @type {any[]} */ const seen = [];
  const started = Date.now();
  await assert.rejects(readSseStream(body, (ev) => seen.push(ev), controller.signal), (/** @type {any} */ e) => e.name === "AbortError");
  assert.ok(Date.now() - started < 1000, "rejected at the abort, not when the body decided to end");
  assert.equal(cancelled, true, "the reader we own is cancelled so the socket is released");
  assert.ok(seen.length >= 1 && reads >= seen.length, "frames delivered before the abort were parsed");
});

test("SSE-abort-2: without a signal, or with a body that has no getReader, iteration is unchanged", async () => {
  const { readSseStream } = require("../core/sse.js");
  const frames = ["data: {\"a\":1}\n\n", "data: {\"b\":2}\n\n"].map((f) => new TextEncoder().encode(f));
  const iterable = { async *[Symbol.asyncIterator]() { for (const f of frames) yield f; } };
  /** @type {string[]} */ const a = []; await readSseStream(iterable, (ev) => a.push(ev.data));
  assert.deepEqual(a, ['{"a":1}', '{"b":2}']);
  /** @type {string[]} */ const b = []; await readSseStream(iterable, (ev) => b.push(ev.data), new AbortController().signal);
  assert.deepEqual(b, ['{"a":1}', '{"b":2}'], "a signal on a plain iterable falls back to for-await");
});

test("SSE-abort-3: a reader whose cancel() never settles cannot hold the timeout hostage", async () => {
  const { readSseStream } = require("../core/sse.js");
  const body = /** @type {any} */ ({
    getReader() {
      return {
        read: () => new Promise(() => {}), // never yields
        cancel: () => new Promise(() => {}), // never settles either
        releaseLock() {},
      };
    },
  });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);
  const started = Date.now();
  await assert.rejects(readSseStream(body, () => {}, controller.signal), (/** @type {any} */ e) => e.name === "AbortError");
  assert.ok(Date.now() - started < 1000, "rejected at the abort despite a pending cancel()");
});

test("SSE-abort-4: a normal completion leaves no abort listener behind, however many chunks flowed", async () => {
  const { readSseStream } = require("../core/sse.js");
  const frames = Array.from({ length: 500 }, (_, i) => new TextEncoder().encode(`data: {"i":${i}}\n\n`));
  let idx = 0;
  const body = /** @type {any} */ ({ getReader() { return { read: async () => idx < frames.length ? { value: frames[idx++], done: false } : { done: true }, cancel: async () => {}, releaseLock() {} }; } });
  const controller = new AbortController();
  const added = []; const removed = [];
  const origAdd = controller.signal.addEventListener.bind(controller.signal);
  const origRemove = controller.signal.removeEventListener.bind(controller.signal);
  controller.signal.addEventListener = (/** @type {any} */ t, /** @type {any} */ l, /** @type {any} */ o) => { added.push(l); return origAdd(t, l, o); };
  controller.signal.removeEventListener = (/** @type {any} */ t, /** @type {any} */ l, /** @type {any} */ o) => { removed.push(l); return origRemove(t, l, o); };
  let n = 0;
  await readSseStream(body, () => { n++; }, controller.signal);
  assert.equal(n, 500);
  assert.equal(added.length, removed.length, "every per-read subscription is removed when its read settles");
});
