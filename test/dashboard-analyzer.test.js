"use strict";
// server/dashboard/analyzer.js: pure aggregation over journal runs for the Analyzer tab.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const A = require("../server/dashboard/analyzer.js");
const { analyze, C } = A;

let seq = 0;
/** One consensus-step run: `rounds` is a list of per-round voice maps. */
function consensusRun(/** @type {any} */ opts) {
  const runId = `run-${++seq}`;
  /** @type {any[]} */
  const events = [{ kind: "run_start", runId, at: 1000, tool: "consensus-step", workflow: "consensus-step", providers: Object.keys(opts.rounds[0]), ...(opts.project ? { project: opts.project } : {}) }];
  opts.rounds.forEach((/** @type {any} */ voices, /** @type {number} */ i) => {
    const round = i + 1;
    for (const [provider, v] of Object.entries(voices)) {
      const callId = `${runId}-${provider}-${round}`;
      const vv = /** @type {any} */ (v);
      events.push({ kind: "call_start", runId, callId, provider, role: "peer", round, ceilingSource: vv.ceilingSource ?? "shared", grantedMs: 100000, promptChars: 1000, fileCount: 0 });
      events.push({ kind: "call_end", runId, callId, provider, model: `${provider}-m`, ms: vv.ms ?? 1000, isError: !!vv.error, errorKind: vv.error ?? undefined, cached: vv.cached ?? false });
    }
    events.push({ kind: "state", runId, state: "adjudicate", round, verdicts: Object.entries(voices).filter(([, v]) => !/** @type {any} */ (v).error).map(([provider, v]) => ({ provider, verdict: /** @type {any} */ (v).verdict ?? null, categories: /** @type {any} */ (v).cats ?? [] })) });
    if (opts.decisions) events.push({ kind: "arbiter", runId, action: "submit_adjudication", round, decisions: opts.decisions(round) });
  });
  events.push({ kind: "run_end", runId, status: "converged", rounds: opts.rounds.length });
  return { summary: { runId, status: "converged", project: opts.project ?? null, startedAt: 1000 }, events };
}

/** Repeat `n` identical rounds. */
const times = (/** @type {number} */ n, /** @type {any} */ voices) => Array.from({ length: n }, () => voices);

test("AN1: an echoing, slow model with arbiter decisions that never accept it is a drop candidate", () => {
  const rounds = times(12, {
    codex: { verdict: "REQUEST_CHANGES", cats: ["correctness", "ops"], ms: 1000 },
    gemini: { verdict: "REQUEST_CHANGES", cats: ["correctness"], ms: 1100 },
    echo: { verdict: "REQUEST_CHANGES", cats: ["correctness"], ms: 3000 },
  });
  const decisions = () => [{ source: "codex", category: "correctness", action: "accept" }, { source: "echo", category: "correctness", action: "dismiss" }];
  const out = analyze([consensusRun({ rounds, decisions })]);
  const echo = out.models.find((/** @type {any} */ m) => m.provider === "echo");
  assert.equal(echo.rounds, 12);
  assert.equal(echo.addsNothing, 1);
  assert.equal(echo.loneDissent, 0);
  assert.equal(echo.decisionRounds, 12);
  assert.equal(echo.acceptedRate, 0);
  assert.equal(echo.slow, true);
  assert.equal(echo.candidate, true);
  assert.equal(echo.configKey, "providers.echo.enabled");
  const codex = out.models.find((/** @type {any} */ m) => m.provider === "codex");
  assert.equal(codex.candidate, false, "codex adds `ops` and gets accepted");
});

test("AN2: without arbiter decisions the same model is only `unconfirmed`, never flagged", () => {
  const rounds = times(12, {
    codex: { verdict: "REQUEST_CHANGES", cats: ["correctness", "ops"] },
    echo: { verdict: "REQUEST_CHANGES", cats: ["correctness"], ms: 5000 },
    gemini: { verdict: "REQUEST_CHANGES", cats: ["correctness"] },
  });
  const echo = analyze([consensusRun({ rounds })]).models.find((/** @type {any} */ m) => m.provider === "echo");
  assert.equal(echo.decisionRounds, 0);
  assert.equal(echo.acceptedRate, null);
  assert.equal(echo.candidate, false);
  assert.equal(echo.unconfirmed, true);
});

test("AN3: unanimous clean APPROVE rounds and null verdicts are not counted", () => {
  const clean = times(20, { a: { verdict: "APPROVE" }, b: { verdict: "APPROVE" } });
  const withNull = times(5, { a: { verdict: "REQUEST_CHANGES", cats: ["scope"] }, b: { verdict: null } });
  const out = analyze([consensusRun({ rounds: clean }), consensusRun({ rounds: withNull })]);
  for (const m of out.models) assert.equal(m.rounds, 0, `${m.provider} counted rounds it should not`);
});

