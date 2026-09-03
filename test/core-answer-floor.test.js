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
  assert.equal(readMinAnswerChars("abc"), DEFAULT_MIN_ANSWER_CHARS);
  assert.equal(readMinAnswerChars("-5"), DEFAULT_MIN_ANSWER_CHARS);
  assert.equal(readMinAnswerChars("0"), 0);
  assert.equal(readMinAnswerChars("80"), 80);
});
