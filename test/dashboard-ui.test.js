// test/dashboard-ui.test.js - the UI's pure event reducer and graph model, in node (no browser).
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const UI = path.join(__dirname, "..", "server", "dashboard", "ui");
/** @param {string} f */
const load = (f) => import(pathToFileURL(path.join(UI, f)).href);

const ev = (/** @type {number} */ seq, /** @type {Record<string, unknown>} */ fields) => ({ v: 1, runId: "fan-1", at: 1000 + seq * 100, seq, ...fields });

test("UI1: reduce folds a fan-out of 2 into status and node states", async () => {
  const { reduce } = await load("app.js");
  const { graphModel } = await load("graph.js");
  let runs = {};
  const apply = (/** @type {any} */ e) => { runs = reduce(runs, e); };

  apply(ev(0, { kind: "run_start", tool: "panel", workflow: "fanout", providers: ["codex", "grok"] }));
  apply(ev(1, { kind: "call_start", callId: "c1", provider: "codex", role: "single" }));
  apply(ev(2, { kind: "call_start", callId: "c2", provider: "grok", role: "single" }));
  /** @param {any} m @param {string} id */
  const node = (m, id) => m.nodes.find((/** @type {any} */ n) => n.id === id);

  let run = /** @type {any} */ (runs)["fan-1"];
  assert.equal(run.status, "running");
  let m = graphModel(run, { now: 1500 });
  assert.equal(node(m, "start").state, "succeeded");
  assert.equal(node(m, "codex").state, "running");
  assert.equal(node(m, "grok").state, "running");
  assert.equal(node(m, "join").state, "pending");

  const before = runs;
  apply(ev(3, { kind: "call_end", callId: "c1", provider: "codex", model: "gpt-5", ms: 200, usage: { totalTokens: 50 }, isError: false }));
  assert.notEqual(runs, before, "reduce returns a new object");
  assert.equal(/** @type {any} */ (before)["fan-1"].calls.c1.endAt, null, "the previous state is not mutated");
  apply(ev(4, { kind: "call_end", callId: "c2", provider: "grok", model: "grok-4", ms: 300, isError: true, errorKind: "timeout" }));
  run = /** @type {any} */ (runs)["fan-1"];
  assert.equal(run.status, "done", "a fan-out with a call_end per provider is done without run_end");
  assert.equal(run.tokens, 50);
  assert.equal(run.errors, 1);
  m = graphModel(run, { now: 2000 });
  assert.equal(node(m, "codex").state, "succeeded");
  assert.equal(node(m, "grok").state, "timeout");
  assert.equal(node(m, "join").state, "succeeded");

  // A replayed event (SSE resume overlapping a fetched detail) changes nothing.
  const same = reduce(runs, ev(3, { kind: "call_end", callId: "c1", provider: "codex", ms: 999 }));
  assert.equal(same, runs);

  // run_end is authoritative when present.
  apply(ev(5, { kind: "run_end", status: "error", rounds: 0 }));
  assert.equal(/** @type {any} */ (runs)["fan-1"].status, "error");
});

test("UI1b: consensus-step phases derive from state, call and arbiter events", async () => {
  const { reduce } = await load("app.js");
  const { graphModel } = await load("graph.js");
  const e = (/** @type {number} */ seq, /** @type {Record<string, unknown>} */ f) => ({ v: 1, runId: "cs-1", at: 1000 + seq * 100, seq, ...f });
  const events = [
    e(0, { kind: "run_start", tool: "consensus-step", workflow: "consensus-step", providers: ["codex", "grok"] }),
    e(1, { kind: "state", state: "init", round: 1 }),
    e(2, { kind: "state", state: "blind", round: 1 }),
    e(3, { kind: "arbiter", action: "record_blind", round: 1, verdict: "APPROVE" }),
    e(4, { kind: "state", state: "peers", round: 1 }),
    e(5, { kind: "call_start", callId: "p1", provider: "codex", role: "peer", round: 1 }),
  ];
  let runs = events.reduce((acc, x) => reduce(acc, x), {});
  let m = graphModel(/** @type {any} */ (runs)["cs-1"], { now: 1700 });
  const st = (/** @type {string} */ id) => m.nodes.find((/** @type {any} */ n) => n.id === id).state;
  assert.equal(st("init"), "succeeded");
  assert.equal(st("peers"), "running");
  assert.equal(st("converged"), "pending");
  const host = m.channels.find((/** @type {any} */ c) => c.id === "host");
  assert.ok(host, "consensus-step draws the host arbiter as its own channel");
  assert.equal(host.segments[0].decode, "APPROVE");

  runs = [
    e(6, { kind: "call_end", callId: "p1", provider: "codex", ms: 500, isError: false }),
    e(7, { kind: "state", state: "adjudicate", round: 1, verdicts: [{ provider: "codex", verdict: "APPROVE", categories: [] }] }),
    e(8, { kind: "arbiter", action: "submit_adjudication", round: 1, verdict: "APPROVE" }),
    e(9, { kind: "state", state: "converged", round: 1 }),
    e(10, { kind: "run_end", status: "converged", rounds: 1 }),
  ].reduce((acc, x) => reduce(acc, x), runs);
  m = graphModel(/** @type {any} */ (runs)["cs-1"], { now: 3000 });
  assert.equal(st("peers"), "succeeded");
  assert.equal(st("adjudicate"), "succeeded");
  assert.equal(st("converged"), "succeeded");
  assert.equal(st("revise"), "pending");
  const codex = m.channels.find((/** @type {any} */ c) => c.id === "codex");
  assert.equal(codex.segments[0].decode, "APPROVE", "the adjudicate verdicts decode under the peer channel");
});

