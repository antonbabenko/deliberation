"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { validateConfig, makeConfigReader } = require("../server/openrouter/config.js");

function base() {
  return {
    version: 1,
    openrouter: {
      enabled: true,
      apiKeyEnv: "OPENROUTER_API_KEY",
      apiBase: "https://openrouter.ai/api/v1",
      allowRawModel: false,
      maxFanout: 3,
      defaultModel: "openai/gpt-5.5",
      defaults: { reasoning_effort: "high", timeout: 180000 },
      models: [
        { alias: "gpt55", model: "openai/gpt-5.5", experts: ["architect"], askAll: true, consensus: true },
        { alias: "llama", model: "meta/llama", experts: ["researcher"] },
        { alias: "deep", model: "deepseek/r2", experts: [], consensus: true },
      ],
    },
  };
}

test("C1: a valid config resolves with defaults applied", () => {
  const { ok, resolved, error } = validateConfig(base());
  assert.equal(ok, true, error);
  assert.equal(resolved.openrouter.enabled, true);
  assert.equal(resolved.openrouter.models[1].askAll, true);
  assert.equal(resolved.openrouter.models[1].consensus, false);
  assert.equal(resolved.openrouter.models[0].consensus, true);
  assert.deepEqual(resolved.openrouter.models[2].experts, []);
  assert.deepEqual(resolved.openrouter.invalidModels, []);
});

// Per-entry partial validation: a bad model entry is collected into invalidModels and
// skipped; the remaining valid delegates are kept (config stays ok:true).

test("C2: duplicate alias is reported as invalid, valid entries kept", () => {
  const c = base();
  c.openrouter.models[1].alias = "gpt55";
  const { ok, resolved } = validateConfig(c);
  assert.equal(ok, true);
  assert.equal(resolved.openrouter.models.length, 2);
  assert.equal(resolved.openrouter.invalidModels.length, 1);
  assert.equal(resolved.openrouter.invalidModels[0].index, 1);
  assert.match(resolved.openrouter.invalidModels[0].reason, /duplicate alias/i);
  assert.equal(resolved.openrouter.invalidModels[0].suggestedAlias, "gpt55-2");
});

test("C3: reserved alias openrouter-default is reported as invalid, valid entries kept", () => {
  const c = base();
  c.openrouter.models[0].alias = "openrouter-default";
  const { ok, resolved } = validateConfig(c);
  assert.equal(ok, true);
  assert.equal(resolved.openrouter.models.length, 2);
  assert.equal(resolved.openrouter.invalidModels.length, 1);
  assert.match(resolved.openrouter.invalidModels[0].reason, /reserved/i);
  // reserved-alias collision has no safe auto-rename
  assert.equal(resolved.openrouter.invalidModels[0].suggestedAlias, undefined);
});

test("C4: unknown expert key is reported as invalid, valid entries kept", () => {
  const c = base();
  c.openrouter.models[0].experts = ["wizard"];
  const { ok, resolved } = validateConfig(c);
  assert.equal(ok, true);
  assert.equal(resolved.openrouter.models.length, 2);
  assert.equal(resolved.openrouter.invalidModels.length, 1);
  assert.match(resolved.openrouter.invalidModels[0].reason, /unknown expert/i);
});

