"use strict";
/** @typedef {import("../types.js").Provider} Provider */
/** @typedef {import("../types.js").DelegationRequest} DelegationRequest */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { resolveCommand, commandOnPath, shimMessage } = require("../resolve-bin.js");
const { clampToHostBudget, annotateTimeout, spendHostBudget } = require("../host-budget.js");

// npm ships @openai/codex with `bin: {"codex": "bin/codex.js"}` and zero dependencies, so on
// Windows - where npm installs a `codex.cmd` shim Node cannot spawn (issue #170) - the real JS
// entry point can be handed to `process.execPath` instead. Nothing to resolve elsewhere.
const CODEX_NPM_ENTRY = { pkg: "@openai/codex", bin: "bin/codex.js" };

// Default per-call wall-time ceiling for a Codex run. Without this the spawner's
// kill timer is never armed (the `timeoutMs ? ... : null` below), so a hung or
// runaway `codex exec` runs UNBOUNDED - the root cause of the observed ~38-min
// single-call outlier. 600s mirrors the Gemini bridge's MAX ceiling: generous for
// a deep GPT answer, fatal to an unbounded hang. Overridable per-call via
// req.timeoutMs, or per-construction via opts.timeoutMs.
const CODEX_DEFAULT_TIMEOUT_MS = 600000;

// A ChatGPT login's refresh token is single-use: every refresh writes a new pair to auth.json and
// retires the old one. So an auth.json copied to a second machine (a web container seeded from a
// laptop) dies on the first refresh either side makes, with "Your access token could not be
// refreshed because your refresh token was already used. Please log out and sign in again." -
// text that names neither "auth" nor "login". All four of codex's refresh failures
// (codex-rs/login/src/auth/manager.rs) share the phrase below. It is matched exactly, and on
// stderr only, because `codex exec` echoes the user's prompt to stderr and a review of token code
// says "refresh token" all the time.
const REFRESH_FAILURE = "access token could not be refreshed";
const CODEX_REFRESH_HINT =
  "The ChatGPT login in auth.json could not refresh: it expired, or a copy of it was refreshed on another machine " +
  "(one auth.json cannot be shared between machines). Run `codex login --device-auth` on this machine for a login of its own, " +
  "or set CODEX_ACCESS_TOKEN (ChatGPT Business/Enterprise).";

/**
 * codex's own refresh-failure line, if stderr has one.
 * @param {string} [stderr]
 * @param {string} [prompt]  what was sent to codex (its echo is excluded)
 * @returns {string|undefined}
 */
function refreshFailureLine(stderr, prompt = "") {
  // codex echoes the prompt on stderr, and a prompt may quote this very phrase. Each line of
  // the prompt is consumed ONCE as echo, so the same line printed again by codex still counts.
  // Last one wins - errors follow the echo.
  /** @type {Map<string, number>} */ const echo = new Map();
  for (const l of String(prompt).split(/\r?\n/)) { const k = l.trim(); if (k) echo.set(k, (echo.get(k) || 0) + 1); }
  /** @type {string|undefined} */ let found;
  for (const raw of String(stderr || "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").split(/\r?\n/)) {
    const l = raw.trim();
    const n = echo.get(l);
    if (n) { echo.set(l, n - 1); continue; }
    if (l.toLowerCase().includes(REFRESH_FAILURE)) found = l;
  }
  return found;
}

/**
 * Map codex stderr to the shared errorKind vocabulary.
 * @param {string} [stderr]
 * @param {string} [prompt]  what was sent to codex, so its echo on stderr is not mistaken for codex's own error
 * @returns {{errorKind:string, retryable:boolean}}
 */
function classifyCodex(stderr, prompt) {
  const s = (stderr || "").toLowerCase();
  // A failed SPAWN is deliberately not classified here - see the `spawnFailed` flag in `ask`.
  // Matching "enoent"/"einval" as substrings would also fire on a codex run that legitimately
  // printed ENOENT about a file in the user's own repo, which is a normal thing for a coding
  // agent to say, and would then tell that user to go fix their CODEX_BIN.
  if (s.includes("auth") || s.includes("login") || refreshFailureLine(stderr, prompt)) return { errorKind: "auth", retryable: false };
  if (s.includes("timeout")) return { errorKind: "timeout", retryable: true };
  if (s.includes("rate")) return { errorKind: "rate-limit", retryable: true };
  return { errorKind: "unknown", retryable: false };
}

/**
 * Argv for a `codex exec` run. The sandbox flag is chosen from the EFFECTIVE mode:
 * "implement" -> `--sandbox workspace-write` (codex permits writes under cwd, still
 * OS-enforced via Seatbelt/Landlock/seccomp); anything else -> `--sandbox read-only`.
 * Read-only is the structural default: only the exact string "implement" opens writes,
 * so the run cannot inherit a writable global default from ~/.codex/config.toml
 * (e.g. sandbox_mode = "workspace-write"). The flag is a fixed literal per branch -
 * caller input is never interpolated, and we never emit danger-full-access /
 * bypass-approvals. The mode reaching here is already gated by the two-lock check in
 * `ask` (allowImplement AND req.mode === "implement"); the opts.run injection point
 * remains the test-only escape hatch.
 * @param {("advisory"|"implement")} [mode]
 * @returns {string[]}
 */
