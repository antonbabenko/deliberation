"use strict";
/** @typedef {import("../types.js").Provider} Provider */
const { toErrorResult } = require("../provider.js");

/**
 * @param {Object} [opts]
 * @param {Object} [opts.bridge]
 * @param {string} [opts.model]
 * @param {boolean} [opts.allowImplement]  construction-time lock (first of two AND-ed locks).
 *   When false/absent, this provider is read-only no matter what `req.mode` says. Set ONLY in a
 *   composition root that has a local workspace + a human-gated write surface (section 3).
 * @returns {Provider}
 */
function makeAntigravityProvider(opts = {}) {
  // Core is transport-agnostic: the caller injects the bridge (the composition
  // root wires it). Cast to any - the CJS bridge exports as a bare Object, and
  // the cast also stops tsc from deep-checking the legacy bridge transitively.
  const bridge = /** @type {any} */ (opts.bridge);
  if (!bridge) throw new Error("makeAntigravityProvider requires opts.bridge (core is transport-agnostic; inject the gemini bridge)");
  const model = opts.model || process.env.GEMINI_DEFAULT_MODEL || "auto-gemini-3";
  const allowImplement = opts.allowImplement === true;

  return {
    name: "gemini",
    // canImplement reflects the construction lock so discovery (panel) is honest about THIS process.
    capabilities: { canImplement: allowImplement, fileUpload: false, multiTurn: true, walksFilesystem: true },
    async health() {
      return typeof bridge.runGemini === "function" ? { ok: true } : { ok: false, reason: "agy bridge unavailable" };
    },
    async ask(req) {
      const started = Date.now();
      // Two-lock gate: write only when constructed write-capable AND this call explicitly asks.
      // Anything else stays advisory (read-only). buildAgyArgs maps sandbox:"workspace-write" ->
      // --dangerously-skip-permissions, else --sandbox; runGemini's readOnly is the explicit
      // caller decision (never argv-inferred) and engages the OS sandbox + mutation detection.
      // The credential env scrub runs in BOTH modes (bridge-side), so a write run still cannot
      // read the operator's keys / SSH agent. The bridge folds developerInstructions into the
      // prompt when present (no system channel in agy print mode).
      const implement = allowImplement && req.mode === "implement";
      const includeDirs = (req.files || []).filter((f) => f.dir).map((f) => f.dir);
      const args = bridge.buildAgyArgs({
        prompt: req.prompt,
        model,
        sandbox: implement ? "workspace-write" : "read-only",
        developerInstructions: req.developerInstructions,
        includeDirs,
      });
      try {
        // runGemini(args, cwd, timeoutMs, recoveryGraceMs, opts). recovered:true => normal success.
        const out = await bridge.runGemini(args, req.cwd, req.timeoutMs, undefined, { readOnly: !implement, includeDirs });
        // out.response can be undefined on a degenerate clean run; coerce to ""
        // so the DelegationSuccess.text contract (string, not string|undefined) holds.
        // Gemini (agy CLI) has no per-call reasoning-effort knob -> null.
        // workspaceMutated (advisory taint signal) is surfaced when the run changed the workspace.
        return { provider: "gemini", model, text: out.response || "", threadId: out.threadId, isError: false, ms: Date.now() - started, reasoningEffort: null, ...(out.workspaceMutated ? { workspaceMutated: true } : {}) };
      } catch (e) {
        // classifyGeminiError(errMsg, errCode): the missing-cli and upstream-abort
        // branches key off the message, so pass the real caught message - not "".
        const err = /** @type {any} */ (e);
        return toErrorResult("gemini", model, started, err, (_status, code) =>
          bridge.classifyGeminiError((err && err.message) || "", code), { reasoningEffort: null }
        );
      }
    },
  };
}

module.exports = { makeAntigravityProvider };
