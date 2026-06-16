"use strict";

/**
 * core/consensus-loop.js - the single source of truth for the multi-round
 * consensus convergence loop. PURE host-neutral state machine: every transition
 * takes a state and returns a NEW state (never mutates), and performs NO I/O.
 *
 * Hosts drive it differently but share THIS logic (no duplicate algorithm):
 *   - Claude Code: a thin client-driven driver calls these transitions one step
 *     per turn, emitting its blind verdict + adjudication as visible transcript
 *     messages (preserving accountability). Server wiring + driver land in PR2b.
 *   - Non-Claude hosts: a `runToConvergence` wrapper (PR2b) drives the SAME
 *     transitions internally with a provider arbiter.
 *
 * `recordBlindVerdict` gates peer reveal (precommit); `submitAdjudication`
 * refuses a silent dismissal (no reason -> throws); `checkConvergence` is pure
 * and enforces "cannot self-approve". See docs/multi-growth/PLAN_point1.md.
 */

const MAX_ROUNDS_DEFAULT = 5;
/** Closed verdict set a peer/host review can carry. */
const VERDICTS = Object.freeze(["APPROVE", "REQUEST_CHANGES", "REJECT"]);

/**
 * The wire-format mandate appended verbatim to BOTH the peer and blind review
 * prompts. SSOT: parseReview (core/provider.js) parses exactly this shape
 * (a `VERDICT: <token>` sentinel line + `- [category] description` issue lines,
 * categories == REVIEW_CATEGORIES). Edit here only; the two prompts MUST stay
 * byte-identical in this suffix or peer/blind replies diverge and the single
 * parser silently mis-handles one path.
 */
const REVIEW_FORMAT_INSTRUCTION =
  "End with a line by itself in exactly this form (no markdown, token on the SAME line): VERDICT: APPROVE   (or VERDICT: REQUEST_CHANGES, or VERDICT: REJECT). Then list any critical issues, one per line as: - [category] description   where category is one of security, correctness, scope, ambiguity, performance, ops.";

/**
 * @typedef {Object} CriticalIssue
 * @property {("security"|"correctness"|"scope"|"ambiguity"|"performance"|"ops")} category
 * @property {string} description
 */

/**
 * One voice's review for a round. `isError` voices are excluded from the
 * convergence bar. `verdict` is null when errored.
 * @typedef {Object} ReviewResult
 * @property {string} source
 * @property {boolean} isError
 * @property {string} [errorKind]
 * @property {(("APPROVE"|"REQUEST_CHANGES"|"REJECT")|null)} verdict
 * @property {CriticalIssue[]} criticalIssues
 * @property {any} [envelope]
 * @property {number} [ms]
 */

/**
 * An adjudication decision on one critical issue. `dismiss`/`defer` REQUIRE a
 * reason (enforced - no silent dismissal).
 * @typedef {Object} Decision
 * @property {string} source
 * @property {("security"|"correctness"|"scope"|"ambiguity"|"performance"|"ops")} category
 * @property {string} description
 * @property {("accept"|"dismiss"|"defer")} action
 * @property {string} [reason]
 */

/**
 * @typedef {Object} HostVerdict
 * @property {("APPROVE"|"REQUEST_CHANGES"|"REJECT")} verdict
 * @property {CriticalIssue[]} [criticalIssues]
 */

/**
 * @typedef {Object} RoundRecord
 * @property {number} round
 * @property {string} plan
 * @property {(string|null)} blindVerdict
 * @property {ReviewResult[]} results
 * @property {Decision[]} decisions
 * @property {(HostVerdict|null)} hostVerdict
 * @property {string} [diffSummary]
 */

/**
 * @typedef {Object} LoopState
 * @property {number} round
 * @property {number} maxRounds
 * @property {("await_blind"|"await_peers"|"await_adjudication"|"await_revision"|"converged"|"unresolved")} status
 * @property {string} currentPlan
 * @property {(string|null)} [expert]
 * @property {("host"|"provider")} arbiterMode
 * @property {(string|null)} [blindVerdict]
 * @property {ReviewResult[]} [results]
 * @property {Decision[]} [decisions]
 * @property {(HostVerdict|null)} [hostVerdict]
 * @property {RoundRecord[]} history
 */

/** Throw a clear status-guard error so a driver can recover (expected vs got). */
function assertStatus(/** @type {LoopState} */ state, /** @type {string} */ expected, /** @type {string} */ op) {
  if (state.status !== expected) {
    throw new Error(`${op}: expected status '${expected}', got '${state.status}'`);
  }
}

