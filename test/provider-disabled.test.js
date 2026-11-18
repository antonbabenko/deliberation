"use strict";
// providers.<name>.enabled: false must stop EVERY tool that would call that provider: the
// unified server's ask-* / ask-one / expert tools and the standalone bridges. A disabled
// provider answers errorKind "disabled" naming the key that turns it back on, and makes no
// network call or CLI spawn.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { buildServer } = require("../server/mcp/index.js");
const { validateConfig } = require("../server/openrouter/config.js");
const { startBridge: startGeminiBridge, send, collectResponses, readArgv } = require("./_helpers.js");

delete process.env.MCP_TOOL_TIMEOUT;

function fakeProvider(/** @type {string} */ name) {
  let calls = 0;
  return /** @type {any} */ ({
    name,
    capabilities: { canImplement: false, fileUpload: false, multiTurn: false },
    async health() { return { ok: true }; },
    async ask(/** @type {any} */ req) { calls += 1; return { provider: name, model: `${name}-m`, text: `${name}:${req.prompt}`, isError: false, ms: 1, reasoningEffort: null }; },
    get calls() { return calls; },
  });
}

/** @param {any} raw */
function resolved(raw) {
  const r = validateConfig(raw, { OPENROUTER_API_KEY: "k" });
  assert.equal(r.ok, true, r.error);
  return r.resolved;
}

/** @param {any} srv @param {string} name @param {any} args */
async function call(srv, name, args) {
  const res = await srv.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  return JSON.parse(res.result.content[0].text);
}

const ASK = { "ask-gpt": "codex", "ask-gemini": "gemini", "ask-grok": "grok", "ask-openrouter": "openrouter" };

for (const [tool, prov] of Object.entries(ASK)) {
  test(`PD1 ${tool}: disabled provider returns errorKind disabled and is never called`, async () => {
    const providers = ["codex", "gemini", "grok", "openrouter"].map(fakeProvider);
    const cfg = resolved({ version: 1, providers: { [prov]: { enabled: false } } });
    const srv = buildServer({ providers, getConfig: () => cfg, configPath: "/cfg/config.json" });
    const { result } = await call(srv, tool, { prompt: "q" });
    assert.equal(result.isError, true);
    assert.equal(result.errorKind, "disabled");
    assert.equal(result.retryable, false);
    assert.equal(result.provider, prov);
    assert.match(result.message, new RegExp(`providers\\.${prov}\\.enabled`));
    assert.match(result.message, /\/cfg\/config\.json/);
    for (const p of providers) assert.equal(p.calls, 0, `${p.name} must not be called`);
  });
}

test("PD2: the flag is read per call (hot reload turns a provider off and back on)", async () => {
  const grok = fakeProvider("grok");
  let cfg = resolved({ version: 1, providers: { grok: { enabled: false } } });
  const srv = buildServer({ providers: [grok], getConfig: () => cfg });
  assert.equal((await call(srv, "ask-grok", { prompt: "q" })).result.errorKind, "disabled");
  cfg = resolved({ version: 1, providers: { grok: { enabled: true } } });
  assert.equal((await call(srv, "ask-grok", { prompt: "q" })).result.text, "grok:q");
  assert.equal(grok.calls, 1);
});

test("PD3: ask-one names the disabled built-in instead of 'not in the panel'", async () => {
  const codex = fakeProvider("codex");
  const grok = fakeProvider("grok");
  const cfg = resolved({ version: 1, providers: { grok: { enabled: false } } });
  const srv = buildServer({ providers: [codex, grok], getConfig: () => cfg });
  const { result } = await call(srv, "ask-one", { provider: "grok", prompt: "q" });
  assert.equal(result.errorKind, "disabled");
  assert.match(result.message, /providers\.grok\.enabled/);
  assert.equal(grok.calls, 0);
});

