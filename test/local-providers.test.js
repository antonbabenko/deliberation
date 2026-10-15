"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { validateConfig } = require("../server/openrouter/config.js");
const { makeRegistry, pinAlias, formatDelegateName } = require("../core/registry.js");
const { makeOpenAICompatibleProvider } = require("../core/providers/openai-compatible.js");
const { resolveDelegate, resolveEffectiveAuth, callOpenRouter } = require("../server/openrouter/index.js");
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

test("LP-B1-B16: OpenRouter delegates named openrouter:<alias>, Gemini keeps gemini, formatDelegateName uses <provider>:<alias>", () => {
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
  const fakeOpenRouter = {
    name: "openrouter",
    capabilities: {},
    async health() { return { ok: true }; },
    async ask(req) { return { provider: "openrouter", model: req.model, text: "ok", isError: false, ms: 10 }; },
  };
  const reg = makeRegistry([fakeGemini, fakeOllama, fakeOpenRouter]);
  const cfg = {
    providers: {
      gemini: { enabled: true },
      ollama: { enabled: true },
      openrouter: { enabled: true },
    },
    openrouter: {
      models: [
        { alias: "local-endpoint-1", provider: "ollama", model: "llama3.3:70b", askAll: true },
        { alias: "claude-or", provider: "openrouter", model: "anthropic/claude-3.7-sonnet", askAll: true },
      ],
    },
  };
  const { providers } = reg.selectForAskAll({ config: cfg, expert: "architect" });
  assert.deepEqual(
    providers.map((p) => p.name),
    ["gemini", "ollama:local-endpoint-1", "openrouter:claude-or"]
  );
  assert.equal(reg.get("gemini").name, "gemini");
  assert.equal(formatDelegateName(cfg.openrouter.models[0]), "ollama:local-endpoint-1");
  assert.equal(formatDelegateName(cfg.openrouter.models[1]), "openrouter:claude-or");
});

test("LP-B13a-B14: standalone openrouter bridge rejects non-openrouter models", () => {
  const orConfig = {
    allowRawModel: false,
    apiKeyEnv: "OPENROUTER_API_KEY",
    apiBase: "https://openrouter.ai/api/v1",
    models: [
      { alias: "claude-or", provider: "openrouter", model: "anthropic/claude-3.7-sonnet" },
      { alias: "ollama-local", provider: "ollama", model: "llama3.3" },
      { alias: "lmstudio-local", provider: "lmstudio", model: "qwen" },
    ],
  };
  const orDelegate = resolveDelegate(orConfig, { alias: "claude-or" });
  assert.equal(orDelegate.model, "anthropic/claude-3.7-sonnet");

  const localOllama = resolveDelegate(orConfig, { alias: "ollama-local" });
  assert.deepEqual(localOllama, { _error: "model-not-allowed" });

  const localLmStudio = resolveDelegate(orConfig, { alias: "lmstudio-local" });
  assert.deepEqual(localLmStudio, { _error: "model-not-allowed" });
});

