"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");

const { redact, redactString } = require("../core/redact.js");

test("RD1: email masked", () => {
  assert.equal(redactString("contact a.b@example.com now"), "contact [email] now");
});

test("RD2: home dir and bare username masked", () => {
  const opts = { home: "/home/alice", username: "alice" };
  assert.equal(redactString("/home/alice/src/x.js", opts), "~/src/x.js");
  assert.equal(redactString("C:\\Users\\alice\\x", opts), "C:\\Users\\[user]\\x");
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
