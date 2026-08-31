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
