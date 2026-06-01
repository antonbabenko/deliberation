"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { validateConfig, makeConfigReader } = require("../server/openrouter/config.js");

// Unified v1 on-disk shape: providers carry connection config; models is a named-record
// map keyed by id; routing holds fan-out; consensus.arbiter is a shorthand string or
// { model: id }. The RESOLVED shape stays stable (resolved.openrouter.models is an ARRAY
// whose entries carry `alias` === the map id), so registry/routing/wire are unchanged.
function base() {
  return {
    $schema: "https://raw.githubusercontent.com/antonbabenko/deliberation/master/config/config.schema.json",
    version: 1,
    providers: {
      codex: { enabled: true },
      gemini: { enabled: true },
      grok: { enabled: true, apiKeyEnv: "XAI_API_KEY" },
      openrouter: {
        enabled: true,
        apiKeyEnv: "OPENROUTER_API_KEY",
        apiBase: "https://openrouter.ai/api/v1",
        allowRawModel: false,
        defaultModel: "openai/gpt-5.5",
        defaults: { reasoningEffort: "high", timeout: 180000 },
      },
    },
    models: {
      gpt55: { provider: "openrouter", model: "openai/gpt-5.5", experts: ["architect"], askAll: true, consensus: true },
      llama: { provider: "openrouter", model: "meta/llama", experts: ["researcher"] },
      deep: { provider: "openrouter", model: "deepseek/r2", experts: [], consensus: true },
    },
    routing: { maxFanout: 3 },
  };
}

test("C1: a valid config resolves with defaults applied", () => {
  const { ok, resolved, error } = validateConfig(base());
  assert.equal(ok, true, error);
  assert.equal(resolved.openrouter.enabled, true);
  assert.equal(resolved.openrouter.maxFanout, 3);
  // models stays an ARRAY keyed by alias (= map id), order = insertion order.
  assert.deepEqual(resolved.openrouter.models.map((m) => m.alias), ["gpt55", "llama", "deep"]);
  assert.equal(resolved.openrouter.models[1].askAll, true);
  assert.equal(resolved.openrouter.models[1].consensus, false);
  assert.equal(resolved.openrouter.models[0].consensus, true);
  assert.deepEqual(resolved.openrouter.models[2].experts, []);
  assert.deepEqual(resolved.openrouter.invalidModels, []);
});

test("C1b: $schema top-level key is tolerated (ignored) and never invalidates", () => {
  const { ok, resolved, error } = validateConfig(base());
  assert.equal(ok, true, error);
  assert.equal(resolved.openrouter.models.length, 3);
});

test("C1c: camelCase reasoningEffort maps to wire reasoning_effort on the resolved entry", () => {
  const c = base();
  c.models.gpt55.reasoningEffort = "low";
  c.models.gpt55.temperature = 0.3;
  c.models.gpt55.timeout = 12345;
  const { resolved } = validateConfig(c);
  const m = resolved.openrouter.models.find((x) => x.alias === "gpt55");
  assert.equal(m.reasoning_effort, "low");
  assert.equal(m.temperature, 0.3);
  assert.equal(m.timeout, 12345);
  // defaults.reasoningEffort also maps to wire reasoning_effort
  assert.equal(resolved.openrouter.defaults.reasoning_effort, "high");
  assert.equal(resolved.openrouter.defaults.timeout, 180000);
});

test("C1d: an invalid providers.openrouter.defaults value is DROPPED and surfaced (not sent to the wire)", () => {
  const c = base();
  // schema rejects a non-numeric temperature; the validator must agree.
  c.providers.openrouter.defaults = { reasoningEffort: "high", temperature: "hot" };
  const { ok, resolved } = validateConfig(c);
  assert.equal(ok, true);
  // bad temperature dropped; the good sibling survives
  assert.equal(resolved.openrouter.defaults.temperature, undefined);
  assert.equal(resolved.openrouter.defaults.reasoning_effort, "high");
  // dropped value is surfaced on the consensusWarnings channel, not silent
  assert.ok(resolved.consensusWarnings.some((w) => /defaults\.temperature/i.test(w)));
});

