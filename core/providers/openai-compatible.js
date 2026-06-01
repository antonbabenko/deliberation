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
  // Core is transport-agnostic: the caller injects the bridge. Cast to any - the
  // CJS bridge exports as a bare Object, and the cast also stops tsc from
  // deep-checking the legacy bridge transitively.
  const bridge = /** @type {any} */ (opts.bridge);
  if (!bridge) throw new Error("makeOpenAICompatibleProvider requires opts.bridge (core is transport-agnostic; inject the bridge)");
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
      // Inline attached files into TEXT blocks before building turns. buildInitialTurns
      // (and the prior-session user turn) expect already-inlined strings; passing the raw
      // { path, mode } objects makes buildMessages string-coerce them to "[object Object]".
      let blocks = [], notes = [];
      if (req.files && req.files.length) {
        try {
          // Defaults guard a bridge that returns only { blocks }.
          ({ blocks = [], notes = [] } = bridge.inlineFiles(req.files, { roots: [req.cwd || process.cwd()] }));
        } catch (e) {
          return toErrorResult(name, model, started, /** @type {any} */ (e), () => ({ errorKind: "config", retryable: false }));
        }
      }
      const turns = prior
        ? [...prior, { role: "user", text: req.prompt, inlineBlocks: blocks }]
        : bridge.buildInitialTurns(req.developerInstructions, req.prompt, blocks);
      try {
        const { text } = await bridge.callOpenRouter({
          apiBase, apiKey: process.env[apiKeyEnv], model,
          messages: bridge.buildMessages(turns),
          reasoningEffort: req.reasoningEffort, temperature: req.temperature, timeoutMs: req.timeoutMs,
        });
        const threadId = req.threadId || crypto.randomUUID();
        sessions.set(threadId, [...turns, { role: "assistant", text }]);
        if (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
        // Surface skip notes (missing/binary/over-cap/over-budget files) like the standalone
        // bridge, so a file-based ask is never silently answered with no file content.
        const outText = notes.length ? `${text}\n\n[files] ${notes.join("; ")}` : text;
        return { provider: name, model, text: outText, threadId, isError: false, ms: Date.now() - started };
      } catch (e) {
        return toErrorResult(name, model, started, /** @type {any} */ (e), bridge.classifyError);
      }
    },
  });
}

module.exports = { makeOpenAICompatibleProvider, MAX_SESSIONS };
