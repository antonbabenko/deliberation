"use strict";

/**
 * core/analyze.js - pure analytics over the debug log + session store.
 *
 * Zero runtime dependencies. CommonJS. JSDoc-typed for the strict `tsc` gate
 * (inside the strict tsconfig include). No filesystem access here: the caller
 * (the MCP `analyze` tool) reads the files and passes parsed events + records +
 * config; this module only aggregates and recommends. That keeps it host-neutral
 * and unit-testable with plain fixtures.
 *
 * Two lenses, NEVER joined:
 *   - Lens A (timing/cost) comes from the debug log (`provider_result` events):
 *     latency + tokens + reasoning effort per model. No text.
 *   - Lens B (agreement-rate) comes from session records: how often a model's
 *     review verdict matched the run's final verdict. No timing.
 * The debug log and the session store share NO run id, so the two lenses are
 * reported side by side and a "slow AND low-value" call is a CANDIDATE, never a
 * joined fact. All recommendations are advisory; nothing here writes anything.
 */

/** A model is a slow outlier when its p95 latency is >= this multiple of the fastest-peer baseline. */
const SLOW_FACTOR = 2;
/** Floor for the fastest-peer baseline (ms): neutralizes cache-fast (~0ms) calls so they
 * can't make every other model look like an outlier, and avoids flagging on tiny absolute gaps. */
const MIN_BASELINE_MS = 200;
/** ...and only when it has at least this many calls (one slow call is noise). */
const MIN_CALLS = 2;
/** Absolute slow gate (ms): a p95 at/above this is flagged regardless of the panel median. */
const ABS_SLOW_MS = 120000;
/** Error rate at/above this flags a model as unreliable. */
const HIGH_ERROR_RATE = 0.5;
/** Agreement rate at/above this (with enough votes) marks a model as rarely-dissenting. */
const HIGH_AGREEMENT = 0.9;
/** ...needs at least this many votes for the agreement signal to mean anything. */
const MIN_VOTES = 3;
/** OpenRouter provider-name prefix; the suffix is the config `models` map key (alias). */
const OR_PREFIX = "openrouter:";

/**
 * @typedef {import("./debug-log.js").DebugEvent} DebugEvent
 * @typedef {import("./sessions.js").SessionRecord} SessionRecord
 */

/**
 * @typedef {Object} LatencyStat
 * @property {number} p50
 * @property {number} p95
 * @property {number} max
 * @property {number} mean
 */

/**
 * @typedef {Object} ModelStat
 * @property {string} provider
 * @property {string} model
 * @property {number} calls
 * @property {number} errors
 * @property {number} errorRate
 * @property {LatencyStat} ms
 * @property {(number|null)} meanTokens  mean total tokens (HTTP providers); null for CLI providers
 * @property {string[]} reasoningEfforts  distinct efforts seen ("n/a" for the CLI null)
 * @property {string[]} tools  distinct tools the model was called under
 */

/**
 * @typedef {Object} AgreementStat
 * @property {string} provider
 * @property {string} model
 * @property {number} votes  records where this model cast a verdict AND the run had a final verdict
 * @property {number} agreed  of those, how many matched the final verdict
 * @property {(number|null)} agreementRate  agreed/votes, or null when votes === 0
 * @property {number} abstained  opinions with no verdict (e.g. ask-all runs, or errors)
 */

/**
 * @typedef {Object} Outlier
 * @property {string} provider
 * @property {string} model
 * @property {("slow-relative"|"slow-absolute"|"high-error")} kind
 * @property {string} detail
 */

/**
 * @typedef {Object} Suggestion
 * @property {("deliberation"|"external")} target  deliberation config.json, or an external tool config
 * @property {string} subject  the provider/model the suggestion is about
 * @property {(string|null)} configKey  exact config.json key path, or null for external
 * @property {string} action  what to change
 * @property {string} rationale  why
 */

/**
 * @typedef {Object} AnalysisMeta
 * @property {string} [logPath]
 * @property {boolean} debugEnabled
 * @property {boolean} sessionsPersist
 * @property {number} eventsParsed
 * @property {number} sessionsRead
 * @property {(string|null)} sessionsDir  dir the running server resolved (for the doctor drift check)
 * @property {number} agreementVotes  total agreement votes across models (0 with sessionsRead>0 => no per-opinion verdicts)
 * @property {boolean} insufficientData  true when there are no provider_result events to analyze
 */

/**
 * @typedef {Object} Analysis
 * @property {ModelStat[]} stats  Lens A (timing/cost), slowest p95 first
 * @property {AgreementStat[]} agreement  Lens B (verdict agreement), least-agreeing first
 * @property {Outlier[]} outliers
 * @property {Suggestion[]} recommendations
 * @property {AnalysisMeta} meta
 */