function codexExecArgs(mode) {
  const sandbox = mode === "implement" ? "workspace-write" : "read-only";
  return ["exec", "--sandbox", sandbox, "--skip-git-repo-check"];
}

/**
 * What to spawn, and with which argv, for one `codex exec` run.
 *
 * Pure and fully injectable so the Windows branch is testable on macOS - `defaultRun` itself
 * cannot be unit-tested (it spawns a real process), which is why the decision lives here.
 * The command name comes from `CODEX_BIN` when set, mirroring `AGY_BIN` in the Gemini bridge,
 * so a user whose install resolves oddly has an immediate escape hatch.
 *
 * @param {Object} [o]
 * @param {("advisory"|"implement")} [o.mode]
 * @param {string[]} [o.args]  codex arguments instead of `exec ...` (the device login uses it)
 * @param {string} [o.platform]
 * @param {Record<string, (string|undefined)>} [o.env]
 * @param {(p: string) => boolean} [o.exists]
 * @param {string} [o.nodePath]
 * @returns {{cmd:string, argv:string[], shim:boolean, name:string}}
 */
function buildSpawnPlan(o = {}) {
  const env = o.env || process.env;
  const name = env.CODEX_BIN || "codex";
  const target = resolveCommand(name, {
    platform: o.platform,
    env,
    exists: o.exists,
    nodePath: o.nodePath,
    npmEntry: CODEX_NPM_ENTRY,
  });
  // prefixArgs (the npm entry point, when the shim was bypassed) must lead: `node <entry> exec ...`.
  return { cmd: target.cmd, argv: [...target.prefixArgs, ...(o.args || codexExecArgs(o.mode))], shim: target.shim, name };
}

/**
 * Has the user run `codex login`? Stat-only: a regular `auth.json` file under `$CODEX_HOME` /
 * `~/.codex` (a directory by that name is not a login). Never reads it; never throws.
 * @param {Object} [o]
 * @param {Record<string, (string|undefined)>} [o.env]
 * @param {(p: string) => boolean} [o.exists]
 * @param {string} [o.home]
 * @returns {boolean}
 */
function codexHasLogin(o = {}) {
  const env = o.env || process.env;
  const exists = o.exists || ((/** @type {string} */ p) => fs.statSync(p).isFile());
  const home = env.CODEX_HOME || path.join(o.home || os.homedir(), ".codex");
  try { return exists(path.join(home, "auth.json")); } catch { return false; }
}

/**
 * The environment a `codex exec` child gets.
 *
 * A ChatGPT credential - the codex login (`auth.json`) or a `CODEX_ACCESS_TOKEN` - always wins.
 * codex-cli ranks a `CODEX_API_KEY` env var above both, so when either exists the key is dropped
 * from the child's env; without one, `CODEX_API_KEY` is used as-is. Between the token and the
 * login, codex's own order applies (the token). `OPENAI_API_KEY` is never used
 * and never reaches the child: a machine that exports it for other tools had every GPT call
 * billed to that API key instead of the subscription ("You have no credits remaining").
 * Returns a copy; pure and injectable.
 *
 * @param {Record<string, (string|undefined)>} [env]
 * @param {{exists?: (p: string) => boolean, home?: string}} [o]
 * @returns {Record<string, (string|undefined)>}
 */
function codexEnv(env = process.env, o = {}) {
  const { OPENAI_API_KEY, ...child } = env;
  if ("CODEX_API_KEY" in child && (child.CODEX_ACCESS_TOKEN || codexHasLogin({ env, ...o }))) delete child.CODEX_API_KEY;
  return child;
}

/**
 * Does codex have a credential it will use? `CODEX_ACCESS_TOKEN` (a ChatGPT Business/Enterprise
 * access token, which never refreshes), a login `auth.json`, or `CODEX_API_KEY`.
 * `OPENAI_API_KEY` does not count - `codexEnv` never passes it on. Never throws.
 * @param {Object} [o]
 * @param {Record<string, (string|undefined)>} [o.env]
 * @param {(p: string) => boolean} [o.exists]
 * @param {string} [o.home]
 * @returns {boolean}
 */
function codexHasAuth(o = {}) {
  const env = o.env || process.env;
  return Boolean(env.CODEX_API_KEY || env.CODEX_ACCESS_TOKEN) || codexHasLogin(o);
}

