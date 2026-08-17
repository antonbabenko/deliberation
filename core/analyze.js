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
/** Upper bound for a `since` window (ms). Larger values ERROR rather than clamp: a silently
 * clamped window would report a period it never covered, which is the lie the coverage
 * fields exist to prevent. */
const MAX_WINDOW_MS = 10 * 365 * 24 * 60 * 60 * 1000;
/** Max models per compare link (the OpenRouter /compare surface takes a handful). */
const COMPARE_MAX = 4;
/** Base for the OpenRouter model-comparison surface. */
const COMPARE_BASE = "https://openrouter.ai/compare";

/**
 * @typedef {import("./debug-log.js").DebugEvent} DebugEvent
 * @typedef {import("./sessions.js").SessionRecord} SessionRecord
 */

/**
 * Latency over SUCCESSFUL calls only. Every field is null when okCalls === 0:
 * an all-error model has no latency, and reporting 0 would make it the fastest
 * model in the panel.
 * @typedef {Object} LatencyStat
 * @property {(number|null)} p50
 * @property {(number|null)} p95
 * @property {(number|null)} max
 * @property {(number|null)} mean
 */

/**
 * @typedef {Object} ModelStat
 * @property {string} provider
 * @property {string} model
 * @property {number} calls  every event, errors included
 * @property {number} okCalls  successful calls - the denominator of `ms`
 * @property {number} errors
 * @property {number} errorRate  errors/calls
 * @property {LatencyStat} ms  over okCalls only; a timeout is an error, not a latency sample
 * @property {(number|null)} meanTokens  mean total tokens (HTTP providers); null for CLI providers
 * @property {string[]} reasoningEfforts  distinct efforts seen ("n/a" for the CLI null)
 * @property {string[]} tools  distinct tools the model was called under
 */

/**
 * A row dropped by the configured-model filter, kept so the report can say what it
 * hid and why rather than silently shrinking the table.
 * @typedef {Object} ExcludedModel
 * @property {string} provider
 * @property {string} model
 * @property {number} calls
 * @property {string} reason
 */

/**
 * @typedef {Object} CompareLink
 * @property {("slow-outlier"|"variant"|"most-called")} group
 * @property {string[]} providers  `openrouter:<alias>` names, joining back to Suggestion.subject
 * @property {string} url
 */

/**
 * Providers observed running more than one model string in-window. Deliberately NOT
 * called "dated": naming a slug dated is a characterisation, and this module does not
 * characterise models - it flags them so the caller can look them up.
 * @typedef {Object} ModelVariant
 * @property {string} provider
 * @property {string[]} models
 */

/**
 * The slice of the RESOLVED config analyze needs. Note the asymmetry, which is
 * deliberate: we READ the resolved shape (`openrouter.models[]` with `alias` and
 * snake_case `reasoning_effort`) but every suggestion NAMES the ON-DISK path
 * (`models.<alias>.*`, `routing.maxFanout`). Both are correct - they are different
 * namespaces. Do not "fix" one to match the other.
 * @typedef {Object} ResolvedConfigView
 * @property {{enabled?:boolean, maxFanout?:number, models?:{alias?:string, model?:string, askAll?:boolean, consensus?:boolean, reasoning_effort?:string, apiBase?:string}[], invalidModels?:{alias?:(string|null)}[]}} [openrouter]
 * @property {Record<string, {enabled?:boolean}>} [providers]
 */

