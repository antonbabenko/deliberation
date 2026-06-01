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
const DEFAULT_ARBITER = "auto";
const BUILTIN_ARBITERS = new Set(["codex", "gemini", "grok"]);
// The only provider a `models` entry may target in v1. codex/gemini/grok are
// CLI-managed or singleton built-ins and are out of scope for named model records.
const MODEL_PROVIDER = "openrouter";

function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// Best-effort sanitize an id to the [a-z0-9-]+ shape. Returns "" when nothing usable remains.
function sanitizeAlias(raw) {
  if (typeof raw !== "string") return "";
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Validate a parsed config object (the unified v1 on-disk schema). Returns
// { ok, resolved, error }. The on-disk shape separates provider CONNECTION config
// (providers.*) from named MODELS (models map), pulls fan-out into routing, and
// lets consensus.arbiter name its own model. The RESOLVED shape is kept stable for
// today's readers: resolved.openrouter.models is still an ARRAY whose entries carry
// `alias` (= the map id), so core/registry.js, server/openrouter/routing.js, and the
// openrouter-list wire keep working on `.alias`.
//
// camelCase config keys map to wire fields HERE in the resolved layer: a model
// entry's `reasoningEffort` becomes resolved `.reasoning_effort` (the wire field the
// bridge call site reads). One place to map, documented at the assignment below.
function validateConfig(raw) {
  if (!isObject(raw)) return fail("config root must be a JSON object");

  const version = raw.version === undefined ? 1 : raw.version;
  if (!Number.isInteger(version) || version < 1 || version > SUPPORTED_MAJOR) {
    return fail(`unsupported config version ${version}; this build supports version <= ${SUPPORTED_MAJOR}`);
  }

  // providers = connection config only, uniform per provider. resolved.providers
  // keeps the same { name: { enabled } } shape today's readers consume; the
  // openrouter-specific keys (apiKeyEnv/apiBase/allowRawModel/defaultModel/defaults)
  // are hoisted into resolved.openrouter below.
  const providersRaw = isObject(raw.providers) ? raw.providers : {};
  const orProviderRaw = isObject(providersRaw.openrouter) ? providersRaw.openrouter : null;

  // routing = global fan-out policy. Pulled out of openrouter. Bad maxFanout hard-fails.
  const routingRaw = isObject(raw.routing) ? raw.routing : {};
  const maxFanout = routingRaw.maxFanout === undefined ? DEFAULT_MAX_FANOUT : routingRaw.maxFanout;
  if (!Number.isInteger(maxFanout) || maxFanout < 1) {
    return fail(`routing.maxFanout must be an integer >= 1 (got ${String(maxFanout)})`);
  }

  // Resolve the connection layer for openrouter. When the openrouter provider block
  // is absent OR enabled:false, openrouter is disabled (no fan-out, no arbiter pin).
  const enabled = !!orProviderRaw && orProviderRaw.enabled !== false; // present + not disabled
  const apiKeyEnv = (orProviderRaw && orProviderRaw.apiKeyEnv) || DEFAULT_API_KEY_ENV;
  const apiBase = (orProviderRaw && orProviderRaw.apiBase) || DEFAULT_API_BASE;
  const allowRawModel = !!orProviderRaw && orProviderRaw.allowRawModel === true;
  const defaultModel = orProviderRaw && typeof orProviderRaw.defaultModel === "string" && orProviderRaw.defaultModel.trim()
    ? orProviderRaw.defaultModel.trim() : null;
  const { defaults, warnings: defaultsWarnings } = resolveDefaults(orProviderRaw && orProviderRaw.defaults);

  // models = a MAP keyed by id. Resolve each entry into the legacy array shape with
  // alias === id. Per-entry soft-fail: a bad entry lands in invalidModels and does
  // NOT reject the whole config. Order follows Object.keys insertion order.
  const parsed = resolveModels(raw.models);
  // Disabled-openrouter gating: when the provider is disabled, force the EFFECTIVE
  // models to [] (and invalidModels to []) so the registry never fans out / votes a
  // disabled provider's models, matching the old disabledOpenRouter() shape. This
  // runs BEFORE resolveConsensus, so a {model:id} arbiter pointing at a now-absent
  // model degrades to "auto" + warning instead of pinning a disabled delegate.
  const models = enabled ? parsed.models : [];
  const invalidModels = enabled ? parsed.invalidModels : [];

  const { consensus, warnings } = resolveConsensus(raw.consensus, models);

  return {
    ok: true,
    error: null,
    resolved: {
      version,
      providers: resolveProviders(providersRaw),
      openrouter: { enabled, apiKeyEnv, apiBase, allowRawModel, maxFanout, defaultModel, defaults, models, invalidModels },
      consensus,
      // Defaults-validation warnings ride the same consensusWarnings channel the
      // bridge already surfaces, so a dropped bad default is visible, not silent.
      consensusWarnings: [...defaultsWarnings, ...warnings],
    },
  };
}

// Resolve providers.openrouter.defaults. camelCase -> wire mapping happens HERE
// (same place as model entries): on-disk `reasoningEffort` becomes the resolved
// `.reasoning_effort` the bridge call site reads; `temperature`/`timeout` pass
// through unchanged. Each value is type-checked with the SAME rules as per-model
// overrides; a bad value is DROPPED (not sent to the wire) and surfaced as a warning,
// so the validator agrees with config.schema.json. Unknown keys are dropped silently.
// @returns {{defaults: object, warnings: string[]}}
function resolveDefaults(raw) {
  const out = {};
  const warnings = [];
  if (!isObject(raw)) return { defaults: out, warnings };
  if (raw.reasoningEffort !== undefined) {
    if (typeof raw.reasoningEffort === "string" && raw.reasoningEffort.trim()) out.reasoning_effort = raw.reasoningEffort;
    else warnings.push(`providers.openrouter.defaults.reasoningEffort must be a non-empty string (got ${JSON.stringify(raw.reasoningEffort)}); dropped`);
  }
  if (raw.temperature !== undefined) {
    if (typeof raw.temperature === "number" && Number.isFinite(raw.temperature)) out.temperature = raw.temperature;
    else warnings.push(`providers.openrouter.defaults.temperature must be a finite number (got ${JSON.stringify(raw.temperature)}); dropped`);
  }
  if (raw.timeout !== undefined) {
    if (Number.isInteger(raw.timeout) && raw.timeout > 0) out.timeout = raw.timeout;
    else warnings.push(`providers.openrouter.defaults.timeout must be a positive integer (got ${JSON.stringify(raw.timeout)}); dropped`);
  }
  return { defaults: out, warnings };
}

// Build resolved.providers as { name: { enabled } }. Only the enable flag is part
// of the registry/arbiter contract; openrouter-specific connection keys are hoisted
// into resolved.openrouter, not duplicated here.
function resolveProviders(providersRaw) {
  const out = {};
  for (const name of Object.keys(providersRaw)) {
    const block = providersRaw[name];
    out[name] = { enabled: !(isObject(block) && block.enabled === false) };
  }
  return out;
}

// Resolve the `models` MAP into the legacy resolved array (alias === id). Each entry
// is validated; bad entries go to invalidModels[] with index/alias(=id)/reason and a
// suggestedAlias when a safe id repair exists. The whole config never hard-fails here.
function resolveModels(modelsRaw) {
  const models = [];
  const invalidModels = [];
  if (modelsRaw !== undefined && !isObject(modelsRaw)) {
    // A present-but-non-object models key is malformed; treat as empty + one notice.
    invalidModels.push({ index: 0, alias: null, reason: `models must be an object map (got ${JSON.stringify(modelsRaw)})` });
    return { models, invalidModels };
  }
  const map = isObject(modelsRaw) ? modelsRaw : {};
  const ids = Object.keys(map);

  // ids come from Object.keys(map), so they are unique by construction - no
  // duplicate detection needed. `taken` seeds the id-format repair suggester so a
  // sanitized suggestion never collides with an existing id or the reserved id.
  const taken = new Set([RESERVED_ALIAS, ...ids.filter((id) => ALIAS_RE.test(id))]);

  // Pick a free id near `candidate`, reserving it so two repairs cannot collide.
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

  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const m = map[id];
    if (!ALIAS_RE.test(id)) {
      const sanitized = sanitizeAlias(id);
      addInvalid(i, id, `models id "${id}" must match [a-z0-9-]+`, sanitized ? suggestFree(sanitized) : undefined);
      continue;
    }
    if (id === RESERVED_ALIAS) { addInvalid(i, id, `id "${RESERVED_ALIAS}" is reserved`); continue; }
    if (!isObject(m)) { addInvalid(i, id, `models["${id}"] must be an object`); continue; }
    // provider is required and MUST be "openrouter" in v1. codex/gemini/grok model
    // entries are rejected with a clear reason - they are CLI-managed / singleton
    // built-ins and out of scope. The field stays required so the shape is explicit.
    if (typeof m.provider !== "string" || !m.provider.trim()) {
      addInvalid(i, id, `models["${id}"] needs a provider (must be "${MODEL_PROVIDER}")`); continue;
    }
    if (m.provider !== MODEL_PROVIDER) {
      addInvalid(i, id, `models["${id}"] provider "${m.provider}" is not supported; only "${MODEL_PROVIDER}" model entries are allowed (codex/gemini/grok are CLI-managed / singleton built-ins, out of scope)`);
      continue;
    }
    if (typeof m.model !== "string" || !m.model.trim()) {
      addInvalid(i, id, `models["${id}"] needs a non-empty model slug`); continue;
    }
    let experts = null;
    if (m.experts !== undefined) {
      if (!Array.isArray(m.experts)) { addInvalid(i, id, `models["${id}"] experts must be an array`); continue; }
      let badExpert = null;
      for (const e of m.experts) {
        if (!EXPERT_KEYS.has(e)) { badExpert = e; break; }
      }
      if (badExpert !== null) { addInvalid(i, id, `models["${id}"] unknown expert "${badExpert}"`); continue; }
      experts = m.experts.slice();
    }
    if (m.askAll !== undefined && typeof m.askAll !== "boolean") {
      addInvalid(i, id, `models["${id}"] askAll must be a boolean`); continue;
    }
    if (m.consensus !== undefined && typeof m.consensus !== "boolean") {
      addInvalid(i, id, `models["${id}"] consensus must be a boolean`); continue;
    }
    if (m.reasoningEffort !== undefined && typeof m.reasoningEffort !== "string") {
      addInvalid(i, id, `models["${id}"] reasoningEffort must be a string`); continue;
    }
    if (m.timeout !== undefined && !(Number.isInteger(m.timeout) && m.timeout > 0)) {
      addInvalid(i, id, `models["${id}"] timeout must be a positive integer`); continue;
    }
    if (m.temperature !== undefined && !(typeof m.temperature === "number" && Number.isFinite(m.temperature))) {
      addInvalid(i, id, `models["${id}"] temperature must be a finite number`); continue;
    }
    if (m.apiBase !== undefined && !(typeof m.apiBase === "string" && m.apiBase.trim())) {
      addInvalid(i, id, `models["${id}"] apiBase must be a non-empty string`); continue;
    }
    models.push({
      alias: id,
      model: m.model.trim(),
      experts,
      askAll: m.askAll !== false,
      consensus: m.consensus === true,
      // camelCase -> wire mapping happens HERE (the one place): the on-disk
      // `reasoningEffort` becomes the resolved `.reasoning_effort` the bridge call
      // site (server/openrouter/index.js) sends to the API as `reasoning_effort`.
      reasoning_effort: m.reasoningEffort,
      timeout: m.timeout,
      temperature: m.temperature,
      apiBase: m.apiBase,
    });
  }
  return { models, invalidModels };
}

