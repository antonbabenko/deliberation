// test/core-orchestrate.test.js
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { askAll, askOne, consensus, buildArbiterPrompt, buildAdjudicationPrompt, runToConvergence } = require("../core/orchestrate.js");
const { askOne: askOneT } = require("../core/orchestrate.js");
const { makeResultCache } = require("../core/result-cache.js");
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

test("C6b: buildArbiterPrompt caps an over-long opinion keeping head AND tail; short ones untouched", () => {
  // The verdict sits at the END of a review: a head-only cut dropped it.
  const long = "x".repeat(5000) + "\nVERDICT: REJECT";
  const opinions = /** @type {any} */ ([
    { provider: "codex", text: long },
    { provider: "gemini", text: "short body" },
  ]);
  const prompt = buildArbiterPrompt("q", opinions);
  assert.equal(prompt.includes("x".repeat(5000)), false, "uncapped long opinion leaked into prompt");
  assert.match(prompt, /x{1800}\n\.\.\.\[cut\]\.\.\.\nx+\nVERDICT: REJECT/);
  const block = prompt.slice(prompt.indexOf("### Opinion 1"), prompt.indexOf("### Opinion 2"));
  assert.ok(block.length <= 3000 + "### Opinion 1\n".length + "\n...[cut]...\n".length + 2, "block stays within the cap");
  // short opinion is left exactly as-is (no marker)
  assert.match(prompt, /### Opinion 2\nshort body/);
  assert.equal((prompt.match(/\[cut\]/g) || []).length, 1);
});

test("C6c: buildAdjudicationPrompt caps a peer block with many long issues", () => {
  const issues = Array.from({ length: 50 }, (_, i) => ({ category: "bug", description: "y".repeat(100) + i }));
  const results = /** @type {any} */ ([
    { source: "codex", isError: false, verdict: "REJECT", criticalIssues: issues },
    { source: "gemini", isError: false, verdict: "APPROVE", criticalIssues: [] },
  ]);
  const prompt = buildAdjudicationPrompt({ currentPlan: "the plan" }, results);
  assert.match(prompt, /\.\.\.\[cut\]\.\.\./); // the verbose peer was capped
  assert.match(prompt, /Peer gemini: APPROVE/); // the short peer is intact
  assert.match(prompt, /the plan/);
});

/** A provider that records the req it was asked with. @param {string} name @param {boolean|undefined} walks */
function recordingProvider(name, walks) {
  /** @type {any} */
  const seen = {};
  const provider = /** @type {any} */ ({
    name,
    capabilities: { canImplement: false, fileUpload: false, multiTurn: false, walksFilesystem: walks },
    async health() { return { ok: true }; },
    async ask(/** @type {any} */ req) { seen.files = req.files; return { provider: name, model: "m", text: "ok", isError: false, ms: 0 }; },
  });
  return { provider, seen };
}

const BUNDLE = [{ path: "/repo/CLAUDE.md" }, { path: "/repo/package.json" }];

test("ORX1: orientationFiles auto-attach to a file-blind provider (walksFilesystem:false)", async () => {
  const { provider, seen } = recordingProvider("blind", false);
  await askAll([provider], { prompt: "hi" }, { orientationFiles: BUNDLE });
  assert.deepEqual(seen.files, BUNDLE);
});

test("ORX2: orientationFiles do NOT attach to a filesystem-walking provider (walksFilesystem:true)", async () => {
  const { provider, seen } = recordingProvider("walker", true);
  await askAll([provider], { prompt: "hi" }, { orientationFiles: BUNDLE });
  assert.equal(seen.files, undefined);
});

test("ORX3: a provider with no walksFilesystem flag is treated as NOT blind (safe default)", async () => {
  const { provider, seen } = recordingProvider("legacy", undefined);
  await askAll([provider], { prompt: "hi" }, { orientationFiles: BUNDLE });
  assert.equal(seen.files, undefined);
});

test("ORX4: explicit req.files is never overridden by orientation", async () => {
  const { provider, seen } = recordingProvider("blind", false);
  const explicit = [{ path: "/repo/main.go" }];
  await askAll([provider], { prompt: "hi", files: explicit }, { orientationFiles: BUNDLE });
  assert.deepEqual(seen.files, explicit);
});

test("ORX5: askOne applies the same orientation gating", async () => {
  const { provider, seen } = recordingProvider("blind", false);
  await askOne(provider, { prompt: "hi" }, { orientationFiles: BUNDLE });
  assert.deepEqual(seen.files, BUNDLE);
});

test("ORX6: empty orientation bundle is a no-op (empty repo)", async () => {
  const { provider, seen } = recordingProvider("blind", false);
  await askAll([provider], { prompt: "hi" }, { orientationFiles: [] });
  assert.equal(seen.files, undefined);
});

test("ORX7: consensus peer fan-out auto-attaches orientation to file-blind peers", async () => {
  const { provider, seen } = recordingProvider("blind", false);
  const arbiter = /** @type {any} */ ({ name: "arb", capabilities: { walksFilesystem: true },
    async health() { return { ok: true }; },
    async ask() { return { provider: "arb", model: "m", text: "verdict", isError: false, ms: 0 }; } });
  await consensus([provider], { prompt: "hi" }, { arbiter, orientationFiles: BUNDLE });
  assert.deepEqual(seen.files, BUNDLE);
});

test("ORX8: arbiter BLIND pass is oriented for a file-blind arbiter; the verdict pass is NOT", async () => {
  /** @type {any[]} */
  const calls = [];
  const arbiter = /** @type {any} */ ({
    name: "arb", capabilities: { walksFilesystem: false },
    async health() { return { ok: true }; },
    async ask(/** @type {any} */ req) {
      const isVerdict = req.prompt.includes("### Opinion");
      calls.push({ isVerdict, files: req.files });
      return { provider: "arb", model: "m", text: isVerdict ? "verdict" : "blind", isError: false, ms: 0 };
    },
  });
  await consensus([fakeProvider("a")], { prompt: "hi" }, { arbiter, blindVote: true, orientationFiles: BUNDLE });
  const blind = calls.find((c) => !c.isVerdict);
  const verdict = calls.find((c) => c.isVerdict);
  assert.deepEqual(blind.files, BUNDLE, "blind pass (cold question) is oriented");
  assert.equal(verdict.files, undefined, "verdict pass (peer text) is NOT oriented");
});

test("ORX9: runToConvergence adjudication/revision passes are NOT oriented (only the blind pass)", async () => {
  /** @type {any[]} */
  const calls = [];
  const arbiter = /** @type {any} */ ({
    name: "arb", capabilities: { walksFilesystem: false },
    async health() { return { ok: true }; },
    async ask(/** @type {any} */ req) {
      const isAdjudication = req.prompt.includes("## Peer reviews");
      const isRevision = req.prompt.includes("## Current plan");
      const kind = isAdjudication ? "adjudication" : isRevision ? "revision" : "blind";
      calls.push({ kind, files: req.files });
      // APPROVE on adjudication so the loop converges in round 1.
      const text = isAdjudication ? "**Verdict**: APPROVE" : "ok";
      return { provider: "arb", model: "m", text, isError: false, ms: 0 };
    },
  });
  const peer = /** @type {any} */ ({ name: "p", capabilities: { walksFilesystem: false },
    async health() { return { ok: true }; },
    async ask() { return { provider: "p", model: "m", text: "**Verdict**: APPROVE", isError: false, ms: 0 }; } });
  await runToConvergence([peer], { prompt: "the plan" }, { arbiter, orientationFiles: BUNDLE, blindVote: true });
  const blind = calls.find((c) => c.kind === "blind");
  const adjudication = calls.find((c) => c.kind === "adjudication");
  assert.deepEqual(blind.files, BUNDLE, "blind pass (cold question) is oriented");
  assert.equal(adjudication.files, undefined, "adjudication pass (peer text) is NOT oriented");
});

/** Provider whose ask() returns a scripted sequence of results, counting calls.
 * @param {string} name
 * @param {any[]} sequence
 * @returns {any}
 */
function scriptedProvider(name, sequence) {
  let i = 0;
  const p = {
    name,
    calls: 0,
    capabilities: { canImplement: false, fileUpload: false, multiTurn: false },
    async health() { return { ok: true }; },
    async ask() { p.calls++; return sequence[Math.min(i++, sequence.length - 1)]; },
  };
  return p;
}
/** @param {string} kind @returns {any} */
const ERR = (kind) => ({ provider: "p", model: "m", isError: true, errorKind: kind, retryable: true, ms: 1 });
/** @returns {any} */
const OK = () => ({ provider: "p", model: "m", isError: false, text: "ok", ms: 1 });

test("ORX-retry-1: a network error retries once and the retry's success is returned", async () => {
  const p = scriptedProvider("p", [ERR("network"), OK()]);
  const r = await askOneT(p, { prompt: "x" });
  assert.equal(r.isError, false);
  assert.equal(r.text, "ok");
  assert.equal(p.calls, 2);
});

test("ORX-retry-2: a timeout error is NOT retried (slow/non-idempotent guard)", async () => {
  const p = scriptedProvider("p", [ERR("timeout"), OK()]);
  const r = await askOneT(p, { prompt: "x" });
  assert.equal(r.isError, true);
  assert.equal(r.errorKind, "timeout");
  assert.equal(p.calls, 1);
});

test("ORX-retry-3: two consecutive network errors retry exactly once (no third call)", async () => {
  const p = scriptedProvider("p", [ERR("network"), ERR("network"), OK()]);
  const r = await askOneT(p, { prompt: "x" });
  assert.equal(r.isError, true);
  assert.equal(r.errorKind, "network");
  assert.equal(p.calls, 2);
});

// --- retry ladder ---
// callProvider retries exactly once, only for kinds that actually self-heal.

function countingProvider(/** @type {any[]} */ results) {
  let calls = 0;
  return {
    name: "p", capabilities: { canImplement: false, fileUpload: false, multiTurn: false },
    async health() { return { ok: true }; },
    async ask() { const r = results[Math.min(calls, results.length - 1)]; calls++; return r; },
    get calls() { return calls; },
  };
}
const errResult = (/** @type {any} */ extra) => ({ provider: "p", model: "m", isError: true, retryable: true, ms: 1, ...extra });
const okResult = { provider: "p", model: "m", isError: false, text: "fine", ms: 1, reasoningEffort: null };

test("RT1: a rate-limit is retried once and the retry's success is returned", async () => {
  const p = countingProvider([errResult({ errorKind: "rate-limit", retryAfterMs: 0 }), okResult]);
  const r = await askOne(p, { prompt: "x" });
  assert.equal(p.calls, 2, "exactly one retry");
  assert.equal(r.isError, false);
});

test("RT2: an empty (non-answer) result is retried once", async () => {
  const p = countingProvider([errResult({ errorKind: "empty" }), okResult]);
  const r = await askOne(p, { prompt: "x" });
  assert.equal(p.calls, 2);
  assert.equal(r.isError, false);
});

test("RT3: timeout and auth are NOT retried", async () => {
  for (const kind of ["timeout", "auth", "parse", "config"]) {
    const p = countingProvider([errResult({ errorKind: kind }), okResult]);
    const r = await askOne(p, { prompt: "x" });
    assert.equal(p.calls, 1, `${kind} must not retry`);
    assert.equal(r.isError, true);
  }
});

test("RT4: a second failure is returned as-is (one retry, not a loop)", async () => {
  const p = countingProvider([errResult({ errorKind: "rate-limit", retryAfterMs: 0 }), errResult({ errorKind: "rate-limit", retryAfterMs: 0 })]);
  const r = await askOne(p, { prompt: "x" });
  assert.equal(p.calls, 2);
  assert.equal(r.isError, true);
  assert.equal(r.errorKind, "rate-limit");
});

test("RT5: the rate-limit retry waits for Retry-After, clamped to 30s", async () => {
  // A hostile hint must not stall the fan-out, so the wait is capped. Assert the clamp
  // by wall clock only at the cheap end: an oversized hint would hang this test if the
  // cap were missing, since the suite has no fake timers.
  const started = Date.now();
  const p = countingProvider([errResult({ errorKind: "rate-limit", retryAfterMs: 60 }), okResult]);
  await askOne(p, { prompt: "x" });
  const waited = Date.now() - started;
  assert.ok(waited >= 50, `honored the hint (waited ${waited}ms)`);
  assert.ok(waited < 5000, `did not fall back to a long default (waited ${waited}ms)`);
});

test("RT6: a retried call logs BOTH attempts, so the retry does not erase the failure", async () => {
  // Only the final result is logged at the end of callProvider, so without an explicit
  // log of the failed first attempt a rate-limit that succeeds on retry would be
  // invisible in debug.jsonl - the signal used to diagnose provider health.
  /** @type {any[]} */
  const events = [];
  const logger = { logEvent: (/** @type {any} */ e) => events.push(e) };
  const p = countingProvider([errResult({ errorKind: "rate-limit", retryAfterMs: 0 }), okResult]);
  await askOne(p, { prompt: "x" }, { logger, tool: "ask-one" });
  const rows = events.filter((e) => e.event === "provider_result");
  assert.equal(rows.length, 2, "two provider_result rows for one retried call");
  assert.equal(rows[0].isError, true);
  assert.equal(rows[0].errorKind, "rate-limit");
  assert.equal(rows[1].isError, false);
});

test("RT7: a call that does NOT retry still logs exactly one row", async () => {
  /** @type {any[]} */
  const events = [];
  const logger = { logEvent: (/** @type {any} */ e) => events.push(e) };
  const p = countingProvider([okResult]);
  await askOne(p, { prompt: "x" }, { logger, tool: "ask-one" });
  assert.equal(events.filter((e) => e.event === "provider_result").length, 1);
});

// --- transport observability + retry pacing --------------------------------

test("ORX-retry-4: a network retry waits before firing again", async () => {
  // Retrying in the SAME millisecond cannot help a transport fault; it only doubled the
  // log rows for a deterministic one. The pause is what makes the second attempt mean
  // something. Asserted as a lower bound so a slow machine cannot flake it.
  const p = scriptedProvider("p", [ERR("network"), OK()]);
  const started = Date.now();
  const r = await askOneT(p, { prompt: "x" });
  assert.equal(r.isError, false);
  assert.equal(p.calls, 2);
  assert.ok(Date.now() - started >= 900, `expected a pause before the retry, got ${Date.now() - started}ms`);
});

test("ORX-retry-5: a rate-limit retry still honors Retry-After, not the network pause", async () => {
  const p = scriptedProvider("p", [{ ...ERR("rate-limit"), retryAfterMs: 0 }, OK()]);
  const started = Date.now();
  await askOneT(p, { prompt: "x" });
  assert.equal(p.calls, 2);
  assert.ok(Date.now() - started < 900, "an explicit Retry-After of 0 must not pick up the network pause");
});

test("ORX-log-1: provider_result logs the transport cause code behind a coarse kind", async () => {
  // errorKind alone made a 300s undici ceiling and an instant DNS failure look
  // identical in the only place provider health is diagnosed.
  /** @type {any[]} */
  const events = [];
  const logger = { logEvent: (/** @type {any} */ e) => events.push(e) };
  const p = scriptedProvider("p", [{ ...ERR("timeout"), transportCode: "UND_ERR_HEADERS_TIMEOUT" }]);
  await askOneT(p, { prompt: "x" }, { logger, tool: "ask-one" });
  const rows = events.filter((e) => e.event === "provider_result");
  assert.equal(rows.length, 1, "a timeout is not retried, so it logs exactly one row");
  assert.equal(rows[0].errorCode, "UND_ERR_HEADERS_TIMEOUT");
});

test("ORX-log-2: a successful result carries no errorCode", async () => {
  /** @type {any[]} */
  const events = [];
  const logger = { logEvent: (/** @type {any} */ e) => events.push(e) };
  await askOneT(scriptedProvider("p", [OK()]), { prompt: "x" }, { logger, tool: "ask-one" });
  assert.equal(events.filter((e) => e.event === "provider_result")[0].errorCode, undefined);
});

test("ORX-retry-6: `upstream` is retried once, matching what the bridges advertise", async () => {
  // classifyGrokError returns retryable:true for `upstream` and the docs said so in three
  // places, but the retry set did not agree - so a transient 5xx or an aborted generation
  // failed the round outright with no second attempt.
  const p = scriptedProvider("p", [ERR("upstream"), OK()]);
  const r = await askOneT(p, { prompt: "x" });
  assert.equal(r.isError, false);
  assert.equal(p.calls, 2);
});

// --- Host budget across sequential legs (retry, arbiter passes) ----------------------------
/** @param {string} v @param {() => Promise<void>} fn */
async function withHostCap(v, fn) {
  const saved = process.env.MCP_TOOL_TIMEOUT;
  process.env.MCP_TOOL_TIMEOUT = v;
  try { await fn(); } finally { if (saved === undefined) delete process.env.MCP_TOOL_TIMEOUT; else process.env.MCP_TOOL_TIMEOUT = saved; }
}

test("HBX1: under a host cap the retry is fitted into what is LEFT, not handed the whole cap again", async () => {
  await withHostCap("8000", async () => {
    /** @type {number[]} */ const seen = [];
    let calls = 0;
    const p = /** @type {any} */ ({
      name: "grok", capabilities: {}, async health() { return { ok: true }; },
      async ask(/** @type {any} */ req) { seen.push(req.hostBudgetRemainingMs); calls++; return calls === 1 ? { provider: "grok", model: "m", isError: true, errorKind: "network", retryable: true, ms: 1 } : { provider: "grok", model: "m", text: "ok", isError: false, ms: 1 }; },
    });
    const r = await askOne(p, { prompt: "x", timeoutMs: 180000 });
    assert.equal(r.isError, false);
    assert.equal(seen.length, 2);
    assert.ok(seen[0] <= 3000, `first leg stamped with what is left of the cap (got ${seen[0]})`);
    assert.ok(seen[1] < seen[0], `retry got less than the first leg (${seen[1]} vs ${seen[0]})`);
  });
});

test("HBX2: with the host budget spent, the retry is skipped and the honest first result is returned", async () => {
  await withHostCap("6000", async () => { // 6000 - 5000 margin = the 1000 floor: nothing left for a second leg
    let calls = 0;
    const p = /** @type {any} */ ({
      name: "grok", capabilities: {}, async health() { return { ok: true }; },
      async ask() { calls++; return { provider: "grok", model: "m", isError: true, errorKind: "network", retryable: true, ms: 1 }; },
    });
    const r = await askOne(p, { prompt: "x" });
    assert.equal(r.isError, true);
    assert.equal(r.errorKind, "network");
    assert.equal(calls, 1, "no retry without budget");
  });
});

test("HBX3: the consensus arbiter verdict pass is fitted into what the fan-out left", async () => {
  await withHostCap("60000", async () => {
    /** @type {any[]} */ const arbiterReqs = [];
    const peer = /** @type {any} */ ({ name: "grok", capabilities: {}, async health() { return { ok: true }; }, async ask() { return { provider: "grok", model: "m", text: "VERDICT: APPROVE", isError: false, ms: 1 }; } });
    const arbiter = /** @type {any} */ ({ name: "codex", capabilities: {}, async health() { return { ok: true }; }, async ask(/** @type {any} */ req) { arbiterReqs.push(req); return { provider: "codex", model: "m", text: "VERDICT: APPROVE", isError: false, ms: 1 }; } });
    await consensus([peer], { prompt: "q", timeoutMs: 600000 }, { arbiter });
    assert.equal(arbiterReqs.length, 1);
    assert.ok(arbiterReqs[0].hostBudgetRemainingMs <= 55000, `arbiter leg stamped with what is left (got ${arbiterReqs[0].hostBudgetRemainingMs})`);
    assert.equal(arbiterReqs[0].timeoutMs, 600000, "the caller's own ceiling is untouched; the adapter clamps");
  });
});

test("HBX5: a Retry-After that would outlive the host cap is not even slept on", async () => {
  await withHostCap("8000", async () => { // 3000 usable; a 30s Retry-After cannot fit
    let calls = 0;
    const p = /** @type {any} */ ({
      name: "grok", capabilities: {}, async health() { return { ok: true }; },
      async ask() { calls++; return { provider: "grok", model: "m", isError: true, errorKind: "rate-limit", retryable: true, retryAfterMs: 30000, ms: 1 }; },
    });
    const started = Date.now();
    const r = await askOne(p, { prompt: "x" });
    assert.ok(Date.now() - started < 2000, "returned without sleeping through the backoff");
    assert.equal(/** @type {any} */ (r).errorKind, "rate-limit");
    assert.equal(calls, 1);
  });
});

test("HBX6: a later consensus round runs on the SAME cap clock as round one - the fan-out is not handed the whole cap again", async () => {
  await withHostCap("60000", async () => {
    /** @type {number[]} */ const peerBudgets = [];
    let peerCalls = 0;
    const peer = /** @type {any} */ ({ name: "p", capabilities: {}, async health() { return { ok: true }; },
      async ask(/** @type {any} */ req) {
        peerBudgets.push(req.hostBudgetRemainingMs); peerCalls++;
        await new Promise((r) => setTimeout(r, 40)); // real time passes between rounds
        // Dissent in round 1 forces a second round; approve in round 2.
        return { provider: "p", model: "m", text: peerCalls === 1 ? "VERDICT: REQUEST_CHANGES\nCRITICAL: x" : "VERDICT: APPROVE", isError: false, ms: 1 };
      } });
    const arbiter = /** @type {any} */ ({ name: "arb", capabilities: {}, async health() { return { ok: true }; },
      async ask(/** @type {any} */ req) { return { provider: "arb", model: "m", text: req.prompt.includes("## Peer reviews") ? "**Verdict**: REQUEST_CHANGES" : "revised", isError: false, ms: 1 }; } });
    const out = await runToConvergence([peer], { prompt: "plan" }, { arbiter, maxRounds: 3 });
    assert.ok(out.rounds.length >= 2, `needs a second round to prove the point (got ${out.rounds.length})`);
    assert.ok(peerBudgets[1] < peerBudgets[0], `round 2 fan-out got less than round 1 (${peerBudgets[1]} vs ${peerBudgets[0]})`);
  });
});

// --- Journal tracing (Task 4: core/orchestrate.js instrumentation) --------------

/** A recording journal matching the Journal interface's shape. @returns {{journal:any, events:any[]}} */
function recordingJournal() {
  /** @type {any[]} */
  const events = [];
  const journal = {
    enabled: () => true,
    newRunId: () => "run-1",
    emit: (/** @type {string} */ id, /** @type {string} */ k, /** @type {any} */ f) => events.push({ id, k, f }),
    prune: () => {},
  };
  return { journal, events };
}

test("OT1: askAll emits call_start/call_end per provider, same runId, role from trace", async () => {
  const { journal, events } = recordingJournal();
  const trace = /** @type {any} */ ({ journal, runId: "run-1", role: "peer" });
  await askAll([fakeProvider("a"), fakeProvider("b")], { prompt: "hi" }, { trace });
  const starts = events.filter((e) => e.k === "call_start");
  const ends = events.filter((e) => e.k === "call_end");
  assert.equal(starts.length, 2);
  assert.equal(ends.length, 2);
  assert.ok(events.every((e) => e.id === "run-1"));
  assert.ok(starts.every((e) => e.f.role === "peer"));
  assert.notEqual(starts[0].f.callId, starts[1].f.callId);
  // call_start doesn't know the model yet; call_end carries both provider and model
  // (Task 4 fix round 1: model was dropped by the whitelist, provider was missing).
  assert.ok(starts.every((e) => e.f.model === null));
  const endA = ends.find((e) => e.f.provider === "a");
  assert.equal(endA.f.model, "m");
});

test("OT2: a retried call emits two call_start/call_end pairs with distinct callIds", async () => {
  const { journal, events } = recordingJournal();
  const trace = /** @type {any} */ ({ journal, runId: "run-1", role: "single" });
  const p = countingProvider([errResult({ errorKind: "network" }), okResult]);
  await askOne(p, { prompt: "x" }, { trace });
  const starts = events.filter((e) => e.k === "call_start");
  const ends = events.filter((e) => e.k === "call_end");
  assert.equal(starts.length, 2);
  assert.equal(ends.length, 2);
  assert.notEqual(starts[0].f.callId, starts[1].f.callId);
  assert.equal(ends[0].f.callId, starts[0].f.callId);
  assert.equal(ends[1].f.callId, starts[1].f.callId);
  assert.equal(ends[0].f.isError, true);
  assert.equal(ends[1].f.isError, false);
});

test("OT3: no trace -> no emits, and behavior is unchanged", async () => {
  const out = await askAll([fakeProvider("a"), fakeProvider("b")], { prompt: "hi" });
  assert.deepEqual(out.map((r) => r.provider), ["a", "b"]);
  const out2 = await askOne(fakeProvider("a"), { prompt: "hi" });
  assert.equal(/** @type {any} */ (out2).text, "a:hi");
});

test("OT4: runToConvergence converging in round 1 emits state sequence [blind, peers, adjudicate, converged]", async () => {
  const { journal, events } = recordingJournal();
  const trace = { journal, runId: "run-1" };
  const peer = /** @type {any} */ ({ name: "p", capabilities: {}, async health() { return { ok: true }; },
    async ask() { return { provider: "p", model: "m", text: "**Verdict**: APPROVE", isError: false, ms: 1 }; } });
  const arbiter = /** @type {any} */ ({ name: "arb", capabilities: {}, async health() { return { ok: true }; },
    async ask() { return { provider: "arb", model: "m", text: "**Verdict**: APPROVE", isError: false, ms: 1 }; } });
  await runToConvergence([peer], { prompt: "plan" }, { arbiter, trace, blindVote: true });
  const stateEvents = events.filter((e) => e.k === "state");
  assert.deepEqual(stateEvents.map((e) => e.f.state), ["blind", "peers", "adjudicate", "converged"]);
  assert.ok(stateEvents.every((e) => e.f.round === 1));
  // Non-terminal phase states fire on ENTRY, before the calls they describe -
  // so a live UI can show "now doing X" while a multi-minute fan-out is in flight.
  const peersIdx = events.findIndex((e) => e.k === "state" && e.f.state === "peers");
  const firstCallStartIdx = events.findIndex((e) => e.k === "call_start");
  assert.ok(peersIdx < firstCallStartIdx, "peers phase state fires before the peer/blind calls start, not after");
  const adjudicateIdx = events.findIndex((e) => e.k === "state" && e.f.state === "adjudicate");
  const adjudicationCallStartIdx = events.findIndex((e) => e.k === "call_start" && e.f.role === "arbiter");
  assert.ok(adjudicateIdx < adjudicationCallStartIdx, "adjudicate phase state fires before the adjudication call starts");
  // Per-peer verdicts ride the "adjudicate" event, categories only (no descriptions).
  const adjudicate = stateEvents.find((e) => e.f.state === "adjudicate");
  assert.deepEqual(adjudicate.f.verdicts, [{ provider: "p", verdict: "APPROVE", categories: [] }]);
});

test("OT5: a journal whose emit() throws does not fail askOne", async () => {
  const trace = /** @type {any} */ ({ journal: { enabled: () => true, newRunId: () => "run-1", emit: () => { throw new Error("boom"); }, prune: () => {} }, runId: "run-1", role: "single" });
  const r = await askOne(fakeProvider("a"), { prompt: "hi" }, { trace });
  assert.equal(/** @type {any} */ (r).text, "a:hi");
});

test("OT6: a traced cache hit emits call_start + call_end (ms from the hit); an untraced hit emits nothing", async () => {
  const cache = makeResultCache();
  const p = fakeProvider("a");
  await askOne(p, { prompt: "hi" }, { cache }); // primes the cache

  const { journal, events } = recordingJournal();
  // Untraced cache hit: no trace passed -> zero journal activity, even against
  // the same journal instance a traced call below WILL write to.
  const untracedHit = await askOne(p, { prompt: "hi" }, { cache });
  assert.equal(/** @type {any} */ (untracedHit).cached, true);
  assert.equal(events.length, 0);

  // Traced cache hit: call_start + call_end, ms taken from the hit (stamped 0 by
  // the cache itself - core/result-cache.js `set`).
  const trace = /** @type {any} */ ({ journal, runId: "run-1", role: "single" });
  const tracedHit = await askOne(p, { prompt: "hi" }, { cache, trace });
  assert.equal(/** @type {any} */ (tracedHit).cached, true);
  assert.equal(events.filter((e) => e.k === "call_start").length, 1);
  const end = events.find((e) => e.k === "call_end");
  assert.equal(end.f.ms, 0);
  assert.equal(end.f.provider, "a");
  assert.equal(end.f.isError, false);
});

test("OT7: consensus emits blind (when blindVote runs), peers, and synthesize state events, in order", async () => {
  const { journal, events } = recordingJournal();
  const trace = /** @type {any} */ ({ journal, runId: "run-1" });
  const { provider: arbiter } = blindAwareArbiter();
  await consensus([fakeProvider("a"), fakeProvider("b")], { prompt: "hi" }, { arbiter, blindVote: true, trace });
  const states = events.filter((e) => e.k === "state").map((e) => e.f.state);
  assert.deepEqual(states, ["blind", "peers", "synthesize"]);
});

test("OT7b: consensus without blindVote emits only peers and synthesize (no blind state)", async () => {
  const { journal, events } = recordingJournal();
  const trace = /** @type {any} */ ({ journal, runId: "run-1" });
  await consensus([fakeProvider("a"), fakeProvider("b")], { prompt: "hi" }, { trace });
  const states = events.filter((e) => e.k === "state").map((e) => e.f.state);
  assert.deepEqual(states, ["peers", "synthesize"]);
});

test("OT8: consensus with a trace still reports arbiter-failed when the arbiter throws (tracedAsk('throw') rethrows after tracing)", async () => {
  const { journal, events } = recordingJournal();
  const trace = /** @type {any} */ ({ journal, runId: "run-1" });
  const badArbiter = /** @type {any} */ ({ name: "arb", capabilities: {}, async health() { return { ok: true }; },
    async ask() { throw new Error("arbiter boom"); } });
  const out = await consensus([fakeProvider("a"), fakeProvider("b")], { prompt: "hi" }, { arbiter: badArbiter, trace });
  assert.equal(out.verdict, null);
  assert.equal(out.error, "arbiter-failed");
  // The failed verdict call is still traced: call_start + a call_end reporting the error.
  assert.equal(events.filter((e) => e.k === "call_start" && e.f.role === "arbiter").length, 1);
  const end = events.find((e) => e.k === "call_end" && e.f.provider === "arb");
  assert.equal(end.f.isError, true);
});

test("HBX7: with the host budget already spent, runToConvergence stops with budget-exhausted before any leg starts", async () => {
  await withHostCap("6000", async () => { // 6000 - 5000 = the floor: nothing usable from the first round on
    let calls = 0;
    const peer = /** @type {any} */ ({ name: "p", capabilities: {}, async health() { return { ok: true }; }, async ask() { calls++; return { provider: "p", model: "m", text: "VERDICT: APPROVE", isError: false, ms: 1 }; } });
    const arbiter = /** @type {any} */ ({ name: "arb", capabilities: {}, async health() { return { ok: true }; }, async ask() { calls++; return { provider: "arb", model: "m", text: "ok", isError: false, ms: 1 }; } });
    const out = await runToConvergence([peer], { prompt: "plan" }, { arbiter, maxRounds: 3 });
    assert.equal(out.converged, false);
    assert.equal(out.stopReason, "budget-exhausted");
    assert.equal(calls, 0, "no provider leg is started on a spent budget");
  });
});

// --- Request size + effective ceiling on call_start (dashboard analyzer) ---------------
/** A fake provider whose own configured timeout is `ms`. @param {string} name @param {number} ms @param {any} [caps] */
function timedProvider(name, ms, caps = {}) {
  return /** @type {any} */ ({
    ...fakeProvider(name),
    capabilities: { canImplement: false, fileUpload: false, multiTurn: false, ...caps },
    resolveSettings: (/** @type {any} */ req) => ({ timeoutMs: req.timeoutMs ?? ms }),
  });
}
const startsOf = (/** @type {any[]} */ events) => events.filter((e) => e.k === "call_start").map((e) => e.f);

test("OS1: a lone call is limited by its own timeout and records the request size", async () => {
  const { journal, events } = recordingJournal();
  await askOne(timedProvider("a", 5000), { prompt: "hello" }, { trace: /** @type {any} */ ({ journal, runId: "r", role: "single" }) });
  const [s] = startsOf(events);
  assert.equal(s.ceilingSource, "own");
  assert.ok(s.grantedMs > 4000 && s.grantedMs <= 5000);
  assert.equal(s.promptChars, 5);
  assert.equal(s.fileCount, 0);
  assert.equal(s.orientationFiles, 0);
  assert.equal(s.fileBytes, 0);
  assert.equal(s.hostCapMs, null);
});

test("OS2: a shared fan-out is attributed to the shared deadline, naming the longest SELECTED peer", async () => {
  const { journal, events } = recordingJournal();
  await askAll([timedProvider("fast", 2000), timedProvider("slow", 9000)], { prompt: "q" }, { trace: /** @type {any} */ ({ journal, runId: "r", role: "peer" }) });
  const starts = startsOf(events);
  assert.equal(starts.length, 2);
  for (const s of starts) {
    assert.equal(s.ceilingSource, "shared");
    assert.deepEqual(s.sharedBy, ["slow"]);
    assert.equal(s.sharedLimitMs, 9000);
    assert.ok(s.grantedMs > 8000);
  }
});

test("OS3: a caller deadline shorter than every peer makes the fan-out ceiling `outer`", async () => {
  const { journal, events } = recordingJournal();
  await askAll([timedProvider("a", 9000), timedProvider("b", 9000)], { prompt: "q", deadlineAt: Date.now() + 1500 }, { trace: /** @type {any} */ ({ journal, runId: "r", role: "peer" }) });
  for (const s of startsOf(events)) {
    assert.equal(s.ceilingSource, "outer");
    assert.ok(s.grantedMs <= 1500);
  }
});

test("OS4: a host cap below the provider timeout makes the ceiling `host` and records the cap", async () => {
  await withHostCap("8000", async () => {
    const { journal, events } = recordingJournal();
    await askOne(timedProvider("a", 60000), { prompt: "q" }, { trace: /** @type {any} */ ({ journal, runId: "r", role: "single" }) });
    const [s] = startsOf(events);
    assert.equal(s.ceilingSource, "host");
    assert.equal(s.hostCapMs, 8000);
    assert.ok(s.grantedMs <= 3000);
  });
});

test("OS5: file sizes: orientation counted, unknown or capped sizes are null, never partial", async () => {
  const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "os5-"));
  const f1 = path.join(dir, "a.txt"); fs.writeFileSync(f1, "12345");
  const f2 = path.join(dir, "b.txt"); fs.writeFileSync(f2, "123");
  const run = async (/** @type {any} */ req, /** @type {any} */ opts = {}, caps = {}) => {
    const { journal, events } = recordingJournal();
    await askOne(timedProvider("a", 5000, caps), req, { ...opts, trace: /** @type {any} */ ({ journal, runId: "r", role: "single" }) });
    return startsOf(events)[0];
  };
  const both = await run({ prompt: "q", files: [{ path: f1 }, { path: f2 }] });
  assert.equal(both.fileCount, 2);
  assert.equal(both.fileBytes, 8);
  assert.equal((await run({ prompt: "q", files: [{ path: f1 }, { dir }] })).fileBytes, null);
  assert.equal((await run({ prompt: "q", files: [{ path: path.join(dir, "missing") }] })).fileBytes, null);
  assert.equal((await run({ prompt: "q", files: Array.from({ length: 51 }, () => ({ path: f1 })) })).fileBytes, null);
  const oriented = await run({ prompt: "q" }, { orientationFiles: [{ path: f1 }] }, { walksFilesystem: false });
  assert.equal(oriented.orientationFiles, 1);
  assert.equal(oriented.fileCount, 1);
  assert.equal(oriented.fileBytes, 5);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("OS6: a retry records its own ceiling, still `own`", async () => {
  const { journal, events } = recordingJournal();
  const p = /** @type {any} */ ({ ...countingProvider([errResult({ errorKind: "network" }), okResult]), resolveSettings: (/** @type {any} */ req) => ({ timeoutMs: req.timeoutMs ?? 5000 }) });
  await askOne(p, { prompt: "x" }, { trace: /** @type {any} */ ({ journal, runId: "r", role: "single" }) });
  const starts = startsOf(events);
  assert.equal(starts.length, 2);
  assert.ok(starts.every((s) => s.ceilingSource === "own" && typeof s.grantedMs === "number"));
});

test("OS7: a cache hit carries size but no ceiling", async () => {
  const cache = makeResultCache();
  const p = timedProvider("a", 5000);
  await askOne(p, { prompt: "same" }, { cache });
  const { journal, events } = recordingJournal();
  await askOne(p, { prompt: "same" }, { cache, trace: /** @type {any} */ ({ journal, runId: "r", role: "single" }) });
  const [s] = startsOf(events);
  assert.equal(s.promptChars, 4);
  assert.ok(!("grantedMs" in s) || s.grantedMs === undefined);
  assert.ok(!s.ceilingSource);
});
