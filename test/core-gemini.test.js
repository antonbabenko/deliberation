// test/core-gemini.test.js - Gemini over an AI Studio API key vs the agy CLI.
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const {
  makeGeminiProvider, makeGeminiApiProvider, geminiApiKey, useGeminiApi, DEFAULT_GEMINI_API_MODEL,
} = require("../core/providers/gemini.js");
const { resolveSettings } = require("../core/settings.js");

/** Fake leg provider that records which path answered.
 * @param {string} name @param {Record<string, any>} [extra] @returns {any} */
function leg(name, extra = {}) {
  return {
    name: "gemini",
    capabilities: { canImplement: false, fileUpload: false, multiTurn: true, walksFilesystem: name === "agy", ...extra },
    health: async () => ({ ok: true, via: name }),
    ask: async () => ({ provider: "gemini", model: name, text: name, isError: false, ms: 0 }),
  };
}

/** Run fn with the given key env, restoring the originals after.
 * @param {Record<string, string>} keys @param {() => any} fn */
async function withKeys(keys, fn) {
  const saved = { GEMINI_API_KEY: process.env.GEMINI_API_KEY, GOOGLE_API_KEY: process.env.GOOGLE_API_KEY };
  delete process.env.GEMINI_API_KEY; delete process.env.GOOGLE_API_KEY;
  Object.assign(process.env, keys);
  try { return await fn(); } finally {
    for (const [k, v] of /** @type {[string, (string|undefined)][]} */ (Object.entries(saved))) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

/** Local OpenAI-compatible stand-in for the Gemini API; records every request. */
async function mockGeminiApi(reply = "MOCK GEMINI API OK") {
  /** @type {any[]} */
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body: JSON.parse(body) });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: reply } }], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", () => r(undefined)));
  const { port } = /** @type {any} */ (server.address());
  return { requests, base: `http://127.0.0.1:${port}/v1beta/openai`, close: () => new Promise((r) => server.close(() => r(undefined))) };
}

// --- provider resolution ---

test("G1: key only -> API path; GOOGLE_API_KEY is accepted, GEMINI_API_KEY wins", () => {
  assert.equal(useGeminiApi(undefined, { GEMINI_API_KEY: "k" }), true);
  assert.equal(useGeminiApi("auto", { GOOGLE_API_KEY: "g" }), true);
  assert.equal(geminiApiKey({ GEMINI_API_KEY: "k", GOOGLE_API_KEY: "g" }), "k");
  assert.equal(geminiApiKey({ GOOGLE_API_KEY: "g" }), "g");
});

test("G2: agy only (no key) -> agy path, so an existing install keeps working", () => {
  assert.equal(useGeminiApi(undefined, {}), false);
  assert.equal(useGeminiApi("auto", { GEMINI_API_KEY: "" }), false);
});

test("G3: both key and agy -> API by default; transport 'agy' opts back into agy; 'api' forces the key path", () => {
  const env = { GEMINI_API_KEY: "k" };
  assert.equal(useGeminiApi(undefined, env), true);
  assert.equal(useGeminiApi("agy", env), false);
  assert.equal(useGeminiApi("api", {}), true);
});

test("G4: dispatcher routes advisory calls by key, implementation always to agy", async () => {
  const p = makeGeminiProvider({ agy: leg("agy", { canImplement: true }), api: leg("api") });
  await withKeys({}, async () => {
    assert.equal(/** @type {any} */ (await p.ask({ prompt: "x" })).text, "agy");
    assert.equal(p.capabilities.walksFilesystem, true);
  });
  await withKeys({ GEMINI_API_KEY: "k" }, async () => {
    assert.equal(/** @type {any} */ (await p.ask({ prompt: "x" })).text, "api");
    assert.equal(/** @type {any} */ (await p.ask({ prompt: "x", mode: "implement" })).text, "agy");
    assert.equal(p.capabilities.walksFilesystem, false, "API path is file-blind, so orientation files get attached");
    assert.equal(p.capabilities.canImplement, true, "implementation capability still comes from agy");
    assert.equal(/** @type {any} */ (await p.health()).via, "api");
  });
  const pinned = makeGeminiProvider({ agy: leg("agy"), api: leg("api"), transport: "agy" });
  await withKeys({ GEMINI_API_KEY: "k" }, async () => {
    assert.equal(/** @type {any} */ (await pinned.ask({ prompt: "x" })).text, "agy");
  });
});

