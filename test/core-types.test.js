// test/core-types.test.js
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");

test("T1: core/types.js loads without throwing (pure typedef module)", () => {
  const m = require("../core/types.js");
  assert.equal(typeof m, "object");
});
