"use strict";
/** @typedef {import("../types.js").Provider} Provider */
const { spawn } = require("node:child_process");
const { resolveCommand, shimMessage } = require("../resolve-bin.js");

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

/**
 * Map codex stderr to the shared errorKind vocabulary.
 * @param {string} [stderr]
 * @returns {{errorKind:string, retryable:boolean}}
 */
function classifyCodex(stderr) {
  const s = (stderr || "").toLowerCase();
  // A failed SPAWN is deliberately not classified here - see the `spawnFailed` flag in `ask`.
  // Matching "enoent"/"einval" as substrings would also fire on a codex run that legitimately
  // printed ENOENT about a file in the user's own repo, which is a normal thing for a coding
  // agent to say, and would then tell that user to go fix their CODEX_BIN.
  if (s.includes("auth") || s.includes("login")) return { errorKind: "auth", retryable: false };
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
  return { cmd: target.cmd, argv: [...target.prefixArgs, ...codexExecArgs(o.mode)], shim: target.shim, name };
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
 * @param {{prompt:string, cwd?:string, timeoutMs?:number, mode?:("advisory"|"implement")}} args
 * @returns {Promise<{code:number, stdout:string, stderr:string, timedOut:boolean, spawnFailed?:boolean}>}
 */
function defaultRun({ prompt, cwd, timeoutMs, mode }) {
  return new Promise((resolve) => {
    const plan = buildSpawnPlan({ mode });
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
    const child = spawn(plan.cmd, plan.argv, { cwd: cwd || process.cwd() });
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

/**
 * @param {Object} [opts]
 * @param {(args:{prompt:string,cwd?:string,timeoutMs?:number,mode?:("advisory"|"implement")})=>Promise<{code:number,stdout:string,stderr:string,timedOut?:boolean,spawnFailed?:boolean}>} [opts.run]
 * @param {string} [opts.model]
 * @param {boolean} [opts.allowImplement]  construction-time lock (first of two AND-ed locks).
 *   When false/absent, this provider is read-only no matter what `req.mode` says. Set ONLY in a
 *   composition root that has a local workspace + a human-gated write surface (section 3).
 * @param {number} [opts.timeoutMs]  construction-time default per-call ceiling (ms). Falls back to CODEX_DEFAULT_TIMEOUT_MS.
 * @returns {Provider}
 */
function makeCodexProvider(opts = {}) {
  const run = opts.run || defaultRun;
  const model = opts.model || "default"; // codex resolves its own model from config.toml
  const allowImplement = opts.allowImplement === true;
  const defaultTimeoutMs = typeof opts.timeoutMs === "number" && opts.timeoutMs > 0
    ? opts.timeoutMs
    : CODEX_DEFAULT_TIMEOUT_MS;
  return {
    name: "codex",
    // canImplement reflects the construction lock so discovery (panel) is honest about THIS
    // process. Option A: no threadId continuity (multiTurn:false).
    capabilities: { canImplement: allowImplement, fileUpload: false, multiTurn: false, walksFilesystem: true },
    async health() { return { ok: true }; },
    async ask(req) {
      const started = Date.now();
      // Two-lock gate: write only when constructed write-capable AND this call explicitly asks.
      const mode = allowImplement && req.mode === "implement" ? "implement" : "advisory";
      const full = req.developerInstructions ? `${req.developerInstructions}\n\n---\n\n${req.prompt}` : req.prompt;
      // Effective ceiling: explicit per-call wins, else the construction default,
      // else the module default. Always a positive number, so defaultRun's kill
      // timer is ALWAYS armed - no Codex call can run unbounded.
      const timeoutMs = typeof req.timeoutMs === "number" && req.timeoutMs > 0 ? req.timeoutMs : defaultTimeoutMs;
      const { code, stdout, stderr, timedOut, spawnFailed } = await run({ prompt: full, cwd: req.cwd, timeoutMs, mode });
      if (code === 0) {
        // Codex CLI has no per-call reasoning-effort knob in this integration -> null.
        return { provider: "codex", model, text: stdout.trim(), isError: false, ms: Date.now() - started, reasoningEffort: null };
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
          : classifyCodex(stderr);
      return {
        provider: "codex",
        model,
        isError: true,
        errorKind,
        retryable,
        // Error results carry no text; surface stdout/stderr diagnostics in message.
        message: (stdout && stdout.trim()) || stderr || undefined,
        ms: Date.now() - started,
        reasoningEffort: null,
      };
    },
  };
}

module.exports = { makeCodexProvider, classifyCodex, codexExecArgs, buildSpawnPlan, CODEX_DEFAULT_TIMEOUT_MS };
