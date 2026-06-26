"use strict";
/** @typedef {import("../types.js").Provider} Provider */
const { spawn } = require("node:child_process");

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
 * Default spawner: `codex exec` reading the prompt on stdin, capturing stdout.
 * @param {{prompt:string, cwd?:string, timeoutMs?:number, mode?:("advisory"|"implement")}} args
 * @returns {Promise<{code:number, stdout:string, stderr:string}>}
 */
function defaultRun({ prompt, cwd, timeoutMs, mode }) {
  return new Promise((resolve) => {
    const child = spawn("codex", codexExecArgs(mode), { cwd: cwd || process.cwd() });
    let stdout = "", stderr = "", settled = false;
    const timer = timeoutMs ? setTimeout(() => child.kill("SIGKILL"), timeoutMs) : null;
    if (timer) timer.unref(); // never hold the event loop open on the timeout timer
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => {
      if (settled) return; settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code: 127, stdout: "", stderr: String((e && e.message) || e) });
    });
    child.on("close", (code) => {
      if (settled) return; settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code: code == null ? 1 : code, stdout, stderr });
    });
    child.stdin.end(prompt);
  });
}

/**
 * @param {Object} [opts]
 * @param {(args:{prompt:string,cwd?:string,timeoutMs?:number,mode?:("advisory"|"implement")})=>Promise<{code:number,stdout:string,stderr:string}>} [opts.run]
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
      const { code, stdout, stderr } = await run({ prompt: full, cwd: req.cwd, timeoutMs, mode });
      if (code === 0) {
        // Codex CLI has no per-call reasoning-effort knob in this integration -> null.
        return { provider: "codex", model, text: stdout.trim(), isError: false, ms: Date.now() - started, reasoningEffort: null };
      }
      const { errorKind, retryable } = classifyCodex(stderr);
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

module.exports = { makeCodexProvider, classifyCodex, codexExecArgs, CODEX_DEFAULT_TIMEOUT_MS };
