"use strict";

const fs = require("node:fs");

const EXPERT_KEYS = new Set([
  "architect", "plan-reviewer", "scope-analyst", "code-reviewer",
  "security-analyst", "researcher", "debugger",
]);
const RESERVED_ALIAS = "openrouter-default";
const ALIAS_RE = /^[a-z0-9-]+$/;
const SUPPORTED_MAJOR = 1;

const DEFAULT_API_BASE = "https://openrouter.ai/api/v1";
const DEFAULT_API_KEY_ENV = "OPENROUTER_API_KEY";
const DEFAULT_MAX_FANOUT = 3;

function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// Validate a parsed config object. Returns { ok, resolved, error }.
// `resolved.openrouter` always exists (disabled when the block is absent).
function validateConfig(raw) {
  if (!isObject(raw)) return fail("config root must be a JSON object");

  const version = raw.version === undefined ? 1 : raw.version;
  if (!Number.isInteger(version) || version < 1 || version > SUPPORTED_MAJOR) {
    return fail(`unsupported config version ${version}; this build supports version <= ${SUPPORTED_MAJOR}`);
  }

  const providers = isObject(raw.providers) ? raw.providers : {};

  const orRaw = isObject(raw.openrouter) ? raw.openrouter : null;
  if (!orRaw) {
    return { ok: true, resolved: { version, providers, openrouter: disabledOpenRouter() }, error: null };
  }

  const enabled = orRaw.enabled !== false; // missing => enabled
  const apiKeyEnv = orRaw.apiKeyEnv || DEFAULT_API_KEY_ENV;
  const apiBase = orRaw.apiBase || DEFAULT_API_BASE;
  const allowRawModel = orRaw.allowRawModel === true;

  const maxFanout = orRaw.maxFanout === undefined ? DEFAULT_MAX_FANOUT : orRaw.maxFanout;
  if (!Number.isInteger(maxFanout) || maxFanout < 1) {
    return fail(`maxFanout must be an integer >= 1 (got ${String(maxFanout)})`);
  }

  const defaultModel = typeof orRaw.defaultModel === "string" && orRaw.defaultModel.trim()
    ? orRaw.defaultModel.trim() : null;

  const defaults = isObject(orRaw.defaults) ? orRaw.defaults : {};

  const modelsRaw = Array.isArray(orRaw.models) ? orRaw.models : [];
  const models = [];
  const seen = new Set();
  for (let i = 0; i < modelsRaw.length; i++) {
    const m = modelsRaw[i];
    if (!isObject(m)) return fail(`models[${i}] must be an object`);
    if (typeof m.alias !== "string" || !ALIAS_RE.test(m.alias)) {
      return fail(`models[${i}] alias must match [a-z0-9-]+ (got ${JSON.stringify(m.alias)})`);
    }
    if (m.alias === RESERVED_ALIAS) return fail(`alias "${RESERVED_ALIAS}" is reserved`);
    if (seen.has(m.alias)) return fail(`duplicate alias "${m.alias}"`);
    seen.add(m.alias);
    if (typeof m.model !== "string" || !m.model.trim()) {
      return fail(`models[${i}] (${m.alias}) needs a non-empty model slug`);
    }
    let experts = null;
    if (m.experts !== undefined) {
      if (!Array.isArray(m.experts)) return fail(`models[${i}] (${m.alias}) experts must be an array`);
      for (const e of m.experts) {
        if (!EXPERT_KEYS.has(e)) return fail(`models[${i}] (${m.alias}) unknown expert "${e}"`);
      }
      experts = m.experts.slice();
    }
    if (m.reasoning_effort !== undefined && typeof m.reasoning_effort !== "string") {
      return fail(`models[${i}] (${m.alias}) reasoning_effort must be a string`);
    }
    if (m.timeout !== undefined && !(Number.isInteger(m.timeout) && m.timeout > 0)) {
      return fail(`models[${i}] (${m.alias}) timeout must be a positive integer`);
    }
    if (m.temperature !== undefined && !(typeof m.temperature === "number" && Number.isFinite(m.temperature))) {
      return fail(`models[${i}] (${m.alias}) temperature must be a finite number`);
    }
    if (m.apiBase !== undefined && !(typeof m.apiBase === "string" && m.apiBase.trim())) {
      return fail(`models[${i}] (${m.alias}) apiBase must be a non-empty string`);
    }
    models.push({
      alias: m.alias,
      model: m.model.trim(),
      experts,
      askAll: m.askAll !== false,
      consensus: m.consensus === true,
      reasoning_effort: m.reasoning_effort,
      timeout: m.timeout,
      temperature: m.temperature,
      apiBase: m.apiBase,
    });
  }

  return {
    ok: true,
    error: null,
    resolved: {
      version, providers,
      openrouter: { enabled, apiKeyEnv, apiBase, allowRawModel, maxFanout, defaultModel, defaults, models },
    },
  };
}

function disabledOpenRouter() {
  return {
    enabled: false, apiKeyEnv: DEFAULT_API_KEY_ENV, apiBase: DEFAULT_API_BASE,
    allowRawModel: false, maxFanout: DEFAULT_MAX_FANOUT, defaultModel: null, defaults: {}, models: [],
  };
}

function fail(message) {
  return { ok: false, resolved: null, error: message };
}

// Stat-gated reader: re-reads + re-validates only when the file mtime changes.
// Never throws. Missing file => ok:true, disabled openrouter. Bad JSON => ok:false parse error.
function makeConfigReader(filePath) {
  let cachedMtimeMs = null;
  let cachedResult = null;

  function read() {
    let text;
    try {
      text = fs.readFileSync(filePath, "utf8");
    } catch (_) {
      return { ok: true, error: null, resolved: { version: 1, providers: {}, openrouter: disabledOpenRouter() } };
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      return { ok: false, resolved: null, error: `config JSON parse error: ${e.message}` };
    }
    return validateConfig(parsed);
  }

  return {
    get() {
      let mtimeMs = null;
      try { mtimeMs = fs.statSync(filePath).mtimeMs; } catch (_) { mtimeMs = null; }
      if (cachedResult === null || mtimeMs !== cachedMtimeMs) {
        cachedResult = read();
        cachedMtimeMs = mtimeMs;
      }
      return cachedResult;
    },
  };
}

module.exports = { validateConfig, makeConfigReader, EXPERT_KEYS, RESERVED_ALIAS, DEFAULT_API_BASE, DEFAULT_API_KEY_ENV };