test("UI3: compactRuns drops unlisted runs and returns idle ones to summary only", async () => {
  const { reduce, compactRuns } = await load("app.js");
  const e = (/** @type {string} */ id, /** @type {number} */ seq, /** @type {Record<string, unknown>} */ f) => ({ v: 1, runId: id, at: 1000 + seq, seq, ...f });
  let runs = {};
  for (const id of ["done-1", "live-1", "gone-1", "shown-1"]) {
    runs = reduce(runs, e(id, 0, { kind: "run_start", tool: "ask-gpt", workflow: "single", providers: ["codex"] }));
    runs = reduce(runs, e(id, 1, { kind: "call_start", callId: "c", provider: "codex", role: "single" }));
    if (id !== "live-1") runs = reduce(runs, e(id, 2, { kind: "run_end", status: "done" }));
  }
  const index = ["done-1", "live-1", "shown-1"].map((runId) => ({ runId }));
  const out = /** @type {any} */ (compactRuns(runs, index, new Set(["shown-1"])));
  assert.deepEqual(Object.keys(out).sort(), ["done-1", "live-1", "shown-1"], "a run the index no longer lists is dropped");
  assert.equal(out["done-1"].loaded, false);
  assert.deepEqual([out["done-1"].events, out["done-1"].calls, out["done-1"].arbiter], [[], {}, []]);
  assert.equal(out["done-1"].status, "done", "the summary survives the reset");
  assert.equal(out["live-1"], /** @type {any} */ (runs)["live-1"], "a running run keeps its events");
  assert.equal(out["shown-1"], /** @type {any} */ (runs)["shown-1"], "an on-screen run keeps its events");
  // A reset run can be refolded from its journal: seq starts over.
  const again = reduce(out, e("done-1", 0, { kind: "run_start", tool: "ask-gpt", workflow: "single", providers: ["codex"] }));
  assert.equal(/** @type {any} */ (again)["done-1"].events.length, 1);
  assert.ok(compactRuns(runs, [], new Set())["done-1"] === undefined);
});

test("UI4: coincident triggers merge into one cluster with the worst state", async () => {
  const { reduce } = await load("app.js");
  const { graphModel, clusterTriggers } = await load("graph.js");
  const e = (/** @type {number} */ seq, /** @type {number} */ at, /** @type {Record<string, unknown>} */ f) => ({ v: 1, runId: "cl", at, seq, ...f });
  const runs = [
    e(0, 0, { kind: "run_start", tool: "consensus-step", workflow: "consensus-step", providers: ["codex"] }),
    e(1, 0, { kind: "state", state: "init", round: 1 }),
    e(2, 18000, { kind: "state", state: "blind", round: 1 }),
    e(3, 18400, { kind: "state", state: "peers", round: 1 }),
    e(4, 18400, { kind: "call_start", callId: "p", provider: "codex", role: "peer", round: 1 }),
  ].reduce((acc, x) => reduce(acc, x), {});
  const m = graphModel(/** @type {any} */ (runs).cl, { now: 60000 });
  const tx = (/** @type {number} */ t) => ((t - m.t0) / (m.t1 - m.t0)) * 1000;
  const points = m.nodes.filter((n) => n.at !== null).sort((a, b) => a.at - b.at).map((n) => ({ x: tx(n.at), node: n }));
  const clusters = clusterTriggers(points);
  assert.equal(clusters.length, 2, "init stands alone; blind and peers, 400 ms apart, share one marker");
  assert.deepEqual(clusters[1].nodes.map((n) => n.id), ["blind", "peers"]);
  assert.equal(clusters[1].label, "blind, peers");
  assert.equal(clusters[1].state, "running", "the cluster shows its worst member");
  const many = clusterTriggers(["start", "codex", "gemini", "grok"].map((id, i) => ({ x: i, node: { id, label: id, state: i === 2 ? "failed" : "succeeded" } })));
  assert.equal(many.length, 1);
  assert.equal(many[0].label, "start +3");
  assert.equal(many[0].state, "failed");
});
