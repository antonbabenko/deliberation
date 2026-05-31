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
/**
 * @param {Provider} orProvider
 * @param {OrModel} delegate
 * @returns {Provider}
 */
function pinAlias(orProvider, delegate) {
  return {
    name: `openrouter:${delegate.alias}`,
    capabilities: orProvider.capabilities,
    health: orProvider.health.bind(orProvider),
    async ask(req) {
      const r = await orProvider.ask({ ...req, model: delegate.model });
      return { ...r, provider: `openrouter:${delegate.alias}` };
    },
  };
}

/** @param {Provider[]} providers */
function makeRegistry(providers) {
  const byName = new Map(providers.map((/** @type {Provider} */ p) => [p.name, p]));
  /**
   * @param {RegistryConfig} config
   * @param {string} name
   * @returns {boolean}
   */
  const enabled = (config, name) => {
    const p = config && config.providers && config.providers[name];
    return !p || p.enabled !== false; // missing = enabled
  };
  /** @param {RegistryConfig} config @returns {Provider[]} */
  const builtinsFor = (config) =>
    BUILTINS.filter((n) => byName.has(n) && enabled(config, n)).map((n) => /** @type {Provider} */ (byName.get(n)));
  /** @param {OrModel[]} delegates @returns {Provider[]} */
  const pinDelegates = (delegates) => {
    const orProvider = byName.get("openrouter");
    return orProvider ? delegates.map((/** @type {OrModel} */ d) => pinAlias(orProvider, d)) : [];
  };

  return {
    /** @param {string} n */
    get: (n) => byName.get(n),

    // Flat provider list ready for askAll(): built-ins + per-alias OR wrappers.
    /** @param {{config: RegistryConfig, expert: string}} args */
    selectForAskAll({ config, expert }) {
      const or = (config && config.openrouter) || {};
      const { selected, omitted } = askAllDelegates(or, expert);
      return { providers: [...builtinsFor(config), ...pinDelegates(selected)], omitted };
    },

    // Uncapped: built-ins + per-alias OR consensus delegates.
    /** @param {{config: RegistryConfig, expert: string}} args */
    selectForConsensus({ config, expert }) {
      const or = (config && config.openrouter) || {};
      return { providers: [...builtinsFor(config), ...pinDelegates(consensusDelegates(or, expert))] };
    },
  };
}

module.exports = { makeRegistry, eligibleForExpert, askAllDelegates, consensusDelegates, pinAlias };
