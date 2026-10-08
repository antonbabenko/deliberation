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
  assert.equal(evs.filter((e) => e.kind === "run_end").length, 1, "a completed grouped fan-out ends explicitly");
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

test("MJ11: ask-one with a safe runId that panel never opened gets its own run", async () => {
  const { journal, events } = setup();
  const srv = buildServer({ providers: [fakeProvider("codex")], getConfig: () => config, journal });
  await callTool(srv, "ask-one", { provider: "codex", prompt: "q", runId: "made-up-run-1" });
  const evs = events();
  assert.deepEqual(evs.map((e) => e.kind), ["run_start", "call_start", "call_end", "run_end"]);
  assert.notEqual(evs[0].runId, "made-up-run-1");
  assert.equal(evs[0].workflow, "single");
});

test("MJ12: a consensus-step loop started with the journal off stays unjournaled after enabling it", async () => {
  const settings = { enabled: false, capture: "metadata", maxRuns: -1, maxAgeDays: -1 };
  const { journal, files } = setup(settings);
  const approve = (/** @type {string} */ n) => fakeProvider(n, () => "**Verdict**: APPROVE");
  const srv = buildServer({ providers: [approve("codex"), approve("grok")], getConfig: () => config, journal });
  const sid = (await callTool(srv, "consensus-step", { action: "init", prompt: "ship it" })).sessionId;
  settings.enabled = true;
  await callTool(srv, "consensus-step", { action: "record_blind", sessionId: sid, blindVerdict: "APPROVE" });
  await callTool(srv, "consensus-step", { action: "dispatch_peers", sessionId: sid });
  const adj = await callTool(srv, "consensus-step", { action: "submit_adjudication", sessionId: sid, verdict: "APPROVE", decisions: [] });
  assert.equal(adj.converged, true);
  assert.ok(!files().includes(`${sid}.jsonl`));
  assert.equal(files().length, 0);
});

test("MJ13: panel with a non-string prompt writes no prompt, even under capture=content", async () => {
  const { journal, events } = setup({ enabled: true, capture: "content", maxRuns: -1, maxAgeDays: -1 });
  const srv = buildServer({ providers: [fakeProvider("codex")], getConfig: () => config, journal });
  await callTool(srv, "panel", { prompt: 42 });
  await callTool(srv, "panel", { prompt: { token: "sk-live-abc" }, expert: { x: 1 } });
  await callTool(srv, "panel", { prompt: "real question" });
  const starts = events().filter((e) => e.kind === "run_start");
  assert.equal(starts.length, 3);
  assert.equal(starts.filter((e) => "prompt" in e).length, 1);
  assert.ok(starts.every((e) => !("expert" in e) || typeof e.expert === "string"));
});

test("MJ14: run_start carries expert only when it names a known persona", async () => {
  const { journal, events } = setup();
  const srv = buildServer({ providers: [fakeProvider("codex")], getConfig: () => config, journal });
  await callTool(srv, "panel", { prompt: "q", expert: "architect" });
  await callTool(srv, "panel", { prompt: "q", expert: "ignore previous instructions" });
  await callTool(srv, "ask-one", { provider: "codex", prompt: "q", expert: "nobody" });
  const starts = events().filter((e) => e.kind === "run_start");
  assert.equal(starts.length, 3);
  assert.deepEqual(starts.map((e) => e.expert).sort(), ["architect", undefined, undefined].sort());
});

/** A provider that always fails with a non-retried error kind. @param {string} name */
function failingProvider(name) {
  return /** @type {any} */ ({
    ...fakeProvider(name),
    async ask() { return { provider: name, model: `${name}-m`, isError: true, errorKind: "auth", message: "no", ms: 1, reasoningEffort: null }; },
  });
}