test("PD4: ask-one for an openrouter:<alias> with OpenRouter disabled is a disabled error", async () => {
  const or = fakeProvider("openrouter");
  const cfg = resolved({ version: 1, providers: { openrouter: { enabled: false } }, models: { m1: { provider: "openrouter", model: "a/b" } } });
  const srv = buildServer({ providers: [or], getConfig: () => cfg });
  const { result } = await call(srv, "ask-one", { provider: "openrouter:m1", prompt: "q" });
  assert.equal(result.errorKind, "disabled");
  assert.match(result.message, /providers\.openrouter\.enabled/);
  assert.equal(or.calls, 0);
});

test("PD5: expert tools skip a disabled provider", async () => {
  const codex = fakeProvider("codex");
  const gemini = fakeProvider("gemini");
  const cfg = resolved({ version: 1, providers: { gemini: { enabled: false } } });
  const srv = buildServer({ providers: [codex, gemini], getConfig: () => cfg });
  const payload = await call(srv, "architect", { prompt: "q" });
  assert.deepEqual(payload.results.map((/** @type {any} */ r) => r.provider), ["codex"]);
  assert.equal(gemini.calls, 0);
});

// ---- standalone bridges ----------------------------------------------------------------

/** @param {any} raw */
function writeConfig(raw) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cdg-disabled-")), "config.json");
  fs.writeFileSync(file, JSON.stringify(raw));
  return file;
}

/** A local endpoint that counts every request it gets. */
async function countingServer() {
  let hits = 0;
  const server = http.createServer((_req, res) => { hits += 1; res.writeHead(500); res.end("{}"); });
  await new Promise((r) => server.listen(0, "127.0.0.1", () => r(undefined)));
  const { port } = /** @type {any} */ (server.address());
  return { base: `http://127.0.0.1:${port}/v1`, hits: () => hits, close: () => new Promise((r) => server.close(r)) };
}