// Resolve the consensus.arbiter spec with soft-degrade semantics. An invalid
// arbiter NEVER rejects the config; it degrades to "auto" and records a warning.
// Accepted forms:
//   - shorthand string: "host" | "auto" | "codex" | "gemini" | "grok"
//   - object { model: "<id>" } referencing ANY models entry (even askAll:false /
//     consensus:false - that is the dedicated-arbiter case). Arbiter eligibility is
//     separate from voting-panel membership.
// The resolved arbiter is normalized to a value resolveArbiter() in
// server/mcp/index.js consumes directly: a shorthand string, or { model: "<id>" }.
// @param {*} rawConsensus  the raw consensus block (untrusted)
// @param {{alias:string}[]} models  resolved (valid) model entries
// @returns {{consensus:{arbiter: (string|{model:string})}, warnings:string[]}}
function resolveConsensus(rawConsensus, models) {
  const warnings = [];
  if (rawConsensus !== undefined && !isObject(rawConsensus)) {
    // The user DID set consensus (just malformed) -> degrade to auto but treat as
    // explicit (arbiterDefaulted:false), so host auto-detect does not override it.
    warnings.push(`consensus must be an object (got ${JSON.stringify(rawConsensus)}); using "${DEFAULT_ARBITER}"`);
    return { consensus: { arbiter: DEFAULT_ARBITER, arbiterDefaulted: false, blindVote: false }, warnings };
  }
  const block = isObject(rawConsensus) ? rawConsensus : {};

  // blindVote: optional boolean; non-boolean degrades to false + a warning. Runs
  // a blind arbiter pre-vote (server/concrete-arbiter mode only); off by default
  // because the extra arbiter call adds cost/latency.
  let blindVote = false;
  if (block.blindVote !== undefined) {
    if (typeof block.blindVote === "boolean") blindVote = block.blindVote;
    else warnings.push(`consensus.blindVote must be a boolean (got ${JSON.stringify(block.blindVote)}); using false`);
  }

  // arbiterDefaulted=true ONLY when the user did not set an arbiter at all, so the
  // server can pick host (under Claude Code) vs auto (elsewhere). An explicit but
  // invalid arbiter degrades to auto with arbiterDefaulted=false (the user did choose).
  const wrap = (/** @type {any} */ arbiter, /** @type {boolean} */ arbiterDefaulted) => ({
    consensus: { arbiter, arbiterDefaulted, blindVote },
    warnings,
  });

  const spec = block.arbiter;
  if (spec === undefined) return wrap(DEFAULT_ARBITER, true);

  // Object form: { model: "<id>" } referencing a models entry.
  if (isObject(spec)) {
    const id = spec.model;
    if (typeof id !== "string" || !id.trim()) {
      warnings.push(`consensus.arbiter object must have a string "model" id (got ${JSON.stringify(spec)}); using "${DEFAULT_ARBITER}"`);
      return wrap(DEFAULT_ARBITER, false);
    }
    if (models.some((m) => m.alias === id)) return wrap({ model: id }, false);
    warnings.push(`consensus.arbiter model "${id}" is not a configured models id; using "${DEFAULT_ARBITER}"`);
    return wrap(DEFAULT_ARBITER, false);
  }

  if (typeof spec !== "string") {
    warnings.push(`consensus.arbiter must be a string shorthand or { model: "<id>" } (got ${JSON.stringify(spec)}); using "${DEFAULT_ARBITER}"`);
    return wrap(DEFAULT_ARBITER, false);
  }
  if (spec === "host" || spec === "auto" || BUILTIN_ARBITERS.has(spec)) {
    return wrap(spec, false);
  }
  warnings.push(`consensus.arbiter "${spec}" is not host/auto/codex/gemini/grok or { model: "<id>" }; using "${DEFAULT_ARBITER}"`);
  return wrap(DEFAULT_ARBITER, false);
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
      return { ok: true, error: null, resolved: { version: 1, providers: {}, openrouter: disabledOpenRouter(), consensus: { arbiter: DEFAULT_ARBITER, arbiterDefaulted: true, blindVote: false }, consensusWarnings: [] } };
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

module.exports = {
  validateConfig, makeConfigReader, EXPERT_KEYS, RESERVED_ALIAS,
  DEFAULT_API_BASE, DEFAULT_API_KEY_ENV,
};
