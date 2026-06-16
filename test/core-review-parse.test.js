// test/core-review-parse.test.js
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseReview, REVIEW_CATEGORIES } = require("../core/provider.js");

test("RP1: parses a bold APPROVE verdict with no issues", () => {
  const r = parseReview("Looks solid.\n\n**Verdict**: APPROVE");
  assert.equal(r.verdict, "APPROVE");
  assert.deepEqual(r.criticalIssues, []);
});

test("RP2: 'REQUEST CHANGES' (space form) normalizes to REQUEST_CHANGES", () => {
  assert.equal(parseReview("Verdict: REQUEST CHANGES").verdict, "REQUEST_CHANGES");
  assert.equal(parseReview("**Verdict:** REQUEST_CHANGES").verdict, "REQUEST_CHANGES");
});

test("RP3: verdict match is case-insensitive", () => {
  assert.equal(parseReview("verdict: reject").verdict, "REJECT");
  assert.equal(parseReview("VERDICT: approve").verdict, "APPROVE");
});

test("RP4: extracts categorized critical issues (bracket + backtick forms)", () => {
  const text = [
    "**Verdict**: REQUEST_CHANGES",
    "**Critical issues**:",
    "- [security] no authz on the endpoint",
    "- `[ops]` missing rollback step",
  ].join("\n");
  const r = parseReview(text);
  assert.equal(r.verdict, "REQUEST_CHANGES");
  assert.equal(r.criticalIssues.length, 2);
  assert.deepEqual(r.criticalIssues[0], { category: "security", description: "no authz on the endpoint" });
  assert.deepEqual(r.criticalIssues[1], { category: "ops", description: "missing rollback step" });
});

test("RP5: an unknown/missing category falls back to 'ambiguity'", () => {
  const r = parseReview("- [bogus] something vague");
  assert.equal(r.criticalIssues.length, 1);
  assert.equal(r.criticalIssues[0].category, "ambiguity");
  assert.equal(r.criticalIssues[0].description, "something vague");
});

test("RP6: no verdict line -> verdict null, never throws", () => {
  assert.doesNotThrow(() => parseReview("just some prose with no verdict"));
  assert.equal(parseReview("just some prose with no verdict").verdict, null);
});

test("RP7: hostile/non-string input -> {verdict:null, criticalIssues:[]} no throw", () => {
  for (const bad of [null, undefined, 42, {}, []]) {
    /** @type {any} */
    let r;
    assert.doesNotThrow(() => { r = parseReview(/** @type {any} */ (bad)); });
    assert.equal(r.verdict, null);
    assert.deepEqual(r.criticalIssues, []);
  }
});

test("RP8: verdict embedded in a sentence is still found", () => {
  assert.equal(parseReview("My **Verdict:** APPROVE - ship it").verdict, "APPROVE");
});

test("RP9: the FIRST verdict line wins (the reviewer's own), not a quoted one later", () => {
  const text = "**Verdict**: REJECT\n...\nthe template says Verdict: APPROVE";
  assert.equal(parseReview(text).verdict, "REJECT");
});

test("RP10: a non-issue bracket like [note] in prose is only taken on a bullet line", () => {
  // Bracketed token mid-paragraph (not a leading bullet) must NOT become an issue.
  const r = parseReview("This plan [mostly] works.\n\n**Verdict**: APPROVE");
  assert.deepEqual(r.criticalIssues, []);
  assert.equal(r.verdict, "APPROVE");
});

test("RP12: substring traps do NOT set a verdict ('DISAPPROVE', 'do not REJECT')", () => {
  assert.equal(parseReview("Verdict: DISAPPROVE").verdict, null);
  assert.equal(parseReview("My verdict: do not REJECT this").verdict, null);
  assert.equal(parseReview("Verdict: APPROVED").verdict, null); // bounded - 'APPROVED' != 'APPROVE'
});

test("RP13: a loose/echoed 'verdict' mention with a non-adjacent token is ignored", () => {
  // The instruction phrasing puts the alpha word 'as'/'or' between keyword and token.
  assert.equal(parseReview("Provide your verdict as APPROVE or REJECT below.").verdict, null);
});

test("RP14: among multiple brackets the first KNOWN category wins (priority tag dropped)", () => {
  const r = parseReview("- [P0] [security] buffer overflow on input");
  assert.equal(r.criticalIssues.length, 1);
  assert.equal(r.criticalIssues[0].category, "security");
  assert.equal(r.criticalIssues[0].description, "buffer overflow on input");
});

