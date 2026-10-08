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
  const { reduce, applySummary } = await load("app.js");
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
  assert.equal(run.status, "running", "a fan-out's status without run_end comes from the server summary, not a UI rule");
  runs = applySummary(runs, { runId: "fan-1", status: "done", endedAt: 1400, providers: ["codex", "grok"] });
  run = /** @type {any} */ (runs)["fan-1"];
  assert.equal(run.status, "done");
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

  // A run SSE created before the index poll lists it is live: kept whole, whatever the view.
  const fresh = reduce({}, e("new-1", 0, { kind: "run_start", tool: "panel", workflow: "fanout", providers: ["codex"] }));
  const kept = /** @type {any} */ (compactRuns(fresh, [], new Set()));
  assert.equal(kept["new-1"], /** @type {any} */ (fresh)["new-1"], "an unlisted running run survives unchanged");
  assert.equal(kept["new-1"].events.length, 1);
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

test("UI5: trigger layout merges a cluster whose label has no free row; labels never overlap", async () => {
  const { layoutTriggers } = await load("graph.js");
  const node = (/** @type {string} */ id) => ({ id, label: id, state: "succeeded" });
  const out = layoutTriggers([{ x: 0, node: node("adjudicate") }, { x: 25, node: node("converged") }, { x: 50, node: node("revise") }], { x1: 1000, charW: 6.7 });
  assert.equal(out.length, 2);
  assert.deepEqual(out[1].nodes.map((n) => n.id), ["converged", "revise"]);
  for (const row of [0, 1]) {
    const inRow = out.filter((c) => c.row === row).sort((a, b) => a.lx - b.lx);
    for (let i = 1; i < inRow.length; i++) assert.ok(inRow[i].lx >= inRow[i - 1].lx + inRow[i - 1].w, "labels in one row do not overlap");
  }
  // Markers closer than 18 px share one, whatever their timestamps.
  assert.equal(layoutTriggers([{ x: 100, node: node("start") }, { x: 114, node: node("openrouter:deepseek") }], { x1: 1000 }).length, 1);
});

test("UI6: gutter text, decodes and run ids are shortened without going blank or cutting a word", async () => {
  const { wrap2, ellipsize, clip, splitId, shortDecode } = await load("graph.js");
  const { midId } = await load("dom.js");
  assert.deepEqual(wrap2("arbiter (host)", 12), ["arbiter", "(host)"]);
  assert.deepEqual(wrap2("openrouter:deepseek", 12), ["openrouter:", "deepseek"]);
  assert.equal(ellipsize("gemini-3.1-pro high", 12), "gemini...");
  assert.equal(shortDecode("RATE-LIMIT"), "RL");
  assert.equal(shortDecode("SOMETHING"), "SOM");
  const a = "3f2a91c4-0000-4000-8000-00009e0b1d77";
  const b = "3f2a91c4-0000-4000-8000-00001c2d3e44";
  assert.notEqual(midId(a, 20), midId(b, 20), "two ids with a shared head stay distinct");
  assert.ok(midId(a, 20).endsWith("9e0b1d77") && midId(a, 20).length === 20);
  assert.equal(midId("cs-synth-live", 20), "cs-synth-live");
  // Cuts land on code points: an astral character is never split into a lone surrogate.
  const astral = "\u{1F600}".repeat(10) + "-run-" + "\u{1F680}".repeat(10);
  for (const t of [midId(astral, 12), clip(astral, 8), ellipsize(astral, 8), ...wrap2(astral, 8)]) {
    assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(t), `no lone surrogate in ${JSON.stringify(t)}`);
  }
  assert.equal(midId(astral, 12), "\u{1F600}".repeat(4) + "..." + "\u{1F680}".repeat(5));
  assert.deepEqual(splitId("gemini-3.1-pro-low", 12), ["gemini-3.1-", "pro-low"], "a long model id splits after a hyphen and keeps its tail");
  assert.deepEqual(splitId("Claude, in session", 12), ["Claude, in", "session"]);
  assert.equal(clip("gemini-3.1-pro-low", 12), "gemini-3....", "the model id is cut hard, not at a hyphen");
});