/**
 * @typedef {Object} AnalysisWindow
 * @property {string} since  the caller's spelling, echoed back (already regex-validated)
 * @property {number} fromMs
 * @property {number} toMs
 * @property {(number|null)} coverageFromMs  earliest timestamp actually surviving, ACROSS BOTH
 *   lenses (min of event `at` and record `createdAt`); null when neither lens has one.
 *   This is real coverage, not requested coverage - they differ when the byte tail bounds
 *   the read before the window does.
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
 * @property {number} eventsParsed  post-window count
 * @property {number} sessionsRead  UNFILTERED: what doctor reads as a read-path signal
 * @property {(string|null)} sessionsDir  dir the running server resolved (for the doctor drift check)
 * @property {number} agreementVotes  UNFILTERED total votes (0 with sessionsRead>0 => no per-opinion verdicts)
 * @property {boolean} insufficientData  UNFILTERED: true when there was nothing to analyze at all,
 *   never merely because the configured-model filter hid everything
 * @property {ExcludedModel[]} excluded  rows the configured-model filter removed
 * @property {(AnalysisWindow|null)} window
 * @property {{log:boolean, sessions:boolean}} truncated  present always: the default 1 MB tail
 *   truncates silently today and there is no window object to hang that on
 * @property {(string|null)} configError  when set, the filter is SKIPPED - a syntax error must not
 *   be reported as "none of your models are configured"
 * @property {ModelVariant[]} modelVariants
 * @property {string[]} warnings
 */

/**
 * @typedef {Object} Analysis
 * @property {ModelStat[]} stats  Lens A (timing/cost), slowest p95 first
 * @property {AgreementStat[]} agreement  Lens B (verdict agreement), least-agreeing first
 * @property {Outlier[]} outliers
 * @property {Suggestion[]} recommendations
 * @property {CompareLink[]} compare
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
 * Parse a `since` window into milliseconds. Same grammar as the Grok files-admin CLI
 * (`server/grok/files-admin.js` `parseOlderThan`): `30m`, `24h`, `7d`, or a bare number
 * of seconds. Copied rather than imported - that module is a bridge CLI that throws, and
 * coupling the MCP server to it to save four lines is the wrong trade. Keep the two
 * grammars recognisably the same.
 *
 * Returns a result object instead of throwing, because an invalid window must surface as
 * a tool error rather than silently degrading to "all time".
 * @param {unknown} raw
 * @returns {{ok:true, ms:number}|{ok:false, error:string}}
 */
