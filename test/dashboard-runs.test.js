// test/dashboard-runs.test.js
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");

const { readEvents, summarize, createRunIndex, deriveStatus, QUIET_MS, NEVER_DISPATCHED_MS } = require("../server/dashboard/runs.js");
const { DEFAULT_TTL_MS } = require("../core/loop-store.js");
const { writeSession, newSessionId, SCHEMA_VERSION } = require("../core/sessions.js");

/** @param {string} [prefix] */
function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix || "delib-dashruns-"));
}

/**
 * Write a run journal file directly (full control over event shape, for tests -
 * production files are written by core/journal.js).
 * @param {string} dir
 * @param {string} runId
 * @param {Record<string, unknown>[]} events  each merged onto {v:1, runId, at, seq}
 */
function writeRun(dir, runId, events) {
  fs.mkdirSync(dir, { recursive: true });
  const lines = events.map((e, i) => JSON.stringify({ v: 1, runId, at: 1_700_000_000_000 + i, seq: i, ...e }));
  fs.writeFileSync(path.join(dir, `${runId}.jsonl`), lines.join("\n") + "\n");
}

const runStart = (/** @type {Record<string, unknown>} */ over) => ({ kind: "run_start", tool: "ask-all", workflow: "single", pid: 1234, procStartedAt: 1_699_000_000_000, providers: ["gpt"], ...over });
const callEnd = (/** @type {Record<string, unknown>} */ over) => ({ kind: "call_end", callId: "c1", provider: "gpt", ms: 5, usage: { totalTokens: 10 }, isError: false, ...over });
const runEnd = (/** @type {Record<string, unknown>} */ over) => ({ kind: "run_end", status: "done", rounds: 1, ...over });

test("RR1: partial trailing line excluded; offset points at its start", () => {
  const dir = tmpDir();
  const line1 = JSON.stringify({ v: 1, runId: "r1", at: 1, seq: 0, kind: "run_start", tool: "ask-all" });
  const line2 = JSON.stringify({ v: 1, runId: "r1", at: 2, seq: 1, kind: "run_end", status: "done" });
  const partial = '{"v":1,"runId":"r1","seq":2,"kind":"call';
  const file = path.join(dir, "r1.jsonl");
  fs.writeFileSync(file, `${line1}\n${line2}\n${partial}`);
  const expectedOffset = Buffer.byteLength(`${line1}\n${line2}\n`, "utf8");

  const { events, offset } = readEvents(file);
  assert.equal(events.length, 2);
  assert.equal(offset, expectedOffset);

  // Resuming from that offset (nothing new appended yet) yields no events and the same offset.
  const again = readEvents(file, offset);
  assert.deepEqual(again.events, []);
  assert.equal(again.offset, offset);

  // Once the line completes, resuming from the same offset picks it up.
  fs.appendFileSync(file, '"}\n'); // closes the "kind" string and the object
  const resumed = readEvents(file, offset);
  assert.equal(resumed.events.length, 1);
  assert.equal(resumed.events[0].kind, "call");
});

test("RR1b: a large prefix plus one new line - read from its offset returns exactly that event, correct offsets, no whole-file re-read", () => {
  const dir = tmpDir();
  const file = path.join(dir, "big.jsonl");
  // A large prefix (well past a single 64 KB read buffer) so a bug that read
  // from byte 0 instead of `fromOffset` would show up as extra/garbled events.
  const bigLine = JSON.stringify({ v: 1, runId: "big", at: 0, seq: 0, kind: "call_end", note: "x".repeat(200_000) }) + "\n";
  fs.writeFileSync(file, bigLine);
  const prefixOffset = Buffer.byteLength(bigLine, "utf8");

  const newLine = JSON.stringify({ v: 1, runId: "big", at: 1, seq: 1, kind: "run_end", status: "done" }) + "\n";
  fs.appendFileSync(file, newLine);

  const { events, offset, offsets } = readEvents(file, prefixOffset);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "run_end");
  assert.deepEqual(offsets, [prefixOffset + Buffer.byteLength(newLine, "utf8")]);
  assert.equal(offset, prefixOffset + Buffer.byteLength(newLine, "utf8"));

  // Resuming again from the new offset (nothing further appended) yields nothing.
  const again = readEvents(file, offset);
  assert.deepEqual(again.events, []);
  assert.equal(again.offset, offset);
});

