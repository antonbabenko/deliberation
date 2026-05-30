"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildServer } = require("../server/mcp/index.js");

function fakeProvider(name) {
  return {
    name,
    capabilities: { canImplement: false, fileUpload: false, multiTurn: false },
    async health() { return { ok: true }; },
    async ask(req) { return { provider: name, model: "m", text: `${name}:${req.prompt}`, isError: false, ms: 1 }; },
  };
}
const config = { providers: {}, openrouter: { maxFanout: 3, models: [] } };
const orConfig = { providers: {}, openrouter: { maxFanout: 3, models: [
  { alias: "on", model: "x/on", experts: null, askAll: true, consensus: true },
  { alias: "off", model: "x/off", experts: null, askAll: false, consensus: true },
] } };

test("M1: tools/list includes ask-all with readOnlyHint", async () => {
  const srv = buildServer({ providers: [fakeProvider("codex"), fakeProvider("grok")], getConfig: () => config });
  const res = await srv.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const askAllTool = res.result.tools.find((t) => t.name === "ask-all");
  assert.ok(askAllTool);
  assert.equal(askAllTool.annotations.readOnlyHint, true);
});

test("M2: tools/call ask-all fans out to all enabled built-ins", async () => {
  const srv = buildServer({ providers: [fakeProvider("codex"), fakeProvider("grok")], getConfig: () => config });
  const res = await srv.handle({ jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "ask-all", arguments: { prompt: "hello", expert: "architect" } } });
  const payload = JSON.parse(res.result.content[0].text);
  assert.deepEqual(payload.results.map((r) => r.provider).sort(), ["codex", "grok"]);
});

test("M3: ask-gpt routes to codex only", async () => {
  const srv = buildServer({ providers: [fakeProvider("codex"), fakeProvider("grok")], getConfig: () => config });
  const res = await srv.handle({ jsonrpc: "2.0", id: 3, method: "tools/call",
    params: { name: "ask-gpt", arguments: { prompt: "hi" } } });
  const payload = JSON.parse(res.result.content[0].text);
  assert.equal(payload.result.provider, "codex");
});

test("M4: consensus runs fan-out + one arbiter pass and returns opinions + verdict", async () => {
  const srv = buildServer({ providers: [fakeProvider("codex"), fakeProvider("grok")], getConfig: () => config });
  const res = await srv.handle({ jsonrpc: "2.0", id: 4, method: "tools/call",
    params: { name: "consensus", arguments: { prompt: "x", expert: "architect" } } });
  const payload = JSON.parse(res.result.content[0].text);
  assert.equal(payload.opinions.length, 2);
  assert.ok(payload.verdict); // arbiter (first provider) produced a verdict
});

test("M5: ask-all expands OR per-alias and never dispatches askAll:false (issue 001 closed)", async () => {
  const srv = buildServer({ providers: [fakeProvider("codex"), fakeProvider("openrouter")], getConfig: () => orConfig });
  const res = await srv.handle({ jsonrpc: "2.0", id: 5, method: "tools/call",
    params: { name: "ask-all", arguments: { prompt: "hi", expert: "architect" } } });
  const provs = JSON.parse(res.result.content[0].text).results.map((r) => r.provider).sort();
  assert.deepEqual(provs, ["codex", "openrouter:on"]); // off excluded server-side
  assert.equal(provs.includes("openrouter:off"), false);
});
