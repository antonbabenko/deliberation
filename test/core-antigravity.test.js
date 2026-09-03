// test/core-antigravity.test.js
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { makeAntigravityProvider } = require("../core/providers/antigravity.js");

const fakeBridge = {
  buildAgyArgs: (/** @type {any} */ req) => ["--model", req.model || "auto-gemini-3", req.prompt],
  runGemini: async () => ({ response: "gemini reply", threadId: "g-1", recovered: false }),
  classifyGeminiError: () => ({ errorKind: "timeout", retryable: true }),
};

test("AG1: ask maps a clean run (response -> text) to a success result", async () => {
  const r = await makeAntigravityProvider({ bridge: fakeBridge }).ask({ prompt: "hi", cwd: "/tmp" });
  assert.equal(r.isError, false);
  assert.equal(r.provider, "gemini");
  assert.equal(r.text, "gemini reply");
  assert.equal(r.threadId, "g-1");
});

test("AG1b: pinDropped reports the effective model source, not the rejected pin", async () => {
  // The bridge re-ran on agy's settings.json default after agy rejected the shipped alias;
  // reporting "auto-gemini-3" here would name a model that never ran (issue #180 review).
  const dropped = { ...fakeBridge, runGemini: async () => ({ response: "ok", threadId: "g-3", pinDropped: true }) };
  const r = await makeAntigravityProvider({ bridge: dropped, model: "auto-gemini-3" }).ask({ prompt: "x", cwd: "/tmp" });
  assert.equal(r.isError, false);
  assert.equal(r.model, "agy-settings-default");
  const kept = await makeAntigravityProvider({ bridge: fakeBridge, model: "gemini-3.1-pro-low" }).ask({ prompt: "x", cwd: "/tmp" });
  assert.equal(kept.model, "gemini-3.1-pro-low", "an honoured pin is reported as-is");
});

test("AG2: recovered:true is still a success (drain), not an error", async () => {
  const recov = { ...fakeBridge, runGemini: async () => ({ response: "late", threadId: "g-2", recovered: true }) };
  const r = await makeAntigravityProvider({ bridge: recov }).ask({ prompt: "x", cwd: "/tmp" });
  assert.equal(r.isError, false);
  assert.equal(r.text, "late");
});

test("AG3: thrown runGemini classifies from the real message, not an empty string", async () => {
  // Mirror the message-keyed branches of the real classifyGeminiError so this
  // test fails if the adapter ever hardcodes "" again (which silences missing-cli).
  const classifyGeminiError = (/** @type {any} */ errMsg, /** @type {any} */ errCode) => {
    const msg = String(errMsg || "");
    const lower = msg.toLowerCase();
    if (errCode === "timeout") return { errorKind: "timeout", retryable: true };
    if (msg.includes("(agy) not found")) return { errorKind: "missing-cli", retryable: false };
    if (lower.includes("aborterror") || lower.includes("aborted")) return { errorKind: "upstream-abort", retryable: true };
    return { errorKind: "unknown", retryable: false };
  };
  const throwing = {
    ...fakeBridge,
    classifyGeminiError,
    runGemini: async () => { throw new Error("Antigravity CLI (agy) not found. Install from ..."); },
  };
  const r = await makeAntigravityProvider({ bridge: throwing }).ask({ prompt: "x", cwd: "/tmp" });
  assert.equal(r.isError, true);
  assert.equal(r.errorKind, "missing-cli"); // would be "unknown" if message were dropped
});

test("AG4: capabilities.canImplement reflects the construction lock (default off)", () => {
  assert.equal(makeAntigravityProvider({ bridge: fakeBridge }).capabilities.canImplement, false);
  assert.equal(makeAntigravityProvider({ bridge: fakeBridge, allowImplement: true }).capabilities.canImplement, true);
});

// Capturing bridge: records the sandbox passed to buildAgyArgs and the readOnly opt to runGemini.
function captureBridge() {
  const seen = { sandbox: undefined, readOnly: undefined };
  return {
    seen,
    bridge: {
      buildAgyArgs: (/** @type {any} */ req) => { seen.sandbox = req.sandbox; return ["--model", req.model, req.prompt]; },
      runGemini: async (/** @type {any} */ _a, /** @type {any} */ _c, /** @type {any} */ _t, /** @type {any} */ _g, /** @type {any} */ o) => { seen.readOnly = o.readOnly; return { response: "ok", threadId: "g", recovered: false }; },
      classifyGeminiError: () => ({ errorKind: "unknown", retryable: false }),
    },
  };
}

test("AG-gate-default: no lock, no mode -> sandbox read-only, runGemini readOnly:true", async () => {
  const { seen, bridge } = captureBridge();
  await makeAntigravityProvider({ bridge }).ask({ prompt: "x", cwd: "/tmp" });
  assert.equal(seen.sandbox, "read-only");
  assert.equal(seen.readOnly, true);
});

test("AG-gate-deny: req.mode 'implement' WITHOUT the construction lock stays read-only", async () => {
  const { seen, bridge } = captureBridge();
  await makeAntigravityProvider({ bridge }).ask({ prompt: "x", cwd: "/tmp", mode: "implement" });
  assert.equal(seen.sandbox, "read-only");
  assert.equal(seen.readOnly, true);
});

test("AG-gate-open: both locks -> sandbox workspace-write, runGemini readOnly:false", async () => {
  const { seen, bridge } = captureBridge();
  const p = makeAntigravityProvider({ bridge, allowImplement: true });
  await p.ask({ prompt: "x", cwd: "/tmp", mode: "implement" });
  assert.equal(seen.sandbox, "workspace-write");
  assert.equal(seen.readOnly, false);
  // lock on, but no mode -> back to read-only
  await p.ask({ prompt: "x", cwd: "/tmp" });
  assert.equal(seen.sandbox, "read-only");
  assert.equal(seen.readOnly, true);
});

test("AG5: capabilities.walksFilesystem is true (Gemini walks cwd under read-only sandbox)", () => {
  assert.equal(makeAntigravityProvider({ bridge: fakeBridge }).capabilities.walksFilesystem, true);
});

test("AG-timeout-1: opts.timeoutMs is the construction default; req.timeoutMs still wins", async () => {
  let seen;
  const capturing = { ...fakeBridge, runGemini: async (/** @type {any} */ _a, /** @type {any} */ _cwd, /** @type {any} */ t) => { seen = t; return { response: "ok", threadId: "g" }; } };
  const p = makeAntigravityProvider({ bridge: capturing, timeoutMs: 600000 });
  await p.ask({ prompt: "hi", cwd: "/tmp" });
  assert.equal(seen, 600000, "construction default is applied");
  await p.ask({ prompt: "hi", cwd: "/tmp", timeoutMs: 9000 });
  assert.equal(seen, 9000, "per-call value wins");
});

test("AG-timeout-2: no configured timeout injects undefined so the bridge default applies", async () => {
  let seen = "unset";
  const capturing = { ...fakeBridge, runGemini: async (/** @type {any} */ _a, /** @type {any} */ _cwd, /** @type {any} */ t) => { seen = t; return { response: "ok", threadId: "g" }; } };
  await makeAntigravityProvider({ bridge: capturing }).ask({ prompt: "hi", cwd: "/tmp" });
  assert.equal(seen, undefined, "undefined, not 0 - a falsy value would read as no timeout");
});
