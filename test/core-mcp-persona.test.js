"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildServer, toolList } = require("../server/mcp/index.js");
const { PROMPTS } = require("../core/prompts/index.js");

/** @typedef {import("../core/types.js").Provider} Provider */

/**
 * Capturing fake provider: records the developerInstructions it received so we
 * can assert what the server injected.
 * @param {string} name
 * @param {{di:(string|undefined)[]}} sink
 * @returns {Provider}
 */
function capturingProvider(name, sink) {
  return {
    name,
    capabilities: { canImplement: false, fileUpload: false, multiTurn: false },
    async health() { return { ok: true }; },
    async ask(req) {
      sink.di.push(req.developerInstructions);
      return { provider: name, model: "m", text: `${name}:${req.prompt}`, isError: false, ms: 1 };
    },
  };
}

const config = { providers: {}, openrouter: { maxFanout: 3, models: [] } };

test("PJ1: direct expert tool injects that expert persona (expert in tool NAME)", async () => {
  const sink = { di: /** @type {(string|undefined)[]} */ ([]) };
  const srv = buildServer({ providers: [capturingProvider("codex", sink)], getConfig: () => config });
  await srv.handle({ jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "architect", arguments: { prompt: "design X" } } });
  assert.equal(sink.di[0], PROMPTS["architect"]);
});

test("PJ2: ask-all with expert injects persona on every fanned-out provider", async () => {
  const sink = { di: /** @type {(string|undefined)[]} */ ([]) };
  const srv = buildServer({ providers: [capturingProvider("codex", sink), capturingProvider("grok", sink)], getConfig: () => config });
  await srv.handle({ jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "ask-all", arguments: { prompt: "x", expert: "security-analyst" } } });
  assert.equal(sink.di.length, 2);
  for (const di of sink.di) assert.equal(di, PROMPTS["security-analyst"]);
});

test("PJ3: consensus with expert injects the expert persona on PEERS and the arbiter persona on the arbiter pass", async () => {
  // Two built-ins. server-mode arbiter is auto-selected; peers would shrink to 1,
  // so floor-of-2 keeps the arbiter in the panel: 2 peer opinions + 1 arbiter pass.
  const sink = { di: /** @type {(string|undefined)[]} */ ([]) };
  const srv = buildServer({ providers: [capturingProvider("codex", sink), capturingProvider("grok", sink)], getConfig: () => config });
  await srv.handle({ jsonrpc: "2.0", id: 3, method: "tools/call",
    params: { name: "consensus", arguments: { prompt: "x", expert: "debugger" } } });
  // 2 peer opinions carry the debugger persona; the trailing arbiter pass carries the arbiter persona.
  assert.equal(sink.di.length, 3);
  assert.equal(sink.di[0], PROMPTS["debugger"]);
  assert.equal(sink.di[1], PROMPTS["debugger"]);
  assert.equal(sink.di[2], PROMPTS["arbiter"]);
});

test("PJ4: ask-gpt with expert injects persona", async () => {
  const sink = { di: /** @type {(string|undefined)[]} */ ([]) };
  const srv = buildServer({ providers: [capturingProvider("codex", sink)], getConfig: () => config });
  await srv.handle({ jsonrpc: "2.0", id: 4, method: "tools/call",
    params: { name: "ask-gpt", arguments: { prompt: "x", expert: "researcher" } } });
  assert.equal(sink.di[0], PROMPTS["researcher"]);
});

test("PJ5: caller-supplied developerInstructions always wins (Claude Code path unchanged)", async () => {
  const sink = { di: /** @type {(string|undefined)[]} */ ([]) };
  const srv = buildServer({ providers: [capturingProvider("codex", sink)], getConfig: () => config });
  await srv.handle({ jsonrpc: "2.0", id: 5, method: "tools/call",
    params: { name: "architect", arguments: { prompt: "x", developerInstructions: "MY OWN PROMPT" } } });
  assert.equal(sink.di[0], "MY OWN PROMPT");
});

test("PJ6: ask-gpt with NO expert leaves developerInstructions undefined (no persona)", async () => {
  const sink = { di: /** @type {(string|undefined)[]} */ ([]) };
  const srv = buildServer({ providers: [capturingProvider("codex", sink)], getConfig: () => config });
  await srv.handle({ jsonrpc: "2.0", id: 6, method: "tools/call",
    params: { name: "ask-gpt", arguments: { prompt: "x" } } });
  assert.equal(sink.di[0], undefined);
});

