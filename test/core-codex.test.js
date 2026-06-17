// test/core-codex.test.js
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { makeCodexProvider, codexExecArgs } = require("../core/providers/codex.js");

test("CX5: codexExecArgs defaults to --sandbox read-only (advisory cannot inherit a writable global default)", () => {
  assert.deepEqual(codexExecArgs(), ["exec", "--sandbox", "read-only", "--skip-git-repo-check"]);
  assert.deepEqual(codexExecArgs("advisory"), ["exec", "--sandbox", "read-only", "--skip-git-repo-check"]);
});

test("CX-impl-1: codexExecArgs('implement') opts into --sandbox workspace-write", () => {
  assert.deepEqual(codexExecArgs("implement"), ["exec", "--sandbox", "workspace-write", "--skip-git-repo-check"]);
});

test("CX-impl-2: only the exact string 'implement' opens writes (gate is structural)", () => {
  for (const m of [undefined, "advisory", "workspace-write", "IMPLEMENT", "", "x"]) {
    assert.deepEqual(codexExecArgs(/** @type {any} */ (m))[2], "read-only", `mode=${String(m)} must stay read-only`);
  }
});

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

test("CX3: capabilities.canImplement reflects the construction lock (default off)", () => {
  assert.equal(makeCodexProvider({ run: async () => ({ code: 0, stdout: "", stderr: "" }) }).capabilities.canImplement, false);
  assert.equal(makeCodexProvider({ allowImplement: true, run: async () => ({ code: 0, stdout: "", stderr: "" }) }).capabilities.canImplement, true);
});

test("CX-gate-deny: req.mode 'implement' WITHOUT the construction lock stays read-only", async () => {
  let seen;
  const run = async (/** @type {any} */ a) => { seen = a.mode; return { code: 0, stdout: "", stderr: "" }; };
  await makeCodexProvider({ run }).ask({ prompt: "x", mode: "implement" });
  assert.equal(seen, "advisory");
});

test("CX-gate-open: both locks (allowImplement + mode 'implement') forward implement to run", async () => {
  let seen;
  const run = async (/** @type {any} */ a) => { seen = a.mode; return { code: 0, stdout: "", stderr: "" }; };
  const p = makeCodexProvider({ allowImplement: true, run });
  await p.ask({ prompt: "x", mode: "implement" });
  assert.equal(seen, "implement");
  // lock on, but no mode -> still advisory
  await p.ask({ prompt: "x" });
  assert.equal(seen, "advisory");
});

test("CX-fs: capabilities.walksFilesystem is true (codex walks cwd under read-only)", () => {
  assert.equal(makeCodexProvider().capabilities.walksFilesystem, true);
});

test("CX4: a non-zero exit surfaces stdout in .message (diagnostic detail not lost; error has no text)", async () => {
  const p = makeCodexProvider({ run: async () => ({ code: 1, stdout: "diagnostic detail from codex", stderr: "boom" }) });
  const r = await p.ask({ prompt: "x" });
  assert.equal(r.isError, true);
  assert.equal(r.errorKind, "unknown");
  assert.equal("text" in r, false); // error results carry no text key
  assert.equal(/** @type {any} */ (r).message, "diagnostic detail from codex");
});
