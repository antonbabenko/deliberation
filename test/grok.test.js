"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");

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

// Start a localhost mock of the xAI chat/completions endpoint.
function startMockXai(handler) {
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

test("G1: grok then grok-reply accumulates the transcript", async () => {
  const received = [];
  const { server, base } = await startMockXai((req, res, body) => {
    received.push(JSON.parse(body));
    const turn = received.length;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: `reply-${turn}` } }] }));
  });
  const child = startGrokBridge({ XAI_API_KEY: "test", XAI_API_BASE: base });
  const rpc = rpcClient(child);
  try {
    await rpc.request({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });

    const r1 = await rpc.request({
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "grok", arguments: { prompt: "hello", "developer-instructions": "sys" } },
    });
    assert.equal(r1.result.isError, undefined, "no error on first call");
    assert.equal(r1.result.content[0].text, "reply-1");
    const threadId = r1.result.threadId;
    assert.ok(threadId, "threadId returned");

    const r2 = await rpc.request({
      jsonrpc: "2.0", id: 3, method: "tools/call",
      params: { name: "grok-reply", arguments: { threadId, prompt: "again" } },
    });
    assert.equal(r2.result.content[0].text, "reply-2");
    assert.equal(r2.result.threadId, threadId, "same threadId preserved");

    assert.deepEqual(received[0].messages, [
      { role: "system", content: "sys" },
      { role: "user", content: "hello" },
    ]);
    assert.deepEqual(received[1].messages, [
      { role: "system", content: "sys" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "reply-1" },
      { role: "user", content: "again" },
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
    assert.equal(r.result.retryable, false);
  } finally {
    child.stdin.end();
  }
});

test("G4: timeout aborts the call and surfaces errorKind timeout", async () => {
  // Mock that delays past the call timeout so AbortController fires.
  const { server, base } = await startMockXai((req, res) => {
    setTimeout(() => {
      try {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "late" } }] }));
      } catch (_) {}
    }, 5000);
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