test("LP-B13b: keyless local endpoints send no Authorization header", async () => {
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
  const pinned = pinAlias(reg.get("ollama"), delegate, cfg.openrouter.defaults, cfg);
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
  const pinned = pinAlias(mockBaseProvider, delegate, undefined, cfg);
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

// --- Regression tests for review blockers 1-5 ---

test("LP-R1: unknown-provider delegate is not dispatched and appears in unavailable", () => {
  const fakeGemini = {
    name: "gemini",
    capabilities: {},
    async health() { return { ok: true }; },
    async ask() { return { provider: "gemini", model: "gemini", text: "ok", isError: false, ms: 10 }; },
  };
  const reg = makeRegistry([fakeGemini]); // no openrouter, no mystery
  const cfg = {
    providers: { gemini: { enabled: true } },
    openrouter: {
      models: [
        { alias: "mystery-mod", provider: "mystery", model: "m-1", askAll: true },
      ],
    },
  };
  const { providers, unavailable } = reg.selectForAskAll({ config: cfg, expert: "architect" });
  assert.deepEqual(providers.map((p) => p.name), ["gemini"]);
  assert.equal(unavailable.length, 1);
  assert.equal(unavailable[0].name, "mystery:mystery-mod");
  assert.match(unavailable[0].reason, /provider ["']mystery["'] is not registered/);
});

test("LP-R2: unknown-provider explicit arbiter is not dispatched, warns, auto-selects, and errors when pool empty", async () => {
  const { buildServer } = require("../server/mcp/index.js");

  const fakeCodex = {
    name: "codex",
    capabilities: {},
    async health() { return { ok: true }; },
    async ask() { return { provider: "codex", model: "gpt-5", text: "consensus verdict", isError: false, ms: 1 }; },
  };

  // Case A: Pool has healthy provider (fakeCodex); unknown-provider arbiter model degrades to auto with warning
  const cfgWithCodex = () => ({
    providers: { codex: { enabled: true } },
    openrouter: {
      maxFanout: 3,
      models: [
        { alias: "unreg-arb", provider: "unregistered", model: "unreg-slug", consensus: true },
      ],
    },
    consensus: { arbiter: { model: "unreg-arb" } },
    consensusWarnings: [],
  });

  const serverA = buildServer({
    providers: [fakeCodex],
    getConfig: cfgWithCodex,
  });

  const resA = await serverA.handle({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "consensus", arguments: { prompt: "Q", synthesizeAlways: true, expert: "architect" } },
  });
  const payloadA = JSON.parse(resA.result.content[0].text);
  assert.equal(payloadA.arbiter.mode, "server");
  assert.equal(payloadA.arbiter.provider, "codex");
  assert.ok(payloadA.warnings.some((w) => /is not available/.test(w)));

  // Case B: Pool is empty; returns error without dispatch
  const cfgEmptyPool = () => ({
    providers: { codex: { enabled: false } },
    openrouter: {
      maxFanout: 3,
      models: [
        { alias: "unreg-arb", provider: "unregistered", model: "unreg-slug", consensus: true },
      ],
    },
    consensus: { arbiter: { model: "unreg-arb" } },
    consensusWarnings: [],
  });

  const serverB = buildServer({
    providers: [fakeCodex],
    getConfig: cfgEmptyPool,
  });

  const resB = await serverB.handle({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "consensus", arguments: { prompt: "Q", synthesizeAlways: true, expert: "architect" } },
  });
  const payloadB = JSON.parse(resB.result.content[0].text);
  assert.equal(payloadB.error, "all-providers-failed");
  assert.equal(payloadB.opinions.length, 0);
  assert.ok(payloadB.warnings.some((w) => /is not available/.test(w)));
});

test("LP-R3: unified-server warning for ignored record fields and apiKeyEnv validation", () => {
  // apiKeyEnv must be a non-empty string; invalid values land in invalidModels
  const rawInvalid = {
    version: 1,
    models: {
      "bad-env-type": { provider: "openrouter", model: "m1", apiKeyEnv: 123 },
      "empty-env": { provider: "openrouter", model: "m2", apiKeyEnv: "   " },
    },
  };
  const { ok, resolved } = validateConfig(rawInvalid);
  assert.equal(ok, true);
  assert.equal(resolved.openrouter.invalidModels.length, 2);
  assert.equal(resolved.openrouter.invalidModels[0].alias, "bad-env-type");
  assert.equal(resolved.openrouter.invalidModels[1].alias, "empty-env");

  // Models with apiBase or apiKeyEnv generate unified server warnings
  const rawIgnored = {
    version: 1,
    models: {
      "custom-bridge": { provider: "openrouter", model: "m3", apiBase: "http://proxy/v1", apiKeyEnv: "MY_KEY" },
    },
  };
  const validated = validateConfig(rawIgnored);
  assert.ok(validated.resolved.consensusWarnings.some((w) => /ignored by unified server/i.test(w)));
});

test("LP-R4: standalone bridge auth rules 1-3 (apiKeyEnv, trailing slash, non-default or.apiKeyEnv)", () => {
  const orConfig = {
    apiBase: "https://openrouter.ai/api/v1",
    apiKeyEnv: "OPENROUTER_API_KEY",
  };
  process.env.OPENROUTER_API_KEY = "or-provider-key-123";
  process.env.CUSTOM_KEY = "custom-key-456";

  // Rule 1: apiKeyEnv set on record -> uses that env var
  const rec1 = { provider: "openrouter", model: "m", apiBase: "http://custom-proxy/v1", apiKeyEnv: "CUSTOM_KEY" };
  const auth1 = resolveEffectiveAuth(rec1, orConfig);
  assert.equal(auth1.apiBase, "http://custom-proxy/v1");
  assert.equal(auth1.apiKeyEnv, "CUSTOM_KEY");
  assert.equal(auth1.apiKey, "custom-key-456");

  // Rule 1 unset: when named env var is unset/empty, sends no key; never falls through to provider key
  delete process.env.UNSET_KEY;
  const rec1b = { provider: "openrouter", model: "m", apiBase: "http://custom-proxy/v1", apiKeyEnv: "UNSET_KEY" };
  const auth1b = resolveEffectiveAuth(rec1b, orConfig);
  assert.equal(auth1b.apiKey, "", "unset apiKeyEnv must result in empty apiKey, never fall through");

  // Rule 2: record has no apiBase -> uses provider key
  const rec2 = { provider: "openrouter", model: "m" };
  const auth2 = resolveEffectiveAuth(rec2, orConfig);
  assert.equal(auth2.apiBase, "https://openrouter.ai/api/v1");
  assert.equal(auth2.apiKeyEnv, "OPENROUTER_API_KEY");
  assert.equal(auth2.apiKey, "or-provider-key-123");

  // Rule 2 trailing slash: record apiBase equals or.apiBase after stripping slashes -> uses provider key
  const rec2Slash = { provider: "openrouter", model: "m", apiBase: "https://openrouter.ai/api/v1///" };
  const auth2Slash = resolveEffectiveAuth(rec2Slash, orConfig);
  assert.equal(auth2Slash.apiKeyEnv, "OPENROUTER_API_KEY");
  assert.equal(auth2Slash.apiKey, "or-provider-key-123");

  // Rule 2 non-default or.apiKeyEnv
  process.env.ALT_OR_KEY = "alt-key-789";
  const orAlt = { apiBase: "https://openrouter.ai/api/v1", apiKeyEnv: "ALT_OR_KEY" };
  const auth2Alt = resolveEffectiveAuth(rec2, orAlt);
  assert.equal(auth2Alt.apiKeyEnv, "ALT_OR_KEY");
  assert.equal(auth2Alt.apiKey, "alt-key-789");

  // Rule 3: Otherwise (custom apiBase without apiKeyEnv) -> send no key
  const rec3 = { provider: "openrouter", model: "m", apiBase: "http://local-proxy:8080/v1" };
  const auth3 = resolveEffectiveAuth(rec3, orConfig);
  assert.equal(auth3.apiBase, "http://local-proxy:8080/v1");
  assert.equal(auth3.apiKeyEnv, null);
  assert.equal(auth3.apiKey, "");

  delete process.env.OPENROUTER_API_KEY;
  delete process.env.CUSTOM_KEY;
  delete process.env.ALT_OR_KEY;
});

test("LP-R5-R8: standalone bridge replies reuse stored session values, handle config edits, and re-resolve on alias change", async () => {
  const { spawn } = require("node:child_process");
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const BRIDGE = path.resolve(__dirname, "../server/openrouter/index.js");

  // Spin up two mock HTTP servers: one for OpenRouter, one for a custom proxy
  const receivedOr = [];
  const serverOr = http.createServer((req, res) => {
    receivedOr.push({ url: req.url, headers: req.headers });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "or-reply" } }] }));
  });
  await new Promise((r) => serverOr.listen(0, "127.0.0.1", r));
  const orPort = serverOr.address().port;
  const orUrl = `http://127.0.0.1:${orPort}/v1`;

  const receivedProxy = [];
  const serverProxy = http.createServer((req, res) => {
    receivedProxy.push({ url: req.url, headers: req.headers });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "proxy-reply" } }] }));
  });
  await new Promise((r) => serverProxy.listen(0, "127.0.0.1", r));
  const proxyPort = serverProxy.address().port;
  const proxyUrl = `http://127.0.0.1:${proxyPort}/v1`;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "delib-lp-test-"));
  const cfgFile = path.join(tmpDir, "config.json");
  const writeCfg = (cfg) => fs.writeFileSync(cfgFile, JSON.stringify(cfg));

  const initialConfig = {
    version: 1,
    providers: {
      openrouter: {
        enabled: true,
        apiBase: orUrl,
        apiKeyEnv: "TEST_OR_KEY",
      },
    },
    models: {
      "model-or": { provider: "openrouter", model: "or-slug" },
      "model-proxy": { provider: "openrouter", model: "proxy-slug", apiBase: proxyUrl, apiKeyEnv: "TEST_PROXY_KEY" },
      "model-other": { provider: "openrouter", model: "other-slug" },
    },
  };
  writeCfg(initialConfig);

  const env = {
    ...process.env,
    DELIBERATION_CONFIG: cfgFile,
    TEST_OR_KEY: "test-or-key-abc",
    TEST_PROXY_KEY: "test-proxy-key-xyz",
  };
  const child = spawn(process.execPath, [BRIDGE], { env, stdio: ["pipe", "pipe", "pipe"] });

  let buf = "";
  const waiters = new Map();
  child.stdout.on("data", (d) => {
    buf += d.toString();
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let m;
      try { m = JSON.parse(line); } catch (_) { continue; }
      if (m.id !== undefined && waiters.has(m.id)) {
        waiters.get(m.id)(m);
        waiters.delete(m.id);
      }
    }
  });
  const req = (o) => new Promise((r) => { waiters.set(o.id, r); child.stdin.write(JSON.stringify(o) + "\n"); });

  try {
    let callId = 1;
    await req({ jsonrpc: "2.0", id: callId++, method: "initialize", params: {} });

    // 1. Start session on OpenRouter model -> reaches orUrl with provider key
    const initOr = await req({
      jsonrpc: "2.0",
      id: callId++,
      method: "tools/call",
      params: { name: "openrouter", arguments: { prompt: "hi or", alias: "model-or" } },
    });
    const replyThreadIdOr = initOr.result.threadId;
    assert.ok(replyThreadIdOr);
    assert.equal(receivedOr.length, 1);
    assert.equal(receivedOr[0].headers.authorization, "Bearer test-or-key-abc");

    // 2. Reply to OpenRouter session without alias/model -> reaches orUrl with provider key
    await req({
      jsonrpc: "2.0",
      id: callId++,
      method: "tools/call",
      params: { name: "openrouter-reply", arguments: { threadId: replyThreadIdOr, prompt: "reply or" } },
    });
    assert.equal(receivedOr.length, 2);
    assert.equal(receivedOr[1].headers.authorization, "Bearer test-or-key-abc");

    // 3. Start session on Proxy model -> reaches proxyUrl with proxy key
    const initProxy = await req({
      jsonrpc: "2.0",
      id: callId++,
      method: "tools/call",
      params: { name: "openrouter", arguments: { prompt: "hi proxy", alias: "model-proxy" } },
    });
    const replyThreadIdProxy = initProxy.result.threadId;
    assert.ok(replyThreadIdProxy);
    assert.equal(receivedProxy.length, 1);
    assert.equal(receivedProxy[0].headers.authorization, "Bearer test-proxy-key-xyz");

    // 4. R7: Reply after a config edit keeps the stored values
    // Edit the config mid-session: change apiBase to an invalid location
    const editedConfig = JSON.parse(JSON.stringify(initialConfig));
    editedConfig.models["model-proxy"].apiBase = "http://127.0.0.1:1/v1-bogus";
    editedConfig.providers.openrouter.apiBase = "http://127.0.0.1:1/v1-bogus";
    writeCfg(editedConfig);
    // Give fs mtime time to change
    await new Promise((r) => setTimeout(r, 50));

    await req({
      jsonrpc: "2.0",
      id: callId++,
      method: "tools/call",
      params: { name: "openrouter-reply", arguments: { threadId: replyThreadIdProxy, prompt: "reply proxy keeps endpoint" } },
    });
    // Call went to original proxyUrl, not the bogus edited URL
    assert.equal(receivedProxy.length, 2);
    assert.equal(receivedProxy[1].headers.authorization, "Bearer test-proxy-key-xyz");

    // 5. R8: Reply naming a different alias is resolved again from the live config
    // Restore config with valid endpoint for model-other pointing to serverOr
    editedConfig.providers.openrouter.apiBase = orUrl;
    writeCfg(editedConfig);
    await new Promise((r) => setTimeout(r, 50));

    await req({
      jsonrpc: "2.0",
      id: callId++,
      method: "tools/call",
      params: { name: "openrouter-reply", arguments: { threadId: replyThreadIdProxy, alias: "model-other", prompt: "switch to other" } },
    });
    // The call switched to serverOr!
    assert.equal(receivedOr.length, 3);
    assert.equal(receivedOr[2].headers.authorization, "Bearer test-or-key-abc");
  } finally {
    child.kill();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    await new Promise((r) => serverOr.close(r));
    await new Promise((r) => serverProxy.close(r));
  }
});

