// test/core-orchestrate.test.js
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { askAll, consensus, buildArbiterPrompt } = require("../core/orchestrate.js");
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

// A blind-vote-aware arbiter: the verdict pass receives a buildArbiterPrompt
// (contains "### Opinion"); the blind pass receives the raw question.
function blindAwareArbiter(/** @type {string} */ behavior = "") {
  /** @type {string[]} */
  const calls = [];
  const provider = /** @type {any} */ ({
    name: "arb", capabilities: {}, async health() { return { ok: true }; },
    async ask(/** @type {any} */ req) {
      calls.push(req.prompt);
      const isVerdict = req.prompt.includes("### Opinion");
      if (behavior === "blind-throws" && !isVerdict) throw new Error("blind boom");
      return { provider: "arb", model: "m", text: isVerdict ? "verdict" : "blind", isError: false, ms: 0 };
    },
  });
  return { provider, calls };
}

test("C7: blindVote runs a blind pre-vote (raw question) alongside the verdict pass", async () => {
  const { provider, calls } = blindAwareArbiter();
  const out = await consensus([fakeProvider("a"), fakeProvider("b")], { prompt: "hi" }, { arbiter: provider, blindVote: true });
  assert.equal(out.blindVerdict && /** @type {any} */ (out.blindVerdict).text, "blind");
  assert.equal(out.verdict && /** @type {any} */ (out.verdict).text, "verdict");
  assert.ok(calls.includes("hi"), "arbiter saw the raw question (blind pass)");
  assert.ok(calls.some((p) => p.includes("### Opinion")), "arbiter saw the opinions (verdict pass)");
});

test("C8: a thrown blind pass yields blindVerdict:null but the run still succeeds", async () => {
  const { provider } = blindAwareArbiter("blind-throws");
  const out = await consensus([fakeProvider("a"), fakeProvider("b")], { prompt: "hi" }, { arbiter: provider, blindVote: true });
  assert.equal(out.blindVerdict, null);
  assert.equal(out.verdict && /** @type {any} */ (out.verdict).text, "verdict");
  assert.equal(out.error, undefined);
});

test("C9: blindVote off (default) -> blindVerdict is null, arbiter called once", async () => {
  const { provider, calls } = blindAwareArbiter();
  const out = await consensus([fakeProvider("a"), fakeProvider("b")], { prompt: "hi" }, { arbiter: provider });
  assert.equal(out.blindVerdict, null);
  assert.equal(calls.length, 1); // verdict pass only, no blind pass
});

test("C6: buildArbiterPrompt anonymizes opinion labels (no provider names leak)", () => {
  const opinions = /** @type {any} */ ([
    { provider: "codex", text: "alpha body" },
    { provider: "gemini", text: "beta body" },
    { provider: "openrouter:llama", text: "gamma body" },
  ]);
  const prompt = buildArbiterPrompt("the question", opinions);
  // anonymized numeric labels present, in order
  assert.match(prompt, /### Opinion 1\nalpha body/);
  assert.match(prompt, /### Opinion 2\nbeta body/);
  assert.match(prompt, /### Opinion 3\ngamma body/);
  // provider names must NOT appear anywhere in the arbiter prompt
  for (const name of ["codex", "gemini", "openrouter:llama", "llama"]) {
    assert.equal(prompt.includes(name), false, `provider name "${name}" leaked into arbiter prompt`);
  }
  // bodies and the original question are preserved
  assert.match(prompt, /the question/);
});
