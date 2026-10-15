"use strict";
/** @typedef {import("./types.js").Provider} Provider */

/**
 * A configured OpenRouter model entry from the deliberation config
 * (~/.config/deliberation/config.json; override with DELIBERATION_CONFIG).
 * @typedef {Object} OrModel
 * @property {string}  alias
 * @property {string}  [model]
 * @property {string}  [provider]
 * @property {string}  [preset]
 * @property {boolean} [askAll]
 * @property {boolean} [consensus]
 * @property {(string[]|null)} [experts]
 * @property {string}  [reasoning_effort]
 * @property {string}  [consensus_reasoning_effort]
 * @property {number}  [temperature]
 * @property {number}  [timeout]
 * @property {string}  [apiBase]
 * @property {string}  [apiKeyEnv]
 */

/**
 * The `openrouter` block of the loaded config.
 * @typedef {Object} OrConfig
 * @property {OrModel[]} [models]
 * @property {number}    [maxFanout]
 * @property {string}    [preset]
 * @property {Record<string, any>} [defaults]
 */

/**
 * Per-provider enable flags from the loaded config.
 * @typedef {Object} ProviderFlag
 * @property {boolean} [enabled]
 * @property {number}  [timeout]
 * @property {string}  [apiBase]
 * @property {string}  [apiKeyEnv]
 * @property {string}  [model]
 */

/**
 * The loaded delegator config (subset consumed by the registry).
 * @typedef {Object} RegistryConfig
 * @property {Object.<string, ProviderFlag>} [providers]
 * @property {OrConfig} [openrouter]
 */

// Selection semantics mirror server/openrouter/routing.js so the two stay
// behaviorally identical. eligibleForExpert: experts null/undefined => all;
// [] => none; else must include the expert.
/**
 * @param {OrModel} model
 * @param {string} expert
 * @returns {boolean}
 */
function eligibleForExpert(model, expert) {
  if (model.experts === null || model.experts === undefined) return true;
  if (model.experts.length === 0) return false;
  return model.experts.includes(expert);
}

/**
 * @param {OrConfig} or
 * @param {string} expert
 * @returns {{selected: OrModel[], omitted: OrModel[]}}
 */
function askAllDelegates(or, expert) {
  const pool = (or.models || []).filter((/** @type {OrModel} */ m) => m.askAll !== false && eligibleForExpert(m, expert));
  const cap = Number.isInteger(or.maxFanout) && /** @type {number} */ (or.maxFanout) >= 1 ? /** @type {number} */ (or.maxFanout) : 3;
  return { selected: pool.slice(0, cap), omitted: pool.slice(cap) };
}

/**
 * @param {OrConfig} or
 * @param {string} expert
 * @returns {OrModel[]}
 */
function consensusDelegates(or, expert) {
  return (or.models || []).filter((/** @type {OrModel} */ m) => m.consensus === true && eligibleForExpert(m, expert));
}

const BUILTINS = ["codex", "gemini", "grok"];

// Wrap the single openrouter/local Provider as a per-alias Provider that pins the
// alias model and re-labels the result. This is the issue-001 fix: selection
// AND dispatch happen inside one server call, so the orchestrator never names
// an alias and a disabled one cannot leak from a stale cache.
/** @param {OrModel|any} m */
function formatDelegateName(m) {
  const prov = m.provider || "openrouter";
  return `${prov}:${m.alias}`;
}

/**
 * @param {Provider} baseProvider
 * @param {OrModel} delegate
 * @param {Record<string, any>} [defaults]
 * @param {RegistryConfig} [config]
 * @returns {Provider}
 */
function pinAlias(baseProvider, delegate, defaults, config) {
  const prov = delegate.provider || "openrouter";
  const name = formatDelegateName(delegate);

  const provTimeout = config && config.providers && config.providers[prov] && config.providers[prov].timeout;
  const configuredTimeout = delegate.timeout !== undefined ? delegate.timeout : provTimeout;

  return {
    name,
    alias: delegate.alias,
    provider: prov,
    model: delegate.model,
    capabilities: baseProvider.capabilities,
    health: baseProvider.health.bind(baseProvider),
    resolveSettings(req) {
      const base = baseProvider.resolveSettings?.(req);
      const isConsensus = req.context === "consensus";
      const defaultEffort = isConsensus
        ? (delegate.consensus_reasoning_effort ?? (defaults && defaults.consensus_reasoning_effort) ?? delegate.reasoning_effort ?? (defaults && defaults.reasoning_effort))
        : (delegate.reasoning_effort ?? (defaults && defaults.reasoning_effort));
      const defaultPreset = delegate.preset ?? (defaults && defaults.preset);
      const cfg = {
        openrouter: { models: [delegate], defaults, preset: defaults?.preset },
        providers: {
          [prov]: { timeout: base?.timeoutMs ?? configuredTimeout, preset: delegate.preset || defaults?.preset },
        },
      };
      return require("./settings.js").resolveSettings(name, cfg, req);
    },
    async ask(req) {
      // Forward the delegate's configured params with ARG-WINS precedence (an
      // explicit caller value beats the model default), mapping config/wire field
      // names to the DelegationRequest fields openai-compatible.js reads. NOTE: only
      // reasoningEffort/temperature/timeout flow here; per-model apiBase and apiKeyEnv
      // apply on the standalone /ask-openrouter bridge path.
      const isConsensus = req.context === "consensus";
      const defaultEffort = isConsensus
        ? (delegate.consensus_reasoning_effort ?? (defaults && defaults.consensus_reasoning_effort) ?? delegate.reasoning_effort ?? (defaults && defaults.reasoning_effort))
        : (delegate.reasoning_effort ?? (defaults && defaults.reasoning_effort));
      const defaultPreset = delegate.preset ?? (defaults && defaults.preset);
      const r = await baseProvider.ask({
        ...req,
        model: delegate.model !== undefined ? delegate.model : (delegate.preset ? "" : req.model),
        preset: req.preset ?? defaultPreset,
        // delegate.reasoning_effort / consensus_reasoning_effort is validated as a string upstream;
        // cast to the DelegationRequest union (the bridge tolerates any effort string).
        reasoningEffort: req.reasoningEffort ?? /** @type {("low"|"medium"|"high"|"none"|undefined)} */ (defaultEffort),
        temperature: req.temperature ?? delegate.temperature ?? (defaults && defaults.temperature),
        timeoutMs: req.timeoutMs ?? configuredTimeout,
      });
      return { ...r, provider: name };
    },
  };
}

