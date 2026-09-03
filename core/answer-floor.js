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
// "Announces intent" means an intent phrase FOLLOWED BY an exploration verb ("I will
// begin by...", "I'll verify...", "Let me check..."). The phrase alone is not enough:
// "I will.", "I'll go with option B because..." and "Let me be clear: no." are complete
// short answers, and with a floor of 1 they would otherwise be the new false positives.
//
// ponytail: an opening-phrase regex is a proxy for "announced intent instead of answering";
// upgrade to a structured-output check once parseOpinion is wired into the pipeline.

const DEFAULT_MIN_ANSWER_CHARS = 1;
const INTENT_STUB_MAX_CHARS = 400;
// An adverb between the phrase and the verb is allowed ("I will now check...") but is not
// a verb itself: "I will now answer: 42" is an answer.
const INTENT_STUB_RE = new RegExp(
  "^\\W*(?:I(?:'ll| will|'m going to| am going to)|Let me|First,? I(?:'ll| will)?)\\s+" +
  "(?:(?:now|first|quickly|just)\\s+)?" +
  "(?:begin|start|verify|check|read|look|find|open|examine|inspect|review|explore|" +
  "search|scan|run|fetch|gather|walk|dig|investigate|analy[sz]e|take a look|go through)\\b",
  "i",
);

/**
 * Parse a `*_MIN_ANSWER_CHARS` env value. Blank, non-numeric or negative falls back to
 * the default (a blank value must not silently disable the floor: Number(" ") is 0).
 * @param {string|undefined} envValue
 * @returns {number}
 */
function readMinAnswerChars(envValue) {
  const s = envValue === undefined ? "" : String(envValue).trim();
  if (s === "") return DEFAULT_MIN_ANSWER_CHARS;
  const raw = Number(s);
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
