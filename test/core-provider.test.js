// test/core-provider.test.js
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { toErrorResult, OPINION_SCHEMA, validateOpinion } = require("../core/provider.js");

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

test("P2: OPINION_SCHEMA requires recommendation + confidence", () => {
  assert.deepEqual(OPINION_SCHEMA.required, ["recommendation", "confidence"]);
});

test("P3: validateOpinion accepts a minimal opinion, rejects a missing field", () => {
  assert.equal(validateOpinion({ recommendation: "ship it", confidence: "high" }).ok, true);
  const bad = validateOpinion({ recommendation: "ship it" });
  assert.equal(bad.ok, false);
  assert.match(String(bad.reason), /confidence/);
});
