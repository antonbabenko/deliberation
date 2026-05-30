"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");

const BRIDGE = path.join(__dirname, "..", "server", "grok", "index.js");

// Spawn the Grok bridge with a controlled environment.
function startGrokBridge(env = {}) {
  return spawn(process.execPath, [BRIDGE], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

// Minimal request/response-correlated JSON-RPC client over the child's stdio.
function rpcClient(child) {
  let buf = "";
  const waiters = new Map();
  child.stdout.on("data", (d) => {
    buf += d.toString();
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (_) { continue; }
      if (msg.id !== undefined && waiters.has(msg.id)) {
        waiters.get(msg.id)(msg);
        waiters.delete(msg.id);
      }
    }
  });
  return {
    request(obj) {
      return new Promise((resolve) => {
        waiters.set(obj.id, resolve);
        child.stdin.write(JSON.stringify(obj) + "\n");
      });
    },
  };
}

// Localhost mock of the xAI API. `handler(req, res, body)` routes per endpoint.
function startMock(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => handler(req, res, body));
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, base: `http://127.0.0.1:${port}/v1` });
    });
  });
}

function reply(res, status, obj) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

function lastUserContent(responsesBody) {
  const input = responsesBody.input;
  return input[input.length - 1].content;
}

// --- Integration (spawned bridge + mock /v1/responses + /v1/files) ---

test("G1: grok then grok-reply build /v1/responses input and accumulate turns", async () => {
  const bodies = [];
  const { server, base } = await startMock((req, res, body) => {
    if (req.method === "POST" && req.url === "/v1/responses") {
      bodies.push(JSON.parse(body));
      return reply(res, 200, { output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: `reply-${bodies.length}` }] }] });
    }
    return reply(res, 404, { error: "unexpected" });
  });
  const child = startGrokBridge({ XAI_API_KEY: "test", XAI_API_BASE: base });
  const rpc = rpcClient(child);
  try {
    await rpc.request({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });

    const r1 = await rpc.request({
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "grok", arguments: { prompt: "hello", "developer-instructions": "sys" } },
    });
    assert.equal(r1.result.isError, undefined);
    assert.equal(r1.result.content[0].text, "reply-1");
    const threadId = r1.result.threadId;
    assert.ok(threadId);

    const r2 = await rpc.request({
      jsonrpc: "2.0", id: 3, method: "tools/call",
      params: { name: "grok-reply", arguments: { threadId, prompt: "again" } },
    });
    assert.equal(r2.result.content[0].text, "reply-2");
    assert.equal(r2.result.threadId, threadId);

    assert.deepEqual(bodies[0].input, [
      { role: "system", content: [{ type: "input_text", text: "sys" }] },
      { role: "user", content: [{ type: "input_text", text: "hello" }] },
    ]);
    assert.deepEqual(bodies[1].input, [
      { role: "system", content: [{ type: "input_text", text: "sys" }] },
      { role: "user", content: [{ type: "input_text", text: "hello" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "reply-1" }] },
      { role: "user", content: [{ type: "input_text", text: "again" }] },
    ]);
  } finally {
    child.stdin.end();
    server.close();
  }
});