function parseWindowMs(raw) {
  if (typeof raw !== "string" || !raw.trim()) return { ok: false, error: "since must be a non-empty string like \"24h\", \"7d\" or a number of seconds" };
  const m = /^(\d+)\s*([smhd]?)$/i.exec(raw.trim());
  if (!m) return { ok: false, error: `invalid since: ${JSON.stringify(raw)} (expected e.g. "30m", "24h", "7d", or seconds)` };
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return { ok: false, error: `invalid since: ${JSON.stringify(raw)} (must be > 0)` };
  const unit = (m[2] || "s").toLowerCase();
  const mult = unit === "d" ? 86400000 : unit === "h" ? 3600000 : unit === "m" ? 60000 : 1000;
  const ms = n * mult;
  if (!Number.isFinite(ms) || ms > MAX_WINDOW_MS) return { ok: false, error: `since out of range: ${JSON.stringify(raw)} (max 10 years)` };
  return { ok: true, ms };
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
    // Latency samples come from SUCCESSFUL calls only. A timeout is recorded with its
    // full `ms`, so counting errors here reports the timeout ceiling as model latency -
    // which is how an aborted round showed up as a 935s p95 instead of the model's 488s.
    if (!e.isError && typeof e.ms === "number" && Number.isFinite(e.ms)) g.ms.push(e.ms);
    const tot = e.usage && typeof e.usage.totalTokens === "number" ? e.usage.totalTokens : undefined;
    if (typeof tot === "number" && Number.isFinite(tot)) g.tokens.push(tot);
    g.efforts.add(e.reasoningEffort == null ? "n/a" : String(e.reasoningEffort));
    if (typeof e.tool === "string") g.tools.add(e.tool);
  }
  /** @type {ModelStat[]} */
  const stats = [];
  for (const g of groups.values()) {
    const sorted = g.ms.slice().sort((a, b) => a - b);
    const ok = sorted.length;
    const mean = ok ? sorted.reduce((a, b) => a + b, 0) / ok : 0;
    stats.push({
      provider: g.provider,
      model: g.model,
      calls: g.calls,
      okCalls: ok,
      errors: g.errors,
      errorRate: g.calls ? g.errors / g.calls : 0,
      // null, not 0, when nothing succeeded: percentile() returns 0 for an empty array,
      // and a 0ms p95 would make an all-error model the fastest peer in the panel.
      ms: {
        p50: ok ? Math.round(percentile(sorted, 50)) : null,
        p95: ok ? Math.round(percentile(sorted, 95)) : null,
        max: ok ? sorted[ok - 1] : null,
        mean: ok ? Math.round(mean) : null,
      },
      meanTokens: g.tokens.length ? Math.round(g.tokens.reduce((a, b) => a + b, 0) / g.tokens.length) : null,
      reasoningEfforts: Array.from(g.efforts).sort(),
      tools: Array.from(g.tools).sort(),
    });
  }
  // Slowest p95 first; rows with no successful call sort last (they have no latency).
  stats.sort((a, b) => (b.ms.p95 == null ? -1 : b.ms.p95) - (a.ms.p95 == null ? -1 : a.ms.p95));
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
  const all = Array.isArray(stats) ? stats : [];
  // Two different eligibility gates on purpose. The error check counts EVERY call, because
  // that is what "unreliable" means. The latency checks count only SUCCESSFUL calls, because
  // since errors left the percentiles an all-error model has p95 null - and if it were
  // admitted as 0 it would become the fastest-peer baseline every other model is judged by.
  const latencyEligible = all.filter((s) => s.okCalls >= MIN_CALLS && s.ms.p95 != null);
  const p95s = latencyEligible.map((s) => (s.ms.p95 == null ? 0 : s.ms.p95));
  const baseline = p95s.length ? Math.max(Math.min(...p95s), MIN_BASELINE_MS) : null;
  /** @type {Outlier[]} */
  const out = [];
  for (const s of all) {
    if (s.calls >= MIN_CALLS && s.errorRate >= HIGH_ERROR_RATE) {
      out.push({ provider: s.provider, model: s.model, kind: "high-error", detail: `${Math.round(s.errorRate * 100)}% of ${s.calls} calls errored` });
    }
    const p95 = s.ms.p95;
    if (p95 == null || s.okCalls < MIN_CALLS || baseline == null) continue;
    if (p95 >= ABS_SLOW_MS) {
      out.push({ provider: s.provider, model: s.model, kind: "slow-absolute", detail: `p95 ${p95}ms (>= ${ABS_SLOW_MS}ms)` });
    } else if (p95 >= SLOW_FACTOR * baseline) {
      out.push({ provider: s.provider, model: s.model, kind: "slow-relative", detail: `p95 ${p95}ms vs fastest-peer baseline ${Math.round(baseline)}ms` });
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
  // Guard the prefix before slicing: a bare "openrouter" provider string would otherwise
  // yield an empty alias and match nothing in config for confusing reasons.
  if (provider.startsWith(OR_PREFIX) && provider.length > OR_PREFIX.length) {
    return { kind: "openrouter", alias: provider.slice(OR_PREFIX.length) };
  }
  if (provider === "codex" || provider === "gemini") return { kind: "external" };
  if (provider === "grok") return { kind: "grok" };
  return { kind: "unknown" };
}

/**
 * Project the RESOLVED config into the levers analyze needs, in ONE place, because
 * both the configured-model filter and `recommend` want the same three facts and
 * duplicating the resolved-shape reads is how the raw-vs-resolved bug comes back.
 * @param {any} config
 * @returns {{byAlias:Map<string,{alias?:string, model?:string, askAll?:boolean, reasoning_effort?:string, apiBase?:string}>, invalidAliases:Set<string>, orEnabled:boolean, maxFanout:(number|null), providers:Record<string, any>}}
 */
function configLevers(config) {
  const cfg = config && typeof config === "object" ? /** @type {ResolvedConfigView} */ (config) : {};
  const or = cfg.openrouter && typeof cfg.openrouter === "object" ? cfg.openrouter : {};
  /** @type {Map<string, any>} */
  const byAlias = new Map();
  for (const m of Array.isArray(or.models) ? or.models : []) {
    if (m && typeof m.alias === "string" && m.alias) byAlias.set(m.alias, m);
  }
  /** @type {Set<string>} */
  const invalidAliases = new Set();
  for (const m of Array.isArray(or.invalidModels) ? or.invalidModels : []) {
    if (m && typeof m.alias === "string" && m.alias) invalidAliases.add(m.alias);
  }
  return {
    byAlias,
    invalidAliases,
    orEnabled: or.enabled !== false,
    maxFanout: typeof or.maxFanout === "number" ? or.maxFanout : null,
    providers: cfg.providers && typeof cfg.providers === "object" ? cfg.providers : {},
  };
}

/**
 * Why a row is not in the current config, or null when it is.
 *
 * OpenRouter rows resolve by alias. Native rows (codex/gemini/grok) are excluded ONLY on an
 * explicit `enabled: false` - never on a model mismatch against `providers.<name>.model`.
 * That pin is a router alias for Gemini (`auto-gemini-3`), so the log records the RESOLVED
 * model and equality would hide every active row; it is also read once at startup and never
 * hot-reloaded, and the env defaults supply models the config layer cannot see. Codex has no
 * model key at all and logs the literal "default".
 * @param {string} provider
 * @param {ReturnType<typeof configLevers>} levers
 * @returns {(string|null)}
 */
function excludeReason(provider, levers) {
  const lever = leverFor(provider);
  if (lever.kind === "openrouter") {
    const alias = typeof lever.alias === "string" ? lever.alias : "";
    if (levers.byAlias.has(alias)) return null;
    // `models` is forced to [] when the provider is disabled, so membership alone cannot
    // tell "retired alias" from "openrouter turned off" from "record rejected".
    if (!levers.orEnabled) return "openrouter provider disabled";
    if (levers.invalidAliases.has(alias)) return "rejected by config validation";
    return "not in config";
  }
  const block = levers.providers[provider];
  if (block && typeof block === "object" && block.enabled === false) return "provider disabled";
  // Absent `providers` map means enabled, matching resolveProviders' own semantics.
  return null;
}

/**
 * Advisory tuning suggestions. NEVER writes; each suggestion names the exact
 * config key (for deliberation-owned levers) or points at the external tool
 * (Codex/Gemini reasoning, which live outside deliberation's config). Combines
 * the slow outliers (Lens A) with the agreement signal (Lens B), reported as a
 * candidate, not a joined fact.
 * @param {ModelStat[]} stats
 * @param {AgreementStat[]} agreement
 * @param {any} config  the RESOLVED config (see ResolvedConfigView)
 * @returns {Suggestion[]}
 */
function recommend(stats, agreement, config) {
  const levers = configLevers(config);
  const outliers = detectOutliers(stats);
  // Keyed by provider|model, matching every other aggregation in this module. Keying on
  // provider alone attributes one model's agreement to another model's latency outlier
  // whenever a provider has run more than one model - which modelVariants now surfaces.
  /** @type {Map<string, AgreementStat>} */
  const agreeBy = new Map();
  for (const a of Array.isArray(agreement) ? agreement : []) agreeBy.set(`${a.provider}|${a.model}`, a);
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
    const agree = agreeBy.get(`${o.provider}|${o.model}`);
    const rarelyDissents = !!(agree && agree.agreementRate != null && agree.votes >= MIN_VOTES && agree.agreementRate >= HIGH_AGREEMENT);
    const valueNote = rarelyDissents
      ? ` It also agreed with the final verdict ${agree ? Math.round((agree.agreementRate || 0) * 100) : 0}% of ${agree ? agree.votes : 0} votes (rarely adds dissent), so it is the strongest cut candidate.`
      : "";

    if (lever.kind === "openrouter") {
      slowOpenRouterCount += 1;
      const alias = typeof lever.alias === "string" ? lever.alias : "";
      const entry = levers.byAlias.get(alias) || null;
      // Resolved records carry snake_case `reasoning_effort`; the on-disk `reasoningEffort`
      // is renamed once, in server/openrouter/config.js. Reading the camelCase name here is
      // what made this suggestion dead in production.
      const effort = entry && typeof entry.reasoning_effort === "string" ? entry.reasoning_effort : null;
      if (effort && effort !== "low") {
        out.push({ target: "deliberation", subject: o.provider, configKey: `models.${alias}.reasoningEffort`, action: `lower models.${alias}.reasoningEffort (currently ${effort})`, rationale: `Slowest in the panel (${o.detail}).${valueNote}` });
      }
      // Suggesting askAll=false on a record that already has it is a no-op recommendation.
      if (!entry || entry.askAll !== false) {
        out.push({ target: "deliberation", subject: o.provider, configKey: `models.${alias}.askAll`, action: `set models.${alias}.askAll=false to drop it from /ask-all fan-out`, rationale: `In parallel fan-out, wall-time is the slowest model (${o.detail}).${valueNote}` });
      }
    } else if (lever.kind === "external") {
      out.push({ target: "external", subject: o.provider, configKey: null, action: o.provider === "codex" ? "lower model_reasoning_effort in ~/.codex/config.toml (or pass it per-call)" : "lower the Gemini/agy reasoning setting", rationale: `Slowest in the panel (${o.detail}); its reasoning lever is outside deliberation's config.${valueNote}` });
    } else {
      out.push({ target: "deliberation", subject: o.provider, configKey: null, action: `consider whether ${o.provider} earns its latency in the panel`, rationale: `${o.detail}.${valueNote}` });
    }
  }

  if (slowOpenRouterCount >= 2) {
    const fanout = levers.maxFanout;
    out.push({ target: "deliberation", subject: "panel", configKey: "routing.maxFanout", action: fanout ? `lower routing.maxFanout (currently ${fanout})` : "set routing.maxFanout to 1-2", rationale: `${slowOpenRouterCount} OpenRouter models are slow outliers; a smaller fan-out cuts cost and parallel wall-time.` });
  }
  return out;
}