test("UI7: undispatched providers draw as skipped branches; a late join reopens the run", async () => {
  const { reduce, applySummary } = await load("app.js");
  const { graphModel } = await load("graph.js");
  let runs = [
    ev(0, { kind: "run_start", tool: "ask-all", workflow: "fanout", providers: ["codex", "grok"] }),
    ev(1, { kind: "call_start", callId: "c1", provider: "codex", role: "single" }),
    ev(2, { kind: "call_end", callId: "c1", provider: "codex", ms: 100, isError: false }),
  ].reduce((acc, e) => reduce(acc, e), {});
  runs = applySummary(runs, { runId: "fan-1", status: "done", endedAt: 1200, providers: ["codex", "grok"], undispatched: ["grok"] });
  let run = /** @type {any} */ (runs)["fan-1"];
  assert.equal(run.status, "done");
  let m = graphModel(run, { now: 5000 });
  const node = (/** @type {string} */ id) => m.nodes.find((/** @type {any} */ n) => n.id === id);
  assert.equal(node("codex").state, "succeeded");
  assert.equal(node("grok").state, "skipped", "never dispatched is not a failure");
  assert.equal(node("join").state, "succeeded");
  assert.ok(m.channels.find((/** @type {any} */ c) => c.id === "grok").flags.includes("SKIPPED"));

  // A late ask-one joins: the run is live again, locally and when the server re-derives it.
  runs = reduce(runs, ev(3, { kind: "call_start", callId: "c2", provider: "grok", role: "single" }));
  assert.equal(/** @type {any} */ (runs)["fan-1"].status, "running");
  runs = applySummary(applySummary(runs, { runId: "fan-1", status: "done", undispatched: ["grok"] }), { runId: "fan-1", status: "running" });
  run = /** @type {any} */ (runs)["fan-1"];
  assert.equal(run.status, "running", "a terminal status the server re-derives as running is accepted");
  m = graphModel(run, { now: 5000 });
  assert.equal(node("grok").state, "running");

  // A run_end seen live is final: a stale summary cannot roll it back.
  runs = reduce(runs, ev(4, { kind: "run_end", status: "done" }));
  runs = applySummary(runs, { runId: "fan-1", status: "running" });
  assert.equal(/** @type {any} */ (runs)["fan-1"].status, "done");
});

test("UI8: a gap in a loaded run's seq marks it unloaded so it is fetched again", async () => {
  const { reduce } = await load("app.js");
  let runs = [
    ev(0, { kind: "run_start", tool: "ask-gpt", workflow: "single", providers: ["codex"] }),
    ev(1, { kind: "call_start", callId: "c1", provider: "codex" }),
  ].reduce((acc, e) => reduce(acc, e), {});
  assert.equal(/** @type {any} */ (runs)["fan-1"].loaded, true);
  runs = reduce(runs, ev(2, { kind: "state", state: "x" }));
  assert.equal(/** @type {any} */ (runs)["fan-1"].loaded, true, "contiguous seq keeps the run loaded");
  runs = reduce(runs, ev(5, { kind: "call_end", callId: "c1", provider: "codex", isError: false }));
  const run = /** @type {any} */ (runs)["fan-1"];
  assert.equal(run.loaded, false, "seq 3 and 4 were missed (a resumed stream for another run)");
  assert.equal(run.seq, 5);
});