test("RR2: junk file, subdirectory, and non-JSON content are skipped without throwing", () => {
  const runsDir = tmpDir();
  writeRun(runsDir, "good-run", [runStart({ providers: ["gpt"] }), runEnd({ status: "done" })]);
  fs.writeFileSync(path.join(runsDir, "junk.txt"), "not a run at all");
  fs.mkdirSync(path.join(runsDir, "a-subdir"));
  fs.mkdirSync(path.join(runsDir, "dir-with-ext.jsonl")); // a directory that even matches the extension
  fs.writeFileSync(path.join(runsDir, "bad-run.jsonl"), "not json\n");

  const index = createRunIndex({ runsDir, sessionsDir: path.join(runsDir, "no-such-sessions-dir") });
  let runs;
  assert.doesNotThrow(() => { runs = index.list(); });
  assert.deepEqual(runs.map((r) => r.runId), ["good-run"]);
});

test("RR3: status - run_end wins; no run_end + dead pid -> abandoned; live pid -> running", () => {
  const converged = summarize([runStart({}), runEnd({ status: "converged" })], () => { throw new Error("must not be called"); });
  assert.equal(converged.status, "converged");

  const dead = summarize([runStart({ pid: 5555, procStartedAt: 1 })], (pid) => { assert.equal(pid, 5555); return false; });
  assert.equal(dead.status, "abandoned");
  assert.equal(dead.endedAt, null);

  const alive = summarize([runStart({ pid: 5555, procStartedAt: 1 })], () => true);
  assert.equal(alive.status, "running");
  assert.equal(alive.endedAt, null);
});

test("RR4: fan-out done rule - done only once every run_start provider has a call_end, else falls to liveness", () => {
  const events = [
    runStart({ workflow: "fanout", providers: ["gpt", "grok"] }),
    callEnd({ callId: "gpt-1", provider: "gpt", at: 10 }),
    callEnd({ callId: "grok-2", provider: "grok", at: 20 }),
  ];
  const done = summarize(events, () => { throw new Error("must not be called once fan-out is done"); });
  assert.equal(done.status, "done");
  assert.equal(done.endedAt, 20);

  const partial = summarize(
    [runStart({ workflow: "fanout", providers: ["gpt", "grok"] }), callEnd({ provider: "gpt" })],
    () => false,
  );
  assert.equal(partial.status, "abandoned", "only one of two providers answered - not done, falls to liveness");
});

test("RR5: list() twice without a file change reads each journal file once", (t) => {
  const runsDir = tmpDir();
  writeRun(runsDir, "run-a", [runStart({}), runEnd({ status: "done" })]);
  writeRun(runsDir, "run-b", [runStart({}), runEnd({ status: "done" })]);
  const index = createRunIndex({ runsDir });

  // readEvents opens the file itself (fs.openSync) rather than fs.readFileSync -
  // see RR1b / task-7 fix round 1, it reads only fromOffset..EOF, not the whole file.
  const spy = t.mock.method(fs, "openSync");
  const first = index.list();
  assert.equal(first.length, 2);
  const afterFirst = spy.mock.callCount();
  assert.equal(afterFirst, 2, "one open per run file on first list()");

  const second = index.list();
  assert.equal(second.length, 2);
  assert.equal(spy.mock.callCount(), afterFirst, "no new reads: neither file's (size, mtimeMs) changed");
});

test("RR6: filters - tool, status, provider, since, q", () => {
  const runsDir = tmpDir();
  writeRun(runsDir, "run-early", [
    { ...runStart({ tool: "consensus", providers: ["gpt"], prompt: "review the auth flow" }), at: 1_000 },
    { ...runEnd({ status: "converged" }), at: 1_100 },
  ]);
  writeRun(runsDir, "run-late", [
    { ...runStart({ tool: "ask-all", providers: ["grok", "gpt"], prompt: "summarize the release notes" }), at: 5_000 },
    { ...runEnd({ status: "done" }), at: 5_100 },
  ]);
  const index = createRunIndex({ runsDir });

  assert.deepEqual(index.list({ tool: "consensus" }).map((r) => r.runId), ["run-early"]);
  assert.deepEqual(index.list({ status: "done" }).map((r) => r.runId), ["run-late"]);
  assert.deepEqual(index.list({ provider: "grok" }).map((r) => r.runId), ["run-late"]);
  assert.deepEqual(index.list({ since: 3_000 }).map((r) => r.runId), ["run-late"]);
  assert.deepEqual(index.list({ q: "auth" }).map((r) => r.runId), ["run-early"]);
  assert.deepEqual(index.list({ q: "release" }).map((r) => r.runId), ["run-late"]);
  assert.deepEqual(index.list({ q: "nonexistent" }), []);
});

