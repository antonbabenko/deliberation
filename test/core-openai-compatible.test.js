// test/core-openai-compatible.test.js
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { makeOpenAICompatibleProvider, MAX_SESSIONS } = require("../core/providers/openai-compatible.js");

const fakeBridge = {
  callOpenRouter: async (/** @type {any} */ { model }) => ({ text: `reply from ${model}` }),
  classifyError: (/** @type {any} */ status) => ({ errorKind: status === 401 ? "auth" : "unknown", retryable: false }),
  buildMessages: (/** @type {any} */ turns) => turns,
  buildInitialTurns: (/** @type {any} */ sys, /** @type {any} */ prompt) => [{ role: "system", text: sys }, { role: "user", text: prompt }],
};

test("OC1: ask returns a success DelegationResult with resolved model + threadId", async () => {
  process.env.FAKE_KEY = "k";
  const p = makeOpenAICompatibleProvider({ name: "openrouter", apiBase: "http://x", apiKeyEnv: "FAKE_KEY",
    resolveModel: () => "deepseek/deepseek-v4-pro", bridge: fakeBridge });
  const r = await p.ask({ prompt: "hi", developerInstructions: "be brief" });
  assert.equal(r.isError, false);
  assert.equal(r.provider, "openrouter");
  assert.equal(r.model, "deepseek/deepseek-v4-pro");
  assert.equal(r.text, "reply from deepseek/deepseek-v4-pro");
  assert.ok(r.threadId);
});

test("OC2: health is false when the api key env is unset", async () => {
  delete process.env.FAKE_KEY;
  const p = makeOpenAICompatibleProvider({ name: "openrouter", apiBase: "http://x", apiKeyEnv: "FAKE_KEY", resolveModel: () => "m", bridge: fakeBridge });
  assert.equal((await p.health()).ok, false);
});

test("OC3: a thrown bridge call becomes a normalized error result", async () => {
  process.env.FAKE_KEY = "k";
  const throwing = { ...fakeBridge, callOpenRouter: async () => { const e = /** @type {any} */ (new Error("nope")); e.status = 401; throw e; } };
  const p = makeOpenAICompatibleProvider({ name: "openrouter", apiBase: "http://x", apiKeyEnv: "FAKE_KEY", resolveModel: () => "m", bridge: throwing });
  const r = await p.ask({ prompt: "x" });
  assert.equal(r.isError, true);
  assert.equal(r.errorKind, "auth");
});

test("OC4: the session map is bounded at MAX_SESSIONS across many fresh calls", async () => {
  process.env.FAKE_KEY = "k";
  const p = makeOpenAICompatibleProvider({ name: "openrouter", apiBase: "http://x", apiKeyEnv: "FAKE_KEY",
    resolveModel: () => "m", bridge: fakeBridge });
  for (let i = 0; i < MAX_SESSIONS + 25; i++) {
    const r = await p.ask({ prompt: `q${i}` }); // each fresh call -> new threadId
    assert.ok(/** @type {any} */ (r).threadId);
  }
  assert.equal(/** @type {any} */ (p).__sessionCount, MAX_SESSIONS);
});

// Regression for the OpenRouter file-blind bug: attached files must be inlined as
// TEXT blocks before the turns are built, or buildMessages string-coerces the raw
// { path } objects to "[object Object]" and the model sees no file contents.
test("OC5: attached files are inlined as text blocks (no [object Object])", async () => {
  process.env.FAKE_KEY = "k";
  let captured = /** @type {any} */ (null);
  const recording = {
    classifyError: fakeBridge.classifyError,
    // Mirror the real bridge: inlineFiles turns { path } objects into text strings.
    inlineFiles: (/** @type {any} */ files) => ({ blocks: files.map((/** @type {any} */ f) => `=== ${f.path} ===\nFILE_BODY_${f.path}`) }),
    buildInitialTurns: (/** @type {any} */ sys, /** @type {any} */ prompt, /** @type {any} */ blocks) =>
      [{ role: "system", text: sys }, { role: "user", text: prompt, inlineBlocks: blocks || [] }],
    // Mirror the real buildMessages join so the [object Object] coercion would surface.
    buildMessages: (/** @type {any} */ turns) => turns.map((/** @type {any} */ t) =>
      (t.role === "user" && Array.isArray(t.inlineBlocks) && t.inlineBlocks.length)
        ? { role: "user", content: [t.text, ...t.inlineBlocks].join("\n\n") }
        : { role: t.role, content: t.text }),
    callOpenRouter: async (/** @type {any} */ { messages }) => { captured = messages; return { text: "ok" }; },
  };
  const p = makeOpenAICompatibleProvider({ name: "openrouter", apiBase: "http://x", apiKeyEnv: "FAKE_KEY",
    resolveModel: () => "m", bridge: recording });
  const r = await p.ask({ prompt: "review", files: [{ path: "a.js" }], cwd: "/tmp" });
  assert.equal(r.isError, false);
  const user = captured.find((/** @type {any} */ m) => m.role === "user");
  assert.match(user.content, /FILE_BODY_a\.js/); // real file text reached the payload
  assert.doesNotMatch(user.content, /\[object Object\]/); // the bug is gone
});

test("OC6: a throwing inlineFiles becomes a config error result, not a crash", async () => {
  process.env.FAKE_KEY = "k";
  const throwing = { ...fakeBridge, inlineFiles: () => { throw new Error("per-file cap exceeded"); } };
  const p = makeOpenAICompatibleProvider({ name: "openrouter", apiBase: "http://x", apiKeyEnv: "FAKE_KEY",
    resolveModel: () => "m", bridge: throwing });
  const r = await p.ask({ prompt: "x", files: [{ path: "big.bin" }] });
  assert.equal(r.isError, true);
  assert.equal(r.errorKind, "config");
});

test("OC7: inlineFiles skip notes are surfaced in the result text (no silent drop)", async () => {
  process.env.FAKE_KEY = "k";
  const withNotes = { ...fakeBridge, inlineFiles: () => ({ blocks: [], notes: ["big.bin: skipped (binary)"] }) };
  const p = makeOpenAICompatibleProvider({ name: "openrouter", apiBase: "http://x", apiKeyEnv: "FAKE_KEY",
    resolveModel: () => "m", bridge: withNotes });
  const r = await p.ask({ prompt: "x", files: [{ path: "big.bin" }] });
  assert.equal(r.isError, false);
  assert.match(r.text, /\[files\] big\.bin: skipped \(binary\)/);
});
