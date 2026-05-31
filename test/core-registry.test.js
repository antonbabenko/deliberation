"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { makeRegistry } = require("../core/registry.js");

/** @param {string} name @returns {import("../core/types.js").Provider} */
function prov(name) {
  return /** @type {any} */ ({ name, capabilities: {}, async health() { return { ok: true }; }, async ask() { return { provider: name, model: "m", isError: false, ms: 0 }; } });
}

const config = {
  providers: { codex: { enabled: true }, gemini: { enabled: false }, grok: { enabled: true } },
  openrouter: {
    maxFanout: 2,
    models: [
      { alias: "all-on", model: "a/x", experts: null, askAll: true, consensus: true },
      { alias: "arch", model: "a/y", experts: ["architect"], askAll: true, consensus: false },
      { alias: "off", model: "a/z", experts: null, askAll: false, consensus: true },
    ],
  },
};

test("G1: get returns a registered provider by name", () => {
  const reg = makeRegistry([prov("codex"), prov("grok")]);
  assert.equal(/** @type {any} */ (reg.get("grok")).name, "grok");
  assert.equal(reg.get("nope"), undefined);
});

test("G2: selectForAskAll = enabled built-ins + per-alias OR wrappers, capped", () => {
  const reg = makeRegistry([prov("codex"), prov("gemini"), prov("grok"), prov("openrouter")]);
  const { providers, omitted } = reg.selectForAskAll({ config, expert: "architect" });
  // gemini disabled; OR "off" excluded; cap 2 -> all-on, arch. Names carry the alias.
  assert.deepEqual(providers.map((p) => p.name), ["codex", "grok", "openrouter:all-on", "openrouter:arch"]);
  assert.deepEqual(omitted.map((m) => m.alias), []);
});

test("G3: a disabled (askAll:false) OR model is never in the fan-out - issue 001 regression", () => {
  const reg = makeRegistry([prov("codex"), prov("openrouter")]);
  const { providers } = reg.selectForAskAll({ config, expert: "architect" });
  assert.equal(providers.some((p) => p.name === "openrouter:off"), false);
});

test("G4: a per-alias OR wrapper injects the alias model into ask() and renames provider", async () => {
  let gotModel;
  const orp = /** @type {any} */ ({ name: "openrouter", capabilities: {}, async health() { return { ok: true }; },
    async ask(/** @type {any} */ req) { gotModel = req.model; return { provider: "openrouter", model: req.model, isError: false, ms: 0 }; } });
  const reg = makeRegistry([orp]);
  const { providers } = reg.selectForAskAll({ config, expert: "architect" });
  const wrapped = /** @type {any} */ (providers.find((p) => p.name === "openrouter:all-on"));
  const r = await wrapped.ask({ prompt: "x" });
  assert.equal(gotModel, "a/x");                 // alias model pinned
  assert.equal(r.provider, "openrouter:all-on"); // result re-labelled with the alias
});

test("G4b: a per-alias OR wrapper forwards the delegate's reasoning_effort/temperature/timeout to ask()", async () => {
  /** @type {any} */
  let gotReq;
  const orp = /** @type {any} */ ({ name: "openrouter", capabilities: {}, async health() { return { ok: true }; },
    async ask(/** @type {any} */ req) { gotReq = req; return { provider: "openrouter", model: req.model, isError: false, ms: 0 }; } });
  const cfg = {
    providers: {},
    openrouter: { maxFanout: 2, models: [
      { alias: "tuned", model: "a/t", experts: null, askAll: true, consensus: true, reasoning_effort: "high", temperature: 0.2, timeout: 60000 },
    ] },
  };
  const reg = makeRegistry([orp]);
  const { providers } = reg.selectForAskAll({ config: cfg, expert: "architect" });
  const wrapped = /** @type {any} */ (providers.find((p) => p.name === "openrouter:tuned"));
  await wrapped.ask({ prompt: "x" });
  assert.equal(gotReq.model, "a/t");
  // wire/config field names mapped to the DelegationRequest fields openai-compatible.js reads
  assert.equal(gotReq.reasoningEffort, "high");
  assert.equal(gotReq.temperature, 0.2);
  assert.equal(gotReq.timeoutMs, 60000);
});

test("G4c: explicit caller params win over the delegate's configured params (arg-wins)", async () => {
  /** @type {any} */
  let gotReq;
  const orp = /** @type {any} */ ({ name: "openrouter", capabilities: {}, async health() { return { ok: true }; },
    async ask(/** @type {any} */ req) { gotReq = req; return { provider: "openrouter", model: req.model, isError: false, ms: 0 }; } });
  const cfg = {
    providers: {},
    openrouter: { maxFanout: 2, models: [
      { alias: "tuned", model: "a/t", experts: null, askAll: true, consensus: true, reasoning_effort: "high", temperature: 0.2, timeout: 60000 },
    ] },
  };
  const reg = makeRegistry([orp]);
  const { providers } = reg.selectForAskAll({ config: cfg, expert: "architect" });
  const wrapped = /** @type {any} */ (providers.find((p) => p.name === "openrouter:tuned"));
  await wrapped.ask({ prompt: "x", reasoningEffort: "low", temperature: 0.9, timeoutMs: 1000 });
  assert.equal(gotReq.reasoningEffort, "low");
  assert.equal(gotReq.temperature, 0.9);
  assert.equal(gotReq.timeoutMs, 1000);
});

test("G5: selectForConsensus = built-ins + per-alias OR consensus delegates, uncapped", () => {
  const reg = makeRegistry([prov("codex"), prov("gemini"), prov("grok"), prov("openrouter")]);
  const { providers } = reg.selectForConsensus({ config, expert: "architect" });
  // consensus===true: all-on, off. (arch is consensus:false.) gemini disabled. Uncapped.
  assert.deepEqual(providers.map((p) => p.name), ["codex", "grok", "openrouter:all-on", "openrouter:off"]);
});
