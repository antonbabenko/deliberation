// test/core-provider.test.js
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  toErrorResult,
  classifyFetchFailure,
} = require("../core/provider.js");

test("P1: toErrorResult normalizes a thrown error via the bridge classifier", () => {
  const classify = (/** @type {any} */ status) => ({ errorKind: status === 429 ? "rate-limit" : "unknown", retryable: status === 429 });
  const r = toErrorResult("openrouter", "x/y", Date.now() - 5, { status: 429 }, classify);
  assert.equal(r.provider, "openrouter");
  assert.equal(r.model, "x/y");
  assert.equal(r.isError, true);
  assert.equal(r.errorKind, "rate-limit");
  assert.equal(r.retryable, true);
  assert.equal("text" in r, false); // error results carry no text key
  assert.ok(r.ms >= 0);
});

// --- Retry-After ---

const { parseRetryAfterMs } = require("../core/provider.js");

test("RA1: delta-seconds parses to ms", () => {
  assert.equal(parseRetryAfterMs("30"), 30000);
  assert.equal(parseRetryAfterMs("  0 "), 0);
});

test("RA2: an HTTP-date parses to a non-negative delta", () => {
  const soon = new Date(Date.now() + 20000).toUTCString();
  const ms = /** @type {number} */ (parseRetryAfterMs(soon));
  assert.ok(ms > 5000 && ms <= 20000, `expected ~20s, got ${ms}`);
  // A date already in the past clamps to 0 rather than going negative.
  assert.equal(parseRetryAfterMs(new Date(Date.now() - 60000).toUTCString()), 0);
});

test("RA3: missing or unparseable values yield undefined", () => {
  for (const v of [undefined, null, "", "   ", "soon", "-5", "1.5", 30]) {
    assert.equal(parseRetryAfterMs(/** @type {any} */ (v)), undefined, `${JSON.stringify(v)} -> undefined`);
  }
});

test("RA4: toErrorResult forwards retryAfterMs and omits it when absent", () => {
  const classify = () => ({ errorKind: "rate-limit", retryable: true });
  const withHint = toErrorResult("grok", "m", Date.now(), { status: 429, retryAfterMs: 4000 }, classify);
  assert.equal(withHint.retryAfterMs, 4000);
  const without = toErrorResult("grok", "m", Date.now(), { status: 429 }, classify);
  assert.ok(!("retryAfterMs" in without), "absent hint adds no key");
});

test("RA5: toErrorResult forwards the bridge's message, truncated, and omits it when absent", () => {
  // Issue #180: the Gemini bridge said exactly why it failed ("2 chars, below the 80-char
  // answer floor: ok"), but the unified envelope carried only errorKind, so the operator
  // saw an opaque `empty` and spent hours instrumenting the sandbox. Forward the reason.
  const classify = () => ({ errorKind: "empty", retryable: true });
  const withMsg = toErrorResult("gemini", "m", Date.now(), new Error("agy returned a stub, not an answer (2 chars): ok"), classify);
  assert.equal(withMsg.message, "agy returned a stub, not an answer (2 chars): ok");
  const long = String(toErrorResult("gemini", "m", Date.now(), new Error("x".repeat(2000)), classify).message);
  assert.ok(long.length <= 503, "bounded: " + long.length);
  assert.ok(long.endsWith("..."), "truncation is visible");
  const without = toErrorResult("gemini", "m", Date.now(), { status: 500 }, classify);
  assert.ok(!("message" in without), "no message adds no key");
  const blank = toErrorResult("gemini", "m", Date.now(), new Error(""), classify);
  assert.ok(!("message" in blank), "empty message adds no key");
});

test("RA6: the forwarded message is plain text - ANSI sequences and control bytes are stripped", () => {
  const classify = () => ({ errorKind: "unknown", retryable: false });
  const raw = "\x1b[31mError:\x1b[0m invalid model \x1b]0;title\x07selection\x07\x00 (see list)\r\n  next";
  const r = toErrorResult("gemini", "m", Date.now(), new Error(raw), classify);
  assert.equal(r.message, "Error: invalid model selection (see list)\n  next");
  const onlyControls = toErrorResult("gemini", "m", Date.now(), new Error("\x1b[2J\x07"), classify);
  assert.ok(!("message" in onlyControls), "nothing left after stripping adds no key");
});

// --- fetch failure classification -----------------------------------------

test("FF1: a wrapped abort (TypeError: terminated + cause AbortError) is a timeout", () => {
  // undici does NOT always reject with the AbortError itself: when the controller fires
  // during the body/stream read it rejects with `TypeError: terminated` whose `cause` is
  // a DOMException named AbortError. Classifying that as `network` makes it RETRYABLE,
  // so the call pays a second full ceiling - the exact double-billing the timeout
  // classification exists to prevent.
  const e = new TypeError("terminated");
  e.cause = new DOMException("This operation was aborted", "AbortError");
  assert.deepEqual(classifyFetchFailure(e), { code: "timeout", transportCode: "AbortError" });
});

test("FF2: a DOMException's numeric legacy `code` never leaks as the transport code", () => {
  const e = new TypeError("terminated");
  e.cause = new DOMException("aborted", "AbortError");
  assert.equal(/** @type {any} */ (e.cause).code, 20, "the legacy numeric code is present and must be skipped");
  assert.equal(classifyFetchFailure(e).transportCode, "AbortError");
});

test("FF3: undici ceilings are timeouts; a real transport fault stays network", () => {
  const undici = (/** @type {string} */ code) => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(code), { code }) });
  assert.equal(classifyFetchFailure(undici("UND_ERR_HEADERS_TIMEOUT")).code, "timeout");
  assert.equal(classifyFetchFailure(undici("UND_ERR_BODY_TIMEOUT")).code, "timeout");
  assert.equal(classifyFetchFailure(undici("ECONNRESET")).code, "network");
  assert.equal(classifyFetchFailure(undici("ENOTFOUND")).transportCode, "ENOTFOUND");
});
