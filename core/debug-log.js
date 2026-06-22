"use strict";

/**
 * core/debug-log.js - the universal, host-neutral debug-logging seam.
 *
 * Core emits structured events at the SOURCE (right after each provider call
 * resolves, and per consensus round) to an injected `Logger`. Core knows nothing
 * about the filesystem or MCP: by default it holds `NULL_LOGGER` (a no-op), so
 * nothing is written unless a host injects a real sink. This is the single seam
 * that serves BOTH the file sink (this module's `createFileLogger`) and the live
 * MCP-notification sink (wired by `server/mcp`), and it works identically for the
 * Claude host-arbiter path and the in-core `runToConvergence` (non-Claude) path.
 *
 * Privacy contract: events carry latency, token counts, reasoning effort, and
 * voting/approval OUTCOMES (verdict, category, counts) - NEVER prompt/response
 * text and NEVER free-text issue descriptions (those are response-derived).
 */

/**
 * One debug event. All fields optional except `event` + `at`; a record only
 * carries the fields relevant to its event kind.
 * @typedef {Object} DebugEvent
 * @property {string} event  // "provider_result" | "round" | "dispatch_start" | ...
 * @property {number} at     // epoch ms (injected by the caller; core has no clock policy)
 * @property {string} [tool] // "ask-all" | "ask-one" | "consensus"
 * @property {string} [provider]
 * @property {string} [model]
 * @property {(string|null)} [reasoningEffort]
 * @property {number} [ms]
 * @property {boolean} [isError]
 * @property {string} [errorKind]
 * @property {{promptTokens?:number, completionTokens?:number, totalTokens?:number}} [usage]
 * @property {number} [round]
 * @property {(string|null)} [verdict]
 * @property {(string|null)} [blindVerdict]
 * @property {boolean} [converged]
 * @property {number} [acceptedCritical]
 * @property {number} [voices]
 * @property {string} [errorCode]      // sanitized failure kind (errno or "write_failed") - NEVER err.message
 * @property {string} [loopSessionId]  // ephemeral consensus-step loop id, for failure correlation only
 */

/**
 * The logger contract a host injects. `logEvent` must NEVER throw (a logging
 * failure must not fail a delegation) and must be cheap when disabled.
 * @typedef {Object} Logger
 * @property {(event: DebugEvent) => void} logEvent
 */

/** The no-op logger. Core defaults to this, so logging is off unless injected. */
const NULL_LOGGER = Object.freeze({ logEvent(/** @type {DebugEvent} */ _event) {} });

/**
 * The exact whitelist of keys a debug record may carry. Anything outside this set
 * (e.g. prompt/response text, issue descriptions) is dropped before writing, so a
 * sink can never leak content even if a caller over-populates an event.
 */
const ALLOWED_KEYS = Object.freeze([
  "event", "at", "tool", "provider", "model", "reasoningEffort", "ms", "isError",
  "errorKind", "usage", "round", "verdict", "blindVerdict", "converged",
  "acceptedCritical", "voices", "errorCode", "loopSessionId",
]);

/**
 * Project an event onto the allowed-key whitelist. Defensive: guarantees no
 * content key is ever serialized, regardless of what the caller passed.
 * @param {DebugEvent} event
 * @returns {Record<string, unknown>}
 */
function sanitizeEvent(event) {
  /** @type {Record<string, unknown>} */
  const out = {};
  if (!event || typeof event !== "object") return out;
  for (const k of ALLOWED_KEYS) {
    const v = /** @type {Record<string, unknown>} */ (event)[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * A file-backed logger sink. Appends one compact JSON line per event to `path`.
 * Failure-isolated: any fs error is swallowed (debug logging must never break a
 * call). Uses the Node `fs` builtin only - no runtime dependency, so the "zero
 * runtime deps" rule for core holds; a host that does not want local files simply
 * never calls this factory.
 * @param {string} path  absolute path to the JSONL file
 * @returns {Logger}
 */
function createFileLogger(path) {
  const fs = require("node:fs");
  return {
    logEvent(event) {
      try {
        fs.appendFileSync(path, JSON.stringify(sanitizeEvent(event)) + "\n");
      } catch {
        // Never throw from logging.
      }
    },
  };
}

/**
 * Compose several sinks into one logger; an event fans out to each. A throwing
 * sink is isolated so it cannot break the others or the caller.
 * @param {Logger[]} sinks
 * @returns {Logger}
 */
function composeLoggers(sinks) {
  const real = (Array.isArray(sinks) ? sinks : []).filter((s) => s && typeof s.logEvent === "function");
  if (!real.length) return NULL_LOGGER;
  if (real.length === 1) return real[0];
  return {
    logEvent(event) {
      for (const s of real) {
        try { s.logEvent(event); } catch { /* isolate a bad sink */ }
      }
    },
  };
}

module.exports = { NULL_LOGGER, createFileLogger, composeLoggers, sanitizeEvent, ALLOWED_KEYS };
