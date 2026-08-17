// test/core-codex.test.js
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { makeCodexProvider, codexExecArgs, buildSpawnPlan, classifyCodex } = require("../core/providers/codex.js");

test("CX5: codexExecArgs defaults to --sandbox read-only (advisory cannot inherit a writable global default)", () => {
  assert.deepEqual(codexExecArgs(), ["exec", "--sandbox", "read-only", "--skip-git-repo-check"]);
  assert.deepEqual(codexExecArgs("advisory"), ["exec", "--sandbox", "read-only", "--skip-git-repo-check"]);
});

test("CX-impl-1: codexExecArgs('implement') opts into --sandbox workspace-write", () => {
  assert.deepEqual(codexExecArgs("implement"), ["exec", "--sandbox", "workspace-write", "--skip-git-repo-check"]);
});

test("CX-impl-2: only the exact string 'implement' opens writes (gate is structural)", () => {
  for (const m of [undefined, "advisory", "workspace-write", "IMPLEMENT", "", "x"]) {
    assert.deepEqual(codexExecArgs(/** @type {any} */ (m))[2], "read-only", `mode=${String(m)} must stay read-only`);
  }
});

test("CX1: ask returns the captured stdout as text on exit 0", async () => {
  const p = makeCodexProvider({ run: async () => ({ code: 0, stdout: "codex says hi", stderr: "" }) });
  const r = await p.ask({ prompt: "hi" });
  assert.equal(r.isError, false);
  assert.equal(r.provider, "codex");
  assert.equal(r.text, "codex says hi");
});

test("CX2: a non-zero exit is a normalized error result", async () => {
  const p = makeCodexProvider({ run: async () => ({ code: 1, stdout: "", stderr: "auth required" }) });
  const r = await p.ask({ prompt: "x" });
  assert.equal(r.isError, true);
  assert.equal(r.errorKind, "auth");
});

test("CX3: capabilities.canImplement reflects the construction lock (default off)", () => {
  assert.equal(makeCodexProvider({ run: async () => ({ code: 0, stdout: "", stderr: "" }) }).capabilities.canImplement, false);
  assert.equal(makeCodexProvider({ allowImplement: true, run: async () => ({ code: 0, stdout: "", stderr: "" }) }).capabilities.canImplement, true);
});

test("CX-gate-deny: req.mode 'implement' WITHOUT the construction lock stays read-only", async () => {
  let seen;
  const run = async (/** @type {any} */ a) => { seen = a.mode; return { code: 0, stdout: "", stderr: "" }; };
  await makeCodexProvider({ run }).ask({ prompt: "x", mode: "implement" });
  assert.equal(seen, "advisory");
});

test("CX-gate-open: both locks (allowImplement + mode 'implement') forward implement to run", async () => {
  let seen;
  const run = async (/** @type {any} */ a) => { seen = a.mode; return { code: 0, stdout: "", stderr: "" }; };
  const p = makeCodexProvider({ allowImplement: true, run });
  await p.ask({ prompt: "x", mode: "implement" });
  assert.equal(seen, "implement");
  // lock on, but no mode -> still advisory
  await p.ask({ prompt: "x" });
  assert.equal(seen, "advisory");
});

test("CX-fs: capabilities.walksFilesystem is true (codex walks cwd under read-only)", () => {
  assert.equal(makeCodexProvider().capabilities.walksFilesystem, true);
});

test("CX4: a non-zero exit surfaces stdout in .message (diagnostic detail not lost; error has no text)", async () => {
  const p = makeCodexProvider({ run: async () => ({ code: 1, stdout: "diagnostic detail from codex", stderr: "boom" }) });
  const r = await p.ask({ prompt: "x" });
  assert.equal(r.isError, true);
  assert.equal(r.errorKind, "unknown");
  assert.equal("text" in r, false); // error results carry no text key
  assert.equal(/** @type {any} */ (r).message, "diagnostic detail from codex");
});

