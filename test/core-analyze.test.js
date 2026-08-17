// test/core-analyze.test.js
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  parseDebugLog,
  parseWindowMs,
  percentile,
  aggregateByModel,
  aggregateAgreement,
  detectOutliers,
  detectModelVariants,
  excludeReason,
  configLevers,
  recommend,
  buildAnalysis,
} = require("../core/analyze.js");

/** The RESOLVED config shape the server passes: openrouter.models is an ARRAY keyed by alias. */
function resolved(/** @type {any[]} */ models, /** @type {any} */ extra = {}) {
  return { openrouter: { models, ...extra } };
}

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
  assert.equal(stats[0].okCalls, 1, "the errored call is counted in calls but not in okCalls");
  const grok = stats[1];
  assert.equal(grok.meanTokens, 1500);
  assert.deepEqual(grok.reasoningEfforts, ["high"]);
  assert.equal(grok.ms.p50, 100);
});

test("A4b: errored calls never contribute latency; an all-error model reports null, not 0", () => {
  // A timeout is logged with its full `ms`. Counting it as latency reports the timeout
  // ceiling as model speed - and a 0ms p95 would make an all-error model the fastest peer.
  const stats = aggregateByModel([
    ev("slowish", "m", 400),
    ev("slowish", "m", 400),
    ev("slowish", "m", 600000, { isError: true, errorKind: "timeout" }),
    ev("dead", "m", 600000, { isError: true }),
    ev("dead", "m", 600000, { isError: true }),
  ]);
  const slowish = stats.find((s) => s.provider === "slowish");
  const dead = stats.find((s) => s.provider === "dead");
  assert.ok(slowish && dead);
  assert.equal(slowish.ms.p95, 400, "the 600s timeout is not a latency sample");
  assert.equal(slowish.calls, 3);
  assert.equal(slowish.okCalls, 2);
  assert.equal(dead.okCalls, 0);
  assert.equal(dead.ms.p95, null, "no successful call means no latency, not zero latency");

  // ...and the all-error model must not become the fastest-peer baseline.
  const outliers = detectOutliers(stats);
  assert.ok(outliers.some((o) => o.provider === "dead" && o.kind === "high-error"));
  assert.ok(!outliers.some((o) => o.provider === "slowish" && o.kind.startsWith("slow")), "400ms is not slow against a real baseline");
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
  // The RESOLVED shape the server actually passes: openrouter.models is an ARRAY keyed by
  // `alias`, and the on-disk camelCase `reasoningEffort` has become snake_case here.
  const config = { openrouter: { models: [{ alias: "foo", model: "vendor/foo", reasoning_effort: "high", askAll: true }] } };
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
  const recs = recommend(stats, agreement, { openrouter: { models: [{ alias: "foo", model: "vendor/foo", askAll: true }] } });
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
  const recs = recommend(stats, [], {
    openrouter: {
      maxFanout: 3,
      models: [{ alias: "a", model: "v/a", askAll: true }, { alias: "b", model: "v/b", askAll: true }],
    },
  });
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

test("A13: parseWindowMs accepts the files-admin grammar, rejects junk and overflow", () => {
  assert.deepEqual(parseWindowMs("30m"), { ok: true, ms: 1800000 });
  assert.deepEqual(parseWindowMs("24h"), { ok: true, ms: 86400000 });
  assert.deepEqual(parseWindowMs("7d"), { ok: true, ms: 604800000 });
  assert.deepEqual(parseWindowMs("90"), { ok: true, ms: 90000 }, "bare number is seconds");
  for (const bad of ["", "  ", "-1d", "7w", "abc", "1.5h", null, 7]) {
    const r = parseWindowMs(/** @type {any} */ (bad));
    assert.equal(r.ok, false, `expected ${JSON.stringify(bad)} to be rejected`);
  }
  // Out of range ERRORS rather than clamping: a silently clamped window would report a
  // period it never covered.
  assert.equal(parseWindowMs("99999d").ok, false);
});

test("A14: excludeReason keeps configured aliases and distinguishes why a row was dropped", () => {
  const levers = configLevers(resolved([{ alias: "keep", model: "v/keep", askAll: false }]));
  assert.equal(excludeReason("openrouter:keep", levers), null, "askAll:false is still CONFIGURED");
  assert.equal(excludeReason("openrouter:gone", levers), "not in config");
  assert.equal(excludeReason("codex", levers), null, "absent providers map means enabled");
  assert.equal(excludeReason("openrouter", levers), null, "a bare provider string is not an alias");

  const rejected = configLevers(resolved([], { invalidModels: [{ alias: "broken" }] }));
  assert.equal(excludeReason("openrouter:broken", rejected), "rejected by config validation");

  const disabled = configLevers({ openrouter: { enabled: false, models: [] } });
  assert.equal(excludeReason("openrouter:any", disabled), "openrouter provider disabled",
    "models[] is forced empty when the provider is off, so membership alone cannot tell these apart");

  const off = configLevers({ providers: { grok: { enabled: false } } });
  assert.equal(excludeReason("grok", off), "provider disabled");
  assert.equal(excludeReason("gemini", off), null);
});

test("A15: native rows survive a model change - the gemini pin is a router alias", () => {
  // The regression this whole filter nearly shipped with: providers.gemini.model defaults to
  // the router alias `auto-gemini-3`, but the log records the RESOLVED model. Matching the
  // logged model against the pin would hide every active Gemini row.
  const events = [
    ev("gemini", "gemini-3.6-flash-high", 100), ev("gemini", "gemini-3.6-flash-high", 100),
    ev("gemini", "auto-gemini-3", 100),
  ];
  const out = buildAnalysis(events, [], { providers: { gemini: { model: "auto-gemini-3" } } }, {});
  const providers = out.stats.map((s) => s.provider);
  assert.ok(providers.includes("gemini"));
  assert.deepEqual(out.meta.excluded, [], "no gemini row is excluded for running a different model id");
});

test("A16: the configured-model filter drops retired rows from stats AND recommendations", () => {
  const events = [
    ev("openrouter:live", "v/live", 100), ev("openrouter:live", "v/live", 100),
    ev("openrouter:retired", "v/retired", 900000), ev("openrouter:retired", "v/retired", 900000),
  ];
  const cfg = resolved([{ alias: "live", model: "v/live", askAll: true }]);
  const out = buildAnalysis(events, [], cfg, {});
  assert.deepEqual(out.stats.map((s) => s.provider), ["openrouter:live"]);
  assert.equal(out.meta.excluded.length, 1);
  assert.equal(out.meta.excluded[0].provider, "openrouter:retired");
  assert.equal(out.meta.excluded[0].reason, "not in config");
  assert.equal(out.meta.excluded[0].calls, 2);
  // The point of the whole change: a retired model is never recommended for cutting.
  assert.ok(!out.recommendations.some((r) => r.subject === "openrouter:retired"));
  assert.ok(!out.outliers.some((o) => o.provider === "openrouter:retired"));

  const unfiltered = buildAnalysis(events, [], cfg, { configuredOnly: false });
  assert.equal(unfiltered.stats.length, 2);
  assert.deepEqual(unfiltered.meta.excluded, []);
});

test("A17: a config error skips the filter instead of reporting everything unconfigured", () => {
  const events = [ev("openrouter:foo", "v/foo", 100), ev("openrouter:foo", "v/foo", 100)];
  const out = buildAnalysis(events, [], {}, { configError: "Unexpected token } in JSON at position 42" });
  assert.equal(out.stats.length, 1, "a syntax error must not read as 'none of your models are configured'");
  assert.deepEqual(out.meta.excluded, []);
  assert.match(out.meta.configError || "", /Unexpected token/);
});

test("A18: when the filter would empty the table, rows are shown but nothing is recommended", () => {
  const events = [
    ev("openrouter:gone", "v/gone", 900000), ev("openrouter:gone", "v/gone", 900000),
  ];
  const out = buildAnalysis(events, [], resolved([]), {});
  assert.equal(out.stats.length, 1, "rows are still shown for reference");
  assert.equal(out.meta.excluded.length, 1);
  assert.deepEqual(out.recommendations, [], "but an unconfigured model is never recommended");
  assert.deepEqual(out.outliers, []);
  assert.equal(out.meta.warnings.length, 1);
  assert.match(out.meta.warnings[0], /configuredOnly/);
});

test("A19: the window gates Lens A and reports real coverage across both lenses", () => {
  const now = 1_000_000_000;
  const events = [
    { ...ev("grok", "m", 100), at: now - 1000 },
    { ...ev("grok", "m", 100), at: now - 2000 },
    { ...ev("old", "m", 100), at: now - 999_000 },
    { ...ev("noAt", "m", 100), at: undefined },
  ];
  const recs = [
    // Carries an opinion, so it actually contributes to Lens B and may set coverage.
    { id: "a", schemaVersion: 1, tool: "consensus", createdAt: new Date(now - 3000).toISOString(), question: "q", verdict: "APPROVE",
      opinions: [{ provider: "grok", model: "m", verdict: "APPROVE" }] },
    // Opinion-less: contributes to neither lens, so it must NOT set coverage.
    { id: "b", schemaVersion: 1, tool: "ask-all", createdAt: new Date(now - 9000).toISOString(), question: "q", opinions: [] },
  ];
  const out = buildAnalysis(/** @type {any} */ (events), /** @type {any} */ (recs), {}, { windowMs: 10_000, nowMs: now, since: "10s" });
  const providers = out.stats.map((s) => s.provider);
  assert.ok(providers.includes("grok"));
  assert.ok(!providers.includes("old"), "out-of-window events are dropped");
  assert.ok(!providers.includes("noAt"), "an event with no usable `at` cannot be shown to be in-window");
  assert.equal(out.meta.eventsParsed, 2);
  assert.ok(out.meta.window);
  assert.equal(out.meta.window.since, "10s");
  // Coverage spans BOTH lenses, so the record (now-3000) is the earliest, not the event.
  assert.equal(out.meta.window.coverageFromMs, now - 3000);

  const noWindow = buildAnalysis(/** @type {any} */ (events), [], {}, {});
  assert.equal(noWindow.meta.window, null);
  assert.equal(noWindow.meta.eventsParsed, 4, "without a window, an event with no `at` is kept");
});

test("A20: meta counters stay UNFILTERED so doctor's read-path diagnostic still works", () => {
  // Two providers, one configured, so the empty-result fallback does NOT fire and the
  // filter is genuinely exercised.
  const events = [
    ev("openrouter:gone", "v/gone", 100), ev("openrouter:gone", "v/gone", 100),
    ev("openrouter:live", "v/live", 100), ev("openrouter:live", "v/live", 100),
  ];
  /** @type {any[]} */
  const recs = [{
    id: "a", schemaVersion: 1, tool: "consensus", createdAt: new Date().toISOString(), question: "q", verdict: "APPROVE",
    opinions: [
      { provider: "openrouter:gone", model: "v/gone", verdict: "APPROVE" },
      { provider: "openrouter:live", model: "v/live", verdict: "APPROVE" },
    ],
  }];
  const out = buildAnalysis(events, recs, resolved([{ alias: "live", model: "v/live" }]), {});
  assert.equal(out.meta.sessionsRead, 1);
  assert.equal(out.meta.agreementVotes, 2, "a filtered-away vote must not read as broken persistence");
  assert.equal(out.meta.insufficientData, false, "the filter hid rows; there WAS data");
  assert.deepEqual(out.agreement.map((a) => a.provider), ["openrouter:live"], "Lens B hides what Lens A hides");
});

test("A21: agreement joins on provider+model, not provider alone", () => {
  // grok ran two models. Keyed by provider alone, the fast model's agreement would be
  // attributed to the slow one's latency outlier.
  const stats = aggregateByModel([
    ev("openrouter:fast", "v/fast", 100), ev("openrouter:fast", "v/fast", 100),
    ev("grok", "grok-4.6", 9000), ev("grok", "grok-4.6", 9000),
  ]);
  /** @type {any[]} */
  const agreement = [
    { provider: "grok", model: "grok-4.5", votes: 5, agreed: 5, agreementRate: 1, abstained: 0 },
    { provider: "grok", model: "grok-4.6", votes: 5, agreed: 1, agreementRate: 0.2, abstained: 0 },
  ];
  const recs = recommend(stats, agreement, {});
  const grokRec = recs.find((r) => r.subject === "grok");
  assert.ok(grokRec);
  assert.ok(!/strongest cut candidate/.test(grokRec.rationale),
    "grok-4.6 dissents often; grok-4.5's agreement must not be borrowed for it");
});

test("A22: detectModelVariants flags a provider running several model ids, and only then", () => {
  const stats = aggregateByModel([
    ev("gemini", "gemini-3.6-flash-high", 10), ev("gemini", "gemini-3.7-flash-high", 10),
    ev("codex", "default", 10), ev("codex", "default", 10),
  ]);
  const variants = detectModelVariants(stats);
  assert.equal(variants.length, 1);
  assert.equal(variants[0].provider, "gemini");
  assert.deepEqual(variants[0].models, ["gemini-3.6-flash-high", "gemini-3.7-flash-high"]);
});

test("A23: compare links are OpenRouter-only, capped at 4, deduped, and skip custom apiBase", () => {
  const events = [
    ev("openrouter:slow", "vendor/slow", 900000), ev("openrouter:slow", "vendor/slow", 900000),
    ev("openrouter:a", "vendor/a", 100), ev("openrouter:a", "vendor/a", 100),
    ev("openrouter:b", "vendor/b", 120), ev("openrouter:b", "vendor/b", 120),
    ev("openrouter:priv", "vendor/priv", 130), ev("openrouter:priv", "vendor/priv", 130),
    ev("grok", "grok-4.6", 140), ev("grok", "grok-4.6", 140),
  ];
  const cfg = resolved([
    { alias: "slow", model: "vendor/slow" },
    { alias: "a", model: "vendor/a" },
    { alias: "b", model: "vendor/b" },
    { alias: "priv", model: "vendor/priv", apiBase: "https://internal.example/v1" },
  ]);
  const out = buildAnalysis(events, [], cfg, {});
  assert.ok(out.compare.length >= 1);
  const link = out.compare[0];
  assert.equal(link.group, "slow-outlier");
  assert.match(link.url, /^https:\/\/openrouter\.ai\/compare\//);
  assert.ok(link.url.includes("vendor/slow"));
  assert.ok(!link.url.includes("grok"), "native model ids are not catalog slugs");
  assert.ok(!link.url.includes("vendor/priv"), "a custom apiBase may not resolve on openrouter.ai");
  assert.ok(link.url.split("/compare/")[1].split("/").length <= 8, "at most 4 vendor/name slugs");
  assert.equal(new Set(out.compare.map((c) => c.url)).size, out.compare.length, "urls are deduped");
});

test("A24: a retired provider with sessions but no timing rows is still filtered from Lens B", () => {
  // The filter used to be decided from the stats rows alone, so a provider that appears
  // only in the session store leaked straight through into Lens B.
  const events = [ev("openrouter:live", "v/live", 100), ev("openrouter:live", "v/live", 100)];
  /** @type {any[]} */
  const recs = [{
    id: "a", schemaVersion: 1, tool: "consensus", createdAt: new Date().toISOString(), question: "q", verdict: "APPROVE",
    opinions: [
      { provider: "openrouter:live", model: "v/live", verdict: "APPROVE" },
      { provider: "openrouter:retired", model: "v/retired", verdict: "REJECT" },
    ],
  }];
  const out = buildAnalysis(events, recs, resolved([{ alias: "live", model: "v/live" }]), {});
  assert.deepEqual(out.agreement.map((a) => a.provider), ["openrouter:live"]);
  const retired = out.meta.excluded.find((e) => e.provider === "openrouter:retired");
  assert.ok(retired, "an agreement-only exclusion is still reported, not silently dropped");
  assert.equal(retired.calls, 0);
});

test("A25: window coverage ignores data that reached no lens, and rejects future timestamps", () => {
  const now = 2_000_000_000;
  /** @type {any[]} */
  const events = [
    // Parsed but never aggregated - must not set coverage.
    { event: "round", at: now - 9000, tool: "consensus", round: 1 },
    { event: "dispatch_start", at: now - 8000, tool: "ask-all", voices: 3 },
    { ...ev("grok", "m", 100), at: now - 1000 },
    { ...ev("grok", "m", 100), at: now - 1500 },
    // Future-dated (clock skew): inside [fromMs, now] only if the upper bound is missing.
    { ...ev("future", "m", 100), at: now + 60_000 },
  ];
  const out = buildAnalysis(events, [], {}, { windowMs: 10_000, nowMs: now, since: "10s" });
  assert.ok(out.meta.window);
  assert.equal(out.meta.window.coverageFromMs, now - 1500,
    "a round/dispatch_start event reaches no lens and cannot claim coverage");
  assert.ok(!out.stats.some((s) => s.provider === "future"), "a future-dated event is outside the window");
});

test("A26: an excluded provider cannot extend the reported coverage", () => {
  const now = 2_000_000_000;
  /** @type {any[]} */
  const events = [
    { ...ev("openrouter:gone", "v/gone", 100), at: now - 9000 },
    { ...ev("openrouter:gone", "v/gone", 100), at: now - 9500 },
    { ...ev("openrouter:live", "v/live", 100), at: now - 1000 },
    { ...ev("openrouter:live", "v/live", 100), at: now - 1200 },
  ];
  const out = buildAnalysis(events, [], resolved([{ alias: "live", model: "v/live" }]), { windowMs: 20_000, nowMs: now, since: "20s" });
  assert.ok(out.meta.window);
  assert.equal(out.meta.window.coverageFromMs, now - 1200,
    "the filtered-out rows are not in the report, so they cannot describe its coverage");
});
