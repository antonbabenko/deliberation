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
// Hard cap on consensus.maxRounds. Each round drives a blind pass + a peer fan-out
// (multiple paid provider calls), so an unbounded value is a cost/runaway vector.
// An over-cap config value is clamped to this (with a warning), not dropped.
const MAX_ROUNDS_CAP = 50;
// Default wall-clock budget (ms) for the consensus loop. Absent or invalid config
// values fall back to this constant so the 30-min cap is enforced even for configs
// that pre-date the feature. A present-but-invalid value degrades to the default
// WITH a warning (unlike maxRounds which omits when invalid, here we always emit).
const DEFAULT_CONSENSUS_MAX_WALL_MS = 1800000;
const DEFAULT_CONSENSUS_QUORUM_FLOOR = 2;
// sessions block defaults (opt-in store; default OFF).
const DEFAULT_SESSIONS_MAX_RECORDS = 200;
const DEFAULT_SESSIONS_MAX_AGE_DAYS = 30;
// dashboard block defaults (opt-in local read-only server; default OFF).
const DEFAULT_DASHBOARD_CAPTURE = "metadata";
const DEFAULT_DASHBOARD_PORT = 7717;
const DEFAULT_DASHBOARD_MAX_RUNS = 200;
const DEFAULT_DASHBOARD_MAX_AGE_DAYS = 30;
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
  const sharedDefaultsRaw = isObject(providersRaw.defaults) ? providersRaw.defaults : null;

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
  const { defaults, warnings: defaultsWarnings } = resolveDefaults(orProviderRaw && orProviderRaw.defaults, sharedDefaultsRaw);

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

  const defaultEntries = models.filter((m) => m.default);
  const defaultWarnings = [];
  if (defaultEntries.length > 1) {
    defaultWarnings.push(
      `multiple models marked with default: true (${defaultEntries.map((m) => `"${m.alias}"`).join(", ")}); using "${defaultEntries[0].alias}"`
    );
  }
  const defaultModelFromRecord = defaultEntries.length > 0 ? defaultEntries[0].alias : null;
  const defaultModelFromProvider = orProviderRaw && typeof (orProviderRaw.model || orProviderRaw.defaultModel) === "string" && (orProviderRaw.model || orProviderRaw.defaultModel).trim()
    ? (orProviderRaw.model || orProviderRaw.defaultModel).trim() : null;
  const defaultModel = defaultModelFromRecord || defaultModelFromProvider;

  const { consensus, warnings } = resolveConsensus(raw.consensus, models);
  const { sessions, warnings: sessionsWarnings } = resolveSessions(raw.sessions);
  const { debug, warnings: debugWarnings } = resolveDebug(raw.debug);
  const { dashboard, warnings: dashboardWarnings } = resolveDashboard(raw.dashboard);

  return {
    ok: true,
    error: null,
    resolved: {
      version,
      providers: resolveProviders(providersRaw),
      openrouter: { enabled, apiKeyEnv, apiBase, allowRawModel, maxFanout, defaultModel, defaults, models, invalidModels },
      consensus,
      sessions,
      debug,
      dashboard,
      // Defaults-, sessions-, debug-, and dashboard-validation warnings ride the same
      // consensusWarnings channel the bridge already surfaces, so a dropped/degraded
      // value is visible, not silent.
      consensusWarnings: [...defaultsWarnings, ...warnings, ...sessionsWarnings, ...debugWarnings, ...dashboardWarnings, ...defaultWarnings],
    },
  };
}

// Resolve the optional `debug` block (opt-in debug log; default OFF). Soft-degrade
// like resolveSessions: an invalid value never rejects the config.
//   - enabled: boolean (non-bool -> false + warning); default false (log OFF).
//   - path: optional non-empty string (an absolute file path). Invalid -> dropped
//     + warning; the server then falls back to the canonical cache-dir default.
// @param {*} raw  the raw debug block (untrusted)
// @returns {{debug:{enabled:boolean, path:(string|null)}, warnings:string[]}}
function resolveDebug(raw) {
  const warnings = [];
  const out = { enabled: false, path: null };
  if (raw === undefined) return { debug: out, warnings };
  if (!isObject(raw)) {
    warnings.push(`debug must be an object (got ${JSON.stringify(raw)}); debug logging disabled`);
    return { debug: out, warnings };
  }
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled === "boolean") out.enabled = raw.enabled;
    else warnings.push(`debug.enabled must be a boolean (got ${JSON.stringify(raw.enabled)}); using false`);
  }
  if (raw.path !== undefined) {
    if (typeof raw.path === "string" && raw.path.trim()) out.path = raw.path.trim();
    else warnings.push(`debug.path must be a non-empty string (got ${JSON.stringify(raw.path)}); using the default cache-dir path`);
  }
  return { debug: out, warnings };
}