/**
 * Stat-only health probe: the CLI must be spawnable and a credential must exist. Both are
 * cheap enough to run on every `panel` call, and neither spawns or touches the network.
 * @param {Object} [o]
 * @param {Record<string, (string|undefined)>} [o.env]
 * @param {(p: string) => boolean} [o.exists]
 * @param {string} [o.platform]
 * @param {string} [o.home]
 * @returns {{ok:boolean, reason?:string, needsLogin?:boolean}}
 */
function codexHealth(o = {}) {
  const env = o.env || process.env;
  const plan = buildSpawnPlan({ platform: o.platform, env, exists: o.exists });
  if (plan.shim) return { ok: false, reason: shimMessage(plan.name, plan.cmd, "CODEX_BIN") };
  if (!commandOnPath(plan.cmd, { platform: o.platform, env, exists: o.exists })) {
    return { ok: false, reason: `codex CLI not found (tried "${plan.cmd}"); install it or set CODEX_BIN` };
  }
  if (!codexHasAuth({ env, exists: o.exists, home: o.home })) {
    return { ok: false, needsLogin: true, reason: "codex has no credential: run `codex login` (ChatGPT; `codex login --device-auth` on a remote machine), set CODEX_ACCESS_TOKEN (ChatGPT Business/Enterprise), or set CODEX_API_KEY (OPENAI_API_KEY is never used)" };
  }
  return { ok: true };
}

/**
 * Default spawner: `codex exec` reading the prompt on stdin, capturing stdout.
 *
 * `spawnFailed` marks "the process never started", which `ask` maps to `not-found`. It is a
 * flag rather than a stderr pattern for the same reason `timedOut` is: the child's own output
 * is not evidence about the child's launch, and a codex run can legitimately print ENOENT
 * about a file in the user's repo.
 *
 * The plan is rebuilt per call (a long-lived server should honour a PATH or CODEX_BIN change),
 * which costs a few `existsSync` probes on Windows and nothing at all anywhere else. The Gemini
 * bridge resolves once at module scope instead because it also gates startup on the result.
 *
 * @param {{prompt:string, cwd?:string, timeoutMs?:number, mode?:("advisory"|"implement"), env?:Record<string,(string|undefined)>}} args
 * @returns {Promise<{code:number, stdout:string, stderr:string, timedOut:boolean, spawnFailed?:boolean}>}
 */
function defaultRun({ prompt, cwd, timeoutMs, mode, env }) {
  return new Promise((resolve) => {
    const plan = buildSpawnPlan({ mode, env });
    // Only a shell shim was found. Spawning it fails with a bare EINVAL that explains nothing,
    // and `shell: true` is not the answer - the shell would become the child, so the SIGKILL
    // below would kill the shell and leave codex running past its timeout.
    if (plan.shim) {
      resolve({
        code: 127, stdout: "", timedOut: false, spawnFailed: true,
        stderr: shimMessage(plan.name, plan.cmd, "CODEX_BIN"),
      });
      return;
    }
    const child = spawn(plan.cmd, plan.argv, { cwd: cwd || process.cwd(), env: codexEnv(env) });
    let stdout = "", stderr = "", settled = false, timedOut = false;
    // A SIGKILL'd codex usually writes nothing, so classifyCodex(stderr) would map the
    // kill to `unknown` (or worse, to `auth` - "author" contains "auth"). Report the
    // kill explicitly instead of inferring it from a stream that may be empty.
    const timer = timeoutMs ? setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs) : null;
    if (timer) timer.unref(); // never hold the event loop open on the timeout timer
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => {
      if (settled) return; settled = true;
      if (timer) clearTimeout(timer);
      // An `error` event means the process never started - name what was tried, since the
      // stock "spawn codex ENOENT" does not say which codex, and on Windows the answer is
      // usually a shim rather than a missing install.
      const detail = String((e && e.message) || e);
      const hint = `. Tried "${plan.cmd}"; set CODEX_BIN to the codex executable if it is not on PATH.`;
      resolve({ code: 127, stdout: "", stderr: detail + hint, timedOut, spawnFailed: true });
    });
    child.on("close", (code) => {
      if (settled) return; settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code: code == null ? 1 : code, stdout, stderr, timedOut });
    });
    child.stdin.end(prompt);
  });
}

// ---- Login on first use ------------------------------------------------------------------
// A remote container (Claude Code on the web) has no browser and must not borrow another
// machine's auth.json, so the first call that needs GPT starts `codex login --device-auth` and
// hands the user its link and one-time code. The login keeps polling in the background; once
// the user approves, codex writes auth.json and the next call simply finds it.

const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;
const DEVICE_PROMPT_WAIT_MS = 20000; // codex prints the code within a second or two
const DEVICE_CODE_TTL_MS = 15 * 60000; // what codex says today; used when it stops saying
// A dialog holds the tool call open. Five minutes is ample to open a link and type a code;
// past it the result path returns the still-valid code instead of risking a host that kills
// long calls on a cap it never told us about.
const DIALOG_WAIT_MAX_MS = 5 * 60000;
// Below this much host budget a dialog cannot be answered in time: return the link at once.
const DIALOG_MIN_BUDGET_MS = 15000;