test("PJ9: named expert tool wins over args.expert; arg honored only on non-named tools", async () => {
  // Named tool "architect" with a conflicting args.expert -> tool name wins.
  const sink1 = { di: /** @type {(string|undefined)[]} */ ([]) };
  const srv1 = buildServer({ providers: [capturingProvider("codex", sink1)], getConfig: () => config });
  await srv1.handle({ jsonrpc: "2.0", id: 91, method: "tools/call",
    params: { name: "architect", arguments: { prompt: "x", expert: "researcher" } } });
  assert.equal(sink1.di[0], PROMPTS["architect"]);

  // Non-named tool "ask-gpt" honors args.expert.
  const sink2 = { di: /** @type {(string|undefined)[]} */ ([]) };
  const srv2 = buildServer({ providers: [capturingProvider("codex", sink2)], getConfig: () => config });
  await srv2.handle({ jsonrpc: "2.0", id: 92, method: "tools/call",
    params: { name: "ask-gpt", arguments: { prompt: "x", expert: "architect" } } });
  assert.equal(sink2.di[0], PROMPTS["architect"]);
});

test("PJ8: prototype-chain expert keys never inject (constructor / __proto__)", async () => {
  for (const evil of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) {
    const sink = { di: /** @type {(string|undefined)[]} */ ([]) };
    const srv = buildServer({ providers: [capturingProvider("codex", sink)], getConfig: () => config });
    // Pass via ask-gpt so the evil string flows through args.expert -> withPersona.
    await srv.handle({ jsonrpc: "2.0", id: 8, method: "tools/call",
      params: { name: "ask-gpt", arguments: { prompt: "x", expert: evil } } });
    assert.equal(sink.di[0], undefined, `expert "${evil}" must not inject a persona`);
  }
});

test("PJ7: inputSchema exposes files array; descriptions are richer per-expert", () => {
  const tools = toolList();
  const architect = tools.find((t) => t.name === "architect");
  assert.ok(architect);
  // files property present in schema
  assert.ok(architect.inputSchema.properties.files);
  assert.equal(architect.inputSchema.properties.files.type, "array");
  // richer description: not the old terse default
  assert.equal(/Direct architect expert \(advisory\)\.$/.test(architect.description), false);
  assert.ok(architect.description.length > 40);
  // ask-all / consensus describe fan-out / arbiter
  const askAll = tools.find((t) => t.name === "ask-all");
  const cons = tools.find((t) => t.name === "consensus");
  assert.ok(askAll && /parallel|fan/i.test(askAll.description));
  assert.ok(cons && /arbiter|synthesiz/i.test(cons.description));
});

// --- Phase B: configurable host-agnostic consensus arbiter --------------------

/**
 * Records every ask() it receives (provider, prompt, developerInstructions) and
 * lets the test control health. ask returns a per-provider labelled success.
 * @param {string} name
 * @param {{calls:any[]}} sink
 * @param {{ok:boolean}} [health]
 * @returns {Provider}
 */
function recordingProvider(name, sink, health = { ok: true }) {
  return {
    name,
    capabilities: { canImplement: false, fileUpload: false, multiTurn: false },
    async health() { return health; },
    async ask(req) {
      sink.calls.push({ provider: name, prompt: req.prompt, di: req.developerInstructions });
      return { provider: name, model: "m", text: `${name}:${req.prompt}`, isError: false, ms: 1 };
    },
  };
}

/** @param {string} arbiter @param {any[]} [models] */
function cfg(arbiter, models = []) {
  return { providers: {}, openrouter: { maxFanout: 3, models }, consensus: { arbiter }, consensusWarnings: /** @type {string[]} */ ([]) };
}

/** @param {any} srv @param {any} args */
async function callConsensus(srv, args) {
  const res = await srv.handle({ jsonrpc: "2.0", id: 99, method: "tools/call", params: { name: "consensus", arguments: { prompt: "Q", ...args } } });
  return JSON.parse(res.result.content[0].text);
}

test("AR1: arbiter 'host' returns verdict:null and runs NO arbiter pass", async () => {
  const sink = { calls: /** @type {any[]} */ ([]) };
  const srv = buildServer({ providers: [recordingProvider("codex", sink), recordingProvider("grok", sink)], getConfig: () => cfg("host") });
  const out = await callConsensus(srv, { expert: "architect" });
  assert.equal(out.verdict, null);
  assert.equal(out.opinions.length, 2);
  assert.deepEqual(out.arbiter, { mode: "host" });
  // exactly 2 asks (the two opinions), zero arbiter pass
  assert.equal(sink.calls.length, 2);
});

test("AR2: arbiter 'auto' picks the first healthy provider and surfaces an auto-selected warning", async () => {
  const sink = { calls: /** @type {any[]} */ ([]) };
  // 3 built-ins so peers can exclude the arbiter and still have >= 2.
  const srv = buildServer({
    providers: [recordingProvider("codex", sink), recordingProvider("gemini", sink), recordingProvider("grok", sink)],
    getConfig: () => cfg("auto"),
  });
  const out = await callConsensus(srv, { expert: "architect" });
  assert.equal(out.arbiter.mode, "server");
  assert.equal(out.arbiter.provider, "codex"); // first healthy
  assert.ok(out.verdict);
  assert.ok(out.warnings.some((/** @type {string} */ w) => /auto-selected/i.test(w)));
});

