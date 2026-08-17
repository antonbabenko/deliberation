"use strict";
// The `analyze` MCP tool: read-only run analytics over the opt-in debug log +
// session store. Reads files, returns pre-aggregated JSON, writes nothing, and
// degrades gracefully when the log is missing or persistence is off.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const { buildServer } = require("../server/mcp/index.js");

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "delib-analyze-"));
}
/** @param {any} srv @param {any} args */
async function callAnalyze(srv, args) {
  const res = await srv.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "analyze", arguments: args || {} } });
  return JSON.parse(res.result.content[0].text);
}
/** @param {string} provider @param {string} model @param {number} ms @param {object} [extra] */
function line(provider, model, ms, extra = {}) {
  return JSON.stringify({ event: "provider_result", at: 1, tool: "ask-one", provider, model, ms, isError: false, reasoningEffort: null, ...extra });
}

test("M1: analyze is advertised in tools/list as read-only", async () => {
  const srv = buildServer({ providers: [], getConfig: () => ({}) });
  const res = await srv.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const tool = res.result.tools.find((/** @type {any} */ t) => t.name === "analyze");
  assert.ok(tool, "analyze tool present");
  assert.equal(tool.annotations.readOnlyHint, true);
});

test("M2: analyze aggregates a debug log pointed at by config.debug.path", async () => {
  const dir = tmpdir();
  const logPath = path.join(dir, "debug.jsonl");
  fs.writeFileSync(logPath, [
    line("grok", "grok-m", 100, { usage: { totalTokens: 500 } }),
    line("grok", "grok-m", 100, { usage: { totalTokens: 700 } }),
    line("openrouter:foo", "vendor/foo", 6000, { reasoningEffort: "high", usage: { totalTokens: 3000 } }),
    line("openrouter:foo", "vendor/foo", 6000, { reasoningEffort: "high", usage: { totalTokens: 3200 } }),
    "", "{ broken json",
  ].join("\n") + "\n");
  // getConfig() returns the RESOLVED config in production: openrouter.models is an ARRAY
  // keyed by `alias`, with snake_case reasoning_effort. Injecting the raw on-disk shape here
  // used to hide the fact that the engine read keys the server never produces.
  const config = {
    debug: { enabled: true, path: logPath },
    openrouter: { models: [{ alias: "foo", model: "vendor/foo", reasoning_effort: "high", askAll: true }] },
  };
  const srv = buildServer({ providers: [], getConfig: () => config });

  const out = await callAnalyze(srv, {});
  assert.equal(out.meta.insufficientData, false);
  assert.equal(out.meta.eventsParsed, 4, "two broken/blank lines dropped");
  // slowest first
  assert.equal(out.stats[0].provider, "openrouter:foo");
  assert.equal(out.stats[1].provider, "grok");
  // a slow OpenRouter model yields an advisory askAll suggestion (no writes)
  const askAll = out.recommendations.find((/** @type {any} */ r) => r.configKey === "models.foo.askAll");
  assert.ok(askAll, "suggests dropping the slow model from ask-all");
  // tool never wrote anything beyond the log we created
  assert.deepEqual(fs.readdirSync(dir), ["debug.jsonl"]);
});

test("M3: analyze degrades gracefully when the debug log is missing", async () => {
  const dir = tmpdir();
  const config = { debug: { enabled: true, path: path.join(dir, "nope.jsonl") } };
  const srv = buildServer({ providers: [], getConfig: () => config });
  const out = await callAnalyze(srv, {});
  assert.equal(out.meta.insufficientData, true);
  assert.equal(out.meta.eventsParsed, 0);
  assert.deepEqual(out.stats, []);
  assert.deepEqual(out.recommendations, []);
});

