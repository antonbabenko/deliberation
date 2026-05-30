"use strict";
/** @typedef {import("../types.js").Provider} Provider */
/** @typedef {import("../types.js").DelegationRequest} DelegationRequest */
const crypto = require("node:crypto");
const { toErrorResult } = require("../provider.js");

// Cap the in-memory session map so a long-running server cannot leak unbounded
// conversation history. Oldest (insertion-order) entry is evicted past the cap.
const MAX_SESSIONS = 100;

/**
 * @param {Object} opts
 * @param {string} opts.name
 * @param {string} opts.apiBase
 * @param {string} opts.apiKeyEnv
 * @param {(req:DelegationRequest)=>string} opts.resolveModel
 * @param {Object} [opts.bridge]  // injectable for tests; defaults to the real bridge
 * @returns {Provider}
 */
function makeOpenAICompatibleProvider(opts) {
  const { name = "openrouter", apiBase, apiKeyEnv, resolveModel } = opts;
  // Cast the bridge to any: its CJS module.exports is typed as bare Object, and
  // casting also stops tsc from deep-checking the legacy bridge transitively.
  const bridge = /** @type {any} */ (opts.bridge || require("../../server/openrouter/index.js"));
  const sessions = new Map(); // threadId -> turns

  return /** @type {any} */ ({
    name,
    capabilities: { canImplement: false, fileUpload: false, multiTurn: true },
    /** Test-only: current number of cached sessions. */
    get __sessionCount() { return sessions.size; },
    async health() {
      return process.env[apiKeyEnv] ? { ok: true } : { ok: false, reason: `${apiKeyEnv} unset` };
    },
    async ask(/** @type {import("../types.js").DelegationRequest} */ req) {
      const started = Date.now();
      const model = resolveModel(req);
      const prior = req.threadId && sessions.get(req.threadId);
      const turns = prior
        ? [...prior, { role: "user", text: req.prompt }]
        : bridge.buildInitialTurns(req.developerInstructions, req.prompt, req.files || []);
      try {
        const { text } = await bridge.callOpenRouter({
          apiBase, apiKey: process.env[apiKeyEnv], model,
          messages: bridge.buildMessages(turns),
          reasoningEffort: req.reasoningEffort, temperature: req.temperature, timeoutMs: req.timeoutMs,
        });
        const threadId = req.threadId || crypto.randomUUID();
        sessions.set(threadId, [...turns, { role: "assistant", text }]);
        if (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
        return { provider: name, model, text, threadId, isError: false, ms: Date.now() - started };
      } catch (e) {
        return toErrorResult(name, model, started, /** @type {any} */ (e), bridge.classifyError);
      }
    },
  });
}

module.exports = { makeOpenAICompatibleProvider, MAX_SESSIONS };
