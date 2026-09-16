"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { validateConfig } = require("../server/openrouter/config.js");
const { makeRegistry } = require("../core/registry.js");

test("LP1: validateConfig accepts ollama and lmstudio providers in models", () => {
  const raw = {
    version: 1,
    providers: {
      gemini: { enabled: true, model: "gpt-oss-120b-medium" },
      ollama: { enabled: true, apiBase: "http://localhost:11434/v1" },
      lmstudio: { enabled: true, apiBase: "http://localhost:1234/v1" },
    },
    models: {
      "nemotron-ultra": { provider: "ollama", model: "nemotron-3-ultra:cloud", askAll: true, consensus: true },
      "qwen-coder": { provider: "lmstudio", model: "qwen3-coder-next", askAll: true, consensus: true },
    },
  };
  const { ok, resolved, error } = validateConfig(raw);
  assert.equal(ok, true, error);
  assert.equal(resolved.openrouter.models.length, 2);
  assert.equal(resolved.openrouter.models[0].provider, "ollama");
  assert.equal(resolved.openrouter.models[1].provider, "lmstudio");
});

test("LP2: makeRegistry formats delegate names with provider prefix and model slug", () => {
  const fakeOrProvider = {
    name: "openrouter",
    capabilities: {},
    async health() { return { ok: true }; },
    async ask(req) { return { provider: "openrouter", model: req.model, text: "ok", isError: false, ms: 10 }; },
  };
  const fakeGoogleProvider = {
    name: "google:gpt-oss-120b-medium",
    capabilities: {},
    async health() { return { ok: true }; },
    async ask() { return { provider: "google:gpt-oss-120b-medium", model: "gpt-oss-120b-medium", text: "ok", isError: false, ms: 10 }; },
  };

  const reg = makeRegistry([fakeGoogleProvider, fakeOrProvider]);
  const cfg = {
    providers: {
      gemini: { enabled: true, model: "gpt-oss-120b-medium" },
      ollama: { enabled: true, apiBase: "http://localhost:11434/v1" },
      lmstudio: { enabled: true, apiBase: "http://localhost:1234/v1" },
    },
    openrouter: {
      maxFanout: 4,
      models: [
        { alias: "nemotron-ultra", provider: "ollama", model: "nemotron-3-ultra:cloud", askAll: true, consensus: true },
        { alias: "qwen-coder", provider: "lmstudio", model: "qwen3-coder-next", askAll: true, consensus: true },
      ],
    },
  };

  const { providers } = reg.selectForAskAll({ config: cfg, expert: "architect" });
  assert.deepEqual(
    providers.map((p) => p.name),
    ["google:gpt-oss-120b-medium", "ollama:nemotron-3-ultra:cloud", "lmstudio:qwen3-coder-next"]
  );

  // reg.get resolves google and gemini aliases
  assert.ok(reg.get("gemini"));
  assert.ok(reg.get("google"));
  assert.ok(reg.get("google:gpt-oss-120b-medium"));
});

test("LP3: validateConfig accepts models with colons, dots, and slashes in model slugs", () => {
  const raw = {
    version: 1,
    models: {
      "nemotron-ultra": { provider: "ollama", model: "nemotron-3-ultra:cloud" },
      "glm-cloud": { provider: "ollama", model: "glm-5.3:cloud" },
      "custom-v1": { provider: "lmstudio", model: "custom/model:v1.0" },
    },
  };
  const { ok, resolved, error } = validateConfig(raw);
  assert.equal(ok, true, error);
  assert.equal(resolved.openrouter.models.length, 3);
  assert.equal(resolved.openrouter.models[0].model, "nemotron-3-ultra:cloud");
  assert.equal(resolved.openrouter.models[1].model, "glm-5.3:cloud");
  assert.equal(resolved.openrouter.models[2].model, "custom/model:v1.0");
});

test("LP4: validateConfig accepts google provider in models and makeRegistry binds pinGoogleAlias", () => {
  const raw = {
    version: 1,
    providers: {
      gemini: { enabled: true, model: "gemini-3.8-flash-high" },
    },
    models: {
      "gpt-oss-120b": { provider: "google", model: "gpt-oss-120b-medium", askAll: false, consensus: false },
    },
  };
  const { ok, resolved, error } = validateConfig(raw);
  assert.equal(ok, true, error);
  assert.equal(resolved.openrouter.models.length, 1);
  assert.equal(resolved.openrouter.models[0].provider, "google");

  const fakeGoogleProvider = {
    name: "google:gemini-3.8-flash-high",
    capabilities: {},
    async health() { return { ok: true }; },
    async ask(req) { return { provider: "google:gemini-3.8-flash-high", model: req.model, text: "ok", isError: false, ms: 10 }; },
  };
  const reg = makeRegistry([fakeGoogleProvider]);
  const cfg = {
    providers: { gemini: { enabled: true, model: "gemini-3.8-flash-high" } },
    openrouter: { models: resolved.openrouter.models },
  };
  // askAll does not include askAll:false models
  const { providers } = reg.selectForAskAll({ config: cfg, expert: "architect" });
  assert.deepEqual(providers.map((p) => p.name), ["google:gemini-3.8-flash-high"]);
});