test("RP15: a category-only bullet with no description is dropped", () => {
  assert.deepEqual(parseReview("- [security]").criticalIssues, []);
});

test("RP11: REVIEW_CATEGORIES is the frozen 6-set", () => {
  assert.deepEqual([...REVIEW_CATEGORIES].sort(), ["ambiguity", "correctness", "ops", "performance", "scope", "security"]);
  assert.equal(Object.isFrozen(REVIEW_CATEGORIES), true);
});

test("RP-V1: heading-split verdict (### Verdict then token on next line)", () => {
  assert.equal(parseReview("### Verdict\n**REQUEST CHANGES**").verdict, "REQUEST_CHANGES");
  assert.equal(parseReview("**Verdict**\nAPPROVE").verdict, "APPROVE");
  assert.equal(parseReview("### **Verdict**\nAPPROVE").verdict, "APPROVE");
});

test("RP-V2: bare leading token with no 'verdict' keyword", () => {
  assert.equal(parseReview("REQUEST CHANGES\n\nThe cache regression needs a fix.").verdict, "REQUEST_CHANGES");
  assert.equal(parseReview("APPROVE\n\n- [correctness] minor nit").verdict, "APPROVE");
});

test("RP-V3: explicit VERDICT: sentinel line wins", () => {
  assert.equal(parseReview("blah\nVERDICT: APPROVE\nmore").verdict, "APPROVE");
  assert.equal(parseReview("VERDICT: REQUEST_CHANGES").verdict, "REQUEST_CHANGES");
});

test("RP-V4: tokens inside fenced code blocks do NOT hijack the verdict", () => {
  const t = ["```", "VERDICT: REJECT", "```", "VERDICT: APPROVE"].join("\n");
  assert.equal(parseReview(t).verdict, "APPROVE");
});

test("RP-V5: a bare token in prose does NOT match (only a whole-line token)", () => {
  assert.equal(parseReview("I would not REJECT this; it is fine.").verdict, null);
});

test("RP-V6: still returns null when there is genuinely no verdict", () => {
  assert.equal(parseReview("Some commentary with no decision.").verdict, null);
});

test("RP-I1: bold category heading with description on the NEXT line", () => {
  const t = ["VERDICT: REQUEST_CHANGES", "- **[security]**", "  the endpoint has no authz check"].join("\n");
  assert.deepEqual(parseReview(t).criticalIssues, [{ category: "security", description: "the endpoint has no authz check" }]);
});

test("RP-I2: pure markdown-artifact description (** with nothing after) is dropped", () => {
  const t = ["VERDICT: APPROVE", "- [correctness] **", "", "next paragraph"].join("\n");
  assert.deepEqual(parseReview(t).criticalIssues, []);
});

test("RP-I3: same-line category + description still works (no regression)", () => {
  const t = ["VERDICT: REQUEST_CHANGES", "- [ops] missing rollback step"].join("\n");
  assert.deepEqual(parseReview(t).criticalIssues, [{ category: "ops", description: "missing rollback step" }]);
});

test("RP-I4: continuation stops at a blank line / next bullet (no over-capture)", () => {
  const t = ["- [scope] ", "- [perf-ish] should not be swallowed"].join("\n");
  // first bullet has empty desc and the next line is another bullet -> dropped, not joined
  assert.deepEqual(parseReview(t).criticalIssues.filter(c => c.category === "scope"), []);
});

test("RP-I5: continuation stops at a legacy same-line verdict line (not swallowed as description)", () => {
  const t = ["- [security]", "Final verdict - APPROVE"].join("\n");
  // empty-desc bullet must NOT swallow the following same-line verdict line; issue is dropped, verdict still resolves
  const r = parseReview(t);
  assert.deepEqual(r.criticalIssues, []);
  assert.equal(r.verdict, "APPROVE");
});

test("RP-V7: a bare token on a MIDDLE line (not first/last) does NOT hijack the verdict", () => {
  assert.equal(parseReview("Some analysis here.\nAPPROVE\nMore detail follows.").verdict, null);
  // first/last-line bare tokens still resolve:
  assert.equal(parseReview("APPROVE\nrationale follows").verdict, "APPROVE");
  assert.equal(parseReview("rationale first\nREJECT").verdict, "REJECT");
});