/** @typedef {{url:string, code:string, expiresAt:number}} DevicePrompt */
/** @typedef {{prompt?:DevicePrompt, error?:string, ended:boolean, done:Promise<boolean>, authBefore?:(number|null)}} DeviceFlight */
/**
 * Where a device login stands, for the `codex-login` tool and on ask()'s auth results.
 * @typedef {{status:("authenticated"|"pending"|"starting"|"declined"|"failed"|"unavailable"), message:string, url?:string, code?:string, expiresAt?:number}} LoginResult
 */

/**
 * Link, code and lifetime from `codex login --device-auth` output (codex colours it even into a
 * pipe). This is codex's text for humans, not an API, so the match is loose and anything
 * unrecognised is null - the caller then reports the raw output instead of guessing.
 * @param {string} text
 * @returns {{url:string, code:string, expiresInMs:number}|null}
 */
function parseDevicePrompt(text) {
  const t = String(text || "").replace(ANSI_RE, "");
  // By role, not position: codex can print an update notice with its own link first. And only
  // an OpenAI host is ever offered as a login link; anything else falls back to raw output.
  // Each token must be followed by whitespace: at the end of a partial chunk "ABCD-1234" or
  // ".../dev" would otherwise pass for the whole thing, and the first parse wins.
  const urls = (t.match(/https:\/\/\S+(?=\s)/g) || []).filter(isOpenAiUrl);
  const url = urls.find((u) => /\/device\b/.test(u)) || urls[0];
  const code = (t.match(/\b[A-Z0-9]{4,}-[A-Z0-9]{4,}(?=\s)/) || [])[0];
  if (!url || !code) return null;
  const mins = t.match(/expires in (\d+) minute/i);
  return { url, code, expiresInMs: mins ? Number(mins[1]) * 60000 : DEVICE_CODE_TTL_MS };
}

/** @param {string} u */
function isOpenAiUrl(u) {
  try {
    const h = new URL(u).hostname;
    return ["openai.com", "chatgpt.com"].some((d) => h === d || h.endsWith(`.${d}`));
  } catch { return false; }
}

/** @param {string} text */
function outputTail(text) {
  return text.replace(ANSI_RE, "").trim().slice(-300);
}

/**
 * Spawns `codex login --device-auth`, streaming its output to `onText`. Resolved like every
 * other codex spawn (CODEX_BIN, the Windows shim bypass), with the same credential scrub.
 * @param {Record<string, (string|undefined)>} env
 * @param {(text: string) => void} onText
 * @returns {{exit: Promise<number>, kill: () => void}}
 */
function defaultSpawnLogin(env, onText) {
  const plan = buildSpawnPlan({ env, args: ["login", "--device-auth"] });
  // Its own process group (POSIX): an npm install runs a Node launcher that starts the native
  // binary, and killing the launcher alone leaves the real login polling - it could still land
  // after a decline. killTree takes the whole group.
  const child = spawn(plan.cmd, plan.argv, { env: codexEnv(env), stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true });
  child.stdout.on("data", (d) => onText(String(d)));
  child.stderr.on("data", (d) => onText(String(d)));
  const reap = () => killTree(child);
  liveLogins.add(reap);
  const exit = new Promise((resolve) => {
    child.on("error", (e) => { liveLogins.delete(reap); onText(String(e.message)); resolve(127); });
    child.on("close", (code) => { liveLogins.delete(reap); resolve(code == null ? 1 : code); });
  });
  return { exit: /** @type {Promise<number>} */ (exit), kill: reap };
}

/**
 * Kill a spawned CLI and everything it started. POSIX: the child leads its own process group.
 * Windows: taskkill /T walks the tree.
 * @param {import("node:child_process").ChildProcess} child
 */
function killTree(child) {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => {});
    else process.kill(-child.pid, "SIGKILL");
  } catch {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }
}

/** Every device login still running, so a server shutting down can end them. */
const liveLogins = new Set();
let loginsClosed = false;
/** End every device login this process started (exit). */
function killDeviceLogins() {
  for (const reap of [...liveLogins]) reap();
}
/**
 * The session is over (stdin closed, SIGTERM): end every login AND refuse new ones - a codex run
 * still in flight could otherwise hit a spent login afterwards and start one nobody will see.
 */
function shutdownDeviceLogins() {
  loginsClosed = true;
  killDeviceLogins();
}
process.once("exit", killDeviceLogins);

/**
 * One device login at a time for the whole process: a second caller while a code is still
 * valid gets the same code, so a consensus round and a parallel ask never show two.
 * @param {{spawnLogin?: typeof defaultSpawnLogin, now?: () => number, killGraceMs?: number, promptWaitMs?: number, isClosed?: () => boolean}} [o]
 * @returns {{start: (env: Record<string, (string|undefined)>) => Promise<DeviceFlight>, cancel: () => void}}
 */