test("C1e: each bad defaults type is dropped with its own warning", () => {
  for (const [bad, re] of [
    [{ reasoningEffort: 5 }, /reasoningEffort/i],
    [{ reasoningEffort: "" }, /reasoningEffort/i],
    [{ temperature: "hot" }, /temperature/i],
    [{ timeout: -1 }, /timeout/i],
    [{ timeout: 2.5 }, /timeout/i],
  ]) {
    const c = base();
    c.providers.openrouter.defaults = bad;
    const { ok, resolved } = validateConfig(c);
    assert.equal(ok, true, `defaults ${JSON.stringify(bad)} should not hard-fail`);
    const key = Object.keys(bad)[0] === "reasoningEffort" ? "reasoning_effort" : Object.keys(bad)[0];
    assert.equal(resolved.openrouter.defaults[key], undefined, `${JSON.stringify(bad)}: dropped`);
    assert.ok(resolved.consensusWarnings.some((w) => re.test(w)), `${JSON.stringify(bad)}: warned`);
  }
});

// Per-entry partial validation: a bad model entry is collected into invalidModels and
// skipped; the remaining valid records are kept (config stays ok:true).

test("C2: duplicate model slug across two ids is fine; ids are unique by construction", () => {
  // The map cannot hold duplicate ids; two ids may share a slug. Both kept.
  const c = base();
  c.models.llama.model = "openai/gpt-5.5";
  const { ok, resolved } = validateConfig(c);
  assert.equal(ok, true);
  assert.equal(resolved.openrouter.models.length, 3);
  assert.deepEqual(resolved.openrouter.invalidModels, []);
});

test("C3: reserved id openrouter-default is reported as invalid, valid entries kept", () => {
  const c = base();
  c.models["openrouter-default"] = { provider: "openrouter", model: "x/y" };
  const { ok, resolved } = validateConfig(c);
  assert.equal(ok, true);
  assert.equal(resolved.openrouter.models.length, 3);
  assert.equal(resolved.openrouter.invalidModels.length, 1);
  assert.match(resolved.openrouter.invalidModels[0].reason, /reserved/i);
  assert.equal(resolved.openrouter.invalidModels[0].suggestedAlias, undefined);
});

test("C4: unknown expert key is reported as invalid, valid entries kept", () => {
  const c = base();
  c.models.gpt55.experts = ["wizard"];
  const { ok, resolved } = validateConfig(c);
  assert.equal(ok, true);
  assert.equal(resolved.openrouter.models.length, 2);
  assert.equal(resolved.openrouter.invalidModels.length, 1);
  assert.match(resolved.openrouter.invalidModels[0].reason, /unknown expert/i);
});

test("C4b: non-openrouter provider model entry is rejected with a clear reason, valid kept", () => {
  for (const bad of ["codex", "gemini", "grok"]) {
    const c = base();
    c.models.gpt55.provider = bad;
    const { ok, resolved } = validateConfig(c);
    assert.equal(ok, true, `provider ${bad} should be partial, not fatal`);
    assert.equal(resolved.openrouter.models.length, 2, `${bad}: valid entries kept`);
    assert.equal(resolved.openrouter.invalidModels.length, 1);
    assert.match(resolved.openrouter.invalidModels[0].reason, /not supported|only "openrouter"/i);
  }
});

test("C4c: a model entry missing provider is rejected (provider required)", () => {
  const c = base();
  delete c.models.gpt55.provider;
  const { ok, resolved } = validateConfig(c);
  assert.equal(ok, true);
  assert.equal(resolved.openrouter.models.length, 2);
  assert.match(resolved.openrouter.invalidModels[0].reason, /provider/i);
});

test("C5: non-integer or <1 routing.maxFanout is rejected (hard-fail)", () => {
  for (const bad of [0, -1, 2.5, "3", null, NaN, Infinity, true]) {
    const c = base();
    c.routing.maxFanout = bad;
    const { ok } = validateConfig(c);
    assert.equal(ok, false, `maxFanout=${bad} should be invalid`);
  }
});

test("C6: unknown major version is rejected", () => {
  const c = base();
  c.version = 2;
  const { ok, error } = validateConfig(c);
  assert.equal(ok, false);
  assert.match(error, /version/i);
});

test("C6b: version 0 or negative is rejected", () => {
  for (const v of [0, -1]) {
    const c = base();
    c.version = v;
    const { ok } = validateConfig(c);
    assert.equal(ok, false, `version ${v} should be invalid`);
  }
});

