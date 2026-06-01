"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { makeGrokProvider } = require("../core/providers/grok.js");

const fakeBridge = {
  buildInitialTurns: (/** @type {any} */ sys, /** @type {any} */ prompt) => [{ role: "system", text: sys }, { role: "user", text: prompt }],
  runGrok: async (/** @type {any} */ { model }) => ({ text: `grok ${model}`, output: null }),       // real shape: { text, output }
  runWithFiles: async (/** @type {any} */ { model }) => ({ text: `grok+files ${model}`, output: null, refs: [], ownedIds: [] }),
  classifyGrokError: (/** @type {any} */ status) => ({ errorKind: status === 401 ? "auth" : "unknown", retryable: false }),
  resolveReasoningEffort: (/** @type {any} */ e) => e || "high",
};

test("GK1: capabilities.fileUpload is true, multiTurn is false (not wired through Core)", () => {
  const caps = makeGrokProvider({ bridge: fakeBridge }).capabilities;
  assert.equal(caps.fileUpload, true);
  assert.equal(caps.multiTurn, false);
});

test("GK2: ask with no files uses runGrok and returns success text", async () => {
  process.env.XAI_API_KEY = "k";
  const p = makeGrokProvider({ bridge: fakeBridge, model: "grok-4.3" });
  const r = await p.ask({ prompt: "hi" });
  assert.equal(r.isError, false);
  assert.equal(r.provider, "grok");
  assert.equal(r.text, "grok grok-4.3");
});

test("GK3: ask WITH files routes through runWithFiles", async () => {
  process.env.XAI_API_KEY = "k";
  const p = makeGrokProvider({ bridge: fakeBridge, model: "grok-4.3" });
  const r = await p.ask({ prompt: "hi", files: [{ path: "x.js", mode: "auto" }] });
  assert.equal(/** @type {any} */ (r).text, "grok+files grok-4.3");
});

test("GK4: missing XAI_API_KEY -> health false", async () => {
  delete process.env.XAI_API_KEY;
  assert.equal((await makeGrokProvider({ bridge: fakeBridge }).health()).ok, false);
});

test("GK5: a thrown bridge call -> normalized error via classifyGrokError", async () => {
  process.env.XAI_API_KEY = "k";
  const throwing = { ...fakeBridge, runGrok: async () => { const e = /** @type {any} */ (new Error("no")); e.status = 401; throw e; } };
  const r = await makeGrokProvider({ bridge: throwing }).ask({ prompt: "x" });
  assert.equal(r.isError, true);
  assert.equal(r.errorKind, "auth");
});

test("GK6: req.apiKey overrides process.env.XAI_API_KEY; absent -> falls back to env", async () => {
  let seen;
  const capturing = { ...fakeBridge, runGrok: async (/** @type {any} */ a) => { seen = a.apiKey; return { text: "ok", output: null }; } };
  process.env.XAI_API_KEY = "env-key";
  const p = makeGrokProvider({ bridge: capturing, model: "grok-4.3" });

  await p.ask({ prompt: "hi", apiKey: "tenant-key" });
  assert.equal(seen, "tenant-key"); // per-request override wins

  await p.ask({ prompt: "hi" });
  assert.equal(seen, "env-key"); // no override -> process.env fallback
});
