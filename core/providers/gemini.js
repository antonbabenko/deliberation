"use strict";
/** @typedef {import("../types.js").Provider} Provider */
/** @typedef {import("../types.js").DelegationRequest} DelegationRequest */
const { makeOpenAICompatibleProvider } = require("./openai-compatible.js");

// Google's OpenAI-compatible endpoint for the Gemini API (AI Studio keys).
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/openai";
// A Google-maintained alias for the newest Gemini Flash model. Gemini-only (unlike agy's
// router alias), served on the free tier, and it does not go stale when a model id retires.
const DEFAULT_GEMINI_API_MODEL = "gemini-flash-latest";

/**
 * The AI Studio key: GEMINI_API_KEY first, then GOOGLE_API_KEY (the name Google's SDKs also read).
 * @param {Record<string, string|undefined>} [env]
 * @returns {string}
 */
function geminiApiKey(env = process.env) {
  return env.GEMINI_API_KEY || env.GOOGLE_API_KEY || "";
}

/**
 * Which path an ADVISORY Gemini call takes. providers.gemini.transport: "api" always uses the
 * key, "agy" always uses the Antigravity CLI, anything else ("auto", unset) uses the key when
 * one is set and falls back to agy, so an existing agy-only install keeps working.
 * @param {(string|undefined)} transport
 * @param {Record<string, string|undefined>} [env]
 * @returns {boolean}
 */
function useGeminiApi(transport, env = process.env) {
  if (transport === "api") return true;
  if (transport === "agy") return false;
  return geminiApiKey(env) !== "";
}

/**
 * Gemini over the API key, on the shared OpenAI-compatible HTTP client.
 * @param {Object} opts
 * @param {Object} opts.bridge  the OpenAI-compatible bridge (server/openrouter)
 * @param {string} [opts.model]  providers.gemini.apiModel
 * @param {string} [opts.apiBase]
 * @param {number} [opts.timeoutMs]
 * @returns {Provider}
 */
function makeGeminiApiProvider(opts) {
  const bridge = /** @type {any} */ (opts.bridge);
  if (!bridge) throw new Error("makeGeminiApiProvider requires opts.bridge");
  const model = opts.model || DEFAULT_GEMINI_API_MODEL;
  // Label errors as Gemini and send `reasoning_effort` (Google's field) instead of OpenRouter's `reasoning`.
  const geminiBridge = { ...bridge, callOpenRouter: (/** @type {any} */ a) => bridge.callOpenRouter({ ...a, label: "Gemini", reasoningParam: "reasoning_effort" }) };
  const inner = makeOpenAICompatibleProvider({
    name: "gemini", apiBase: opts.apiBase || process.env.GEMINI_API_BASE || GEMINI_API_BASE, apiKeyEnv: "",
    resolveModel: () => model, bridge: geminiBridge, timeoutMs: opts.timeoutMs,
  });
  return {
    ...inner,
    async health() {
      return geminiApiKey() ? { ok: true } : { ok: false, reason: "GEMINI_API_KEY (or GOOGLE_API_KEY) unset" };
    },
    ask: (req) => inner.ask({ ...req, apiKey: req.apiKey || geminiApiKey() }),
  };
}

/**
 * The one "gemini" provider: the API key path for advisory calls, agy for implementation
 * (workspace-write) and for installs without a key or with transport "agy".
 * @param {{agy: Provider, api: Provider, transport?: string}} opts
 * @returns {Provider}
 */
function makeGeminiProvider({ agy, api, transport }) {
  const pick = (/** @type {DelegationRequest} */ req) =>
    (req && req.mode === "implement") || !useGeminiApi(transport) ? agy : api;
  return {
    name: "gemini",
    // A getter: the active path (and so whether it can read the workspace) follows the env.
    get capabilities() {
      return useGeminiApi(transport)
        ? { ...api.capabilities, canImplement: agy.capabilities.canImplement, fixedModelEffort: true }
        : agy.capabilities;
    },
    health: () => (useGeminiApi(transport) ? api : agy).health(),
    ask: (req) => pick(req).ask(req),
  };
}

module.exports = { makeGeminiProvider, makeGeminiApiProvider, geminiApiKey, useGeminiApi, GEMINI_API_BASE, DEFAULT_GEMINI_API_MODEL };