/** @param {Provider[]} providers */
function makeRegistry(providers) {
  const byName = new Map();
  for (const p of providers) {
    byName.set(p.name, p);
  }

  /**
   * @param {RegistryConfig} config
   * @param {string} name
   * @returns {boolean}
   */
  const enabled = (config, name) => {
    const p = config && config.providers && config.providers[name];
    return !p || p.enabled !== false; // missing = enabled
  };
  /**
   * Enabled built-ins, split by health. `unhealthy` (name -> reason) comes from the server's
   * stat-only probes; a provider that cannot answer (no CLI, no credential) is reported in
   * `unavailable` instead of being dispatched to fail - so a dead peer costs a fan-out nothing.
   * @param {RegistryConfig} config
   * @param {(Map<string,string>|undefined)} unhealthy
   * @returns {{providers: Provider[], unavailable: {name:string, reason:string}[]}}
   */
  const builtinsFor = (config, unhealthy) => {
    /** @type {Provider[]} */ const providers = [];
    /** @type {{name:string, reason:string}[]} */ const unavailable = [];
    for (const n of BUILTINS) {
      if (!byName.has(n) || !enabled(config, n)) continue;
      const p = /** @type {Provider} */ (byName.get(n));
      const reason = unhealthy && (unhealthy.get(n) || unhealthy.get(p.name));
      if (reason) unavailable.push({ name: p.name, reason });
      else providers.push(p);
    }
    return { providers, unavailable };
  };
  /** @param {OrModel[]} delegates @param {Record<string, any>} [defaults] @param {RegistryConfig} [config] @returns {{providers: Provider[], unavailable: {name:string, reason:string}[]}} */
  const pinDelegates = (delegates, defaults, config) => {
    /** @type {Provider[]} */
    const res = [];
    /** @type {{name:string, reason:string}[]} */
    const unavailable = [];
    for (const d of delegates) {
      const prov = d.provider || "openrouter";
      const targetProvider = byName.get(prov);
      if (targetProvider) {
        res.push(pinAlias(targetProvider, d, defaults, config));
      } else {
        unavailable.push({ name: formatDelegateName(d), reason: `provider "${prov}" is not registered` });
      }
    }
    return { providers: res, unavailable };
  };

  return {
    /** @param {string} n */
    get: (n) => byName.get(n),

    // Flat provider list ready for askAll(): healthy built-ins + per-alias OR wrappers.
    // `omitted` = OR aliases over the fanout cap; `unavailable` = built-ins that cannot answer.
    /** @param {{config: RegistryConfig, expert: string, unhealthy?: Map<string,string>}} args */
    selectForAskAll({ config, expert, unhealthy }) {
      const or = (config && config.openrouter) || {};
      const { selected, omitted } = askAllDelegates(or, expert);
      const b = builtinsFor(config, unhealthy);
      const pinned = pinDelegates(selected, or.defaults, config);
      return { providers: [...b.providers, ...pinned.providers], omitted, unavailable: [...b.unavailable, ...pinned.unavailable] };
    },

    // Uncapped: healthy built-ins + per-alias OR consensus delegates.
    /** @param {{config: RegistryConfig, expert: string, unhealthy?: Map<string,string>}} args */
    selectForConsensus({ config, expert, unhealthy }) {
      const or = (config && config.openrouter) || {};
      const b = builtinsFor(config, unhealthy);
      const pinned = pinDelegates(consensusDelegates(or, expert), or.defaults, config);
      return { providers: [...b.providers, ...pinned.providers], unavailable: [...b.unavailable, ...pinned.unavailable] };
    },
  };
}

module.exports = { makeRegistry, eligibleForExpert, askAllDelegates, consensusDelegates, pinAlias, formatDelegateName };
