"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { startBridge, send, collectResponses, readArgv } = require("./_helpers.js");

// --- argv mapping ---

test("A1: default call -> argv has --sandbox, -p, --print-timeout; not -m/-o", async () => {
  const child = startBridge({ fakeBin: "fake-agy.sh" });
  const responsesP = collectResponses(child);
  send(child, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  send(child, {
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "gemini", arguments: { prompt: "hi" } },
  });
  setTimeout(() => child.stdin.end(), 1000);
  await responsesP;

  const argv = readArgv(child.argvLog)[0];
  assert.ok(argv, "captured an agy invocation");
  assert.ok(argv.includes("--sandbox"), "read-only default maps to --sandbox");
  assert.ok(argv.includes("-p"), "argv contains -p");
  assert.ok(argv.includes("--print-timeout"), "argv contains --print-timeout");
  assert.ok(!argv.includes("-m"), "argv does NOT contain -m");
  assert.ok(!argv.includes("-o"), "argv does NOT contain -o");
  assert.ok(!argv.includes("--dangerously-skip-permissions"), "no skip-perms on read-only");
});

test("A2: workspace-write -> --dangerously-skip-permissions (no --sandbox)", async () => {
  const child = startBridge({ fakeBin: "fake-agy.sh" });
  const responsesP = collectResponses(child);
  send(child, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  send(child, {
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "gemini", arguments: { prompt: "hi", sandbox: "workspace-write" } },
  });
  setTimeout(() => child.stdin.end(), 1000);
  await responsesP;

  const argv = readArgv(child.argvLog)[0];
  assert.ok(argv.includes("--dangerously-skip-permissions"), "workspace-write maps to --dangerously-skip-permissions");
  assert.ok(!argv.includes("--sandbox"), "workspace-write does NOT add --sandbox");
});

test("A3: include-directories -> repeated --add-dir", async () => {
  const child = startBridge({ fakeBin: "fake-agy.sh" });
  const responsesP = collectResponses(child);
  send(child, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  send(child, {
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "gemini", arguments: { prompt: "hi", "include-directories": ["/a", "/b"] } },
  });
  setTimeout(() => child.stdin.end(), 1000);
  await responsesP;

  const argv = readArgv(child.argvLog)[0];
  const addDirCount = argv.filter((a) => a === "--add-dir").length;
  assert.equal(addDirCount, 2, "two --add-dir flags");
  assert.ok(argv.includes("/a"), "first dir present");
  assert.ok(argv.includes("/b"), "second dir present");
  assert.ok(!argv.includes("--include-directories"), "no legacy --include-directories flag");
});

test("A5: gemini-reply -> --conversation <threadId>", async () => {
  const child = startBridge({ fakeBin: "fake-agy.sh" });
  const responsesP = collectResponses(child);
  send(child, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  send(child, {
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "gemini-reply", arguments: { threadId: "abc", prompt: "follow up" } },
  });
  setTimeout(() => child.stdin.end(), 1000);
  await responsesP;

  const argv = readArgv(child.argvLog)[0];
  const idx = argv.indexOf("--conversation");
  assert.notEqual(idx, -1, "argv contains --conversation");
  assert.equal(argv[idx + 1], "abc", "conversation id follows the flag");
});

// --- output handling ---

test("O1: plain stdout -> content text + conversation-id threadId", async () => {
  const convFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cdg-conv-")), "last_conversations.json");
  const child = startBridge({
    fakeBin: "fake-agy.sh",
    env: { AGY_LAST_CONVERSATIONS: convFile },
  });
  const responsesP = collectResponses(child);
  send(child, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  send(child, {
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "gemini", arguments: { prompt: "hi" } },
  });
  setTimeout(() => child.stdin.end(), 1500);
  const responses = await responsesP;
  const r = responses.find((x) => x.id === 2);
  assert.ok(r, "got tools/call response");
  assert.ok(!r.result.isError, "not an error: " + JSON.stringify(r.result));
  assert.equal(r.result.content[0].text, "FAKE AGY OK");
  assert.equal(r.result.threadId, "11111111-2222-3333-4444-555555555555");
});

test("O2: stdout Error: sentinel (exit 0) -> isError, errorKind timeout", async () => {
  const child = startBridge({ fakeBin: "fake-agy-error.sh" });
  const responsesP = collectResponses(child);
  send(child, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  send(child, {
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "gemini", arguments: { prompt: "deep" } },
  });
  setTimeout(() => child.stdin.end(), 1500);
  const responses = await responsesP;
  const r = responses.find((x) => x.id === 2);
  assert.equal(r.result.isError, true, "isError");
  assert.equal(r.result.errorKind, "timeout", "stdout 'Error: timed out' -> timeout");
});