test("UI9: errors count a call's final attempt only", async () => {
  const { reduce } = await load("app.js");
  const fold = (/** @type {any[]} */ list) => /** @type {any} */ (list.reduce((acc, e) => reduce(acc, e), {}))["fan-1"];
  const start = ev(0, { kind: "run_start", tool: "consensus", workflow: "consensus", providers: ["x"] });
  const retried = fold([start,
    ev(1, { kind: "call_start", callId: "x-1", provider: "x", role: "peer", round: 1 }),
    ev(2, { kind: "call_end", callId: "x-1", provider: "x", isError: true, errorKind: "network" }),
    ev(3, { kind: "call_start", callId: "x-2", provider: "x", role: "peer", round: 1 }),
    ev(4, { kind: "call_end", callId: "x-2", provider: "x", isError: false })]);
  assert.equal(retried.errors, 0);
  const concurrent = fold([start,
    ev(1, { kind: "call_start", callId: "x-1", provider: "x", role: "arbiter", round: 1 }),
    ev(2, { kind: "call_start", callId: "x-2", provider: "x", role: "arbiter", round: 1 }),
    ev(3, { kind: "call_end", callId: "x-1", provider: "x", isError: true }),
    ev(4, { kind: "call_end", callId: "x-2", provider: "x", isError: false })]);
  assert.equal(concurrent.errors, 1, "an overlapping leg is not a retry");
});

test("UI10: a reconnect marks loaded non-terminal runs unloaded and names the on-screen ones", async () => {
  const { reduce, staleAfterReconnect } = await load("app.js");
  const e = (/** @type {string} */ id, /** @type {number} */ seq, /** @type {Record<string, unknown>} */ f) => ({ v: 1, runId: id, at: 1000 + seq, seq, ...f });
  let runs = {};
  for (const id of ["live-1", "shown-1", "done-1"]) {
    runs = reduce(runs, e(id, 0, { kind: "run_start", tool: "consensus", workflow: "consensus", providers: ["codex"] }));
    runs = reduce(runs, e(id, 1, { kind: "call_start", callId: "c", provider: "codex", role: "peer", round: 1 }));
  }
  runs = reduce(runs, e("done-1", 2, { kind: "run_end", status: "converged" }));
  runs = reduce(runs, e("cold-1", 0, { kind: "run_start", tool: "consensus", workflow: "consensus", providers: ["codex"] }));
  runs = { ...runs, "cold-1": { ...(/** @type {any} */ (runs))["cold-1"], loaded: false } };

  const out = staleAfterReconnect(runs, ["shown-1", "done-1", "cold-1"]);
  const r = /** @type {any} */ (out.runs);
  assert.equal(r["live-1"].loaded, false, "an off-screen running run is marked, fetched lazily");
  assert.equal(r["shown-1"].loaded, false);
  assert.equal(r["done-1"].loaded, true, "a terminal run cannot have missed anything");
  assert.deepEqual(out.refetch, ["shown-1"], "only on-screen runs that were loaded and live are refetched now");
  assert.equal(/** @type {any} */ (runs)["live-1"].loaded, true, "the input map is not mutated");
  // Once refetched (loaded again) the same reconnect does not mark it again: the caller
  // runs this once per open, and an unloaded run is skipped, so a second pass is a no-op.
  assert.deepEqual(staleAfterReconnect(out.runs, ["shown-1"]).refetch, []);
});