test("C7: bad id characters are reported as invalid with a sanitized suggestion", () => {
  const c = base();
  c.models["GPT_55"] = { provider: "openrouter", model: "openai/gpt-5.5" };
  const { ok, resolved } = validateConfig(c);
  assert.equal(ok, true);
  assert.equal(resolved.openrouter.models.length, 3);
  const inv = resolved.openrouter.invalidModels.find((e) => e.alias === "GPT_55");
  assert.ok(inv);
  assert.match(inv.reason, /\[a-z0-9-\]/i);
  assert.equal(inv.suggestedAlias, "gpt-55");
});

test("C7b: dotted id (qwen3.7-max) suggests qwen3-7-max", () => {
  const c = base();
  c.models["qwen3.7-max"] = { provider: "openrouter", model: "qwen/q" };
  const { resolved } = validateConfig(c);
  const inv = resolved.openrouter.invalidModels.find((e) => e.alias === "qwen3.7-max");
  assert.equal(inv.suggestedAlias, "qwen3-7-max");
});

test("C7d: suggested id avoids colliding with an existing id", () => {
  // An invalid id that sanitizes to "gpt55" (already present) gets a suffix.
  const c = base();
  c.models["GPT55"] = { provider: "openrouter", model: "x/y" };
  const { resolved } = validateConfig(c);
  const inv = resolved.openrouter.invalidModels.find((e) => e.alias === "GPT55");
  assert.equal(inv.suggestedAlias, "gpt55-2");
});

test("C8: omitted openrouter provider block resolves to disabled, no error", () => {
  const { ok, resolved } = validateConfig({ version: 1 });
  assert.equal(ok, true);
  assert.equal(resolved.openrouter.enabled, false);
  assert.deepEqual(resolved.openrouter.models, []);
});

test("C8b: enabled:false + a populated models map forces EFFECTIVE models to [] (no fan-out/vote from a disabled provider)", () => {
  const c = base();
  c.providers.openrouter.enabled = false;
  const { resolved } = validateConfig(c);
  assert.equal(resolved.openrouter.enabled, false);
  // gating: a disabled provider reports nothing - matches the old disabledOpenRouter() shape
  assert.deepEqual(resolved.openrouter.models, []);
  assert.deepEqual(resolved.openrouter.invalidModels, []);
});

test("C8c: a {model:id} arbiter pointing at a model on a DISABLED provider degrades to auto + warning", () => {
  const c = base();
  c.providers.openrouter.enabled = false;
  // "gpt55" exists in the on-disk map but is gated out when openrouter is disabled.
  c.consensus = { arbiter: { model: "gpt55" } };
  const { ok, resolved } = validateConfig(c);
  assert.equal(ok, true);
  assert.deepEqual(resolved.openrouter.models, []);
  assert.equal(resolved.consensus.arbiter, "auto");
  assert.equal(resolved.consensusWarnings.length, 1);
  assert.match(resolved.consensusWarnings[0], /gpt55/);
});

test("C12: invalid per-model override types are reported as invalid, valid entries kept", () => {
  for (const bad of [{ reasoningEffort: 5 }, { timeout: -1 }, { timeout: 2.5 }, { temperature: "hot" }, { apiBase: "" }]) {
    const c = base();
    Object.assign(c.models.gpt55, bad);
    const { ok, resolved } = validateConfig(c);
    assert.equal(ok, true, `override ${JSON.stringify(bad)} should be partial, not fatal`);
    assert.equal(resolved.openrouter.models.length, 2, `${JSON.stringify(bad)}: valid entries kept`);
    assert.equal(resolved.openrouter.invalidModels.length, 1, `${JSON.stringify(bad)}: one invalid`);
    assert.equal(resolved.openrouter.invalidModels[0].alias, "gpt55");
  }
});

test("C12b: non-boolean askAll/consensus are reported as invalid (schema requires booleans), valid entries kept", () => {
  for (const bad of [{ askAll: "false" }, { askAll: 1 }, { consensus: "true" }, { consensus: 0 }]) {
    const c = base();
    Object.assign(c.models.gpt55, bad);
    const { ok, resolved } = validateConfig(c);
    assert.equal(ok, true, `${JSON.stringify(bad)} should be partial, not fatal`);
    assert.equal(resolved.openrouter.models.length, 2, `${JSON.stringify(bad)}: valid entries kept`);
    assert.equal(resolved.openrouter.invalidModels.length, 1, `${JSON.stringify(bad)}: one invalid`);
    assert.equal(resolved.openrouter.invalidModels[0].alias, "gpt55");
    assert.match(resolved.openrouter.invalidModels[0].reason, /askAll|consensus/i);
  }
});

