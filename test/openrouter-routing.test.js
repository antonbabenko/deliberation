"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { askAllDelegates, consensusDelegates, resolveAlias } = require("../server/openrouter/routing.js");

function cfg() {
  return {
    maxFanout: 2,
    defaultModel: "openai/gpt-5.5",
    models: [
      { alias: "all-on", model: "a/x", experts: null, askAll: true, consensus: true },
      { alias: "arch", model: "a/y", experts: ["architect"], askAll: true, consensus: false },
      { alias: "none", model: "a/z", experts: [], askAll: true, consensus: true },
      { alias: "rev", model: "a/w", experts: ["researcher"], askAll: false, consensus: true },
    ],
  };
}

test("R1: askAll picks eligible models with askAll!=false, capped, in order", () => {
  const out = askAllDelegates(cfg(), "architect");
  assert.deepEqual(out.selected.map((m) => m.alias), ["all-on", "arch"]);
  assert.deepEqual(out.omitted.map((m) => m.alias), []);
});

test("R2: askAll truncates beyond maxFanout and reports omitted", () => {
  const c = cfg();
  c.maxFanout = 1;
  const out = askAllDelegates(c, "architect");
  assert.deepEqual(out.selected.map((m) => m.alias), ["all-on"]);
  assert.deepEqual(out.omitted.map((m) => m.alias), ["arch"]);
});

test("R3: experts:[] is never auto-eligible for askAll or consensus", () => {
  const all = askAllDelegates(cfg(), "researcher").selected.map((m) => m.alias);
  assert.equal(all.includes("none"), false);
  const con = consensusDelegates(cfg(), "researcher").map((m) => m.alias);
  assert.equal(con.includes("none"), false);
});

test("R4: consensus picks only consensus==true eligible models, NOT maxFanout-capped", () => {
  const c = cfg();
  c.maxFanout = 1;
  const out = consensusDelegates(c, "researcher").map((m) => m.alias);
  assert.deepEqual(out, ["all-on", "rev"]);
});

test("R5: resolveAlias finds a model; openrouter-default maps to defaultModel; unknown => null", () => {
  assert.equal(resolveAlias(cfg(), "arch").model, "a/y");
  assert.equal(resolveAlias(cfg(), "openrouter-default").model, "openai/gpt-5.5");
  assert.equal(resolveAlias(cfg(), "nope"), null);
});

test("R6: resolveAlias openrouter-default returns null when defaultModel unset", () => {
  const c = cfg();
  c.defaultModel = null;
  assert.equal(resolveAlias(c, "openrouter-default"), null);
});

test("R7: invalid maxFanout (0/negative/non-int) falls back to a cap of 3", () => {
  const c = cfg();
  // add 2 more eligible-for-architect models so a cap of 3 is observable
  c.models.push({ alias: "x4", model: "a/4", experts: null, askAll: true, consensus: false });
  c.models.push({ alias: "x5", model: "a/5", experts: null, askAll: true, consensus: false });
  for (const bad of [0, -1, 2.5]) {
    c.maxFanout = bad;
    assert.equal(askAllDelegates(c, "architect").selected.length, 3, `maxFanout=${bad} should fall back to 3`);
  }
});

test("R8: a model expert-eligible but askAll:false is excluded from askAll, still in consensus", () => {
  // Regression for the reported bug: deepseek-v4-pro/kimi-k2-thinking were dispatched by
  // /ask-all after being set askAll:false. `dis` is expert-eligible (experts:null) so this
  // isolates the askAll filter alone (R1's `rev` is also expert-filtered).
  const c = {
    maxFanout: 5,
    models: [
      { alias: "on", model: "a/on", experts: null, askAll: true, consensus: true },
      { alias: "dis", model: "a/dis", experts: null, askAll: false, consensus: true },
    ],
  };
  const askAll = askAllDelegates(c, "architect").selected.map((m) => m.alias);
  assert.equal(askAll.includes("dis"), false, "askAll:false model must not be selected for /ask-all");
  assert.deepEqual(askAll, ["on"]);
  const con = consensusDelegates(c, "architect").map((m) => m.alias);
  assert.equal(con.includes("dis"), true, "askAll:false does not affect /consensus eligibility");
});

test("R5b: resolveAlias openrouter-default inherits model settings when defaultModel matches a configured alias", () => {
  const c = cfg();
  c.defaultModel = "arch";
  const resolved = resolveAlias(c, "openrouter-default");
  assert.equal(resolved.alias, "openrouter-default");
  assert.equal(resolved.model, "a/y");
  assert.deepEqual(resolved.experts, ["architect"]);
});