test("RR7: legacy session appears with legacy:true; get() returns it and rejects path traversal", () => {
  const runsDir = tmpDir();
  const sessionsDir = tmpDir("delib-dashruns-sessions-");
  const id = newSessionId();
  writeSession({
    id, parentId: null, schemaVersion: SCHEMA_VERSION, createdAt: new Date(1_700_000_000_000).toISOString(),
    tool: "consensus", question: "should we do X?", opinions: [{ provider: "gpt" }, { provider: "grok" }],
    converged: true, rounds: 2,
  }, { dir: sessionsDir });

  const index = createRunIndex({ runsDir, sessionsDir });
  const list = index.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].runId, id);
  assert.equal(list[0].legacy, true);
  assert.equal(list[0].workflow, "consensus");
  assert.equal(list[0].status, "converged");
  assert.deepEqual(list[0].providers.slice().sort(), ["gpt", "grok"]);

  const got = index.get(id);
  assert.ok(got && "legacy" in got);
  assert.equal(got.summary.legacy, true);
  assert.equal(got.legacy.id, id);

  assert.equal(index.get("../x"), null);
  assert.equal(index.get("no-such-run"), null);
});

test("RR8: run_start with a pid but no procStartedAt is reported running (0 must not look like a valid epoch)", () => {
  // No injected isAlive: exercises the real default, so process.pid (this test
  // process, definitely alive) must come back "running" even though procStartedAt
  // is entirely absent from the event.
  const summary = summarize([{ kind: "run_start", tool: "ask-all", workflow: "single", pid: process.pid, providers: ["gpt"] }]);
  assert.equal(summary.status, "running");
});

test("RR9: get() falls back to the legacy store when a .jsonl with the same id has no valid summary", () => {
  const runsDir = tmpDir();
  const sessionsDir = tmpDir("delib-dashruns-sessions-");
  const id = newSessionId();
  fs.mkdirSync(runsDir, { recursive: true });
  fs.writeFileSync(path.join(runsDir, `${id}.jsonl`), "not json\n");
  writeSession({
    id, parentId: null, schemaVersion: SCHEMA_VERSION, createdAt: new Date(1_700_000_000_000).toISOString(),
    tool: "ask-all", question: "q", opinions: [{ provider: "gpt" }],
  }, { dir: sessionsDir });

  const index = createRunIndex({ runsDir, sessionsDir });
  const got = index.get(id);
  assert.ok(got && "legacy" in got, "must fall back to the legacy record, not return null");
  assert.equal(got.summary.legacy, true);
  assert.equal(got.legacy.id, id);
});

test("RR10: list() evicts cache entries for run files removed from disk", () => {
  const runsDir = tmpDir();
  writeRun(runsDir, "run-a", [runStart({}), runEnd({ status: "done" })]);
  writeRun(runsDir, "run-b", [runStart({}), runEnd({ status: "done" })]);
  const index = createRunIndex({ runsDir });

  index.list();
  const before = index.cacheSize();
  assert.equal(before, 2);

  fs.rmSync(path.join(runsDir, "run-a.jsonl"));
  index.list();
  assert.equal(index.cacheSize(), 1, "the deleted run's cache entry must be dropped, not kept forever");
});

test("RR11: a multi-byte UTF-8 character right at a line boundary keeps byte offsets correct", () => {
  const dir = tmpDir();
  const file = path.join(dir, "utf8.jsonl");
  // "cafe" + e-acute (2-byte in UTF-8) + a rocket emoji (4-byte in UTF-8, a
  // surrogate pair in JS strings), both right at the end of the line, before the
  // newline - a char-count (rather than byte-count) offset would land mid-codepoint.
  const line1 = JSON.stringify({ v: 1, runId: "u1", at: 1, seq: 0, kind: "state", state: "cafeé 🚀" });
  fs.writeFileSync(file, `${line1}\n`);

  const first = readEvents(file);
  assert.equal(first.events.length, 1);
  assert.equal(first.events[0].state, "cafeé 🚀");
  const offsetAfterLine1 = first.offset;
  assert.equal(offsetAfterLine1, Buffer.byteLength(line1 + "\n", "utf8"), "offset must be a byte offset, not a UTF-16 code-unit count");

  const line2 = JSON.stringify({ v: 1, runId: "u1", at: 2, seq: 1, kind: "state", state: "next" });
  fs.appendFileSync(file, `${line2}\n`);

  const resumed = readEvents(file, offsetAfterLine1);
  assert.equal(resumed.events.length, 1);
  assert.equal(resumed.events[0].state, "next", "resuming from the reported offset must land exactly on the next line");
});