// Resolve the optional `sessions` block (opt-in per-session store) with
// soft-degrade semantics, mirroring resolveConsensus: an invalid value NEVER
// rejects the config; it degrades to the default and records a warning.
//   - persist: boolean (non-bool -> false + warning); default false (store OFF).
//   - maxRecords / maxAgeDays: positive ints (invalid -> default + warning).
// @param {*} raw  the raw sessions block (untrusted)
// @returns {{sessions:{persist:boolean, maxRecords:number, maxAgeDays:number}, warnings:string[]}}
function resolveSessions(raw) {
  const warnings = [];
  const out = { persist: false, maxRecords: DEFAULT_SESSIONS_MAX_RECORDS, maxAgeDays: DEFAULT_SESSIONS_MAX_AGE_DAYS, captureText: false };
  if (raw === undefined) return { sessions: out, warnings };
  if (!isObject(raw)) {
    warnings.push(`sessions must be an object (got ${JSON.stringify(raw)}); persistence disabled`);
    return { sessions: out, warnings };
  }
  if (raw.persist !== undefined) {
    if (typeof raw.persist === "boolean") out.persist = raw.persist;
    else warnings.push(`sessions.persist must be a boolean (got ${JSON.stringify(raw.persist)}); using false`);
  }
  // Opt-in capture of provider RESPONSE bodies (opinion text) into the record.
  // Default OFF -> only summaries (verdict/issues) are stored. Never gates the
  // mandatory secret-scrub; never affects the metrics-only debug log.
  if (raw.captureText !== undefined) {
    if (typeof raw.captureText === "boolean") out.captureText = raw.captureText;
    else warnings.push(`sessions.captureText must be a boolean (got ${JSON.stringify(raw.captureText)}); using false`);
  }
  // -1 means UNLIMITED (keep forever / no count cap); otherwise a positive integer.
  // 0 and other values are invalid -> default + warning.
  if (raw.maxRecords !== undefined) {
    if (Number.isInteger(raw.maxRecords) && (raw.maxRecords === -1 || raw.maxRecords > 0)) out.maxRecords = raw.maxRecords;
    else warnings.push(`sessions.maxRecords must be -1 (unlimited) or a positive integer (got ${JSON.stringify(raw.maxRecords)}); using ${DEFAULT_SESSIONS_MAX_RECORDS}`);
  }
  if (raw.maxAgeDays !== undefined) {
    if (Number.isInteger(raw.maxAgeDays) && (raw.maxAgeDays === -1 || raw.maxAgeDays > 0)) out.maxAgeDays = raw.maxAgeDays;
    else warnings.push(`sessions.maxAgeDays must be -1 (unlimited) or a positive integer (got ${JSON.stringify(raw.maxAgeDays)}); using ${DEFAULT_SESSIONS_MAX_AGE_DAYS}`);
  }
  return { sessions: out, warnings };
}