/**
 * @param {{plan:string, maxRounds?:number, expert?:string, arbiterMode?:("host"|"provider")}} opts
 * @returns {LoopState}
 */
function initConsensusLoop(opts) {
  const maxRounds = Number.isInteger(opts.maxRounds) && /** @type {number} */ (opts.maxRounds) > 0
    ? /** @type {number} */ (opts.maxRounds)
    : MAX_ROUNDS_DEFAULT;
  return {
    round: 1,
    maxRounds,
    status: "await_blind",
    currentPlan: opts.plan,
    expert: opts.expert || null,
    arbiterMode: opts.arbiterMode || "host",
    blindVerdict: null,
    results: [],
    decisions: [],
    hostVerdict: null,
    history: [],
  };
}

/**
 * Build the round's prompts. Pure read. Bounds history: the last 2 rounds appear
 * verbatim (verdict + diff), older rounds as a one-line summary, to cap growth.
 * Guarded to `await_blind` so a terminated/mid-round state cannot emit a stale
 * "next round" prompt.
 * @param {LoopState} state
 * @returns {{peerPrompt:string, blindPrompt:string}}
 */
function prepareRound(state) {
  assertStatus(state, "await_blind", "prepareRound");
  const hist = state.history || [];
  const recent = hist.slice(-2).map((r) => `Round ${r.round}: ${r.diffSummary || "(revised)"}`);
  const older = hist.slice(0, -2).map((r) => `Round ${r.round}: revised`);
  const meta = [...older, ...recent].join("\n");
  const header = `Round ${state.round} of ${state.maxRounds}.`;
  const body = [
    header,
    meta ? `Prior rounds:\n${meta}` : "",
    `## Plan under review\n${state.currentPlan}`,
  ].filter(Boolean).join("\n\n");
  const peerPrompt = [
    body,
    "Review the plan for correctness, security, scope, ambiguity, performance, and ops gaps.",
    REVIEW_FORMAT_INSTRUCTION,
  ].join("\n\n");
  const blindPrompt = [
    body,
    "Give your own independent verdict BEFORE seeing peer opinions.",
    REVIEW_FORMAT_INSTRUCTION,
  ].join("\n\n");
  return { peerPrompt, blindPrompt };
}

/**
 * Record the host/arbiter blind pre-commit. Gates peer reveal: peers cannot be
 * added until this is set.
 * @param {LoopState} state
 * @param {string} blindVerdict
 * @returns {LoopState}
 */
function recordBlindVerdict(state, blindVerdict) {
  assertStatus(state, "await_blind", "recordBlindVerdict");
  if (!(typeof blindVerdict === "string" && blindVerdict.trim())) {
    throw new Error("recordBlindVerdict: blindVerdict must be a non-empty string");
  }
  return { ...state, blindVerdict, status: "await_peers" };
}

/**
 * Attach the round's peer reviews.
 * @param {LoopState} state
 * @param {ReviewResult[]} results
 * @returns {LoopState}
 */
function addOpinions(state, results) {
  assertStatus(state, "await_peers", "addOpinions");
  // Copy the array AND each element so later caller mutation cannot corrupt
  // stored state or history (the pure-machine contract).
  const owned = Array.isArray(results) ? results.map((r) => ({ ...r })) : [];
  return { ...state, results: owned, status: "await_adjudication" };
}

/**
 * Submit the host/arbiter adjudication: the overall `verdict` plus per-issue
 * decisions. THROWS if any dismiss/defer lacks a reason (no silent dismissal).
 * Then evaluates convergence and moves to `converged` or `await_revision`.
 * @param {LoopState} state
 * @param {{verdict:("APPROVE"|"REQUEST_CHANGES"|"REJECT"), decisions?:Decision[]}} adj
 * @returns {LoopState}
 */
function submitAdjudication(state, adj) {
  assertStatus(state, "await_adjudication", "submitAdjudication");
  if (!adj || !VERDICTS.includes(adj.verdict)) {
    throw new Error(`submitAdjudication: verdict must be one of ${VERDICTS.join("|")}`);
  }
  // Copy each decision so later caller mutation cannot corrupt stored state.
  const decisions = Array.isArray(adj.decisions) ? adj.decisions.map((d) => ({ ...d })) : [];
  decisions.forEach((d, i) => {
    if (!d || typeof d !== "object") {
      throw new Error(`submitAdjudication: decision at index ${i} is not an object`);
    }
    if ((d.action === "dismiss" || d.action === "defer") && !(typeof d.reason === "string" && d.reason.trim())) {
      throw new Error(`submitAdjudication: decision at index ${i} (${d.action}) requires a non-empty reason`);
    }
  });
  const next = { ...state, hostVerdict: { verdict: adj.verdict }, decisions };
  const { converged } = checkConvergence(next);
  return { ...next, status: converged ? "converged" : "await_revision" };
}

