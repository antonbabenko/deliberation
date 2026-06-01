"use strict";
/** @typedef {import("../types.js").Provider} Provider */
const { toErrorResult } = require("../provider.js");

/**
 * @param {Object} [opts]
 * @param {Object} [opts.bridge]
 * @param {string} [opts.model]
 * @param {string} [opts.apiBase]
 * @returns {Provider}
 */
function makeGrokProvider(opts = {}) {
  // Core is transport-agnostic: the caller injects the bridge. Cast to any - the
  // bridge's module.exports is typed as bare Object (untyped CJS export).
  const bridge = /** @type {any} */ (opts.bridge);
  if (!bridge) throw new Error("makeGrokProvider requires opts.bridge (core is transport-agnostic; inject the grok bridge)");
  const model = opts.model || process.env.GROK_DEFAULT_MODEL || "grok-4.3";
  const apiBase = opts.apiBase || process.env.XAI_API_BASE || "https://api.x.ai/v1";

  return {
    name: "grok",
    // multiTurn is not wired through Core (runGrok/runWithFiles return no threadId),
    // so report false to match reality.
    capabilities: { canImplement: false, fileUpload: true, multiTurn: false },
    async health() {
      return process.env.XAI_API_KEY ? { ok: true } : { ok: false, reason: "XAI_API_KEY unset" };
    },
    async ask(req) {
      const started = Date.now();
      const reasoningEffort = bridge.resolveReasoningEffort(req.reasoningEffort);
      const apiKey = (req && req.apiKey) || process.env.XAI_API_KEY;
      try {
        // runWithFiles builds its own turns from prompt + developer-instructions;
        // runGrok takes pre-built turns. Both return { text, output }.
        const out = (req.files && req.files.length)
          ? await bridge.runWithFiles({
              files: req.files, prompt: req.prompt, "developer-instructions": req.developerInstructions,
              apiKey, apiBase, model, reasoningEffort, timeout: req.timeoutMs, cwd: req.cwd,
            })
          : await bridge.runGrok({
              turns: bridge.buildInitialTurns(req.developerInstructions, req.prompt, []),
              model, apiKey, apiBase, reasoningEffort, timeoutMs: req.timeoutMs,
            });
        return { provider: "grok", model, text: out.text || "", isError: false, ms: Date.now() - started };
      } catch (e) {
        return toErrorResult("grok", model, started, /** @type {any} */ (e), bridge.classifyGrokError);
      }
    },
  };
}

module.exports = { makeGrokProvider };