function makeDeviceLogin(o = {}) {
  const spawnLogin = o.spawnLogin || defaultSpawnLogin;
  const now = o.now || Date.now;
  const killGraceMs = typeof o.killGraceMs === "number" ? o.killGraceMs : 5000;
  const promptWaitMs = typeof o.promptWaitMs === "number" ? o.promptWaitMs : DEVICE_PROMPT_WAIT_MS;
  const isClosed = o.isClosed || (() => loginsClosed);
  /** @type {{finished:boolean, expiresAt:number, ready:Promise<DeviceFlight>, kill:()=>void}|null} */
  let flight = null;

  /** @param {Record<string, (string|undefined)>} env */
  function launch(env) {
    let text = "";
    let promptEnd = 0; // after a code is shown, only what codex prints next explains a failure
    /** @type {ReturnType<typeof setTimeout>|undefined} */ let noCode;
    /** @type {(ok: boolean) => void} */ let finish = () => {};
    // auth.json as it was when THIS login began, shared by every caller that joins it: one that
    // joins after the approval was saved must still see the credentials as new.
    /** @type {DeviceFlight} */
    const state = { ended: false, done: new Promise((r) => { finish = r; }), authBefore: authStamp(env) };
    /** @type {(v: DeviceFlight) => void} */ let settle = () => {};
    const f = { finished: false, expiresAt: Infinity, kill: () => {}, ready: /** @type {Promise<DeviceFlight>} */ (new Promise((r) => { settle = r; })) };
    /** @param {string} error */
    const fail = (error) => {
      if (state.prompt || state.error) return;
      state.error = error;
      f.finished = true; // the next start() launches a fresh login instead of joining this one
      settle(state);
    };
    const proc = spawnLogin(env, (chunk) => {
      text += chunk;
      const p = state.prompt || state.error ? null : parseDevicePrompt(text);
      if (!p) return;
      clearTimeout(noCode); // a code is out: from here only its expiry (or the user) ends the login
      f.expiresAt = now() + p.expiresInMs;
      promptEnd = text.length;
      state.prompt = { url: p.url, code: p.code, expiresAt: f.expiresAt };
      // Reap a code nobody used, whether or not codex exits on expiry by itself.
      setTimeout(() => { if (!f.finished) proc.kill(); }, p.expiresInMs + killGraceMs).unref();
      settle(state);
    });
    f.kill = proc.kill;
    // Armed after the spawn: a codex (or fake) that printed its code synchronously found no timer
    // to clear, so the guard below keeps this from killing a login that already showed its code.
    noCode = setTimeout(() => {
      if (state.prompt || f.finished) return;
      fail(`no code within ${Math.round(promptWaitMs / 1000)}s: ${outputTail(text)}`);
      proc.kill();
    }, promptWaitMs);
    noCode.unref();
    proc.exit.then((code) => {
      clearTimeout(noCode);
      // Success is the file, not the exit code alone: that is what the next call looks for.
      const ok = code === 0 && codexHasLogin({ env });
      fail(outputTail(text) || `exited ${code}`); // no-op once a code was shown
      f.finished = true;
      state.ended = true;
      if (!ok && !state.error) state.error = outputTail(text.slice(promptEnd)) || `exited with code ${code}`;
      finish(ok);
    });
    return f;
  }

  return {
    start(env) {
      if (isClosed()) return Promise.resolve({ error: "the server is shutting down", ended: true, done: Promise.resolve(false) });
      if (flight && !flight.finished && now() < flight.expiresAt) return flight.ready;
      if (flight && !flight.finished) flight.kill(); // an expired code: nobody can use it
      flight = launch(env);
      return flight.ready;
    },
    // The user refused this code: end the login so it can never land.
    cancel() {
      if (flight && !flight.finished) { flight.finished = true; flight.kill(); }
    },
  };
}

/**
 * A deadline a call in flight awaits. Deliberately NOT unref'd: an unref'd timer lets the process
 * (or a test runner) decide nothing is pending while a caller still waits on it. `stop` clears it
 * once the race is decided, so it never outlives the call.
 * @template T
 * @param {number} ms
 * @param {T} value
 * @returns {{promise: Promise<T>, stop: () => void}}
 */
function deadline(ms, value) {
  /** @type {ReturnType<typeof setTimeout>|undefined} */ let timer;
  const promise = /** @type {Promise<T>} */ (new Promise((r) => { timer = setTimeout(() => r(value), ms); }));
  return { promise, stop: () => clearTimeout(timer) };
}

/**
 * When auth.json last changed, or null when there is none - so a login that landed can be told
 * apart from one that did not, whatever its exit code said.
 * @param {Record<string, (string|undefined)>} env
 * @returns {number|null}
 */
