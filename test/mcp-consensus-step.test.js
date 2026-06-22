// test/mcp-consensus-step.test.js
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildServer } = require("../server/mcp/index.js");
const sessions = require("../core/sessions.js");

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "delib-cs-"));

/** @param {string} name @param {(p:string)=>string} reply */
function peer(name, reply) {
  return {
    name,
    capabilities: { canImplement: false, fileUpload: false, multiTurn: false },
    async health() { return { ok: true }; },
    /** @param {{prompt:string}} req @returns {Promise<any>} */
    async ask(req) { return { provider: name, model: "m", isError: false, text: reply(req.prompt), ms: 1 }; },
  };
}
const approve = (n) => peer(n, () => "**Verdict**: APPROVE");
const revSensitive = (n) => peer(n, (p) => (p.includes("REVISED") ? "**Verdict**: APPROVE" : "**Verdict**: REQUEST_CHANGES\n- [scope] thin"));
const reject = (n) => peer(n, () => "**Verdict**: REQUEST_CHANGES\n- [ops] needs work");
const config = { providers: {}, openrouter: { maxFanout: 3, models: [] } };
/** config carrying a low consensus.maxRounds, so the step loop hits the cap fast. */
const configCap = (n) => ({ providers: {}, openrouter: { maxFanout: 3, models: [] }, consensus: { maxRounds: n } });

/** Drive one consensus-step action; return the parsed payload. */
async function step(srv, args, id) {
  const res = await srv.handle({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "consensus-step", arguments: args } });
  return JSON.parse(res.result.content[0].text);
}

test("CS1: tools/list advertises consensus-step (state-writing + external)", async () => {
  const srv = buildServer({ providers: [approve("codex")], getConfig: () => config });
  const res = await srv.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const t = res.result.tools.find((x) => x.name === "consensus-step");
  assert.ok(t);
  // consensus-step mutates the ephemeral loop store every call and dispatches
  // providers via dispatch_peers, so it is NOT read-only; the annotation reflects
  // the write contract (additive, open-world).
  assert.equal(t.annotations.readOnlyHint, false);
  assert.equal(t.annotations.openWorldHint, true);
  assert.equal(t.annotations.destructiveHint, false);
});

test("CS2: full happy path converges in round 1", async () => {
  const srv = buildServer({ providers: [approve("codex"), approve("grok")], getConfig: () => config });
  const init = await step(srv, { action: "init", prompt: "ship it", expert: "architect" }, 2);
  assert.equal(init.status, "await_blind");
  assert.ok(init.sessionId && init.blindPrompt.includes("ship it"));
  const sid = init.sessionId;

  const rb = await step(srv, { action: "record_blind", sessionId: sid, blindVerdict: "looks good, APPROVE" }, 3);
  assert.equal(rb.status, "await_peers");

  const dp = await step(srv, { action: "dispatch_peers", sessionId: sid }, 4);
  assert.equal(dp.status, "await_adjudication");
  assert.equal(dp.opinions.length, 2);
  assert.ok(dp.opinions.every((o) => o.verdict === "APPROVE"));

  const adj = await step(srv, { action: "submit_adjudication", sessionId: sid, verdict: "APPROVE", decisions: [] }, 5);
  assert.equal(adj.converged, true);
  assert.equal(adj.verdict, "APPROVE");
  assert.ok(typeof adj.finalReport === "string" && adj.finalReport.length > 0);
});

test("CS3: out-of-order action -> structured error (no throw)", async () => {
  const srv = buildServer({ providers: [approve("codex")], getConfig: () => config });
  const init = await step(srv, { action: "init", prompt: "x" }, 6);
  // skip record_blind -> dispatch_peers while status is await_blind
  const bad = await step(srv, { action: "dispatch_peers", sessionId: init.sessionId }, 7);
  assert.equal(bad.error, "unexpected-action-for-status");
});

