"use strict";
// Answer floor shared by the Gemini and Grok bridges: a provider stub is an error, not
// an answer - but a terse answer is an answer.
//
// History. `agy` can exit 0 having printed only a preamble ("I will begin by finding the
// repository directory...") and `grok-4.6` can end its turn on "I'll verify the cited
// files..." (99-162 chars) waiting for a tool call that never comes. Any non-empty text
// used to flow downstream as a real opinion, and inside consensus `parseReview` turned it
// into `verdict: null` - silently blocking convergence. The first fix was an 80-char
// LENGTH floor. Issue #180 showed why that is the wrong signal: the reporter's smoke
// prompt "Sag nur: ok" made agy answer `ok` (2 chars, exit 0) and every call failed as
// `empty`. A length floor cannot tell a terse answer from a stub; the opening phrase can.
//
// Two checks, both disabled by a floor of 0 (the documented escape hatch):
//   1. trimmed length < minChars           -> stub ("N chars, below the M-char answer floor")
//   2. length < 400 AND opens with intent  -> stub ("N chars that only announce intent")
// The shipped default floor is 1: non-empty output is an answer unless it announces
// intent. Operators who want the old hard floor set GEMINI_/GROK_MIN_ANSWER_CHARS=80.
//
// ponytail: an opening-phrase regex is a proxy for "announced intent instead of answering";
// upgrade to a structured-output check once parseOpinion is wired into the pipeline.

const DEFAULT_MIN_ANSWER_CHARS = 1;
const INTENT_STUB_MAX_CHARS = 400;
const INTENT_STUB_RE = /^\W*(?:I(?:'ll| will|'m going to| am going to)|Let me|First,? I)\b/i;

/**
 * Parse a `*_MIN_ANSWER_CHARS` env value. Non-numeric or negative falls back to the default.
 * @param {string|undefined} envValue
 * @returns {number}
 */
function readMinAnswerChars(envValue) {
  if (envValue === undefined || envValue === "") return DEFAULT_MIN_ANSWER_CHARS;
  const raw = Number(envValue);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_MIN_ANSWER_CHARS;
}

/**
 * Why `text` is a stub, or null when it counts as an answer.
 * @param {unknown} text
 * @param {number} minChars 0 disables both checks.
 * @returns {(string|null)}
 */
function stubReason(text, minChars) {
  if (minChars === 0) return null;
  const t = String(text == null ? "" : text).trim();
  if (t.length < minChars) return `${t.length} chars, below the ${minChars}-char answer floor`;
  if (t.length < INTENT_STUB_MAX_CHARS && INTENT_STUB_RE.test(t)) return `${t.length} chars that only announce intent`;
  return null;
}

module.exports = { DEFAULT_MIN_ANSWER_CHARS, INTENT_STUB_MAX_CHARS, INTENT_STUB_RE, readMinAnswerChars, stubReason };
