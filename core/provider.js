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
 * @param {Partial<DelegationError>} [extra]  merged onto the result (e.g. reasoningEffort)
 * @returns {DelegationError}
 */
function toErrorResult(name, model, started, err, classify, extra) {
  const { errorKind, retryable } = classify(err && err.status, err && err.code);
  // Spread `extra` FIRST so the canonical envelope fields always win - a caller's
  // stray `extra` key (or a non-object) can never clobber provider/isError/ms/etc.
  return { ...(extra && typeof extra === "object" ? extra : {}), provider: name, model, isError: true, errorKind, retryable, ms: Date.now() - started };
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

/** The closed 6-category taxonomy a consensus review tags critical issues with. */
const REVIEW_CATEGORIES = deepFreeze(["security", "correctness", "scope", "ambiguity", "performance", "ops"]);
const REVIEW_FALLBACK_CATEGORY = "ambiguity";

/**
 * @typedef {Object} ReviewCriticalIssue
 * @property {("security"|"correctness"|"scope"|"ambiguity"|"performance"|"ops")} category
 * @property {string} description
 */

/**
 * @typedef {Object} ParsedReview
 * @property {(("APPROVE"|"REQUEST_CHANGES"|"REJECT")|null)} verdict
 * @property {ReviewCriticalIssue[]} criticalIssues
 */

// Anchored verdict matcher: the token must sit adjacent to the word "verdict"
// (only non-alphanumerics between), and is matched on WORD BOUNDARIES. This
// rejects substring traps ("DISAPPROVE"/"APPROVED" never match "APPROVE";
// "verdict: do not REJECT" finds no adjacent token -> null) and loose prose
// ("verdict as APPROVE" has the alpha word "as" between -> no match), so an
// echoed instruction line cannot hijack the verdict.
const VERDICT_RE = /\bverdict\b[^A-Za-z0-9]*\b(APPROVE|REJECT|REQUEST[_\s]CHANGES)\b/i;
const BULLET_RE = /^([-*+•]|`?\[)/;
const BRACKET_CAT_RE = /\[\s*([A-Za-z_]+)\s*\]/g; // /g: consumed ONLY via matchAll (does not touch lastIndex); do NOT .exec()/.test() this

// Verdict-line shapes (all anchored / bounded - no backtracking):
const SENTINEL_RE = /^[#>*_`\s]*verdict\s*[:=]\s*[*_`\s]*(APPROVE|REJECT|REQUEST[_\s]CHANGES)\b/i;
const VERDICT_WORD_RE = /^[#>*_`\s]*verdict[*_`:\s]*$/i;   // a "Verdict" heading line, nothing else
const TOKEN_LINE_RE = /^(APPROVE|REJECT|REQUEST[_\s]CHANGES)$/i; // a whole line that IS just the token
const MD_EMPHASIS = /[*_`~]/g;                             // emphasis chars to strip when isolating a token
const FENCE_RE = /^\s*(```|~~~)/;                          // fenced code-block delimiter
const ARTIFACT_RE = /^[*_`~\s:.\-]*$/;                     // empty or only markdown/punct
const STRIP_LEAD = /^[*_`~\s:.\-]+/;                       // leading noise to trim off a description
const STRIP_TRAIL = /[*_`~\s]+$/;                          // trailing emphasis to trim
const HEADING_RE = /^#{1,6}\s/;
/** Normalize a verdict token: "REQUEST CHANGES" -> "REQUEST_CHANGES", upper-cased. */
function normVerdict(/** @type {string} */ tok) { return tok.replace(/\s+/g, "_").toUpperCase(); }

/**
 * Parse a consensus REVIEW reply into a verdict + categorized critical issues.
 * Best-effort and NEVER throws. Line-based (no regex backtracking on large input).
 *
 * - verdict: the FIRST line whose `verdict` keyword is immediately followed by a
 *   bounded APPROVE/REJECT/REQUEST_CHANGES token wins (the reviewer's own verdict;
 *   later quoted/template mentions are ignored). No adjacent token -> null.
 * - criticalIssues: taken only from bullet/bracket lines; among multiple `[tag]`
 *   brackets the FIRST that is a known category wins (so `- [P0] [security] ...`
 *   categorizes as security), else the first bracket degrades to `ambiguity`. A
 *   bullet with a category but NO description is dropped (not actionable for
 *   convergence).
 *
 * Distinct from `parseOpinion` (advisory recommendation envelope) - this drives
 * the consensus loop's convergence rule.
 * @param {string} text
 * @returns {ParsedReview}
 */
function parseReview(text) {
  const raw = safeString(text);
  // Drop fenced code blocks so a reviewer's quoted/fenced example cannot hijack
  // the verdict.
  const lines = [];
  let inFence = false;
  for (const ln of raw.split(/\r?\n/)) {
    if (FENCE_RE.test(ln)) { inFence = !inFence; continue; }
    if (!inFence) lines.push(ln);
  }
  return { verdict: resolveVerdict(lines), criticalIssues: resolveIssues(lines) };
}

/**
 * Verdict ladder, first match wins (priority a > b > c > d). All passes scan a
 * small fence-filtered line array - no backtracking.
 * @param {string[]} lines
 * @returns {ParsedReview["verdict"]}
 */
function resolveVerdict(lines) {
  // a) explicit machine-readable sentinel: `VERDICT: APPROVE`
  for (const ln of lines) { const m = ln.match(SENTINEL_RE); if (m) return /** @type {any} */ (normVerdict(m[1])); }
  // b) keyword + token on the same line (legacy shape; the reviewer's own verdict)
  for (const ln of lines) { const m = ln.match(VERDICT_RE); if (m) return /** @type {any} */ (normVerdict(m[1])); }
  // c) heading-split: a "Verdict" heading line, then a bare token within the next 3 non-empty lines
  for (let i = 0; i < lines.length; i++) {
    if (!VERDICT_WORD_RE.test(lines[i].trim())) continue;
    for (let j = i + 1; j < lines.length && j <= i + 3; j++) {
      const t = lines[j].replace(MD_EMPHASIS, "").trim();
      if (!t) continue;
      if (TOKEN_LINE_RE.test(t)) return /** @type {any} */ (normVerdict(t));
      break; // first non-empty line under the heading was not a token -> stop
    }
  }
  // d) bare standalone token line, no "verdict" keyword (leading-token replies)
  for (const ln of lines) { const t = ln.replace(MD_EMPHASIS, "").trim(); if (TOKEN_LINE_RE.test(t)) return /** @type {any} */ (normVerdict(t)); }
  return null;
}

/**
 * Extract categorized critical issues. Only bullet/bracket lines are considered;
 * the first bracket that is a known category wins (else the first bracket degrades
 * to `ambiguity`). The description is the text after the chosen `]`; when that is
 * empty or only markdown artifacts (e.g. a bold `**[security]**` heading with the
 * text on the following line), pull the next usable line as the description. A
 * still-empty/artifact-only description is dropped (not actionable for convergence).
 * @param {string[]} lines
 * @returns {ReviewCriticalIssue[]}
 */
function resolveIssues(lines) {
  /** @type {ReviewCriticalIssue[]} */
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!BULLET_RE.test(trimmed)) continue;
    let chosen = null;
    for (const mm of trimmed.matchAll(BRACKET_CAT_RE)) {
      if (REVIEW_CATEGORIES.includes(mm[1].toLowerCase())) { chosen = mm; break; }
      if (chosen === null) chosen = mm;
    }
    if (!chosen) continue;
    const cat = chosen[1].toLowerCase();
    const category = /** @type {ReviewCriticalIssue["category"]} */ (
      REVIEW_CATEGORIES.includes(cat) ? cat : REVIEW_FALLBACK_CATEGORY
    );
    let description = trimmed.slice(chosen.index + chosen[0].length).replace(STRIP_LEAD, "").replace(STRIP_TRAIL, "").trim();
    if (!description || ARTIFACT_RE.test(description)) {
      for (let j = i + 1; j < lines.length; j++) {
        const nt = lines[j].trim();
        if (!nt) break;                                  // blank -> stop
        if (BULLET_RE.test(nt) || HEADING_RE.test(nt)) break;  // next bullet/heading -> stop
        if (SENTINEL_RE.test(nt) || VERDICT_WORD_RE.test(nt)) break; // verdict line -> stop
        description = nt.replace(STRIP_LEAD, "").replace(STRIP_TRAIL, "").trim();
        break;                                           // take the first usable continuation line
      }
    }
    if (description && !ARTIFACT_RE.test(description)) out.push({ category, description });
  }
  return out;
}

module.exports = {
  toErrorResult,
  OPINION_SCHEMA,
  OPINION_INSTRUCTIONS,
  CONFIDENCE_ENUM,
  REVIEW_CATEGORIES,
  validateOpinion,
  parseOpinion,
  parseReview,
};
