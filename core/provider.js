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

/** Recursively freeze a plain object/array literal so the exported schema is truly immutable. */
function deepFreeze(/** @type {any} */ o) {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

/** Allowed confidence values; anything else degrades to CONFIDENCE_FALLBACK. */
const CONFIDENCE_ENUM = deepFreeze(["low", "medium", "high"]);
const CONFIDENCE_FALLBACK = "unknown";
/** The three enriched array fields added in 1a (all optional, all string[]). */
const ENRICHED_ARRAY_FIELDS = deepFreeze(["dissent_points", "assumptions", "tradeoffs"]);

// The opinion shape REQUESTED from a provider (drives native response_format and
// the prompt instructions). `recommendation` + `confidence` are required; the 1a
// enrichment adds three OPTIONAL string[] fields. This is the IDEAL provider
// output; `parseOpinion` below is intentionally tolerant and never drops a reply
// that falls short of it. Deep-frozen so importers cannot mutate the shared schema.
const OPINION_SCHEMA = deepFreeze({
  type: "object",
  required: ["recommendation", "confidence"],
  properties: {
    recommendation: { type: "string" },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
    dissent_points: { type: "array", items: { type: "string" } },
    assumptions: { type: "array", items: { type: "string" } },
    tradeoffs: { type: "array", items: { type: "string" } },
  },
});

// Prompt-injectable guidance. Adapters that lack a native structured-output
// channel (Codex stdout, Gemini agy print mode) append this; OpenRouter/Grok can
// use native response_format instead. Wiring into adapters lands with PR2 (the
// loop consumes envelopes); exported here so the schema text has a single home.
const OPINION_INSTRUCTIONS = [
  "When you have a verdict, END your reply with a fenced ```json block containing:",
  '  "recommendation": string (one-line bottom line),',
  '  "confidence": "low" | "medium" | "high",',
  '  "dissent_points": string[] (where you disagree or see risk; [] if none),',
  '  "assumptions": string[] (assumptions you made; [] if none),',
  '  "tradeoffs": string[] (tradeoffs considered; [] if none).',
  "Prose before the block is fine; the block must be valid JSON, and it must be the LAST such block.",
].join("\n");

/**
 * Normalized, always-present opinion shape. `structured` is PROVENANCE: true when
 * the reply parsed from a JSON object, false when it was prose / unparseable (in
 * which case `recommendation` carries the raw text and the arrays are empty).
 * `raw` always preserves the original text. Field QUALITY (vs `structured`
 * provenance) is reported separately by `validateOpinion`.
 * @typedef {Object} OpinionEnvelope
 * @property {string} recommendation
 * @property {("low"|"medium"|"high"|"unknown")} confidence
 * @property {string[]} dissent_points
 * @property {string[]} assumptions
 * @property {string[]} tradeoffs
 * @property {boolean} structured
 * @property {string} raw
 * @property {string[]} warnings
 */

/** Coerce any input to a string without ever throwing (null-proto / throwing toString safe). */
function safeString(/** @type {unknown} */ text) {
  if (typeof text === "string") return text;
  try {
    return String(text == null ? "" : text);
  } catch {
    return "";
  }
}

/**
 * Collect every JSON candidate from provider text, in document order: each
 * fenced code block body (```json or bare ```), then the whole trimmed text when
 * it looks like a JSON object (native response_format returns raw, unfenced
 * JSON). Uses indexOf scanning - O(n), no regex backtracking on large input.
 * @param {string} text
 * @returns {string[]}
 */
function extractJsonCandidates(text) {
  /** @type {string[]} */
  const out = [];
  let i = 0;
  while (true) {
    const open = text.indexOf("```", i);
    if (open === -1) break;
    // Body starts after the fence's first line (which may carry a language tag).
    const nl = text.indexOf("\n", open + 3);
    const bodyStart = nl === -1 ? open + 3 : nl + 1;
    const close = text.indexOf("```", bodyStart);
    if (close === -1) break; // unterminated fence - stop (no infinite loop)
    const body = text.slice(bodyStart, close).trim();
    if (body) out.push(body);
    i = close + 3;
  }
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) out.push(trimmed);
  return out;
}

/**
 * Coerce a parsed JSON object into a structured OpinionEnvelope, collecting
 * advisory warnings. Never throws.
 * @param {Record<string, unknown>} obj
 * @param {string} raw
 * @returns {OpinionEnvelope}
 */