const T0 = 1_700_000_000_000;
/** @param {Record<string, unknown>[]} list */
const evs = (list) => list.map((e, i) => ({ v: 1, runId: "r", seq: i, at: T0 + i, ...e }));
const cs = (/** @type {string} */ callId, /** @type {string} */ provider, /** @type {number} */ at, extra = {}) => ({ kind: "call_start", callId, provider, at, ...extra });
const ce = (/** @type {string} */ callId, /** @type {string} */ provider, /** @type {number} */ at, extra = {}) => ({ kind: "call_end", callId, provider, at, isError: false, ...extra });
const fan = (/** @type {string[]} */ providers) => ({ kind: "run_start", tool: "ask-all", workflow: "fanout", pid: 7, procStartedAt: 1, providers, at: T0 });
const never = () => { throw new Error("isAlive must not be consulted"); };

test("DS1: deriveStatus - one row per rule", () => {
  /** @type {[string, Record<string, unknown>[], number, Function, Record<string, unknown>][]} */
  const rows = [
    ["run_end wins", evs([runStart({ at: T0 }), { kind: "run_end", status: "unresolved", stopReason: "max-rounds", at: T0 + 9 }]), T0 + 1e9, never,
      { status: "unresolved", endedAt: T0 + 9, stopReason: "max-rounds" }],
    ["fan-out: every listed provider's latest call ended", evs([fan(["a", "b"]), cs("a-1", "a", T0 + 1), cs("b-2", "b", T0 + 2), ce("a-1", "a", T0 + 5), ce("b-2", "b", T0 + 20)]), T0 + 30, never,
      { status: "done", endedAt: T0 + 20, stopReason: null }],
    ["fan-out: a retry still in flight after an errored first call", evs([fan(["a"]), cs("a-1", "a", T0 + 1), ce("a-1", "a", T0 + 2, { isError: true, errorKind: "network" }), cs("a-2", "a", T0 + 3)]), T0 + 3 * QUIET_MS, () => true,
      { status: "running", endedAt: null, stopReason: null }],
    ["fan-out: quiet with an undispatched provider", evs([fan(["a", "b"]), cs("a-1", "a", T0 + 1), ce("a-1", "a", T0 + 10)]), T0 + 10 + QUIET_MS, never,
      { status: "done", endedAt: T0 + 10, stopReason: null, undispatched: ["b"] }],
    ["fan-out: not yet quiet", evs([fan(["a", "b"]), cs("a-1", "a", T0 + 1), ce("a-1", "a", T0 + 10)]), T0 + 9 + QUIET_MS, () => true,
      { status: "running", endedAt: null, stopReason: null }],
    ["fan-out: never dispatched", evs([fan(["a", "b"])]), T0 + NEVER_DISPATCHED_MS + 1, never,
      { status: "abandoned", endedAt: null, stopReason: "never-dispatched" }],
    ["fan-out: not dispatched yet", evs([fan(["a", "b"])]), T0 + NEVER_DISPATCHED_MS, () => true,
      { status: "running", endedAt: null, stopReason: null }],
    ["consensus-step: expired", evs([runStart({ tool: "consensus-step", workflow: "consensus-step", at: T0 }), { kind: "state", state: "init", at: T0 + 5 }]), T0 + 5 + DEFAULT_TTL_MS + 1, never,
      { status: "abandoned", endedAt: null, stopReason: "expired" }],
    ["consensus-step: within the loop TTL", evs([runStart({ tool: "consensus-step", workflow: "consensus-step", at: T0 }), { kind: "state", state: "init", at: T0 + 5 }]), T0 + 5 + DEFAULT_TTL_MS, () => true,
      { status: "running", endedAt: null, stopReason: null }],
    ["dead pid", evs([runStart({ pid: 5555, at: T0 })]), T0 + 1, () => false,
      { status: "abandoned", endedAt: null, stopReason: null }],
    ["live pid", evs([runStart({ pid: 5555, at: T0 })]), T0 + 1e9, () => true,
      { status: "running", endedAt: null, stopReason: null }],
  ];
  for (const [name, events, now, alive, want] of rows) {
    assert.deepEqual(deriveStatus(events, now, /** @type {any} */ (alive)), want, name);
  }
});

