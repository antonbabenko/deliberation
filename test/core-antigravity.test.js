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

test("AG4: capabilities.canImplement is true", () => {
  assert.equal(makeAntigravityProvider({ bridge: fakeBridge }).capabilities.canImplement, true);
});