/**
 * Parse a JSONL debug log into events. Tolerant: blank and malformed lines are
 * skipped, and only objects with a string `event` survive. Never throws.
 * @param {string} text
 * @returns {DebugEvent[]}
 */
function parseDebugLog(text) {
  if (typeof text !== "string" || text.length === 0) return [];
  /** @type {DebugEvent[]} */
  const out = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (obj && typeof obj === "object" && typeof obj.event === "string") {
      out.push(/** @type {DebugEvent} */ (obj));
    }
  }
  return out;
}

/**
 * Percentile of an ascending-sorted numeric array via linear interpolation.
 * Returns 0 for an empty array.
 * @param {number[]} sorted  ascending
 * @param {number} p  0..100
 * @returns {number}
 */
function percentile(sorted, p) {
  if (!sorted.length) return 0;
  if (sorted.length === 1) return sorted[0];
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/**
 * Lens A. Aggregate `provider_result` events per provider+model: call count,
 * error rate, latency percentiles, mean tokens (HTTP only), reasoning efforts and
 * tools seen. Sorted slowest p95 first.
 * @param {DebugEvent[]} events
 * @returns {ModelStat[]}
 */
function aggregateByModel(events) {
  /** @type {Map<string, {provider:string, model:string, ms:number[], errors:number, calls:number, tokens:number[], efforts:Set<string>, tools:Set<string>}>} */
  const groups = new Map();
  for (const e of Array.isArray(events) ? events : []) {
    if (!e || e.event !== "provider_result" || typeof e.provider !== "string") continue;
    const provider = e.provider;
    const model = typeof e.model === "string" ? e.model : "";
    const key = `${provider}|${model}`;
    let g = groups.get(key);
    if (!g) {
      g = { provider, model, ms: [], errors: 0, calls: 0, tokens: [], efforts: new Set(), tools: new Set() };
      groups.set(key, g);
    }
    g.calls += 1;
    if (e.isError) g.errors += 1;
    if (typeof e.ms === "number" && Number.isFinite(e.ms)) g.ms.push(e.ms);
    const tot = e.usage && typeof e.usage.totalTokens === "number" ? e.usage.totalTokens : undefined;
    if (typeof tot === "number" && Number.isFinite(tot)) g.tokens.push(tot);
    g.efforts.add(e.reasoningEffort == null ? "n/a" : String(e.reasoningEffort));
    if (typeof e.tool === "string") g.tools.add(e.tool);
  }
  /** @type {ModelStat[]} */
  const stats = [];
  for (const g of groups.values()) {
    const sorted = g.ms.slice().sort((a, b) => a - b);
    const mean = sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : 0;
    stats.push({
      provider: g.provider,
      model: g.model,
      calls: g.calls,
      errors: g.errors,
      errorRate: g.calls ? g.errors / g.calls : 0,
      ms: {
        p50: Math.round(percentile(sorted, 50)),
        p95: Math.round(percentile(sorted, 95)),
        max: sorted.length ? sorted[sorted.length - 1] : 0,
        mean: Math.round(mean),
      },
      meanTokens: g.tokens.length ? Math.round(g.tokens.reduce((a, b) => a + b, 0) / g.tokens.length) : null,
      reasoningEfforts: Array.from(g.efforts).sort(),
      tools: Array.from(g.tools).sort(),
    });
  }
  stats.sort((a, b) => b.ms.p95 - a.ms.p95);
  return stats;
}

/**
 * Lens B. Per provider+model, the agreement rate = share of its review verdicts
 * that matched the run's FINAL verdict. Only records that carry a final `verdict`
 * (consensus loop runs) contribute votes; ask-all records (no final verdict) only
 * add to `abstained`. Sorted least-agreeing first (most "unique"), abstain-only
 * models last.
 * @param {SessionRecord[]} records
 * @returns {AgreementStat[]}
 */
function aggregateAgreement(records) {
  /** @type {Map<string, {provider:string, model:string, votes:number, agreed:number, abstained:number}>} */
  const groups = new Map();
  for (const rec of Array.isArray(records) ? records : []) {
    if (!rec || !Array.isArray(rec.opinions)) continue;
    const finalVerdict = typeof rec.verdict === "string" ? rec.verdict : null;
    for (const op of rec.opinions) {
      if (!op || typeof op.provider !== "string") continue;
      const provider = op.provider;
      const model = typeof op.model === "string" ? op.model : "";
      const key = `${provider}|${model}`;
      let g = groups.get(key);
      if (!g) {
        g = { provider, model, votes: 0, agreed: 0, abstained: 0 };
        groups.set(key, g);
      }
      const opVerdict = typeof op.verdict === "string" ? op.verdict : null;
      if (finalVerdict && opVerdict) {
        g.votes += 1;
        if (opVerdict === finalVerdict) g.agreed += 1;
      } else {
        g.abstained += 1;
      }
    }
  }
  /** @type {AgreementStat[]} */
  const out = [];
  for (const g of groups.values()) {
    out.push({
      provider: g.provider,
      model: g.model,
      votes: g.votes,
      agreed: g.agreed,
      agreementRate: g.votes ? g.agreed / g.votes : null,
      abstained: g.abstained,
    });
  }
  // Least-agreeing first (most independent signal); models with no votes sink to the bottom.
  out.sort((a, b) => {
    const ar = a.agreementRate == null ? Infinity : a.agreementRate;
    const br = b.agreementRate == null ? Infinity : b.agreementRate;
    return ar - br;
  });
  return out;
}

/**
 * Flag latency/error outliers from Lens A. The relative baseline is the FASTEST
 * eligible model's p95 (floored at MIN_BASELINE_MS), so a panel with several slow
 * models still flags them all against the fast ones - and a uniformly-slow panel
 * flags none. A model is "slow-relative" when its p95 >= SLOW_FACTOR x that
 * baseline, "slow-absolute" when its p95 >= ABS_SLOW_MS, "high-error" when
 * errorRate >= HIGH_ERROR_RATE. Models below MIN_CALLS are never flagged.
 * @param {ModelStat[]} stats
 * @returns {Outlier[]}
 */
function detectOutliers(stats) {
  const eligible = (Array.isArray(stats) ? stats : []).filter((s) => s.calls >= MIN_CALLS);
  if (!eligible.length) return [];
  const fastestP95 = Math.min(...eligible.map((s) => s.ms.p95));
  const baseline = Math.max(fastestP95, MIN_BASELINE_MS);
  /** @type {Outlier[]} */
  const out = [];
  for (const s of eligible) {
    if (s.errorRate >= HIGH_ERROR_RATE) {
      out.push({ provider: s.provider, model: s.model, kind: "high-error", detail: `${Math.round(s.errorRate * 100)}% of ${s.calls} calls errored` });
    }
    if (s.ms.p95 >= ABS_SLOW_MS) {
      out.push({ provider: s.provider, model: s.model, kind: "slow-absolute", detail: `p95 ${s.ms.p95}ms (>= ${ABS_SLOW_MS}ms)` });
    } else if (s.ms.p95 >= SLOW_FACTOR * baseline) {
      out.push({ provider: s.provider, model: s.model, kind: "slow-relative", detail: `p95 ${s.ms.p95}ms vs fastest-peer baseline ${Math.round(baseline)}ms` });
    }
  }
  return out;
}

/**
 * Map a debug-log provider name to where its tuning lever lives.
 * @param {string} provider
 * @returns {{kind:"openrouter"|"external"|"grok"|"unknown", alias?:string}}
 */
function leverFor(provider) {
  if (provider.startsWith(OR_PREFIX)) return { kind: "openrouter", alias: provider.slice(OR_PREFIX.length) };
  if (provider === "codex" || provider === "gemini") return { kind: "external" };
  if (provider === "grok") return { kind: "grok" };
  return { kind: "unknown" };
}

/**
 * Advisory tuning suggestions. NEVER writes; each suggestion names the exact
 * config key (for deliberation-owned levers) or points at the external tool
 * (Codex/Gemini reasoning, which live outside deliberation's config). Combines
 * the slow outliers (Lens A) with the agreement signal (Lens B), reported as a
 * candidate, not a joined fact.
 * @param {ModelStat[]} stats
 * @param {AgreementStat[]} agreement
 * @param {any} config  untrusted config.json contents
 * @returns {Suggestion[]}
 */
function recommend(stats, agreement, config) {
  const cfg = config && typeof config === "object" ? config : {};
  const models = cfg.models && typeof cfg.models === "object" ? cfg.models : {};
  const outliers = detectOutliers(stats);
  /** @type {Map<string, AgreementStat>} */
  const agreeBy = new Map();
  for (const a of Array.isArray(agreement) ? agreement : []) agreeBy.set(a.provider, a);
  /** @type {Suggestion[]} */
  const out = [];
  let slowOpenRouterCount = 0;

  for (const o of outliers) {
    if (o.kind === "high-error") {
      const lever = leverFor(o.provider);
      out.push({
        target: lever.kind === "openrouter" ? "deliberation" : "external",
        subject: o.provider,
        configKey: lever.kind === "openrouter" ? `models.${lever.alias}.askAll` : null,
        action: lever.kind === "openrouter" ? `set models.${lever.alias}.askAll=false until it stabilizes` : `check the ${o.provider} credentials/CLI session`,
        rationale: o.detail,
      });
      continue;
    }
    // A slow model. Find which alias-config key to suggest, and fold in agreement.
    const lever = leverFor(o.provider);
    const agree = agreeBy.get(o.provider);
    const rarelyDissents = !!(agree && agree.agreementRate != null && agree.votes >= MIN_VOTES && agree.agreementRate >= HIGH_AGREEMENT);
    const valueNote = rarelyDissents
      ? ` It also agreed with the final verdict ${agree ? Math.round((agree.agreementRate || 0) * 100) : 0}% of ${agree ? agree.votes : 0} votes (rarely adds dissent), so it is the strongest cut candidate.`
      : "";

    if (lever.kind === "openrouter") {
      slowOpenRouterCount += 1;
      const alias = typeof lever.alias === "string" ? lever.alias : "";
      const entry = models[alias] && typeof models[alias] === "object" ? models[alias] : null;
      const effort = entry && typeof entry.reasoningEffort === "string" ? entry.reasoningEffort : null;
      if (effort && effort !== "low") {
        out.push({ target: "deliberation", subject: o.provider, configKey: `models.${alias}.reasoningEffort`, action: `lower models.${alias}.reasoningEffort (currently ${effort})`, rationale: `Slowest in the panel (${o.detail}).${valueNote}` });
      }
      out.push({ target: "deliberation", subject: o.provider, configKey: `models.${alias}.askAll`, action: `set models.${alias}.askAll=false to drop it from /ask-all fan-out`, rationale: `In parallel fan-out, wall-time is the slowest model (${o.detail}).${valueNote}` });
    } else if (lever.kind === "external") {
      out.push({ target: "external", subject: o.provider, configKey: null, action: o.provider === "codex" ? "lower model_reasoning_effort in ~/.codex/config.toml (or pass it per-call)" : "lower the Gemini/agy reasoning setting", rationale: `Slowest in the panel (${o.detail}); its reasoning lever is outside deliberation's config.${valueNote}` });
    } else {
      out.push({ target: "deliberation", subject: o.provider, configKey: null, action: `consider whether ${o.provider} earns its latency in the panel`, rationale: `${o.detail}.${valueNote}` });
    }
  }

  if (slowOpenRouterCount >= 2) {
    const fanout = cfg.routing && typeof cfg.routing.maxFanout === "number" ? cfg.routing.maxFanout : null;
    out.push({ target: "deliberation", subject: "panel", configKey: "routing.maxFanout", action: fanout ? `lower routing.maxFanout (currently ${fanout})` : "set routing.maxFanout to 1-2", rationale: `${slowOpenRouterCount} OpenRouter models are slow outliers; a smaller fan-out cuts cost and parallel wall-time.` });
  }
  return out;
}

/**
 * Build the full Analysis from already-read inputs. Pure: no IO. The MCP tool
 * does the file reads and passes parsed events, parsed records, and the config.
 * @param {DebugEvent[]} events
 * @param {SessionRecord[]} records
 * @param {any} config
 * @param {{logPath?:string, debugEnabled?:boolean, sessionsPersist?:boolean, sessionsDir?:(string|null)}} [meta]
 * @returns {Analysis}
 */
function buildAnalysis(events, records, config, meta) {
  const evs = Array.isArray(events) ? events : [];
  const recs = Array.isArray(records) ? records : [];
  const stats = aggregateByModel(evs);
  const agreement = aggregateAgreement(recs);
  const outliers = detectOutliers(stats);
  const recommendations = recommend(stats, agreement, config);
  return {
    stats,
    agreement,
    outliers,
    recommendations,
    meta: {
      logPath: meta && meta.logPath,
      debugEnabled: !!(meta && meta.debugEnabled),
      sessionsPersist: !!(meta && meta.sessionsPersist),
      eventsParsed: evs.length,
      sessionsRead: recs.length,
      // sessionsDir is the dir the RUNNING server resolved (passed by the caller).
      // /deliberation:doctor compares this to the shell-resolved path to detect the
      // XDG_CACHE_HOME / DELIBERATION_SESSIONS drift that silently empties Lens B.
      sessionsDir: (meta && meta.sessionsDir) || null,
      // Total agreement votes across all models. sessionsRead>0 with agreementVotes==0
      // means records exist but none carry a per-opinion verdict (old or ask-all runs) -
      // Lens B is empty for a content reason, not a read-path one.
      agreementVotes: agreement.reduce((n, a) => n + (a && a.votes ? a.votes : 0), 0),
      insufficientData: stats.length === 0,
    },
  };
}

module.exports = {
  SLOW_FACTOR,
  MIN_CALLS,
  ABS_SLOW_MS,
  HIGH_ERROR_RATE,
  HIGH_AGREEMENT,
  MIN_VOTES,
  parseDebugLog,
  percentile,
  aggregateByModel,
  aggregateAgreement,
  detectOutliers,
  recommend,
  buildAnalysis,
};