test("G2: missing XAI_API_KEY returns errorKind missing-auth", async () => {
  const child = startGrokBridge({ XAI_API_KEY: "", XAI_API_BASE: "http://127.0.0.1:1/v1" });
  const rpc = rpcClient(child);
  try {
    await rpc.request({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const r = await rpc.request({
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "grok", arguments: { prompt: "hi" } },
    });
    assert.equal(r.result.isError, true);
    assert.equal(r.result.errorKind, "missing-auth");
    assert.equal(r.result.retryable, false);
  } finally {
    child.stdin.end();
  }
});

test("G3: grok-reply on an unknown threadId returns unknown-thread", async () => {
  const child = startGrokBridge({ XAI_API_KEY: "test", XAI_API_BASE: "http://127.0.0.1:1/v1" });
  const rpc = rpcClient(child);
  try {
    await rpc.request({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const r = await rpc.request({
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "grok-reply", arguments: { threadId: "does-not-exist", prompt: "x" } },
    });
    assert.equal(r.result.isError, true);
    assert.equal(r.result.errorKind, "unknown-thread");
  } finally {
    child.stdin.end();
  }
});

test("G4: timeout aborts the call and surfaces errorKind timeout", async () => {
  const { server, base } = await startMock((req, res) => {
    setTimeout(() => { try { reply(res, 200, { output: [{ content: [{ type: "output_text", text: "late" }] }] }); } catch (_) {} }, 5000);
  });
  const child = startGrokBridge({ XAI_API_KEY: "test", XAI_API_BASE: base });
  const rpc = rpcClient(child);
  try {
    await rpc.request({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const r = await rpc.request({
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "grok", arguments: { prompt: "slow", timeout: 300 } },
    });
    assert.equal(r.result.isError, true);
    assert.equal(r.result.errorKind, "timeout");
    assert.equal(r.result.retryable, true);
  } finally {
    child.stdin.end();
    server.close();
  }
});

test("G5: tools/list advertises grok + grok-reply, both with a files param", async () => {
  const child = startGrokBridge({ XAI_API_KEY: "test" });
  const rpc = rpcClient(child);
  try {
    const r = await rpc.request({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const tools = r.result.tools;
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    assert.deepEqual(Object.keys(byName).sort(), ["grok", "grok-reply"]);
    assert.ok(byName.grok.inputSchema.properties.files, "grok has files param");
    assert.ok(byName["grok-reply"].inputSchema.properties.files, "grok-reply has files param");
  } finally {
    child.stdin.end();
  }
});

test("G6: grok with files:[{file_id}] references it in input without uploading", async () => {
  let filesHits = 0;
  const bodies = [];
  const { server, base } = await startMock((req, res, body) => {
    if (req.method === "POST" && req.url === "/v1/files") { filesHits++; return reply(res, 200, { id: "should-not-happen" }); }
    if (req.method === "POST" && req.url === "/v1/responses") {
      bodies.push(JSON.parse(body));
      return reply(res, 200, { output: [{ content: [{ type: "output_text", text: "ok" }] }] });
    }
    return reply(res, 404, { error: "unexpected" });
  });
  const child = startGrokBridge({ XAI_API_KEY: "test", XAI_API_BASE: base });
  const rpc = rpcClient(child);
  try {
    await rpc.request({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const r = await rpc.request({
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "grok", arguments: { prompt: "review", files: [{ file_id: "file_abc" }] } },
    });
    assert.equal(r.result.isError, undefined);
    assert.equal(filesHits, 0, "no upload for an existing file_id");
    assert.deepEqual(lastUserContent(bodies[0]), [
      { type: "input_text", text: "review" },
      { type: "input_file", file_id: "file_abc" },
    ]);
  } finally {
    child.stdin.end();
    server.close();
  }
});

test("G7: grok with files:[{path}] uploads then references the returned file_id", async () => {
  const tmp = path.join(os.tmpdir(), `grok-up-${Date.now()}.txt`);
  fs.writeFileSync(tmp, "file body");
  const bodies = [];
  let filesHits = 0;
  const { server, base } = await startMock((req, res, body) => {
    if (req.method === "POST" && req.url === "/v1/files") {
      filesHits++;
      return reply(res, 200, { id: "file_up1", object: "file", bytes: 9, created_at: 1762345678, filename: "x", purpose: "assistants" });
    }
    if (req.method === "POST" && req.url === "/v1/responses") {
      bodies.push(JSON.parse(body));
      return reply(res, 200, { output: [{ content: [{ type: "output_text", text: "done" }] }] });
    }
    return reply(res, 404, { error: "unexpected" });
  });
  const child = startGrokBridge({ XAI_API_KEY: "test", XAI_API_BASE: base });
  const rpc = rpcClient(child);
  try {
    await rpc.request({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const r = await rpc.request({
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "grok", arguments: { prompt: "review", files: [{ path: tmp }], cwd: os.tmpdir() } },
    });
    assert.equal(r.result.isError, undefined);
    assert.equal(filesHits, 1);
    assert.deepEqual(r.result.uploadedFileIds, ["file_up1"]);
    assert.deepEqual(lastUserContent(bodies[0]), [
      { type: "input_text", text: "review" },
      { type: "input_file", file_id: "file_up1" },
    ]);
  } finally {
    child.stdin.end();
    server.close();
    fs.rmSync(tmp, { force: true });
  }
});

test("G8: a missing file path short-circuits with errorKind file-read", async () => {
  const child = startGrokBridge({ XAI_API_KEY: "test", XAI_API_BASE: "http://127.0.0.1:1/v1" });
  const rpc = rpcClient(child);
  try {
    await rpc.request({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const r = await rpc.request({
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "grok", arguments: { prompt: "x", files: [{ path: "/no/such/grok-file-xyz" }] } },
    });
    assert.equal(r.result.isError, true);
    assert.equal(r.result.errorKind, "file-read");
  } finally {
    child.stdin.end();
  }
});

// --- Unit tests (bridge required as a module) ---

const grok = require("../server/grok/index.js");

test("G9: classifyGrokError maps transport codes and HTTP statuses", () => {
  assert.deepEqual(grok.classifyGrokError(null, "missing-auth"), { errorKind: "missing-auth", retryable: false });
  assert.deepEqual(grok.classifyGrokError(null, "unknown-thread"), { errorKind: "unknown-thread", retryable: false });
  assert.deepEqual(grok.classifyGrokError(null, "timeout"), { errorKind: "timeout", retryable: true });
  assert.deepEqual(grok.classifyGrokError(null, "file-too-large"), { errorKind: "file-too-large", retryable: false });
  assert.deepEqual(grok.classifyGrokError(null, "file-read"), { errorKind: "file-read", retryable: false });
  assert.deepEqual(grok.classifyGrokError(null, "file-upload"), { errorKind: "file-upload", retryable: true });
  assert.deepEqual(grok.classifyGrokError(401), { errorKind: "auth", retryable: false });
  assert.deepEqual(grok.classifyGrokError(429), { errorKind: "rate-limit", retryable: true });
  assert.deepEqual(grok.classifyGrokError(503), { errorKind: "upstream", retryable: true });
  assert.deepEqual(grok.classifyGrokError(200), { errorKind: "unknown", retryable: false });
});

test("G10: buildInitialTurns + turnsToInput produce the responses input shape", () => {
  const turns = grok.buildInitialTurns("sys", "hi", [{ file_id: "f1" }, { file_url: "https://u/x" }]);
  assert.deepEqual(grok.turnsToInput(turns), [
    { role: "system", content: [{ type: "input_text", text: "sys" }] },
    {
      role: "user",
      content: [
        { type: "input_text", text: "hi" },
        { type: "input_file", file_id: "f1" },
        { type: "input_file", file_url: "https://u/x" },
      ],
    },
  ]);
  // No developer-instructions -> no system turn.
  assert.deepEqual(grok.buildInitialTurns("", "hi", []), [{ role: "user", text: "hi", fileRefs: [] }]);
});

test("G11: parseResponsesOutput handles output_text, nested output[], and malformed", () => {
  assert.equal(grok.parseResponsesOutput({ output_text: "quick" }), "quick");
  assert.equal(grok.parseResponsesOutput({ output: [{ content: [{ type: "output_text", text: "nested" }] }] }), "nested");
  assert.equal(grok.parseResponsesOutput({ output: [{ content: [{ type: "text", text: "alt" }] }] }), "alt");
  assert.throws(() => grok.parseResponsesOutput({}), /Parse error/);
  assert.throws(() => grok.parseResponsesOutput({ output: [] }), /Parse error/);
  assert.throws(() => grok.parseResponsesOutput({ output: [{ content: [{ type: "image" }] }] }), /Parse error/);
});

test("G12: validateFiles enforces exactly-one-of and types", () => {
  assert.equal(grok.validateFiles(undefined), null);
  assert.equal(grok.validateFiles([{ path: "a" }]), null);
  assert.equal(grok.validateFiles([{ file_id: "f" }]), null);
  assert.ok(grok.validateFiles("nope"));
  assert.ok(grok.validateFiles([{ path: "a", file_id: "b" }]));
  assert.ok(grok.validateFiles([{}]));
  assert.ok(grok.validateFiles([{ path: "" }]));
  assert.ok(grok.validateFiles([{ path: "a", filename: "" }]));
});

test("G13: runGrok posts to /responses via injected fetch (success, http error, missing key)", async () => {
  let calledUrl = null;
  const okFetch = async (url) => {
    calledUrl = url;
    return { ok: true, status: 200, text: async () => JSON.stringify({ output: [{ content: [{ type: "output_text", text: "ok" }] }] }) };
  };
  const out = await grok.runGrok({ turns: [{ role: "user", text: "x", fileRefs: [] }], apiKey: "k", apiBase: "https://api.x.ai/v1", fetchImpl: okFetch });
  assert.equal(out.text, "ok");
  assert.match(calledUrl, /\/responses$/);

  const errFetch = async () => ({ ok: false, status: 500, text: async () => "boom" });
  await assert.rejects(grok.runGrok({ turns: [], apiKey: "k", fetchImpl: errFetch }), (e) => e.status === 500);

  await assert.rejects(grok.runGrok({ turns: [], apiKey: "", fetchImpl: okFetch }), (e) => e.code === "missing-auth");
});

test("G14: uploadFile sends multipart with purpose, expires_after, and prefixed filename", async () => {
  const tmp = path.join(os.tmpdir(), `grok-unit-${Date.now()}.md`);
  fs.writeFileSync(tmp, "hello");
  let captured = null;
  const fetchImpl = async (url, opts) => {
    captured = { url, opts };
    return { ok: true, status: 200, text: async () => JSON.stringify({ id: "file_x", filename: "n" }) };
  };
  try {
    const res = await grok.uploadFile({ filePath: tmp, apiKey: "k", apiBase: "https://api.x.ai/v1", cwd: os.tmpdir(), fetchImpl });
    assert.equal(res.id, "file_x");
    assert.match(captured.url, /\/files$/);
    const form = captured.opts.body;
    assert.equal(form.get("purpose"), "assistants");
    assert.equal(form.get("expires_after"), String(grok.FILE_TTL_SECONDS));
    const filePart = form.get("file");
    assert.ok(filePart.name.startsWith(grok.FILE_PREFIX), `filename ${filePart.name} should carry the prefix`);
    assert.ok(filePart.name.endsWith(path.basename(tmp)));
    // No manual Content-Type (fetch sets the multipart boundary).
    assert.equal(captured.opts.headers["Content-Type"], undefined);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
});

test("G15: uploadFile rejects an oversize file with file-too-large", async () => {
  const tmp = path.join(os.tmpdir(), `grok-big-${Date.now()}.bin`);
  // Sparse 49 MB file: ftruncate sets size without writing 49 MB of data.
  const fd = fs.openSync(tmp, "w");
  fs.ftruncateSync(fd, 49 * 1024 * 1024);
  fs.closeSync(fd);
  try {
    await assert.rejects(
      grok.uploadFile({ filePath: tmp, apiKey: "k", cwd: os.tmpdir(), fetchImpl: async () => { throw new Error("should not reach fetch"); } }),
      (e) => e.code === "file-too-large"
    );
  } finally {
    fs.rmSync(tmp, { force: true });
  }
});

test("G19: uploadFile refuses a path outside cwd (no exfiltration, fetch never called)", async () => {
  const tmp = path.join(os.tmpdir(), `grok-out-${Date.now()}.txt`);
  fs.writeFileSync(tmp, "secret");
  try {
    await assert.rejects(
      grok.uploadFile({ filePath: tmp, apiKey: "k", cwd: __dirname, fetchImpl: async () => { throw new Error("should not reach fetch"); } }),
      (e) => e.code === "file-read"
    );
  } finally {
    fs.rmSync(tmp, { force: true });
  }
});

test("G20: resolveReasoningEffort defaults to high and honors overrides", () => {
  delete process.env.GROK_REASONING_EFFORT;
  assert.equal(grok.resolveReasoningEffort(undefined), "high");
  assert.equal(grok.resolveReasoningEffort("low"), "low");
  assert.equal(grok.resolveReasoningEffort("  high "), "high");
  assert.equal(grok.resolveReasoningEffort("none"), null);
  assert.equal(grok.resolveReasoningEffort("off"), null);
  assert.equal(grok.resolveReasoningEffort(""), null);
  process.env.GROK_REASONING_EFFORT = "medium";
  try {
    assert.equal(grok.resolveReasoningEffort(undefined), "medium");
    assert.equal(grok.resolveReasoningEffort("high"), "high"); // per-call wins over env
  } finally {
    delete process.env.GROK_REASONING_EFFORT;
  }
});

test("G21: reasoning_effort is sent (default high), overridable, and omittable", async () => {
  delete process.env.GROK_REASONING_EFFORT; // ensure the child inherits no override
  const bodies = [];
  const { server, base } = await startMock((req, res, body) => {
    if (req.method === "POST" && req.url === "/v1/responses") {
      bodies.push(JSON.parse(body));
      return reply(res, 200, { output: [{ content: [{ type: "output_text", text: "ok" }] }] });
    }
    return reply(res, 404, { error: "unexpected" });
  });
  const child = startGrokBridge({ XAI_API_KEY: "test", XAI_API_BASE: base });
  const rpc = rpcClient(child);
  try {
    await rpc.request({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await rpc.request({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "grok", arguments: { prompt: "a" } } });
    await rpc.request({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "grok", arguments: { prompt: "b", reasoning_effort: "low" } } });
    await rpc.request({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "grok", arguments: { prompt: "c", reasoning_effort: "none" } } });
    assert.equal(bodies[0].reasoning_effort, "high");
    assert.equal(bodies[1].reasoning_effort, "low");
    assert.equal("reasoning_effort" in bodies[2], false);
  } finally {
    child.stdin.end();
    server.close();
  }
});

// --- files-admin (cleanup) unit tests ---

const admin = require("../server/grok/files-admin.js");

test("G16: parseOlderThan understands s/m/h/d and plain seconds", () => {
  assert.equal(admin.parseOlderThan("30m"), 1800);
  assert.equal(admin.parseOlderThan("24h"), 86400);
  assert.equal(admin.parseOlderThan("7d"), 604800);
  assert.equal(admin.parseOlderThan("90"), 90);
  assert.equal(admin.parseOlderThan("0h"), 0);
  assert.throws(() => admin.parseOlderThan("soon"));
});

test("G17: selectPrunable keeps only prefixed files older than the cutoff", () => {
  const now = 1_000_000; // epoch seconds
  const files = [
    { id: "a", filename: "deliberation-1-old.txt", created_at: now - 1000 },   // prefixed + old -> prune
    { id: "b", filename: "deliberation-2-new.txt", created_at: now - 10 },     // prefixed + new -> keep
    { id: "c", filename: "user-doc.pdf", created_at: now - 100000 },               // not prefixed -> keep
  ];
  const out = admin.selectPrunable(files, { cutoffEpochSec: now - 100 });
  assert.deepEqual(out.map((f) => f.id), ["a"]);
  // Safety floor: even prefix "" can never select the non-bridge file "c".
  const all = admin.selectPrunable(files, { prefix: "", cutoffEpochSec: now });
  assert.deepEqual(all.map((f) => f.id), ["a", "b"]);
});

test("G18: prune lists, filters, and deletes only prunable ids when not a dry run", async () => {
  const nowMs = 2_000_000_000_000;
  const nowSec = Math.floor(nowMs / 1000);
  const deleted = [];
  const fetchImpl = async (url, opts) => {
    if (opts.method === "GET") {
      return { ok: true, status: 200, text: async () => JSON.stringify({
        data: [
          { id: "old", filename: "deliberation-x.txt", created_at: nowSec - 100000 },
          { id: "fresh", filename: "deliberation-y.txt", created_at: nowSec - 1 },
          { id: "theirs", filename: "report.pdf", created_at: 1 },
        ],
        pagination_token: null,
      }) };
    }
    if (opts.method === "DELETE") {
      deleted.push(decodeURIComponent(url.split("/files/")[1]));
      return { ok: true, status: 200, text: async () => JSON.stringify({ deleted: true }) };
    }
    return { ok: false, status: 405, text: async () => "no" };
  };
  const res = await admin.prune({ olderThanSec: 3600, apiKey: "k", apiBase: "https://api.x.ai/v1", fetchImpl, dryRun: false, now: nowMs });
  assert.deepEqual(res.candidates.map((f) => f.id), ["old"]);
  assert.deepEqual(deleted, ["old"]);

  // Dry run deletes nothing.
  deleted.length = 0;
  const dry = await admin.prune({ olderThanSec: 3600, apiKey: "k", apiBase: "https://api.x.ai/v1", fetchImpl, dryRun: true, now: nowMs });
  assert.deepEqual(dry.candidates.map((f) => f.id), ["old"]);
  assert.deepEqual(dry.deleted, []);
  assert.deepEqual(deleted, []);
});