/**
 * Providers seen running more than one model string. Flags only - no date parsing and no
 * "dated" label, because calling a slug dated is a characterisation and this module does
 * not characterise models.
 * @param {ModelStat[]} stats
 * @returns {ModelVariant[]}
 */
function detectModelVariants(stats) {
  /** @type {Map<string, Set<string>>} */
  const byProvider = new Map();
  for (const s of Array.isArray(stats) ? stats : []) {
    if (!s || typeof s.provider !== "string") continue;
    let set = byProvider.get(s.provider);
    if (!set) {
      set = new Set();
      byProvider.set(s.provider, set);
    }
    if (s.model) set.add(s.model);
  }
  /** @type {ModelVariant[]} */
  const out = [];
  for (const [provider, set] of byProvider) {
    if (set.size > 1) out.push({ provider, models: Array.from(set).sort() });
  }
  out.sort((a, b) => a.provider.localeCompare(b.provider));
  return out;
}

/**
 * The OpenRouter slug for a row, or null when it is not linkable. Prefers the logged
 * `model` (for an OpenRouter row that IS the slug) and falls back to the configured
 * record when only the alias is known. Records with a custom `apiBase` are never
 * linkable: their slug may not resolve on openrouter.ai at all.
 * @param {ModelStat} s
 * @param {ReturnType<typeof configLevers>} levers
 * @returns {(string|null)}
 */