const { makeCodexProvider: mkCx, CODEX_DEFAULT_TIMEOUT_MS } = require("../core/providers/codex.js");

test("CX-timeout-1: ask passes the default timeout to run when the request carries none", async () => {
  let seen;
  const run = async (/** @type {any} */ a) => { seen = a.timeoutMs; return { code: 0, stdout: "ok", stderr: "" }; };
  await mkCx({ run }).ask({ prompt: "x" });
  assert.equal(seen, CODEX_DEFAULT_TIMEOUT_MS);
  assert.equal(CODEX_DEFAULT_TIMEOUT_MS, 600000);
});

test("CX-timeout-2: an explicit req.timeoutMs overrides the default", async () => {
  let seen;
  const run = async (/** @type {any} */ a) => { seen = a.timeoutMs; return { code: 0, stdout: "ok", stderr: "" }; };
  await mkCx({ run }).ask({ prompt: "x", timeoutMs: 12345 });
  assert.equal(seen, 12345);
});

test("CX-timeout-3: a construction-time opts.timeoutMs is used when the request carries none, and req still wins", async () => {
  let seen;
  const run = async (/** @type {any} */ a) => { seen = a.timeoutMs; return { code: 0, stdout: "ok", stderr: "" }; };
  const p = mkCx({ run, timeoutMs: 77000 });
  await p.ask({ prompt: "x" });
  assert.equal(seen, 77000);
  await p.ask({ prompt: "x", timeoutMs: 5000 });
  assert.equal(seen, 5000);
});

test("CX-timeout-1: a run killed by the timer classifies as timeout even with empty stderr", async () => {
  // A SIGKILL'd codex usually writes nothing, so stderr-substring classification would
  // report `unknown` - and a codex timeout that is not `timeout` can never trip the
  // consensus circuit breaker.
  const run = async () => ({ code: 1, stdout: "", stderr: "", timedOut: true });
  const r = await mkCx({ run }).ask({ prompt: "x" });
  assert.equal(r.isError, true);
  assert.equal(r.errorKind, "timeout");
  assert.equal(r.retryable, true);
});

test("CX-timeout-2: the kill flag beats a misleading stderr (\"author\" must not read as auth)", async () => {
  const run = async () => ({ code: 1, stdout: "", stderr: "reading author metadata", timedOut: true });
  const killed = /** @type {any} */ (await mkCx({ run }).ask({ prompt: "x" }));
  assert.equal(killed.errorKind, "timeout");
  // Same stderr WITHOUT the kill still goes through the substring classifier.
  const runNotKilled = async () => ({ code: 1, stdout: "", stderr: "reading author metadata", timedOut: false });
  const notKilled = /** @type {any} */ (await mkCx({ run: runNotKilled }).ask({ prompt: "x" }));
  assert.equal(notKilled.errorKind, "auth");
});

// --- Windows spawn resolution (issue #170) -----------------------------------
//
// `defaultRun` spawns a real process and cannot be unit-tested, so the platform
// DECISION lives in `buildSpawnPlan`, which is pure and fully injectable. That is the
// only way to assert Windows behaviour here: CI runs ubuntu-latest only.

const NODE_EXE = "C:\\Program Files\\nodejs\\node.exe";
const NPM_DIR = "C:\\Users\\t\\AppData\\Roaming\\npm";
const WIN_ENV = { PATH: NPM_DIR, PATHEXT: ".COM;.EXE;.BAT;.CMD" };
const CODEX_JS = `${NPM_DIR}\\node_modules\\@openai\\codex\\bin\\codex.js`;

test("CX-win-1: on darwin the plan is byte-identical to the pre-fix spawn (no behaviour change)", () => {
  const plan = buildSpawnPlan({ mode: "advisory", platform: "darwin", env: {} });
  assert.equal(plan.cmd, "codex");
  assert.deepEqual(plan.argv, codexExecArgs("advisory"));
  assert.equal(plan.shim, false);
});

