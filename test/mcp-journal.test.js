"use strict";
// Journal instrumentation of the MCP server: run_start/run_end per tool run, and the
// /ask-all grouping where `panel` opens a fan-out run and parallel `ask-one` calls join
// it by runId. Drives buildServer with fake providers and a REAL journal on a temp dir.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildServer } = require("../server/mcp/index.js");
const { createJournal } = require("../core/journal.js");

/** @param {string} name @param {(p:string)=>string} [reply] */
function fakeProvider(name, reply = (p) => `${name}:${p}`) {
  return /** @type {any} */ ({
    name,
    capabilities: { canImplement: false, fileUpload: false, multiTurn: false },
    async health() { return { ok: true }; },
    async ask(/** @type {any} */ req) { return { provider: name, model: `${name}-m`, text: reply(req.prompt), isError: false, ms: 1, reasoningEffort: null }; },
  });
}
const config = { providers: {}, openrouter: { maxFanout: 3, models: [] } };

function setup(/** @type {any} */ settings = { enabled: true, capture: "metadata", maxRuns: -1, maxAgeDays: -1 }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delib-mj-"));
  const journal = createJournal({ dir, getSettings: () => settings });
  /** All events across every run file, in write order per file. */
  const events = () => fs.existsSync(dir)
    ? fs.readdirSync(dir).flatMap((f) => fs.readFileSync(path.join(dir, f), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)))
    : [];
  const files = () => (fs.existsSync(dir) ? fs.readdirSync(dir) : []);
  return { dir, journal, events, files, settings };
}

async function callTool(/** @type {any} */ srv, /** @type {string} */ name, /** @type {any} */ args) {
  const res = await srv.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  return JSON.parse(res.result.content[0].text);
}

test("MJ1: panel returns a runId; two ask-one calls with it join that one run", async () => {
  const { journal, events } = setup();
  const srv = buildServer({ providers: [fakeProvider("codex"), fakeProvider("grok")], getConfig: () => config, journal });
  const panel = await callTool(srv, "panel", { prompt: "q" });
  assert.equal(typeof panel.runId, "string");
  await Promise.all(["codex", "grok"].map((provider) => callTool(srv, "ask-one", { provider, prompt: "q", runId: panel.runId })));
  const evs = events();
  assert.ok(evs.every((e) => e.runId === panel.runId), "everything lands in the panel's run");
  const starts = evs.filter((e) => e.kind === "run_start");
  assert.equal(starts.length, 1);
  assert.equal(starts[0].workflow, "fanout");
  assert.equal(starts[0].tool, "ask-all");
  assert.deepEqual([...starts[0].providers].sort(), ["codex", "grok"]);
  assert.equal(evs.filter((e) => e.kind === "call_end").length, 2);
  assert.equal(evs.filter((e) => e.kind === "run_end").length, 0, "a grouped fan-out has no explicit end");
});

test("MJ2: ask-one without runId is its own single run with run_start and run_end", async () => {
  const { journal, events } = setup();
  const srv = buildServer({ providers: [fakeProvider("codex")], getConfig: () => config, journal });
  await callTool(srv, "ask-one", { provider: "codex", prompt: "q" });
  const evs = events();
  const kinds = evs.map((e) => e.kind);
  assert.deepEqual(kinds, ["run_start", "call_start", "call_end", "run_end"]);
  assert.equal(evs[0].workflow, "single");
  assert.deepEqual(evs[0].providers, ["codex"]);
  assert.equal(evs[3].status, "done");
  assert.ok(evs.every((e) => e.runId === evs[0].runId));
});

test("MJ3: an unsafe runId is ignored - the call becomes its own run", async () => {
  const { journal, events, dir } = setup();
  const srv = buildServer({ providers: [fakeProvider("codex")], getConfig: () => config, journal });
  await callTool(srv, "ask-gpt", { prompt: "q", runId: "../x" });
  const evs = events();
  assert.deepEqual(evs.map((e) => e.kind), ["run_start", "call_start", "call_end", "run_end"]);
  assert.notEqual(evs[0].runId, "../x");
  assert.ok(!fs.existsSync(path.join(dir, "..", "x.jsonl")));
});

test("MJ4: a full consensus-step loop journals under runId === sessionId", async () => {
  const { journal, events } = setup();
  const approve = (/** @type {string} */ n) => fakeProvider(n, () => "**Verdict**: APPROVE");
  const srv = buildServer({ providers: [approve("codex"), approve("grok")], getConfig: () => config, journal });
  const init = await callTool(srv, "consensus-step", { action: "init", prompt: "ship it" });
  const sid = init.sessionId;
  await callTool(srv, "consensus-step", { action: "record_blind", sessionId: sid, blindVerdict: "APPROVE" });
  await callTool(srv, "consensus-step", { action: "dispatch_peers", sessionId: sid });
  const adj = await callTool(srv, "consensus-step", { action: "submit_adjudication", sessionId: sid, verdict: "APPROVE", decisions: [] });
  assert.equal(adj.converged, true);
  const evs = events();
  assert.ok(evs.length > 0 && evs.every((e) => e.runId === sid));
  const kinds = evs.map((e) => e.kind);
  for (const k of ["run_start", "state", "call_end", "run_end"]) assert.ok(kinds.includes(k), `missing ${k}`);
  assert.ok(kinds.filter((k) => k === "arbiter").length >= 2);
  assert.equal(evs.find((e) => e.kind === "run_start").workflow, "consensus-step");
  const adjState = evs.find((e) => e.kind === "state" && e.state === "adjudicate");
  assert.deepEqual(adjState.verdicts.map((/** @type {any} */ v) => v.verdict), ["APPROVE", "APPROVE"]);
  const end = evs.find((e) => e.kind === "run_end");
  assert.equal(end.status, "converged");
  assert.equal(end.rounds, 1);
  assert.equal(kinds[kinds.length - 1], "run_end");
});

