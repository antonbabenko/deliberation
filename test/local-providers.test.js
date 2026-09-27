"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { validateConfig } = require("../server/openrouter/config.js");
const { makeRegistry, pinAlias, formatDelegateName } = require("../core/registry.js");
const { makeOpenAICompatibleProvider } = require("../core/providers/openai-compatible.js");
const { resolveDelegate } = require("../server/openrouter/index.js");
const { configLevers, leverFor } = require("../core/analyze.js");

test("LP1: validateConfig accepts ollama and lmstudio providers in models", () => {
  const raw = {
    version: 1,
    providers: {
      gemini: { enabled: true, model: "gemini-3.8-flash-high" },
      ollama: { enabled: true, apiBase: "http://localhost:11434/v1" },
      lmstudio: { enabled: true, apiBase: "http://localhost:1234/v1" },
    },
    models: {
      "nemotron-ultra": { provider: "ollama", model: "nemotron-3-ultra:cloud", askAll: true, consensus: true },
      "qwen-coder": { provider: "lmstudio", model: "qwen3-coder-next", askAll: true, consensus: true },
    },
  };
  const { ok, resolved, error } = validateConfig(raw);
  assert.equal(ok, true, error);
  assert.equal(resolved.openrouter.models.length, 2);
  assert.equal(resolved.openrouter.models[0].provider, "ollama");
  assert.equal(resolved.openrouter.models[1].provider, "lmstudio");
});

test("LP-B2: models: { x: null } lands in invalidModels without throwing", () => {
  const raw = {
    version: 1,
    models: {
      "valid-local": { provider: "ollama", model: "nemotron-local" },
      "broken-null": null,
      "broken-num": 123,
    },
  };
  const { ok, resolved } = validateConfig(raw);
  assert.equal(ok, true);
  assert.equal(resolved.openrouter.models.length, 1);
  assert.equal(resolved.openrouter.models[0].alias, "valid-local");
  assert.equal(resolved.openrouter.invalidModels.length, 2);
  assert.equal(resolved.openrouter.invalidModels[0].alias, "broken-null");
  assert.equal(resolved.openrouter.invalidModels[1].alias, "broken-num");
});

test("LP-B5: invalid local record is reported in invalidModels when OpenRouter is disabled", () => {
  const raw = {
    version: 1,
    providers: {
      openrouter: { enabled: false },
      ollama: { enabled: true },
    },
    models: {
      "good-ollama": { provider: "ollama", model: "nemotron-local" },
      "bad-ollama": { provider: "ollama" }, // missing model
    },
  };
  const { ok, resolved } = validateConfig(raw);
  assert.equal(ok, true);
  assert.equal(resolved.openrouter.invalidModels.length, 1);
  assert.equal(resolved.openrouter.invalidModels[0].alias, "bad-ollama");
});

test("LP-B1-B16: Gemini keeps name gemini, and formatDelegateName uses <provider>:<alias>", () => {
  const fakeGemini = {
    name: "gemini",
    model: "gemini-3.8-flash-high",
    capabilities: {},
    async health() { return { ok: true }; },
    async ask() { return { provider: "gemini", model: "gemini-3.8-flash-high", text: "ok", isError: false, ms: 10 }; },
  };
  const fakeOllama = {
    name: "ollama",
    capabilities: {},
    async health() { return { ok: true }; },
    async ask(req) { return { provider: "ollama", model: req.model, text: "ok", isError: false, ms: 10 }; },
  };
  const reg = makeRegistry([fakeGemini, fakeOllama]);
  const cfg = {
    providers: {
      gemini: { enabled: true },
      ollama: { enabled: true },
    },
    openrouter: {
      models: [
        { alias: "local-endpoint-1", provider: "ollama", model: "llama3.3:70b", askAll: true },
        { alias: "local-endpoint-2", provider: "ollama", model: "llama3.3:70b", askAll: true },
      ],
    },
  };
  const { providers } = reg.selectForAskAll({ config: cfg, expert: "architect" });
  assert.deepEqual(
    providers.map((p) => p.name),
    ["gemini", "ollama:local-endpoint-1", "ollama:local-endpoint-2"]
  );
  assert.equal(reg.get("gemini").name, "gemini");
  assert.equal(formatDelegateName(cfg.openrouter.models[0]), "ollama:local-endpoint-1");
});

test("LP-B13a-B14: standalone openrouter bridge rejects non-openrouter models and guards apiKey", () => {
  process.env.OPENROUTER_API_KEY = "sk-or-v1-secret-token";
  const orConfig = {
    allowRawModel: false,
    apiKeyEnv: "OPENROUTER_API_KEY",
    apiBase: "https://openrouter.ai/api/v1",
    models: [
      { alias: "claude-or", provider: "openrouter", model: "anthropic/claude-3.7-sonnet" },
      { alias: "ollama-local", provider: "ollama", model: "llama3.3" },
      { alias: "custom-endpoint", provider: "openrouter", model: "custom-slug", apiBase: "http://127.0.0.1:9999/v1" },
    ],
  };
  const orDelegate = resolveDelegate(orConfig, { alias: "claude-or" });
  assert.equal(orDelegate.model, "anthropic/claude-3.7-sonnet");

  const localDelegate = resolveDelegate(orConfig, { alias: "ollama-local" });
  assert.deepEqual(localDelegate, { _error: "model-not-allowed" });

  const customDelegate = resolveDelegate(orConfig, { alias: "custom-endpoint" });
  assert.equal(customDelegate.model, "custom-slug");
  const targetApiBase = customDelegate.apiBase || orConfig.apiBase;
  const targetApiKey = customDelegate.apiKey !== undefined
    ? customDelegate.apiKey
    : customDelegate.apiKeyEnv
      ? process.env[customDelegate.apiKeyEnv]
      : targetApiBase === orConfig.apiBase
        ? process.env[orConfig.apiKeyEnv]
        : undefined;
  assert.equal(targetApiKey, undefined, "standalone bridge does not leak OPENROUTER_API_KEY to custom apiBase");
  delete process.env.OPENROUTER_API_KEY;
});