// Resolve the optional `dashboard` block (opt-in local read-only run viewer) with
// soft-degrade semantics, mirroring resolveSessions: an invalid value NEVER rejects
// the config; it degrades to the default and records a warning.
//   - enabled: boolean (non-bool -> false + warning); default false (dashboard OFF).
//   - capture: "metadata" | "content" (invalid -> "metadata" + warning). Threat model:
//     "content" journals prompt/response bodies (scrubbed + capped) to local disk;
//     "metadata" never does.
//   - showPII: boolean (non-bool -> false + warning). Threat model: the dashboard UI
//     redacts likely-PII substrings from journaled content by default; true disables
//     that redaction for local display only (the journal on disk is unaffected).
//   - port: integer 1..65535 (invalid -> 7717 + warning).
//   - maxRuns / maxAgeDays: -1 (unlimited) or positive ints (invalid -> default + warning).
// @param {*} raw  the raw dashboard block (untrusted)
// @returns {{dashboard:{enabled:boolean, capture:("metadata"|"content"), showPII:boolean, port:number, maxRuns:number, maxAgeDays:number}, warnings:string[]}}
function resolveDashboard(raw) {
  const warnings = [];
  const out = {
    enabled: false,
    capture: DEFAULT_DASHBOARD_CAPTURE,
    showPII: false,
    port: DEFAULT_DASHBOARD_PORT,
    maxRuns: DEFAULT_DASHBOARD_MAX_RUNS,
    maxAgeDays: DEFAULT_DASHBOARD_MAX_AGE_DAYS,
  };
  if (raw === undefined) return { dashboard: out, warnings };
  if (!isObject(raw)) {
    warnings.push(`dashboard must be an object (got ${JSON.stringify(raw)}); dashboard disabled`);
    return { dashboard: out, warnings };
  }
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled === "boolean") out.enabled = raw.enabled;
    else warnings.push(`dashboard.enabled must be a boolean (got ${JSON.stringify(raw.enabled)}); using false`);
  }
  if (raw.capture !== undefined) {
    if (raw.capture === "metadata" || raw.capture === "content") out.capture = raw.capture;
    else warnings.push(`dashboard.capture must be "metadata" or "content" (got ${JSON.stringify(raw.capture)}); using ${DEFAULT_DASHBOARD_CAPTURE}`);
  }
  if (raw.showPII !== undefined) {
    if (typeof raw.showPII === "boolean") out.showPII = raw.showPII;
    else warnings.push(`dashboard.showPII must be a boolean (got ${JSON.stringify(raw.showPII)}); using false`);
  }
  if (raw.port !== undefined) {
    if (Number.isInteger(raw.port) && raw.port >= 1 && raw.port <= 65535) out.port = raw.port;
    else warnings.push(`dashboard.port must be an integer 1-65535 (got ${JSON.stringify(raw.port)}); using ${DEFAULT_DASHBOARD_PORT}`);
  }
  // -1 means UNLIMITED (keep forever / no count cap); otherwise a positive integer.
  // 0 and other values are invalid -> default + warning.
  if (raw.maxRuns !== undefined) {
    if (Number.isInteger(raw.maxRuns) && (raw.maxRuns === -1 || raw.maxRuns > 0)) out.maxRuns = raw.maxRuns;
    else warnings.push(`dashboard.maxRuns must be -1 (unlimited) or a positive integer (got ${JSON.stringify(raw.maxRuns)}); using ${DEFAULT_DASHBOARD_MAX_RUNS}`);
  }
  if (raw.maxAgeDays !== undefined) {
    if (Number.isInteger(raw.maxAgeDays) && (raw.maxAgeDays === -1 || raw.maxAgeDays > 0)) out.maxAgeDays = raw.maxAgeDays;
    else warnings.push(`dashboard.maxAgeDays must be -1 (unlimited) or a positive integer (got ${JSON.stringify(raw.maxAgeDays)}); using ${DEFAULT_DASHBOARD_MAX_AGE_DAYS}`);
  }
  return { dashboard: out, warnings };
}