function authStamp(env) {
  try {
    return fs.statSync(path.join(env.CODEX_HOME || path.join(os.homedir(), ".codex"), "auth.json")).mtimeMs;
  } catch { return null; }
}

/**
 * @param {DevicePrompt} prompt
 * @returns {string}
 */
function loginMessage(prompt) {
  const minutes = Math.max(1, Math.round((prompt.expiresAt - Date.now()) / 60000));
  return `GPT (Codex) needs a ChatGPT login on this machine. Open ${prompt.url} and enter the code ${prompt.code} ` +
    `(expires in ${minutes} min). GPT answers on the next call after you approve. ` +
    "The code signs this machine's codex into your ChatGPT account: only continue if you are using GPT through " +
    "deliberation in this session. It is a login of its own - never copy auth.json from another machine.";
}

/**
 * @param {Object} [opts]
 * @param {(args:{prompt:string,cwd?:string,timeoutMs?:number,mode?:("advisory"|"implement"),env?:Record<string,(string|undefined)>})=>Promise<{code:number,stdout:string,stderr:string,timedOut?:boolean,spawnFailed?:boolean}>} [opts.run]
 * @param {string} [opts.model]
 * @param {boolean} [opts.allowImplement]  construction-time lock (first of two AND-ed locks).
 *   When false/absent, this provider is read-only no matter what `req.mode` says. Set ONLY in a
 *   composition root that has a local workspace + a human-gated write surface (section 3).
 * @param {number} [opts.timeoutMs]  construction-time default per-call ceiling (ms). Falls back to CODEX_DEFAULT_TIMEOUT_MS.
 * @param {Record<string, (string|undefined)>} [opts.env]  environment read for the host budget
 *   (MCP_TOOL_TIMEOUT), the health probe, and the child's credential. Defaults to process.env;
 *   tests inject it so a capped host (Claude Code on the web) does not change what they assert.
 * @param {boolean} [opts.deviceLogin]  log in on first use: with no working credential, start
 *   `codex login --device-auth` and return its link + code instead of failing. The composition
 *   root turns it on; the library default is off, so nothing spawns a login unasked.
 * @param {(prompt: DevicePrompt, waitMs: number, signal: AbortSignal) => Promise<("accept"|"decline"|"none")>} [opts.confirmLogin]
 *   shows the link + code in the host's own UI (an MCP elicitation) and resolves with the user's
 *   action. "none" (no dialog, dismissed, error, timeout) keeps the code valid and it rides in
 *   the result; "decline" ends that login.
 * @param {{start: (env: Record<string, (string|undefined)>) => Promise<DeviceFlight>, cancel: () => void}} [opts.login]
 *   the device-login manager (tests inject one with a fake CLI)
 * @returns {Provider & {login: (req?: Partial<DelegationRequest>) => Promise<LoginResult>}}
 */