test("MJ5: the enabled flag is read per call - flipping it on starts journaling", async () => {
  const settings = { enabled: false, capture: "metadata", maxRuns: -1, maxAgeDays: -1 };
  const { journal, files } = setup(settings);
  const srv = buildServer({ providers: [fakeProvider("codex")], getConfig: () => config, journal });
  await callTool(srv, "ask-one", { provider: "codex", prompt: "q" });
  assert.equal(files().length, 0);
  settings.enabled = true;
  await callTool(srv, "ask-one", { provider: "codex", prompt: "q" });
  assert.equal(files().length, 1);
});

test("MJ6: journal disabled -> panel has no runId key", async () => {
  const { journal } = setup({ enabled: false });
  const srv = buildServer({ providers: [fakeProvider("codex")], getConfig: () => config, journal });
  const panel = await callTool(srv, "panel", {});
  assert.ok(!Object.prototype.hasOwnProperty.call(panel, "runId"));
  // And with no journal injected at all (NULL_JOURNAL default).
  const bare = buildServer({ providers: [fakeProvider("codex")], getConfig: () => config });
  assert.ok(!Object.prototype.hasOwnProperty.call(await callTool(bare, "panel", {}), "runId"));
});

test("MJ7: panel for consensus opens no fan-out run", async () => {
  const { journal, files } = setup();
  const srv = buildServer({ providers: [fakeProvider("codex")], getConfig: () => config, journal });
  const panel = await callTool(srv, "panel", { for: "consensus" });
  assert.ok(!Object.prototype.hasOwnProperty.call(panel, "runId"));
  assert.equal(files().length, 0);
});

test("MJ8: ask-all and an expert tool each journal one fanout run with run_end", async () => {
  const { journal, events } = setup();
  const srv = buildServer({ providers: [fakeProvider("codex"), fakeProvider("grok")], getConfig: () => config, journal });
  await callTool(srv, "ask-all", { prompt: "q" });
  await callTool(srv, "architect", { prompt: "q2" });
  const evs = events();
  const starts = evs.filter((e) => e.kind === "run_start");
  assert.deepEqual(starts.map((e) => e.workflow), ["fanout", "fanout"]);
  assert.deepEqual(starts.map((e) => e.tool).sort(), ["architect", "ask-all"]);
  const ends = evs.filter((e) => e.kind === "run_end");
  assert.equal(ends.length, 2);
  assert.ok(ends.every((e) => e.status === "done"));
  assert.equal(evs.filter((e) => e.kind === "call_end").length, 4);
});

test("MJ9: consensus tool journals run_start/run_end; an early stop carries stopReason", async () => {
  const { journal, events } = setup();
  // Arbiter set to a provider, but the only other panel member is the arbiter itself:
  // no distinct peer -> insufficient-peers, a stop before any loop round.
  const cfg = { ...config, consensus: { arbiter: "codex" } };
  const srv = buildServer({ providers: [fakeProvider("codex")], getConfig: () => cfg, journal });
  const out = await callTool(srv, "consensus", { prompt: "q" });
  assert.equal(out.error, "insufficient-peers");
  const evs = events();
  const start = evs.find((e) => e.kind === "run_start");
  assert.equal(start.workflow, "consensus");
  const end = evs.find((e) => e.kind === "run_end");
  assert.equal(end.status, "error");
  assert.equal(end.stopReason, "insufficient-peers");
});

test("MJ10: consensus-step stopped by the wall budget ends with stopReason", async () => {
  const { journal, events } = setup();
  let clock = 1000;
  const realNow = Date.now;
  Date.now = () => clock;
  try {
    const cfg = { ...config, consensus: { maxWallMs: 10 } };
    const srv = buildServer({ providers: [fakeProvider("codex"), fakeProvider("grok")], getConfig: () => cfg, journal });
    const sid = (await callTool(srv, "consensus-step", { action: "init", prompt: "p" })).sessionId;
    await callTool(srv, "consensus-step", { action: "record_blind", sessionId: sid, blindVerdict: "x" });
    clock += 100;
    const dp = await callTool(srv, "consensus-step", { action: "dispatch_peers", sessionId: sid });
    assert.equal(dp.stopReason, "budget-exhausted");
  } finally {
    Date.now = realNow;
  }
  const end = events().find((e) => e.kind === "run_end");
  assert.equal(end.status, "unresolved");
  assert.equal(end.stopReason, "budget-exhausted");
});