/** Send initialize + the given tool calls, then close stdin and collect the replies. */
async function runBridge(/** @type {any} */ child, /** @type {any[]} */ calls) {
  const out = collectResponses(child);
  send(child, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  calls.forEach((params, i) => send(child, { jsonrpc: "2.0", id: i + 2, method: "tools/call", params }));
  child.stdin.end();
  const responses = await out;
  return calls.map((_, i) => responses.find((r) => r.id === i + 2));
}

/** @param {any} r @param {string} prov @param {string} file */
function assertDisabled(r, prov, file) {
  assert.ok(r && r.result, `got a result: ${JSON.stringify(r)}`);
  assert.equal(r.result.isError, true);
  assert.equal(r.result.errorKind, "disabled");
  assert.equal(r.result.retryable, false);
  assert.ok(r.result.content[0].text.includes(`providers.${prov}.enabled`));
  assert.ok(r.result.content[0].text.includes(file));
}

test("PD6: Grok bridge - grok and grok-reply refuse when disabled, no xAI request", async () => {
  const api = await countingServer();
  try {
    const file = writeConfig({ version: 1, providers: { grok: { enabled: false } } });
    const child = spawn(process.execPath, [path.join(__dirname, "..", "server", "grok", "index.js")], {
      env: { ...process.env, DELIBERATION_CONFIG: file, XAI_API_KEY: "k", XAI_API_BASE: api.base },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const [a, b] = await runBridge(child, [
      { name: "grok", arguments: { prompt: "q" } },
      { name: "grok-reply", arguments: { prompt: "q", threadId: "t1" } },
    ]);
    assertDisabled(a, "grok", file);
    assertDisabled(b, "grok", file);
    assert.equal(api.hits(), 0, "no request reached the API");
  } finally { await api.close(); }
});

test("PD7: Gemini bridge - gemini and gemini-reply refuse when disabled, no agy spawn and no API request", async () => {
  const api = await countingServer();
  try {
    const file = writeConfig({ version: 1, providers: { gemini: { enabled: false } } });
    const child = startGeminiBridge({ env: { DELIBERATION_CONFIG: file, GEMINI_API_KEY: "k", GEMINI_API_BASE: api.base } });
    const [a, b, c] = await runBridge(child, [
      { name: "gemini", arguments: { prompt: "q" } },
      { name: "gemini", arguments: { prompt: "q", sandbox: "workspace-write" } },
      { name: "gemini-reply", arguments: { prompt: "q", threadId: "t1" } },
    ]);
    for (const r of [a, b, c]) assertDisabled(r, "gemini", file);
    assert.equal(readArgv(child.argvLog).length, 0, "agy was never spawned");
    assert.equal(api.hits(), 0, "no request reached the API");
  } finally { await api.close(); }
});

test("PD8: OpenRouter bridge - openrouter and openrouter-reply refuse when disabled, no request", async () => {
  const api = await countingServer();
  try {
    const file = writeConfig({ version: 1, providers: { openrouter: { enabled: false, apiBase: api.base } }, models: { m1: { provider: "openrouter", model: "a/b" } } });
    const child = spawn(process.execPath, [path.join(__dirname, "..", "server", "openrouter", "index.js")], {
      env: { ...process.env, DELIBERATION_CONFIG: file, OPENROUTER_API_KEY: "k" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const [a, b, list] = await runBridge(child, [
      { name: "openrouter", arguments: { prompt: "q", alias: "m1" } },
      { name: "openrouter-reply", arguments: { prompt: "q", threadId: "t1" } },
      { name: "openrouter-list", arguments: {} },
    ]);
    assertDisabled(a, "openrouter", file);
    assertDisabled(b, "openrouter", file);
    assert.ok(!list.result.isError, "openrouter-list still answers (local, no network)");
    assert.equal(api.hits(), 0, "no request reached the API");
  } finally { await api.close(); }
});

test("PD9: OpenRouter bridge - an ABSENT providers.openrouter block with a key is NOT disabled", async () => {
  const api = await countingServer();
  try {
    const file = writeConfig({ version: 1, models: { m1: { provider: "openrouter", model: "a/b", apiBase: api.base } } });
    const child = spawn(process.execPath, [path.join(__dirname, "..", "server", "openrouter", "index.js")], {
      env: { ...process.env, DELIBERATION_CONFIG: file, OPENROUTER_API_KEY: "k" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const [a] = await runBridge(child, [{ name: "openrouter", arguments: { prompt: "q", alias: "m1" } }]);
    assert.notEqual(a.result.errorKind, "disabled");
    assert.ok(api.hits() >= 1, "the call went out to the endpoint");
  } finally { await api.close(); }
});

test("PD10: a running bridge picks up an edit to providers.grok.enabled without a restart", async () => {
  const api = await countingServer();
  try {
    const file = writeConfig({ version: 1, providers: { grok: { enabled: true } } });
    const child = spawn(process.execPath, [path.join(__dirname, "..", "server", "grok", "index.js")], {
      env: { ...process.env, DELIBERATION_CONFIG: file, XAI_API_KEY: "k", XAI_API_BASE: api.base, GROK_MIN_ANSWER_CHARS: "0" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out = collectResponses(child);
    /** @param {number} id */
    const waitFor = (id) => new Promise((resolve) => {
      let buf = "";
      const on = (/** @type {Buffer} */ d) => {
        buf += d.toString();
        for (const line of buf.split("\n")) { try { const m = JSON.parse(line); if (m.id === id) { child.stdout.off("data", on); resolve(m); return; } } catch (_) { /* partial */ } }
      };
      child.stdout.on("data", on);
    });
    const ask = (/** @type {number} */ id) => { const p = waitFor(id); send(child, { jsonrpc: "2.0", id, method: "tools/call", params: { name: "grok", arguments: { prompt: "q" } } }); return p; };
    send(child, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const first = /** @type {any} */ (await ask(2));
    assert.notEqual(first.result.errorKind, "disabled");
    const before = api.hits();
    assert.ok(before >= 1, "enabled: the call reached the API");
    fs.writeFileSync(file, JSON.stringify({ version: 1, providers: { grok: { enabled: false } } }));
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(file, later, later); // the reader is mtime-gated; make the edit visible
    const second = /** @type {any} */ (await ask(3));
    assert.equal(second.result.errorKind, "disabled");
    assert.equal(api.hits(), before, "disabled: no new request");
    child.stdin.end();
    await out;
  } finally { await api.close(); }
});