test("RR12: a cached run's status is re-derived on every read, without a file change", () => {
  const runsDir = tmpDir();
  writeRun(runsDir, "live-pid", [runStart({})]);
  writeRun(runsDir, "step", [{ ...runStart({ tool: "consensus-step", workflow: "consensus-step" }), at: T0 }]);
  let alive = true;
  let clock = T0 + 1;
  const index = createRunIndex({ runsDir, isAlive: () => alive, now: () => clock });
  const statusOf = (/** @type {string} */ id) => index.list().find((r) => r.runId === id)?.status;
  assert.equal(statusOf("live-pid"), "running");
  assert.equal(statusOf("step"), "running");
  alive = false;
  assert.equal(statusOf("live-pid"), "abandoned", "the writer died; the file never changes");
  alive = true;
  clock = T0 + DEFAULT_TTL_MS + 1;
  assert.equal(statusOf("step"), "abandoned");
  assert.equal(index.get("step")?.summary.stopReason, "expired");
  assert.deepEqual(index.list({ status: "abandoned" }).map((r) => r.runId), ["step"]);
});

test("RR13: errors count a call's final attempt only", () => {
  const retried = summarize(evs([fan(["a"]), cs("a-1", "a", T0 + 1, { role: "peer", round: 1 }), ce("a-1", "a", T0 + 2, { isError: true }), cs("a-2", "a", T0 + 3, { role: "peer", round: 1 }), ce("a-2", "a", T0 + 4)]), () => true, T0 + 5);
  assert.equal(retried.errors, 0, "an errored attempt followed by a successful retry is not an error");
  const failedTwice = summarize(evs([fan(["a"]), cs("a-1", "a", T0 + 1), ce("a-1", "a", T0 + 2, { isError: true }), cs("a-2", "a", T0 + 3), ce("a-2", "a", T0 + 4, { isError: true })]), () => true, T0 + 5);
  assert.equal(failedTwice.errors, 1);
  // Two concurrent arbiter legs in one round: the second started before the first failed, so it is not its retry.
  const concurrent = summarize(evs([runStart({ workflow: "consensus" }), cs("x-1", "x", T0 + 1, { role: "arbiter", round: 1 }), cs("x-2", "x", T0 + 2, { role: "arbiter", round: 1 }), ce("x-1", "x", T0 + 3, { isError: true }), ce("x-2", "x", T0 + 4)]), () => true, T0 + 5);
  assert.equal(concurrent.errors, 1);
  const otherRound = summarize(evs([runStart({ workflow: "consensus" }), cs("x-1", "x", T0 + 1, { role: "peer", round: 1 }), ce("x-1", "x", T0 + 2, { isError: true }), cs("x-2", "x", T0 + 3, { role: "peer", round: 2 }), ce("x-2", "x", T0 + 4)]), () => true, T0 + 5);
  assert.equal(otherRound.errors, 1, "the next round's call is not a retry");
});

test("RR14: q matches the redacted prompt when asked to", () => {
  const runsDir = tmpDir();
  writeRun(runsDir, "pii", [runStart({ prompt: "mail alice@example.com about it" }), runEnd({})]);
  const index = createRunIndex({ runsDir });
  assert.equal(index.list({ q: "alice@example" }).length, 1);
  assert.equal(index.list({ q: "alice@example", redacted: true }).length, 0, "a search cannot confirm a masked value");
  assert.equal(index.list({ q: "mail [email]", redacted: true }).length, 1);
});

test("RR15: run summaries carry the run_start project; ?project= filters by id, `unknown` matches runs without one", () => {
  const dir = tmpDir();
  const app = { id: "aaaaaaaaaaaa", name: "app", root: "/x/app" };
  writeRun(dir, "r-app", [runStart({ project: app }), callEnd({}), runEnd({})]);
  writeRun(dir, "r-none", [runStart({}), callEnd({}), runEnd({})]);
  writeRun(dir, "r-bad", [runStart({ project: "/raw" }), runEnd({})]);
  const index = createRunIndex({ runsDir: dir, isAlive: () => false });
  const all = index.list();
  assert.deepEqual(all.find((r) => r.runId === "r-app")?.project, app);
  assert.equal(all.find((r) => r.runId === "r-none")?.project, null);
  assert.equal(all.find((r) => r.runId === "r-bad")?.project, null);
  assert.deepEqual(index.list({ project: app.id }).map((r) => r.runId), ["r-app"]);
  assert.deepEqual(index.list({ project: "unknown" }).map((r) => r.runId).sort(), ["r-bad", "r-none"]);
});