test("UI11: an index summary that differs from or is ahead of a loaded run marks it unloaded", async () => {
  const { reduce, staleFromIndex } = await load("app.js");
  const e = (/** @type {string} */ id, /** @type {number} */ seq, /** @type {Record<string, unknown>} */ f) => ({ v: 1, runId: id, at: 1000 + seq, seq, ...f });
  let runs = {};
  for (const id of ["a", "b", "c", "d"]) {
    runs = reduce(runs, e(id, 0, { kind: "run_start", tool: "consensus", workflow: "consensus", providers: ["codex"] }));
    runs = reduce(runs, e(id, 1, { kind: "state", state: "peers", round: 1 }));
  }
  runs = reduce(runs, e("d", 2, { kind: "run_end", status: "converged" }));
  const same = { status: "running", endedAt: null, rounds: 1 };
  const list = [
    { runId: "a", ...same },
    { runId: "b", status: "converged", endedAt: 5000, rounds: 1 },
    { runId: "c", status: "running", endedAt: null, rounds: 2 },
    { runId: "d", status: "abandoned", endedAt: null, rounds: 1 },
    { runId: "unknown", status: "done" },
  ];
  const out = staleFromIndex(runs, list, ["b", "a"]);
  const r = /** @type {any} */ (out.runs);
  assert.equal(r.a.loaded, true, "matching status and nothing ahead: untouched");
  assert.equal(r.b.loaded, false, "the status differs (its run_end was missed)");
  assert.equal(r.c.loaded, false, "the summary is ahead by a round");
  assert.equal(r.d.loaded, true, "a run that saw its own run_end is final");
  assert.deepEqual(out.refetch, ["b"], "only the on-screen stale run is refetched now");
  assert.equal(staleFromIndex(out.runs, list, ["b"]).refetch.length, 0, "an unloaded run is not flagged again");
});

test("UI12: a detail fetch that started before a reconnect is discarded and refetched", async () => {
  const { createLoader } = await load("app.js");
  /** @type {Record<string, any>} */
  const runs = { r1: { loaded: false } };
  /** @type {Array<(body: any) => void>} */
  const pending = [];
  const applied = [];
  const loader = createLoader({
    fetchRun: () => new Promise((res) => pending.push(res)),
    get: (id) => runs[id],
    apply: (id, body) => { applied.push(body); runs[id] = { loaded: true }; },
    fail: () => assert.fail("no fetch fails"),
    settled: () => {},
    shown: () => true,
  });
  const first = loader.ensure("r1");
  assert.equal(pending.length, 1);
  assert.equal(loader.ensure("r1"), first, "before a reconnect the in-flight fetch is shared");
  loader.reconnected();
  const second = loader.ensure("r1");
  assert.equal(pending.length, 2, "after a reconnect a new fetch starts, not the stale promise");
  assert.notEqual(second, first);
  pending[0]({ snap: "before-reconnect" });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(applied, [], "the stale result is discarded");
  assert.equal(runs.r1.loaded, false, "and does not mark the run loaded");
  assert.equal(pending.length, 2, "the fresh fetch already running is not duplicated");
  pending[1]({ snap: "after-reconnect" });
  await Promise.all([first, second]);
  assert.deepEqual(applied, [{ snap: "after-reconnect" }]);
  assert.equal(runs.r1.loaded, true);

  // A stale fetch that resolves with nothing newer running starts exactly one fresh fetch.
  runs.r2 = { loaded: false };
  const stale = loader.ensure("r2");
  loader.reconnected();
  pending[2]({ snap: "stale" });
  await new Promise((r) => setImmediate(r));
  assert.equal(pending.length, 4, "one refetch for the run still on screen");
  pending[3]({ snap: "fresh" });
  await stale;
  assert.deepEqual(applied.slice(1), [{ snap: "fresh" }], "only the fresh snapshot lands; no loop");
});
test("UI13: deriveDebateTrajectory tracks round-by-round votes, dissents, and convergence", async () => {
  const { deriveDebateTrajectory } = await load("telemetry.js");
  const { reduce } = await load("app.js");

  const e = (/** @type {number} */ seq, /** @type {Record<string, unknown>} */ f) => ({ v: 1, runId: "c-1", at: 1000 + seq * 100, seq, ...f });
  const events = [
    e(0, { kind: "run_start", tool: "consensus", workflow: "consensus", providers: ["codex", "grok"] }),
    // Round 1: codex APPROVE, grok REQUEST_CHANGES -> revision
    e(1, { kind: "call_start", callId: "c1", provider: "codex", model: "gpt-5", role: "peer", round: 1 }),
    e(2, { kind: "call_start", callId: "c2", provider: "grok", model: "grok-4", role: "peer", round: 1 }),
    e(3, { kind: "call_end", callId: "c1", provider: "codex", model: "gpt-5", ms: 1200, verdict: "APPROVE", isError: false }),
    e(4, { kind: "call_end", callId: "c2", provider: "grok", model: "grok-4", ms: 2400, verdict: "REQUEST_CHANGES", criticalIssues: [{ category: "security", description: "token leak" }], isError: false }),
    e(5, { kind: "arbiter", action: "submit_revision", round: 1, text: "revised plan" }),
    // Round 2: both APPROVE -> converged
    e(6, { kind: "call_start", callId: "c3", provider: "codex", model: "gpt-5", role: "peer", round: 2 }),
    e(7, { kind: "call_start", callId: "c4", provider: "grok", model: "grok-4", role: "peer", round: 2 }),
    e(8, { kind: "call_end", callId: "c3", provider: "codex", model: "gpt-5", ms: 1100, verdict: "APPROVE", isError: false }),
    e(9, { kind: "call_end", callId: "c4", provider: "grok", model: "grok-4", ms: 1500, verdict: "APPROVE", isError: false }),
    e(10, { kind: "arbiter", action: "submit_adjudication", round: 2, verdict: "APPROVE" }),
    e(11, { kind: "run_end", status: "converged", rounds: 2 }),
  ];

  const runs = events.reduce((acc, x) => reduce(acc, x), {});
  const traj = deriveDebateTrajectory(/** @type {any} */ (runs)["c-1"]);

  assert.equal(traj.length, 2);
  assert.equal(traj[0].round, 1);
  assert.equal(traj[0].converged, false);
  assert.equal(traj[0].peers.length, 2);
  assert.equal(traj[0].peers[0].verdict, "APPROVE");
  assert.equal(traj[0].peers[1].verdict, "REQUEST_CHANGES");
  assert.equal(traj[0].peers[1].issuesCount, 1);
  assert.equal(traj[0].arbiter.hasRevision, true);
  assert.ok(traj[0].summary.includes("Dissent: grok"));

  assert.equal(traj[1].round, 2);
  assert.equal(traj[1].converged, true);
  assert.equal(traj[1].agreedCount, 2);
  assert.equal(traj[1].arbiter.verdict, "APPROVE");
  assert.ok(traj[1].summary.includes("Consensus reached"));
});

