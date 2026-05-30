"use strict";
/** @typedef {import("./types.js").Provider} Provider */

// Selection semantics mirror server/openrouter/routing.js so the two stay
// behaviorally identical. eligibleForExpert: experts null/undefined => all;
// [] => none; else must include the expert.
function eligibleForExpert(model, expert) {
  if (model.experts === null || model.experts === undefined) return true;
  if (model.experts.length === 0) return false;
  return model.experts.includes(expert);
}

function askAllDelegates(or, expert) {
  const pool = (or.models || []).filter((m) => m.askAll !== false && eligibleForExpert(m, expert));
  const cap = Number.isInteger(or.maxFanout) && or.maxFanout >= 1 ? or.maxFanout : 3;
  return { selected: pool.slice(0, cap), omitted: pool.slice(cap) };
}

function consensusDelegates(or, expert) {
  return (or.models || []).filter((m) => m.consensus === true && eligibleForExpert(m, expert));
}

const BUILTINS = ["codex", "gemini", "grok"];

// Wrap the single openrouter Provider as a per-alias Provider that pins the
// alias model and re-labels the result. This is the issue-001 fix: selection
// AND dispatch happen inside one server call, so the orchestrator never names
// an alias and a disabled one cannot leak from a stale cache.
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
  const byName = new Map(providers.map((p) => [p.name, p]));
  const enabled = (config, name) => {
    const p = config && config.providers && config.providers[name];
    return !p || p.enabled !== false; // missing = enabled
  };
  const builtinsFor = (config) => BUILTINS.filter((n) => byName.has(n) && enabled(config, n)).map((n) => byName.get(n));
  const pinDelegates = (delegates) => {
    const orProvider = byName.get("openrouter");
    return orProvider ? delegates.map((d) => pinAlias(orProvider, d)) : [];
  };

  return {
    get: (n) => byName.get(n),

    // Flat provider list ready for askAll(): built-ins + per-alias OR wrappers.
    selectForAskAll({ config, expert }) {
      const or = (config && config.openrouter) || {};
      const { selected, omitted } = askAllDelegates(or, expert);
      return { providers: [...builtinsFor(config), ...pinDelegates(selected)], omitted };
    },

    // Uncapped: built-ins + per-alias OR consensus delegates.
    selectForConsensus({ config, expert }) {
      const or = (config && config.openrouter) || {};
      return { providers: [...builtinsFor(config), ...pinDelegates(consensusDelegates(or, expert))] };
    },
  };
}

module.exports = { makeRegistry, eligibleForExpert, askAllDelegates, consensusDelegates, pinAlias };
