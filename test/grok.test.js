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
    // Transport tests reply with one-word fixtures; the answer floor has its own tests (GF*).
    env: { ...process.env, GROK_MIN_ANSWER_CHARS: "0", ...env },
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
      { role: "system", content: [{ type: "input_text", text: `sys\n\n${grok.NO_TOOLS_NOTE}` }] },
      { role: "user", content: [{ type: "input_text", text: "hello" }] },
    ]);
    assert.deepEqual(bodies[1].input, [
      { role: "system", content: [{ type: "input_text", text: `sys\n\n${grok.NO_TOOLS_NOTE}` }] },
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
    { role: "system", content: [{ type: "input_text", text: `sys\n\n${grok.NO_TOOLS_NOTE}` }] },
    {
      role: "user",
      content: [
        { type: "input_text", text: "hi" },
        { type: "input_file", file_id: "f1" },
        { type: "input_file", file_url: "https://u/x" },
      ],
    },
  ]);
  // No developer-instructions -> the system turn still carries the no-tools note.
  assert.deepEqual(grok.buildInitialTurns("", "hi", []), [
    { role: "system", text: grok.NO_TOOLS_NOTE },
    { role: "user", text: "hi", fileRefs: [] },
  ]);
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

const REAL_ANSWER = "The change is safe: one file, two callers, and the existing tests cover both paths. VERDICT: APPROVE";

test("G13: runGrok posts to /responses via injected fetch (success, http error, missing key)", async () => {
  let calledUrl = null;
  let calledOpts = null;
  const okFetch = async (url, opts) => {
    calledUrl = url;
    calledOpts = opts;
    return { ok: true, status: 200, text: async () => JSON.stringify({ output: [{ content: [{ type: "output_text", text: REAL_ANSWER }] }] }) };
  };
  const out = await grok.runGrok({ turns: [{ role: "user", text: "x", fileRefs: [] }], apiKey: "k", apiBase: "https://api.x.ai/v1", fetchImpl: okFetch });
  assert.equal(out.text, REAL_ANSWER);
  assert.match(calledUrl, /\/responses$/);
  assert.equal(calledOpts.redirect, "error", "redirect:error prevents the bearer token following a 3xx to another host");

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

// --- Answer floor: an announced-intent stub is an error, not an answer ---

const STUB_TEXT = "I'll verify the cited files and edit anchors so the review is based on what's actually in the repo.";
const responsesFetch = (text) => async () => ({
  ok: true, status: 200,
  text: async () => JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text }] }] }),
});
const runWithText = (text) => grok.runGrok({ turns: [{ role: "user", text: "x", fileRefs: [] }], apiKey: "k", apiBase: "https://api.x.ai/v1", fetchImpl: responsesFetch(text) });

test("GF1: runGrok rejects an announced-intent stub (\"I'll verify...\") as code=empty", async () => {
  await assert.rejects(runWithText(STUB_TEXT), (e) => e.code === "empty" && /stub/i.test(e.message));
});

test("GF2: runGrok rejects an empty message as code=empty (not a silent success)", async () => {
  await assert.rejects(runWithText(""), (e) => e.code === "empty");
  await assert.rejects(runWithText("   "), (e) => e.code === "empty");
});

test("GF3: runGrok accepts a real answer, including a short non-intent one above the floor", async () => {
  const long = "**Summary**: the plan is complete.\n\n**Critical issues**: none.\n\nVERDICT: APPROVE".repeat(3);
  assert.equal((await runWithText(long)).text, long);
  const short = "VERDICT: APPROVE - the plan names files, has executable checks, and no blocking gaps remain.";
  assert.equal((await runWithText(short)).text, short);
});

test("GF4: a long answer that merely opens with \"I'll\" is not a stub", async () => {
  const long = "I'll be direct: the plan is sound. " + "Every task names a starting file and an executable check. ".repeat(8) + "VERDICT: APPROVE";
  assert.equal((await runWithText(long)).text, long);
});

test("GF5: GROK_MIN_ANSWER_CHARS=0 disables the floor entirely", async () => {
  process.env.GROK_MIN_ANSWER_CHARS = "0";
  try {
    assert.equal((await runWithText(STUB_TEXT)).text, STUB_TEXT);
    assert.equal((await runWithText("")).text, "");
  } finally {
    delete process.env.GROK_MIN_ANSWER_CHARS;
  }
});

test("GF6: classifyGrokError maps code=empty to a retryable empty", () => {
  assert.deepEqual(grok.classifyGrokError(null, "empty"), { errorKind: "empty", retryable: true });
});

