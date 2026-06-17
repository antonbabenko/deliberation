// test/core-analyze.test.js
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  parseDebugLog,
  percentile,
  aggregateByModel,
  aggregateAgreement,
  detectOutliers,
  recommend,
  buildAnalysis,
} = require("../core/analyze.js");

/**
 * @param {string} provider @param {string} model @param {number} ms
 * @param {object} [extra]
 * @returns {any}
 */
function ev(provider, model, ms, extra = {}) {
  return { event: "provider_result", at: 1, tool: "ask-one", provider, model, ms, isError: false, reasoningEffort: null, ...extra };
}

test("A1: parseDebugLog skips blank + malformed lines and keeps valid events", () => {
  const text = [
    JSON.stringify(ev("grok", "grok-m", 10)),
    "",
    "{not json",
    JSON.stringify({ noEventKey: true }),
    "   ",
    JSON.stringify(ev("codex", "default", 20)),
  ].join("\n");
  const events = parseDebugLog(text);
  assert.equal(events.length, 2);
  assert.equal(events[0].provider, "grok");
  assert.equal(events[1].provider, "codex");
});

test("A2: parseDebugLog tolerates empty/non-string input", () => {
  assert.deepEqual(parseDebugLog(""), []);
  assert.deepEqual(parseDebugLog(/** @type {any} */ (null)), []);
});

test("A3: percentile interpolates and handles edge sizes", () => {
  assert.equal(percentile([], 95), 0);
  assert.equal(percentile([42], 95), 42);
  assert.equal(percentile([0, 10], 50), 5);
  assert.equal(percentile([0, 100], 95), 95);
});

test("A4: aggregateByModel computes latency, error rate, tokens, efforts; sorts slow-first", () => {
  const events = [
    ev("grok", "grok-m", 100, { reasoningEffort: "high", usage: { totalTokens: 1000 } }),
    ev("grok", "grok-m", 100, { reasoningEffort: "high", usage: { totalTokens: 2000 } }),
    ev("codex", "default", 5000),
    ev("codex", "default", 5000, { isError: true, errorKind: "timeout" }),
  ];
  const stats = aggregateByModel(events);
  // codex p95 (5000) > grok p95 (100) -> codex first
  assert.equal(stats[0].provider, "codex");
  assert.equal(stats[0].calls, 2);
  assert.equal(stats[0].errors, 1);
  assert.equal(stats[0].errorRate, 0.5);
  assert.equal(stats[0].meanTokens, null, "CLI provider has no token usage");
  assert.deepEqual(stats[0].reasoningEfforts, ["n/a"]);
  const grok = stats[1];
  assert.equal(grok.meanTokens, 1500);
  assert.deepEqual(grok.reasoningEfforts, ["high"]);
  assert.equal(grok.ms.p50, 100);
});

test("A5: aggregateAgreement counts votes only when both final + opinion verdicts exist", () => {
  /** @type {any[]} */
  const records = [
    { tool: "consensus", verdict: "APPROVE", opinions: [
      { provider: "grok", model: "grok-m", verdict: "APPROVE" },
      { provider: "codex", model: "default", verdict: "REJECT" },
    ] },
    { tool: "consensus", verdict: "APPROVE", opinions: [
      { provider: "grok", model: "grok-m", verdict: "APPROVE" },
      { provider: "codex", model: "default", verdict: "APPROVE" },
    ] },
    // ask-all record: no final verdict -> only abstentions
    { tool: "ask-all", opinions: [{ provider: "grok", model: "grok-m" }] },
  ];
  const agree = aggregateAgreement(records);
  const grok = agree.find((a) => a.provider === "grok");
  const codex = agree.find((a) => a.provider === "codex");
  assert.ok(grok && codex);
  assert.equal(grok.votes, 2);
  assert.equal(grok.agreed, 2);
  assert.equal(grok.agreementRate, 1);
  assert.equal(grok.abstained, 1, "the ask-all opinion is an abstention");
  assert.equal(codex.votes, 2);
  assert.equal(codex.agreed, 1);
  assert.equal(codex.agreementRate, 0.5);
  // least-agreeing first
  assert.equal(agree[0].provider, "codex");
});

test("A6: detectOutliers flags slow-relative, slow-absolute, high-error; gates on MIN_CALLS", () => {
  const stats = aggregateByModel([
    ev("a", "m", 100), ev("a", "m", 100),
    ev("b", "m", 100), ev("b", "m", 100),
    ev("slow", "m", 1000), ev("slow", "m", 1000), // 10x median -> slow-relative
    ev("once", "m", 99999), // 1 call only -> gated out
    ev("err", "m", 100, { isError: true }), ev("err", "m", 100, { isError: true }), // high-error
  ]);
  const outliers = detectOutliers(stats);
  const kinds = new Map(outliers.map((o) => [o.provider, o.kind]));
  assert.equal(kinds.get("slow"), "slow-relative");
  assert.equal(kinds.get("err"), "high-error");
  assert.ok(!kinds.has("once"), "single-call models are not flagged");
});