test("O3: stderr failure -> isError, stderr wins over stdout banner", async () => {
  const child = startBridge({ fakeBin: "fake-agy-stderr-fail.sh" });
  const responsesP = collectResponses(child);
  send(child, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  send(child, {
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "gemini", arguments: { prompt: "hi" } },
  });
  setTimeout(() => child.stdin.end(), 1500);
  const responses = await responsesP;
  const r = responses.find((x) => x.id === 2);
  assert.equal(r.result.isError, true, "isError");
  // classifier no longer special-cases trust text -> unknown kind.
  assert.equal(r.result.errorKind, "unknown", "classified from stderr text");
  const text = r.result.content[0].text;
  assert.ok(text.includes("trust check failed"), "stderr text surfaced");
  assert.ok(!text.includes("agy config banner"), "stdout banner not surfaced");
});

// --- timeout-recovery (stdout drain) ---

test("R-A: drain completes -> recovered:true with final answer", async () => {
  const child = startBridge({
    fakeBin: "fake-agy-timeout-recover.sh",
    env: { FAKE_AGY_SLEEP: "3" },
  });
  const responsesP = collectResponses(child);
  send(child, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  send(child, {
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "gemini", arguments: { prompt: "deep", timeout: 800, "recovery-grace": 6000 } },
  });
  setTimeout(() => child.stdin.end(), 9000);
  const responses = await responsesP;
  const r = responses.find((x) => x.id === 2);
  assert.ok(r, "got tools/call response");
  assert.ok(!r.result.isError, "not an error: " + JSON.stringify(r.result));
  assert.equal(r.result.recovered, true, "recovered flag");
  assert.equal(r.result.content[0].text, "RECOVERED ANSWER OK");
});

test("R-B: drain exceeds grace -> timeout, no recovered flag", async () => {
  const child = startBridge({
    fakeBin: "fake-agy-timeout-recover.sh",
    env: { FAKE_AGY_SLEEP: "20" },
  });
  const responsesP = collectResponses(child);
  send(child, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  send(child, {
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "gemini", arguments: { prompt: "deep", timeout: 500, "recovery-grace": 1500 } },
  });
  setTimeout(() => child.stdin.end(), 6000);
  const responses = await responsesP;
  const r = responses.find((x) => x.id === 2);
  assert.equal(r.result.isError, true, "isError");
  assert.equal(r.result.errorKind, "timeout", "errorKind timeout");
  assert.ok(!JSON.stringify(r.result).includes("recovered"), "no recovered field in JSON");
});

test("B8b: GEMINI_DISABLE_TIMEOUT_RECOVERY=1 keeps legacy timeout", async () => {
  const child = startBridge({
    fakeBin: "fake-agy-timeout-recover.sh",
    env: { FAKE_AGY_SLEEP: "20", GEMINI_DISABLE_TIMEOUT_RECOVERY: "1" },
  });
  const responsesP = collectResponses(child);
  send(child, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  send(child, {
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "gemini", arguments: { prompt: "deep", timeout: 500, "recovery-grace": 10000 } },
  });
  setTimeout(() => child.stdin.end(), 5000);
  const responses = await responsesP;
  const r = responses.find((x) => x.id === 2);
  assert.equal(r.result.isError, true);
  assert.equal(r.result.errorKind, "timeout");
  assert.equal(r.result.retryable, true);
});

// Resolve as soon as the response for `id` arrives, so timing assertions measure
// response latency rather than the long-running stdin server's close time.
function awaitResponse(child, id) {
  return new Promise((resolve) => {
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d.toString();
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try { const o = JSON.parse(line); if (o.id === id) resolve(o); } catch (_) {}
      }
    });
    child.on("close", () => resolve(null));
  });
}

test("R-C: grace=0 hard timeout kills agy via SIGTERM/SIGKILL (no wait-for-exit)", async () => {
  const child = startBridge({ fakeBin: "fake-agy-slow.sh" });
  const got2 = awaitResponse(child, 2);
  const t0 = Date.now();
  send(child, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  send(child, {
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "gemini", arguments: { prompt: "slow", timeout: 500, "recovery-grace": 0 } },
  });
  const r = await got2;
  const elapsed = Date.now() - t0;
  child.stdin.end();
  child.kill();

  assert.ok(r, "got tools/call response");
  assert.equal(r.result.isError, true, "isError");
  assert.equal(r.result.errorKind, "timeout", "errorKind timeout");
  assert.equal(r.result.retryable, true, "retryable");
  // fake-agy-slow.sh sleeps 30s; the legacy kill path must return far sooner,
  // proving SIGTERM/SIGKILL fired rather than waiting for the child to exit.
  assert.ok(elapsed < 5000, "returned before the fixture's 30s sleep, got " + elapsed + "ms");
});

test("R-D: drain-window failure (stdout Error: during drain) -> timeout, not recovered", async () => {
  const child = startBridge({
    fakeBin: "fake-agy-slow-error.sh",
    env: { FAKE_AGY_SLEEP: "3" },
  });
  const got2 = awaitResponse(child, 2);
  send(child, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  send(child, {
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "gemini", arguments: { prompt: "deep", timeout: 500, "recovery-grace": 6000 } },
  });
  const r = await got2;
  child.stdin.end();
  child.kill();
  assert.ok(r, "got tools/call response");
  assert.equal(r.result.isError, true, "isError");
  assert.equal(r.result.errorKind, "timeout", "drain-window failure classified as timeout");
  const blob = JSON.stringify(r.result);
  assert.ok(!blob.includes("recovered"), "no recovered field in JSON");
  assert.ok(!blob.includes("partial answer so far"), "partial text not returned as a successful answer");
});

