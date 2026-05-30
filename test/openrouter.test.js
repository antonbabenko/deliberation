"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { callOpenRouter, classifyError, buildMessages, isNonEmptyString } = require("../server/openrouter/index.js");

function startMock(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => handler(req, res, body));
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, base: `http://127.0.0.1:${server.address().port}/v1` }));
  });
}
function reply(res, status, obj) { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); }

test("O1: buildMessages emits system + user with inline blocks appended", () => {
  const msgs = buildMessages([
    { role: "system", text: "sys" },
    { role: "user", text: "hi", inlineBlocks: ["=== a.txt ===\nAAA"] },
  ]);
  assert.equal(msgs[0].role, "system");
  assert.equal(msgs[1].role, "user");
  assert.match(msgs[1].content, /hi/);
  assert.match(msgs[1].content, /AAA/);
});

test("O2: callOpenRouter posts chat/completions and returns assistant text", async () => {
  let received = null;
  const { server, base } = await startMock((req, res, body) => {
    received = { url: req.url, auth: req.headers["authorization"], body: JSON.parse(body) };
    return reply(res, 200, { choices: [{ message: { role: "assistant", content: "the answer" } }] });
  });
  try {
    const out = await callOpenRouter({
      apiBase: base, apiKey: "sk-test", model: "openai/gpt-5.5",
      messages: buildMessages([{ role: "user", text: "q" }]),
    });
    assert.equal(out.text, "the answer");
    assert.equal(received.url, "/v1/chat/completions");
    assert.equal(received.auth, "Bearer sk-test");
    assert.equal(received.body.model, "openai/gpt-5.5");
  } finally { server.close(); }
});

test("O3: empty key sends NO Authorization header (keyless local endpoints)", async () => {
  let auth = "unset";
  const { server, base } = await startMock((req, res) => {
    auth = req.headers["authorization"] || null;
    return reply(res, 200, { choices: [{ message: { content: "ok" } }] });
  });
  try {
    await callOpenRouter({ apiBase: base, apiKey: "", model: "m", messages: buildMessages([{ role: "user", text: "q" }]) });
    assert.equal(auth, null);
  } finally { server.close(); }
});

test("O4: classifyError maps HTTP status and error codes", () => {
  assert.equal(classifyError(401, null).errorKind, "auth");
  assert.equal(classifyError(429, null).errorKind, "rate-limit");
  assert.equal(classifyError(503, null).errorKind, "upstream");
  assert.equal(classifyError(null, "timeout").errorKind, "timeout");
  assert.equal(classifyError(null, "timeout").retryable, true);
});

test("O5: non-2xx surfaces a status-tagged error", async () => {
  const { server, base } = await startMock((req, res) => reply(res, 429, { error: "slow down" }));
  try {
    await assert.rejects(
      () => callOpenRouter({ apiBase: base, apiKey: "k", model: "m", messages: buildMessages([{ role: "user", text: "q" }]) }),
      (e) => e.status === 429
    );
  } finally { server.close(); }
});

const { spawn } = require("node:child_process");
const fsx = require("node:fs");
const osx = require("node:os");
const pathx = require("node:path");
const BRIDGE = pathx.join(__dirname, "..", "server", "openrouter", "index.js");

function writeConfig(obj) {
  const dir = fsx.mkdtempSync(pathx.join(osx.tmpdir(), "cdg-orcfg-"));
  const file = pathx.join(dir, "config.json");
  fsx.writeFileSync(file, JSON.stringify(obj));
  return file;
}
function startBridge(env) {
  return spawn(process.execPath, [BRIDGE], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
}
function rpc(child) {
  let buf = ""; const waiters = new Map();
  child.stdout.on("data", (d) => {
    buf += d.toString(); const lines = buf.split("\n"); buf = lines.pop();
    for (const line of lines) { if (!line.trim()) continue; let m; try { m = JSON.parse(line); } catch (_) { continue; } if (m.id !== undefined && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); } }
  });
  return { request(o) { return new Promise((r) => { waiters.set(o.id, r); child.stdin.write(JSON.stringify(o) + "\n"); }); } };
}