test("CS4: unknown/expired sessionId -> session-expired error", async () => {
  const srv = buildServer({ providers: [approve("codex")], getConfig: () => config });
  const out = await step(srv, { action: "record_blind", sessionId: "nope-not-real", blindVerdict: "x" }, 8);
  assert.equal(out.error, "session-expired");
});

test("CS5: dissent -> revise -> converge in round 2", async () => {
  const srv = buildServer({ providers: [revSensitive("codex"), revSensitive("grok")], getConfig: () => config });
  const sid = (await step(srv, { action: "init", prompt: "ship it" }, 10)).sessionId;
  await step(srv, { action: "record_blind", sessionId: sid, blindVerdict: "needs work" }, 11);
  const dp1 = await step(srv, { action: "dispatch_peers", sessionId: sid }, 12);
  assert.ok(dp1.opinions.every((o) => o.verdict === "REQUEST_CHANGES"));
  const adj1 = await step(srv, { action: "submit_adjudication", sessionId: sid, verdict: "REQUEST_CHANGES", decisions: [{ source: "codex", category: "scope", description: "thin", action: "accept" }] }, 13);
  assert.equal(adj1.status, "await_revision");
  const rev = await step(srv, { action: "submit_revision", sessionId: sid, revisedPlan: "REVISED plan with detail", diffSummary: "added detail" }, 14);
  assert.equal(rev.status, "await_blind");
  assert.equal(rev.round, 2);

  await step(srv, { action: "record_blind", sessionId: sid, blindVerdict: "better now" }, 15);
  const dp2 = await step(srv, { action: "dispatch_peers", sessionId: sid }, 16);
  assert.ok(dp2.opinions.every((o) => o.verdict === "APPROVE"));
  const adj2 = await step(srv, { action: "submit_adjudication", sessionId: sid, verdict: "APPROVE", decisions: [] }, 17);
  assert.equal(adj2.converged, true);
});

test("CS7: dispatch_peers with record_blind skipped errors WITHOUT fanning out to peers", async () => {
  let calls = 0;
  const counted = {
    name: "codex",
    capabilities: { canImplement: false, fileUpload: false, multiTurn: false },
    async health() { return { ok: true }; },
    /** @returns {Promise<any>} */
    async ask() { calls++; return { provider: "codex", model: "m", isError: false, text: "**Verdict**: APPROVE", ms: 1 }; },
  };
  const srv = buildServer({ providers: [counted], getConfig: () => config });
  const sid = (await step(srv, { action: "init", prompt: "x" }, 30)).sessionId;
  const bad = await step(srv, { action: "dispatch_peers", sessionId: sid }, 31); // skipped record_blind
  assert.equal(bad.error, "unexpected-action-for-status");
  assert.equal(calls, 0); // guard fired before any provider call
});

test("CS8: a non-init action without sessionId -> missing-sessionId", async () => {
  const srv = buildServer({ providers: [approve("codex")], getConfig: () => config });
  const out = await step(srv, { action: "record_blind", blindVerdict: "x" }, 32);
  assert.equal(out.error, "missing-sessionId");
});

test("CS6: no-silent-dismissal - a dismiss without a reason is rejected", async () => {
  const srv = buildServer({ providers: [approve("codex")], getConfig: () => config });
  const sid = (await step(srv, { action: "init", prompt: "x" }, 20)).sessionId;
  await step(srv, { action: "record_blind", sessionId: sid, blindVerdict: "b" }, 21);
  await step(srv, { action: "dispatch_peers", sessionId: sid }, 22);
  const adj = await step(srv, { action: "submit_adjudication", sessionId: sid, verdict: "REQUEST_CHANGES", decisions: [{ source: "codex", category: "ops", description: "x", action: "dismiss" }] }, 23);
  assert.ok(adj.error); // submitAdjudication throws -> structured error
});

