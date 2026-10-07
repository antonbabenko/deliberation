"use strict";

/**
 * core/result-cache.js - an in-session (MCP-process-lifetime) dedup cache for
 * advisory provider results. A no-tradeoff latency win: an identical re-ask
 * (same provider + model + reasoning effort + context + developer instructions + prompt +
 * file fingerprint) returns the prior SUCCESS instantly instead of re-calling the
 * model. Distinct prompts behave exactly as before.
 *
 * Scope + safety:
 *   - In-memory only, lost on restart (no staleness across upgrades).
 *   - NEVER caches errors (a transient failure must be retryable).
 *   - LRU-bounded (mirrors the openai-compatible session-map cap) so a long-lived
 *     server cannot grow unbounded.
 *   - The host constructs ONE cache and injects it; core holds no module state, so
 *     tests stay isolated and a remote/multi-tenant host can opt out (pass none).
 *   - File fingerprint is by reference (path/dir/file_id/file_url), not content -
 *     fine for a short advisory session; mostly helps repeated /ask-*. Rarely hits
 *     in /consensus (the revised plan changes each round).
 *
 * @typedef {import("./types.js").DelegationRequest} DelegationRequest
 * @typedef {import("./types.js").DelegationResult} DelegationResult
 * @typedef {import("./types.js").DelegationSuccess} DelegationSuccess
 */

const DEFAULT_MAX = 100;
// Entries expire after this long, so a stale opinion does not linger an entire
// session - covers config/alias changes and a user wanting a fresh sample after a
// while. (File-bearing requests skip the cache entirely at the call layer, since
// file CONTENT can change under the same path.)
const DEFAULT_TTL_MS = 600000; // 10 minutes

/**
 * @typedef {Object} ResultCache
 * @property {(providerName:string, req:DelegationRequest) => (DelegationSuccess|undefined)} get
 * @property {(providerName:string, req:DelegationRequest, result:DelegationResult) => void} set
 * @property {number} size
 */

/**
 * Stable cache key for a (provider, request) pair. Only the fields that change
 * the model's answer participate; everything else (threadId, cwd, timeout) is
 * deliberately excluded so retries/timeouts do not fragment the key.
 * @param {string} providerName
 * @param {DelegationRequest} req
 * @returns {string}
 */
function keyFor(providerName, req) {
  const files = Array.isArray(req.files)
    ? req.files.map((f) => `${f.path || ""}|${f.dir || ""}|${f.file_id || ""}|${f.file_url || ""}|${f.mode || ""}`)
    : [];
  return JSON.stringify([
    providerName,
    req.model || "",
    req.reasoningEffort || "",
    req.context || "ask",
    req.cwd || "",
    req.tool || "", req.expert || "", req.provenance?.configId || "",
    typeof req.temperature === "number" ? req.temperature : "",
    req.developerInstructions || "",
    req.prompt || "",
    files,
  ]);
}

/**
 * Create an in-session result cache. Returns `null`-safe operations; callers may
 * also simply not pass a cache to disable it.
 * @param {{max?:number, ttlMs?:number}} [opts]
 * @returns {ResultCache}
 */
function makeResultCache(opts = {}) {
  const max = Number.isInteger(opts.max) && /** @type {number} */ (opts.max) > 0 ? /** @type {number} */ (opts.max) : DEFAULT_MAX;
  const ttlMs = Number.isInteger(opts.ttlMs) && /** @type {number} */ (opts.ttlMs) > 0 ? /** @type {number} */ (opts.ttlMs) : DEFAULT_TTL_MS;
  /** @type {Map<string, {result:DelegationSuccess, at:number}>} */
  const map = new Map();
  return {
    get(providerName, req) {
      const k = keyFor(providerName, req);
      const e = map.get(k);
      if (!e) return undefined;
      if (Date.now() - e.at > ttlMs) { map.delete(k); return undefined; } // expired
      // Refresh LRU recency: delete + re-set moves the entry to newest.
      map.delete(k);
      map.set(k, e);
      return e.result;
    },
    set(providerName, req, result) {
      // Only successes are cacheable; an error must stay retryable.
      if (!result || result.isError) return;
      const k = keyFor(providerName, req);
      // Stamp `cached:true` + `ms:0` so a hit is visibly distinct downstream.
      map.set(k, { result: { .../** @type {DelegationSuccess} */ (result), cached: true, ms: 0 }, at: Date.now() });
      if (map.size > max) {
        const oldest = map.keys().next().value;
        if (oldest !== undefined) map.delete(oldest);
      }
    },
    get size() { return map.size; },
  };
}

module.exports = { makeResultCache, keyFor, DEFAULT_MAX, DEFAULT_TTL_MS };
