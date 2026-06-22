// test/core-debug-log.test.js
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const { NULL_LOGGER, createFileLogger, composeLoggers, sanitizeEvent, ALLOWED_KEYS } = require("../core/debug-log.js");
const { askAll, askOne } = require("../core/orchestrate.js");

/** @param {string} name @param {object} [extra] */
function fakeProvider(name, extra = {}) {
  return /** @type {any} */ ({
    name,
    capabilities: { canImplement: false, fileUpload: false, multiTurn: false },
    async health() { return { ok: true }; },
    async ask(/** @type {any} */ _req) {
      return { provider: name, model: `${name}-m`, text: "ok", isError: false, ms: 5, reasoningEffort: "high", ...extra };
    },
  });
}

/** A capturing stub logger. */
function stubLogger() {
  /** @type {any[]} */
  const events = [];
  return { events, logEvent(/** @type {any} */ e) { events.push(e); } };
}

test("D1: NULL_LOGGER.logEvent is a no-op and never throws", () => {
  assert.doesNotThrow(() => NULL_LOGGER.logEvent({ event: "x", at: 1 }));
});

test("D2: sanitizeEvent drops any key outside the whitelist (no prompt/response leak)", () => {
  const out = sanitizeEvent(/** @type {any} */ ({
    event: "provider_result", at: 1, provider: "grok", ms: 10,
    prompt: "SECRET PROMPT", response: "SECRET RESPONSE", text: "SECRET", description: "issue text",
  }));
  assert.deepEqual(Object.keys(out).sort(), ["at", "event", "ms", "provider"].sort());
  for (const k of ["prompt", "response", "text", "description"]) {
    assert.ok(!(k in out), `disallowed key ${k} must be stripped`);
  }
  // whitelist sanity: every allowed key is actually permitted through
  assert.ok(ALLOWED_KEYS.includes("usage") && ALLOWED_KEYS.includes("verdict"));
});

test("D3: createFileLogger appends one sanitized JSON line per event", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delib-dbg-"));
  const file = path.join(dir, "debug.jsonl");
  const logger = createFileLogger(file);
  logger.logEvent(/** @type {any} */ ({ event: "provider_result", at: 1, provider: "grok", ms: 10, prompt: "LEAK" }));
  logger.logEvent({ event: "round", at: 2, round: 1, verdict: "APPROVE" });
  const lines = fs.readFileSync(file, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  const first = JSON.parse(lines[0]);
  assert.equal(first.provider, "grok");
  assert.ok(!("prompt" in first), "prompt must never be written");
  assert.equal(JSON.parse(lines[1]).verdict, "APPROVE");
});

test("D4: createFileLogger never throws on an unwritable path", () => {
  const logger = createFileLogger("/this/path/should/not/exist/debug.jsonl");
  assert.doesNotThrow(() => logger.logEvent({ event: "round", at: 1 }));
});

test("D5: composeLoggers fans out to every sink and isolates a throwing sink", () => {
  const a = stubLogger();
  const bad = { logEvent() { throw new Error("boom"); } };
  const c = stubLogger();
  const composite = composeLoggers([a, bad, c]);
  assert.doesNotThrow(() => composite.logEvent({ event: "round", at: 1 }));
  assert.equal(a.events.length, 1);
  assert.equal(c.events.length, 1);
});

test("D6: composeLoggers with no real sinks returns the no-op logger", () => {
  assert.equal(composeLoggers([]), NULL_LOGGER);
  assert.equal(composeLoggers(/** @type {any} */ ([null, {}])), NULL_LOGGER);
});

test("D7: askAll emits one provider_result event per provider with the right tool", async () => {
  const log = stubLogger();
  await askAll([fakeProvider("a"), fakeProvider("b")], { prompt: "q" }, { logger: log, tool: "ask-all" });
  assert.equal(log.events.length, 2);
  for (const e of log.events) {
    assert.equal(e.event, "provider_result");
    assert.equal(e.tool, "ask-all");
    assert.equal(e.reasoningEffort, "high");
    assert.equal(typeof e.ms, "number");
    assert.ok(!("text" in e), "result text must never reach the event");
  }
});

test("D8: askOne emits a single provider_result event", async () => {
  const log = stubLogger();
  await askOne(fakeProvider("solo"), { prompt: "q" }, { logger: log, tool: "ask-one" });
  assert.equal(log.events.length, 1);
  assert.equal(log.events[0].tool, "ask-one");
  assert.equal(log.events[0].provider, "solo");
});

test("D9: askAll defaults to the no-op logger (no opts) and still returns results", async () => {
  const out = await askAll([fakeProvider("a")], { prompt: "q" });
  assert.equal(out.length, 1);
  assert.equal(out[0].isError, false);
});

test("D-persistfail: a persist_failed event survives the whitelist with ONLY content-free keys", () => {
  // The consensus-step failure telemetry must carry its correlation fields
  // (errorCode, loopSessionId) through sanitizeEvent, and nothing else.
  assert.ok(ALLOWED_KEYS.includes("errorCode"), "errorCode is whitelisted");
  assert.ok(ALLOWED_KEYS.includes("loopSessionId"), "loopSessionId is whitelisted");
  const out = sanitizeEvent(/** @type {any} */ ({
    event: "persist_failed",
    at: 123,
    tool: "consensus",
    errorCode: "EACCES",
    loopSessionId: "loop-abc",
    // content that must be dropped even if a caller over-populates the event:
    prompt: "SECRET PLAN TEXT",
    parts: { opinions: ["leaky"] },
    verdictText: "free text",
  }));
  // deepEqual proves the projection carries EXACTLY the content-free keys -
  // prompt/parts/verdictText were dropped.
  assert.deepEqual(out, { event: "persist_failed", at: 123, tool: "consensus", errorCode: "EACCES", loopSessionId: "loop-abc" });
});