test("M4: analyze folds in the agreement lens when sessions persist", async () => {
  const dir = tmpdir();
  const logPath = path.join(dir, "debug.jsonl");
  fs.writeFileSync(logPath, [
    line("grok", "grok-m", 100), line("grok", "grok-m", 100),
    line("openrouter:foo", "vendor/foo", 6000), line("openrouter:foo", "vendor/foo", 6000),
  ].join("\n") + "\n");
  const sessionsDir = path.join(dir, "sessions");
  fs.mkdirSync(sessionsDir);
  const rec = {
    id: "11111111-1111-1111-1111-111111111111", schemaVersion: 1, tool: "consensus",
    createdAt: new Date(0).toISOString(), question: "q", verdict: "APPROVE",
    opinions: [
      { provider: "openrouter:foo", model: "vendor/foo", verdict: "APPROVE" },
      { provider: "grok", model: "grok-m", verdict: "REJECT" },
    ],
  };
  fs.writeFileSync(path.join(sessionsDir, rec.id + ".json"), JSON.stringify(rec));

  const config = {
    debug: { enabled: true, path: logPath },
    sessions: { persist: true },
    openrouter: { models: [{ alias: "foo", model: "vendor/foo", askAll: true }] },
  };
  const srv = buildServer({ providers: [], getConfig: () => config, sessionsDir });
  const out = await callAnalyze(srv, {});
  assert.equal(out.meta.sessionsPersist, true);
  assert.equal(out.meta.sessionsRead, 1);
  const fooAgree = out.agreement.find((/** @type {any} */ a) => a.provider === "openrouter:foo");
  assert.ok(fooAgree);
  assert.equal(fooAgree.agreementRate, 1, "foo matched the APPROVE verdict");
});

test("M5: analyze skips the agreement lens when persistence is off", async () => {
  const dir = tmpdir();
  const logPath = path.join(dir, "debug.jsonl");
  fs.writeFileSync(logPath, line("grok", "grok-m", 100) + "\n" + line("grok", "grok-m", 100) + "\n");
  const config = { debug: { enabled: true, path: logPath } }; // no sessions.persist, no sessionsDir
  const srv = buildServer({ providers: [], getConfig: () => config });
  const out = await callAnalyze(srv, {});
  assert.equal(out.meta.sessionsPersist, false);
  assert.equal(out.meta.sessionsRead, 0);
  assert.deepEqual(out.agreement, []);
});

test("M6: an invalid `since` is an error, never a silent all-time report", async () => {
  const dir = tmpdir();
  const logPath = path.join(dir, "debug.jsonl");
  fs.writeFileSync(logPath, [line("grok", "grok-m", 100), line("grok", "grok-m", 100)].join("\n") + "\n");
  const srv = buildServer({ providers: [], getConfig: () => ({ debug: { enabled: true, path: logPath } }) });

  for (const bad of ["7w", "abc", "-1d", "99999d"]) {
    const out = await callAnalyze(srv, { since: bad });
    assert.equal(out.error, "invalid-since", `expected ${bad} to be rejected`);
    assert.ok(out.detail, "the error names what was wrong");
    assert.equal(out.stats, undefined, "no analysis is returned alongside the error");
  }
  const ok = await callAnalyze(srv, { since: "24h" });
  assert.equal(ok.error, undefined);
});

test("M7: `since` filters the debug log and reports the applied window", async () => {
  const dir = tmpdir();
  const logPath = path.join(dir, "debug.jsonl");
  const now = Date.now();
  const at = (/** @type {number} */ ms) => ({ at: ms });
  fs.writeFileSync(logPath, [
    JSON.stringify({ event: "provider_result", tool: "ask-one", provider: "recent", model: "m", ms: 100, isError: false, ...at(now - 60_000) }),
    JSON.stringify({ event: "provider_result", tool: "ask-one", provider: "recent", model: "m", ms: 100, isError: false, ...at(now - 61_000) }),
    JSON.stringify({ event: "provider_result", tool: "ask-one", provider: "ancient", model: "m", ms: 100, isError: false, ...at(now - 40 * 86400_000) }),
  ].join("\n") + "\n");
  const srv = buildServer({ providers: [], getConfig: () => ({ debug: { enabled: true, path: logPath } }) });

  const all = await callAnalyze(srv, {});
  assert.equal(all.stats.length, 2);
  assert.equal(all.meta.window, null);

  const windowed = await callAnalyze(srv, { since: "24h" });
  assert.deepEqual(windowed.stats.map((/** @type {any} */ s) => s.provider), ["recent"]);
  assert.equal(windowed.meta.window.since, "24h");
  assert.equal(windowed.meta.truncated.log, false, "the whole log fitted, so coverage is the window");
  assert.ok(windowed.meta.window.coverageFromMs >= now - 62_000);
});

