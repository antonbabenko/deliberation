// test/core-provider.test.js
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  toErrorResult,
  classifyFetchFailure,
  OPINION_SCHEMA,
  validateOpinion,
  parseOpinion,
  OPINION_INSTRUCTIONS,
} = require("../core/provider.js");

test("P1: toErrorResult normalizes a thrown error via the bridge classifier", () => {
  const classify = (/** @type {any} */ status) => ({ errorKind: status === 429 ? "rate-limit" : "unknown", retryable: status === 429 });
  const r = toErrorResult("openrouter", "x/y", Date.now() - 5, { status: 429 }, classify);
  assert.equal(r.provider, "openrouter");
  assert.equal(r.model, "x/y");
  assert.equal(r.isError, true);
  assert.equal(r.errorKind, "rate-limit");
  assert.equal(r.retryable, true);
  assert.equal("text" in r, false); // error results carry no text key
  assert.ok(r.ms >= 0);
});

test("P2: OPINION_SCHEMA keeps recommendation + confidence required, adds enriched optional fields", () => {
  assert.deepEqual(OPINION_SCHEMA.required, ["recommendation", "confidence"]);
  const props = /** @type {Record<string, any>} */ (OPINION_SCHEMA.properties);
  // 1a enrichment: the three new fields are present as optional string[] properties.
  for (const k of ["dissent_points", "assumptions", "tradeoffs"]) {
    assert.equal(props[k].type, "array", `${k} is an array`);
    assert.equal(props[k].items.type, "string", `${k} items are strings`);
    assert.equal(OPINION_SCHEMA.required.includes(k), false, `${k} stays optional`);
  }
  // confidence stays a low|medium|high enum (locked; no numeric).
  assert.deepEqual(props.confidence.enum, ["low", "medium", "high"]);
});

test("P3: validateOpinion is advisory — returns {valid,wellFormed,warnings}, never throws", () => {
  const full = validateOpinion({
    recommendation: "ship it", confidence: "high",
    dissent_points: [], assumptions: [], tradeoffs: [],
  });
  assert.equal(full.valid, true);
  assert.equal(full.wellFormed, true);
  assert.deepEqual(full.warnings, []);

  // Missing confidence: still valid (advisory), but not well-formed, with a warning.
  const partial = validateOpinion({ recommendation: "ship it" });
  assert.equal(partial.valid, true);
  assert.equal(partial.wellFormed, false);
  assert.ok(partial.warnings.some((w) => /confidence/.test(w)));

  // Non-string array elements are not well-formed.
  const badArr = validateOpinion({ recommendation: "x", confidence: "low", dissent_points: [1], assumptions: [], tradeoffs: [] });
  assert.equal(badArr.wellFormed, false);
  assert.ok(badArr.warnings.some((w) => /dissent_points/.test(w)));

  // Garbage never throws.
  assert.doesNotThrow(() => validateOpinion(null));
  assert.equal(validateOpinion(null).valid, false);
  assert.equal(validateOpinion(42).valid, false);
});

test("P4: OPINION_INSTRUCTIONS is a non-empty string naming all five fields", () => {
  assert.equal(typeof OPINION_INSTRUCTIONS, "string");
  assert.ok(OPINION_INSTRUCTIONS.length > 0);
  for (const k of ["recommendation", "confidence", "dissent_points", "assumptions", "tradeoffs"]) {
    assert.ok(OPINION_INSTRUCTIONS.includes(k), `instructions mention ${k}`);
  }
});

test("P5: parseOpinion reads a FENCED ```json block", () => {
  const text = 'Here is my view:\n```json\n' +
    JSON.stringify({ recommendation: "go", confidence: "medium", dissent_points: ["a"], assumptions: ["b"], tradeoffs: ["c"] }) +
    '\n```\nthanks';
  const env = parseOpinion(text);
  assert.equal(env.structured, true);
  assert.equal(env.recommendation, "go");
  assert.equal(env.confidence, "medium");
  assert.deepEqual(env.dissent_points, ["a"]);
  assert.deepEqual(env.assumptions, ["b"]);
  assert.deepEqual(env.tradeoffs, ["c"]);
  assert.equal(env.raw, text);
});

