// test/core-run-to-convergence.test.js
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { runToConvergence } = require("../core/orchestrate.js");

/**
 * Stub provider. `reply(prompt) -> string` returns the review text; throws/errors
 * are simulated by `errors:true`.
 * @param {string} name
 * @param {(prompt:string)=>string} reply
 * @param {{errors?:boolean}} [opts]
 */
function stub(name, reply, opts = {}) {
  return {
    name,
    capabilities: { canImplement: false, fileUpload: false, multiTurn: false },
    health: async () => ({ ok: true }),
    /** @param {{prompt:string}} req @returns {Promise<any>} */
    ask: async (req) => {
      const ms = 1;
      if (opts.errors) return { provider: name, model: "stub", isError: true, errorKind: "timeout", retryable: true, ms };
      return { provider: name, model: "stub", isError: false, text: reply(req.prompt), ms };
    },
  };
}

/** Peer that APPROVES once the plan has been revised, else REQUEST_CHANGES. @param {string} name */
function revisionSensitivePeer(name) {
  return stub(name, (p) => (p.includes("REVISED") ? "**Verdict**: APPROVE" : "**Verdict**: REQUEST_CHANGES\n- [scope] needs detail"));
}

/** Arbiter: blind -> APPROVE; adjudicate -> APPROVE unless a peer dissented; revise -> "REVISED plan". */
function smartArbiter(name = "arbiter") {
  return stub(name, (p) => {
    // Detect a peer dissent on a "Peer X: VERDICT" line (not the instruction line
    // that merely lists the allowed tokens).
    if (p.includes("ADJUDICATE")) return /:\s+(REQUEST_CHANGES|REJECT)\b/.test(p) ? "**Verdict**: REQUEST_CHANGES" : "**Verdict**: APPROVE";
    if (p.includes("REVISE")) return "REVISED plan addressing the feedback";
    return "**Verdict**: APPROVE"; // blind
  });
}

const REQ = { prompt: "ship the widget" };

test("RC1: all peers + arbiter APPROVE -> converged round 1, high confidence", async () => {
  const peers = [stub("gpt", () => "**Verdict**: APPROVE"), stub("gemini", () => "**Verdict**: APPROVE")];
  const out = await runToConvergence(peers, REQ, { arbiter: smartArbiter() });
  assert.equal(out.converged, true);
  assert.equal(out.verdict, "APPROVE");
  assert.equal(out.confidence, "high");
  assert.equal(out.rounds.length, 0); // converged in round 1, no revision recorded
});

test("RC2: dissent then revise -> converges in round 2", async () => {
  const peers = [revisionSensitivePeer("gpt"), revisionSensitivePeer("gemini")];
  const out = await runToConvergence(peers, REQ, { arbiter: smartArbiter(), maxRounds: 5 });
  assert.equal(out.converged, true);
  assert.equal(out.verdict, "APPROVE");
  assert.equal(out.confidence, "medium"); // round 2
  assert.equal(out.rounds.length, 1); // one revision happened
});

test("RC3: persistent dissent -> unresolved at maxRounds", async () => {
  const peers = [stub("gpt", () => "**Verdict**: REQUEST_CHANGES\n- [ops] no rollback")];
  // arbiter that never approves (always sees the dissent) + revision that never satisfies
  const arb = stub("arb", (p) => (p.includes("ADJUDICATE") ? "**Verdict**: REQUEST_CHANGES" : p.includes("REVISE") ? "still not enough" : "**Verdict**: REQUEST_CHANGES"));
  const out = await runToConvergence(peers, REQ, { arbiter: arb, maxRounds: 2 });
  assert.equal(out.converged, false);
  assert.equal(out.confidence, "none");
  assert.equal(out.rounds.length, 2); // both rounds recorded
});

test("RC4: an errored peer is excluded; remaining APPROVE -> converges", async () => {
  const peers = [stub("gpt", () => "**Verdict**: APPROVE"), stub("grok", () => "", { errors: true })];
  const out = await runToConvergence(peers, REQ, { arbiter: smartArbiter() });
  assert.equal(out.converged, true);
  // the errored peer surfaces as isError in the opinions
  assert.ok(out.opinions.some((o) => o.isError && o.source === "grok"));
});

test("RC5: a failing blind arbiter pass is isolated (run still completes)", async () => {
  // arbiter errors ONLY on the blind pass; adjudication/revision still work.
  let calls = 0;
  const arb = {
    name: "arb",
    capabilities: { canImplement: false, fileUpload: false, multiTurn: false },
    health: async () => ({ ok: true }),
    /** @param {{prompt:string}} req @returns {Promise<any>} */
    ask: async (req) => {
      calls++;
      if (!req.prompt.includes("ADJUDICATE") && !req.prompt.includes("REVISE")) {
        return { provider: "arb", model: "s", isError: true, errorKind: "timeout", retryable: true, ms: 1 }; // blind fails
      }
      return { provider: "arb", model: "s", isError: false, text: "**Verdict**: APPROVE", ms: 1 };
    },
  };
  const peers = [stub("gpt", () => "**Verdict**: APPROVE")];
  /** @type {any} */
  let out;
  await assert.doesNotReject(async () => { out = await runToConvergence(peers, REQ, { arbiter: arb }); });
  assert.equal(out.converged, true);
  assert.ok(calls > 0);
});

