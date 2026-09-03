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

test("M4: consensus synthesizeAlways runs fan-out + one arbiter pass and returns opinions + synthesis", async () => {
  const srv = buildServer({ providers: [fakeProvider("codex"), fakeProvider("grok")], getConfig: () => config });
  const res = await srv.handle({ jsonrpc: "2.0", id: 4, method: "tools/call",
    params: { name: "consensus", arguments: { prompt: "x", expert: "architect", synthesizeAlways: true } } });
  const payload = JSON.parse(res.result.content[0].text);
  assert.equal(payload.opinions.length, 2);
  assert.equal(payload.synthesizeAlways, true);
  assert.ok(payload.synthesis); // arbiter produced a free-text synthesis
  assert.equal(payload.verdict, null); // enum verdict is null in synthesize mode
});

// arbiterDefaulted=true simulates a user who did NOT set consensus.arbiter, so the
// server picks the default by host (Claude -> host, else -> auto).
const defaultedConfig = { providers: {}, openrouter: { maxFanout: 3, models: [] }, consensus: { arbiter: "auto", arbiterDefaulted: true, blindVote: false } };

async function consensusArbiterMode(clientName, claudecode) {
  const prev = process.env.CLAUDECODE;
  if (claudecode) process.env.CLAUDECODE = "1"; else delete process.env.CLAUDECODE;
  try {
    const srv = buildServer({ providers: [fakeProvider("codex"), fakeProvider("grok")], getConfig: () => defaultedConfig });
    if (clientName) await srv.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: clientName } } });
    const res = await srv.handle({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "consensus", arguments: { prompt: "x", expert: "architect", synthesizeAlways: true } } });
    return JSON.parse(res.result.content[0].text);
  } finally {
    if (prev === undefined) delete process.env.CLAUDECODE; else process.env.CLAUDECODE = prev;
  }
}

test("M6: arbiterDefaulted + a Claude clientInfo.name defaults the arbiter to host (verdict:null)", async () => {
  const payload = await consensusArbiterMode("claude-code", false);
  assert.equal(payload.arbiter.mode, "host");
  assert.equal(payload.verdict, null);
});

test("M7: arbiterDefaulted + a non-Claude client defaults the arbiter to auto (server synthesis)", async () => {
  const payload = await consensusArbiterMode("cursor", false);
  assert.equal(payload.arbiter.mode, "server");
  assert.ok(payload.synthesis);
});

test("M8: CLAUDECODE=1 forces host default even when the client name is non-Claude", async () => {
  const payload = await consensusArbiterMode("cursor", true);
  assert.equal(payload.arbiter.mode, "host");
});

test("M5: ask-all expands OR per-alias and never dispatches askAll:false (issue 001 closed)", async () => {
  const srv = buildServer({ providers: [fakeProvider("codex"), fakeProvider("openrouter")], getConfig: () => orConfig });
  const res = await srv.handle({ jsonrpc: "2.0", id: 5, method: "tools/call",
    params: { name: "ask-all", arguments: { prompt: "hi", expert: "architect" } } });
  const provs = JSON.parse(res.result.content[0].text).results.map((r) => r.provider).sort();
  assert.deepEqual(provs, ["codex", "openrouter:on"]); // off excluded server-side
  assert.equal(provs.includes("openrouter:off"), false);
});