function slugFor(s, levers) {
  const lever = leverFor(s.provider);
  if (lever.kind !== "openrouter") return null;
  const entry = levers.byAlias.get(typeof lever.alias === "string" ? lever.alias : "");
  if (entry && typeof entry.apiBase === "string" && entry.apiBase) return null;
  if (typeof s.model === "string" && s.model.includes("/")) return s.model;
  if (entry && typeof entry.model === "string" && entry.model) return entry.model;
  return null;
}

/**
 * Build an openrouter.ai/compare URL from slugs. Each path segment is encoded separately
 * so a vendor/name slug keeps its separator while a data-driven value cannot escape the path.
 * @param {string[]} slugs
 * @returns {string}
 */
function compareUrl(slugs) {
  const path = slugs
    .map((slug) => slug.split("/").map((seg) => encodeURIComponent(seg)).join("/"))
    .join("/");
  return `${COMPARE_BASE}/${path}`;
}

/**
 * OpenRouter compare links, one per finding group, up to COMPARE_MAX models each.
 * OpenRouter rows only - a native provider's model id is not a catalog slug, so a link
 * built from it would 404.
 * @param {ModelStat[]} stats
 * @param {Outlier[]} outliers
 * @param {ModelVariant[]} variants
 * @param {ReturnType<typeof configLevers>} levers
 * @returns {CompareLink[]}
 */