// --- reply guards ---

test("G1: gemini-reply threadId 'unknown' -> -32602", async () => {
  const child = startBridge({ fakeBin: "fake-agy.sh" });
  const responsesP = collectResponses(child);
  send(child, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  send(child, {
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "gemini-reply", arguments: { threadId: "unknown", prompt: "x" } },
  });
  setTimeout(() => child.stdin.end(), 1000);
  const responses = await responsesP;
  const r = responses.find((x) => x.id === 2);
  assert.equal(r.error && r.error.code, -32602);
});

test("G2: gemini-reply threadId 'latest' -> -32602", async () => {
  const child = startBridge({ fakeBin: "fake-agy.sh" });
  const responsesP = collectResponses(child);
  send(child, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  send(child, {
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "gemini-reply", arguments: { threadId: "latest", prompt: "x" } },
  });
  setTimeout(() => child.stdin.end(), 1000);
  const responses = await responsesP;
  const r = responses.find((x) => x.id === 2);
  assert.equal(r.error && r.error.code, -32602);
});

test("G3: gemini-reply threadId '' -> -32602", async () => {
  const child = startBridge({ fakeBin: "fake-agy.sh" });
  const responsesP = collectResponses(child);
  send(child, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  send(child, {
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "gemini-reply", arguments: { threadId: "   ", prompt: "x" } },
  });
  setTimeout(() => child.stdin.end(), 1000);
  const responses = await responsesP;
  const r = responses.find((x) => x.id === 2);
  assert.equal(r.error && r.error.code, -32602);
});

// --- model param accepted but not passed to argv ---

test("M1: model param accepted, never reaches argv", async () => {
  const child = startBridge({ fakeBin: "fake-agy.sh" });
  const responsesP = collectResponses(child);
  send(child, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  send(child, {
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "gemini", arguments: { prompt: "hi", model: "auto-gemini-3" } },
  });
  setTimeout(() => child.stdin.end(), 1000);
  const responses = await responsesP;
  const r = responses.find((x) => x.id === 2);
  assert.ok(!r.error, "model accepted");
  const argv = readArgv(child.argvLog)[0];
  assert.ok(!argv.includes("auto-gemini-3"), "model value not in argv");
  assert.ok(!argv.includes("-m"), "no -m flag");
});

test("M1: model empty string -> -32602", async () => {
  const child = startBridge({ fakeBin: "fake-agy.sh" });
  const responsesP = collectResponses(child);
  send(child, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  send(child, {
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "gemini", arguments: { prompt: "hi", model: "   " } },
  });
  setTimeout(() => child.stdin.end(), 1000);
  const responses = await responsesP;
  const r = responses.find((x) => x.id === 2);
  assert.equal(r.error && r.error.code, -32602);
});

// --- pure classifier units (no spawn) ---

test("C2: classifyGeminiError preserves timeout / parse / missing-cli / abort", () => {
  const { classifyGeminiError } = require("../server/gemini/index.js");
  assert.deepEqual(classifyGeminiError("anything", "timeout"), { errorKind: "timeout", retryable: true });
  assert.deepEqual(classifyGeminiError("anything", "parse"),   { errorKind: "parse",   retryable: false });
  const missing = classifyGeminiError("Antigravity CLI (agy) not found", null);
  assert.equal(missing.errorKind, "missing-cli");
  assert.equal(missing.retryable, false);
  const abort = classifyGeminiError("AbortError: signal aborted", null);
  assert.equal(abort.errorKind, "upstream-abort");
  assert.equal(abort.retryable, true);
});

test("C3: classifyGeminiError falls back to unknown for unrelated text", () => {
  const { classifyGeminiError } = require("../server/gemini/index.js");
  const r = classifyGeminiError("network blip", null);
  assert.equal(r.errorKind, "unknown");
  assert.equal(r.retryable, false);
  assert.equal(r.hint, undefined);
  assert.equal(classifyGeminiError(null, null).errorKind, "unknown");
  assert.equal(classifyGeminiError(undefined, null).errorKind, "unknown");
});

// --- resolveConversationId unit (exported) ---

test("C4: resolveConversationId reads cwd->id map, returns null on miss", () => {
  const { resolveConversationId } = require("../server/gemini/index.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cdg-rc-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cdg-rc-cwd-"));
  const mapFile = path.join(dir, "last_conversations.json");
  const real = fs.realpathSync(cwd);
  fs.writeFileSync(mapFile, JSON.stringify({ [real]: "id-xyz" }));
  const prev = process.env.AGY_LAST_CONVERSATIONS;
  process.env.AGY_LAST_CONVERSATIONS = mapFile;
  try {
    assert.equal(resolveConversationId(cwd), "id-xyz");
    assert.equal(resolveConversationId("/no/such/dir/anywhere"), null);
  } finally {
    if (prev === undefined) delete process.env.AGY_LAST_CONVERSATIONS;
    else process.env.AGY_LAST_CONVERSATIONS = prev;
  }
});
