// test/core-loop-store.test.js
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { makeLoopStore } = require("../core/loop-store.js");

/** A controllable clock. */
function clock(start = 1000) {
  let t = start;
  /** @type {any} */
  const now = () => t;
  now.advance = (/** @type {number} */ ms) => { t += ms; };
  return now;
}

test("LS1: put then get round-trips the state", () => {
  const s = makeLoopStore({ ttlMs: 1000, maxEntries: 10, now: clock() });
  s.put("a", { round: 1 });
  assert.deepEqual(s.get("a"), { round: 1 });
});

test("LS2: get returns null for an unknown id", () => {
  const s = makeLoopStore({ ttlMs: 1000, maxEntries: 10, now: clock() });
  assert.equal(s.get("missing"), null);
});

test("LS3: an entry past its TTL is expired (get returns null and drops it)", () => {
  const now = clock();
  const s = makeLoopStore({ ttlMs: 1000, maxEntries: 10, now });
  s.put("a", { round: 1 });
  now.advance(1001);
  assert.equal(s.get("a"), null);
  assert.equal(s.size(), 0); // dropped on access
});

test("LS4: get refreshes the TTL (sliding expiry keeps an active loop alive)", () => {
  const now = clock();
  const s = makeLoopStore({ ttlMs: 1000, maxEntries: 10, now });
  s.put("a", { round: 1 });
  now.advance(600);
  assert.deepEqual(s.get("a"), { round: 1 }); // touch at t=1600
  now.advance(600); // t=2200, but last touch was 1600 -> not yet expired (1600+1000=2600)
  assert.deepEqual(s.get("a"), { round: 1 });
});

test("LS5: size cap evicts the least-recently-touched entry", () => {
  const now = clock();
  const s = makeLoopStore({ ttlMs: 100000, maxEntries: 2, now });
  s.put("a", { v: 1 }); now.advance(10);
  s.put("b", { v: 2 }); now.advance(10);
  s.get("a"); now.advance(10);          // touch a -> b is now the oldest
  s.put("c", { v: 3 });                  // over cap -> evict b (least recently touched)
  assert.equal(s.size(), 2);
  assert.equal(s.get("b"), null);
  assert.deepEqual(s.get("a"), { v: 1 });
  assert.deepEqual(s.get("c"), { v: 3 });
});

test("LS6: delete removes an entry", () => {
  const s = makeLoopStore({ ttlMs: 1000, maxEntries: 10, now: clock() });
  s.put("a", { round: 1 });
  assert.equal(s.delete("a"), true);
  assert.equal(s.get("a"), null);
  assert.equal(s.delete("a"), false);
});

test("LS7: sweep drops expired entries and keeps fresh ones", () => {
  const now = clock();
  const s = makeLoopStore({ ttlMs: 1000, maxEntries: 10, now });
  s.put("old", { v: 1 });
  now.advance(500);
  s.put("fresh", { v: 2 }); // touched at 1500
  now.advance(600);          // t=2100; old last-touched 1000 (expired), fresh 1500 (alive)
  const removed = s.sweep();
  assert.equal(removed, 1);
  assert.equal(s.get("old"), null);
  assert.deepEqual(s.get("fresh"), { v: 2 });
});

test("LS8: put refreshes touch + overwrites state", () => {
  const now = clock();
  const s = makeLoopStore({ ttlMs: 1000, maxEntries: 10, now });
  s.put("a", { round: 1 });
  now.advance(900);
  s.put("a", { round: 2 }); // overwrite + refresh touch to t=1900
  now.advance(900);          // t=2800; last touch 1900 -> alive
  assert.deepEqual(s.get("a"), { round: 2 });
});

test("LS9: defaults are sane when opts omitted/null (no throw)", () => {
  assert.doesNotThrow(() => {
    const s = makeLoopStore();
    s.put("a", { round: 1 });
    assert.deepEqual(s.get("a"), { round: 1 });
  });
  assert.doesNotThrow(() => makeLoopStore(/** @type {any} */ (null)));
});

test("LS10: eviction is TRUE LRU under a frozen clock (seq, not timestamp ties)", () => {
  // Clock never advances -> all touchedAt equal. Eviction must still respect
  // access recency via the monotonic seq counter.
  const s = makeLoopStore({ ttlMs: 100000, maxEntries: 2, now: () => 5000 });
  s.put("a", { v: 1 });
  s.put("b", { v: 2 });
  s.get("a");            // a is now most-recently-used despite equal timestamps
  s.put("c", { v: 3 });  // over cap -> evict b (least-recently-used)
  assert.equal(s.get("b"), null);
  assert.deepEqual(s.get("a"), { v: 1 });
  assert.deepEqual(s.get("c"), { v: 3 });
});