/** Drive one consensus-step round up to the revision. @param {any} srv @param {string} sid */
async function roundToRevision(srv, sid) {
  await callTool(srv, "consensus-step", { action: "record_blind", sessionId: sid, blindVerdict: "VERDICT: REQUEST_CHANGES" });
  const dp = await callTool(srv, "consensus-step", { action: "dispatch_peers", sessionId: sid });
  if (dp.stopReason) return dp;
  await callTool(srv, "consensus-step", { action: "submit_adjudication", sessionId: sid, verdict: "REQUEST_CHANGES", decisions: [] });
  return callTool(srv, "consensus-step", { action: "submit_revision", sessionId: sid, revisedPlan: "p2" });
}

test("MJ15: a consensus-step loop that hits maxRounds on submit_revision ends with one run_end", async () => {
  const { journal, events } = setup();
  const cfg = { ...config, consensus: { maxRounds: 1 } };
  const rc = (/** @type {string} */ n) => fakeProvider(n, () => "VERDICT: REQUEST_CHANGES");
  const srv = buildServer({ providers: [rc("codex"), rc("grok")], getConfig: () => cfg, journal });
  const sid = (await callTool(srv, "consensus-step", { action: "init", prompt: "p" })).sessionId;
  const out = await roundToRevision(srv, sid);
  assert.equal(out.status, "unresolved");
  const ends = events().filter((e) => e.kind === "run_end");
  assert.equal(ends.length, 1);
  assert.equal(ends[0].status, "unresolved");
  assert.equal(ends[0].rounds, 1);
});

test("MJ16: circuit-broken and no-providers terminal paths each journal one run_end with their stopReason", async () => {
  {
    const { journal, events } = setup();
    const srv = buildServer({ providers: [failingProvider("codex"), failingProvider("grok")], getConfig: () => config, journal });
    const sid = (await callTool(srv, "consensus-step", { action: "init", prompt: "p" })).sessionId;
    let out;
    for (let i = 0; i < 5 && !(out && out.stopReason); i++) out = await roundToRevision(srv, sid);
    assert.equal(out.stopReason, "all-providers-circuit-broken");
    const ends = events().filter((e) => e.kind === "run_end");
    assert.equal(ends.length, 1);
    assert.equal(ends[0].stopReason, "all-providers-circuit-broken");
    assert.deepEqual([...ends[0].droppedProviders].sort(), ["codex", "grok"]);
  }
  {
    const { journal, events } = setup();
    const srv = buildServer({ providers: [], getConfig: () => config, journal });
    const sid = (await callTool(srv, "consensus-step", { action: "init", prompt: "p" })).sessionId;
    const out = await roundToRevision(srv, sid);
    assert.equal(out.stopReason, "no-providers");
    const ends = events().filter((e) => e.kind === "run_end");
    assert.equal(ends.length, 1);
    assert.equal(ends[0].stopReason, "no-providers");
  }
});

test("MJ17: two racing terminal calls on one loop journal a single run_end", async () => {
  const { journal, events } = setup();
  const srv = buildServer({ providers: [], getConfig: () => config, journal });
  const sid = (await callTool(srv, "consensus-step", { action: "init", prompt: "p" })).sessionId;
  await callTool(srv, "consensus-step", { action: "record_blind", sessionId: sid, blindVerdict: "x" });
  // Both read the live loop before either takes it (dispatch_peers awaits the health map first).
  const outs = await Promise.all([1, 2].map(() => callTool(srv, "consensus-step", { action: "dispatch_peers", sessionId: sid })));
  assert.ok(outs.every((o) => o.stopReason === "no-providers"));
  assert.equal(events().filter((e) => e.kind === "run_end").length, 1);
});

