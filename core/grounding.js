"use strict";
// Date grounding shared by every prompt builder (Codex, Gemini, Grok, OpenRouter).
//
// A delegate trained months ago will call a newer model, tool, or version "hallucinated"
// and file it as a critical issue - a false positive that blocks consensus. The fix
// splits by who can act. The date is a FACT only code can supply: Grok and OpenRouter
// run with no tools, so "run `date -u`" in prose would be an instruction they cannot
// follow. The no-denial rule travels with it, because a date alone still lets a model
// reject a name it does not know. Retrieving the actual facts is the HOST's job (see
// AGENTS.md "Time-sensitive questions"); a delegate is only told not to deny from memory.
//
// Kept to one short paragraph: it is paid on every delegate call, times panel size,
// times rounds.

/**
 * The grounding paragraph for a delegate prompt.
 * @param {Date} [now]  injectable clock for tests
 * @returns {string}
 */
function groundingNote(now = new Date()) {
  const date = now.toISOString().slice(0, 10);
  return (
    `Current date (UTC): ${date}. Your training data may predate it. ` +
    "Do not call a model, tool, library, API, or version hallucinated, fictional, or " +
    "non-existent only because you do not recognize it; if you cannot confirm it from this " +
    "message or from tools you actually have (if any), mark the claim [unverified] and say " +
    "what would confirm it."
  );
}

module.exports = { groundingNote };