test("LP-B13b: keyless local endpoints send no Authorization header and do not leak OPENROUTER_API_KEY", async () => {
  process.env.OPENROUTER_API_KEY = "sk-or-v1-secret-token";
  let capturedUrl = null;
  let capturedKey = null;

  const mockBridge = {
    inlineFiles: () => ({ blocks: [], notes: [] }),
    buildInitialTurns: (_inst, prompt) => [{ role: "user", text: prompt }],
    buildMessages: (turns) => turns,
    classifyError: () => ({ errorKind: "unknown", retryable: false }),
    callOpenRouter: async ({ apiBase, apiKey }) => {
      capturedUrl = apiBase;
      capturedKey = apiKey;
      return { text: "mock response" };
    },
  };

  const ollamaProvider = makeOpenAICompatibleProvider({
    name: "ollama",
    apiBase: "http://127.0.0.1:11434/v1",
    apiKeyEnv: "",
    resolveModel: (r) => r.model,
    bridge: mockBridge,
  });

  await ollamaProvider.ask({ prompt: "hello", model: "llama3" });
  assert.equal(capturedUrl, "http://127.0.0.1:11434/v1");
  assert.equal(capturedKey, undefined, "no OPENROUTER_API_KEY must be sent to local endpoint");

  const lmstudioProvider = makeOpenAICompatibleProvider({
    name: "lmstudio",
    apiBase: "http://127.0.0.1:1234/v1",
    apiKeyEnv: "",
    resolveModel: (r) => r.model,
    bridge: mockBridge,
  });

  await lmstudioProvider.ask({ prompt: "hello", model: "custom-local" });
  assert.equal(capturedUrl, "http://127.0.0.1:1234/v1");
  assert.equal(capturedKey, undefined, "lmstudio local endpoint must not send OPENROUTER_API_KEY");

  delete process.env.OPENROUTER_API_KEY;
});

test("LP-B4-B6: pinAlias pins to target provider and ask-one dispatches from active panel", async () => {
  const fakeOllama = {
    name: "ollama",
    capabilities: {},
    async health() { return { ok: true }; },
    async ask(req) { return { provider: "ollama", model: req.model, text: "ok", isError: false, ms: 10 }; },
  };
  const reg = makeRegistry([fakeOllama]);
  const cfg = {
    providers: { ollama: { enabled: true } },
    openrouter: {
      models: [
        { alias: "local-arb", provider: "ollama", model: "deepseek-r1", askAll: false, consensus: true },
      ],
    },
  };
  const delegate = cfg.openrouter.models[0];
  const pinned = pinAlias(reg.get("ollama"), delegate, cfg);
  assert.equal(pinned.name, "ollama:local-arb");
  const res = await pinned.ask({ prompt: "test" });
  assert.equal(res.provider, "ollama:local-arb");
});

test("LP-B8: configLevers maps by alias only, not model slug, and leverFor identifies local models", () => {
  const config = {
    openrouter: {
      enabled: true,
      models: [
        { alias: "my-alias", model: "llama3.3" },
        { alias: "other-alias", model: "my-alias" },
      ],
    },
  };
  const levers = configLevers(config);
  assert.equal(levers.byAlias.get("my-alias").model, "llama3.3");
  assert.equal(levers.byAlias.get("other-alias").model, "my-alias");
  assert.equal(levers.byAlias.has("llama3.3"), false, "slug must not be keyed in byAlias");

  const ollamaLever = leverFor("ollama:my-alias");
  assert.equal(ollamaLever.kind, "local");
  assert.equal(ollamaLever.alias, "my-alias");

  const lmstudioLever = leverFor("lmstudio:my-alias");
  assert.equal(lmstudioLever.kind, "local");
  assert.equal(lmstudioLever.alias, "my-alias");
});

test("LP-B9: providers.ollama.timeout applies when delegate.timeout is unset", async () => {
  let askedTimeout = null;
  const mockBaseProvider = {
    name: "ollama",
    capabilities: {},
    async health() { return { ok: true }; },
    async ask(req) { askedTimeout = req.timeoutMs; return { provider: "ollama", model: req.model, text: "ok", isError: false, ms: 10 }; },
  };
  const cfg = {
    providers: {
      ollama: { enabled: true, timeout: 45000 },
    },
  };
  const delegate = { alias: "local-mod", provider: "ollama", model: "llama3" };
  const pinned = pinAlias(mockBaseProvider, delegate, cfg);
  await pinned.ask({ prompt: "hi" });
  assert.equal(askedTimeout, 45000);
});

test("LP3: validateConfig accepts models with colons, dots, and slashes in model slugs", () => {
  const raw = {
    version: 1,
    models: {
      "nemotron-ultra": { provider: "ollama", model: "nemotron-3-ultra:cloud" },
      "glm-cloud": { provider: "ollama", model: "glm-5.3:cloud" },
      "custom-v1": { provider: "lmstudio", model: "custom/model:v1.0" },
    },
  };
  const { ok, resolved, error } = validateConfig(raw);
  assert.equal(ok, true, error);
  assert.equal(resolved.openrouter.models.length, 3);
  assert.equal(resolved.openrouter.models[0].model, "nemotron-3-ultra:cloud");
  assert.equal(resolved.openrouter.models[1].model, "glm-5.3:cloud");
  assert.equal(resolved.openrouter.models[2].model, "custom/model:v1.0");
});