// --- session store wiring ----------------------------------------------------

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function tmpSessionsDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "delib-mcp-sess-"));
}
function sessionsConfig(persist) {
  return { providers: {}, openrouter: { maxFanout: 3, models: [] }, sessions: { persist, maxRecords: 200, maxAgeDays: 30 } };
}
async function callTool(srv, id, name, args) {
  const res = await srv.handle({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  return JSON.parse(res.result.content[0].text);
}

test("S-MCP1: tools/list includes the session tools with per-tool (no-prompt) schemas", async () => {
  const srv = buildServer({ providers: [fakeProvider("codex"), fakeProvider("grok")], getConfig: () => config });
  const res = await srv.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const byName = Object.fromEntries(res.result.tools.map((t) => [t.name, t]));
  for (const n of ["session-get", "session-revisit", "session-annotate"]) {
    assert.ok(byName[n], `missing tool ${n}`);
    assert.equal(byName[n].inputSchema.properties.prompt, undefined); // NOT the prompt-required schema
    assert.ok(byName[n].inputSchema.required.includes("sessionId"));
  }
  assert.ok(byName["session-annotate"].inputSchema.required.includes("note"));
});

test("S-MCP2: consensus with persist on writes a record and returns sessionId", async (t) => {
  const dir = tmpSessionsDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const srv = buildServer({ providers: [fakeProvider("codex"), fakeProvider("grok")], getConfig: () => sessionsConfig(true), sessionsDir: dir });
  const payload = await callTool(srv, 2, "consensus", { synthesizeAlways: true, prompt: "q", expert: "architect" });
  assert.ok(payload.sessionId, "expected a sessionId");
  assert.ok(fs.existsSync(path.join(dir, `${payload.sessionId}.json`)));
});

test("S-MCP3: ask-all with persist on writes a record and returns sessionId", async (t) => {
  const dir = tmpSessionsDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const srv = buildServer({ providers: [fakeProvider("codex"), fakeProvider("grok")], getConfig: () => sessionsConfig(true), sessionsDir: dir });
  const payload = await callTool(srv, 3, "ask-all", { prompt: "q" });
  assert.ok(payload.sessionId);
  assert.ok(fs.existsSync(path.join(dir, `${payload.sessionId}.json`)));
});

test("S-MCP3b: an error result's forwarded `message` is never written to the session store", async (t) => {
  // toErrorResult forwards the bridge's reason (issue #180), which can quote model output.
  // It is for the host's eyes only: opinionsFrom must keep copying just provider/model/
  // text/verdict fields, so a persisted record never carries it.
  const dir = tmpSessionsDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const failing = {
    name: "grok",
    capabilities: { canImplement: false, fileUpload: false, multiTurn: false },
    async health() { return { ok: true }; },
    async ask() { return { provider: "grok", model: "grok-4.6", isError: true, errorKind: "empty", retryable: true, message: "stub: SECRET OUTPUT", ms: 1 }; },
  };
  const srv = buildServer({ providers: [fakeProvider("codex"), /** @type {any} */ (failing)], getConfig: () => sessionsConfig(true), sessionsDir: dir });
  const payload = await callTool(srv, 33, "ask-all", { prompt: "q" });
  assert.ok(payload.results.some((r) => r.provider === "grok" && r.isError && r.message), "the envelope itself carries the message");
  const record = fs.readFileSync(path.join(dir, `${payload.sessionId}.json`), "utf8");
  assert.ok(!record.includes("SECRET OUTPUT"), "persisted record must not contain the forwarded message");
  assert.ok(!/"message"/.test(record), "no message key at all in the record");
});

test("S-MCP4: persist off writes nothing and returns no sessionId", async (t) => {
  const dir = tmpSessionsDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const srv = buildServer({ providers: [fakeProvider("codex"), fakeProvider("grok")], getConfig: () => sessionsConfig(false), sessionsDir: dir });
  const payload = await callTool(srv, 4, "consensus", { synthesizeAlways: true, prompt: "q" });
  assert.equal(payload.sessionId, undefined);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("S-MCP5: session-get round-trips a persisted record", async (t) => {
  const dir = tmpSessionsDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const srv = buildServer({ providers: [fakeProvider("codex"), fakeProvider("grok")], getConfig: () => sessionsConfig(true), sessionsDir: dir });
  const made = await callTool(srv, 5, "consensus", { synthesizeAlways: true, prompt: "the question", expert: "architect" });
  const got = await callTool(srv, 6, "session-get", { sessionId: made.sessionId });
  assert.equal(got.session.id, made.sessionId);
  assert.equal(got.session.question, "the question");
  assert.equal(got.session.tool, "consensus");
});

test("S-MCP6: session-revisit writes a CHILD record linked by parentId", async (t) => {
  const dir = tmpSessionsDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const srv = buildServer({ providers: [fakeProvider("codex"), fakeProvider("grok")], getConfig: () => sessionsConfig(true), sessionsDir: dir });
  const parent = await callTool(srv, 7, "consensus", { synthesizeAlways: true, prompt: "original q" });
  const child = await callTool(srv, 8, "session-revisit", { sessionId: parent.sessionId });
  assert.equal(child.parentId, parent.sessionId);
  assert.ok(child.sessionId);
  assert.notEqual(child.sessionId, parent.sessionId);
  const childRec = await callTool(srv, 9, "session-get", { sessionId: child.sessionId });
  assert.equal(childRec.session.parentId, parent.sessionId);
  assert.equal(childRec.session.question, "original q"); // re-ran the original question
});

test("S-MCP7: session-annotate appends to the audit trail", async (t) => {
  const dir = tmpSessionsDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const srv = buildServer({ providers: [fakeProvider("codex"), fakeProvider("grok")], getConfig: () => sessionsConfig(true), sessionsDir: dir });
  const made = await callTool(srv, 10, "consensus", { synthesizeAlways: true, prompt: "q" });
  const ann = await callTool(srv, 11, "session-annotate", { sessionId: made.sessionId, note: "reviewed" });
  assert.equal(ann.session.annotations.length, 1);
  assert.equal(ann.session.annotations[0].note, "reviewed");
});

test("S-MCP8: session tools report disabled when persist is off", async (t) => {
  const dir = tmpSessionsDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const srv = buildServer({ providers: [fakeProvider("codex"), fakeProvider("grok")], getConfig: () => sessionsConfig(false), sessionsDir: dir });
  for (const [id, name] of [[12, "session-get"], [13, "session-revisit"], [14, "session-annotate"]]) {
    const payload = await callTool(srv, id, name, { sessionId: "whatever", note: "x" });
    assert.match(payload.error, /persistence is disabled/);
  }
});

test("S-MCP9: session-get on an unknown id returns a not-found message", async (t) => {
  const dir = tmpSessionsDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const srv = buildServer({ providers: [fakeProvider("codex"), fakeProvider("grok")], getConfig: () => sessionsConfig(true), sessionsDir: dir });
  const payload = await callTool(srv, 15, "session-get", { sessionId: "nope" });
  assert.match(payload.error, /session not found/);
});
