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
  // env:{} - the host budget (MCP_TOOL_TIMEOUT) is a separate concern, tested in core-host-budget.
  await mkCx({ run, env: {} }).ask({ prompt: "x" });
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
  const p = mkCx({ run, timeoutMs: 77000, env: {} });
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

// --- Host budget (MCP_TOOL_TIMEOUT), credential passthrough, health -------------------------
const { codexEnv, codexHasLogin, codexHasAuth, codexHealth } = require("../core/providers/codex.js");

test("CX-host-1: the default ceiling is clamped under MCP_TOOL_TIMEOUT, and a timeout names the cap", async () => {
  let seen;
  const run = async (/** @type {any} */ a) => { seen = a.timeoutMs; return { code: 137, stdout: "", stderr: "", timedOut: true }; };
  const r = await mkCx({ run, env: { MCP_TOOL_TIMEOUT: "60000" } }).ask({ prompt: "x" });
  assert.equal(seen, 55000, "600000 default clamped to budget minus margin");
  assert.equal(r.isError, true);
  assert.equal(r.errorKind, "timeout");
  assert.match(String(/** @type {any} */ (r).message), /MCP_TOOL_TIMEOUT=60000/);
  assert.match(String(/** @type {any} */ (r).message), /Claude Code on the web/);
});

test("CX-host-1b: a remaining budget from an earlier leg lowers the ceiling; a shorter configured default still wins", async () => {
  let seen;
  const run = async (/** @type {any} */ a) => { seen = a.timeoutMs; return { code: 0, stdout: "ok", stderr: "" }; };
  await mkCx({ run, env: { MCP_TOOL_TIMEOUT: "60000" } }).ask({ prompt: "x", hostBudgetRemainingMs: 20000 });
  assert.equal(seen, 20000, "600000 default -> what is left of the cap");
  await mkCx({ run, timeoutMs: 2000, env: { MCP_TOOL_TIMEOUT: "60000" } }).ask({ prompt: "x", hostBudgetRemainingMs: 20000 });
  assert.equal(seen, 2000, "a construction-time 2s ceiling is not raised to the remaining 20s");
});

test("CX-host-2: a ceiling already under the cap is not clamped and a timeout carries no hint", async () => {
  let seen;
  const run = async (/** @type {any} */ a) => { seen = a.timeoutMs; return { code: 137, stdout: "", stderr: "", timedOut: true }; };
  const r = await mkCx({ run, env: { MCP_TOOL_TIMEOUT: "60000" } }).ask({ prompt: "x", timeoutMs: 20000 });
  assert.equal(seen, 20000);
  assert.doesNotMatch(String(/** @type {any} */ (r).message), /MCP_TOOL_TIMEOUT/);
});

test("CX-env-1: a codex login wins - an exported OPENAI_API_KEY never reaches codex and CODEX_API_KEY cannot override the login", () => {
  const login = { home: "/h", exists: (/** @type {string} */ p) => p === "/h/.codex/auth.json" };
  const env = { PATH: "/x", OPENAI_API_KEY: "sk-a" };
  const child = codexEnv(env, login);
  assert.equal(child.OPENAI_API_KEY, undefined, "OPENAI_API_KEY is stripped");
  assert.equal(child.CODEX_API_KEY, undefined, "and never forwarded - it would beat the ChatGPT login");
  assert.equal(child.PATH, "/x");
  assert.equal(env.OPENAI_API_KEY, "sk-a", "the caller's env is not mutated");
  assert.equal(codexEnv({ CODEX_API_KEY: "ck-b" }, login).CODEX_API_KEY, undefined, "login beats CODEX_API_KEY");
  assert.equal("CODEX_API_KEY" in codexEnv({ CODEX_API_KEY: "" }, login), false, "an empty CODEX_API_KEY is dropped too");
});