test("RC6: no arbiter -> graceful error, no throw", async () => {
  const out = await runToConvergence([stub("gpt", () => "**Verdict**: APPROVE")], REQ, {});
  assert.equal(out.converged, false);
  assert.equal(out.error, "no-arbiter");
});

test("RC7: a peer whose ask() throws SYNCHRONOUSLY does not reject the run", async () => {
  const syncThrower = {
    name: "boom",
    capabilities: { canImplement: false, fileUpload: false, multiTurn: false },
    health: async () => ({ ok: true }),
    ask: () => { throw new Error("sync peer throw"); }, // throws before returning a promise
  };
  /** @type {any} */
  let out;
  await assert.doesNotReject(async () => { out = await runToConvergence([syncThrower], REQ, { arbiter: smartArbiter() }); });
  assert.equal(out.converged, false);
  assert.ok(typeof out.error === "string" || out.opinions.length >= 0);
});

test("RC8: omitted maxRounds still terminates (defaults to 5) -> unresolved on persistent dissent", async () => {
  const peers = [stub("gpt", () => "**Verdict**: REQUEST_CHANGES\n- [ops] x")];
  const arb = stub("arb", (p) => (p.includes("ADJUDICATE") ? "**Verdict**: REQUEST_CHANGES" : p.includes("REVISE") ? "nope" : "**Verdict**: REQUEST_CHANGES"));
  const out = await runToConvergence(peers, REQ, { arbiter: arb }); // no maxRounds
  assert.equal(out.converged, false);
  assert.equal(out.confidence, "none");
  assert.equal(out.rounds.length, 5); // defaulted to 5 and terminated
});

test("RC9: dissent in round 1 -> the round-1 revision propagates into round 2's plan-under-review", async () => {
  /** @type {string[]} */
  const seen = [];
  const peers = [stub("gpt", (p) => { seen.push(p); return p.includes("REVISED") ? "**Verdict**: APPROVE" : "**Verdict**: REQUEST_CHANGES\n- [scope] needs detail"; })];
  const out = await runToConvergence(peers, REQ, { arbiter: smartArbiter(), maxRounds: 5 });
  assert.equal(out.converged, true); // round 2, after the revision lands
  // The dissent round's revision ("REVISED plan...") must appear in a later peer prompt.
  assert.ok(seen.some((p) => p.includes("Round 2 of 5") && p.includes("REVISED")), "round-2 plan-under-review should contain the round-1 revision");
});

test("RC10: round-1 all-APPROVE dispatches NO revision call (dissent gate avoids waste)", async () => {
  /** @type {string[]} */
  const arbPrompts = [];
  const arbiter = stub("arb", (p) => { arbPrompts.push(p); if (p.includes("ADJUDICATE")) return "**Verdict**: APPROVE"; if (p.includes("REVISE")) return "REVISED"; return "**Verdict**: APPROVE"; });
  const peers = [stub("gpt", () => "**Verdict**: APPROVE"), stub("gemini", () => "**Verdict**: APPROVE")];
  const out = await runToConvergence(peers, REQ, { arbiter });
  assert.equal(out.converged, true);
  assert.equal(out.rounds.length, 0); // converged round 1, no revision recorded
  assert.ok(!arbPrompts.some((p) => p.includes("REVISE")), "no REVISE prompt should be dispatched on an all-approve converging round");
});

test("RC11: a revision leg that throws SYNCHRONOUSLY on a dissent round is isolated (no reject)", async () => {
  // Dissent => parallel branch fires adjudication ∥ revision; the arbiter throws
  // synchronously on the REVISE prompt, before returning a promise.
  const arbiter = {
    name: "arb",
    capabilities: { canImplement: false, fileUpload: false, multiTurn: false },
    health: async () => ({ ok: true }),
    /** @param {{prompt:string}} req @returns {any} */
    ask: (req) => {
      if (req.prompt.includes("REVISE")) throw new Error("sync revise throw");
      return Promise.resolve({ provider: "arb", model: "s", isError: false, text: "**Verdict**: REQUEST_CHANGES", ms: 1 });
    },
  };
  const peers = [stub("gpt", () => "**Verdict**: REQUEST_CHANGES\n- [ops] x")];
  /** @type {any} */
  let out;
  await assert.doesNotReject(async () => { out = await runToConvergence(peers, REQ, { arbiter, maxRounds: 2 }); });
  assert.equal(out.converged, false); // revision threw -> plan never changes -> peer keeps dissenting
  assert.equal(out.rounds.length, 2); // both rounds still ran despite the throwing revision leg
});

test("RC12: all peers APPROVE but arbiter blocks -> serial revision runs (the !peerDissent post-break path)", async () => {
  /** @type {string[]} */
  const arbPrompts = [];
  // No peer dissent, but the arbiter REQUEST_CHANGES on adjudication, so the round
  // cannot converge and the SERIAL revision branch must fire.
  const arbiter = stub("arb", (p) => { arbPrompts.push(p); if (p.includes("ADJUDICATE")) return "**Verdict**: REQUEST_CHANGES"; if (p.includes("REVISE")) return "REVISED"; return "**Verdict**: APPROVE"; });
  const peers = [stub("gpt", () => "**Verdict**: APPROVE")];
  const out = await runToConvergence(peers, REQ, { arbiter, maxRounds: 2 });
  assert.equal(out.converged, false); // arbiter never approves
  assert.equal(out.rounds.length, 2);
  assert.ok(arbPrompts.some((p) => p.includes("REVISE")), "serial revision should run when all peers approve but the arbiter blocks");
});