test("AN4: acceptedRate denominator is only rounds the model voted in; sources matching no voice are ignored", () => {
  const voted = times(10, { a: { verdict: "REQUEST_CHANGES", cats: ["ops"] }, b: { verdict: "REQUEST_CHANGES", cats: ["ops"] } });
  const absent = times(30, { a: { verdict: "REQUEST_CHANGES", cats: ["ops"] }, c: { verdict: "REQUEST_CHANGES", cats: ["ops"] } });
  const decisions = () => [{ source: "b", category: "ops", action: "accept" }, { source: "claude", category: "ops", action: "accept" }];
  const out = analyze([consensusRun({ rounds: voted, decisions }), consensusRun({ rounds: absent, decisions })]);
  const b = out.models.find((/** @type {any} */ m) => m.provider === "b");
  assert.equal(b.decisionRounds, 10);
  assert.equal(b.acceptedRate, 1);
  assert.ok(!out.models.some((/** @type {any} */ m) => m.provider === "claude"));
});

test("AN5: lone dissent and boundary constants decide candidacy", () => {
  const base = { a: { verdict: "REQUEST_CHANGES", cats: ["ops", "scope"] }, b: { verdict: "REQUEST_CHANGES", cats: ["ops"] }, x: { verdict: "REQUEST_CHANGES", cats: ["ops"], ms: 5000 } };
  const dissent = { a: { verdict: "REQUEST_CHANGES", cats: ["ops", "scope"] }, b: { verdict: "REQUEST_CHANGES", cats: ["ops"] }, x: { verdict: "REJECT", cats: ["ops"], ms: 5000 } };
  const decisions = () => [{ source: "a", category: "ops", action: "accept" }];
  // 2 dissent rounds of 20 = 0.10 -> still within LONE_DISSENT_MAX
  const at = analyze([consensusRun({ rounds: [...times(18, base), ...times(2, dissent)], decisions })]).models.find((/** @type {any} */ m) => m.provider === "x");
  assert.equal(at.loneDissent, 0.1);
  assert.equal(at.candidate, true);
  // 3 of 20 = 0.15 -> over the line
  const over = analyze([consensusRun({ rounds: [...times(17, base), ...times(3, dissent)], decisions })]).models.find((/** @type {any} */ m) => m.provider === "x");
  assert.equal(over.candidate, false);
  // MIN_ROUNDS: 9 rounds is too few
  const few = analyze([consensusRun({ rounds: times(C.MIN_ROUNDS - 1, base), decisions })]).models.find((/** @type {any} */ m) => m.provider === "x");
  assert.equal(few.candidate, false);
});

test("AN6: host-capped, outer, cached and history calls never count toward slow or error", () => {
  const capped = times(12, {
    a: { verdict: "REQUEST_CHANGES", cats: ["ops", "scope"] },
    b: { verdict: "REQUEST_CHANGES", cats: ["ops"] },
    x: { verdict: "REQUEST_CHANGES", cats: ["ops"], error: "timeout", ceilingSource: "host" },
  });
  const outer = times(12, {
    a: { verdict: "REQUEST_CHANGES", cats: ["ops", "scope"] },
    b: { verdict: "REQUEST_CHANGES", cats: ["ops"] },
    x: { verdict: "REQUEST_CHANGES", cats: ["ops"], error: "timeout", ceilingSource: "outer" },
  });
  const out = analyze([consensusRun({ rounds: capped }), consensusRun({ rounds: outer })]);
  const x = out.models.find((/** @type {any} */ m) => m.provider === "x");
  assert.ok(!x || (x.calls === 0 && x.errorRate === null), "no eligible calls, no voice: nothing to judge");
  assert.ok(out.models.every((/** @type {any} */ m) => !m.candidate));
});

