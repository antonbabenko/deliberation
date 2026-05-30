"use strict";
/** @typedef {import("./types.js").DelegationError} DelegationError */

/**
 * Normalize a thrown bridge error into a DelegationError using that bridge's
 * own classifier, so behavior matches the standalone bridge exactly.
 * @param {string} name
 * @param {string} model
 * @param {number} started   // Date.now() at call start
 * @param {{status?:number, code?:string}} err
 * @param {(status?:number, code?:string) => {errorKind:string, retryable:boolean}} classify
 * @returns {DelegationError}
 */
function toErrorResult(name, model, started, err, classify) {
  const { errorKind, retryable } = classify(err && err.status, err && err.code);
  return { provider: name, model, isError: true, errorKind, retryable, ms: Date.now() - started };
}

// Structured opinion schema shared across providers (Core minimum).
// Fast-follow extends with dissent_points/assumptions/tradeoffs.
const OPINION_SCHEMA = Object.freeze({
  type: "object",
  required: ["recommendation", "confidence"],
  properties: {
    recommendation: { type: "string" },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
    reasoning: { type: "string" },
  },
});

/**
 * Minimal runtime validation at the boundary (no JSON-schema dependency).
 * @param {any} o
 * @returns {{ok:boolean, reason?:string}}
 */
function validateOpinion(o) {
  if (!o || typeof o !== "object") return { ok: false, reason: "opinion is not an object" };
  for (const k of OPINION_SCHEMA.required) {
    if (!(k in o)) return { ok: false, reason: `missing required field: ${k}` };
  }
  return { ok: true };
}

module.exports = { toErrorResult, OPINION_SCHEMA, validateOpinion };