function buildCompare(stats, outliers, variants, levers) {
  const rows = (Array.isArray(stats) ? stats : []).filter((s) => slugFor(s, levers) !== null);
  /** @type {CompareLink[]} */
  const out = [];
  /** @type {Set<string>} */
  const seen = new Set();
  const push = (/** @type {CompareLink["group"]} */ group, /** @type {ModelStat[]} */ picks) => {
    if (picks.length < 2) return;
    /** @type {string[]} */
    const slugs = [];
    for (const p of picks) {
      const slug = slugFor(p, levers);
      if (slug && !slugs.includes(slug)) slugs.push(slug);
    }
    if (slugs.length < 2) return;
    const chosen = slugs.slice(0, COMPARE_MAX);
    // Dedupe on the SET of models, not the ordered URL: one link per outlier otherwise
    // emits the same four models in a different order once per outlier, which is noise.
    const key = chosen.slice().sort().join("|");
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ group, providers: picks.slice(0, COMPARE_MAX).map((p) => p.provider), url: compareUrl(chosen) });
  };

  // slow-outlier: the outlier plus its nearest peers by p95, so the link answers
  // "is this model worth its latency against comparable peers".
  for (const o of Array.isArray(outliers) ? outliers : []) {
    if (o.kind === "high-error") continue;
    const target = rows.find((s) => s.provider === o.provider && s.model === o.model);
    if (!target || target.ms.p95 == null) continue;
    const tp95 = target.ms.p95;
    const peers = rows
      .filter((s) => s !== target && s.ms.p95 != null)
      .sort((a, b) => Math.abs((a.ms.p95 || 0) - tp95) - Math.abs((b.ms.p95 || 0) - tp95))
      .slice(0, COMPARE_MAX - 1);
    push("slow-outlier", [target, ...peers]);
  }

  // variant: an alias whose logged slug changed over time (config edited under the same id).
  for (const v of Array.isArray(variants) ? variants : []) {
    const picks = rows
      .filter((s) => s.provider === v.provider)
      .sort((a, b) => b.calls - a.calls)
      .slice(0, COMPARE_MAX);
    push("variant", picks);
  }

  // most-called: a single fallback so the report still offers a comparison when nothing
  // was flagged.
  if (!out.length) {
    push("most-called", rows.slice().sort((a, b) => b.calls - a.calls).slice(0, COMPARE_MAX));
  }
  return out;
}

