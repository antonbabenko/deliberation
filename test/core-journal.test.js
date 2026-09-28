// test/core-journal.test.js
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");

const { createJournal, NULL_JOURNAL, JOURNAL_KEYS, procStartedAt, isSafeId } = require("../core/journal.js");

/** @param {string} [prefix] */
function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix || "delib-journal-"));
}

/**
 * @param {Partial<import("../core/journal.js").DashboardSettings>} [over]
 * @returns {import("../core/journal.js").DashboardSettings}
 */
function settings(over) {
  return /** @type {import("../core/journal.js").DashboardSettings} */ ({
    enabled: true, capture: "metadata", showPII: false, port: 7717, maxRuns: 200, maxAgeDays: 30, ...over,
  });
}

/** Read + parse every line of a run's journal file. @param {string} dir @param {string} runId */
function readLines(dir, runId) {
  const raw = fs.readFileSync(path.join(dir, `${runId}.jsonl`), "utf8");
  return raw.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

test("J1: disabled settings -> emit creates no file", () => {
  const dir = tmpDir();
  const j = createJournal({ dir, getSettings: () => settings({ enabled: false }) });
  j.emit("run-1", "run_start", { tool: "ask-all", workflow: "single", providers: ["grok"] });
  assert.equal(fs.existsSync(path.join(dir, "run-1.jsonl")), false);
});

test("J2: metadata capture keeps whitelisted meta fields, drops content", () => {
  const dir = tmpDir();
  const j = createJournal({ dir, getSettings: () => settings({ capture: "metadata" }) });
  j.emit("run-2", "call_end", { ms: 5, provider: "gpt", model: "gpt-5", response: "hi", verdict: "APPROVE" });
  const [line] = readLines(dir, "run-2");
  assert.equal(line.ms, 5);
  assert.equal(line.provider, "gpt");
  assert.equal(line.model, "gpt-5");
  assert.equal(line.verdict, "APPROVE");
  assert.ok(!("response" in line), "content field must be absent under metadata capture");
});

test("J3: content capture scrubs secrets in content fields", () => {
  const dir = tmpDir();
  const j = createJournal({ dir, getSettings: () => settings({ capture: "content" }) });
  const secret = "sk-ant-api03-" + "x".repeat(30);
  j.emit("run-3", "call_start", { callId: "c1", provider: "gpt", request: `here is my key ${secret}` });
  const [line] = readLines(dir, "run-3");
  assert.equal(line.callId, "c1");
  assert.ok(typeof line.request === "string");
  assert.ok(!line.request.includes(secret), "raw secret must never be written");
  assert.ok(line.request.includes("[REDACTED]"));
});

test("J4: unknown keys dropped; unknown kind -> no write", () => {
  const dir = tmpDir();
  const j = createJournal({ dir, getSettings: () => settings({ capture: "content" }) });
  j.emit("run-4", "state", { state: "await_peers", round: 1, status: "ok", evil: 1 });
  const [line] = readLines(dir, "run-4");
  assert.ok(!("evil" in line), "unwhitelisted key must be dropped");
  assert.equal(line.state, "await_peers");

  j.emit("run-4b", /** @type {any} */ ("not_a_kind"), { anything: 1 });
  assert.equal(fs.existsSync(path.join(dir, "run-4b.jsonl")), false);
});

test("J5: seq increments per run from 0; envelope has v:1", () => {
  const dir = tmpDir();
  const j = createJournal({ dir, getSettings: () => settings() });
  j.emit("run-5", "state", { state: "init" });
  j.emit("run-5", "state", { state: "await_blind" });
  j.emit("run-5", "state", { state: "converged" });
  const lines = readLines(dir, "run-5");
  assert.deepEqual(lines.map((l) => l.seq), [0, 1, 2]);
  for (const l of lines) {
    assert.equal(l.v, 1);
    assert.equal(l.kind, "state");
    assert.equal(l.runId, "run-5");
    assert.equal(typeof l.at, "number");
  }
});

test("J6: file mode 0600, dir mode 0700 (posix only)", { skip: process.platform === "win32" }, () => {
  const base = tmpDir();
  const dir = path.join(base, "runs");
  const j = createJournal({ dir, getSettings: () => settings() });
  j.emit("run-6", "state", { state: "init" });
  const dirMode = fs.statSync(dir).mode & 0o777;
  const fileMode = fs.statSync(path.join(dir, "run-6.jsonl")).mode & 0o777;
  assert.equal(dirMode, 0o700);
  assert.equal(fileMode, 0o600);
});

test("J7: prune trims by maxRuns (oldest by mtime) and by maxAgeDays; -1 keeps all", () => {
  const dir = tmpDir();
  let clock = 1_700_000_000_000;
  const j = createJournal({ dir, getSettings: () => settings({ maxRuns: 3, maxAgeDays: -1 }), now: () => clock });
  for (let i = 0; i < 5; i++) {
    j.emit(`run-p${i}`, "state", { state: "init" });
    clock += 1000;
  }
  j.prune();
  const remaining = fs.readdirSync(dir).sort();
  assert.deepEqual(remaining, ["run-p2.jsonl", "run-p3.jsonl", "run-p4.jsonl"], "oldest 2 of 5 removed, newest 3 kept");

  // Age-based prune: one more (oldest by mtime among survivors) pushed far in the past.
  const oldFile = path.join(dir, "run-p2.jsonl");
  const veryOld = Date.now() - 100 * 24 * 60 * 60 * 1000;
  fs.utimesSync(oldFile, veryOld / 1000, veryOld / 1000);
  const j2 = createJournal({ dir, getSettings: () => settings({ maxRuns: -1, maxAgeDays: 30 }) });
  j2.prune();
  assert.equal(fs.existsSync(oldFile), false, "file older than maxAgeDays removed");
  assert.ok(fs.existsSync(path.join(dir, "run-p3.jsonl")));
  assert.ok(fs.existsSync(path.join(dir, "run-p4.jsonl")));

  // -1 for both keeps everything (no-op prune).
  const j3 = createJournal({ dir, getSettings: () => settings({ maxRuns: -1, maxAgeDays: -1 }) });
  j3.prune();
  assert.equal(fs.readdirSync(dir).length, 2);
});

test("J8: newRunId matches the safe-id shape and is unique across 1000 calls", () => {
  const j = createJournal({ dir: tmpDir(), getSettings: () => settings() });
  const ids = new Set();
  for (let i = 0; i < 1000; i++) {
    const id = j.newRunId();
    assert.match(id, /^[A-Za-z0-9-]+$/);
    ids.add(id);
  }
  assert.equal(ids.size, 1000);
});

test("J9: a throwing fs (dir is a file) -> emit does not throw", () => {
  const base = tmpDir();
  const dirAsFile = path.join(base, "not-a-dir");
  fs.writeFileSync(dirAsFile, "i am a file");
  const j = createJournal({ dir: dirAsFile, getSettings: () => settings() });
  assert.doesNotThrow(() => j.emit("run-9", "state", { state: "init" }));
  const j2 = createJournal({ dir: dirAsFile, getSettings: () => settings() });
  assert.doesNotThrow(() => j2.prune());
});

test("NULL_JOURNAL: enabled false, emit and prune are no-ops, newRunId still works", () => {
  assert.equal(NULL_JOURNAL.enabled(), false);
  assert.doesNotThrow(() => NULL_JOURNAL.emit("x", "run_start", { tool: "ask-all" }));
  assert.doesNotThrow(() => NULL_JOURNAL.prune());
  assert.match(NULL_JOURNAL.newRunId(), /^[A-Za-z0-9-]+$/);
});

test("run_start: pid and procStartedAt are injected by emit, not taken from fields", () => {
  const dir = tmpDir();
  const j = createJournal({ dir, getSettings: () => settings(), pid: 4242 });
  j.emit("run-rs", "run_start", { tool: "ask-all", pid: 1, procStartedAt: 1, expert: "architect", workflow: "single", providers: ["gpt"] });
  const [line] = readLines(dir, "run-rs");
  assert.equal(line.pid, 4242);
  assert.equal(typeof line.procStartedAt, "number");
  assert.notEqual(line.procStartedAt, 1);
  assert.equal(line.tool, "ask-all");
  assert.deepEqual(line.providers, ["gpt"]);
});

test("call_end: criticalIssues keeps category under metadata, adds description only under content", () => {
  const dir = tmpDir();
  const issues = [{ category: "correctness", description: "off-by-one SECRET" }];

  const dirMeta = tmpDir();
  const jMeta = createJournal({ dir: dirMeta, getSettings: () => settings({ capture: "metadata" }) });
  jMeta.emit("run-ci-meta", "call_end", { ms: 1, criticalIssues: issues });
  const [meta] = readLines(dirMeta, "run-ci-meta");
  assert.deepEqual(meta.criticalIssues, [{ category: "correctness" }]);

  const jContent = createJournal({ dir, getSettings: () => settings({ capture: "content" }) });
  jContent.emit("run-ci-content", "call_end", { ms: 1, criticalIssues: issues });
  const [content] = readLines(dir, "run-ci-content");
  assert.equal(content.criticalIssues[0].category, "correctness");
  assert.equal(content.criticalIssues[0].description, "off-by-one SECRET");
});

test("state: verdicts (per-peer, categories only) round-trips under metadata capture", () => {
  const dir = tmpDir();
  const j = createJournal({ dir, getSettings: () => settings({ capture: "metadata" }) });
  const verdicts = [{ provider: "gpt", verdict: "REQUEST_CHANGES", categories: ["ops", "scope"] }];
  j.emit("run-verdicts", "state", { state: "adjudicate", round: 1, status: "await_revision", verdicts });
  const [line] = readLines(dir, "run-verdicts");
  assert.deepEqual(line.verdicts, verdicts);
});

test("JOURNAL_KEYS matches the spec table for all six kinds", () => {
  assert.deepEqual(Object.keys(JOURNAL_KEYS).sort(), ["arbiter", "call_end", "call_start", "run_end", "run_start", "state"].sort());
  assert.deepEqual(JOURNAL_KEYS.run_start.meta, ["tool", "pid", "procStartedAt", "expert", "workflow", "providers"]);
  assert.deepEqual(JOURNAL_KEYS.run_start.content, ["prompt"]);
  assert.deepEqual(JOURNAL_KEYS.state.meta, ["state", "round", "status", "verdicts"]);
  assert.deepEqual(JOURNAL_KEYS.state.content, []);
  assert.deepEqual(JOURNAL_KEYS.call_start.meta, ["callId", "provider", "model", "role", "round", "timeoutMs", "reasoningEffort"]);
  assert.deepEqual(JOURNAL_KEYS.call_start.content, ["request"]);
  assert.deepEqual(JOURNAL_KEYS.call_end.meta, ["callId", "provider", "model", "ms", "usage", "isError", "errorKind", "errorCode", "verdict", "criticalIssues[].category"]);
  assert.deepEqual(JOURNAL_KEYS.call_end.content, ["response", "criticalIssues[].description"]);
  assert.deepEqual(JOURNAL_KEYS.arbiter.meta, ["action", "round", "verdict"]);
  assert.deepEqual(JOURNAL_KEYS.arbiter.content, ["text"]);
  assert.deepEqual(JOURNAL_KEYS.run_end.meta, ["status", "stopReason", "rounds", "droppedProviders"]);
  assert.deepEqual(JOURNAL_KEYS.run_end.content, ["finalReport"]);
});

test("procStartedAt: roughly now minus process.uptime, in the past", () => {
  const v = procStartedAt();
  assert.equal(typeof v, "number");
  assert.ok(v <= Date.now());
});

test("isSafeId: rejects path traversal shapes, accepts uuid-like ids", () => {
  assert.equal(isSafeId("../../etc/passwd"), false);
  assert.equal(isSafeId("a/b"), false);
  assert.equal(isSafeId(""), false);
  assert.equal(isSafeId(42), false);
  assert.equal(isSafeId("3f2504e0-4f89-11d3-9a0c-0305e82c3301"), true);
});

test("emit rejects an unsafe runId (no file written, no throw)", () => {
  const dir = tmpDir();
  const j = createJournal({ dir, getSettings: () => settings() });
  assert.doesNotThrow(() => j.emit("../evil", "state", { state: "init" }));
  assert.equal(fs.readdirSync(dir).length, 0);
});

test("J-nonstring: a non-string content value is dropped under capture=content", () => {
  const dir = tmpDir();
  const j = createJournal({ dir, getSettings: () => settings({ capture: "content" }) });
  j.emit("r1", "run_start", { tool: "t", prompt: { secret: "sk-live-abc" } });
  j.emit("r1", "arbiter", { action: "record_blind", text: 42 });
  const [start, arb] = readLines(dir, "r1");
  assert.ok(!("prompt" in start));
  assert.ok(!("text" in arb));
});