function envelopeFromObject(obj, raw) {
  /** @type {string[]} */
  const warnings = [];

  const recommendation = typeof obj.recommendation === "string" && obj.recommendation
    ? obj.recommendation
    : (warnings.push("missing recommendation; using raw text"), raw);

  let confidence = /** @type {OpinionEnvelope["confidence"]} */ (CONFIDENCE_FALLBACK);
  if (typeof obj.confidence === "string" && CONFIDENCE_ENUM.includes(obj.confidence)) {
    confidence = /** @type {OpinionEnvelope["confidence"]} */ (obj.confidence);
  } else {
    warnings.push(`confidence not in ${CONFIDENCE_ENUM.join("|")}; using '${CONFIDENCE_FALLBACK}'`);
  }

  /** @type {Record<string, string[]>} */
  const arrays = {};
  for (const k of ENRICHED_ARRAY_FIELDS) {
    const v = obj[k];
    if (v === undefined) {
      arrays[k] = [];
    } else if (Array.isArray(v) && v.every((x) => typeof x === "string")) {
      arrays[k] = v;
    } else {
      arrays[k] = [];
      warnings.push(`${k} is not a string[]; coerced to []`);
    }
  }

  return {
    recommendation,
    confidence,
    dissent_points: arrays.dissent_points,
    assumptions: arrays.assumptions,
    tradeoffs: arrays.tradeoffs,
    structured: true,
    raw,
    warnings,
  };
}

/**
 * Parse a provider's text reply into a normalized OpinionEnvelope. Best-effort
 * and NEVER throws: it scans every JSON candidate and picks the LAST one that
 * parses to an object - matching the OPINION_INSTRUCTIONS contract that the
 * opinion block is LAST, so an earlier example/reasoning block can never win
 * (malformed blocks are skipped, not chosen). On no parseable object it returns
 * an unstructured envelope (`structured:false`, raw text as `recommendation`,
 * empty arrays) so a prose provider is never dropped and a malformed reply never
 * fails the batch.
 * @param {string} text
 * @returns {OpinionEnvelope}
 */
function parseOpinion(text) {
  const raw = safeString(text);
  /** @type {Record<string, unknown>|null} */
  let lastObj = null;
  for (const candidate of extractJsonCandidates(raw)) {
    try {
      const obj = JSON.parse(candidate);
      if (obj && typeof obj === "object" && !Array.isArray(obj)) lastObj = obj;
    } catch {
      // skip this candidate; a malformed block must not win or throw
    }
  }
  if (lastObj) return envelopeFromObject(lastObj, raw);
  return {
    recommendation: raw,
    confidence: CONFIDENCE_FALLBACK,
    dissent_points: [],
    assumptions: [],
    tradeoffs: [],
    structured: false,
    raw,
    warnings: ["unstructured: no parseable json opinion block"],
  };
}

/**
 * Advisory quality check - NEVER throws and NEVER gates the fan-out. `valid`
 * means a usable recommendation is present; `wellFormed` means the strict
 * enriched shape is present (enum confidence - NOT the `unknown` fallback - plus
 * all three string[] fields with string elements); `warnings` explains any gaps.
 * For tagging/observability, not a hard schema gate. Distinct from
 * `OpinionEnvelope.structured`, which is parse PROVENANCE, not quality.
 * @param {any} o
 * @returns {{valid:boolean, wellFormed:boolean, warnings:string[]}}
 */
function validateOpinion(o) {
  if (!o || typeof o !== "object") {
    return { valid: false, wellFormed: false, warnings: ["opinion is not an object"] };
  }
  /** @type {string[]} */
  const warnings = [];
  const valid = typeof o.recommendation === "string" && o.recommendation.length > 0;
  if (!valid) warnings.push("missing recommendation");

  let wellFormed = valid;
  if (!(typeof o.confidence === "string" && CONFIDENCE_ENUM.includes(o.confidence))) {
    warnings.push(`confidence not in ${CONFIDENCE_ENUM.join("|")}`);
    wellFormed = false;
  }
  for (const k of ENRICHED_ARRAY_FIELDS) {
    const v = o[k];
    if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
      warnings.push(`${k} missing or not a string[]`);
      wellFormed = false;
    }
  }
  return { valid, wellFormed, warnings };
}

module.exports = {
  toErrorResult,
  OPINION_SCHEMA,
  OPINION_INSTRUCTIONS,
  CONFIDENCE_ENUM,
  validateOpinion,
  parseOpinion,
};