test("M8: configuredOnly hides unconfigured models by default and says why", async () => {
  const dir = tmpdir();
  const logPath = path.join(dir, "debug.jsonl");
  fs.writeFileSync(logPath, [
    line("openrouter:live", "vendor/live", 100), line("openrouter:live", "vendor/live", 100),
    line("openrouter:retired", "vendor/retired", 900000), line("openrouter:retired", "vendor/retired", 900000),
  ].join("\n") + "\n");
  const config = {
    debug: { enabled: true, path: logPath },
    openrouter: { models: [{ alias: "live", model: "vendor/live", askAll: true }] },
  };
  const srv = buildServer({ providers: [], getConfig: () => config });

  const out = await callAnalyze(srv, {});
  assert.deepEqual(out.stats.map((/** @type {any} */ s) => s.provider), ["openrouter:live"]);
  assert.equal(out.meta.excluded.length, 1);
  assert.equal(out.meta.excluded[0].reason, "not in config");
  assert.ok(!out.recommendations.some((/** @type {any} */ r) => r.subject === "openrouter:retired"),
    "the whole point: a retired model is never recommended for cutting");

  const everything = await callAnalyze(srv, { configuredOnly: false });
  assert.equal(everything.stats.length, 2);
  assert.deepEqual(everything.meta.excluded, []);
});

test("M9: meta.truncated is present on every response, window or not", async () => {
  const dir = tmpdir();
  const logPath = path.join(dir, "debug.jsonl");
  fs.writeFileSync(logPath, [line("grok", "grok-m", 100), line("grok", "grok-m", 100)].join("\n") + "\n");
  const srv = buildServer({ providers: [], getConfig: () => ({ debug: { enabled: true, path: logPath } }) });
  const out = await callAnalyze(srv, {});
  assert.deepEqual(out.meta.truncated, { log: false, sessions: false });

  // The default 1 MB tail truncates silently today; with a tiny limit the flag must fire.
  const clipped = await callAnalyze(srv, { limitBytes: 40 });
  assert.equal(clipped.meta.truncated.log, true);
});

test("M10: a future-dated session record is outside the window, like a future-dated event", async () => {
  // The record-side upper bound lives in runAnalyze, so it is unreachable from a core test.
  // Without it, clock skew or a hand-edited createdAt lands inside every window.
  const dir = tmpdir();
  const logPath = path.join(dir, "debug.jsonl");
  const now = Date.now();
  fs.writeFileSync(logPath, [
    JSON.stringify({ event: "provider_result", tool: "ask-one", provider: "grok", model: "m", ms: 100, isError: false, at: now - 1000 }),
    JSON.stringify({ event: "provider_result", tool: "ask-one", provider: "grok", model: "m", ms: 100, isError: false, at: now - 2000 }),
  ].join("\n") + "\n");
  const sessionsDir = path.join(dir, "sessions");
  fs.mkdirSync(sessionsDir);
  const mk = (/** @type {string} */ id, /** @type {number} */ createdMs) => {
    const rec = {
      id, schemaVersion: 1, tool: "consensus", createdAt: new Date(createdMs).toISOString(),
      question: "q", verdict: "APPROVE",
      opinions: [{ provider: "grok", model: "m", verdict: "APPROVE" }],
    };
    fs.writeFileSync(path.join(sessionsDir, id + ".json"), JSON.stringify(rec));
  };
  mk("11111111-1111-1111-1111-111111111111", now - 60_000);      // inside
  mk("22222222-2222-2222-2222-222222222222", now + 86_400_000);  // a day in the future

  const config = { debug: { enabled: true, path: logPath }, sessions: { persist: true } };
  const srv = buildServer({ providers: [], getConfig: () => config, sessionsDir });

  const windowed = await callAnalyze(srv, { since: "24h" });
  assert.equal(windowed.meta.sessionsRead, 1, "only the in-window record survives");

  const all = await callAnalyze(srv, {});
  assert.equal(all.meta.sessionsRead, 2, "without a window both records are read");
});