test("G5: tools/list advertises grok and grok-reply", async () => {
  const child = startGrokBridge({ XAI_API_KEY: "test" });
  const rpc = rpcClient(child);
  try {
    const r = await rpc.request({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const names = r.result.tools.map((t) => t.name);
    assert.deepEqual(names.sort(), ["grok", "grok-reply"]);
  } finally {
    child.stdin.end();
  }
});

// --- Pure-function unit tests (bridge required as a module) ---

test("G6: classifyGrokError maps transport codes and HTTP statuses", () => {
  const { classifyGrokError } = require("../server/grok/index.js");
  assert.deepEqual(classifyGrokError(null, "missing-auth"), { errorKind: "missing-auth", retryable: false });
  assert.deepEqual(classifyGrokError(null, "unknown-thread"), { errorKind: "unknown-thread", retryable: false });
  assert.deepEqual(classifyGrokError(null, "timeout"), { errorKind: "timeout", retryable: true });
  assert.deepEqual(classifyGrokError(null, "network"), { errorKind: "network", retryable: true });
  assert.deepEqual(classifyGrokError(null, "parse"), { errorKind: "parse", retryable: false });
  assert.deepEqual(classifyGrokError(401), { errorKind: "auth", retryable: false });
  assert.deepEqual(classifyGrokError(403), { errorKind: "auth", retryable: false });
  assert.deepEqual(classifyGrokError(429), { errorKind: "rate-limit", retryable: true });
  assert.deepEqual(classifyGrokError(503), { errorKind: "upstream", retryable: true });
  assert.deepEqual(classifyGrokError(200), { errorKind: "unknown", retryable: false });
});

test("G7: buildMessages adds system only when developer-instructions present", () => {
  const { buildMessages } = require("../server/grok/index.js");
  assert.deepEqual(buildMessages("sys", "p"), [
    { role: "system", content: "sys" },
    { role: "user", content: "p" },
  ]);
  assert.deepEqual(buildMessages("", "p"), [{ role: "user", content: "p" }]);
  assert.deepEqual(buildMessages(undefined, "p"), [{ role: "user", content: "p" }]);
});

test("G8: parseChatCompletion extracts content and throws on malformed", () => {
  const { parseChatCompletion } = require("../server/grok/index.js");
  assert.equal(parseChatCompletion({ choices: [{ message: { content: "hi" } }] }), "hi");
  assert.throws(() => parseChatCompletion({}), /Parse error/);
  assert.throws(() => parseChatCompletion({ choices: [] }), /Parse error/);
  assert.throws(() => parseChatCompletion({ choices: [{ message: {} }] }), /Parse error/);
});

test("G9: runGrok uses injected fetch (success, http error, missing key)", async () => {
  const { runGrok } = require("../server/grok/index.js");

  const okFetch = async () => ({
    ok: true, status: 200,
    text: async () => JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
  });
  assert.equal(
    await runGrok({ messages: [{ role: "user", content: "x" }], apiKey: "k", fetchImpl: okFetch }),
    "ok"
  );

  const errFetch = async () => ({ ok: false, status: 500, text: async () => "boom" });
  await assert.rejects(
    runGrok({ messages: [], apiKey: "k", fetchImpl: errFetch }),
    (e) => e.status === 500
  );

  await assert.rejects(
    runGrok({ messages: [], apiKey: "", fetchImpl: okFetch }),
    (e) => e.code === "missing-auth"
  );
});

// --- Process-lifecycle + observability tests (F2 / F3) ---

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Accumulate the child's stderr so we can assert on the F3 log lines and the
// F2 fatal-guard messages.
function collectStderr(child) {
  const ref = { text: "" };
  child.stderr.on("data", (d) => (ref.text += d.toString()));
  return ref;
}

// Resolve with the child's exit code (or signal) once it terminates.
function waitExit(child) {
  return new Promise((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });
}

test("G10: F3 emits one stderr correlation line per call; stdout stays JSON-RPC", async () => {
  const { server, base } = await startMockXai((req, res, body) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
  });
  const child = startGrokBridge({ XAI_API_KEY: "test", XAI_API_BASE: base });
  const rpc = rpcClient(child);
  const err = collectStderr(child);
  let stdout = "";
  child.stdout.on("data", (d) => (stdout += d.toString()));
  try {
    await rpc.request({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await rpc.request({
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "grok", arguments: { prompt: "hi" } },
    });
    await sleep(20); // let the finally-block stderr write flush
    assert.match(err.text, /^\[grok\] 2 grok -> ok in \d+ms$/m, "one ok correlation line for id 2");
    assert.equal(stdout.includes("[grok]"), false, "stdout never carries the log prefix");
  } finally {
    child.stdin.end();
    server.close();
  }
});

test("G11: F2 uncaughtException is logged with a stack and exits non-zero", async () => {
  // GROK_TEST_THROW_ASYNC schedules a real async throw ~30ms after start. After
  // an uncaught throw the process state is undefined, so the bridge logs and
  // exits 1 (the host then restarts it); it does NOT try to keep serving.
  const child = startGrokBridge({ XAI_API_KEY: "test", GROK_TEST_THROW_ASYNC: "1" });
  const err = collectStderr(child);
  const { code } = await waitExit(child);
  assert.equal(code, 1, "uncaught throw is fatal -> exit 1");
  assert.match(err.text, /fatal-guard uncaughtException:.*async boom/s);
});

test("G12: F2 stdin 'error' (broken pipe) exits 1", async () => {
  const child = startGrokBridge({ XAI_API_KEY: "test", GROK_TEST_EMIT_STDIN_ERROR: "1" });
  const err = collectStderr(child);
  const { code } = await waitExit(child);
  assert.equal(code, 1, "broken input pipe is terminal");
  assert.match(err.text, /stdin error \(input pipe broken\)/);
});

test("G13: F2 clean EOF drains an in-flight call, then exits 0", async () => {
  // Mock holds the response so EOF lands while the call is in flight.
  const { server, base } = await startMockXai((req, res) => {
    setTimeout(() => {
      try {
        // Connection: close so the bridge's HTTP socket dies after the response
        // and does not linger in the keep-alive pool, letting the process exit
        // promptly once stdin has ended.
        res.writeHead(200, { "content-type": "application/json", "connection": "close" });
        res.end(JSON.stringify({ choices: [{ message: { content: "slow-ok" } }] }));
      } catch (_) {}
    }, 200);
  });
  const child = startGrokBridge({ XAI_API_KEY: "test", XAI_API_BASE: base });
  const rpc = rpcClient(child);
  const exited = waitExit(child);
  try {
    await rpc.request({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const callPromise = rpc.request({
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "grok", arguments: { prompt: "slow" } },
    });
    await sleep(50);          // call is now in flight (mock not resolved yet)
    child.stdin.end();        // clean EOF arrives mid-call
    const r = await callPromise;
    assert.equal(r.result.content[0].text, "slow-ok", "in-flight response still delivered");
    const { code } = await exited;
    assert.equal(code, 0, "exits 0 after draining the in-flight call");
  } finally {
    server.close();
  }
});

test("G14: a final line with no trailing newline is flushed on EOF", async () => {
  const child = startGrokBridge({ XAI_API_KEY: "test" });
  const exited = waitExit(child);
  let resolve;
  const got = new Promise((r) => (resolve = r));
  let out = "";
  child.stdout.on("data", (d) => {
    out += d.toString();
    for (const line of out.split("\n")) {
      if (!line.trim()) continue;
      try { const m = JSON.parse(line); if (m.id === 1) resolve(m); } catch (_) {}
    }
  });
  // Write a complete request WITHOUT a trailing newline, then EOF. The bridge
  // must flush the buffered tail line before draining.
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }));
  child.stdin.end();
  const msg = await got;
  assert.ok(msg.result, "EOF-flushed initialize is still answered");
  const { code } = await exited;
  assert.equal(code, 0, "exits 0 cleanly after the flush");
});
