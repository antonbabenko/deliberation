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
});

test("C2: duplicate alias is rejected", () => {
  const c = base();
  c.openrouter.models[1].alias = "gpt55";
  const { ok, error } = validateConfig(c);
  assert.equal(ok, false);
  assert.match(error, /duplicate alias/i);
});

test("C3: reserved alias openrouter-default is rejected", () => {
  const c = base();
  c.openrouter.models[0].alias = "openrouter-default";
  const { ok, error } = validateConfig(c);
  assert.equal(ok, false);
  assert.match(error, /reserved/i);
});

test("C4: unknown expert key is rejected", () => {
  const c = base();
  c.openrouter.models[0].experts = ["wizard"];
  const { ok, error } = validateConfig(c);
  assert.equal(ok, false);
  assert.match(error, /unknown expert/i);
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

test("C7: bad alias characters are rejected", () => {
  const c = base();
  c.openrouter.models[0].alias = "GPT_55";
  const { ok, error } = validateConfig(c);
  assert.equal(ok, false);
  assert.match(error, /alias/i);
});

test("C8: omitted openrouter block resolves to disabled, no error", () => {
  const { ok, resolved } = validateConfig({ version: 1 });
  assert.equal(ok, true);
  assert.equal(resolved.openrouter.enabled, false);
  assert.deepEqual(resolved.openrouter.models, []);
});

test("C12: invalid per-model override types are rejected", () => {
  for (const bad of [{ reasoning_effort: 5 }, { timeout: -1 }, { timeout: 2.5 }, { temperature: "hot" }, { apiBase: "" }]) {
    const c = base();
    Object.assign(c.openrouter.models[0], bad);
    const { ok } = validateConfig(c);
    assert.equal(ok, false, `override ${JSON.stringify(bad)} should be invalid`);
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