test("P6: parseOpinion reads RAW UNFENCED json (native response_format path)", () => {
  // OpenRouter/Grok with response_format return raw JSON, no fence — must NOT be mis-tagged.
  const text = JSON.stringify({ recommendation: "raw-go", confidence: "high" });
  const env = parseOpinion(text);
  assert.equal(env.structured, true);
  assert.equal(env.recommendation, "raw-go");
  assert.equal(env.confidence, "high");
  assert.deepEqual(env.dissent_points, []); // missing arrays default to []
});

test("P7: parseOpinion falls back for unstructured prose — keeps raw, never throws", () => {
  const text = "I think you should ship it, confidence is high-ish.";
  const env = parseOpinion(text);
  assert.equal(env.structured, false);
  assert.equal(env.recommendation, text); // raw text preserved as recommendation
  assert.equal(env.raw, text);
  assert.deepEqual(env.dissent_points, []);
  assert.ok(env.warnings.some((w) => /unstructured/.test(w)));
});

test("P8: parseOpinion tolerates MALFORMED json in a fence (no throw, flagged)", () => {
  const text = '```json\n{ "recommendation": "x", confidence: bad json,, }\n```';
  /** @type {any} */
  let env;
  assert.doesNotThrow(() => { env = parseOpinion(text); });
  assert.equal(env.structured, false);
  assert.equal(env.raw, text);
  assert.ok(env.warnings.length > 0);
});

test("P9: parseOpinion normalizes a bad confidence to a flagged fallback", () => {
  const text = JSON.stringify({ recommendation: "go", confidence: "very-sure" });
  const env = parseOpinion(text);
  // Parsed as structured JSON, but confidence is outside the enum -> flagged fallback.
  assert.equal(env.recommendation, "go");
  assert.equal(env.confidence, "unknown");
  assert.ok(env.warnings.some((w) => /confidence/.test(w)));
});

test("P10: parseOpinion coerces non-array enriched fields to [] with a warning", () => {
  const text = JSON.stringify({ recommendation: "go", confidence: "low", dissent_points: "not-an-array" });
  const env = parseOpinion(text);
  assert.deepEqual(env.dissent_points, []);
  assert.ok(env.warnings.some((w) => /dissent_points/.test(w)));
});

test("P11: parseOpinion prefers the LAST json block carrying a recommendation (example block first)", () => {
  const text =
    'Example of the format:\n```json\n{ "recommendation": "EXAMPLE", "confidence": "low" }\n```\n' +
    'My actual verdict:\n```json\n' +
    JSON.stringify({ recommendation: "REAL", confidence: "high" }) +
    '\n```';
  const env = parseOpinion(text);
  assert.equal(env.structured, true);
  assert.equal(env.recommendation, "REAL");
  assert.equal(env.confidence, "high");
});

test("P12: parseOpinion skips a malformed earlier block and uses a valid later one", () => {
  const text =
    '```json\n{ bad json,, }\n```\n```json\n' +
    JSON.stringify({ recommendation: "recovered", confidence: "medium" }) +
    '\n```';
  const env = parseOpinion(text);
  assert.equal(env.structured, true);
  assert.equal(env.recommendation, "recovered");
});

test("P13: parseOpinion never throws on hostile inputs (null-proto, non-string)", () => {
  assert.doesNotThrow(() => parseOpinion(/** @type {any} */ (Object.create(null))));
  assert.doesNotThrow(() => parseOpinion(/** @type {any} */ (12345)));
  assert.doesNotThrow(() => parseOpinion(/** @type {any} */ (null)));
  assert.equal(parseOpinion(/** @type {any} */ (null)).structured, false);
});