test("LP-R9: local delegate timeout survives the resolveSettings overlay used at dispatch", async () => {
  let asked = null;
  const base = { name: "ollama", capabilities: {}, async health() { return { ok: true }; }, async ask(req) { asked = req; return { provider: "ollama", model: req.model, text: "ok", isError: false, ms: 1 }; } };
  const cfg = { providers: { ollama: { enabled: true, timeout: 1200000 } } };
  const perModel = pinAlias(base, { alias: "slow", provider: "ollama", model: "llama3", timeout: 900000 }, undefined, cfg);
  const fromProvider = pinAlias(base, { alias: "slow2", provider: "lmstudio", model: "qwen" }, undefined, { providers: { lmstudio: { timeout: 700000 } } });
  for (const [p, want, model] of [[perModel, 900000, "llama3"], [fromProvider, 700000, "qwen"]]) {
    // Same overlay callProvider/tracedAsk apply before ask().
    const s = p.resolveSettings({ prompt: "hi", context: "ask" });
    assert.equal(s.timeoutMs, want);
    assert.equal(s.model, model);
    await p.ask({ prompt: "hi", timeoutMs: s.timeoutMs, model: s.model });
    assert.equal(asked.timeoutMs, want);
    assert.equal(asked.model, model);
  }
});

test("LP-R10: standalone openrouter-list lists only openrouter records", async () => {
  const { spawn } = require("node:child_process");
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "delib-lp-list-"));
  const cfgFile = path.join(tmpDir, "config.json");
  fs.writeFileSync(cfgFile, JSON.stringify({
    version: 1,
    providers: { openrouter: { enabled: true } },
    models: {
      "or-a": { provider: "openrouter", model: "a/b", askAll: true, consensus: true },
      "loc-a": { provider: "ollama", model: "llama3", askAll: true, consensus: true },
    },
  }));
  const child = spawn(process.execPath, [path.resolve(__dirname, "../server/openrouter/index.js")], { env: { ...process.env, DELIBERATION_CONFIG: cfgFile }, stdio: ["pipe", "pipe", "pipe"] });
  try {
    const call = (id, args) => new Promise((resolve) => {
      let buf = "";
      const onData = (d) => {
        buf += d;
        for (const line of buf.split("\n")) {
          let msg; try { msg = JSON.parse(line); } catch { continue; }
          if (msg.id === id) { child.stdout.off("data", onData); resolve(JSON.parse(msg.result.content[0].text)); }
        }
      };
      child.stdout.on("data", onData);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "openrouter-list", arguments: args } }) + "\n");
    });
    const askAll = await call(1, { mode: "ask-all" });
    assert.deepEqual(askAll.delegates.map((d) => d.alias), ["or-a"]);
    assert.deepEqual(askAll.selected.map((d) => d.alias), ["or-a"]);
    const cons = await call(2, { mode: "consensus" });
    assert.deepEqual(cons.selected.map((d) => d.alias), ["or-a"]);
  } finally {
    child.kill();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
