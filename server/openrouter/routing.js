"use strict";

const RESERVED_ALIAS = "openrouter-default";

// A model is eligible for expert E iff experts is null/undefined (all), OR (non-empty and includes E).
// experts === [] => never auto-eligible.
function eligibleForExpert(model, expert) {
  if (model.experts === null || model.experts === undefined) return true;
  if (model.experts.length === 0) return false;
  return model.experts.includes(expert);
}

// /ask-all participants: eligible AND askAll!=false, config order, truncated to maxFanout.
// Returns { selected, omitted }.
function askAllDelegates(or, expert) {
  const pool = (or.models || []).filter((m) => m.askAll !== false && eligibleForExpert(m, expert));
  const cap = Number.isInteger(or.maxFanout) && or.maxFanout >= 1 ? or.maxFanout : 3;
  return { selected: pool.slice(0, cap), omitted: pool.slice(cap) };
}

// /consensus voting voices: eligible AND consensus===true. NOT maxFanout-capped.
function consensusDelegates(or, expert) {
  return (or.models || []).filter((m) => m.consensus === true && eligibleForExpert(m, expert));
}

// Resolve an alias to a delegate-like object, or null.
// openrouter-default resolves to the configured defaultModel (null if unset).
function resolveAlias(or, alias) {
  if (alias === RESERVED_ALIAS) {
    return or.defaultModel ? { alias: RESERVED_ALIAS, model: or.defaultModel, experts: null } : null;
  }
  return (or.models || []).find((m) => m.alias === alias) || null;
}

module.exports = { eligibleForExpert, askAllDelegates, consensusDelegates, resolveAlias, RESERVED_ALIAS };