test("A7: recommend suggests askAll=false + reasoning for a slow OpenRouter model, advisory only", () => {
  const stats = aggregateByModel([
    ev("grok", "grok-m", 100), ev("grok", "grok-m", 100),
    ev("openrouter:foo", "vendor/foo", 5000), ev("openrouter:foo", "vendor/foo", 5000),
  ]);
  const config = { models: { foo: { provider: "openrouter", reasoningEffort: "high", askAll: true } } };
  const recs = recommend(stats, [], config);
  const keys = recs.map((r) => r.configKey);
  assert.ok(keys.includes("models.foo.askAll"));
  assert.ok(keys.includes("models.foo.reasoningEffort"));
  for (const r of recs) assert.equal(r.target === "deliberation" || r.target === "external", true);
});

test("A8: recommend routes Codex reasoning to external advice (outside deliberation config)", () => {
  const stats = aggregateByModel([
    ev("grok", "grok-m", 100), ev("grok", "grok-m", 100),
    ev("codex", "default", 9000), ev("codex", "default", 9000),
  ]);
  const recs = recommend(stats, [], {});
  const codexRec = recs.find((r) => r.subject === "codex");
  assert.ok(codexRec);
  assert.equal(codexRec.target, "external");
  assert.equal(codexRec.configKey, null);
  assert.match(codexRec.action, /config\.toml|reasoning/i);
});

test("A9: high agreement on a slow model adds the strongest-cut-candidate note", () => {
  const stats = aggregateByModel([
    ev("grok", "grok-m", 100), ev("grok", "grok-m", 100),
    ev("openrouter:foo", "vendor/foo", 5000), ev("openrouter:foo", "vendor/foo", 5000),
  ]);
  /** @type {any[]} */
  const agreement = [{ provider: "openrouter:foo", model: "vendor/foo", votes: 4, agreed: 4, agreementRate: 1, abstained: 0 }];
  const recs = recommend(stats, agreement, { models: { foo: { provider: "openrouter", askAll: true } } });
  const askAllRec = recs.find((r) => r.configKey === "models.foo.askAll");
  assert.ok(askAllRec);
  assert.match(askAllRec.rationale, /strongest cut candidate/);
});

test("A10: recommend suggests lowering maxFanout when 2+ OpenRouter models are slow", () => {
  const stats = aggregateByModel([
    ev("grok", "grok-m", 100), ev("grok", "grok-m", 100),
    ev("openrouter:a", "v/a", 5000), ev("openrouter:a", "v/a", 5000),
    ev("openrouter:b", "v/b", 5000), ev("openrouter:b", "v/b", 5000),
  ]);
  const recs = recommend(stats, [], { routing: { maxFanout: 3 }, models: {} });
  const fanout = recs.find((r) => r.configKey === "routing.maxFanout");
  assert.ok(fanout);
  assert.match(fanout.action, /maxFanout/);
});

test("A11: buildAnalysis reports meta + insufficientData when no events", () => {
  const empty = buildAnalysis([], [], {}, { debugEnabled: false, sessionsPersist: false });
  assert.equal(empty.meta.insufficientData, true);
  assert.equal(empty.meta.eventsParsed, 0);
  assert.deepEqual(empty.stats, []);

  const withData = buildAnalysis([ev("grok", "grok-m", 10), ev("grok", "grok-m", 10)], [], {}, { debugEnabled: true, sessionsPersist: false, logPath: "/tmp/x.jsonl" });
  assert.equal(withData.meta.insufficientData, false);
  assert.equal(withData.meta.eventsParsed, 2);
  assert.equal(withData.meta.logPath, "/tmp/x.jsonl");
});

test("A12: meta surfaces sessionsDir + agreementVotes for the doctor/empty-Lens-B diagnostic", () => {
  // sessionsDir echoes the caller-resolved server path; defaults to null when absent.
  const a = buildAnalysis([], [], {}, { sessionsDir: "/cache/deliberation/sessions" });
  assert.equal(a.meta.sessionsDir, "/cache/deliberation/sessions");
  assert.equal(buildAnalysis([], [], {}, {}).meta.sessionsDir, null);

  // records with a final verdict AND a matching per-opinion verdict -> votes > 0.
  const recVoted = /** @type {any} */ ({ verdict: "APPROVE", opinions: [{ provider: "codex", model: "default", verdict: "APPROVE" }] });
  assert.ok(buildAnalysis([], [recVoted], {}, {}).meta.agreementVotes > 0);

  // records present but no per-opinion verdict (ask-all shape) -> read>0 but votes==0
  // (this is the case that explains an empty Lens B without it being a read-path bug).
  const recAbstain = /** @type {any} */ ({ verdict: null, opinions: [{ provider: "codex", model: "default", text: "hi" }] });
  const ab = buildAnalysis([], [recAbstain], {}, {});
  assert.equal(ab.meta.sessionsRead, 1);
  assert.equal(ab.meta.agreementVotes, 0);
});
