"use strict";
/** @typedef {import("../types.js").Provider} Provider */
const { toErrorResult } = require("../provider.js");

/**
 * @param {Object} [opts]
 * @param {Object} [opts.bridge]
 * @param {string} [opts.model]
 * @returns {Provider}
 */
function makeAntigravityProvider(opts = {}) {
  // Core is transport-agnostic: the caller injects the bridge (the composition
  // root wires it). Cast to any - the CJS bridge exports as a bare Object, and
  // the cast also stops tsc from deep-checking the legacy bridge transitively.
  const bridge = /** @type {any} */ (opts.bridge);
  if (!bridge) throw new Error("makeAntigravityProvider requires opts.bridge (core is transport-agnostic; inject the gemini bridge)");
  const model = opts.model || process.env.GEMINI_DEFAULT_MODEL || "auto-gemini-3";

  return {
    name: "gemini",
    capabilities: { canImplement: true, fileUpload: false, multiTurn: true, walksFilesystem: true },
    async health() {
      return typeof bridge.runGemini === "function" ? { ok: true } : { ok: false, reason: "agy bridge unavailable" };
    },
    async ask(req) {
      const started = Date.now();
      // buildAgyArgs(req) real signature: { prompt, model, sandbox, includeDirs, developerInstructions }.
      // Pin sandbox:"read-only" so Core stays advisory; the bridge folds
      // developerInstructions into the prompt when present (no system channel in agy print mode).
      const includeDirs = (req.files || []).filter((f) => f.dir).map((f) => f.dir);
      const args = bridge.buildAgyArgs({
        prompt: req.prompt,
        model,
        sandbox: "read-only",
        developerInstructions: req.developerInstructions,
        includeDirs,
      });
      try {
        // runGemini(args, cwd, timeoutMs, recoveryGraceMs, opts). recovered:true => normal
        // success. opts.readOnly:true engages the OS sandbox + env scrub + mutation detection;
        // includeDirs widens detection to --add-dir roots.
        const out = await bridge.runGemini(args, req.cwd, req.timeoutMs, undefined, { readOnly: true, includeDirs });
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