function makeCodexProvider(opts = {}) {
  const run = opts.run || defaultRun;
  const env = opts.env || process.env;
  const model = opts.model || "default"; // codex resolves its own model from config.toml
  const allowImplement = opts.allowImplement === true;
  const deviceLogin = opts.deviceLogin === true;
  const login = opts.login || makeDeviceLogin();
  const confirmLogin = opts.confirmLogin;
  const defaultTimeoutMs = typeof opts.timeoutMs === "number" && opts.timeoutMs > 0
    ? opts.timeoutMs
    : CODEX_DEFAULT_TIMEOUT_MS;

  /**
   * @param {number} started
   * @param {string} message
   * @param {Partial<LoginResult>} [state]
   */
  const authError = (started, message, state = {}) =>
    ({ provider: "codex", model, isError: true, errorKind: "auth", retryable: false, message, deviceLogin: { ...state, message }, ms: Date.now() - started, reasoningEffort: null });

  /**
   * What the host still allows after `started`: a call that waited for a login must not hand
   * the codex run the budget stamped at tool entry.
   * @param {DelegationRequest} req
   * @param {number} started
   * @returns {DelegationRequest}
   */
  const afterWait = (req, started) => typeof req.hostBudgetRemainingMs === "number"
    // Floored at 1 ms, never 0 or below: clampToHostBudget reads a non-positive budget as
    // "none given" and would hand back the whole cap.
    ? { ...req, hostBudgetRemainingMs: spendHostBudget(req.hostBudgetRemainingMs, Date.now() - started) }
    : req;

  /**
   * Start (or join) the device login and give the user the code. Resolves null once a login
   * has landed, or the error result to return when it has not.
   * @param {DelegationRequest} req
   * @param {number} started
   * @param {string} [lead]  codex's own failure line, when a spent login brought us here
   * @returns {Promise<object|null>}
   */
  async function signIn(req, started, lead = "") {
    // The action leads, codex's own line follows: whatever truncates a long error keeps the code.
    const tail = lead ? `\n\n${lead}` : "";
    // Waiting for codex to print its code spends this call's budget too: bound it, and leave the
    // shared login running for the next call if the code is not out in time. Half, like the
    // dialog wait below: the rest is for that wait and the codex run itself.
    const acquireLeft = /** @type {number} */ (clampToHostBudget(Number.MAX_SAFE_INTEGER, env, afterWait(req, started).hostBudgetRemainingMs).timeoutMs);
    const acquireMs = Math.min(acquireLeft / 2, DEVICE_PROMPT_WAIT_MS + 1000);
    const acquire = deadline(acquireMs, null);
    const flight = /** @type {DeviceFlight|null} */ (await Promise.race([login.start(env), acquire.promise]));
    acquire.stop();
    if (!flight) return authError(started, `GPT (Codex) needs a ChatGPT login on this machine; \`codex login --device-auth\` is starting but has no code yet within this call's time. The next GPT call shows it.${tail}`, { status: "starting" });
    if (!flight.prompt) return authError(started, `GPT (Codex) has no working ChatGPT login here, and \`codex login --device-auth\` gave no code: ${flight.error}${tail}`, { status: "failed" });
    const prompt = flight.prompt;
    // Wait only while the code lives, at most DIALOG_WAIT_MAX_MS, and at most half of what the
    // host still allows this call (after any failed first run) - the other half is the codex run.
    const hostLeft = /** @type {number} */ (clampToHostBudget(Number.MAX_SAFE_INTEGER, env, afterWait(req, started).hostBudgetRemainingMs).timeoutMs);
    const waitMs = Math.min(prompt.expiresAt - Date.now(), DIALOG_WAIT_MAX_MS, hostLeft / 2);
    if (confirmLogin && waitMs > 0 && hostLeft >= DIALOG_MIN_BUDGET_MS) {
      const wait = deadline(waitMs, false);
      const timeout = /** @type {Promise<any>} */ (wait.promise); // races mixed outcomes below
      // Aborted once this call stops waiting, so the host can close a dialog nobody reads.
      const dialog = new AbortController();
      const viaDialog = Promise.resolve()
        .then(() => confirmLogin(prompt, waitMs, dialog.signal))
        .then((action) => (action === "accept" ? Promise.race([flight.done, timeout]) : action), () => "none");
      // Approving in the browser without touching the dialog counts too.
      const outcome = await Promise.race([viaDialog, flight.done, timeout]);
      wait.stop();
      dialog.abort();
      if (outcome === true) return null;
      if (outcome === "decline") {
        login.cancel();
        // The login may have landed just before the decline (or as we killed it): never claim a
        // code is dead when it was used, and never delete a credential file on the user's behalf.
        const settle = deadline(250, false);
        const exitedOk = await Promise.race([flight.done, settle.promise]);
        settle.stop();
        // A login killed right after saving reports a failed exit: the file is the truth.
        const stamp = authStamp(env);
        const landed = exitedOk || (stamp !== null && stamp !== flight.authBefore);
        if (landed) return authError(started, `You declined, but the ChatGPT login had already completed on this machine. GPT is skipped this time. If you did not approve that login yourself, run \`codex logout\` here.${tail}`, { status: "declined" });
        return authError(started, `You declined the ChatGPT login for GPT (Codex), so GPT is skipped this time and that code no longer works. The next GPT call offers a new one.${tail}`, { status: "declined" });
      }
    }
    // A login that ended without landing has a dead code: say so rather than show it.
    if (flight.ended) return authError(started, `\`codex login --device-auth\` ended before the login landed: ${flight.error}. The next GPT call starts a fresh one.${tail}`, { status: "failed" });
    return authError(started, `${loginMessage(prompt)}${tail}`, { status: "pending", url: prompt.url, code: prompt.code, expiresAt: prompt.expiresAt });
  }

  /**
   * One `codex exec` run, mapped to a result.
   * @param {DelegationRequest} req
   * @param {number} started
   * @returns {Promise<{result: object, refreshLine?: string}>}
   */
  async function runOnce(req, started) {
    // Two-lock gate: write only when constructed write-capable AND this call explicitly asks.
    const mode = allowImplement && req.mode === "implement" ? "implement" : "advisory";
    const full = req.developerInstructions ? `${req.developerInstructions}\n\n---\n\n${req.prompt}` : req.prompt;
    // Effective ceiling: explicit per-call wins, else the construction default,
    // else the module default. Always a positive number, so defaultRun's kill
    // timer is ALWAYS armed - no Codex call can run unbounded.
    // Then clamped under the host's own per-call cap (MCP_TOOL_TIMEOUT), so a run the
    // host would kill mid-flight fails HERE first, as a timeout that names the cap.
    const clamp = clampToHostBudget(typeof req.timeoutMs === "number" && req.timeoutMs > 0 ? req.timeoutMs : defaultTimeoutMs, env, req.hostBudgetRemainingMs);
    const timeoutMs = /** @type {number} */ (clamp.timeoutMs);
    const { code, stdout, stderr, timedOut, spawnFailed } = await run({ prompt: full, cwd: req.cwd, timeoutMs, mode, env });
    if (code === 0) {
      // Codex CLI has no per-call reasoning-effort knob in this integration -> null.
      return { result: { provider: "codex", model, text: stdout.trim(), isError: false, ms: Date.now() - started, reasoningEffort: null } };
    }
    // The kill timer is authoritative: a run we killed is a timeout regardless of what
    // (if anything) landed on stderr. Without this a codex timeout classifies as
    // `unknown` and can never trip the consensus circuit breaker.
    // Both flags are authoritative over the stderr classifier, for the same reason: they
    // describe the RUN, while stderr is the child's own text. `not-found` is non-retryable -
    // callProvider retries only network/rate-limit/empty, so a missing CLI fails fast.
    const { errorKind, retryable } = timedOut
      ? { errorKind: "timeout", retryable: true }
      : spawnFailed
        ? { errorKind: "not-found", retryable: false }
        : classifyCodex(stderr, full);
    const output = (stdout && stdout.trim()) || stderr || undefined;
    // codex's line and the fix LEAD: codex prints its banner and echoes the whole prompt on
    // stderr first, so the line would otherwise sit far below them. Gated on `auth`, so
    // errorKind and message never disagree.
    const refreshLine = errorKind === "auth" ? refreshFailureLine(stderr, full) : undefined;
    return {
      refreshLine,
      result: {
        provider: "codex",
        model,
        isError: true,
        errorKind,
        retryable,
        // Error results carry no text; surface stdout/stderr diagnostics in message.
        message: timedOut
          ? annotateTimeout({ code: "timeout", message: `codex timed out after ${Math.round(timeoutMs / 1000)}s` }, clamp).message
          : refreshLine ? `${refreshLine}\n${CODEX_REFRESH_HINT}\n\n${output}` : output,
        ms: Date.now() - started,
        reasoningEffort: null,
      },
    };
  }

  return {
    name: "codex",
    // canImplement reflects the construction lock so discovery (panel) is honest about THIS
    // process. Option A: no threadId continuity (multiTurn:false).
    capabilities: { canImplement: allowImplement, fileUpload: false, multiTurn: false, walksFilesystem: true },
    async health() {
      const h = codexHealth({ env });
      // No credential is the one gap ask() can close itself, so it must not keep GPT off the panel.
      return deviceLogin && h.needsLogin ? { ok: true } : h;
    },
    async ask(req) {
      const started = Date.now();
      if (deviceLogin && !codexHasAuth({ env })) {
        const blocked = await signIn(req, started);
        if (blocked) return /** @type {any} */ (blocked);
        return /** @type {any} */ ((await runOnce(afterWait(req, started), started)).result);
      }
      const first = await runOnce(req, started);
      if (!(deviceLogin && first.refreshLine)) return /** @type {any} */ (first.result);
      // A spent login (a copied auth.json that another machine refreshed first): replace it, retry once.
      const blocked = await signIn(req, started, first.refreshLine);
      if (blocked) return /** @type {any} */ (blocked);
      return /** @type {any} */ ((await runOnce(afterWait(req, started), started)).result);
    },
    // The login ask() would start, without a question: an agent that decides a logged-out GPT
    // call "would only return a link" skips the call, and then nobody ever gets the code.
    async login(req = {}) {
      const started = Date.now();
      // A credential FILE is all a stat can see: a copied or spent auth.json looks the same.
      if (codexHasAuth({ env })) {
        return {
          status: "authenticated",
          message: "GPT (Codex) already has a credential on this machine. If GPT calls still fail with \"access token could not be refreshed\", " +
            "that login is spent: the next GPT call replaces it with a new device login, or run `codex logout` here and then /deliberation:login.",
        };
      }
      if (!deviceLogin) return { status: "unavailable", message: "Login on first use is off in this process: run `codex login` (`codex login --device-auth` on a remote machine) yourself." };
      const blocked = /** @type {any} */ (await signIn(/** @type {DelegationRequest} */ ({ prompt: "", ...req }), started));
      if (!blocked) return { status: "authenticated", message: "Logged in. GPT answers from the next call." };
      // signIn's auth results always carry deviceLogin; the fallback keeps the contract total.
      return /** @type {LoginResult} */ (blocked.deviceLogin || { status: "failed", message: String(blocked.message || "device login failed") });
    },
  };
}

module.exports = { makeCodexProvider, classifyCodex, codexExecArgs, buildSpawnPlan, codexEnv, codexHasLogin, codexHasAuth, codexHealth, parseDevicePrompt, makeDeviceLogin, killDeviceLogins, shutdownDeviceLogins, CODEX_DEFAULT_TIMEOUT_MS };