test("G5: API provider health names the missing key", async () => {
  const p = makeGeminiApiProvider({ bridge: require("../server/openrouter/index.js") });
  await withKeys({}, async () => {
    const h = await p.health();
    assert.equal(h.ok, false);
    assert.match(String(h.reason), /GEMINI_API_KEY/);
  });
  await withKeys({ GOOGLE_API_KEY: "g" }, async () => assert.equal((await p.health()).ok, true));
});

test("G6: settings resolve the API model on the key path and the agy model otherwise", () => {
  const cfg = { providers: { gemini: { model: "gemini-3.6-flash-high", apiModel: "gemini-pro-latest" } } };
  assert.equal(resolveSettings("gemini", cfg, {}, { GEMINI_API_KEY: "k" }).model, "gemini-pro-latest");
  assert.equal(resolveSettings("gemini", { providers: { gemini: {} } }, {}, { GEMINI_API_KEY: "k" }).model, DEFAULT_GEMINI_API_MODEL);
  const agy = resolveSettings("gemini", cfg, {}, {});
  assert.equal(agy.model, "gemini-3.6-flash-high");
  assert.equal(agy.reasoningEffort, "high");
  const pinned = resolveSettings("gemini", { providers: { gemini: { ...cfg.providers.gemini, transport: "agy" } } }, {}, { GEMINI_API_KEY: "k" });
  assert.equal(pinned.model, "gemini-3.6-flash-high");
});

// --- HTTP request shape ---

test("G7: the API call posts an OpenAI chat request with the key as a bearer token", async () => {
  const mock = await mockGeminiApi();
  try {
    await withKeys({ GEMINI_API_KEY: "test-key-123" }, async () => {
      const p = makeGeminiApiProvider({ bridge: require("../server/openrouter/index.js"), apiBase: mock.base });
      const r = /** @type {any} */ (await p.ask({ prompt: "review this", developerInstructions: "you are a reviewer", reasoningEffort: "high" }));
      assert.equal(r.isError, false, JSON.stringify(r));
      assert.equal(r.text, "MOCK GEMINI API OK");
      assert.equal(r.model, DEFAULT_GEMINI_API_MODEL);
      assert.equal(r.provider, "gemini");
      assert.deepEqual(r.usage, { promptTokens: 3, completionTokens: 4, totalTokens: 7 });
    });
    assert.equal(mock.requests.length, 1);
    const [req] = mock.requests;
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/v1beta/openai/chat/completions");
    assert.equal(req.headers.authorization, "Bearer test-key-123");
    assert.equal(req.body.model, DEFAULT_GEMINI_API_MODEL);
    assert.equal(req.body.stream, false);
    assert.equal(req.body.reasoning_effort, "high", "Google's field, not OpenRouter's reasoning object");
    assert.equal(req.body.reasoning, undefined);
    assert.equal(req.body.preset, undefined);
    assert.equal(req.body.messages[0].role, "system");
    assert.match(req.body.messages[0].content, /you are a reviewer/);
    assert.equal(req.body.messages.at(-1).role, "user");
    assert.match(JSON.stringify(req.body.messages.at(-1).content), /review this/);
  } finally { await mock.close(); }
});

test("G8: an API error is labelled Gemini and classified, never leaking the key", async () => {
  const server = http.createServer((_req, res) => { res.writeHead(401, { "Content-Type": "application/json" }); res.end('{"error":"API key not valid"}'); });
  await new Promise((r) => server.listen(0, "127.0.0.1", () => r(undefined)));
  const base = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}/v1beta/openai`;
  try {
    await withKeys({ GEMINI_API_KEY: "secret-key-xyz" }, async () => {
      const r = /** @type {any} */ (await makeGeminiApiProvider({ bridge: require("../server/openrouter/index.js"), apiBase: base }).ask({ prompt: "x" }));
      assert.equal(r.isError, true);
      assert.equal(r.errorKind, "auth");
      assert.match(r.message, /^Gemini API error 401/);
      assert.ok(!JSON.stringify(r).includes("secret-key-xyz"));
    });
  } finally { await new Promise((r) => server.close(() => r(undefined))); }
});