test("C13: providers resolve to { name: { enabled } }; only enabled:false disables", () => {
  const c = base();
  c.providers.codex = { enabled: false };
  const { resolved } = validateConfig(c);
  assert.equal(resolved.providers.codex.enabled, false);
  assert.equal(resolved.providers.gemini.enabled, true);
  assert.equal(resolved.providers.grok.enabled, true);
});

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function tmpConfig(obj) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cdg-or-"));
  const file = path.join(dir, "config.json");
  fs.writeFileSync(file, JSON.stringify(obj));
  return file;
}

test("C9: reader returns resolved config and re-reads on mtime change", () => {
  const file = tmpConfig(base());
  const reader = makeConfigReader(file);
  const first = reader.get();
  assert.equal(first.ok, true);
  assert.equal(first.resolved.openrouter.models.length, 3);

  const c2 = base();
  c2.models.extra = { provider: "openrouter", model: "x/y" };
  fs.writeFileSync(file, JSON.stringify(c2));
  const future = new Date(Date.now() + 2000); // bump mtime; same-second writes can collide
  fs.utimesSync(file, future, future);

  const second = reader.get();
  assert.equal(second.resolved.openrouter.models.length, 4);
});

test("C10: missing file => disabled openrouter, ok=true (graceful)", () => {
  const reader = makeConfigReader(path.join(os.tmpdir(), "definitely-absent-cdg.json"));
  const r = reader.get();
  assert.equal(r.ok, true);
  assert.equal(r.resolved.openrouter.enabled, false);
});

test("C11: malformed JSON => ok=false with parse error, no throw", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cdg-or-bad-"));
  const file = path.join(dir, "config.json");
  fs.writeFileSync(file, "{ not json ");
  const reader = makeConfigReader(file);
  const r = reader.get();
  assert.equal(r.ok, false);
  assert.match(r.error, /parse|json/i);
});

// --- consensus.arbiter resolution (shorthand string OR { model: id }) ---------

test("CB1: missing consensus block defaults arbiter to 'auto', no warnings", () => {
  const { ok, resolved } = validateConfig(base());
  assert.equal(ok, true);
  assert.deepEqual(resolved.consensus, { arbiter: "auto", arbiterDefaulted: true, blindVote: false });
  assert.deepEqual(resolved.consensusWarnings, []);
});

test("CB1b: consensus.blindVote true is accepted; arbiterDefaulted false when arbiter is explicit", () => {
  const c = base();
  c.consensus = { arbiter: "auto", blindVote: true };
  const { resolved } = validateConfig(c);
  assert.equal(resolved.consensus.blindVote, true);
  assert.equal(resolved.consensus.arbiterDefaulted, false); // arbiter was explicitly set
});

test("CB1c: non-boolean consensus.blindVote degrades to false + a warning", () => {
  const c = base();
  c.consensus = { blindVote: "yes" };
  const { resolved } = validateConfig(c);
  assert.equal(resolved.consensus.blindVote, false);
  assert.ok(resolved.consensusWarnings.some((/** @type {string} */ w) => /blindVote must be a boolean/.test(w)));
});

test("CB2: arbiter 'host' is accepted verbatim", () => {
  const c = base();
  c.consensus = { arbiter: "host" };
  const { resolved } = validateConfig(c);
  assert.equal(resolved.consensus.arbiter, "host");
  assert.deepEqual(resolved.consensusWarnings, []);
});

test("CB3: built-in provider arbiters (codex/gemini/grok) are accepted", () => {
  for (const name of ["codex", "gemini", "grok"]) {
    const c = base();
    c.consensus = { arbiter: name };
    const { resolved } = validateConfig(c);
    assert.equal(resolved.consensus.arbiter, name, `arbiter ${name}`);
    assert.deepEqual(resolved.consensusWarnings, []);
  }
});

