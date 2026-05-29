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