/**
 * PURE convergence check. Converges only when: >=1 responding external (an
 * errored voice is excluded), every responding external APPROVES, no REJECT,
 * zero ACCEPTED critical issues, AND the host/arbiter verdict is APPROVE
 * (cannot self-approve - peers must carry it).
 *
 * Contract: a peer's blocking concerns ride a REQUEST_CHANGES/REJECT verdict,
 * which `everyApprove` catches. `criticalIssues` attached to an APPROVE verdict
 * are advisory (the peer itself deemed them non-blocking by approving); they do
 * not block convergence unless the host adjudicates one as `accept`. Any
 * non-"APPROVE" / null / malformed verdict fails closed (no convergence).
 * @param {LoopState} state
 * @returns {{converged:boolean, verdict:("APPROVE"|"REQUEST_CHANGES"), nextAction:("finalize"|"revise")}}
 */
function checkConvergence(state) {
  const results = state.results || [];
  const responding = results.filter((r) => !r.isError);
  const everyApprove = responding.length > 0 && responding.every((r) => r.verdict === "APPROVE");
  const anyReject = responding.some((r) => r.verdict === "REJECT");
  const acceptedCritical = (state.decisions || []).filter((d) => d.action === "accept").length;
  const hostApprove = !!(state.hostVerdict && state.hostVerdict.verdict === "APPROVE");
  const converged = responding.length > 0 && everyApprove && !anyReject && acceptedCritical === 0 && hostApprove;
  return {
    converged,
    verdict: converged ? "APPROVE" : "REQUEST_CHANGES",
    nextAction: converged ? "finalize" : "revise",
  };
}

/**
 * Apply the revised plan and advance. Records the just-finished round to history.
 * If already at maxRounds, the loop ends `unresolved` (no further round).
 * @param {LoopState} state
 * @param {string} revisedPlan
 * @param {string} [diffSummary]
 * @returns {LoopState}
 */
function submitRevision(state, revisedPlan, diffSummary) {
  assertStatus(state, "await_revision", "submitRevision");
  /** @type {RoundRecord} */
  const record = {
    round: state.round,
    plan: state.currentPlan,
    blindVerdict: state.blindVerdict || null,
    results: state.results || [],
    decisions: state.decisions || [],
    hostVerdict: state.hostVerdict || null,
    diffSummary: diffSummary || "(revised)",
  };
  const history = [...state.history, record];
  if (state.round >= state.maxRounds) {
    // Cap reached: end unresolved. Still apply revisedPlan as currentPlan so the
    // final report shows the host's LAST revision (authored in response to this
    // round's dissent), not the stale plan that was reviewed. The reviewed plan is
    // preserved in the just-pushed history record.
    return { ...state, history, currentPlan: revisedPlan, status: "unresolved" };
  }
  return {
    ...state,
    history,
    round: state.round + 1,
    currentPlan: revisedPlan,
    status: "await_blind",
    blindVerdict: null,
    results: [],
    decisions: [],
    hostVerdict: null,
  };
}

/**
 * Produce the final report + confidence label. Confidence by the round the loop
 * settled in: 1 = high, 2-3 = medium, 4-5 = low; an unresolved loop = none.
 * @param {Pick<LoopState,"status"|"round"|"history"|"currentPlan">} state
 * @returns {{finalReport:string, confidence:("high"|"medium"|"low"|"none")}}
 */
function finalize(state) {
  const confidence = state.status === "converged"
    ? (state.round === 1 ? "high" : state.round <= 3 ? "medium" : "low")
    : "none";
  const outcome = state.status === "converged"
    ? `CONVERGED in ${state.round} round(s) (confidence: ${confidence})`
    : `UNRESOLVED after ${state.round} round(s)`;
  const finalReport = [
    `## Consensus result`,
    `**Outcome**: ${outcome}`,
    `**Final plan**:\n${state.currentPlan}`,
  ].join("\n\n");
  return { finalReport, confidence };
}

module.exports = {
  MAX_ROUNDS_DEFAULT,
  VERDICTS,
  initConsensusLoop,
  prepareRound,
  recordBlindVerdict,
  addOpinions,
  submitAdjudication,
  checkConvergence,
  submitRevision,
  finalize,
};
