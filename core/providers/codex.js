"use strict";
/** @typedef {import("../types.js").Provider} Provider */
const { spawn } = require("node:child_process");

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
 * Argv for an advisory `codex exec` run. `--sandbox read-only` is hard-pinned so
 * the run cannot inherit a writable global default from ~/.codex/config.toml
 * (e.g. sandbox_mode = "workspace-write" + approval_policy = "never"). codex
 * enforces this at the OS level (Seatbelt on macOS, Landlock/seccomp on Linux).
 * Core providers only ever serve advisory paths (ask-one / ask-all / consensus);
 * implementation mode runs through the separate native codex MCP server, which
 * owns its own sandbox parameter and is untouched here. The opts.run injection
 * point remains the escape hatch if a caller ever needs different argv.
 * @returns {string[]}
 */
function codexExecArgs() {
  return ["exec", "--sandbox", "read-only", "--skip-git-repo-check"];
}

/**
 * Default spawner: `codex exec` reading the prompt on stdin, capturing stdout.
 * @param {{prompt:string, cwd?:string, timeoutMs?:number}} args
 * @returns {Promise<{code:number, stdout:string, stderr:string}>}
 */
function defaultRun({ prompt, cwd, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn("codex", codexExecArgs(), { cwd: cwd || process.cwd() });
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
 * @param {(args:{prompt:string,cwd?:string,timeoutMs?:number})=>Promise<{code:number,stdout:string,stderr:string}>} [opts.run]
 * @param {string} [opts.model]
 * @returns {Provider}
 */
function makeCodexProvider(opts = {}) {
  const run = opts.run || defaultRun;
  const model = opts.model || "default"; // codex resolves its own model from config.toml
  return {
    name: "codex",
    capabilities: { canImplement: true, fileUpload: false, multiTurn: false, walksFilesystem: true }, // Option A: no threadId continuity
    async health() { return { ok: true }; },
    async ask(req) {
      const started = Date.now();
      const full = req.developerInstructions ? `${req.developerInstructions}\n\n---\n\n${req.prompt}` : req.prompt;
      const { code, stdout, stderr } = await run({ prompt: full, cwd: req.cwd, timeoutMs: req.timeoutMs });
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

module.exports = { makeCodexProvider, classifyCodex, codexExecArgs };