test("UI14: deriveProviderLatency aggregates call count, durations, and bottlenecks accurately", async () => {
  const { deriveProviderLatency } = await load("telemetry.js");
  const { reduce } = await load("app.js");

  const e = (/** @type {number} */ seq, /** @type {Record<string, unknown>} */ f) => ({ v: 1, runId: "fan-lats", at: 1000 + seq * 100, seq, ...f });
  const events = [
    e(0, { kind: "run_start", tool: "panel", workflow: "fanout", providers: ["codex", "gemini", "grok"] }),
    e(1, { kind: "call_start", callId: "c1", provider: "codex", model: "gpt-5" }),
    e(2, { kind: "call_start", callId: "c2", provider: "gemini", model: "gemini-2.5-pro" }),
    e(3, { kind: "call_start", callId: "c3", provider: "grok", model: "grok-4" }),
    e(4, { kind: "call_end", callId: "c1", provider: "codex", model: "gpt-5", ms: 1000, isError: false }),
    e(5, { kind: "call_end", callId: "c2", provider: "gemini", model: "gemini-2.5-pro", ms: 500, isError: false }),
    e(6, { kind: "call_end", callId: "c3", provider: "grok", model: "grok-4", ms: 3000, isError: false }),
    e(7, { kind: "run_end", status: "done" }),
  ];

  const runs = events.reduce((acc, x) => reduce(acc, x), {});
  const lats = deriveProviderLatency(/** @type {any} */ (runs)["fan-lats"]);

  assert.equal(lats.length, 3);
  // Sorted slowest first
  assert.equal(lats[0].provider, "grok");
  assert.equal(lats[0].totalMs, 3000);
  assert.equal(lats[0].share, 1.0);

  assert.equal(lats[1].provider, "codex");
  assert.equal(lats[1].totalMs, 1000);
  assert.ok(Math.abs(lats[1].share - 1/3) < 0.01);

  assert.equal(lats[2].provider, "gemini");
  assert.equal(lats[2].totalMs, 500);
  assert.ok(Math.abs(lats[2].share - 1/6) < 0.01);
});

