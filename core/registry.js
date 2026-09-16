"use strict";
/** @typedef {import("./types.js").Provider} Provider */

/**
 * A configured OpenRouter model entry from the deliberation config
 * (~/.config/deliberation/config.json; override with DELIBERATION_CONFIG).
 * @typedef {Object} OrModel
 * @property {string}  alias
 * @property {string}  model
 * @property {boolean} [askAll]
 * @property {boolean} [consensus]
 * @property {(string[]|null)} [experts]
 * @property {string}  [reasoning_effort]
 * @property {number}  [temperature]
 * @property {number}  [timeout]
 */

/**
 * The `openrouter` block of the loaded config.
 * @typedef {Object} OrConfig
 * @property {OrModel[]} [models]
 * @property {number}    [maxFanout]
 */

/**
 * Per-provider enable flags from the loaded config.
 * @typedef {Object} ProviderFlag
 * @property {boolean} [enabled]
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

// Wrap the single openrouter Provider as a per-alias Provider that pins the
// alias model and re-labels the result. This is the issue-001 fix: selection
// AND dispatch happen inside one server call, so the orchestrator never names
// an alias and a disabled one cannot leak from a stale cache.
function formatDelegateName(delegate) {
  const prov = delegate.provider || "openrouter";
  if (prov === "ollama") {
    return `ollama:${delegate.model || delegate.alias}`;
  }
  if (prov === "lmstudio" || prov === "llmstudio") {
    return `lmstudio:${delegate.model || delegate.alias}`;
  }
  if (prov === "google" || prov === "gemini") {
    return `google:${delegate.model || delegate.alias}`;
  }
  return `${prov}:${delegate.alias}`;
}

/**
 * @param {Provider} orProvider
 * @param {OrModel} delegate
 * @param {RegistryConfig} [config]
 * @returns {Provider}
 */
function pinAlias(orProvider, delegate, config) {
  const prov = delegate.provider || "openrouter";
  const name = formatDelegateName(delegate);

  let apiBase = delegate.apiBase;
  if (!apiBase && config && config.providers) {
    if (prov === "ollama") {
      apiBase = (config.providers.ollama && config.providers.ollama.apiBase) || "http://localhost:11434/v1";
    } else if (prov === "lmstudio" || prov === "llmstudio") {
      apiBase = (config.providers.lmstudio && config.providers.lmstudio.apiBase) || (config.providers.llmstudio && config.providers.llmstudio.apiBase) || "http://localhost:1234/v1";
    }
  }

  let apiKey = delegate.apiKey;
  let apiKeyEnv = delegate.apiKeyEnv;
  if (!apiKey && !apiKeyEnv && (prov === "ollama" || prov === "lmstudio" || prov === "llmstudio")) {
    const pCfg = config && config.providers && (config.providers[prov] || config.providers.lmstudio || config.providers.llmstudio);
    apiKeyEnv = (pCfg && pCfg.apiKeyEnv) || "NONE";
  }

  return {
    name,
    alias: delegate.alias,
    provider: prov,
    model: delegate.model,
    apiBase,
    apiKeyEnv,
    capabilities: orProvider.capabilities,
    health: async () => {
      if (prov === "ollama" || prov === "lmstudio" || prov === "llmstudio") {
        return { ok: true };
      }
      return orProvider.health();
    },
    async ask(req) {
      // Forward the delegate's configured params with ARG-WINS precedence (an
      // explicit caller value beats the model default), mapping config/wire field
      // names to the DelegationRequest fields openai-compatible.js reads.
      const r = await orProvider.ask({
        ...req,
        model: delegate.model,
        apiBase: apiBase || req.apiBase,
        apiKey: apiKey || req.apiKey,
        apiKeyEnv: apiKeyEnv || req.apiKeyEnv,
        // delegate.reasoning_effort is validated as a string upstream; cast to the
        // DelegationRequest union (the bridge tolerates any effort string).
        reasoningEffort: req.reasoningEffort ?? /** @type {("low"|"medium"|"high"|"none"|undefined)} */ (delegate.reasoning_effort),
        temperature: req.temperature ?? delegate.temperature,
        timeoutMs: req.timeoutMs ?? delegate.timeout,
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
    if (p.name.startsWith("google:") || p.name.startsWith("gemini:")) {
      byName.set("gemini", p);
      byName.set("google", p);
    }
  }

  /**
   * @param {RegistryConfig} config
   * @param {string} name
   * @returns {boolean}
   */
  const enabled = (config, name) => {
    const p = config && config.providers && (config.providers[name] || (name === "google" && config.providers.gemini));
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
  /** @param {OrModel[]} delegates @param {RegistryConfig} [config] @returns {Provider[]} */
  const pinDelegates = (delegates, config) => {
    const orProvider = byName.get("openrouter");
    return orProvider ? delegates.map((/** @type {OrModel} */ d) => pinAlias(orProvider, d, config)) : [];
  };

  return {
    /** @param {string} n */
    get: (n) => {
      if (byName.has(n)) return byName.get(n);
      if (n === "gemini" || n === "google") {
        for (const [k, p] of byName.entries()) {
          if (k.startsWith("google:") || k.startsWith("gemini:")) return p;
        }
      }
      return undefined;
    },

    // Flat provider list ready for askAll(): healthy built-ins + per-alias OR wrappers.
    // `omitted` = OR aliases over the fanout cap; `unavailable` = built-ins that cannot answer.
    /** @param {{config: RegistryConfig, expert: string, unhealthy?: Map<string,string>}} args */
    selectForAskAll({ config, expert, unhealthy }) {
      const or = (config && config.openrouter) || {};
      const { selected, omitted } = askAllDelegates(or, expert);
      const b = builtinsFor(config, unhealthy);
      return { providers: [...b.providers, ...pinDelegates(selected, config)], omitted, unavailable: b.unavailable };
    },

    // Uncapped: healthy built-ins + per-alias OR consensus delegates.
    /** @param {{config: RegistryConfig, expert: string, unhealthy?: Map<string,string>}} args */
    selectForConsensus({ config, expert, unhealthy }) {
      const or = (config && config.openrouter) || {};
      const b = builtinsFor(config, unhealthy);
      return { providers: [...b.providers, ...pinDelegates(consensusDelegates(or, expert), config)], unavailable: b.unavailable };
    },
  };
}

module.exports = { makeRegistry, eligibleForExpert, askAllDelegates, consensusDelegates, pinAlias };
