// test/dashboard-runs.test.js
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");

const { readEvents, summarize, createRunIndex } = require("../server/dashboard/runs.js");
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
    callEnd({ provider: "gpt", at: 10 }),
    callEnd({ provider: "grok", at: 20 }),
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

  const spy = t.mock.method(fs, "readFileSync");
  const first = index.list();
  assert.equal(first.length, 2);
  const afterFirst = spy.mock.callCount();
  assert.equal(afterFirst, 2, "one readFileSync per run file on first list()");

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