test("GF7: buildInitialTurns always seeds a system turn that tells the model it has no tools", () => {
  const withSys = grok.buildInitialTurns("sys", "hi", []);
  assert.equal(withSys[0].role, "system");
  assert.ok(withSys[0].text.startsWith("sys\n\n"), "developer-instructions come first");
  assert.match(withSys[0].text, /no tools/i);
  assert.match(withSys[0].text, /no further turns/i);
  const noSys = grok.buildInitialTurns(undefined, "hi", []);
  assert.equal(noSys[0].role, "system");
  assert.equal(noSys[0].text, grok.NO_TOOLS_NOTE);
});

// --- streaming ------------------------------------------------------------
// xAI sends nothing until a non-streaming answer is finished, and Node's fetch gives
// up after undici's 300s headersTimeout with no way to raise it - so every grok call
// that thought for over five minutes died at exactly 300s, misreported as `network`.
// Streaming puts the first byte on the wire in seconds and keeps the bridge's own
// AbortController as the only ceiling.

/** A fetch returning an SSE body built from the given frames, split at `chunkAt`. */
function sseFetch(frames, { chunkAt = 0, status = 200, eol = "\n", nameOnFrame = false } = {}) {
  const text = frames.map((f) => {
    const body = nameOnFrame ? { ...f, type: undefined } : f;
    const head = nameOnFrame && f.type ? `event: ${f.type}${eol}` : "";
    return `${head}data: ${JSON.stringify(body)}${eol}${eol}`;
  }).join("") + `data: [DONE]${eol}${eol}`;
  const bytes = new TextEncoder().encode(text);
  const pieces = chunkAt > 0
    ? [bytes.slice(0, chunkAt), bytes.slice(chunkAt)]
    : [bytes];
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h) => (h.toLowerCase() === "content-type" ? "text/event-stream" : null) },
    body: (async function* () { for (const p of pieces) yield p; })(),
    text: async () => text,
  });
}

const completed = (t) => ({
  type: "response.completed",
  response: { output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: t }] }], usage: { input_tokens: 11, output_tokens: 22 } },
});

test("GS1: a completed stream is parsed exactly like a non-streaming body", async () => {
  const out = await grok.runGrok({
    turns: [{ role: "user", text: "x", fileRefs: [] }], apiKey: "k",
    fetchImpl: sseFetch([{ type: "response.output_text.delta", delta: "The change" }, completed(REAL_ANSWER)]),
  });
  assert.equal(out.text, REAL_ANSWER, "the completion event wins over accumulated deltas");
  assert.deepEqual(out.usage, { promptTokens: 11, completionTokens: 22 });
  assert.ok(Array.isArray(out.output), "output is retained so grok-reply can replay it verbatim");
});

test("GS2: a stream that ends without a completion event falls back to the deltas", async () => {
  const half = REAL_ANSWER.slice(0, 40), rest = REAL_ANSWER.slice(40);
  const out = await grok.runGrok({
    turns: [], apiKey: "k",
    fetchImpl: sseFetch([
      { type: "response.output_text.delta", delta: half },
      { type: "response.output_text.delta", delta: rest },
    ]),
  });
  assert.equal(out.text, REAL_ANSWER);
});

test("GS3: SSE frames split across chunk boundaries still reassemble", async () => {
  const out = await grok.runGrok({
    turns: [], apiKey: "k",
    fetchImpl: sseFetch([completed(REAL_ANSWER)], { chunkAt: 25 }),
  });
  assert.equal(out.text, REAL_ANSWER);
});

test("GS4: a response.failed event is `upstream` (retryable), not a parse error", async () => {
  await assert.rejects(
    grok.runGrok({ turns: [], apiKey: "k", fetchImpl: sseFetch([{ type: "response.failed", response: { error: "model exploded" } }]) }),
    (e) => e.code === "upstream" && /model exploded/.test(e.message)
  );
  assert.deepEqual(grok.classifyGrokError(null, "upstream"), { errorKind: "upstream", retryable: true });
});

test("GS5: a clean but empty stream is `empty` (retryable), never `parse`", async () => {
  await assert.rejects(
    grok.runGrok({ turns: [], apiKey: "k", fetchImpl: sseFetch([{ type: "response.in_progress" }]) }),
    (e) => e.code === "empty"
  );
});

test("GS6: the answer floor still applies to an assembled stream", async () => {
  await assert.rejects(
    grok.runGrok({ turns: [], apiKey: "k", fetchImpl: sseFetch([completed("I'll verify the cited files now.")]) }),
    (e) => e.code === "empty"
  );
});

