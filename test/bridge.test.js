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

test("A6: agy stdin is closed so print mode is not stalled waiting for EOF", async () => {
  // fake-agy-needs-stdin-eof.sh blocks on `cat` until stdin EOF, then prints.
  // The bridge must spawn agy with stdin /dev/null (not an open pipe) or this stalls.
  const child = startBridge({ fakeBin: "fake-agy-needs-stdin-eof.sh" });
  const responsesP = collectResponses(child);
  send(child, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  send(child, {
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "gemini", arguments: { prompt: "hi", timeout: 8000 } },
  });
  setTimeout(() => child.stdin.end(), 3000);
  const responses = await responsesP;
  const r = responses.find((x) => x.id === 2);
  assert.ok(r, "got tools/call response (no stdin-EOF stall)");
  assert.ok(!r.result.isError, "not an error: " + JSON.stringify(r.result));
  assert.equal(r.result.content[0].text, "STDIN EOF OK");
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

// --- advisory read-only enforcement (pure units; no spawn) ---

test("S1: buildAgyArgs prepends the read-only guard on advisory runs, not on workspace-write", () => {
  const { buildAgyArgs, READ_ONLY_GUARD } = require("../server/gemini/index.js");
  const ro = buildAgyArgs({ prompt: "hi" });
  const roPrompt = ro[ro.lastIndexOf("-p") + 1];
  assert.ok(roPrompt.startsWith(READ_ONLY_GUARD), "read-only prompt leads with the guard");

  const ww = buildAgyArgs({ prompt: "hi", sandbox: "workspace-write" });
  const wwPrompt = ww[ww.lastIndexOf("-p") + 1];
  assert.equal(wwPrompt, "hi", "workspace-write prompt is unguarded");
  assert.ok(ww.includes("--dangerously-skip-permissions"), "workspace-write maps to skip-perms");
});

test("S2: the guard sits OUTSIDE developerInstructions (outermost)", () => {
  const { buildAgyArgs, READ_ONLY_GUARD } = require("../server/gemini/index.js");
  const a = buildAgyArgs({ prompt: "Q", developerInstructions: "SYS" });
  const prompt = a[a.lastIndexOf("-p") + 1];
  assert.ok(prompt.startsWith(`SYS\n\n${READ_ONLY_GUARD}`), "dev instructions wrap the guarded prompt");
});

test("S3: advisoryEnv drops the kill-switch and scrubs push/exfil + credential-shaped env", () => {
  const { advisoryEnv } = require("../server/gemini/index.js");
  const out = advisoryEnv({
    DELIBERATION_DISABLE_OS_SANDBOX: "1",
    GITHUB_TOKEN: "ght", GH_TOKEN: "gh", GIT_ASKPASS: "x", SSH_AUTH_SOCK: "/sock",
    // Credential-shaped vars an advisory delegate has no need for. agy's own
    // Gemini auth lives in ~/.gemini (OAuth), NOT in GEMINI_API_KEY, so the
    // credential-name scrub correctly drops API_KEY-shaped vars too.
    GEMINI_API_KEY: "drop", PATH: "/usr/bin", HOME: "/Users/x", LANG: "en_US.UTF-8",
  });
  assert.equal("DELIBERATION_DISABLE_OS_SANDBOX" in out, false);
  for (const k of ["GITHUB_TOKEN", "GH_TOKEN", "GIT_ASKPASS", "SSH_AUTH_SOCK", "GEMINI_API_KEY"]) {
    assert.equal(k in out, false, `${k} scrubbed`);
  }
  assert.equal(out.PATH, "/usr/bin", "PATH preserved");
  assert.equal(out.HOME, "/Users/x", "HOME preserved");
  assert.equal(out.LANG, "en_US.UTF-8", "locale preserved");
});

test("S4: buildSpawnCommand wraps in sandbox-exec on darwin read-only with sandbox-exec present", () => {
  const { buildSpawnCommand } = require("../server/gemini/index.js");
  const r = buildSpawnCommand({
    bin: "agy", args: ["--sandbox", "-p", "hi"], readOnly: true,
    platform: "darwin", home: "/Users/x", tmpdir: "/private/var/folders/zz",
    sandboxExecPath: "/usr/bin/sandbox-exec",
  });
  assert.equal(r.osSandbox, true);
  assert.equal(r.cmd, "/usr/bin/sandbox-exec");
  assert.equal(r.argv[0], "-p");
  assert.ok(/\(deny file-write\*\)/.test(r.argv[1]), "profile denies file writes");
  assert.ok(r.argv[1].includes('(subpath "/Users/x/.gemini")'), "profile allows ~/.gemini writes");
  assert.ok(r.argv[1].includes('(subpath "/private/var/folders/zz")'), "profile allows tmpdir writes");
  assert.deepEqual(r.argv.slice(2), ["agy", "--sandbox", "-p", "hi"], "agy argv preserved as tail");
});

test("S5: buildSpawnCommand stays unwrapped when not eligible (not read-only / linux / disabled / no sandbox-exec)", () => {
  const { buildSpawnCommand } = require("../server/gemini/index.js");
  const base = { bin: "agy", args: ["-p", "hi"], home: "/Users/x", tmpdir: "/tmp", platform: "darwin", sandboxExecPath: "/usr/bin/sandbox-exec" };
  assert.equal(buildSpawnCommand({ ...base, readOnly: false }).osSandbox, false);
  assert.equal(buildSpawnCommand({ ...base, readOnly: true, platform: "linux" }).osSandbox, false);
  assert.equal(buildSpawnCommand({ ...base, readOnly: true, disabled: true }).osSandbox, false);
  assert.equal(buildSpawnCommand({ ...base, readOnly: true, sandboxExecPath: null }).osSandbox, false);
  const u = buildSpawnCommand({ ...base, readOnly: false });
  assert.equal(u.cmd, "agy");
  assert.deepEqual(u.argv, ["-p", "hi"]);
});

test("S6: a home path with a quote is escaped into the seatbelt literal", () => {
  const { buildSeatbeltProfile } = require("../server/gemini/index.js");
  const prof = buildSeatbeltProfile({ home: '/Users/a"b', tmpdir: "/tmp" });
  assert.ok(prof.includes('(subpath "/Users/a\\"b/.gemini")'), "quote in path is backslash-escaped");
});

test("S7: diffGitState flags HEAD or status changes, ignores null snapshots", () => {
  const { diffGitState } = require("../server/gemini/index.js");
  assert.equal(diffGitState({ head: "a", status: "" }, { head: "a", status: "" }), false);
  assert.equal(diffGitState({ head: "a", status: "" }, { head: "b", status: "" }), true);
  assert.equal(diffGitState({ head: "a", status: "" }, { head: "a", status: " M f\n" }), true);
  assert.equal(diffGitState(null, { head: "a", status: "" }), false, "unavailable pre -> no detection");
  assert.equal(diffGitState({ head: "a", status: "" }, null), false, "unavailable post -> no detection");
});

// --- git mutation detection (integration; OS sandbox disabled via helper default) ---

test("S8: an advisory run that writes into the consulted repo is flagged workspaceMutated + warned", { skip: !hasGit() }, async () => {
  const repo = makeGitRepo();
  const child = startBridge({ fakeBin: "fake-agy-mutates.sh" });
  const responsesP = collectResponses(child);
  send(child, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  send(child, {
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "gemini", arguments: { prompt: "advise", cwd: repo } },
  });
  setTimeout(() => child.stdin.end(), 1500);
  const responses = await responsesP;

  const r = responses.find((x) => x.id === 2);
  assert.ok(r && r.result, "got a result");
  assert.equal(r.result.workspaceMutated, true, "mutation surfaced on the result");
  assert.ok(/WORKSPACE MUTATION DETECTED/.test(r.result.content[0].text), "warning prepended to text");
});

test("S9: a clean advisory run carries no workspaceMutated flag", { skip: !hasGit() }, async () => {
  const repo = makeGitRepo();
  const child = startBridge({ fakeBin: "fake-agy.sh" });
  const responsesP = collectResponses(child);
  send(child, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  send(child, {
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "gemini", arguments: { prompt: "advise", cwd: repo } },
  });
  setTimeout(() => child.stdin.end(), 1500);
  const responses = await responsesP;

  const r = responses.find((x) => x.id === 2);
  assert.ok(r && r.result, "got a result");
  assert.equal("workspaceMutated" in r.result, false, "no mutation flag on a clean run");
});

function hasGit() {
  try { require("node:child_process").execFileSync("git", ["--version"], { stdio: "ignore" }); return true; }
  catch (_) { return false; }
}

function makeGitRepo() {
  const { execFileSync } = require("node:child_process");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cdg-repo-"));
  const opts = { cwd: dir, stdio: "ignore" };
  execFileSync("git", ["init"], opts);
  execFileSync("git", ["config", "user.email", "t@t.t"], opts);
  execFileSync("git", ["config", "user.name", "t"], opts);
  fs.writeFileSync(path.join(dir, "seed.txt"), "seed");
  execFileSync("git", ["add", "."], opts);
  execFileSync("git", ["commit", "-m", "seed"], opts);
  return dir;
}
