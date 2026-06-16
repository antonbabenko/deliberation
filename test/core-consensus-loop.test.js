// test/core-consensus-loop.test.js
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  initConsensusLoop,
  prepareRound,
  recordBlindVerdict,
  addOpinions,
  submitAdjudication,
  submitRevision,
  checkConvergence,
  finalize,
  MAX_ROUNDS_DEFAULT,
} = require("../core/consensus-loop.js");

/**
 * A successful peer review result.
 * @param {string} source
 * @param {("APPROVE"|"REQUEST_CHANGES"|"REJECT")} verdict
 * @param {any[]} [criticalIssues]
 */
function review(source, verdict, criticalIssues = []) {
  return { source, isError: false, verdict, criticalIssues };
}
/** @param {string} source */
function errored(source) {
  return { source, isError: true, errorKind: "timeout", verdict: null, criticalIssues: [] };
}

test("L1: init starts at round 1, await_blind, carries the plan", () => {
  const s = initConsensusLoop({ plan: "do X", expert: "Plan Reviewer", arbiterMode: "host" });
  assert.equal(s.round, 1);
  assert.equal(s.status, "await_blind");
  assert.equal(s.currentPlan, "do X");
  assert.equal(s.maxRounds, MAX_ROUNDS_DEFAULT);
  assert.deepEqual(s.history, []);
});

test("L2: recordBlindVerdict requires await_blind and advances to await_peers", () => {
  const s = initConsensusLoop({ plan: "p", arbiterMode: "host" });
  const s2 = recordBlindVerdict(s, "blind says request changes");
  assert.equal(s2.status, "await_peers");
  assert.equal(s2.blindVerdict, "blind says request changes");
  // out-of-order: calling addOpinions before blind throws
  assert.throws(() => addOpinions(s, [review("gpt", "APPROVE")]), /await_peers|status/i);
});

test("L3: addOpinions advances await_peers -> await_adjudication", () => {
  let s = initConsensusLoop({ plan: "p", arbiterMode: "host" });
  s = recordBlindVerdict(s, "b");
  s = addOpinions(s, [review("gpt", "APPROVE"), review("gemini", "REQUEST_CHANGES", [{ category: "correctness", description: "x" }])]);
  assert.equal(s.status, "await_adjudication");
  assert.equal((s.results || []).length, 2);
});

test("L4: submitAdjudication THROWS naming the index when a dismiss/defer lacks a reason", () => {
  let s = initConsensusLoop({ plan: "p", arbiterMode: "host" });
  s = recordBlindVerdict(s, "b");
  s = addOpinions(s, [review("gpt", "REQUEST_CHANGES", [{ category: "ops", description: "no rollback" }])]);
  assert.throws(
    () => submitAdjudication(s, { verdict: "REQUEST_CHANGES", decisions: [{ source: "gpt", category: "ops", description: "no rollback", action: "dismiss" }] }),
    /index 0|reason/i,
  );
  // with a reason it does not throw
  assert.doesNotThrow(() =>
    submitAdjudication(s, { verdict: "APPROVE", decisions: [{ source: "gpt", category: "ops", description: "no rollback", action: "dismiss", reason: "already covered in step 4" }] }),
  );
});

test("L5: converges when every responding peer APPROVES, host APPROVES, and no accepted critical issues", () => {
  let s = initConsensusLoop({ plan: "p", arbiterMode: "host" });
  s = recordBlindVerdict(s, "approve");
  s = addOpinions(s, [review("gpt", "APPROVE"), review("gemini", "APPROVE"), errored("grok")]);
  s = submitAdjudication(s, { verdict: "APPROVE", decisions: [] });
  assert.equal(s.status, "converged");
  const c = checkConvergence(s);
  assert.equal(c.converged, true);
});

test("L6: a single REQUEST_CHANGES peer blocks convergence -> await_revision", () => {
  let s = initConsensusLoop({ plan: "p", arbiterMode: "host" });
  s = recordBlindVerdict(s, "b");
  s = addOpinions(s, [review("gpt", "APPROVE"), review("gemini", "REQUEST_CHANGES", [{ category: "scope", description: "unclear" }])]);
  s = submitAdjudication(s, { verdict: "REQUEST_CHANGES", decisions: [{ source: "gemini", category: "scope", description: "unclear", action: "accept" }] });
  assert.equal(s.status, "await_revision");
  assert.equal(checkConvergence(s).converged, false);
});

test("L7: an accepted critical issue blocks convergence even if all peers APPROVE", () => {
  let s = initConsensusLoop({ plan: "p", arbiterMode: "host" });
  s = recordBlindVerdict(s, "b");
  s = addOpinions(s, [review("gpt", "APPROVE"), review("gemini", "APPROVE")]);
  // host's own blind verdict surfaced an accepted issue
  s = submitAdjudication(s, { verdict: "REQUEST_CHANGES", decisions: [{ source: "claude-blind", category: "security", description: "missing authz", action: "accept" }] });
  assert.equal(checkConvergence(s).converged, false);
});

test("L8: cannot self-approve - all peers errored means no convergence", () => {
  let s = initConsensusLoop({ plan: "p", arbiterMode: "host" });
  s = recordBlindVerdict(s, "b");
  s = addOpinions(s, [errored("gpt"), errored("gemini"), errored("grok")]);
  s = submitAdjudication(s, { verdict: "APPROVE", decisions: [] });
  const c = checkConvergence(s);
  assert.equal(c.converged, false); // >=1 responding external is required
});