// Resolve providers.openrouter.defaults. camelCase -> wire mapping happens HERE
// (same place as model entries): on-disk `reasoningEffort` becomes the resolved
// `.reasoning_effort` the bridge call site reads; `temperature`/`timeout` pass
// through unchanged. Each value is type-checked with the SAME rules as per-model
// overrides; a bad value is DROPPED (not sent to the wire) and surfaced as a warning,
// so the validator agrees with config.schema.json. If own defaults omit an effort
// or timeout, it inherits from shared providers.defaults. Unknown keys are dropped silently.
// @param {*} raw  providers.openrouter.defaults
// @param {*} [shared]  providers.defaults
// @returns {{defaults: object, warnings: string[]}}
function resolveDefaults(raw, shared) {
  const out = {};
  const warnings = [];
  const own = isObject(raw) ? raw : {};
  const sh = isObject(shared) ? shared : {};

  const ownEffort = own.reasoningEffort;
  const shEffort = sh.reasoningEffort;
  const targetEffort = ownEffort !== undefined ? ownEffort : shEffort;
  if (targetEffort !== undefined) {
    if (typeof targetEffort === "string" && targetEffort.trim()) {
      out.reasoning_effort = targetEffort.trim();
    } else {
      warnings.push(`providers.openrouter.defaults.reasoningEffort must be a non-empty string (got ${JSON.stringify(targetEffort)}); dropped`);
    }
  }

  const ownConsensusEffort = own.consensusReasoningEffort;
  const shConsensusEffort = sh.consensusReasoningEffort;
  const targetConsensusEffort = ownConsensusEffort !== undefined ? ownConsensusEffort : shConsensusEffort;
  if (targetConsensusEffort !== undefined) {
    if (typeof targetConsensusEffort === "string" && targetConsensusEffort.trim()) {
      out.consensus_reasoning_effort = targetConsensusEffort.trim();
    } else {
      warnings.push(`providers.openrouter.defaults.consensusReasoningEffort must be a non-empty string (got ${JSON.stringify(targetConsensusEffort)}); dropped`);
    }
  }

  if (own.temperature !== undefined) {
    if (typeof own.temperature === "number" && Number.isFinite(own.temperature)) out.temperature = own.temperature;
    else warnings.push(`providers.openrouter.defaults.temperature must be a finite number (got ${JSON.stringify(own.temperature)}); dropped`);
  }
  const ownTimeout = own.timeout;
  const shTimeout = sh.timeout;
  const targetTimeout = ownTimeout !== undefined ? ownTimeout : shTimeout;
  if (targetTimeout !== undefined) {
    if (Number.isInteger(targetTimeout) && targetTimeout > 0) out.timeout = targetTimeout;
    else warnings.push(`providers.openrouter.defaults.timeout must be a positive integer (got ${JSON.stringify(targetTimeout)}); dropped`);
  }
  return { defaults: out, warnings };
}