/** A lone ask-one call with size and ceiling fields. */
function call(/** @type {any} */ o) {
  const runId = `call-${++seq}`;
  const callId = `${runId}-c`;
  return {
    summary: { runId, status: o.error ? "error" : "done", project: o.project ?? null, startedAt: o.at ?? 1000 },
    events: [
      { kind: "run_start", runId, at: o.at ?? 1000, tool: "ask-one", workflow: "single", providers: [o.provider ?? "grok"], ...(o.project ? { project: o.project } : {}) },
      { kind: "call_start", runId, at: o.at ?? 1000, callId, provider: o.provider ?? "grok", role: "single", promptChars: o.chars ?? 1000, fileCount: o.fileCount ?? 0, fileBytes: "fileBytes" in o ? o.fileBytes : 0,
        grantedMs: o.granted ?? 180000, configuredTimeoutMs: o.configured ?? 180000, hostCapMs: o.hostCap ?? null, ...(o.source === null ? {} : { ceilingSource: o.source ?? "own" }), ...(o.sharedBy ? { sharedBy: o.sharedBy, sharedLimitMs: o.sharedLimit } : {}) },
      { kind: "call_end", runId, callId, provider: o.provider ?? "grok", model: o.model ?? "grok-4", ms: o.ms ?? 1000, isError: !!o.error, errorKind: o.error, cached: o.cached ?? false },
      { kind: "run_end", runId, status: o.error ? "error" : "done" },
    ],
  };
}
const sizeRow = (/** @type {any} */ out, provider = "grok", split = "text") => out.size.find((/** @type {any} */ s) => s.provider === provider && s.split === split);

test("AN7: a bucket with timeouts is censored; the suggestion exceeds both the granted and the configured ceiling", () => {
  const runs = [
    ...Array.from({ length: 18 }, () => call({ chars: 40000, ms: 150000 })),
    ...Array.from({ length: 4 }, () => call({ chars: 40000, ms: 180000, error: "timeout", granted: 170000 })),
  ];
  const row = sizeRow(analyze(runs));
  const big = row.buckets.find((/** @type {any} */ b) => b.label === ">32k");
  assert.equal(big.n, 22);
  assert.ok(big.timeoutRate > 0.05);
  assert.equal(big.advice.kind, "censored");
  assert.equal(big.advice.suggestedMs, 270000, "1.5 x max(170000 granted, 180000 configured)");
  assert.equal(big.advice.configKey, "providers.grok.timeout");
});

test("AN8: near-ceiling successes with zero timeouts still give a defined suggestion", () => {
  const runs = Array.from({ length: 20 }, (_, i) => call({ chars: 2000, ms: i < 5 ? 170000 : 50000, granted: 180000 }));
  const small = sizeRow(analyze(runs)).buckets.find((/** @type {any} */ b) => b.label === "<8k");
  assert.equal(small.timeouts, 0);
  assert.equal(small.advice.kind, "censored");
  assert.equal(small.advice.suggestedMs, 270000);
});

test("AN9: the host cap limits the suggestion, and host-capped timeouts get their own line", () => {
  const runs = [
    ...Array.from({ length: 18 }, () => call({ chars: 40000, ms: 50000, granted: 55000, configured: 50000, hostCap: 60000 })),
    ...Array.from({ length: 4 }, () => call({ chars: 40000, ms: 55000, error: "timeout", granted: 55000, configured: 50000, hostCap: 60000 })),
    ...Array.from({ length: 3 }, () => call({ chars: 40000, ms: 55000, error: "timeout", granted: 55000, hostCap: 60000, source: "host" })),
  ];
  const out = analyze(runs);
  const big = sizeRow(out).buckets.find((/** @type {any} */ b) => b.label === ">32k");
  assert.equal(big.advice.kind, "host-limit");
  assert.equal(big.advice.hostCapMs, 60000);
  const host = out.hostTimeouts.find((/** @type {any} */ h) => h.provider === "grok");
  assert.equal(host.timeouts, 3);
  assert.equal(host.hostCapMs, 60000);
});

test("AN10: a shared fan-out timeout names the peer that set the shared ceiling", () => {
  const runs = [
    ...Array.from({ length: 18 }, () => call({ provider: "codex", chars: 40000, ms: 100000, granted: 600000, source: "shared", sharedBy: ["grok"], sharedLimit: 600000, configured: 180000 })),
    ...Array.from({ length: 4 }, () => call({ provider: "codex", chars: 40000, ms: 600000, error: "timeout", granted: 590000, source: "shared", sharedBy: ["grok"], sharedLimit: 600000, configured: 180000 })),
  ];
  const big = sizeRow(analyze(runs), "codex").buckets.find((/** @type {any} */ b) => b.label === ">32k");
  assert.equal(big.advice.kind, "censored");
  assert.equal(big.advice.suggestedMs, 900000);
  assert.deepEqual(big.advice.configKeys, ["providers.grok.timeout"]);
});

test("AN11: a clear size trend suggests p95 x 1.25; weak or small samples say no size effect", () => {
  const trend = Array.from({ length: 24 }, (_, i) => call({ chars: 1000 + i * 250, ms: 10000 + i * 1000 }));
  const out = analyze(trend);
  const row = sizeRow(out);
  assert.ok(row.fit.r > 0.9);
  assert.equal(row.fit.n, 24);
  const small = row.buckets.find((/** @type {any} */ b) => b.label === "<8k");
  assert.equal(small.advice.kind, "trend");
  assert.ok(small.advice.suggestedMs > 30000);
  const few = sizeRow(analyze(trend.slice(0, 10))).buckets.find((/** @type {any} */ b) => b.label === "<8k");
  assert.equal(few.advice.kind, "none");
});