test("CS9: config consensus.maxRounds caps the step loop -> unresolved (engine owns the cap)", async () => {
  // Persistent dissent: peers never APPROVE, so the loop can only end by hitting the cap.
  const srv = buildServer({ providers: [reject("codex"), reject("grok")], getConfig: () => configCap(2) });
  let calls = 0;
  const drive = async (args) => { calls++; return step(srv, args, 40 + calls); };

  const init = await drive({ action: "init", prompt: "ship it", expert: "architect" });
  assert.equal(init.round, 1);
  const sid = init.sessionId;

  // Round 1: blind -> peers -> adjudicate (accept the issue, stays REQUEST_CHANGES) -> revise.
  await drive({ action: "record_blind", sessionId: sid, blindVerdict: "needs work" });
  const dp1 = await drive({ action: "dispatch_peers", sessionId: sid });
  assert.ok(dp1.opinions.every((o) => o.verdict === "REQUEST_CHANGES"));
  const adj1 = await drive({ action: "submit_adjudication", sessionId: sid, verdict: "REQUEST_CHANGES", decisions: [{ source: "codex", category: "ops", description: "needs work", action: "accept" }] });
  assert.equal(adj1.status, "await_revision");
  const rev1 = await drive({ action: "submit_revision", sessionId: sid, revisedPlan: "v2", diffSummary: "tried" });
  assert.equal(rev1.status, "await_blind");
  assert.equal(rev1.round, 2); // engine advanced the round from config maxRounds=2

  // Round 2 == cap: another revision must terminate as unresolved, not open round 3.
  await drive({ action: "record_blind", sessionId: sid, blindVerdict: "still not there" });
  await drive({ action: "dispatch_peers", sessionId: sid });
  await drive({ action: "submit_adjudication", sessionId: sid, verdict: "REQUEST_CHANGES", decisions: [{ source: "codex", category: "ops", description: "needs work", action: "accept" }] });
  const rev2 = await drive({ action: "submit_revision", sessionId: sid, revisedPlan: "v3", diffSummary: "tried again" });

  assert.equal(rev2.status, "unresolved");
  assert.equal(rev2.converged, false);
  assert.equal(calls, 9); // bounded: init + 2 rounds x 4 actions; the cap held (no round 3)
  // The unresolved report carries the host's LAST revision (v3), not the stale reviewed plan.
  assert.ok(typeof rev2.finalReport === "string" && rev2.finalReport.includes("v3"));
  assert.equal(rev2.confidence, "none");
});

test("CS10: HOST is the arbiter - a host REQUEST_CHANGES blocks convergence even when every peer APPROVES", async () => {
  // Regression for the consensus tool merge: consensus-step stays host-arbitrated.
  // Peers all APPROVE, but the host's adjudication verdict gates the round.
  const srv = buildServer({ providers: [approve("codex"), approve("grok")], getConfig: () => config });
  const sid = (await step(srv, { action: "init", prompt: "ship it" }, 50)).sessionId;
  await step(srv, { action: "record_blind", sessionId: sid, blindVerdict: "looks risky" }, 51);
  const dp = await step(srv, { action: "dispatch_peers", sessionId: sid }, 52);
  assert.ok(dp.opinions.every((o) => o.verdict === "APPROVE")); // peers approve
  const adj = await step(srv, { action: "submit_adjudication", sessionId: sid, verdict: "REQUEST_CHANGES", decisions: [] }, 53);
  assert.equal(adj.converged, undefined); // not converged - the host vote, not the peers, decides
  assert.equal(adj.status, "await_revision");
});