// Build resolved.providers as { name: { enabled, model?, reasoningEffort?, consensusReasoningEffort?, timeout? } }. The
// enable flag is the registry/arbiter contract; `model`, `reasoningEffort`, and `consensusReasoningEffort` are
// carried through for the providers that accept a pin so the composition root (and
// the standalone Grok bridge) can hand them to the adapter. openrouter-specific
// connection keys stay hoisted into resolved.openrouter, and openrouter's own model
// and effort live in the models map - so both are ignored there.
//
// Blank or non-string values are DROPPED rather than forwarded: a bogus id or effort
// would be sent upstream verbatim, and falling through to the env var and built-in is
// the safer failure. Schema validation reports the bad value separately.
// `timeout` resolves HERE rather than in the composition root, so the precedence
// ladder lives in the config SSOT: providers.<name>.timeout (providers.openrouter
// .defaults.timeout for OpenRouter, which already owns a defaults block) beats
// providers.defaults.timeout, which beats the adapter's built-in. A pinned alias's
// models.<id>.timeout still wins over all of it - registry.js merges that into the
// request itself. `defaults` is a shared block, NOT a provider: it never becomes an
// entry in the resolved map.
const PINNABLE_KEYS = ["model", "reasoningEffort", "consensusReasoningEffort"];
const KNOWN_PROVIDERS = ["codex", "gemini", "grok", "openrouter"];
const positiveInt = (/** @type {any} */ v) => (Number.isInteger(v) && v > 0 ? v : undefined);
function resolveProviders(providersRaw) {
  const out = {};
  const sharedTimeout = positiveInt(isObject(providersRaw.defaults) ? providersRaw.defaults.timeout : undefined);
  const sharedEffort = isObject(providersRaw.defaults) && typeof providersRaw.defaults.reasoningEffort === "string" && providersRaw.defaults.reasoningEffort.trim()
    ? providersRaw.defaults.reasoningEffort.trim()
    : undefined;
  const sharedConsensusEffort = isObject(providersRaw.defaults) && typeof providersRaw.defaults.consensusReasoningEffort === "string" && providersRaw.defaults.consensusReasoningEffort.trim()
    ? providersRaw.defaults.consensusReasoningEffort.trim()
    : undefined;
  // Union the known providers in so a config that sets ONLY providers.defaults still
  // produces an entry per provider to carry the shared timeout. Absent = enabled, which
  // is what an omitted block already meant to the registry.
  const names = new Set([...KNOWN_PROVIDERS, ...Object.keys(providersRaw)]);
  for (const name of names) {
    if (name === "defaults") continue;
    const block = providersRaw[name];
    /** @type {{enabled:boolean, model?:string, reasoningEffort?:string, consensusReasoningEffort?:string, timeout?:number}} */
    const resolved = { enabled: !(isObject(block) && block.enabled === false) };
    if (isObject(block)) {
      if (name !== "openrouter") {
        for (const key of PINNABLE_KEYS) {
          const v = block[key];
          if (typeof v === "string" && v.trim()) resolved[key] = v.trim();
        }
        if (!resolved.reasoningEffort && sharedEffort) resolved.reasoningEffort = sharedEffort;
        if (!resolved.consensusReasoningEffort && sharedConsensusEffort) resolved.consensusReasoningEffort = sharedConsensusEffort;
      }
      const own = name === "openrouter"
        ? positiveInt(isObject(block.defaults) ? block.defaults.timeout : undefined)
        : positiveInt(block.timeout);
      const t = own !== undefined ? own : sharedTimeout;
      if (t !== undefined) resolved.timeout = t;
    } else {
      if (sharedTimeout !== undefined) resolved.timeout = sharedTimeout;
      if (name !== "openrouter") {
        if (sharedEffort) resolved.reasoningEffort = sharedEffort;
        if (sharedConsensusEffort) resolved.consensusReasoningEffort = sharedConsensusEffort;
      }
    }
    out[name] = resolved;
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
    if (m.reasoningEffort !== undefined && !(typeof m.reasoningEffort === "string" && m.reasoningEffort.trim())) {
      addInvalid(i, id, `models["${id}"] reasoningEffort must be a non-empty string`); continue;
    }
    if (m.consensusReasoningEffort !== undefined && !(typeof m.consensusReasoningEffort === "string" && m.consensusReasoningEffort.trim())) {
      addInvalid(i, id, `models["${id}"] consensusReasoningEffort must be a non-empty string`); continue;
    }
    if (m.timeout !== undefined && !(Number.isInteger(m.timeout) && m.timeout > 0)) {
      addInvalid(i, id, `models["${id}"] timeout must be a positive integer`); continue;
    }
    if (m.temperature !== undefined && !(typeof m.temperature === "number" && Number.isFinite(m.temperature))) {
      addInvalid(i, id, `models["${id}"] temperature must be a finite number`); continue;
    }
    if (m.default !== undefined && typeof m.default !== "boolean") {
      addInvalid(i, id, `models["${id}"] default must be a boolean`); continue;
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
      default: m.default === true,
      // camelCase -> wire mapping happens HERE (the one place): the on-disk
      // `reasoningEffort` becomes the resolved `.reasoning_effort` the bridge call
      // site (server/openrouter/index.js) sends to the API as `reasoning_effort`.
      reasoning_effort: typeof m.reasoningEffort === "string" ? m.reasoningEffort.trim() : undefined,
      consensus_reasoning_effort: typeof m.consensusReasoningEffort === "string" ? m.consensusReasoningEffort.trim() : undefined,
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
    return { consensus: { arbiter: DEFAULT_ARBITER, arbiterDefaulted: false, blindVote: false, maxWallMs: DEFAULT_CONSENSUS_MAX_WALL_MS, quorumFloor: DEFAULT_CONSENSUS_QUORUM_FLOOR }, warnings };
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

  // maxRounds: optional positive-integer cap on the server-side convergence loop
  // (consensus-auto / consensus-step). Invalid -> omit so the loop's default (5)
  // applies. Over MAX_ROUNDS_CAP -> clamp to the cap (the user wants many rounds;
  // clamping is more faithful than dropping to the default). Only included in the
  // resolved block when explicitly valid.
  /** @type {number|undefined} */
  let maxRounds;
  if (block.maxRounds !== undefined) {
    if (Number.isInteger(block.maxRounds) && block.maxRounds > 0) {
      maxRounds = Math.min(block.maxRounds, MAX_ROUNDS_CAP);
      if (block.maxRounds > MAX_ROUNDS_CAP) {
        warnings.push(`consensus.maxRounds ${block.maxRounds} exceeds the cap ${MAX_ROUNDS_CAP}; using ${MAX_ROUNDS_CAP}`);
      }
    } else {
      warnings.push(`consensus.maxRounds must be a positive integer (got ${JSON.stringify(block.maxRounds)}); using the default`);
    }
  }

  // maxWallMs: optional positive-integer wall-clock budget (ms) for the loop. A
  // present-but-invalid value falls back to DEFAULT_CONSENSUS_MAX_WALL_MS with a
  // warning (unlike maxRounds which is omitted on invalid; here the default always
  // applies so the documented 30-min cap holds even for pre-feature configs).
  let maxWallMs = DEFAULT_CONSENSUS_MAX_WALL_MS;
  if (block.maxWallMs !== undefined) {
    if (Number.isInteger(block.maxWallMs) && block.maxWallMs > 0) {
      maxWallMs = block.maxWallMs;
    } else {
      warnings.push(`consensus.maxWallMs must be a positive integer (got ${JSON.stringify(block.maxWallMs)}); using ${DEFAULT_CONSENSUS_MAX_WALL_MS}`);
    }
  }

  // quorumFloor: optional integer >= 1 quorum floor (min responding healthy reviews)
  // for consensus. Defaults to 2.
  let quorumFloor = DEFAULT_CONSENSUS_QUORUM_FLOOR;
  if (block.quorumFloor !== undefined) {
    if (Number.isInteger(block.quorumFloor) && block.quorumFloor >= 1) {
      quorumFloor = block.quorumFloor;
    } else {
      warnings.push(`consensus.quorumFloor must be an integer >= 1 (got ${JSON.stringify(block.quorumFloor)}); using ${DEFAULT_CONSENSUS_QUORUM_FLOOR}`);
    }
  }

  // arbiterDefaulted=true ONLY when the user did not set an arbiter at all, so the
  // server can pick host (under Claude Code) vs auto (elsewhere). An explicit but
  // invalid arbiter degrades to auto with arbiterDefaulted=false (the user did choose).
  const wrap = (/** @type {any} */ arbiter, /** @type {boolean} */ arbiterDefaulted) => ({
    consensus: maxRounds === undefined
      ? { arbiter, arbiterDefaulted, blindVote, maxWallMs, quorumFloor }
      : { arbiter, arbiterDefaulted, blindVote, maxRounds, maxWallMs, quorumFloor },
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
    let raw;
    try {
      raw = fs.readFileSync(filePath, "utf8");
    } catch (err) {
      if (err && /** @type {any} */ (err).code === "ENOENT") {
        return {
          ok: true,
          error: null,
          resolved: {
            version: 1,
            providers: {},
            openrouter: disabledOpenRouter(),
            consensus: { arbiter: DEFAULT_ARBITER, arbiterDefaulted: true, blindVote: false, maxWallMs: DEFAULT_CONSENSUS_MAX_WALL_MS, quorumFloor: DEFAULT_CONSENSUS_QUORUM_FLOOR },
            sessions: { persist: false, maxRecords: DEFAULT_SESSIONS_MAX_RECORDS, maxAgeDays: DEFAULT_SESSIONS_MAX_AGE_DAYS, captureText: false },
            dashboard: { enabled: false, capture: DEFAULT_DASHBOARD_CAPTURE, showPII: false, port: DEFAULT_DASHBOARD_PORT, maxRuns: DEFAULT_DASHBOARD_MAX_RUNS, maxAgeDays: DEFAULT_DASHBOARD_MAX_AGE_DAYS },
          },
          consensusWarnings: [],
        };
      }
      return fail(`read failed: ${err && /** @type {any} */ (err).message ? /** @type {any} */ (err).message : String(err)}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return fail(`JSON parse failed: ${err && /** @type {any} */ (err).message ? /** @type {any} */ (err).message : String(err)}`);
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
  validateConfig, makeConfigReader, resolveSessions, resolveDashboard, EXPERT_KEYS, RESERVED_ALIAS,
  DEFAULT_API_BASE, DEFAULT_API_KEY_ENV,
};
