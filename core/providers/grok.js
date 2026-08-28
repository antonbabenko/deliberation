"use strict";
/** @typedef {import("../types.js").Provider} Provider */
const { toErrorResult } = require("../provider.js");

/**
 * @param {Object} [opts]
 * @param {Object} [opts.bridge]
 * @param {string} [opts.model]
 * @param {string} [opts.reasoningEffort]  default effort from providers.grok.reasoningEffort
 * @param {string} [opts.apiBase]
 * @param {number} [opts.timeoutMs]  construction-time default per-call ceiling (ms), from
 *   providers.grok.timeout / providers.defaults.timeout. Falls through to the bridge default.
 * @returns {Provider}
 */
function makeGrokProvider(opts = {}) {
  // Core is transport-agnostic: the caller injects the bridge. Cast to any - the
  // bridge's module.exports is typed as bare Object (untyped CJS export).
  const bridge = /** @type {any} */ (opts.bridge);
  if (!bridge) throw new Error("makeGrokProvider requires opts.bridge (core is transport-agnostic; inject the grok bridge)");
  const model = opts.model || process.env.GROK_DEFAULT_MODEL || "grok-4.6";
  const apiBase = opts.apiBase || process.env.XAI_API_BASE || "https://api.x.ai/v1";
  // Construction-time ceiling. Undefined (not 0) when unset, so the bridge applies its
  // own default rather than being handed a falsy value it would treat as "no timeout".
  const defaultTimeoutMs = typeof opts.timeoutMs === "number" && opts.timeoutMs > 0 ? opts.timeoutMs : undefined;

  return {
    name: "grok",
    // multiTurn is not wired through Core (runGrok/runWithFiles return no threadId),
    // so report false to match reality.
    capabilities: { canImplement: false, fileUpload: true, multiTurn: false, walksFilesystem: false },
    async health() {
      return process.env.XAI_API_KEY ? { ok: true } : { ok: false, reason: "XAI_API_KEY unset" };
    },
    async ask(req) {
      const started = Date.now();
      // opts.reasoningEffort carries providers.grok.reasoningEffort from the
      // composition root; the request still wins. Core never reads config itself.
      const reasoningEffort = bridge.resolveReasoningEffort(req.reasoningEffort ?? opts.reasoningEffort);
      const apiKey = (req && req.apiKey) || process.env.XAI_API_KEY;
      const timeoutMs = typeof req.timeoutMs === "number" && req.timeoutMs > 0 ? req.timeoutMs : defaultTimeoutMs;
      try {
        // runWithFiles builds its own turns from prompt + developer-instructions;
        // runGrok takes pre-built turns. Both return { text, output }.
        const out = (req.files && req.files.length)
          ? await bridge.runWithFiles({
              files: req.files, prompt: req.prompt, "developer-instructions": req.developerInstructions,
              apiKey, apiBase, model, reasoningEffort, timeout: timeoutMs, cwd: req.cwd,
            })
          : await bridge.runGrok({
              turns: bridge.buildInitialTurns(req.developerInstructions, req.prompt, []),
              model, apiKey, apiBase, reasoningEffort, timeoutMs,
            });
        return { provider: "grok", model, text: out.text || "", isError: false, ms: Date.now() - started, reasoningEffort: reasoningEffort ?? null, usage: out.usage };
      } catch (e) {
        return toErrorResult("grok", model, started, /** @type {any} */ (e), bridge.classifyGrokError, { reasoningEffort: reasoningEffort ?? null });
      }
    },
  };
}

module.exports = { makeGrokProvider };