/**
 * Build the full Analysis from already-read inputs. Pure: no IO. The MCP tool
 * does the file reads and passes parsed events, parsed records, and the config.
 * The window (`windowMs`) gates BOTH lenses: Lens A here, Lens B in the caller, which
 * already dropped out-of-window records before passing them. A report whose timing spans
 * months and whose agreement spans days would make the combined "slow AND rarely dissents"
 * candidate a mixed-period claim.
 * @param {DebugEvent[]} events
 * @param {SessionRecord[]} records  already time-filtered by the caller
 * @param {any} config  the RESOLVED config
 * @param {{logPath?:string, debugEnabled?:boolean, sessionsPersist?:boolean, sessionsDir?:(string|null), windowMs?:(number|null), since?:(string|null), nowMs?:number, configuredOnly?:boolean, configError?:(string|null), truncated?:{log?:boolean, sessions?:boolean}}} [meta]
 * @returns {Analysis}
 */
function buildAnalysis(events, records, config, meta) {
  const m = meta || {};
  const recs = Array.isArray(records) ? records : [];
  const nowMs = typeof m.nowMs === "number" ? m.nowMs : Date.now();
  const windowMs = typeof m.windowMs === "number" && m.windowMs > 0 ? m.windowMs : null;
  const fromMs = windowMs == null ? null : nowMs - windowMs;

  // An event with no usable `at` is dropped under a window (it cannot be shown to be
  // inside it) and kept without one.
  const allEvents = Array.isArray(events) ? events : [];
  const evs = fromMs == null
    ? allEvents
    : allEvents.filter((e) => e && typeof e.at === "number" && Number.isFinite(e.at) && e.at >= fromMs);

  const allStats = aggregateByModel(evs);
  const allAgreement = aggregateAgreement(recs);

  // Counters come from the UNFILTERED aggregates. doctor reads them as read-path signals,
  // and a zero produced by the configured-model filter would masquerade as broken
  // persistence or a drifted sessions dir.
  const agreementVotes = allAgreement.reduce((n, a) => n + (a && a.votes ? a.votes : 0), 0);
  const insufficientData = allStats.length === 0;

  const levers = configLevers(config);
  const configError = typeof m.configError === "string" && m.configError ? m.configError : null;
  // A syntax error must never be reported as "none of your models are configured".
  const filtering = m.configuredOnly !== false && !configError;
  /** @type {ExcludedModel[]} */
  const excluded = [];
  /** @type {string[]} */
  const warnings = [];

  let stats = allStats;
  let agreement = allAgreement;
  if (filtering) {
    /** @type {Map<string, string>} */
    const reasonByProvider = new Map();
    for (const s of allStats) {
      const reason = excludeReason(s.provider, levers);
      if (reason) {
        reasonByProvider.set(s.provider, reason);
        excluded.push({ provider: s.provider, model: s.model, calls: s.calls, reason });
      }
    }
    const kept = allStats.filter((s) => !reasonByProvider.has(s.provider));
    if (allStats.length && !kept.length) {
      // Show the rows, but do NOT feed them to detectOutliers/recommend: the whole point
      // is that a retired model must not be recommended. Analysis stays empty and says so.
      warnings.push("Every model in the log was filtered out as unconfigured; showing rows for reference only, with no recommendations. Pass configuredOnly:false to analyze them.");
      stats = allStats;
      agreement = allAgreement;
      const outliers = /** @type {Outlier[]} */ ([]);
      return {
        stats,
        agreement,
        outliers,
        recommendations: [],
        compare: [],
        meta: buildMeta(m, evs, recs, {
          agreementVotes,
          insufficientData,
          excluded,
          window: buildWindow(m, windowMs, fromMs, nowMs, evs, recs),
          configError,
          modelVariants: detectModelVariants(allStats),
          warnings,
        }),
      };
    }
    stats = kept;
    agreement = allAgreement.filter((a) => !reasonByProvider.has(a.provider));
  }

  const outliers = detectOutliers(stats);
  const recommendations = recommend(stats, agreement, config);
  const modelVariants = detectModelVariants(stats);
  return {
    stats,
    agreement,
    outliers,
    recommendations,
    compare: buildCompare(stats, outliers, modelVariants, levers),
    meta: buildMeta(m, evs, recs, {
      agreementVotes,
      insufficientData,
      excluded,
      window: buildWindow(m, windowMs, fromMs, nowMs, evs, recs),
      configError,
      modelVariants,
      warnings,
    }),
  };
}

