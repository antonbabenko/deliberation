// test/core-result-cache.test.js
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { makeResultCache, keyFor } = require("../core/result-cache.js");
const { askAll, askOne } = require("../core/orchestrate.js");

/** A provider that counts how many times it was actually called. */
function countingProvider(/** @type {string} */ name) {
  let calls = 0;
  return /** @type {any} */ ({
    name,
    capabilities: { canImplement: false, fileUpload: false, multiTurn: false },
    async health() { return { ok: true }; },
    async ask(/** @type {any} */ _req) { calls += 1; return { provider: name, model: `${name}-m`, text: `r${calls}`, isError: false, ms: 7 }; },
    get __calls() { return calls; },
  });
}

function errorProvider(/** @type {string} */ name) {
  return /** @type {any} */ ({
    name,
    capabilities: { canImplement: false, fileUpload: false, multiTurn: false },
    async health() { return { ok: true }; },
    async ask(/** @type {any} */ _req) { return { provider: name, model: "m", isError: true, errorKind: "timeout", retryable: true, ms: 3 }; },
  });
}

test("C1: identical re-ask hits the cache (provider called once), stamps cached + ms 0", async () => {
  const cache = makeResultCache();
  const p = countingProvider("a");
  const r1 = /** @type {any} */ (await askOne(p, { prompt: "same" }, { cache }));
  const r2 = /** @type {any} */ (await askOne(p, { prompt: "same" }, { cache }));
  assert.equal(p.__calls, 1, "second identical ask must be served from cache");
  assert.equal(r1.isError, false);
  assert.equal(r2.cached, true);
  assert.equal(r2.ms, 0);
  assert.equal(r2.text, r1.text);
});

test("C2: a different prompt/model/effort/file is a cache MISS", async () => {
  const cache = makeResultCache();
  const p = countingProvider("a");
  await askOne(p, { prompt: "x" }, { cache });
  await askOne(p, { prompt: "y" }, { cache });                       // different prompt
  await askOne(p, { prompt: "x", reasoningEffort: "high" }, { cache }); // different effort
  await askOne(p, { prompt: "x", model: "z" }, { cache });            // different model
  await askOne(p, { prompt: "x", files: [{ path: "/f" }] }, { cache }); // different files
  assert.equal(p.__calls, 5, "each distinct key must call the provider");
});

test("C3: errors are NEVER cached (stay retryable)", async () => {
  const cache = makeResultCache();
  const p = errorProvider("e");
  await askOne(p, { prompt: "q" }, { cache });
  await askOne(p, { prompt: "q" }, { cache });
  assert.equal(cache.size, 0, "error results must not populate the cache");
});

test("C4: LRU evicts the oldest past the cap", async () => {
  const cache = makeResultCache({ max: 2 });
  const p = countingProvider("a");
  await askOne(p, { prompt: "1" }, { cache });
  await askOne(p, { prompt: "2" }, { cache });
  await askOne(p, { prompt: "3" }, { cache }); // evicts "1"
  assert.equal(cache.size, 2);
  // "1" was evicted -> a re-ask calls the provider again; "2"/"3" still hit.
  const before = p.__calls;
  await askOne(p, { prompt: "2" }, { cache });
  assert.equal(p.__calls, before, "2 should still be cached");
  await askOne(p, { prompt: "1" }, { cache });
  assert.equal(p.__calls, before + 1, "1 was evicted -> recomputed");
});

test("C5: askAll caches per-provider (each alias keyed by name)", async () => {
  const cache = makeResultCache();
  const a = countingProvider("a");
  const b = countingProvider("b");
  await askAll([a, b], { prompt: "q" }, { cache });
  await askAll([a, b], { prompt: "q" }, { cache });
  assert.equal(a.__calls, 1);
  assert.equal(b.__calls, 1);
});

test("C6: keyFor ignores threadId/cwd/timeout (retries do not fragment the key)", () => {
  const k1 = keyFor("a", { prompt: "q", threadId: "t1", cwd: "/x", timeoutMs: 1000 });
  const k2 = keyFor("a", { prompt: "q", threadId: "t2", cwd: "/y", timeoutMs: 2000 });
  assert.equal(k1, k2);
});

test("C7: no cache passed = always calls the provider", async () => {
  const p = countingProvider("a");
  await askOne(p, { prompt: "q" });
  await askOne(p, { prompt: "q" });
  assert.equal(p.__calls, 2);
});

test("C8: file-bearing requests bypass the cache (content can change under a path)", async () => {
  const cache = makeResultCache();
  const p = countingProvider("a");
  await askOne(p, { prompt: "q", files: [{ path: "/f" }] }, { cache });
  await askOne(p, { prompt: "q", files: [{ path: "/f" }] }, { cache });
  assert.equal(p.__calls, 2, "identical file request must NOT be served from cache");
  assert.equal(cache.size, 0, "file requests must not populate the cache");
});

test("C9: an expired entry is a miss (TTL)", async () => {
  const cache = makeResultCache({ ttlMs: 5 });
  const p = countingProvider("a");
  await askOne(p, { prompt: "q" }, { cache });
  await new Promise((r) => setTimeout(r, 20));
  await askOne(p, { prompt: "q" }, { cache }); // entry older than 5ms -> recompute
  assert.equal(p.__calls, 2);
});

test("C10: a provider that REJECTS yields a logged error result, never a throw", async () => {
  /** @type {any[]} */
  const events = [];
  const thrower = /** @type {any} */ ({
    name: "boom",
    capabilities: { canImplement: false, fileUpload: false, multiTurn: false },
    async health() { return { ok: true }; },
    async ask() { throw new Error("kaboom"); },
  });
  const r = /** @type {any} */ (await askOne(thrower, { prompt: "q" }, { logger: { logEvent: (/** @type {any} */ e) => events.push(e) } }));
  assert.equal(r.isError, true);
  assert.equal(r.errorKind, "unknown");
  assert.equal(events.length, 1, "the thrown failure must still emit a provider_result event");
  assert.equal(events[0].isError, true);
});

test("C11: keyFor separates ask and consensus contexts (prevents low-effort consensus polluting ask)", async () => {
  const kAsk = keyFor("a", { prompt: "q", context: "ask" });
  const kConsensus = keyFor("a", { prompt: "q", context: "consensus" });
  const kDefault = keyFor("a", { prompt: "q" });
  assert.equal(kAsk, kDefault, "default context should resolve to ask");
  assert.notEqual(kAsk, kConsensus, "consensus context must produce distinct key");

  const cache = makeResultCache();
  const p = countingProvider("a");
  const r1 = /** @type {any} */ (await askOne(p, { prompt: "q", context: "ask" }, { cache }));
  const r2 = /** @type {any} */ (await askOne(p, { prompt: "q", context: "consensus" }, { cache }));
  assert.equal(p.__calls, 2, "cross-context request must not reuse cached result");
  assert.equal(r2.cached, undefined);
});