test("CX-login-1: only a regular auth.json file is a login - a directory under that name is not", () => {
  const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cx-login-"));
  try {
    fs.mkdirSync(path.join(home, "auth.json"));
    assert.equal(codexHasLogin({ env: { CODEX_HOME: home } }), false, "directory -> no login");
    assert.equal(codexEnv({ CODEX_HOME: home, CODEX_API_KEY: "ck" }).CODEX_API_KEY, "ck", "so CODEX_API_KEY is kept");
    fs.rmdirSync(path.join(home, "auth.json"));
    fs.writeFileSync(path.join(home, "auth.json"), "{}");
    assert.equal(codexHasLogin({ env: { CODEX_HOME: home } }), true, "regular file -> login");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("CX-env-2: without a login, CODEX_API_KEY is used as-is and OPENAI_API_KEY still never is", () => {
  const noLogin = { home: "/h", exists: () => false };
  const child = codexEnv({ OPENAI_API_KEY: "sk-a", CODEX_API_KEY: "ck-b" }, noLogin);
  assert.equal(child.CODEX_API_KEY, "ck-b");
  assert.equal(child.OPENAI_API_KEY, undefined);
  assert.equal(codexEnv({ OPENAI_API_KEY: "sk-a" }, noLogin).CODEX_API_KEY, undefined, "nothing invented");
});

test("CX-auth-1: codexHasAuth accepts CODEX_API_KEY or a login auth.json under CODEX_HOME / ~/.codex, never OPENAI_API_KEY", () => {
  assert.equal(codexHasAuth({ env: { OPENAI_API_KEY: "k" }, home: "/h", exists: () => false }), false);
  assert.equal(codexHasAuth({ env: { CODEX_API_KEY: "k" }, exists: () => false }), true);
  assert.equal(codexHasAuth({ env: {}, home: "/h", exists: (p) => p.endsWith("/h/.codex/auth.json") }), true);
  assert.equal(codexHasAuth({ env: { CODEX_HOME: "/ch" }, exists: (p) => p === "/ch/auth.json" }), true);
  assert.equal(codexHasAuth({ env: {}, home: "/h", exists: () => false }), false);
});

test("CX-health-1: health is stat-only and names the missing piece (CLI, then credential)", async () => {
  const onPath = (/** @type {string} */ p) => p === "/bin/codex";
  assert.deepEqual(codexHealth({ platform: "linux", env: { PATH: "/bin", CODEX_API_KEY: "k" }, exists: onPath }), { ok: true });
  const noCli = codexHealth({ platform: "linux", env: { PATH: "/nowhere", CODEX_API_KEY: "k" }, exists: () => false });
  assert.equal(noCli.ok, false); assert.match(String(noCli.reason), /codex CLI not found/);
  const noAuth = codexHealth({ platform: "linux", env: { PATH: "/bin" }, home: "/h", exists: onPath });
  assert.equal(noAuth.ok, false); assert.match(String(noAuth.reason), /no credential/);
  const openaiOnly = codexHealth({ platform: "linux", env: { PATH: "/bin", OPENAI_API_KEY: "k" }, home: "/h", exists: onPath });
  assert.equal(openaiOnly.ok, false, "OPENAI_API_KEY alone is not a codex credential");
  assert.match(String(openaiOnly.reason), /codex login/);
  // The provider's health() reads the injected env, so a panel probe never spawns anything.
  const h = await mkCx({ run: async () => ({ code: 0, stdout: "", stderr: "" }), env: { PATH: "/nowhere" } }).health();
  assert.equal(h.ok, false);
});

test("CX-token-1: CODEX_ACCESS_TOKEN (ChatGPT Business/Enterprise) is a credential on its own", () => {
  assert.equal(codexHasAuth({ env: { CODEX_ACCESS_TOKEN: "at" }, home: "/h", exists: () => false }), true);
  assert.equal(codexHasAuth({ env: { CODEX_ACCESS_TOKEN: "" }, home: "/h", exists: () => false }), false, "empty is not a token");
  const onPath = (/** @type {string} */ p) => p === "/bin/codex";
  assert.deepEqual(codexHealth({ platform: "linux", env: { PATH: "/bin", CODEX_ACCESS_TOKEN: "at" }, home: "/h", exists: onPath }), { ok: true });
});

test("CX-token-2: a ChatGPT access token beats CODEX_API_KEY - the key is dropped, the token is kept", () => {
  const noLogin = { home: "/h", exists: () => false };
  const child = codexEnv({ CODEX_ACCESS_TOKEN: "at", CODEX_API_KEY: "ck" }, noLogin);
  assert.equal(child.CODEX_ACCESS_TOKEN, "at");
  assert.equal("CODEX_API_KEY" in child, false, "codex ranks CODEX_API_KEY first, so it would bill the API");
});

// Verbatim from codex-rs/login/src/auth/manager.rs: what codex prints when a ChatGPT login cannot refresh.
const REFRESH_FAILURES = [
  "Your access token could not be refreshed because your refresh token has expired. Please log out and sign in again.",
  "Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.",
  "Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again.",
  "Your access token could not be refreshed. Please log out and sign in again.",
];

test("CX-refresh-1: a failed ChatGPT token refresh is an auth error, not unknown", () => {
  for (const s of REFRESH_FAILURES) assert.deepEqual(classifyCodex(s), { errorKind: "auth", retryable: false }, s);
});

test("CX-refresh-2: codex's line and the fix lead the message, ahead of the banner and echoed prompt", async () => {
  // codex exec prints a banner and echoes the prompt on stderr before the error; the reader
  // (and any host that truncates a long tool error) must meet the diagnosis first.
  const stderr = `${"banner line\n".repeat(60)}ERROR: ${REFRESH_FAILURES[1]}`;
  const r = /** @type {any} */ (await mkCx({ run: async () => ({ code: 1, stdout: "", stderr, timedOut: false }), env: {} }).ask({ prompt: "x" }));
  assert.equal(r.errorKind, "auth");
  const capped = r.message.slice(0, 500); // what a truncating host would still show
  assert.match(capped, /^ERROR: Your access token could not be refreshed because your refresh token was already used/, "codex's own line comes first");
  assert.match(capped, /codex login --device-auth/);
  assert.match(capped, /CODEX_ACCESS_TOKEN/);
  assert.match(r.message, /banner line/, "the full output follows");
});

test("CX-refresh-4: codex echoes the prompt on stderr - a prompt ABOUT refresh tokens is not an auth failure", async () => {
  const stderr = "user\nreview the refresh token rotation in session.ts: why could the refresh token not be refreshed?\nERROR: stream error: 429 Too Many Requests, rate limited";
  assert.equal(classifyCodex(stderr).errorKind, "rate-limit");
  const r = /** @type {any} */ (await mkCx({ run: async () => ({ code: 1, stdout: "", stderr, timedOut: false }), env: {} }).ask({ prompt: "x" }));
  assert.equal(r.errorKind, "rate-limit");
  assert.doesNotMatch(r.message, /device-auth/);
});

test("CX-refresh-5: an answer on stdout that discusses refresh tokens never earns the hint", async () => {
  const stdout = "Your access token could not be refreshed? Rotate the refresh token on every use.";
  const r = /** @type {any} */ (await mkCx({ run: async () => ({ code: 1, stdout, stderr: "ERROR: something broke", timedOut: false }), env: {} }).ask({ prompt: "x" }));
  assert.equal(r.errorKind, "unknown");
  assert.equal(r.message, stdout);
});

test("CX-refresh-3: other auth errors do not get the refresh hint", async () => {
  const r = /** @type {any} */ (await mkCx({ run: async () => ({ code: 1, stdout: "", stderr: "Not logged in. Run codex login.", timedOut: false }), env: {} }).ask({ prompt: "x" }));
  assert.equal(r.errorKind, "auth");
  assert.doesNotMatch(r.message, /device-auth/);
});

// ---- login on first use: `codex login --device-auth`, started lazily when GPT is needed ----
const { parseDevicePrompt, makeDeviceLogin } = require("../core/providers/codex.js");
// Captured from codex-cli 0.155.1 (code replaced); codex colours stdout even when it is a pipe.
const DEVICE_OUT = "\nWelcome to Codex [v\x1b[90m0.155.1\x1b[0m]\n\x1b[90mOpenAI's command-line coding agent\x1b[0m\n\n" +
  "Follow these steps to sign in with ChatGPT using device code authorization:\n\n" +
  "1. Open this link in your browser and sign in to your account\n   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\n\n" +
  "2. Enter this one-time code \x1b[90m(expires in 15 minutes)\x1b[0m\n   \x1b[94mABCD-12345\x1b[0m\n\n" +
  "\x1b[90mContinue only if you started this login in Codex. If a website or another person gave you this code, cancel.\x1b[0m\n";

/** A fake `codex login --device-auth`: prints the prompt, then waits for approve()/fail(). */
function fakeLoginCli() {
  const calls = { spawned: 0 };
  /** @type {(code:number)=>void} */ let exit = () => {};
  const spawnLogin = (/** @type {any} */ env, /** @type {(t:string)=>void} */ onText) => {
    calls.spawned++;
    onText(DEVICE_OUT);
    return { exit: new Promise((r) => { exit = r; }), kill: () => exit(143) };
  };
  return { calls, spawnLogin, approve: (/** @type {string} */ home) => { require("node:fs").writeFileSync(require("node:path").join(home, "auth.json"), "{}"); exit(0); }, fail: () => exit(1) };
}

function tmpCodexHome() {
  const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
  return fs.mkdtempSync(path.join(os.tmpdir(), "cx-home-"));
}

test("CX-login-parse: link, code and expiry come out of codex's coloured device-auth output", () => {
  assert.deepEqual(parseDevicePrompt(DEVICE_OUT), { url: "https://auth.openai.com/codex/device", code: "ABCD-12345", expiresInMs: 15 * 60000 });
  assert.equal(parseDevicePrompt("\nWelcome to Codex [v0.155.1]\n"), null, "nothing printed yet");
});

test("CX-login-flight: one login at a time - a second start reuses the pending code", async () => {
  const cli = fakeLoginCli();
  const login = makeDeviceLogin({ spawnLogin: cli.spawnLogin });
  const a = /** @type {any} */ (await login.start({}));
  const b = /** @type {any} */ (await login.start({}));
  assert.equal(cli.calls.spawned, 1);
  assert.equal(a.prompt.code, "ABCD-12345");
  assert.equal(b.prompt, a.prompt);
});

test("CX-login-restart: a finished or expired login is replaced by a fresh one", async () => {
  let t = 0;
  const cli = fakeLoginCli();
  const login = makeDeviceLogin({ spawnLogin: cli.spawnLogin, now: () => t });
  const first = /** @type {any} */ (await login.start({}));
  cli.fail();
  assert.equal(await first.done, false, "a failed login is not done");
  await login.start({});
  assert.equal(cli.calls.spawned, 2, "restarted after it exited");
  t = 16 * 60000;
  await login.start({});
  assert.equal(cli.calls.spawned, 3, "restarted after the code expired");
});

test("CX-login-noprompt: a login that exits before printing a code reports what it said", async () => {
  const login = makeDeviceLogin({
    spawnLogin: (_env, onText) => { onText("\x1b[31mError: device code login is disabled for this workspace\x1b[0m\n"); return { exit: Promise.resolve(1), kill() {} }; },
  });
  const r = /** @type {any} */ (await login.start({}));
  assert.equal(r.prompt, undefined);
  assert.match(r.error, /device code login is disabled/);
  assert.doesNotMatch(r.error, /\x1b/, "no ANSI in the message");
});

test("CX-login-link: no credential and no host dialog -> an auth result carrying the link and code; codex never runs", async () => {
  const home = tmpCodexHome();
  const cli = fakeLoginCli();
  let ran = 0;
  const p = mkCx({ env: { CODEX_HOME: home, PATH: "/nowhere" }, deviceLogin: true, login: makeDeviceLogin({ spawnLogin: cli.spawnLogin }), run: async () => { ran++; return { code: 0, stdout: "x", stderr: "" }; } });
  const r = /** @type {any} */ (await p.ask({ prompt: "x" }));
  assert.equal(ran, 0);
  assert.equal(r.isError, true);
  assert.equal(r.errorKind, "auth");
  assert.match(r.message, /https:\/\/auth\.openai\.com\/codex\/device/);
  assert.match(r.message, /ABCD-12345/);
  // The same state rides along structured, for hosts and the codex-login tool.
  assert.equal(r.deviceLogin.status, "pending");
  assert.equal(r.deviceLogin.code, "ABCD-12345");
  assert.equal(r.deviceLogin.url, "https://auth.openai.com/codex/device");
});

test("CX-login-health: with login on first use, a missing credential does not keep GPT off the panel", async () => {
  const fs = require("node:fs"), path = require("node:path");
  const home = tmpCodexHome();
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "codex"), "#!/bin/sh\n", { mode: 0o755 });
  const env = { CODEX_HOME: home, PATH: bin };
  assert.equal(codexHealth({ env }).ok, false, "the stat probe itself is unchanged");
  const off = mkCx({ env, run: async () => ({ code: 0, stdout: "", stderr: "" }) });
  assert.equal((await off.health()).ok, false, "and so is the provider without deviceLogin");
  const p = mkCx({ env, deviceLogin: true, login: makeDeviceLogin({ spawnLogin: fakeLoginCli().spawnLogin }), run: async () => ({ code: 0, stdout: "", stderr: "" }) });
  // ok keeps GPT on the panel; needsLogin lets a command log in BEFORE the fan-out.
  assert.deepEqual(await p.health(), { ok: true, needsLogin: true });
});

test("CX-login-dismissed: no answer from the dialog keeps the code valid; approving later makes the next call work", async () => {
  const home = tmpCodexHome();
  const cli = fakeLoginCli();
  const login = makeDeviceLogin({ spawnLogin: cli.spawnLogin });
  const p = mkCx({ env: { CODEX_HOME: home }, deviceLogin: true, confirmLogin: async () => /** @type {const} */ ("none"), login, run: async () => ({ code: 0, stdout: "answer", stderr: "" }) });
  const r = /** @type {any} */ (await p.ask({ prompt: "x" }));
  assert.equal(r.errorKind, "auth");
  assert.match(r.message, /ABCD-12345/);
  cli.approve(home);
  const again = /** @type {any} */ (await p.ask({ prompt: "x" }));
  assert.equal(again.text, "answer");
  assert.equal(cli.calls.spawned, 1);
});

test("CX-login-refresh: a spent login starts a fresh device login and returns its code with codex's own line", async () => {
  const home = tmpCodexHome();
  require("node:fs").writeFileSync(require("node:path").join(home, "auth.json"), "{}"); // the stale copy
  const cli = fakeLoginCli();
  const run = async () => ({ code: 1, stdout: "", stderr: `ERROR: ${REFRESH_FAILURES[1]}`, timedOut: false });
  const r = /** @type {any} */ (await mkCx({ env: { CODEX_HOME: home }, deviceLogin: true, login: makeDeviceLogin({ spawnLogin: cli.spawnLogin }), run }).ask({ prompt: "x" }));
  assert.equal(r.deviceLogin.status, "pending");
  assert.match(r.message, /ABCD-12345/);
  assert.match(r.message, /refresh token was already used/, "codex's own line still follows");
  assert.equal(cli.calls.spawned, 1);
});

test("CX-login-off: without deviceLogin nothing is spawned (library default)", async () => {
  const home = tmpCodexHome();
  const cli = fakeLoginCli();
  const p = mkCx({ env: { CODEX_HOME: home }, login: makeDeviceLogin({ spawnLogin: cli.spawnLogin }), run: async () => ({ code: 1, stdout: "", stderr: "Not logged in", timedOut: false }) });
  await p.ask({ prompt: "x" });
  assert.equal(cli.calls.spawned, 0);
});

test("CX-login-parse-url: the login link is picked by its role, not by being the first URL printed", () => {
  const withNotice = "Update available! See https://github.com/openai/codex/releases/latest\n" + DEVICE_OUT;
  assert.equal(/** @type {any} */ (parseDevicePrompt(withNotice)).url, "https://auth.openai.com/codex/device");
  assert.equal(/** @type {any} */ (parseDevicePrompt("go to https://auth.openai.com/other and enter ABCD-12345\n")).url, "https://auth.openai.com/other", "an OpenAI URL without /device: still the link");
  assert.equal(parseDevicePrompt("go to https://evil.example/codex/device and enter ABCD-12345"), null, "not an OpenAI host: no clickable link");
  assert.equal(parseDevicePrompt("go to https://evilopenai.com/codex/device and enter ABCD-12345"), null, "suffix without a dot is not a subdomain");
  assert.equal(parseDevicePrompt("go to https://openai.com.evil.com/codex/device and enter ABCD-12345"), null, "openai.com as a label is not the host");
});

test("CX-login-order: on a spent login the link + code lead, codex's refresh line follows", async () => {
  const home = tmpCodexHome();
  require("node:fs").writeFileSync(require("node:path").join(home, "auth.json"), "{}");
  const cli = fakeLoginCli();
  const run = async () => ({ code: 1, stdout: "", stderr: `ERROR: ${REFRESH_FAILURES[1]}`, timedOut: false });
  const r = /** @type {any} */ (await mkCx({ env: { CODEX_HOME: home }, deviceLogin: true, login: makeDeviceLogin({ spawnLogin: cli.spawnLogin }), run }).ask({ prompt: "x" }));
  assert.match(r.message, /^GPT \(Codex\) needs a ChatGPT login/);
  assert.ok(r.message.indexOf("ABCD-12345") < 200, "the code is well inside any 500-char cap");
  assert.match(r.message, /refresh token was already used/);
  assert.match(r.message, /only continue/i, "anti-phishing line");
});

test("CX-login-expiry: a code nobody used is reaped when it expires, whatever codex does", async () => {
  let killed = 0;
  const login = makeDeviceLogin({
    killGraceMs: 5,
    spawnLogin: (_env, onText) => { onText(DEVICE_OUT.replace("expires in 15 minutes", "expires in 0 minutes")); return { exit: new Promise(() => {}), kill: () => { killed++; } }; },
  });
  await login.start({});
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(killed, 1);
});

test("CX-login-expiry-noop: the reaper leaves a login that already finished alone", async () => {
  const home = tmpCodexHome();
  const cli = fakeLoginCli();
  let killed = 0;
  const login = makeDeviceLogin({
    killGraceMs: 5,
    spawnLogin: (env, onText) => {
      const p = cli.spawnLogin(env, (s) => onText(s.replace("expires in 15 minutes", "expires in 0 minutes")));
      return { exit: p.exit, kill: () => { killed++; } };
    },
  });
  const f = /** @type {any} */ (await login.start({ CODEX_HOME: home }));
  cli.approve(home);
  assert.equal(await f.done, true);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(killed, 0);
});

test("CX-login-keepalive: once a code is shown, the no-code timer never kills the login", async () => {
  let killed = 0;
  const cli = fakeLoginCli();
  const login = makeDeviceLogin({ promptWaitMs: 10, spawnLogin: (env, onText) => { const p = cli.spawnLogin(env, onText); return { exit: p.exit, kill: () => { killed++; } }; } });
  await login.start({});
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(killed, 0);
});

test("CX-login-split: however codex's output is chunked, the full link and code come out", async () => {
  const plain = DEVICE_OUT;
  for (let i = 1; i < plain.length; i++) {
    const login = makeDeviceLogin({ spawnLogin: (_env, onText) => { onText(plain.slice(0, i)); onText(plain.slice(i)); return { exit: new Promise(() => {}), kill() {} }; } });
    const f = /** @type {any} */ (await login.start({}));
    assert.equal(f.prompt.code, "ABCD-12345", `split at ${i}`);
    assert.equal(f.prompt.url, "https://auth.openai.com/codex/device", `split at ${i}`);
  }
});

test("CX-refresh-echo: codex's exact phrase inside the ECHOED prompt never starts a device login", async () => {
  const home = tmpCodexHome();
  require("node:fs").writeFileSync(require("node:path").join(home, "auth.json"), "{}");
  const cli = fakeLoginCli();
  const question = 'why does codex say "Your access token could not be refreshed because your refresh token was already used"?';
  const stderr = `user\n${question}\nERROR: stream error: 429 Too Many Requests, rate limited`;
  assert.equal(classifyCodex(stderr, question).errorKind, "rate-limit");
  const r = /** @type {any} */ (await mkCx({ env: { CODEX_HOME: home }, deviceLogin: true, login: makeDeviceLogin({ spawnLogin: cli.spawnLogin }), run: async () => ({ code: 1, stdout: "", stderr, timedOut: false }) }).ask({ prompt: question }));
  assert.equal(r.errorKind, "rate-limit");
  assert.equal(cli.calls.spawned, 0);
});

test("CX-login-abandon: the dialog is cancelled when the login lands, not when the call returns", async () => {
  const home = tmpCodexHome();
  const cli = fakeLoginCli();
  /** @type {AbortSignal|undefined} */ let seen;
  const confirmLogin = (/** @type {any} */ _p, /** @type {number} */ _ms, /** @type {AbortSignal} */ signal) => { seen = signal; return new Promise(() => {}); };
  const p = mkCx({ env: { CODEX_HOME: home }, deviceLogin: true, confirmLogin: /** @type {any} */ (confirmLogin), login: makeDeviceLogin({ spawnLogin: cli.spawnLogin }), run: async () => ({ code: 0, stdout: "answer", stderr: "" }) });
  await p.ask({ prompt: "x" });
  assert.equal(/** @type {any} */ (seen).aborted, false, "a returned call leaves the dialog open");
  cli.approve(home);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(/** @type {any} */ (seen).aborted, true, "the landed login closes it");
});

test("CX-refresh-echo-repeat: quoting the error in the prompt does not hide codex then reporting it for real", () => {
  const errorLine = `ERROR: ${REFRESH_FAILURES[1]}`;
  const prompt = `what does this mean?\n${errorLine}`;
  const stderr = `user\nwhat does this mean?\n${errorLine}\n${errorLine}`;
  assert.equal(classifyCodex(stderr, prompt).errorKind, "auth", "the echo is consumed once; the second line is codex's own");
});

test("CX-login-closed: once the server is shutting down, no new login starts", async () => {
  const cli = fakeLoginCli();
  const r = /** @type {any} */ (await makeDeviceLogin({ spawnLogin: cli.spawnLogin, isClosed: () => true }).start({}));
  assert.equal(cli.calls.spawned, 0);
  assert.match(r.error, /shutting down/);
});

test("CX-login-acquire-budget: waiting for codex to print its code is bounded by the host budget; the login keeps going", async () => {
  const home = tmpCodexHome();
  /** @type {(t:string)=>void} */ let emit = () => {};
  let killed = 0;
  const login = makeDeviceLogin({ spawnLogin: (_env, onText) => { emit = onText; return { exit: new Promise(() => {}), kill: () => { killed++; } }; } });
  const p = mkCx({ env: { CODEX_HOME: home, MCP_TOOL_TIMEOUT: "60000" }, deviceLogin: true, login, run: async () => ({ code: 0, stdout: "", stderr: "" }) });
  const t0 = Date.now();
  const r = /** @type {any} */ (await p.ask({ prompt: "x", hostBudgetRemainingMs: 1000 }));
  assert.ok(Date.now() - t0 < 900, `returned in ${Date.now() - t0} ms`);
  assert.equal(r.errorKind, "auth");
  assert.match(r.message, /no code yet/);
  assert.equal(killed, 0, "the shared login is left running");
  emit(DEVICE_OUT);
  const again = /** @type {any} */ (await p.ask({ prompt: "x" }));
  assert.match(again.message, /ABCD-12345/, "the next call gets the code at once");
});

// ---- codex-login: the same login as ask(), without a question, so nobody has to "waste" a GPT call ----
const noRun = async () => { throw new Error("login() must never run codex exec"); };

test("CX-login-tool-pending: login() starts (or joins) the device login and returns link + code; ask() joins it", async () => {
  const home = tmpCodexHome();
  const cli = fakeLoginCli();
  const p = /** @type {any} */ (mkCx({ env: { CODEX_HOME: home }, deviceLogin: true, login: makeDeviceLogin({ spawnLogin: cli.spawnLogin }), run: noRun }));
  const a = await p.login({});
  assert.equal(a.status, "pending");
  assert.equal(a.url, "https://auth.openai.com/codex/device");
  assert.equal(a.code, "ABCD-12345");
  assert.ok(a.expiresAt > Date.now());
  assert.match(a.message, /ABCD-12345/);
  assert.equal((await p.login({})).code, "ABCD-12345", "a second call joins the same code");
  assert.match((await p.ask({ prompt: "x" })).message, /ABCD-12345/, "and so does ask()");
  assert.equal(cli.calls.spawned, 1);
});

test("CX-login-tool-authenticated: with a credential, login() says so and spawns nothing", async () => {
  const home = tmpCodexHome();
  require("node:fs").writeFileSync(require("node:path").join(home, "auth.json"), "{}");
  const cli = fakeLoginCli();
  const r = await /** @type {any} */ (mkCx({ env: { CODEX_HOME: home }, deviceLogin: true, login: makeDeviceLogin({ spawnLogin: cli.spawnLogin }), run: noRun })).login({});
  assert.equal(r.status, "authenticated");
  assert.equal(cli.calls.spawned, 0);
  // A file on disk is not a working login (a copied or spent auth.json exists too): say so.
  assert.match(r.message, /refresh/);
  assert.match(r.message, /codex logout/);
});

test("CX-login-tool-dialog: an accepted dialog lands the login; the next codex-login call says authenticated", async () => {
  const home = tmpCodexHome();
  const cli = fakeLoginCli();
  /** @type {(a:any)=>void} */ let answer = () => {};
  const p = /** @type {any} */ (mkCx({ env: { CODEX_HOME: home }, deviceLogin: true, confirmLogin: () => new Promise((r) => { answer = r; }), login: makeDeviceLogin({ spawnLogin: cli.spawnLogin }), run: noRun }));
  assert.equal((await p.login({})).status, "pending", "the code comes back without waiting for the dialog");
  answer("accept");
  cli.approve(home);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal((await p.login({})).status, "authenticated");
  assert.equal(cli.calls.spawned, 1);
});

test("CX-login-tool-declined: a decline ends that login, so the next call offers a new code", async () => {
  const home = tmpCodexHome();
  const cli = fakeLoginCli();
  /** @type {(a:any)=>void} */ let answer = () => {};
  const p = /** @type {any} */ (mkCx({ env: { CODEX_HOME: home }, deviceLogin: true, confirmLogin: () => new Promise((r) => { answer = r; }), login: makeDeviceLogin({ spawnLogin: cli.spawnLogin }), run: noRun }));
  assert.equal((await p.login({})).status, "pending");
  answer("decline");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal((await p.login({})).status, "pending");
  assert.equal(cli.calls.spawned, 2, "the refused login was ended; this is a fresh one");
});

test("CX-login-tool-off: without deviceLogin (library default) login() is unavailable and spawns nothing", async () => {
  const home = tmpCodexHome();
  const cli = fakeLoginCli();
  const r = await /** @type {any} */ (mkCx({ env: { CODEX_HOME: home }, login: makeDeviceLogin({ spawnLogin: cli.spawnLogin }), run: noRun })).login({});
  assert.equal(r.status, "unavailable");
  assert.equal(cli.calls.spawned, 0);
});

// ---- the dialog never delays the answer: a host may advertise elicitation and never reply ----
test("CX-login-fast: a dialog nobody answers does not hold the call - the code comes back at once", async () => {
  const home = tmpCodexHome();
  const cli = fakeLoginCli();
  const p = mkCx({ env: { CODEX_HOME: home }, deviceLogin: true, confirmLogin: () => new Promise(() => {}), login: makeDeviceLogin({ spawnLogin: cli.spawnLogin }), run: noRun });
  const t0 = Date.now();
  const r = /** @type {any} */ (await p.ask({ prompt: "x" }));
  assert.ok(Date.now() - t0 < 1000, `returned in ${Date.now() - t0} ms`);
  assert.equal(r.deviceLogin.status, "pending");
  assert.match(r.message, /ABCD-12345/);
});

test("CX-login-copyable: the link and the code each stand on their own line", async () => {
  const home = tmpCodexHome();
  const p = mkCx({ env: { CODEX_HOME: home }, deviceLogin: true, login: makeDeviceLogin({ spawnLogin: fakeLoginCli().spawnLogin }), run: noRun });
  const r = /** @type {any} */ (await p.ask({ prompt: "x" }));
  assert.match(r.message, /\n\nhttps:\/\/auth\.openai\.com\/codex\/device\n\n/, "the link alone on its line");
  assert.match(r.message, /\n\nABCD-12345\n\n/, "the code alone on its line");
  assert.match(r.message, /expires in 15 min/, "the full lifetime, not one spent waiting");
});

test("CX-login-decline-background: a decline that arrives after the call still ends that login", async () => {
  const home = tmpCodexHome();
  const cli = fakeLoginCli();
  let killed = 0;
  const spawnLogin = (/** @type {any} */ env, /** @type {(t:string)=>void} */ onText) => { const f = cli.spawnLogin(env, onText); return { exit: f.exit, kill: () => { killed++; f.kill(); } }; };
  /** @type {(a:any)=>void} */ let answer = () => {};
  const p = mkCx({ env: { CODEX_HOME: home }, deviceLogin: true, confirmLogin: () => new Promise((r) => { answer = r; }), login: makeDeviceLogin({ spawnLogin }), run: noRun });
  const r = /** @type {any} */ (await p.ask({ prompt: "x" }));
  assert.equal(r.deviceLogin.status, "pending", "the call already returned the code");
  answer("decline");
  await new Promise((r2) => setTimeout(r2, 20));
  assert.equal(killed, 1, "the refused login is ended in the background");
});

test("CX-login-accept-later: an accepted dialog lands the login, and the NEXT call answers", async () => {
  const home = tmpCodexHome();
  const cli = fakeLoginCli();
  /** @type {(a:any)=>void} */ let answer = () => {};
  const p = mkCx({ env: { CODEX_HOME: home }, deviceLogin: true, confirmLogin: () => new Promise((r) => { answer = r; }), login: makeDeviceLogin({ spawnLogin: cli.spawnLogin }), run: async () => ({ code: 0, stdout: "answer", stderr: "" }) });
  assert.match(/** @type {any} */ (await p.ask({ prompt: "x" })).message, /ABCD-12345/);
  answer("accept");
  cli.approve(home); // the user approved in the browser; the shared login lands
  await new Promise((r2) => setTimeout(r2, 20));
  assert.equal(/** @type {any} */ (await p.ask({ prompt: "x" })).text, "answer");
  assert.equal(cli.calls.spawned, 1);
});

test("CX-login-decline-stale: a decline for an OLD code never touches the login that replaced it", async () => {
  let t = 0;
  const home = tmpCodexHome();
  const cli = fakeLoginCli();
  /** @type {number[]} */ const killed = [];
  let spawned = 0;
  const spawnLogin = (/** @type {any} */ env, /** @type {(s:string)=>void} */ onText) => {
    const mine = ++spawned;
    const f = cli.spawnLogin(env, onText);
    return { exit: f.exit, kill: () => { killed.push(mine); f.kill(); } };
  };
  /** @type {((a:any)=>void)[]} */ const answers = [];
  const p = mkCx({ env: { CODEX_HOME: home }, deviceLogin: true, confirmLogin: () => new Promise((r) => answers.push(r)), login: makeDeviceLogin({ spawnLogin, now: () => t }), run: noRun });
  await p.ask({ prompt: "x" });          // login #1, dialog #1
  t = 16 * 60000;                        // its code expires
  await p.ask({ prompt: "x" });          // login #2 replaces it, dialog #2
  assert.equal(spawned, 2);
  answers[0]("decline");                 // the stale dialog is answered late
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(!killed.includes(2), `the live login was killed: ${JSON.stringify(killed)}`);
});

test("CX-login-decline-after-landing: a decline once the login landed leaves the credential alone", async () => {
  const fs = require("node:fs"), path = require("node:path");
  const home = tmpCodexHome();
  const cli = fakeLoginCli();
  /** @type {(a:any)=>void} */ let answer = () => {};
  const p = mkCx({ env: { CODEX_HOME: home }, deviceLogin: true, confirmLogin: () => new Promise((r) => { answer = r; }), login: makeDeviceLogin({ spawnLogin: cli.spawnLogin }), run: async () => ({ code: 0, stdout: "answer", stderr: "" }) });
  await p.ask({ prompt: "x" });
  cli.approve(home);                     // the user approved in the browser first
  await new Promise((r) => setTimeout(r, 20));
  answer("decline");                     // ...then declined the stale dialog
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(fs.existsSync(path.join(home, "auth.json")), "deliberation never deletes a credential");
  assert.equal(/** @type {any} */ (await p.ask({ prompt: "x" })).text, "answer");
});

test("CX-login-dialog-throws: a host whose dialog rejects never becomes an unhandled rejection", async () => {
  const home = tmpCodexHome();
  /** @type {unknown[]} */ const unhandled = [];
  const onUnhandled = (/** @type {unknown} */ e) => unhandled.push(e);
  process.on("unhandledRejection", onUnhandled);
  try {
    const p = mkCx({ env: { CODEX_HOME: home }, deviceLogin: true, confirmLogin: () => Promise.reject(new Error("host says no")), login: makeDeviceLogin({ spawnLogin: fakeLoginCli().spawnLogin }), run: noRun });
    assert.match(/** @type {any} */ (await p.ask({ prompt: "x" })).message, /ABCD-12345/);
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(unhandled, []);
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
  }
});

test("CX-login-settled-first: a login that lands before the dialog goes out raises no dialog", async () => {
  const home = tmpCodexHome();
  const cli = fakeLoginCli();
  let asked = 0;
  const spawnLogin = (/** @type {any} */ env, /** @type {(s:string)=>void} */ onText) => {
    const f = cli.spawnLogin(env, onText);
    cli.approve(home); // the login lands in the same tick the code is printed
    return f;
  };
  const p = mkCx({ env: { CODEX_HOME: home }, deviceLogin: true, confirmLogin: async () => { asked++; return /** @type {const} */ ("none"); }, login: makeDeviceLogin({ spawnLogin }), run: async () => ({ code: 0, stdout: "answer", stderr: "" }) });
  const r = /** @type {any} */ (await p.ask({ prompt: "x" }));
  await new Promise((r2) => setTimeout(r2, 20));
  assert.equal(asked, 0, "the dialog is skipped: its signal was aborted before it could be sent");
  // It LANDED, so this very call can answer - no "ended before the login landed".
  assert.equal(r.text, "answer");
  assert.equal(r.isError, false);
});

test("CX-login-abandon-dead: a login that dies also closes its dialog", async () => {
  const home = tmpCodexHome();
  const cli = fakeLoginCli();
  /** @type {AbortSignal|undefined} */ let seen;
  const p = mkCx({ env: { CODEX_HOME: home }, deviceLogin: true, confirmLogin: (/** @type {any} */ _p, /** @type {number} */ _ms, /** @type {AbortSignal} */ s) => { seen = s; return new Promise(() => {}); }, login: makeDeviceLogin({ spawnLogin: cli.spawnLogin }), run: noRun });
  await p.ask({ prompt: "x" });
  assert.equal(/** @type {any} */ (seen).aborted, false);
  cli.fail(); // codex exits without a login
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(/** @type {any} */ (seen).aborted, true, "a dead code's dialog is closed too");
});