test("CX-win-2: a win32 .cmd-only install spawns node against the npm entry, entry first in argv", () => {
  const plan = buildSpawnPlan({
    mode: "advisory",
    platform: "win32",
    env: WIN_ENV,
    exists: (p) => p === `${NPM_DIR}\\codex.cmd` || p === CODEX_JS,
    nodePath: NODE_EXE,
  });
  assert.equal(plan.cmd, NODE_EXE);
  // Order matters: `node <entry> exec --sandbox ...`, never the reverse.
  assert.deepEqual(plan.argv, [CODEX_JS, "exec", "--sandbox", "read-only", "--skip-git-repo-check"]);
  assert.equal(plan.shim, false);
});

test("CX-win-3: the implement sandbox flag survives the win32 rewrite", () => {
  const plan = buildSpawnPlan({
    mode: "implement",
    platform: "win32",
    env: WIN_ENV,
    exists: (p) => p === `${NPM_DIR}\\codex.cmd` || p === CODEX_JS,
    nodePath: NODE_EXE,
  });
  assert.deepEqual(plan.argv, [CODEX_JS, "exec", "--sandbox", "workspace-write", "--skip-git-repo-check"]);
});

test("CX-win-4: a shim with no npm entry is reported, not spawned", () => {
  const plan = buildSpawnPlan({
    platform: "win32",
    env: WIN_ENV,
    exists: (p) => p === `${NPM_DIR}\\codex.cmd`,
    nodePath: NODE_EXE,
  });
  assert.equal(plan.shim, true);
  assert.equal(plan.cmd, `${NPM_DIR}\\codex.cmd`);
});

test("CX-win-5: CODEX_BIN overrides the command name that gets resolved", () => {
  const plan = buildSpawnPlan({ platform: "darwin", env: { CODEX_BIN: "/opt/codex/bin/codex" } });
  assert.equal(plan.cmd, "/opt/codex/bin/codex");
  assert.equal(plan.name, "/opt/codex/bin/codex");
  assert.deepEqual(plan.argv, codexExecArgs());
});

test("CX-notfound-1: a run that never started classifies as not-found, non-retryable", async () => {
  // Before the fix this was `unknown`, which tells a Windows user nothing about why nothing
  // ran. Non-retryable matters too: callProvider retries network/rate-limit/empty, and
  // retrying a missing CLI just burns the round.
  const run = async () => ({ code: 127, stdout: "", stderr: "spawn codex ENOENT", timedOut: false, spawnFailed: true });
  const r = /** @type {any} */ (await mkCx({ run }).ask({ prompt: "x" }));
  assert.equal(r.isError, true);
  assert.equal(r.errorKind, "not-found");
  assert.equal(r.retryable, false);
});

test("CX-notfound-2: ENOENT in codex's OWN output is not a missing CLI", async () => {
  // A coding agent legitimately says ENOENT about files in the user's repo. Classifying the
  // launch from the child's own text would tell that user to go fix their CODEX_BIN.
  for (const s of ["ENOENT: no such file or directory, open 'src/missing.ts'", "EINVAL reading config"]) {
    assert.equal(classifyCodex(s).errorKind, "unknown", s);
  }
  const run = async () => ({ code: 1, stdout: "", stderr: "ENOENT: no such file or directory", timedOut: false });
  const r = /** @type {any} */ (await mkCx({ run }).ask({ prompt: "x" }));
  assert.equal(r.errorKind, "unknown");
});

test("CX-notfound-3: the timeout flag still wins over a spawn failure flag", async () => {
  const run = async () => ({ code: 137, stdout: "", stderr: "", timedOut: true, spawnFailed: true });
  const r = /** @type {any} */ (await mkCx({ run }).ask({ prompt: "x" }));
  assert.equal(r.errorKind, "timeout");
  assert.equal(r.retryable, true);
});
