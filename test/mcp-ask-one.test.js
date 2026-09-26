"use strict";
// panel + ask-one: the per-provider parallel path /ask-all uses for visible
// progress. panel echoes the exact selection set (no dispatch); ask-one runs ONE
// named provider from that set; an unknown provider is a structured error, not a throw.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildServer } = require("../server/mcp/index.js");

function fakeProvider(/** @type {string} */ name) {
  let calls = 0;
  return /** @type {any} */ ({
    name,
    capabilities: { canImplement: false, fileUpload: false, multiTurn: false },
    async health() { return { ok: true }; },
    async ask(/** @type {any} */ req) { calls += 1; return { provider: name, model: `${name}-m`, text: `${name}:${req.prompt}`, isError: false, ms: 1, reasoningEffort: null }; },
    get __calls() { return calls; },
  });
}
const config = { providers: {}, openrouter: { maxFanout: 3, models: [] } };

test("P1: panel returns the active provider names without dispatching", async () => {
  const codex = fakeProvider("codex");
  const grok = fakeProvider("grok");
  const srv = buildServer({ providers: [codex, grok], getConfig: () => config });
  const res = await srv.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "panel", arguments: { expert: "architect" } } });
  const payload = JSON.parse(res.result.content[0].text);
  assert.deepEqual(payload.providers.sort(), ["codex", "grok"]);
  assert.equal(codex.__calls, 0, "panel must NOT call any provider");
  assert.equal(grok.__calls, 0);
});

test("P2: ask-one dispatches exactly the one named provider", async () => {
  const codex = fakeProvider("codex");
  const grok = fakeProvider("grok");
  const srv = buildServer({ providers: [codex, grok], getConfig: () => config });
  const res = await srv.handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ask-one", arguments: { provider: "grok", prompt: "hi", expert: "architect" } } });
  const payload = JSON.parse(res.result.content[0].text);
  assert.equal(payload.result.provider, "grok");
  assert.equal(payload.result.text, "grok:hi");
  assert.equal(grok.__calls, 1);
  assert.equal(codex.__calls, 0, "only the named provider runs");
});

test("P3: ask-one with a provider NOT in the panel returns a structured error (no throw)", async () => {
  const srv = buildServer({ providers: [fakeProvider("codex"), fakeProvider("grok")], getConfig: () => config });
  const res = await srv.handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "ask-one", arguments: { provider: "gemini", prompt: "hi" } } });
  const payload = JSON.parse(res.result.content[0].text);
  assert.match(payload.error, /not in the active panel/);
  assert.deepEqual(payload.panel.sort(), ["codex", "grok"]);
});

test("P4: panel + ask-one are advertised in tools/list", async () => {
  const srv = buildServer({ providers: [fakeProvider("codex")], getConfig: () => config });
  const res = await srv.handle({ jsonrpc: "2.0", id: 4, method: "tools/list" });
  const names = res.result.tools.map((/** @type {any} */ t) => t.name);
  assert.ok(names.includes("panel"));
  assert.ok(names.includes("ask-one"));
  const askOne = res.result.tools.find((/** @type {any} */ t) => t.name === "ask-one");
  assert.equal(askOne.annotations.readOnlyHint, true);
});

function needsLoginProvider(/** @type {string} */ name) {
  const p = fakeProvider(name);
  p.health = async () => ({ ok: true, needsLogin: true });
  return p;
}

test("P5: panel reports needsLogin for a panel member that has no login yet, and still lists it", async () => {
  const codex = needsLoginProvider("codex");
  const srv = buildServer({ providers: [codex, fakeProvider("grok")], getConfig: () => config });
  const res = await srv.handle({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "panel", arguments: {} } });
  const payload = JSON.parse(res.result.content[0].text);
  assert.deepEqual(payload.providers.sort(), ["codex", "grok"]);
  assert.deepEqual(payload.needsLogin, ["codex"]);
  assert.equal(codex.__calls, 0, "panel must NOT start a login or call the provider");
});

test("P6: panel needsLogin is empty with a login, and never names a provider outside the panel", async () => {
  const srv = buildServer({ providers: [fakeProvider("codex"), fakeProvider("grok")], getConfig: () => config });
  const res = await srv.handle({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "panel", arguments: {} } });
  assert.deepEqual(JSON.parse(res.result.content[0].text).needsLogin, []);
  const off = { ...config, providers: { codex: { enabled: false } } };
  const srv2 = buildServer({ providers: [needsLoginProvider("codex"), fakeProvider("grok")], getConfig: () => off });
  const res2 = await srv2.handle({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "panel", arguments: {} } });
  const p2 = JSON.parse(res2.result.content[0].text);
  assert.deepEqual(p2.providers, ["grok"]);
  assert.deepEqual(p2.needsLogin, []);
});

test("P7: panel for:consensus returns the consensus panel (uncapped delegates) with needsLogin", async () => {
  const srv = buildServer({ providers: [needsLoginProvider("codex"), fakeProvider("grok")], getConfig: () => config });
  const res = await srv.handle({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "panel", arguments: { for: "consensus" } } });
  const payload = JSON.parse(res.result.content[0].text);
  assert.deepEqual(payload.providers.sort(), ["codex", "grok"]);
  assert.deepEqual(payload.needsLogin, ["codex"]);
  assert.deepEqual(payload.omitted, [], "consensus is uncapped: nothing is omitted");
});
