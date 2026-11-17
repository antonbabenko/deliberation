"use strict";
/** @typedef {import("../types.js").Provider} Provider */
/** @typedef {import("../types.js").DelegationRequest} DelegationRequest */
const { makeOpenAICompatibleProvider } = require("./openai-compatible.js");

// Google's OpenAI-compatible endpoint for the Gemini API (AI Studio keys).
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/openai";
// Google's documented alias for the latest Gemini Flash release (hot-swapped with two weeks'
// notice). Gemini-only, unlike agy's router alias, and it does not go stale when an id retires.
const DEFAULT_GEMINI_API_MODEL = "gemini-flash-latest";

/**
 * The key sent to the API: GEMINI_API_KEY first, then GOOGLE_API_KEY (the name Google's SDKs
 * also read). Only GEMINI_API_KEY switches transport "auto" to the API; see useGeminiApi.
 * @param {Record<string, string|undefined>} [env]
 * @returns {string}
 */
function geminiApiKey(env = process.env) {
  return env.GEMINI_API_KEY || env.GOOGLE_API_KEY || "";
}

/**
 * Which path an ADVISORY Gemini call takes. providers.gemini.transport: "api" always uses the
 * key (GEMINI_API_KEY or GOOGLE_API_KEY) and never agy; "agy" always uses the Antigravity CLI;
 * anything else ("auto", unset) uses the API when GEMINI_API_KEY is set and agy otherwise.
 * GOOGLE_API_KEY alone does not switch "auto": it is often a key for another Google API, and an
 * agy-only install that happens to export one must keep working.
 * @param {(string|undefined)} transport
 * @param {Record<string, string|undefined>} [env]
 * @returns {boolean}
 */
function useGeminiApi(transport, env = process.env) {
  if (transport === "api") return true;
  if (transport === "agy") return false;
  return !!env.GEMINI_API_KEY;
}

/**
 * True when this call runs on the API key path. Implementation calls go to agy, except under
 * transport "api", which never runs agy (the unified server is advisory-only anyway).
 * @param {(string|undefined)} transport
 * @param {(DelegationRequest|{mode?:string}|undefined)} req
 * @param {Record<string, string|undefined>} [env]
 * @returns {boolean}
 */
function callUsesGeminiApi(transport, req, env = process.env) {
  if (transport === "api") return true;
  return !(req && req.mode === "implement") && useGeminiApi(transport, env);
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
 * and for installs without a key or with transport "agy". The env is read ONCE here, like the
 * startup env core/settings.js resolves the model from, so the model and the leg always agree.
 * @param {{agy: Provider, api: Provider, transport?: string, env?: Record<string, string|undefined>}} opts
 * @returns {Provider}
 */
function makeGeminiProvider({ agy, api, transport, env = process.env }) {
  const advisoryApi = useGeminiApi(transport, env);
  const implementApi = callUsesGeminiApi(transport, { mode: "implement" }, env);
  return {
    name: "gemini",
    // Under transport "api" agy never runs, so nothing can implement.
    capabilities: advisoryApi
      ? { ...api.capabilities, canImplement: !implementApi && agy.capabilities.canImplement, fixedModelEffort: true }
      : agy.capabilities,
    health: () => (advisoryApi ? api : agy).health(),
    ask: (req) => ((req && req.mode === "implement" ? implementApi : advisoryApi) ? api : agy).ask(req),
  };
}

module.exports = { makeGeminiProvider, makeGeminiApiProvider, geminiApiKey, useGeminiApi, callUsesGeminiApi, GEMINI_API_BASE, DEFAULT_GEMINI_API_MODEL };