test("P14: OPINION_SCHEMA is deep-frozen (nested mutation has no effect)", () => {
  const props = /** @type {Record<string, any>} */ (OPINION_SCHEMA.properties);
  assert.equal(Object.isFrozen(OPINION_SCHEMA), true);
  assert.equal(Object.isFrozen(OPINION_SCHEMA.properties), true);
  assert.equal(Object.isFrozen(OPINION_SCHEMA.required), true);
  assert.equal(Object.isFrozen(props.confidence.enum), true);
  // Silent in sloppy mode, throws in strict; either way the value is unchanged.
  try { props.recommendation.type = "number"; } catch { /* strict-mode throw is fine */ }
  assert.equal(props.recommendation.type, "string");
});

test("P15: a parseOpinion structured envelope is wellFormed; an unstructured one is not", () => {
  const structured = parseOpinion(JSON.stringify({ recommendation: "go", confidence: "high", dissent_points: [], assumptions: [], tradeoffs: [] }));
  assert.equal(structured.structured, true);
  assert.equal(validateOpinion(structured).wellFormed, true);

  const prose = parseOpinion("just some prose, no json");
  assert.equal(prose.structured, false);
  // confidence degraded to "unknown" -> not wellFormed (provenance false, quality false).
  assert.equal(validateOpinion(prose).wellFormed, false);
});

test("P16: parseOpinion reads a BARE fence (``` with no language tag)", () => {
  const text = "verdict below:\n```\n" + JSON.stringify({ recommendation: "bare", confidence: "low" }) + "\n```";
  const env = parseOpinion(text);
  assert.equal(env.structured, true);
  assert.equal(env.recommendation, "bare");
});

test("P17: the LAST parseable block always wins, even one without a recommendation", () => {
  // Contract: OPINION_INSTRUCTIONS says the opinion block is LAST. An earlier
  // block carrying a recommendation must NOT override a later parseable object.
  const text =
    '```json\n' + JSON.stringify({ recommendation: "EARLY-EXAMPLE", confidence: "high" }) + '\n```\n' +
    '```json\n' + JSON.stringify({ confidence: "low" }) + '\n```';
  const env = parseOpinion(text);
  assert.equal(env.structured, true); // parsed an object (the last one)
  assert.notEqual(env.recommendation, "EARLY-EXAMPLE"); // the early example did not win
  assert.equal(env.recommendation, env.raw); // last block had no recommendation -> raw fallback
  assert.ok(env.warnings.some((w) => /recommendation/.test(w)));
});

test("P18: validateOpinion on a raw object missing recommendation is valid:false (no throw)", () => {
  const r = validateOpinion({ confidence: "high", dissent_points: [], assumptions: [], tradeoffs: [] });
  assert.equal(r.valid, false);
  assert.equal(r.wellFormed, false);
  assert.ok(r.warnings.some((w) => /recommendation/.test(w)));
});

// --- Retry-After ---

const { parseRetryAfterMs } = require("../core/provider.js");

test("RA1: delta-seconds parses to ms", () => {
  assert.equal(parseRetryAfterMs("30"), 30000);
  assert.equal(parseRetryAfterMs("  0 "), 0);
});

test("RA2: an HTTP-date parses to a non-negative delta", () => {
  const soon = new Date(Date.now() + 20000).toUTCString();
  const ms = /** @type {number} */ (parseRetryAfterMs(soon));
  assert.ok(ms > 5000 && ms <= 20000, `expected ~20s, got ${ms}`);
  // A date already in the past clamps to 0 rather than going negative.
  assert.equal(parseRetryAfterMs(new Date(Date.now() - 60000).toUTCString()), 0);
});

test("RA3: missing or unparseable values yield undefined", () => {
  for (const v of [undefined, null, "", "   ", "soon", "-5", "1.5", 30]) {
    assert.equal(parseRetryAfterMs(/** @type {any} */ (v)), undefined, `${JSON.stringify(v)} -> undefined`);
  }
});

