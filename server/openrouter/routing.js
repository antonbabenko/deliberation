// @ts-nocheck -- legacy bridge; predates the strict typecheck gate (core-only). Opt-in is a separate pass.
"use strict";

// NOTE: askAllDelegates/consensusDelegates/eligibleForExpert are the canonical
// selection semantics for fan-out. The bridge runtime calls them from openrouter-list
// (mode:"ask-all"|"consensus") so /ask-all and /consensus dispatch exactly the returned
// `selected` set instead of re-deriving selection in command prose. These exports are the
// single source of truth and are unit-tested in test/openrouter-routing.test.js.

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
  // Fallback to 3 is defensive only: the config validator already rejects maxFanout<1, so validated configs never hit it.
  const cap = Number.isInteger(or.maxFanout) && or.maxFanout >= 1 ? or.maxFanout : 3;
  return { selected: pool.slice(0, cap), omitted: pool.slice(cap) };
}

// /consensus voting voices: eligible AND consensus===true. NOT maxFanout-capped.
function consensusDelegates(or, expert) {
  return (or.models || []).filter((m) => m.consensus === true && eligibleForExpert(m, expert));
}

// Resolve an alias to a delegate-like object, or null.
// openrouter-default resolves to the configured defaultModel (null if unset).
// The synthetic object for openrouter-default intentionally carries ONLY { alias, model, experts }:
// it is a single-shot fallback delegate and deliberately omits askAll/consensus because
// openrouter-default never participates in /ask-all or /consensus fan-out.
function resolveAlias(or, alias) {
  if (alias === RESERVED_ALIAS) {
    return or.defaultModel ? { alias: RESERVED_ALIAS, model: or.defaultModel, experts: null } : null;
  }
  return (or.models || []).find((m) => m.alias === alias) || null;
}

module.exports = { eligibleForExpert, askAllDelegates, consensusDelegates, resolveAlias, RESERVED_ALIAS };