test("AR3: arbiter 'auto' prefers an openrouter provider when one is healthy in the panel", async () => {
  const sink = { calls: /** @type {any[]} */ ([]) };
  const models = [{ alias: "k2", model: "x/k2", experts: null, askAll: true, consensus: true }];
  const srv = buildServer({
    providers: [recordingProvider("codex", sink), recordingProvider("grok", sink), recordingProvider("openrouter", sink)],
    getConfig: () => cfg("auto", models),
  });
  const out = await callConsensus(srv, { expert: "architect" });
  assert.equal(out.arbiter.mode, "server");
  assert.equal(out.arbiter.provider, "openrouter:k2"); // OR preferred over built-ins
});

test("AR4: built-in arbiter name selects that provider and excludes it from peers", async () => {
  const sink = { calls: /** @type {any[]} */ ([]) };
  const srv = buildServer({
    providers: [recordingProvider("codex", sink), recordingProvider("gemini", sink), recordingProvider("grok", sink)],
    getConfig: () => cfg("grok"),
  });
  const out = await callConsensus(srv, { expert: "architect" });
  assert.equal(out.arbiter.provider, "grok");
  // peers = codex, gemini (grok excluded). 2 opinions, neither is grok.
  assert.deepEqual(out.opinions.map((/** @type {any} */ o) => o.provider).sort(), ["codex", "gemini"]);
  // grok appears once - as the arbiter pass only
  const grokCalls = sink.calls.filter((c) => c.provider === "grok");
  assert.equal(grokCalls.length, 1);
  // arbiter pass carries the arbiter persona, not the architect persona
  assert.equal(grokCalls[0].di, PROMPTS["arbiter"]);
});

test("AR5: openrouter:<alias> arbiter pins that alias as the arbiter", async () => {
  const sink = { calls: /** @type {any[]} */ ([]) };
  const models = [{ alias: "k2", model: "x/k2", experts: null, askAll: true, consensus: true }];
  const srv = buildServer({
    providers: [recordingProvider("codex", sink), recordingProvider("gemini", sink), recordingProvider("grok", sink), recordingProvider("openrouter", sink)],
    getConfig: () => cfg("openrouter:k2", models),
  });
  const out = await callConsensus(srv, { expert: "architect" });
  assert.equal(out.arbiter.provider, "openrouter:k2");
  assert.equal(out.opinions.some((/** @type {any} */ o) => o.provider === "openrouter:k2"), false); // excluded from peers
});

test("AR6: openrouter:<missing-alias> arbiter degrades to auto + warning", async () => {
  const sink = { calls: /** @type {any[]} */ ([]) };
  const srv = buildServer({
    providers: [recordingProvider("codex", sink), recordingProvider("gemini", sink), recordingProvider("grok", sink)],
    getConfig: () => cfg("openrouter:ghost"),
  });
  const out = await callConsensus(srv, { expert: "architect" });
  assert.equal(out.arbiter.mode, "server");
  assert.equal(out.arbiter.provider, "codex"); // auto fallback
  assert.ok(out.warnings.some((/** @type {string} */ w) => /ghost|unknown|degrad|auto-selected/i.test(w)));
});

test("AR7: unknown built-in arbiter (not registered) degrades to auto + warning", async () => {
  const sink = { calls: /** @type {any[]} */ ([]) };
  // config says arbiter:gemini but gemini is NOT in the provider set.
  const srv = buildServer({
    providers: [recordingProvider("codex", sink), recordingProvider("grok", sink)],
    getConfig: () => cfg("gemini"),
  });
  const out = await callConsensus(srv, { expert: "architect" });
  assert.equal(out.arbiter.mode, "server");
  assert.ok(out.warnings.length >= 1);
});

test("AR8: floor-of-2 - with only 2 providers the arbiter stays in peers (panel never < 2)", async () => {
  const sink = { calls: /** @type {any[]} */ ([]) };
  const srv = buildServer({ providers: [recordingProvider("codex", sink), recordingProvider("grok", sink)], getConfig: () => cfg("codex") });
  const out = await callConsensus(srv, { expert: "architect" });
  // peers would be [grok] (1) -> floor keeps codex in -> 2 opinions
  assert.equal(out.opinions.length, 2);
  assert.ok(out.warnings.some((/** @type {string} */ w) => /floor|kept|panel/i.test(w)));
  assert.ok(out.verdict);
});

test("AR9: consensusWarnings from config are surfaced in the consensus response", async () => {
  const sink = { calls: /** @type {any[]} */ ([]) };
  const c = cfg("auto");
  c.consensusWarnings = ["config-level warning about a bad arbiter"];
  const srv = buildServer({ providers: [recordingProvider("codex", sink), recordingProvider("gemini", sink), recordingProvider("grok", sink)], getConfig: () => c });
  const out = await callConsensus(srv, { expert: "architect" });
  assert.ok(out.warnings.some((/** @type {string} */ w) => /config-level warning/.test(w)));
});