test("RA4: toErrorResult forwards retryAfterMs and omits it when absent", () => {
  const classify = () => ({ errorKind: "rate-limit", retryable: true });
  const withHint = toErrorResult("grok", "m", Date.now(), { status: 429, retryAfterMs: 4000 }, classify);
  assert.equal(withHint.retryAfterMs, 4000);
  const without = toErrorResult("grok", "m", Date.now(), { status: 429 }, classify);
  assert.ok(!("retryAfterMs" in without), "absent hint adds no key");
});

test("RA5: toErrorResult forwards the bridge's message, truncated, and omits it when absent", () => {
  // Issue #180: the Gemini bridge said exactly why it failed ("2 chars, below the 80-char
  // answer floor: ok"), but the unified envelope carried only errorKind, so the operator
  // saw an opaque `empty` and spent hours instrumenting the sandbox. Forward the reason.
  const classify = () => ({ errorKind: "empty", retryable: true });
  const withMsg = toErrorResult("gemini", "m", Date.now(), new Error("agy returned a stub, not an answer (2 chars): ok"), classify);
  assert.equal(withMsg.message, "agy returned a stub, not an answer (2 chars): ok");
  const long = String(toErrorResult("gemini", "m", Date.now(), new Error("x".repeat(2000)), classify).message);
  assert.ok(long.length <= 503, "bounded: " + long.length);
  assert.ok(long.endsWith("..."), "truncation is visible");
  const without = toErrorResult("gemini", "m", Date.now(), { status: 500 }, classify);
  assert.ok(!("message" in without), "no message adds no key");
  const blank = toErrorResult("gemini", "m", Date.now(), new Error(""), classify);
  assert.ok(!("message" in blank), "empty message adds no key");
});

test("RA6: the forwarded message is plain text - ANSI sequences and control bytes are stripped", () => {
  const classify = () => ({ errorKind: "unknown", retryable: false });
  const raw = "\x1b[31mError:\x1b[0m invalid model \x1b]0;title\x07selection\x07\x00 (see list)\r\n  next";
  const r = toErrorResult("gemini", "m", Date.now(), new Error(raw), classify);
  assert.equal(r.message, "Error: invalid model selection (see list)\n  next");
  const onlyControls = toErrorResult("gemini", "m", Date.now(), new Error("\x1b[2J\x07"), classify);
  assert.ok(!("message" in onlyControls), "nothing left after stripping adds no key");
});

// --- fetch failure classification -----------------------------------------

test("FF1: a wrapped abort (TypeError: terminated + cause AbortError) is a timeout", () => {
  // undici does NOT always reject with the AbortError itself: when the controller fires
  // during the body/stream read it rejects with `TypeError: terminated` whose `cause` is
  // a DOMException named AbortError. Classifying that as `network` makes it RETRYABLE,
  // so the call pays a second full ceiling - the exact double-billing the timeout
  // classification exists to prevent.
  const e = new TypeError("terminated");
  e.cause = new DOMException("This operation was aborted", "AbortError");
  assert.deepEqual(classifyFetchFailure(e), { code: "timeout", transportCode: "AbortError" });
});

test("FF2: a DOMException's numeric legacy `code` never leaks as the transport code", () => {
  const e = new TypeError("terminated");
  e.cause = new DOMException("aborted", "AbortError");
  assert.equal(/** @type {any} */ (e.cause).code, 20, "the legacy numeric code is present and must be skipped");
  assert.equal(classifyFetchFailure(e).transportCode, "AbortError");
});

test("FF3: undici ceilings are timeouts; a real transport fault stays network", () => {
  const undici = (/** @type {string} */ code) => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(code), { code }) });
  assert.equal(classifyFetchFailure(undici("UND_ERR_HEADERS_TIMEOUT")).code, "timeout");
  assert.equal(classifyFetchFailure(undici("UND_ERR_BODY_TIMEOUT")).code, "timeout");
  assert.equal(classifyFetchFailure(undici("ECONNRESET")).code, "network");
  assert.equal(classifyFetchFailure(undici("ENOTFOUND")).transportCode, "ENOTFOUND");
});
