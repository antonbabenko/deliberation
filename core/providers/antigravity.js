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
  // Cast the bridge to any: its CJS module.exports is typed as bare Object, and
  // casting also stops tsc from deep-checking the legacy bridge transitively.
  const bridge = /** @type {any} */ (opts.bridge || require("../../server/gemini/index.js"));
  const model = opts.model || process.env.GEMINI_DEFAULT_MODEL || "auto-gemini-3";

  return {
    name: "gemini",
    capabilities: { canImplement: true, fileUpload: false, multiTurn: true },
    async health() {
      return typeof bridge.runGemini === "function" ? { ok: true } : { ok: false, reason: "agy bridge unavailable" };
    },
    async ask(req) {
      const started = Date.now();
      // buildAgyArgs(req) real signature: { prompt, model, sandbox, includeDirs, developerInstructions }.
      // Pin sandbox:"read-only" so Core stays advisory; the bridge folds
      // developerInstructions into the prompt when present (no system channel in agy print mode).
      const args = bridge.buildAgyArgs({
        prompt: req.prompt,
        model,
        sandbox: "read-only",
        developerInstructions: req.developerInstructions,
        includeDirs: (req.files || []).filter((f) => f.dir).map((f) => f.dir),
      });
      try {
        // runGemini(args, cwd, timeoutMs, recoveryGraceMs). recovered:true => normal success.
        const out = await bridge.runGemini(args, req.cwd, req.timeoutMs, undefined);
        // out.response can be undefined on a degenerate clean run; coerce to ""
        // so the DelegationSuccess.text contract (string, not string|undefined) holds.
        return { provider: "gemini", model, text: out.response || "", threadId: out.threadId, isError: false, ms: Date.now() - started };
      } catch (e) {
        // classifyGeminiError(errMsg, errCode): the missing-cli and upstream-abort
        // branches key off the message, so pass the real caught message - not "".
        const err = /** @type {any} */ (e);
        return toErrorResult("gemini", model, started, err, (_status, code) =>
          bridge.classifyGeminiError((err && err.message) || "", code)
        );
      }
    },
  };
}

module.exports = { makeAntigravityProvider };