test("CS11: a converged terminal run persists ONE tool:consensus record with question=ORIGINAL prompt", async () => {
  // Dissent -> revise -> converge, so currentPlan ("REVISED...") != the original prompt.
  // The persisted `question` must be the ORIGINAL, not the final revision.
  const dir = tmpDir();
  const srv = buildServer({ providers: [revSensitive("codex"), revSensitive("grok")], getConfig: () => ({ ...config, sessions: { persist: true } }), sessionsDir: dir });
  const sid = (await step(srv, { action: "init", prompt: "ORIGINAL ship it", expert: "architect" }, 60)).sessionId;
  await step(srv, { action: "record_blind", sessionId: sid, blindVerdict: "needs work" }, 61);
  await step(srv, { action: "dispatch_peers", sessionId: sid }, 62);
  await step(srv, { action: "submit_adjudication", sessionId: sid, verdict: "REQUEST_CHANGES", decisions: [{ source: "codex", category: "scope", description: "thin", action: "accept" }] }, 63);
  await step(srv, { action: "submit_revision", sessionId: sid, revisedPlan: "REVISED detailed plan", diffSummary: "added detail" }, 64);
  await step(srv, { action: "record_blind", sessionId: sid, blindVerdict: "better" }, 65);
  await step(srv, { action: "dispatch_peers", sessionId: sid }, 66);
  const adj = await step(srv, { action: "submit_adjudication", sessionId: sid, verdict: "APPROVE", decisions: [] }, 67);

  assert.equal(adj.converged, true);
  assert.equal(adj.persisted, true);
  assert.ok(adj.sessionId, "durable record id returned on success");
  assert.notEqual(adj.sessionId, sid, "record id differs from the ephemeral loop sid");
  assert.equal(adj.loopSessionId, sid);

  const rec = sessions.readSession(adj.sessionId, { dir });
  assert.ok(rec, "record written to disk");
  assert.equal(rec.tool, "consensus");
  assert.equal(rec.question, "ORIGINAL ship it"); // NOT "REVISED detailed plan"
  assert.equal(rec.converged, true);
  assert.equal(rec.rounds, 2);
  assert.equal(rec.opinions.length, 2);
  assert.equal(sessions.listSessions({ dir }).length, 1, "exactly one record per loop");
});

test("CS12: persist OFF -> terminal returns persisted:false, no sessionId, writes nothing", async () => {
  const srv = buildServer({ providers: [approve("codex"), approve("grok")], getConfig: () => config }); // no sessionsDir
  const sid = (await step(srv, { action: "init", prompt: "ship it" }, 70)).sessionId;
  await step(srv, { action: "record_blind", sessionId: sid, blindVerdict: "ok APPROVE" }, 71);
  await step(srv, { action: "dispatch_peers", sessionId: sid }, 72);
  const adj = await step(srv, { action: "submit_adjudication", sessionId: sid, verdict: "APPROVE", decisions: [] }, 73);
  assert.equal(adj.converged, true);
  assert.equal(adj.persisted, false);
  assert.equal(adj.sessionId, undefined); // omitted on non-persist
  assert.equal(adj.loopSessionId, sid);   // still correlatable
});

test("CS13: an UNRESOLVED (cap) terminal run also persists ONE record with the ORIGINAL question", async () => {
  const dir = tmpDir();
  const srv = buildServer({ providers: [reject("codex"), reject("grok")], getConfig: () => ({ ...configCap(1), sessions: { persist: true } }), sessionsDir: dir });
  const sid = (await step(srv, { action: "init", prompt: "ORIGINAL never approves" }, 80)).sessionId;
  await step(srv, { action: "record_blind", sessionId: sid, blindVerdict: "nope" }, 81);
  await step(srv, { action: "dispatch_peers", sessionId: sid }, 82);
  await step(srv, { action: "submit_adjudication", sessionId: sid, verdict: "REQUEST_CHANGES", decisions: [{ source: "codex", category: "ops", description: "needs work", action: "accept" }] }, 83);
  const rev = await step(srv, { action: "submit_revision", sessionId: sid, revisedPlan: "still bad", diffSummary: "tried" }, 84);

  assert.equal(rev.status, "unresolved");
  assert.equal(rev.persisted, true);
  assert.ok(rev.sessionId);
  const rec = sessions.readSession(rev.sessionId, { dir });
  assert.equal(rec.tool, "consensus");
  assert.equal(rec.question, "ORIGINAL never approves");
  assert.equal(rec.converged, false);
  assert.equal(sessions.listSessions({ dir }).length, 1);
});