test("C5: non-integer or <1 maxFanout is rejected", () => {
  for (const bad of [0, -1, 2.5, "3", null, NaN, Infinity, true]) {
    const c = base();
    c.openrouter.maxFanout = bad;
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

test("C7: bad alias characters are reported as invalid with a sanitized suggestion", () => {
  const c = base();
  c.openrouter.models[0].alias = "GPT_55";
  const { ok, resolved } = validateConfig(c);
  assert.equal(ok, true);
  assert.equal(resolved.openrouter.models.length, 2);
  assert.equal(resolved.openrouter.invalidModels.length, 1);
  assert.match(resolved.openrouter.invalidModels[0].reason, /alias/i);
  assert.equal(resolved.openrouter.invalidModels[0].suggestedAlias, "gpt-55");
});

test("C7b: dotted alias (qwen3.7-max) suggests qwen3-7-max", () => {
  const c = base();
  c.openrouter.models[0].alias = "qwen3.7-max";
  const { ok, resolved } = validateConfig(c);
  assert.equal(ok, true);
  assert.equal(resolved.openrouter.invalidModels[0].suggestedAlias, "qwen3-7-max");
});

test("C7c: a single bad entry leaves the other delegates intact (partial)", () => {
  const c = base();
  c.openrouter.models[1].alias = "bad alias!"; // illegal chars
  const { ok, resolved } = validateConfig(c);
  assert.equal(ok, true);
  assert.equal(resolved.openrouter.models.length, 2);
  assert.deepEqual(resolved.openrouter.models.map((m) => m.alias), ["gpt55", "deep"]);
  assert.equal(resolved.openrouter.invalidModels.length, 1);
  assert.equal(resolved.openrouter.invalidModels[0].index, 1);
  assert.equal(resolved.openrouter.invalidModels[0].suggestedAlias, "bad-alias");
});

test("C7d: suggested alias avoids colliding with an existing alias", () => {
  // models[1] alias is invalid and would sanitize to "gpt55", which already exists -> suffix.
  const c = base();
  c.openrouter.models[1].alias = "GPT55";
  const { ok, resolved } = validateConfig(c);
  assert.equal(ok, true);
  assert.equal(resolved.openrouter.invalidModels[0].suggestedAlias, "gpt55-2");
});

test("C8: omitted openrouter block resolves to disabled, no error", () => {
  const { ok, resolved } = validateConfig({ version: 1 });
  assert.equal(ok, true);
  assert.equal(resolved.openrouter.enabled, false);
  assert.deepEqual(resolved.openrouter.models, []);
});

test("C12: invalid per-model override types are reported as invalid, valid entries kept", () => {
  for (const bad of [{ reasoning_effort: 5 }, { timeout: -1 }, { timeout: 2.5 }, { temperature: "hot" }, { apiBase: "" }]) {
    const c = base();
    Object.assign(c.openrouter.models[0], bad);
    const { ok, resolved } = validateConfig(c);
    assert.equal(ok, true, `override ${JSON.stringify(bad)} should be partial, not fatal`);
    assert.equal(resolved.openrouter.models.length, 2, `${JSON.stringify(bad)}: valid entries kept`);
    assert.equal(resolved.openrouter.invalidModels.length, 1, `${JSON.stringify(bad)}: one invalid`);
    assert.equal(resolved.openrouter.invalidModels[0].index, 0);
  }
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
  c2.openrouter.models.push({ alias: "extra", model: "x/y" });
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

// --- Phase B1: consensus.arbiter resolution -----------------------------------

test("CB1: missing consensus block defaults arbiter to 'auto', no warnings", () => {
  const { ok, resolved } = validateConfig(base());
  assert.equal(ok, true);
  assert.deepEqual(resolved.consensus, { arbiter: "auto" });
  assert.deepEqual(resolved.consensusWarnings, []);
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

test("CB4: openrouter:<existing-alias> arbiter is accepted (no consensus:true needed)", () => {
  const c = base();
  // "llama" exists but is NOT consensus:true; arbiter eligibility != panel membership.
  c.consensus = { arbiter: "openrouter:llama" };
  const { resolved } = validateConfig(c);
  assert.equal(resolved.consensus.arbiter, "openrouter:llama");
  assert.deepEqual(resolved.consensusWarnings, []);
});

test("CB5: unknown arbiter soft-degrades to 'auto' with a warning, config stays ok", () => {
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

test("CB5b: openrouter:<missing-alias> soft-degrades to 'auto' with a warning", () => {
  const c = base();
  c.consensus = { arbiter: "openrouter:ghost" };
  const { ok, resolved } = validateConfig(c);
  assert.equal(ok, true);
  assert.equal(resolved.consensus.arbiter, "auto");
  assert.equal(resolved.consensusWarnings.length, 1);
  assert.match(resolved.consensusWarnings[0], /ghost/);
});

test("CB6: non-string / non-object consensus block degrades to default auto", () => {
  for (const bad of [{ arbiter: 5 }, { arbiter: null }, "host", 7]) {
    const c = base();
    c.consensus = bad;
    const { ok, resolved } = validateConfig(c);
    assert.equal(ok, true, `consensus=${JSON.stringify(bad)} should not hard-fail`);
    assert.equal(resolved.consensus.arbiter, "auto");
  }
});

test("CB7: omitted openrouter block still carries consensus default auto", () => {
  const { resolved } = validateConfig({ version: 1 });
  assert.deepEqual(resolved.consensus, { arbiter: "auto" });
  assert.deepEqual(resolved.consensusWarnings, []);
});

test("CB8: missing config file => disabled openrouter + consensus default auto", () => {
  const reader = makeConfigReader(path.join(os.tmpdir(), "definitely-absent-cdg-cb.json"));
  const r = reader.get();
  assert.equal(r.ok, true);
  assert.deepEqual(r.resolved.consensus, { arbiter: "auto" });
});
