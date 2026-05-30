// @ts-nocheck -- legacy bridge; predates the strict typecheck gate (core-only). Opt-in is a separate pass.
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

// Best-effort sanitize an alias to the [a-z0-9-]+ shape. Returns "" when nothing usable remains.
function sanitizeAlias(raw) {
  if (typeof raw !== "string") return "";
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
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

  // Per-entry partial validation: a single bad model entry no longer rejects the whole
  // config. Valid entries are kept; bad ones are collected into `invalidModels` with a
  // human-readable reason and (where a safe fix exists) a `suggestedAlias` the caller can
  // apply to repair config.json. Top-level/schema errors above still hard-fail.
  const modelsRaw = Array.isArray(orRaw.models) ? orRaw.models : [];
  const models = [];
  const invalidModels = [];
  const seen = new Set();           // aliases of entries that fully validated (for duplicate detection)
  const taken = new Set([RESERVED_ALIAS]); // every existing alias + reserved + suggestions already made
  for (const m of modelsRaw) {
    if (isObject(m) && typeof m.alias === "string") taken.add(m.alias);
  }

  // Pick a free alias near `candidate`, reserving it so two repairs cannot collide.
  function suggestFree(candidate) {
    if (!candidate || candidate === RESERVED_ALIAS) return undefined;
    let chosen = candidate;
    if (taken.has(chosen)) {
      chosen = undefined;
      for (let n = 2; n <= 99; n++) {
        if (!taken.has(`${candidate}-${n}`)) { chosen = `${candidate}-${n}`; break; }
      }
      if (!chosen) return undefined;
    }
    taken.add(chosen);
    return chosen;
  }

  function addInvalid(i, alias, reason, suggestedAlias) {
    const entry = { index: i, alias: alias === undefined ? null : alias, reason };
    if (suggestedAlias) entry.suggestedAlias = suggestedAlias;
    invalidModels.push(entry);
  }

  for (let i = 0; i < modelsRaw.length; i++) {
    const m = modelsRaw[i];
    if (!isObject(m)) { addInvalid(i, null, `models[${i}] must be an object`); continue; }
    const rawAlias = typeof m.alias === "string" ? m.alias : null;
    if (typeof m.alias !== "string" || !ALIAS_RE.test(m.alias)) {
      const sanitized = sanitizeAlias(m.alias);
      addInvalid(i, rawAlias, `models[${i}] alias must match [a-z0-9-]+ (got ${JSON.stringify(m.alias)})`,
        sanitized ? suggestFree(sanitized) : undefined);
      continue;
    }
    if (m.alias === RESERVED_ALIAS) { addInvalid(i, m.alias, `alias "${RESERVED_ALIAS}" is reserved`); continue; }
    if (seen.has(m.alias)) { addInvalid(i, m.alias, `duplicate alias "${m.alias}"`, suggestFree(m.alias)); continue; }
    if (typeof m.model !== "string" || !m.model.trim()) {
      addInvalid(i, m.alias, `models[${i}] (${m.alias}) needs a non-empty model slug`); continue;
    }
    let experts = null;
    if (m.experts !== undefined) {
      if (!Array.isArray(m.experts)) { addInvalid(i, m.alias, `models[${i}] (${m.alias}) experts must be an array`); continue; }
      let badExpert = null;
      for (const e of m.experts) {
        if (!EXPERT_KEYS.has(e)) { badExpert = e; break; }
      }
      if (badExpert !== null) { addInvalid(i, m.alias, `models[${i}] (${m.alias}) unknown expert "${badExpert}"`); continue; }
      experts = m.experts.slice();
    }
    if (m.reasoning_effort !== undefined && typeof m.reasoning_effort !== "string") {
      addInvalid(i, m.alias, `models[${i}] (${m.alias}) reasoning_effort must be a string`); continue;
    }
    if (m.timeout !== undefined && !(Number.isInteger(m.timeout) && m.timeout > 0)) {
      addInvalid(i, m.alias, `models[${i}] (${m.alias}) timeout must be a positive integer`); continue;
    }
    if (m.temperature !== undefined && !(typeof m.temperature === "number" && Number.isFinite(m.temperature))) {
      addInvalid(i, m.alias, `models[${i}] (${m.alias}) temperature must be a finite number`); continue;
    }
    if (m.apiBase !== undefined && !(typeof m.apiBase === "string" && m.apiBase.trim())) {
      addInvalid(i, m.alias, `models[${i}] (${m.alias}) apiBase must be a non-empty string`); continue;
    }
    seen.add(m.alias);
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
      openrouter: { enabled, apiKeyEnv, apiBase, allowRawModel, maxFanout, defaultModel, defaults, models, invalidModels },
    },
  };
}

function disabledOpenRouter() {
  return {
    enabled: false, apiKeyEnv: DEFAULT_API_KEY_ENV, apiBase: DEFAULT_API_BASE,
    allowRawModel: false, maxFanout: DEFAULT_MAX_FANOUT, defaultModel: null, defaults: {}, models: [], invalidModels: [],
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