test("UI15: deriveDebateTrajectory handles non-consensus runs, retried peer calls, and state category fallbacks", async () => {
  const { deriveDebateTrajectory } = await load("telemetry.js");
  const { reduce } = await load("app.js");

  // 1. Non-consensus workflow returns []
  assert.deepEqual(deriveDebateTrajectory(null), []);
  assert.deepEqual(deriveDebateTrajectory(/** @type {any} */ ({ workflow: "fanout" })), []);

  // 2. Retried peer calls in consensus: failed call superseded by retried call does not duplicate
  const e = (/** @type {number} */ seq, /** @type {Record<string, unknown>} */ f) => ({ v: 1, runId: "c-retry", at: 1000 + seq * 100, seq, ...f });
  const events = [
    e(0, { kind: "run_start", tool: "consensus", workflow: "consensus", providers: ["gemini"] }),
    // Call 1 fails (transient network error)
    e(1, { kind: "call_start", callId: "c1", provider: "gemini", role: "peer", round: 1 }),
    e(2, { kind: "call_end", callId: "c1", provider: "gemini", ms: 200, isError: true, errorKind: "network" }),
    // Call 2 retried and succeeds
    e(3, { kind: "call_start", callId: "c2", provider: "gemini", role: "peer", round: 1 }),
    e(4, { kind: "call_end", callId: "c2", provider: "gemini", ms: 800, verdict: "APPROVE", isError: false }),
    // State event with categories
    e(5, { kind: "state", state: "converged", round: 1, verdicts: [{ provider: "gemini", verdict: "APPROVE", categories: ["correctness"] }] }),
    e(6, { kind: "run_end", status: "converged", rounds: 1 }),
  ];

  const runs = events.reduce((acc, x) => reduce(acc, x), {});
  const traj = deriveDebateTrajectory(/** @type {any} */ (runs)["c-retry"]);

  assert.equal(traj.length, 1);
  assert.equal(traj[0].peers.length, 1, "failed attempt was retried and superseded; only 1 peer entry");
  assert.equal(traj[0].peers[0].provider, "gemini");
  assert.equal(traj[0].peers[0].verdict, "APPROVE");
  assert.equal(traj[0].peers[0].issuesCount, 1, "extracts categories from state verdict");
  assert.equal(traj[0].converged, true);
  assert.equal(traj[0].agreedCount, 1);
});