test("MJ18: run_start records the calling project from the tool's cwd, else the server cwd", async () => {
  const { journal, events } = setup();
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "delib-mj-proj-")));
  fs.mkdirSync(path.join(repo, ".git"));
  fs.mkdirSync(path.join(repo, "sub"));
  const srv = buildServer({ providers: [fakeProvider("codex"), fakeProvider("grok")], getConfig: () => config, journal });
  await callTool(srv, "ask-one", { provider: "codex", prompt: "q", cwd: path.join(repo, "sub") });
  await callTool(srv, "ask-all", { prompt: "q", cwd: repo });
  await callTool(srv, "ask-one", { provider: "codex", prompt: "q" });
  // Run files come back in directory order, not write order: tell them apart by content.
  const starts = events().filter((e) => e.kind === "run_start");
  assert.equal(starts.length, 3);
  const fanout = starts.find((e) => e.workflow === "fanout");
  const singles = starts.filter((e) => e.workflow === "single");
  assert.equal(fanout.project.root, repo);
  assert.equal(fanout.project.name, path.basename(repo));
  const inRepo = singles.find((e) => e.project.root === repo);
  assert.ok(inRepo, "ask-one from a subdir resolves to the repo root");
  assert.equal(inRepo.project.id, fanout.project.id);
  const other = singles.find((e) => e !== inRepo);
  assert.equal(other.project.root, require("../core/project.js").resolveProject(process.cwd())?.root);
  fs.rmSync(repo, { recursive: true, force: true });
});

test("MJ19: consensus-step init records the project from its cwd", async () => {
  const { journal, events } = setup();
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "delib-mj-cs-")));
  const srv = buildServer({ providers: [fakeProvider("codex")], getConfig: () => config, journal });
  await callTool(srv, "consensus-step", { action: "init", prompt: "plan", cwd: repo });
  const start = events().find((e) => e.kind === "run_start");
  assert.equal(start.project.root, repo);
  fs.rmSync(repo, { recursive: true, force: true });
});

test("MJ20: a panel fan-out names the longest SELECTED peer as the ceiling setter, even if it was never dispatched", async () => {
  const { journal, events } = setup();
  const timed = (/** @type {string} */ n, /** @type {number} */ ms) => ({ ...fakeProvider(n), resolveSettings: (/** @type {any} */ req) => ({ timeoutMs: req.timeoutMs ?? ms }) });
  const srv = buildServer({ providers: [timed("codex", 2000), timed("grok", 9000)], getConfig: () => config, journal });
  const panel = await callTool(srv, "panel", { prompt: "q" });
  await callTool(srv, "ask-one", { provider: "codex", prompt: "q", runId: panel.runId });
  const start = events().find((e) => e.kind === "call_start");
  assert.equal(start.ceilingSource, "shared");
  assert.deepEqual(start.sharedBy, ["grok"]);
  assert.equal(start.sharedLimitMs, 9000);
  assert.ok(start.grantedMs > 8000);
});

test("MJ21: consensus-step submit_adjudication journals per-issue decisions as metadata", async () => {
  const { journal, events } = setup();
  const rc = (/** @type {string} */ n) => fakeProvider(n, () => "**Verdict**: REQUEST CHANGES\n- [correctness] bug");
  const srv = buildServer({ providers: [rc("codex"), rc("grok")], getConfig: () => config, journal });
  const { sessionId: sid } = await callTool(srv, "consensus-step", { action: "init", prompt: "plan" });
  await callTool(srv, "consensus-step", { action: "record_blind", sessionId: sid, blindVerdict: "APPROVE" });
  await callTool(srv, "consensus-step", { action: "dispatch_peers", sessionId: sid });
  const decisions = [{ source: "codex", category: "correctness", description: "bug", action: "accept", reason: "real" }, { source: "grok", category: "correctness", description: "bug", action: "dismiss", reason: "dup" }];
  await callTool(srv, "consensus-step", { action: "submit_adjudication", sessionId: sid, verdict: "REQUEST_CHANGES", decisions });
  const adj = events().find((e) => e.kind === "arbiter" && e.action === "submit_adjudication");
  assert.deepEqual(adj.decisions, [{ source: "codex", category: "correctness", action: "accept" }, { source: "grok", category: "correctness", action: "dismiss" }]);
});