test("CS14: captureText ON -> consensus-step record stores the raw provider RESPONSE (opinion text)", async () => {
  const dir = tmpDir();
  const srv = buildServer({ providers: [approve("codex"), approve("grok")], getConfig: () => ({ ...config, sessions: { persist: true, captureText: true } }), sessionsDir: dir });
  const sid = (await step(srv, { action: "init", prompt: "ship it" }, 90)).sessionId;
  await step(srv, { action: "record_blind", sessionId: sid, blindVerdict: "ok APPROVE" }, 91);
  await step(srv, { action: "dispatch_peers", sessionId: sid }, 92);
  const adj = await step(srv, { action: "submit_adjudication", sessionId: sid, verdict: "APPROVE", decisions: [] }, 93);
  const rec = sessions.readSession(adj.sessionId, { dir });
  assert.ok(rec);
  assert.equal(rec.opinions.length, 2);
  assert.ok(rec.opinions.every((o) => typeof o.text === "string" && o.text.includes("APPROVE")), "raw response captured under captureText");
});

test("CS15: captureText OFF (default) -> consensus-step record OMITS opinion text, keeps verdict summary", async () => {
  const dir = tmpDir();
  const srv = buildServer({ providers: [approve("codex"), approve("grok")], getConfig: () => ({ ...config, sessions: { persist: true } }), sessionsDir: dir });
  const sid = (await step(srv, { action: "init", prompt: "ship it" }, 100)).sessionId;
  await step(srv, { action: "record_blind", sessionId: sid, blindVerdict: "ok" }, 101);
  await step(srv, { action: "dispatch_peers", sessionId: sid }, 102);
  const adj = await step(srv, { action: "submit_adjudication", sessionId: sid, verdict: "APPROVE", decisions: [] }, 103);
  const rec = sessions.readSession(adj.sessionId, { dir });
  assert.ok(rec);
  assert.ok(rec.opinions.every((o) => o.text === undefined), "no response body without captureText");
  assert.ok(rec.opinions.every((o) => o.verdict === "APPROVE"), "verdict summary still present");
});

test("CS16: captureText gates ask-all opinion text at the SAME shared chokepoint", async () => {
  const callAll = async (srv, id) => {
    const res = await srv.handle({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "ask-all", arguments: { prompt: "q" } } });
    return JSON.parse(res.result.content[0].text);
  };
  const dirOn = tmpDir();
  const on = buildServer({ providers: [approve("codex")], getConfig: () => ({ ...config, sessions: { persist: true, captureText: true } }), sessionsDir: dirOn });
  const recOn = sessions.readSession((await callAll(on, 110)).sessionId, { dir: dirOn });
  assert.ok(recOn);
  assert.ok(typeof recOn.opinions[0].text === "string", "captureText on -> ask-all response stored");

  const dirOff = tmpDir();
  const off = buildServer({ providers: [approve("codex")], getConfig: () => ({ ...config, sessions: { persist: true } }), sessionsDir: dirOff });
  const recOff = sessions.readSession((await callAll(off, 111)).sessionId, { dir: dirOff });
  assert.ok(recOff);
  assert.equal(recOff.opinions[0].text, undefined, "captureText off -> ask-all response omitted");
});

test("CS17: dispatch_peers wire response NEVER carries raw opinion text, even with captureText ON", async () => {
  // The raw response is retained on the in-memory loop result (so a terminal
  // persist can store it when captureText is on), but must NOT ride the wire.
  const srv = buildServer({ providers: [approve("codex"), approve("grok")], getConfig: () => ({ ...config, sessions: { persist: true, captureText: true } }) });
  const sid = (await step(srv, { action: "init", prompt: "x" }, 120)).sessionId;
  await step(srv, { action: "record_blind", sessionId: sid, blindVerdict: "ok" }, 121);
  const dp = await step(srv, { action: "dispatch_peers", sessionId: sid }, 122);
  assert.equal(dp.opinions.length, 2);
  assert.ok(dp.opinions.every((o) => !("text" in o)), "raw response text must not leak onto the wire response");
});