test("GS7: a JSON body on a 200 is still parsed, even though we asked to stream", async () => {
  // An upstream is free to ignore `stream:true`; branching on Content-Type rather than
  // on the request keeps that working instead of failing as an empty stream.
  let sent = null;
  const jsonFetch = async (url, opts) => {
    sent = JSON.parse(opts.body);
    return { ok: true, status: 200, headers: { get: () => "application/json" }, text: async () => JSON.stringify({ output_text: REAL_ANSWER }) };
  };
  const out = await grok.runGrok({ turns: [], apiKey: "k", fetchImpl: jsonFetch });
  assert.equal(out.text, REAL_ANSWER);
  assert.equal(sent.stream, true, "the request still asks for a stream");
});

test("GS8: an error status is read as a plain body, not as SSE", async () => {
  const errFetch = async () => ({ ok: false, status: 503, headers: { get: () => "text/event-stream" }, text: async () => "upstream down" });
  await assert.rejects(grok.runGrok({ turns: [], apiKey: "k", fetchImpl: errFetch }), (e) => e.status === 503 && /upstream down/.test(e.message));
});

test("GS9: a CRLF-delimited stream is framed correctly", async () => {
  // The SSE spec allows CR, LF or CRLF, and any proxy may rewrite line endings.
  // Splitting on "\n\n" alone never matched "\r\n\r\n", so the buffer grew to hold the
  // whole response and the end-of-stream flush handed every concatenated payload to one
  // JSON.parse - turning a perfectly good answer into an empty stream.
  const out = await grok.runGrok({
    turns: [], apiKey: "k",
    fetchImpl: sseFetch([completed(REAL_ANSWER)], { eol: "\r\n" }),
  });
  assert.equal(out.text, REAL_ANSWER);
});

test("GS10: events named only on the SSE `event:` line are still recognized", async () => {
  // Relying on the JSON `type` alone meant a server that names events the spec's way
  // matched nothing at all, and every call failed as an empty stream.
  const out = await grok.runGrok({
    turns: [], apiKey: "k",
    fetchImpl: sseFetch([completed(REAL_ANSWER)], { nameOnFrame: true }),
  });
  assert.equal(out.text, REAL_ANSWER);
});

test("GS11: `response.incomplete` keeps the partial answer instead of throwing", async () => {
  // A truncated answer (max tokens, content filter) came back usable on the
  // non-streaming path; treating it as a failure discarded output already paid for.
  const partial = REAL_ANSWER.slice(0, 90);
  const out = await grok.runGrok({
    turns: [], apiKey: "k",
    fetchImpl: sseFetch([{ type: "response.incomplete", response: { output_text: partial } }]),
  });
  assert.equal(out.text, partial);
});

test("GS12: an unparseable completion event falls back to the accumulated deltas", async () => {
  // `final || deltas` picked a completion event whose output we could not read, and
  // parseResponsesOutput then threw a NON-retryable `parse` while the whole answer sat
  // unused in the deltas.
  const out = await grok.runGrok({
    turns: [], apiKey: "k",
    fetchImpl: sseFetch([
      { type: "response.output_text.delta", delta: REAL_ANSWER },
      { type: "response.completed", response: { output: [] } },
    ]),
  });
  assert.equal(out.text, REAL_ANSWER);
});

test("GS13: whitespace-only deltas are `empty` (retryable), not `parse`", async () => {
  await assert.rejects(
    grok.runGrok({ turns: [], apiKey: "k", fetchImpl: sseFetch([{ type: "response.output_text.delta", delta: "   \n" }]) }),
    (e) => e.code === "empty"
  );
});

test("GS14: a stream we do not understand retries once WITHOUT streaming", async () => {
  // The one real hazard of streaming by default: if the event vocabulary drifts, every
  // call fails and /consensus silently circuit-breaks Grok off the panel. Degrade to the
  // old behavior instead.
  const sent = [];
  const fetchImpl = async (url, opts) => {
    sent.push(JSON.parse(opts.body).stream);
    if (sent.length === 1) {
      const text = 'data: {"kind":"something-we-do-not-know"}\n\n';
      return {
        ok: true, status: 200,
        headers: { get: () => "text/event-stream" },
        body: (async function* () { yield new TextEncoder().encode(text); })(),
      };
    }
    return { ok: true, status: 200, headers: { get: () => "application/json" }, text: async () => JSON.stringify({ output_text: REAL_ANSWER }) };
  };
  const out = await grok.runGrok({ turns: [], apiKey: "k", fetchImpl });
  assert.equal(out.text, REAL_ANSWER);
  assert.deepEqual(sent, [true, false], "first call asks to stream, the fallback does not");
});

test("GS15: the no-stream fallback cannot recurse", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return { ok: true, status: 200, headers: { get: () => "application/json" }, text: async () => JSON.stringify({ output: [] }) };
  };
  await assert.rejects(grok.runGrok({ turns: [], apiKey: "k", fetchImpl }));
  assert.equal(calls, 1, "a non-streaming reply never re-enters the fallback");
});
