"use strict";
// Answer floor (shared by the Gemini and Grok bridges): a provider stub is an error, not
// an answer - but a terse answer is an answer (issue #180).
const test = require("node:test");
const assert = require("node:assert/strict");
const { stubReason, readMinAnswerChars, DEFAULT_MIN_ANSWER_CHARS } = require("../core/answer-floor.js");

const GEMINI_PREAMBLE = "I will begin by finding the repository directory and reading the relevant files.";
const GROK_STUB = "I'll verify the cited files and edit anchors so the review is based on what's actually in the repo.";

test("AF1: the shipped default accepts any non-empty answer, however terse (#180)", () => {
  assert.equal(DEFAULT_MIN_ANSWER_CHARS, 1);
  assert.equal(stubReason("ok", DEFAULT_MIN_ANSWER_CHARS), null);
  assert.equal(stubReason("42", DEFAULT_MIN_ANSWER_CHARS), null);
  assert.equal(stubReason("VERDICT: APPROVE", DEFAULT_MIN_ANSWER_CHARS), null);
});

test("AF2: empty or whitespace-only output is a stub under the default", () => {
  assert.match(String(stubReason("", DEFAULT_MIN_ANSWER_CHARS)), /answer floor/);
  assert.match(String(stubReason("   \n", DEFAULT_MIN_ANSWER_CHARS)), /answer floor/);
  assert.match(String(stubReason(null, DEFAULT_MIN_ANSWER_CHARS)), /answer floor/);
});

test("AF3: an announced-intent preamble is a stub regardless of the length floor", () => {
  assert.match(String(stubReason(GEMINI_PREAMBLE, DEFAULT_MIN_ANSWER_CHARS)), /announce intent/);
  assert.match(String(stubReason(GROK_STUB, DEFAULT_MIN_ANSWER_CHARS)), /announce intent/);
  assert.match(String(stubReason("  Let me check the files first.", DEFAULT_MIN_ANSWER_CHARS)), /announce intent/);
});

test("AF4: a long answer that merely opens with an intent phrase is not a stub", () => {
  const long = "I'll be direct: the plan is sound. " + "Every task names a starting file and an executable check. ".repeat(8);
  assert.ok(long.length >= 400);
  assert.equal(stubReason(long, DEFAULT_MIN_ANSWER_CHARS), null);
});

test("AF5: an explicit floor still rejects short output below it", () => {
  assert.match(String(stubReason("ok", 80)), /2 chars, below the 80-char answer floor/);
  assert.equal(stubReason("x".repeat(80), 80), null);
});

test("AF6: floor 0 disables both checks (escape hatch)", () => {
  assert.equal(stubReason("", 0), null);
  assert.equal(stubReason(GEMINI_PREAMBLE, 0), null);
});

test("AF7: readMinAnswerChars parses the env value and falls back to the default", () => {
  assert.equal(readMinAnswerChars(undefined), DEFAULT_MIN_ANSWER_CHARS);
  assert.equal(readMinAnswerChars(""), DEFAULT_MIN_ANSWER_CHARS);
  // Number(" ") is 0, which would silently DISABLE the floor on a blank env value.
  assert.equal(readMinAnswerChars(" "), DEFAULT_MIN_ANSWER_CHARS);
  assert.equal(readMinAnswerChars(" 80 "), 80);
  assert.equal(readMinAnswerChars("abc"), DEFAULT_MIN_ANSWER_CHARS);
  assert.equal(readMinAnswerChars("-5"), DEFAULT_MIN_ANSWER_CHARS);
  assert.equal(readMinAnswerChars("0"), 0);
  assert.equal(readMinAnswerChars("80"), 80);
});

test("AF8: an intent phrase WITHOUT an exploration verb is a complete short answer, not a stub", () => {
  // Review round 1 (#180): with the length floor gone, a bare "I'll"/"Let me" opener would
  // have become the new false positive. Intent means "I will go and look", not any
  // first-person sentence.
  for (const answer of [
    "I will.",
    "I'll go with option B because it keeps the retry budget bounded.",
    "Let me be clear: no.",
    "First, I disagree with the premise - the cache key already includes the files.",
    "I'm going to say APPROVE - the plan names files and has executable checks.",
    // An adverb is not a verb (loop-2 review): "now"/"first" must not count on their own.
    "I will now answer: 42",
    "I'll first say APPROVE, then the reasons.",
  ]) {
    assert.equal(stubReason(answer, DEFAULT_MIN_ANSWER_CHARS), null, answer);
  }
  // ...while the observed stubs and their close variants still trip it.
  for (const stub of [
    GEMINI_PREAMBLE,
    GROK_STUB,
    "Let me check the files first.",
    "First, I will start by reading the bridge.",
    "I'm going to take a look at the repository structure.",
    "I will now check the files.",
  ]) {
    assert.match(String(stubReason(stub, DEFAULT_MIN_ANSWER_CHARS)), /announce intent/, stub);
  }
});
