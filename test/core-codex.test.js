// test/core-codex.test.js
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { makeCodexProvider } = require("../core/providers/codex.js");

test("CX1: ask returns the captured stdout as text on exit 0", async () => {
  const p = makeCodexProvider({ run: async () => ({ code: 0, stdout: "codex says hi", stderr: "" }) });
  const r = await p.ask({ prompt: "hi" });
  assert.equal(r.isError, false);
  assert.equal(r.provider, "codex");
  assert.equal(r.text, "codex says hi");
});

test("CX2: a non-zero exit is a normalized error result", async () => {
  const p = makeCodexProvider({ run: async () => ({ code: 1, stdout: "", stderr: "auth required" }) });
  const r = await p.ask({ prompt: "x" });
  assert.equal(r.isError, true);
  assert.equal(r.errorKind, "auth");
});

test("CX3: capabilities.canImplement true (Core still calls advisory only)", () => {
  assert.equal(makeCodexProvider({ run: async () => ({ code: 0, stdout: "", stderr: "" }) }).capabilities.canImplement, true);
});

test("CX4: a non-zero exit surfaces stdout in .message (diagnostic detail not lost; error has no text)", async () => {
  const p = makeCodexProvider({ run: async () => ({ code: 1, stdout: "diagnostic detail from codex", stderr: "boom" }) });
  const r = await p.ask({ prompt: "x" });
  assert.equal(r.isError, true);
  assert.equal(r.errorKind, "unknown");
  assert.equal("text" in r, false); // error results carry no text key
  assert.equal(/** @type {any} */ (r).message, "diagnostic detail from codex");
});
