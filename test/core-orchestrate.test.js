// test/core-orchestrate.test.js
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { askAll, consensus } = require("../core/orchestrate.js");
/** @typedef {import("../core/types.js").Provider} Provider */

/** @param {string} name @param {string} [behavior] @returns {Provider} */
function fakeProvider(name, behavior) {
  return /** @type {any} */ ({
    name,
    capabilities: { canImplement: false, fileUpload: false, multiTurn: false },
    async health() { return { ok: true }; },
    async ask(/** @type {any} */ req) {
      if (behavior === "throw") throw new Error("boom");
      return { provider: name, model: "m", text: `${name}:${req.prompt}`, isError: false, ms: 1 };
    },
  });
}

test("O1: askAll returns one result per provider, in order", async () => {
  const out = await askAll([fakeProvider("a"), fakeProvider("b")], { prompt: "hi" });
  assert.deepEqual(out.map((r) => r.provider), ["a", "b"]);
  assert.equal(/** @type {any} */ (out[0]).text, "a:hi");
});

test("O2: a thrown provider becomes an isError result, never rejects the batch", async () => {
  const out = await askAll([fakeProvider("ok"), fakeProvider("bad", "throw")], { prompt: "x" });
  assert.equal(out[0].isError, false);
  assert.equal(out[1].isError, true);
  assert.equal(out[1].provider, "bad");
  assert.equal(out[1].errorKind, "unknown");
});

test("O3: each provider gets an independent copy of the request (zero contamination)", async () => {
  /** @type {any[]} */
  const seen = [];
  const a = /** @type {any} */ ({ name: "a", capabilities: {}, async health() { return { ok: true }; },
    async ask(/** @type {any} */ req) { req.prompt += "!"; seen.push(req.prompt); return { provider: "a", model: "m", isError: false, ms: 0 }; } });
  const b = /** @type {any} */ ({ name: "b", capabilities: {}, async health() { return { ok: true }; },
    async ask(/** @type {any} */ req) { seen.push(req.prompt); return { provider: "b", model: "m", isError: false, ms: 0 }; } });
  await askAll([a, b], { prompt: "p" });
  assert.deepEqual(seen, ["p!", "p"]); // b unaffected by a's mutation
});

test("C1: consensus fans out then runs ONE arbiter pass over the opinions", async () => {
  const a = fakeProvider("a"), b = fakeProvider("b");
  const arbiter = /** @type {any} */ ({ name: "arb", capabilities: {}, async health() { return { ok: true }; },
    async ask(/** @type {any} */ req) {
      const sawBoth = req.prompt.includes("a:hi") && req.prompt.includes("b:hi");
      return { provider: "arb", model: "m", text: `verdict:${sawBoth}`, isError: false, ms: 0 };
    } });
  const out = await consensus([a, b], { prompt: "hi" }, { arbiter });
  assert.equal(out.opinions.length, 2);
  assert.equal(out.verdict && /** @type {any} */ (out.verdict).text, "verdict:true"); // arbiter received both opinions in its prompt
});

test("C2: all-failed short-circuits with no arbiter call", async () => {
  let called = false;
  const arbiter = /** @type {any} */ ({ name: "arb", capabilities: {}, async health() { return { ok: true }; },
    async ask() { called = true; return { provider: "arb", model: "m", isError: false, ms: 0 }; } });
  const out = await consensus([fakeProvider("bad", "throw")], { prompt: "x" }, { arbiter });
  assert.equal(out.verdict, null);
  assert.equal(out.error, "all-providers-failed");
  assert.equal(called, false);
});

test("C3: default arbiter is the first provider when none passed", async () => {
  const out = await consensus([fakeProvider("a"), fakeProvider("b")], { prompt: "hi" });
  assert.equal(out.verdict && out.verdict.provider, "a"); // first provider arbitrates
});

test("C4: consensus is fail-safe when the arbiter throws", async () => {
  const a = fakeProvider("a"), b = fakeProvider("b");
  const badArbiter = /** @type {any} */ ({ name: "arb", capabilities: {}, async health() { return { ok: true }; },
    async ask() { throw new Error("arbiter boom"); } });
  const out = await consensus([a, b], { prompt: "hi" }, { arbiter: badArbiter });
  assert.equal(out.verdict, null);
  assert.equal(out.error, "arbiter-failed");
  assert.equal(out.opinions.length, 2);
});

test("C5: consensus with empty providers yields a safe shape, never throws", async () => {
  const out = await consensus([], { prompt: "hi" });
  assert.equal(out.verdict, null);
  // No opinions -> all-providers-failed guard fires before the no-arbiter guard.
  assert.ok(out.error === "all-providers-failed" || out.error === "no-arbiter");
});