test("L9: submitRevision advances the round + sets the new plan; maxRounds -> unresolved", () => {
  let s = initConsensusLoop({ plan: "p0", maxRounds: 2, arbiterMode: "host" });
  // round 1: not converged -> revise
  s = recordBlindVerdict(s, "b");
  s = addOpinions(s, [review("gpt", "REQUEST_CHANGES", [{ category: "ops", description: "x" }])]);
  s = submitAdjudication(s, { verdict: "REQUEST_CHANGES", decisions: [{ source: "gpt", category: "ops", description: "x", action: "accept" }] });
  s = submitRevision(s, "p1", "addressed x");
  assert.equal(s.round, 2);
  assert.equal(s.currentPlan, "p1");
  assert.equal(s.status, "await_blind");
  assert.equal(s.history.length, 1);
  // round 2: still not converged + at maxRounds -> unresolved
  s = recordBlindVerdict(s, "b2");
  s = addOpinions(s, [review("gpt", "REQUEST_CHANGES", [{ category: "ops", description: "y" }])]);
  s = submitAdjudication(s, { verdict: "REQUEST_CHANGES", decisions: [{ source: "gpt", category: "ops", description: "y", action: "accept" }] });
  s = submitRevision(s, "p2", "tried y");
  assert.equal(s.status, "unresolved");
});

test("L10: finalize labels confidence by round (1=high, 3=medium, 5=low, unresolved=none)", () => {
  assert.equal(finalize({ status: "converged", round: 1, history: [], currentPlan: "p" }).confidence, "high");
  assert.equal(finalize({ status: "converged", round: 3, history: [], currentPlan: "p" }).confidence, "medium");
  assert.equal(finalize({ status: "converged", round: 5, history: [], currentPlan: "p" }).confidence, "low");
  assert.equal(finalize({ status: "unresolved", round: 5, history: [], currentPlan: "p" }).confidence, "none");
});

test("L11: prepareRound returns peer + blind prompts that include the current plan", () => {
  const s = initConsensusLoop({ plan: "ship the widget", arbiterMode: "host" });
  const { peerPrompt, blindPrompt } = prepareRound(s);
  assert.ok(peerPrompt.includes("ship the widget"));
  assert.ok(blindPrompt.includes("ship the widget"));
  assert.ok(/round 1/i.test(peerPrompt));
});

test("L11b: peer and blind prompts share the byte-identical VERDICT-format mandate", () => {
  const s = initConsensusLoop({ plan: "ship the widget", arbiterMode: "host" });
  const { peerPrompt, blindPrompt } = prepareRound(s);
  const grab = (/** @type {string} */ p) => p.slice(p.indexOf("End with a line by itself"));
  assert.equal(grab(peerPrompt), grab(blindPrompt));
  assert.match(peerPrompt, /VERDICT: APPROVE/);
  assert.match(blindPrompt, /- \[category\] description/);
});

test("L12: full happy path - converge in round 1 yields a final report + high confidence", () => {
  let s = initConsensusLoop({ plan: "p", arbiterMode: "host" });
  s = recordBlindVerdict(s, "looks good");
  s = addOpinions(s, [review("gpt", "APPROVE"), review("gemini", "APPROVE")]);
  s = submitAdjudication(s, { verdict: "APPROVE", decisions: [] });
  assert.equal(s.status, "converged");
  const f = finalize(s);
  assert.equal(f.confidence, "high");
  assert.ok(typeof f.finalReport === "string" && f.finalReport.length > 0);
});

test("L13: caller mutation after addOpinions/submitAdjudication cannot corrupt state (immutability)", () => {
  let s = initConsensusLoop({ plan: "p", arbiterMode: "host" });
  s = recordBlindVerdict(s, "b");
  const peers = [review("gpt", "APPROVE")];
  s = addOpinions(s, peers);
  peers[0].verdict = "REJECT"; // mutate the caller's array AFTER ingest
  assert.equal((s.results || [])[0].verdict, "APPROVE"); // stored copy is unaffected
  /** @type {any[]} */
  const decisions = [{ source: "gpt", category: "ops", description: "x", action: "accept" }];
  s = submitAdjudication(s, { verdict: "APPROVE", decisions });
  decisions[0].action = "dismiss";
  assert.equal((s.decisions || [])[0].action, "accept");
});

test("L14: recordBlindVerdict rejects an empty/non-string verdict", () => {
  const s = initConsensusLoop({ plan: "p", arbiterMode: "host" });
  assert.throws(() => recordBlindVerdict(s, ""), /non-empty/);
  assert.throws(() => recordBlindVerdict(s, /** @type {any} */ (null)), /non-empty/);
});

test("L15: prepareRound throws on a terminated state (guarded to await_blind)", () => {
  let s = initConsensusLoop({ plan: "p", arbiterMode: "host" });
  s = recordBlindVerdict(s, "b");
  s = addOpinions(s, [review("gpt", "APPROVE")]);
  s = submitAdjudication(s, { verdict: "APPROVE", decisions: [] });
  assert.equal(s.status, "converged");
  assert.throws(() => prepareRound(s), /await_blind|status/i);
});