test("UI16: deriveProviderLatency handles multi-round calls, in-flight calls (ms null), and error counts", async () => {
  const { deriveProviderLatency } = await load("telemetry.js");
  const { reduce } = await load("app.js");

  const e = (/** @type {number} */ seq, /** @type {Record<string, unknown>} */ f) => ({ v: 1, runId: "lat-multi", at: 1000 + seq * 100, seq, ...f });
  const events = [
    e(0, { kind: "run_start", tool: "consensus", workflow: "consensus", providers: ["codex", "gemini"] }),
    // Codex: 2 completed calls (1000ms, 2000ms)
    e(1, { kind: "call_start", callId: "c1", provider: "codex", model: "gpt-5", round: 1 }),
    e(2, { kind: "call_end", callId: "c1", provider: "codex", model: "gpt-5", ms: 1000, isError: false }),
    e(3, { kind: "call_start", callId: "c2", provider: "codex", model: "gpt-5", round: 2 }),
    e(4, { kind: "call_end", callId: "c2", provider: "codex", model: "gpt-5", ms: 2000, isError: false }),
    // Gemini: 1 error call (500ms) + 1 in-flight call (started, no call_end)
    e(5, { kind: "call_start", callId: "g1", provider: "gemini", model: "gemini-2.5-pro", round: 1 }),
    e(6, { kind: "call_end", callId: "g1", provider: "gemini", model: "gemini-2.5-pro", ms: 500, isError: true }),
    e(7, { kind: "call_start", callId: "g2", provider: "gemini", model: "gemini-2.5-pro", round: 2 }),
  ];

  const runs = events.reduce((acc, x) => reduce(acc, x), {});
  const lats = deriveProviderLatency(/** @type {any} */ (runs)["lat-multi"]);

  assert.equal(lats.length, 2);
  const codex = lats.find((l) => l.provider === "codex");
  assert.ok(codex);
  assert.equal(codex.calls, 2);
  assert.equal(codex.totalMs, 3000);
  assert.equal(codex.meanMs, 1500);
  assert.equal(codex.maxMs, 2000);
  assert.equal(codex.errors, 0);

  const gemini = lats.find((l) => l.provider === "gemini");
  assert.ok(gemini);
  assert.equal(gemini.calls, 2, "includes the in-flight call in calls count");
  assert.equal(gemini.totalMs, 500, "only completed calls contribute to durations");
  assert.equal(gemini.errors, 1);
});

test("UI-PRJ: the run_start project survives reduce, applySummary and summaryOf; junk shapes are dropped", async () => {
  const { reduce, applySummary, summaryOf } = await load("app.js");
  const project = { id: "aaaaaaaaaaaa", name: "app", root: "~/app" };
  let runs = reduce({}, ev(0, { kind: "run_start", tool: "ask-one", workflow: "single", providers: ["grok"], project }));
  assert.deepEqual(summaryOf(runs["fan-1"]).project, project);
  const fromSummary = applySummary({}, { runId: "s-1", status: "done", startedAt: 1, providers: [], project });
  assert.deepEqual(fromSummary["s-1"].project, project);
  const junk = reduce({}, ev(0, { kind: "run_start", tool: "ask-one", project: "/raw/path" }));
  assert.equal(summaryOf(junk["fan-1"]).project, null);
});

test("UI-PRJ2: project options are a repo -> workspace tree; a stored bare id still selects its repo", async () => {
  const { projectOptions, projectFilter, selectionOf } = await load("views/runs.js");
  const runs = [
    { project: { id: "aaaaaaaaaaaa", name: "acme/svc", root: "~/svc", ws: "111111111111" } },
    { project: { id: "aaaaaaaaaaaa", name: "acme/svc", root: "/tmp/rev", ws: "222222222222" } },
    { project: { id: "bbbbbbbbbbbb", name: "acme/api", root: "~/api", ws: "333333333333" } },
    { project: null },
  ];
  assert.deepEqual(projectOptions(runs, "").map((o) => [o.id, o.label, o.depth]), [
    ["p:bbbbbbbbbbbb", "acme/api (~/api)", 0],
    ["p:aaaaaaaaaaaa", "acme/svc (2 workspaces)", 0],
    ["w:222222222222", "/tmp/rev", 1],
    ["w:111111111111", "~/svc", 1],
    ["p:unknown", "(unknown)", 0],
  ]);
  assert.equal(selectionOf("aaaaaaaaaaaa"), "p:aaaaaaaaaaaa");
  assert.deepEqual(projectFilter("aaaaaaaaaaaa"), { project: "aaaaaaaaaaaa", ws: "" });
  assert.deepEqual(projectFilter("w:222222222222"), { project: "", ws: "222222222222" });
  assert.ok(projectOptions(runs, "w:999999999999").some((o) => o.id === "w:999999999999"), "the selection stays listed");
});