/**
 * @param {any} m
 * @param {(number|null)} windowMs
 * @param {(number|null)} fromMs
 * @param {number} nowMs
 * @param {DebugEvent[]} evs
 * @param {SessionRecord[]} recs
 * @returns {(AnalysisWindow|null)}
 */
function buildWindow(m, windowMs, fromMs, nowMs, evs, recs) {
  if (windowMs == null || fromMs == null) return null;
  /** @type {number[]} */
  const earliest = [];
  for (const e of evs) {
    if (e && typeof e.at === "number" && Number.isFinite(e.at)) earliest.push(e.at);
  }
  for (const r of recs) {
    const t = r && typeof r.createdAt === "string" ? Date.parse(r.createdAt) : NaN;
    if (Number.isFinite(t)) earliest.push(t);
  }
  return {
    since: typeof m.since === "string" ? m.since : `${Math.round(windowMs / 1000)}s`,
    fromMs,
    toMs: nowMs,
    // Real coverage across both lenses, not requested coverage: they differ whenever the
    // byte tail bounded the read before the window did.
    coverageFromMs: earliest.length ? Math.min(...earliest) : null,
  };
}

/**
 * @param {any} m
 * @param {DebugEvent[]} evs
 * @param {SessionRecord[]} recs
 * @param {{agreementVotes:number, insufficientData:boolean, excluded:ExcludedModel[], window:(AnalysisWindow|null), configError:(string|null), modelVariants:ModelVariant[], warnings:string[]}} parts
 * @returns {AnalysisMeta}
 */
function buildMeta(m, evs, recs, parts) {
  const trunc = m.truncated && typeof m.truncated === "object" ? m.truncated : {};
  return {
    logPath: m.logPath,
    debugEnabled: !!m.debugEnabled,
    sessionsPersist: !!m.sessionsPersist,
    eventsParsed: evs.length,
    sessionsRead: recs.length,
    // sessionsDir is the dir the RUNNING server resolved (passed by the caller).
    // /deliberation:doctor compares this to the shell-resolved path to detect the
    // XDG_CACHE_HOME / DELIBERATION_SESSIONS drift that silently empties Lens B.
    sessionsDir: m.sessionsDir || null,
    // Total agreement votes across all models, BEFORE the configured-model filter.
    // sessionsRead>0 with agreementVotes==0 means records exist but none carry a
    // per-opinion verdict (old or ask-all runs) - a content reason, not a read-path one.
    agreementVotes: parts.agreementVotes,
    insufficientData: parts.insufficientData,
    excluded: parts.excluded,
    window: parts.window,
    truncated: { log: !!trunc.log, sessions: !!trunc.sessions },
    configError: parts.configError,
    modelVariants: parts.modelVariants,
    warnings: parts.warnings,
  };
}

module.exports = {
  SLOW_FACTOR,
  MIN_CALLS,
  ABS_SLOW_MS,
  HIGH_ERROR_RATE,
  HIGH_AGREEMENT,
  MIN_VOTES,
  MAX_WINDOW_MS,
  COMPARE_MAX,
  parseDebugLog,
  parseWindowMs,
  percentile,
  aggregateByModel,
  aggregateAgreement,
  detectOutliers,
  detectModelVariants,
  configLevers,
  excludeReason,
  buildCompare,
  recommend,
  buildAnalysis,
};