test("O6: tools/list advertises openrouter, -reply, -list", async () => {
  const file = writeConfig({ version: 1, openrouter: { enabled: true, models: [{ alias: "m1", model: "a/b" }] } });
  const child = startBridge({ DELIBERATION_CONFIG: file });
  const c = rpc(child);
  try {
    await c.request({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const list = await c.request({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const names = list.result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["openrouter", "openrouter-list", "openrouter-reply"]);
  } finally { child.kill(); }
});

test("O6b: DELIBERATION_CONFIG env points the bridge at the configured delegate", async () => {
  const file = writeConfig({ version: 1, openrouter: { enabled: true, models: [{ alias: "m1", model: "a/b" }] } });
  const child = startBridge({ DELIBERATION_CONFIG: file });
  const c = rpc(child);
  try {
    await c.request({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const r = await c.request({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "openrouter-list", arguments: {} } });
    const payload = JSON.parse(r.result.content[0].text);
    assert.deepEqual(payload.delegates.map((d) => d.alias), ["m1"]);
  } finally { child.kill(); }
});

test("O7: openrouter-list returns delegates object in config order", async () => {
  const file = writeConfig({ version: 1, openrouter: { enabled: true, maxFanout: 4, defaultModel: "d/m", models: [
    { alias: "x", model: "a/x" }, { alias: "y", model: "a/y", experts: [] },
  ] } });
  const child = startBridge({ DELIBERATION_CONFIG: file });
  const c = rpc(child);
  try {
    await c.request({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const r = await c.request({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "openrouter-list", arguments: {} } });
    const payload = JSON.parse(r.result.content[0].text);
    assert.deepEqual(payload.delegates.map((d) => d.alias), ["x", "y"]);
    assert.equal(payload.defaultModelSet, true);
    assert.equal(payload.maxFanout, 4);
    assert.deepEqual(payload.invalidModels, []);
  } finally { child.kill(); }
});

test("O7e: openrouter-list keeps valid delegates and reports a broken entry with a suggestion", async () => {
  const file = writeConfig({ version: 1, openrouter: { enabled: true, defaultModel: "d/m", models: [
    { alias: "good", model: "a/good" },
    { alias: "qwen3.7-max", model: "qwen/qwen3.7-max" }, // illegal '.' in alias
  ] } });
  const child = startBridge({ DELIBERATION_CONFIG: file });
  const c = rpc(child);
  try {
    await c.request({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const r = await c.request({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "openrouter-list", arguments: {} } });
    const payload = JSON.parse(r.result.content[0].text);
    assert.equal(payload.error, undefined, "partial config must not set the hard error field");
    assert.deepEqual(payload.delegates.map((d) => d.alias), ["good"]);
    assert.equal(payload.invalidModels.length, 1);
    assert.equal(payload.invalidModels[0].index, 1);
    assert.equal(payload.invalidModels[0].suggestedAlias, "qwen3-7-max");
  } finally { child.kill(); }
});

test("O7b: openrouter-list resolves reasoning_effort (per-model > defaults > null)", async () => {
  // With defaults: per-model override wins; otherwise inherit defaults.
  const withDefaults = writeConfig({ version: 1, openrouter: { enabled: true, defaultModel: "d/m",
    defaults: { reasoning_effort: "medium" },
    models: [
      { alias: "override", model: "a/x", reasoning_effort: "high" },
      { alias: "inherit", model: "a/y" },
    ] } });
  let child = startBridge({ DELIBERATION_CONFIG: withDefaults });
  let c = rpc(child);
  try {
    await c.request({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const r = await c.request({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "openrouter-list", arguments: {} } });
    const byAlias = Object.fromEntries(JSON.parse(r.result.content[0].text).delegates.map((d) => [d.alias, d.reasoning_effort]));
    assert.equal(byAlias.override, "high");
    assert.equal(byAlias.inherit, "medium");
  } finally { child.kill(); }

  // No defaults and no per-model value => null (always present).
  const noDefaults = writeConfig({ version: 1, openrouter: { enabled: true, models: [{ alias: "bare", model: "a/z" }] } });
  child = startBridge({ DELIBERATION_CONFIG: noDefaults });
  c = rpc(child);
  try {
    await c.request({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const r = await c.request({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "openrouter-list", arguments: {} } });
    assert.equal(JSON.parse(r.result.content[0].text).delegates[0].reasoning_effort, null);
  } finally { child.kill(); }
});

test("O8: openrouter call with unknown alias => model-not-allowed", async () => {
  const file = writeConfig({ version: 1, openrouter: { enabled: true, models: [{ alias: "m1", model: "a/b" }] } });
  const child = startBridge({ DELIBERATION_CONFIG: file, OPENROUTER_API_KEY: "k" });
  const c = rpc(child);
  try {
    await c.request({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const r = await c.request({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "openrouter", arguments: { prompt: "q", alias: "ghost" } } });
    assert.equal(r.result.isError, true);
    assert.equal(r.result.errorKind, "model-not-allowed");
  } finally { child.kill(); }
});

test("O9: allowRawModel:false rejects a raw model param", async () => {
  const file = writeConfig({ version: 1, openrouter: { enabled: true, allowRawModel: false, models: [{ alias: "m1", model: "a/b" }] } });
  const child = startBridge({ DELIBERATION_CONFIG: file, OPENROUTER_API_KEY: "k" });
  const c = rpc(child);
  try {
    await c.request({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const r = await c.request({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "openrouter", arguments: { prompt: "q", model: "raw/slug" } } });
    assert.equal(r.result.isError, true);
    assert.equal(r.result.errorKind, "model-not-allowed");
  } finally { child.kill(); }
});

test("O10: end-to-end openrouter call via alias against a mock endpoint", async () => {
  const { server, base } = await startMock((req, res) => reply(res, 200, { choices: [{ message: { content: "delegated answer" } }] }));
  const file = writeConfig({ version: 1, openrouter: { enabled: true, apiBase: base, models: [{ alias: "m1", model: "a/b" }] } });
  const child = startBridge({ DELIBERATION_CONFIG: file, OPENROUTER_API_KEY: "k" });
  const c = rpc(child);
  try {
    await c.request({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const r = await c.request({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "openrouter", arguments: { prompt: "q", alias: "m1" } } });
    assert.equal(r.result.content[0].text, "delegated answer");
    assert.ok(isNonEmptyString(r.result.threadId));
  } finally { child.kill(); server.close(); }
});

test("O11: openrouter-reply reuses the session model (no drift to default)", async () => {
  const seen = [];
  const { server, base } = await startMock((req, res, body) => { seen.push(JSON.parse(body).model); return reply(res, 200, { choices: [{ message: { content: "ok" } }] }); });
  const file = writeConfig({ version: 1, openrouter: { enabled: true, apiBase: base, defaultModel: "default/model", models: [{ alias: "llama", model: "meta/llama" }] } });
  const child = startBridge({ DELIBERATION_CONFIG: file, OPENROUTER_API_KEY: "k" });
  const c = rpc(child);
  try {
    await c.request({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const r1 = await c.request({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "openrouter", arguments: { prompt: "q1", alias: "llama" } } });
    const tid = r1.result.threadId;
    await c.request({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "openrouter-reply", arguments: { threadId: tid, prompt: "q2" } } });
    assert.deepEqual(seen, ["meta/llama", "meta/llama"]); // reply stayed on llama, not default/model
  } finally { child.kill(); server.close(); }
});

test("O12: non-array roots is rejected with -32602", async () => {
  const file = writeConfig({ version: 1, openrouter: { enabled: true, models: [{ alias: "m1", model: "a/b" }] } });
  const child = startBridge({ DELIBERATION_CONFIG: file, OPENROUTER_API_KEY: "k" });
  const c = rpc(child);
  try {
    await c.request({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const r = await c.request({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "openrouter", arguments: { prompt: "q", alias: "m1", roots: "not-an-array" } } });
    assert.ok(r.error && r.error.code === -32602, "expected -32602 JSON-RPC error for non-array roots");
  } finally { child.kill(); }
});

test("O13: openrouter-list returns object with error (not error envelope) on bad config", async () => {
  const dir = fsx.mkdtempSync(pathx.join(osx.tmpdir(), "cdg-orbad-"));
  const file = pathx.join(dir, "config.json");
  fsx.writeFileSync(file, "{ not json ");
  const child = startBridge({ DELIBERATION_CONFIG: file });
  const c = rpc(child);
  try {
    await c.request({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const r = await c.request({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "openrouter-list", arguments: {} } });
    assert.ok(!r.result.isError, "should not be an error envelope");
    const payload = JSON.parse(r.result.content[0].text);
    assert.deepEqual(payload.delegates, []);
    assert.ok(payload.error, "error field set");
  } finally { child.kill(); }
});

test("O14: concurrent tools/call to one bridge run in parallel, not serialized", async () => {
  const DELAY = 300;
  let inFlight = 0, maxInFlight = 0;
  const { server, base } = await startMock((req, res) => {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    setTimeout(() => { inFlight--; reply(res, 200, { choices: [{ message: { content: "ok" } }] }); }, DELAY);
  });
  const file = writeConfig({ version: 1, openrouter: { enabled: true, apiBase: base, models: [
    { alias: "m1", model: "a/m1" }, { alias: "m2", model: "a/m2" },
  ] } });
  const child = startBridge({ DELIBERATION_CONFIG: file });
  const c = rpc(child);
  try {
    await c.request({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const t0 = Date.now();
    // Fire both without awaiting the first - a serialized bridge would run them back-to-back.
    const [a, b] = await Promise.all([
      c.request({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "openrouter", arguments: { alias: "m1", prompt: "q" } } }),
      c.request({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "openrouter", arguments: { alias: "m2", prompt: "q" } } }),
    ]);
    const elapsed = Date.now() - t0;
    assert.equal(a.result.content[0].text, "ok");
    assert.equal(b.result.content[0].text, "ok");
    assert.equal(maxInFlight, 2, "both requests should be in flight at the mock simultaneously");
    assert.ok(elapsed < DELAY * 2, `expected overlap (<${DELAY * 2}ms), got ${elapsed}ms`);
  } finally { child.kill(); server.close(); }
});
