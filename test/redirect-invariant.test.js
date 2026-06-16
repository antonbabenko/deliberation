"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// Bridge files that make outbound HTTP via `f(url, opts)` (f = fetchImpl || globalThis.fetch).
const FILES = ["server/grok/index.js", "server/grok/files-admin.js", "server/openrouter/index.js"];

test("every outbound bridge fetch sets redirect:error (no bearer token follows a 3xx)", () => {
  for (const rel of FILES) {
    const src = fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
    // Count actual outbound invocations: `await f(` is the fetch call shape in all
    // three bridges. The assignment line `const f = fetchImpl || globalThis.fetch`
    // is NOT an invocation and is not matched here.
    const invocations = (src.match(/\bawait f\(/g) || []).length;
    const guarded = (src.match(/redirect:\s*["']error["']/g) || []).length;
    assert.ok(invocations > 0, `${rel}: expected at least one outbound fetch`);
    assert.equal(
      guarded,
      invocations,
      `${rel}: ${invocations} fetch invocation(s) but ${guarded} redirect:error guard(s) — a fetch is missing redirect:"error"`,
    );
  }
});
