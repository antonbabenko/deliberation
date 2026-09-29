"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");

const { redact, redactString } = require("../core/redact.js");

test("RD1: email masked", () => {
  assert.equal(redactString("contact a.b@example.com now"), "contact [email] now");
});

test("RD2: home dir and the username inside a home path masked", () => {
  const opts = { home: "/home/alice", username: "alice" };
  assert.equal(redactString("/home/alice/src/x.js", opts), "~/src/x.js");
  assert.equal(redactString("C:\\Users\\alice\\x", opts), "~\\x");
  assert.equal(redactString("C:/Users/alice/x", opts), "~/x");
  assert.equal(redactString("/Users/alice", opts), "~");
});

test("RD7: the username is masked only in a home path, never as a bare word", () => {
  const opts = { home: "/var/empty", username: "root" };
  assert.equal(redactString("root cause analysis", opts), "root cause analysis");
  assert.equal(redactString("see /home/root/x", opts), "see ~/x");
  assert.equal(redactString("/home/rooted/x", opts), "/home/rooted/x", "a longer name is someone else");
});

test("RD8: values under id keys are never redacted", () => {
  const runId = "0b9f3c1e-8d2a-4c5b-9e7f-123456789012"; // all-digit last group looks like an account id
  const out = /** @type {any} */ (redact({ runId, callId: "gpt-123456789012", sessionId: runId, loopSessionId: runId, id: runId, nested: [{ runId }], note: "acct 123456789012" }));
  for (const k of ["runId", "sessionId", "loopSessionId", "id"]) assert.equal(out[k], runId, k);
  assert.equal(out.callId, "gpt-123456789012");
  assert.equal(out.nested[0].runId, runId);
  assert.equal(out.note, "acct [account-id]", "other strings are still masked");
});

test("RD3: IPv4 and IPv6 masked", () => {
  assert.equal(redactString("host 10.1.2.3 up"), "host [ip] up");
  assert.equal(redactString("host 2001:db8::1 up"), "host [ip] up");
});

test("RD4: 12-digit account id masked, 13-digit number untouched", () => {
  assert.equal(redactString("acct 123456789012 ok"), "acct [account-id] ok");
  assert.equal(redactString("ts 1234567890123 ok"), "ts 1234567890123 ok");
});

test("RD5: nested structures redacted, input not mutated", () => {
  const input = { a: [{ b: "x@y.io" }] };
  const out = redact(input);
  assert.deepEqual(out, { a: [{ b: "[email]" }] });
  assert.equal(input.a[0].b, "x@y.io");
});

test("RD6: version strings and timestamps left alone", () => {
  assert.equal(redactString("v3.18.0"), "v3.18.0");
  assert.equal(redactString("at 1727500000000"), "at 1727500000000");
  assert.equal(redact(42), 42);
  assert.equal(redact(null), null);
  assert.equal(redact(true), true);
});