test("AN12: file-bearing calls are split out; unknown fileBytes, cached calls and history are skipped from advice", () => {
  const runs = [
    call({ fileCount: 2, fileBytes: 10000, chars: 1000 }),
    call({ fileCount: 1, fileBytes: null }),
    call({ cached: true }),
    call({ source: null }),
  ];
  const out = analyze(runs);
  assert.equal(sizeRow(out, "grok", "files").buckets.find((/** @type {any} */ b) => b.label === "8-32k").n, 1);
  assert.equal(out.skipped.unknownFileBytes, 1);
  assert.equal(out.skipped.cached, 1);
  assert.equal(out.skipped.noCeiling, 1);
});

test("AN13: per-project table groups by id, unknown when no project, with latency and error kinds", () => {
  const p = { id: "aaaaaaaaaaaa", name: "app", root: "/x/app" };
  const runs = [call({ project: p, ms: 1000 }), call({ project: p, ms: 3000, error: "timeout" }), call({ ms: 500 })];
  const out = analyze(runs);
  const app = out.projects.find((/** @type {any} */ r) => r.id === p.id);
  assert.equal(app.name, "app");
  assert.equal(app.runs, 2);
  assert.equal(app.timeouts, 1);
  assert.deepEqual(app.topErrors, [{ kind: "timeout", n: 1 }]);
  const unknown = out.projects.find((/** @type {any} */ r) => r.id === "unknown");
  assert.equal(unknown.name, "(unknown)");
  assert.equal(unknown.runs, 1);
});

test("AN13b: a project row nests its workspaces with their own metrics", () => {
  const a = { id: "aaaaaaaaaaaa", name: "acme/svc", root: "/x/svc", ws: "111111111111" };
  const b = { ...a, root: "/tmp/rev", ws: "222222222222" };
  const out = analyze([call({ project: a, ms: 1000 }), call({ project: a, ms: 2000 }), call({ project: b, ms: 3000, error: "timeout" })]);
  const row = out.projects.find((/** @type {any} */ r) => r.id === a.id);
  assert.equal(row.runs, 3);
  assert.equal(row.timeouts, 1);
  assert.deepEqual(row.workspaces.map((/** @type {any} */ w) => [w.ws, w.root, w.runs, w.timeouts]), [[a.ws, a.root, 2, 0], [b.ws, b.root, 1, 1]]);
});

test("AN14: OpenRouter models use models.<alias> keys", () => {
  assert.equal(A.timeoutKey("openrouter:kimi"), "models.kimi.timeout");
  assert.equal(A.dropKey("openrouter:kimi"), "models.kimi.consensus");
  assert.equal(A.timeoutKey("codex"), "providers.codex.timeout");
});

test("AN15: never throws on junk input", () => {
  assert.doesNotThrow(() => analyze(/** @type {any} */ ([null, {}, { events: [null, 5, { kind: "call_end" }] }])));
});

test("AN16: a small bucket with many timeouts warns without a number", () => {
  const runs = [
    ...Array.from({ length: 5 }, () => call({ chars: 40000, ms: 100000 })),
    ...Array.from({ length: 5 }, () => call({ chars: 40000, ms: 180000, error: "timeout" })),
  ];
  const big = sizeRow(analyze(runs)).buckets.find((/** @type {any} */ b) => b.label === ">32k");
  assert.equal(big.advice.kind, "early-warning");
  assert.equal(big.advice.suggestedMs, undefined);
  assert.equal(big.advice.configKey, "providers.grok.timeout");
});

test("AN17: a yes-man that approves alone while others object is flagged, not protected as a dissenter", () => {
  const rounds = times(12, {
    a: { verdict: "REQUEST_CHANGES", cats: ["ops", "scope"] },
    b: { verdict: "REQUEST_CHANGES", cats: ["ops"] },
    yes: { verdict: "APPROVE", cats: [], ms: 5000 },
  });
  const decisions = () => [{ source: "a", category: "ops", action: "accept" }];
  const yes = analyze([consensusRun({ rounds, decisions })]).models.find((/** @type {any} */ m) => m.provider === "yes");
  assert.equal(yes.loneDissent, 0);
  assert.equal(yes.addsNothing, 1);
  assert.equal(yes.acceptedRate, 0, "zero issues filed = zero accepted, not unknown");
  assert.equal(yes.candidate, true);
});
