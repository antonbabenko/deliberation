// test/gemini-api-bridge.test.js - the standalone Gemini bridge (what /ask-gemini calls) on the
// API key path. Spawns the bridge against a local mock of Google's OpenAI-compatible endpoint.
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { startBridge, send, collectResponses, readArgv } = require("./_helpers.js");

delete process.env.MCP_TOOL_TIMEOUT;

/** Local OpenAI-compatible stand-in for the Gemini API; records every request. */
async function mockGeminiApi(reply = "MOCK GEMINI API OK") {
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
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = /** @type {any} */ (server.address());
  return { requests, base: `http://127.0.0.1:${port}/v1beta/openai`, close: () => new Promise((r) => server.close(r)) };
}


function hermeticEnv(extra) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gem-api-cfg-"));
  return { DELIBERATION_CONFIG: path.join(dir, "missing.json"), ...extra };
}

test("G9: bridge with only a key answers from the API and never runs agy; replies continue the thread", async () => {
  const mock = await mockGeminiApi("FROM API");
  try {
    const child = startBridge({ env: hermeticEnv({ GEMINI_API_KEY: "k", GEMINI_API_BASE: mock.base }) });
    const responsesP = collectResponses(child);
    send(child, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    send(child, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "gemini", arguments: { prompt: "first", "developer-instructions": "sys" } } });
    // Wait for the first answer so the reply can name its thread.
    const first = await new Promise((resolve) => {
      let buf = "";
      child.stdout.on("data", (d) => {
        buf += d.toString();
        for (const line of buf.split("\n")) { try { const m = JSON.parse(line); if (m.id === 2) resolve(m); } catch { /* partial */ } }
      });
    });
    const threadId = /** @type {any} */ (first).result.threadId;
    assert.ok(threadId);
    send(child, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "gemini-reply", arguments: { threadId, prompt: "second" } } });
    send(child, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "gemini-reply", arguments: { threadId, prompt: "x", sandbox: "workspace-write" } } });
    setTimeout(() => child.stdin.end(), 1500);
    const responses = await responsesP;
    const byId = Object.fromEntries(responses.filter((m) => m.id).map((m) => [m.id, m]));
    assert.equal(byId[2].result.content[0].text, "FROM API");
    assert.equal(byId[2].result.transport, "api");
    assert.equal(byId[3].result.content[0].text, "FROM API");
    assert.equal(byId[3].result.threadId, threadId);
    assert.match(byId[4].error.message, /advisory only/);
    assert.equal(readArgv(child.argvLog).length, 0, "agy never ran");
    assert.equal(mock.requests.length, 2);
    const reply = mock.requests[1].body.messages.map((/** @type {any} */ m) => m.role);
    assert.deepEqual(reply, ["system", "user", "assistant", "user"], "the reply carries the prior turns");
  } finally { await mock.close(); }
});

test("G10: bridge with a key still runs agy for workspace-write and for transport 'agy'", async () => {
  const mock = await mockGeminiApi();
  try {
    const child = startBridge({ env: hermeticEnv({ GEMINI_API_KEY: "k", GEMINI_API_BASE: mock.base }) });
    const responsesP = collectResponses(child);
    send(child, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    send(child, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "gemini", arguments: { prompt: "hi", sandbox: "workspace-write" } } });
    setTimeout(() => child.stdin.end(), 1500);
    await responsesP;
    const argv = readArgv(child.argvLog)[0];
    assert.ok(argv && argv.includes("--dangerously-skip-permissions"));
    assert.equal(mock.requests.length, 0);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gem-agy-cfg-"));
    const cfg = path.join(dir, "config.json");
    fs.writeFileSync(cfg, JSON.stringify({ version: 1, providers: { gemini: { transport: "agy" } } }));
    const pinned = startBridge({ env: { DELIBERATION_CONFIG: cfg, GEMINI_API_KEY: "k", GEMINI_API_BASE: mock.base } });
    const pinnedP = collectResponses(pinned);
    send(pinned, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    send(pinned, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "gemini", arguments: { prompt: "hi" } } });
    setTimeout(() => pinned.stdin.end(), 1500);
    await pinnedP;
    assert.ok(readArgv(pinned.argvLog)[0].includes("--sandbox"), "transport agy keeps advisory calls on agy");
    assert.equal(mock.requests.length, 0);
  } finally { await mock.close(); }
});

test("G11: bridge with a key starts even when agy is missing", async () => {
  const mock = await mockGeminiApi("NO AGY NEEDED");
  try {
    const child = startBridge({ fakeBin: "does-not-exist", env: hermeticEnv({ GEMINI_API_KEY: "k", GEMINI_API_BASE: mock.base }) });
    const responsesP = collectResponses(child);
    send(child, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    send(child, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "gemini", arguments: { prompt: "hi" } } });
    setTimeout(() => child.stdin.end(), 1500);
    const responses = await responsesP;
    const r = responses.find((m) => m.id === 2);
    assert.equal(r && r.result.content[0].text, "NO AGY NEEDED");
  } finally { await mock.close(); }
});