test("CB4: { model: <existing-id> } arbiter is accepted (no consensus:true needed)", () => {
  const c = base();
  // "llama" exists but is NOT consensus:true; arbiter eligibility != panel membership.
  c.consensus = { arbiter: { model: "llama" } };
  const { resolved } = validateConfig(c);
  assert.deepEqual(resolved.consensus.arbiter, { model: "llama" });
  assert.deepEqual(resolved.consensusWarnings, []);
});

test("CB5: unknown string arbiter soft-degrades to 'auto' with a warning, config stays ok", () => {
  const c = base();
  c.consensus = { arbiter: "banana" };
  const { ok, resolved } = validateConfig(c);
  assert.equal(ok, true);
  assert.equal(resolved.consensus.arbiter, "auto");
  assert.equal(resolved.consensusWarnings.length, 1);
  assert.match(resolved.consensusWarnings[0], /banana/);
  // providers/openrouter survive the bad arbiter (no whole-config rejection)
  assert.equal(resolved.openrouter.models.length, 3);
});

test("CB5b: { model: <missing-id> } soft-degrades to 'auto' with a warning", () => {
  const c = base();
  c.consensus = { arbiter: { model: "ghost" } };
  const { ok, resolved } = validateConfig(c);
  assert.equal(ok, true);
  assert.equal(resolved.consensus.arbiter, "auto");
  assert.equal(resolved.consensusWarnings.length, 1);
  assert.match(resolved.consensusWarnings[0], /ghost/);
});

test("CB5c: { model: <id> } referencing a dedicated arbiter (askAll:false, consensus:false) is accepted", () => {
  const c = base();
  c.models.arb = { provider: "openrouter", model: "anthropic/claude", askAll: false, consensus: false };
  c.consensus = { arbiter: { model: "arb" } };
  const { resolved } = validateConfig(c);
  assert.deepEqual(resolved.consensus.arbiter, { model: "arb" });
  assert.deepEqual(resolved.consensusWarnings, []);
});

test("CB6: object consensus block with a non-string model id degrades to auto + warning", () => {
  for (const bad of [{ model: 5 }, { model: null }, { model: "" }, {}]) {
    const c = base();
    c.consensus = { arbiter: bad };
    const { ok, resolved } = validateConfig(c);
    assert.equal(ok, true, `arbiter=${JSON.stringify(bad)} should not hard-fail`);
    assert.equal(resolved.consensus.arbiter, "auto");
    assert.equal(resolved.consensusWarnings.length, 1, `${JSON.stringify(bad)}: one warning`);
  }
});

test("CB6b: arbiter as a bare number/array degrades to auto + warning", () => {
  for (const bad of [5, null, [1]]) {
    const c = base();
    c.consensus = { arbiter: bad };
    const { ok, resolved } = validateConfig(c);
    assert.equal(ok, true, `arbiter=${JSON.stringify(bad)} should not hard-fail`);
    assert.equal(resolved.consensus.arbiter, "auto");
    assert.equal(resolved.consensusWarnings.length, 1);
  }
});

test("CB9: non-object consensus block degrades to auto AND warns (invalid->auto+warning rule)", () => {
  for (const bad of ["host", 7, true, []]) {
    const c = base();
    c.consensus = bad;
    const { ok, resolved } = validateConfig(c);
    assert.equal(ok, true, `consensus=${JSON.stringify(bad)} should not hard-fail`);
    assert.equal(resolved.consensus.arbiter, "auto");
    assert.equal(resolved.consensusWarnings.length, 1, `${JSON.stringify(bad)}: must warn`);
    assert.match(resolved.consensusWarnings[0], /object/i);
  }
});

test("CB7: omitted openrouter block still carries consensus default auto", () => {
  const { resolved } = validateConfig({ version: 1 });
  assert.deepEqual(resolved.consensus, { arbiter: "auto", arbiterDefaulted: true, blindVote: false });
  assert.deepEqual(resolved.consensusWarnings, []);
});

test("CB8: missing config file => disabled openrouter + consensus default auto", () => {
  const reader = makeConfigReader(path.join(os.tmpdir(), "definitely-absent-cdg-cb.json"));
  const r = reader.get();
  assert.equal(r.ok, true);
  assert.deepEqual(r.resolved.consensus, { arbiter: "auto", arbiterDefaulted: true, blindVote: false });
});
