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
