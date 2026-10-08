"use strict";

/**
 * server/dashboard/analyzer.js - the Analyzer tab's numbers, computed from journal runs.
 *
 * Pure: takes `{summary, events}` run details (server/dashboard/runs.js `get`) and returns
 * plain JSON. Reads metadata fields only, never prompt or response text. Never throws on
 * junk input; a malformed event is skipped. Three views:
 *   - projects: per calling project, runs, call timeouts, latency, error kinds;
 *   - models:   per consensus voice, how often it agrees instead of adding findings, and
 *               whether it is a drop candidate (all thresholds in C, shared with the tests);
 *   - size:     request size vs latency and timeouts per provider + model, with timeout
 *               advice that treats timeouts as censored (their real latency is unknown).
 */

/** Thresholds. Exported so tests and the UI's method notes use the same numbers. */
const C = Object.freeze({
  MIN_ROUNDS: 10,
  ADDS_NOTHING_MIN: 0.8,
  LONE_DISSENT_MAX: 0.1,
  ACCEPTED_MAX: 0.05,
  MIN_DECISION_ROUNDS: 10,
  SLOW_RATIO: 1.2,
  SLOW_SHARE_MIN: 0.6,
  ERROR_RATE_MIN: 0.2,
  MIN_ERROR_CALLS: 10,
  ADVICE_MIN_N: 20,
  TIMEOUT_RATE_MAX: 0.05,
  NEAR_RATE_MAX: 0.1,
  NEAR_CEILING: 0.9,
  FIT_R_MIN: 0.5,
  CENSORED_FACTOR: 1.5,
  TREND_FACTOR: 1.25,
  HOST_MARGIN_MS: 5000, // core/host-budget.js HOST_BUDGET_MARGIN_MS: what the host cap leaves a call
});

/** Size buckets in request chars (prompt chars, plus file bytes for file-bearing calls). */
const BUCKETS = [
  { label: "<8k", max: 8000 },
  { label: "8-32k", max: 32000 },
  { label: ">32k", max: Infinity },
];
/** Ceilings this config controls: only these drive advice and model speed/error. */
const ADVISABLE = new Set(["own", "shared"]);
const UNKNOWN_PROJECT = { id: "unknown", name: "(unknown)", root: "" };

/** @param {string} p */
const timeoutKey = (p) => (p.startsWith("openrouter:") ? `models.${p.slice(11)}.timeout` : `providers.${p}.timeout`);
/** @param {string} p */
const dropKey = (p) => (p.startsWith("openrouter:") ? `models.${p.slice(11)}.consensus` : `providers.${p}.enabled`);

/** @param {unknown} v @returns {v is number} */
const num = (v) => typeof v === "number" && Number.isFinite(v);
/** @param {number[]} xs @param {number} q */
function quantile(xs, q) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)];
}
/** @param {number[]} xs */
const median = (xs) => quantile(xs, 0.5);
/** @param {number} a @param {number} b */
const ratio = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 1000 : null);

/**
 * Least-squares fit of ms on size.
 * @param {{x:number, y:number}[]} pts
 * @returns {{msPer1k:(number|null), r:(number|null), n:number}}
 */
function fit(pts) {
  const n = pts.length;
  if (n < 2) return { msPer1k: null, r: null, n };
  const mx = pts.reduce((a, p) => a + p.x, 0) / n, my = pts.reduce((a, p) => a + p.y, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (const p of pts) { sxy += (p.x - mx) * (p.y - my); sxx += (p.x - mx) ** 2; syy += (p.y - my) ** 2; }
  if (sxx === 0 || syy === 0) return { msPer1k: null, r: null, n };
  return { msPer1k: Math.round((sxy / sxx) * 1000), r: Math.round((sxy / Math.sqrt(sxx * syy)) * 1000) / 1000, n };
}

/**
 * Pair call_start with call_end by callId.
 * @param {any[]} events
 * @returns {{start:any, end:any}[]}
 */
function calls(events) {
  /** @type {Map<string, any>} */
  const starts = new Map();
  const out = [];
  for (const e of events) {
    if (!e || typeof e !== "object" || typeof e.callId !== "string") continue;
    if (e.kind === "call_start") starts.set(e.callId, e);
    else if (e.kind === "call_end" && starts.has(e.callId)) out.push({ start: starts.get(e.callId), end: e });
  }
  return out;
}

/** @param {any} run */
function projectOf(run) {
  const p = run.summary && run.summary.project;
  const start = run.events.find((/** @type {any} */ e) => e && e.kind === "run_start");
  const ref = p && typeof p.id === "string" ? p : start && start.project;
  return ref && typeof ref.id === "string" ? { id: ref.id, name: String(ref.name || ref.id), root: String(ref.root || "") } : UNKNOWN_PROJECT;
}

/** @param {any[]} runs */
function projectsView(runs) {
  /** @type {Map<string, any>} */
  const by = new Map();
  for (const run of runs) {
    const p = projectOf(run);
    const row = by.get(p.id) || { ...p, runs: 0, status: {}, calls: 0, timeouts: 0, errors: 0, ms: [], kinds: new Map() };
    by.set(p.id, row);
    row.runs++;
    const st = String((run.summary && run.summary.status) || "unknown");
    row.status[st] = (row.status[st] || 0) + 1;
    for (const { end } of calls(run.events)) {
      if (end.cached) continue;
      row.calls++;
      if (end.isError) {
        row.errors++;
        const k = String(end.errorKind || "unknown");
        if (k === "timeout") row.timeouts++;
        row.kinds.set(k, (row.kinds.get(k) || 0) + 1);
      } else if (num(end.ms)) row.ms.push(end.ms);
    }
  }
  return [...by.values()].map((r) => ({
    id: r.id, name: r.name, root: r.root, runs: r.runs, status: r.status, calls: r.calls,
    timeouts: r.timeouts, timeoutRate: ratio(r.timeouts, r.calls), errorRate: ratio(r.errors, r.calls),
    p50: median(r.ms), p95: quantile(r.ms, 0.95),
    topErrors: [...r.kinds.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([kind, n]) => ({ kind, n })),
  })).sort((a, b) => b.runs - a.runs);
}

/** @param {any[]} runs */
function modelsView(runs) {
  /** @type {Map<string, any>} */
  const m = new Map();
  const row = (/** @type {string} */ p) => {
    if (!m.has(p)) m.set(p, { provider: p, rounds: 0, addsNothingN: 0, loneN: 0, decisionRounds: 0, acceptedN: 0, coRounds: 0, slowRounds: 0, calls: 0, errors: 0 });
    return m.get(p);
  };
  for (const run of runs) {
    /** @type {Map<number, any[]>} */
    const decisionsByRound = new Map();
    for (const e of run.events) {
      if (e && e.kind === "arbiter" && e.action === "submit_adjudication" && num(e.round) && Array.isArray(e.decisions)) decisionsByRound.set(e.round, e.decisions);
    }
    for (const e of run.events) {
      if (!e || e.kind !== "state" || e.state !== "adjudicate" || !Array.isArray(e.verdicts)) continue;
      const voices = e.verdicts.filter((/** @type {any} */ v) => v && typeof v.provider === "string" && typeof v.verdict === "string");
      if (voices.length < 2) continue;
      const cats = (/** @type {any} */ v) => (Array.isArray(v.categories) ? v.categories.map(String) : []);
      if (voices.every((/** @type {any} */ v) => v.verdict === "APPROVE" && !cats(v).length)) continue;
      const decisions = decisionsByRound.get(e.round);
      for (const v of voices) {
        const r = row(v.provider);
        const others = voices.filter((/** @type {any} */ o) => o !== v);
        const union = new Set(others.flatMap(cats));
        r.rounds++;
        if (cats(v).every((/** @type {string} */ c) => union.has(c))) r.addsNothingN++;
        // A lone objection is a contribution; a lone APPROVE while everyone else objects is a
        // missed finding, so it never protects a model from the drop rule.
        if (v.verdict !== "APPROVE" && others.every((/** @type {any} */ o) => o.verdict !== v.verdict)) r.loneN++;
        if (decisions) {
          r.decisionRounds++;
          if (decisions.some((/** @type {any} */ d) => d && d.action === "accept" && d.source === v.provider)) r.acceptedN++;
        }
      }
    }
    // Speed and errors: peer calls whose ceiling this config controls, never cached.
    /** @type {Map<string, {provider:string, ms:number}[]>} */
    const okByRound = new Map();
    for (const { start, end } of calls(run.events)) {
      if (start.role !== "peer" || end.cached || !ADVISABLE.has(start.ceilingSource)) continue;
      const r = row(String(start.provider));
      r.calls++;
      if (end.isError) { r.errors++; continue; }
      if (!num(end.ms)) continue;
      const key = String(start.round);
      if (!okByRound.has(key)) okByRound.set(key, []);
      /** @type {any[]} */ (okByRound.get(key)).push({ provider: String(start.provider), ms: end.ms });
    }
    for (const list of okByRound.values()) {
      for (const c of list) {
        const others = list.filter((o) => o !== c).map((o) => o.ms);
        if (!others.length) continue;
        const r = row(c.provider);
        r.coRounds++;
        if (c.ms >= C.SLOW_RATIO * /** @type {number} */ (median(others))) r.slowRounds++;
      }
    }
  }
  return [...m.values()].map((r) => {
    const addsNothing = ratio(r.addsNothingN, r.rounds), loneDissent = ratio(r.loneN, r.rounds);
    const acceptedRate = ratio(r.acceptedN, r.decisionRounds);
    const slowShare = ratio(r.slowRounds, r.coRounds);
    const slow = slowShare !== null && slowShare >= C.SLOW_SHARE_MIN;
    const errorRate = ratio(r.errors, r.calls);
    const erratic = r.calls >= C.MIN_ERROR_CALLS && errorRate !== null && errorRate >= C.ERROR_RATE_MIN;
    const redundantAndCostly = r.rounds >= C.MIN_ROUNDS && addsNothing !== null && addsNothing >= C.ADDS_NOTHING_MIN
      && loneDissent !== null && loneDissent <= C.LONE_DISSENT_MAX && (slow || erratic);
    const confirmed = r.decisionRounds >= C.MIN_DECISION_ROUNDS && acceptedRate !== null && acceptedRate <= C.ACCEPTED_MAX;
    return {
      provider: r.provider, rounds: r.rounds, addsNothing, loneDissent, decisionRounds: r.decisionRounds, acceptedRate,
      coRounds: r.coRounds, slowShare, slow, calls: r.calls, errors: r.errors, errorRate,
      candidate: redundantAndCostly && confirmed,
      unconfirmed: redundantAndCostly && r.decisionRounds < C.MIN_DECISION_ROUNDS,
      configKey: dropKey(r.provider),
    };
  }).sort((a, b) => Number(b.candidate) - Number(a.candidate) || b.rounds - a.rounds);
}

/**
 * Advice for one size bucket from its own/shared calls.
 * @param {any[]} pts  {ms, timeout, granted, configured, source, sharedBy, sharedLimit, hostCap, at}
 * @param {{r:(number|null)}} f  the provider/model/split fit
 * @param {string} provider
 */
function bucketAdvice(pts, f, provider) {
  const n = pts.length;
  if (n < C.ADVICE_MIN_N) {
    // Too few calls for a number, but a bucket that keeps timing out should not look fine.
    const t = pts.filter((p) => p.timeout).length;
    if (n && t / n > C.TIMEOUT_RATE_MAX) return { kind: "early-warning", timeouts: t, n, configKeys: [timeoutKey(provider)], configKey: timeoutKey(provider) };
    return { kind: "none", reason: `only ${n} calls; needs ${C.ADVICE_MIN_N}` };
  }
  const near = pts.filter((p) => !p.timeout && num(p.granted) && p.ms > C.NEAR_CEILING * p.granted);
  const timeouts = pts.filter((p) => p.timeout);
  const latestCap = [...pts].sort((a, b) => b.at - a.at).find((p) => num(p.hostCap));
  const cap = latestCap ? latestCap.hostCap - C.HOST_MARGIN_MS : null;
  const capped = (/** @type {number} */ ms) => (cap !== null ? Math.min(ms, cap) : ms);
  if (timeouts.length / n > C.TIMEOUT_RATE_MAX || near.length / n > C.NEAR_RATE_MAX) {
    const trig = [...timeouts, ...near];
    const g = Math.max(0, ...trig.map((p) => (num(p.granted) ? p.granted : 0)));
    const shared = trig.filter((p) => p.source === "shared");
    const own = trig.filter((p) => p.source !== "shared");
    const keys = new Set([...(own.length ? [timeoutKey(provider)] : []), ...shared.flatMap((p) => (Array.isArray(p.sharedBy) ? p.sharedBy : []).map(timeoutKey))]);
    const current = Math.max(0, ...own.map((p) => (num(p.configured) ? p.configured : 0)), ...shared.map((p) => (num(p.sharedLimit) ? p.sharedLimit : 0)));
    const floor = Math.max(g, current);
    const suggestedMs = capped(Math.ceil(C.CENSORED_FACTOR * floor));
    if (suggestedMs <= floor) return { kind: "host-limit", hostCapMs: latestCap ? latestCap.hostCap : null, currentMs: floor };
    return { kind: "censored", suggestedMs, currentMs: floor, configKeys: [...keys], configKey: [...keys].join(", ") };
  }
  if (f.r !== null && f.r >= C.FIT_R_MIN) {
    const p95 = /** @type {number} */ (quantile(pts.map((p) => p.ms), 0.95));
    return { kind: "trend", suggestedMs: capped(Math.ceil(C.TREND_FACTOR * p95)), configKeys: [timeoutKey(provider)], configKey: timeoutKey(provider) };
  }
  return { kind: "none", reason: "no size effect shown" };
}

/** @param {any[]} runs */
function sizeView(runs) {
  const skipped = { noSize: 0, unknownFileBytes: 0, cached: 0, noCeiling: 0 };
  /** @type {Map<string, any>} */
  const groups = new Map();
  /** @type {Map<string, {provider:string, timeouts:number, hostCapMs:(number|null)}>} */
  const host = new Map();
  /** @type {Map<string, number>} */
  const outer = new Map();
  for (const run of runs) {
    for (const { start, end } of calls(run.events)) {
      if (end.cached) { skipped.cached++; continue; }
      if (!num(start.promptChars)) { skipped.noSize++; continue; }
      const provider = String(start.provider || end.provider);
      const timeout = !!end.isError && end.errorKind === "timeout";
      if (start.ceilingSource === "host") {
        if (timeout) {
          const h = host.get(provider) || { provider, timeouts: 0, hostCapMs: null };
          h.timeouts++;
          if (num(start.hostCapMs)) h.hostCapMs = start.hostCapMs;
          host.set(provider, h);
        }
        continue;
      }
      if (start.ceilingSource === "outer") { if (timeout) outer.set(provider, (outer.get(provider) || 0) + 1); continue; }
      if (!ADVISABLE.has(start.ceilingSource)) { skipped.noCeiling++; continue; }
      if (end.isError && !timeout) continue;
      const files = num(start.fileCount) && start.fileCount > 0;
      if (files && !num(start.fileBytes)) { skipped.unknownFileBytes++; continue; }
      const size = start.promptChars + (files ? start.fileBytes : 0);
      const split = files ? "files" : "text";
      const key = `${provider}|${end.model || ""}|${split}`;
      if (!groups.has(key)) groups.set(key, { provider, model: end.model || null, split, pts: [] });
      groups.get(key).pts.push({
        size, ms: num(end.ms) ? end.ms : 0, timeout, granted: start.grantedMs, configured: start.configuredTimeoutMs,
        source: start.ceilingSource, sharedBy: start.sharedBy, sharedLimit: start.sharedLimitMs, hostCap: start.hostCapMs, at: num(start.at) ? start.at : 0,
      });
    }
  }
  const size = [...groups.values()].map((g) => {
    const f = fit(g.pts.filter((/** @type {any} */ p) => !p.timeout).map((/** @type {any} */ p) => ({ x: p.size, y: p.ms })));
    let lo = 0;
    const buckets = BUCKETS.map((b) => {
      const pts = g.pts.filter((/** @type {any} */ p) => p.size >= lo && p.size < b.max);
      lo = b.max;
      const ok = pts.filter((/** @type {any} */ p) => !p.timeout).map((/** @type {any} */ p) => p.ms);
      const timeouts = pts.filter((/** @type {any} */ p) => p.timeout).length;
      const near = pts.filter((/** @type {any} */ p) => !p.timeout && num(p.granted) && p.ms > C.NEAR_CEILING * p.granted).length;
      return {
        label: b.label, n: pts.length, timeouts, timeoutRate: ratio(timeouts, pts.length), nearRate: ratio(near, pts.length),
        p50: median(ok), p95: quantile(ok, 0.95), medianGrantedMs: median(pts.filter((/** @type {any} */ p) => num(p.granted)).map((/** @type {any} */ p) => p.granted)),
        advice: bucketAdvice(pts, f, g.provider),
      };
    });
    return { provider: g.provider, model: g.model, split: g.split, fit: f, buckets };
  }).sort((a, b) => a.provider.localeCompare(b.provider) || a.split.localeCompare(b.split));
  return { size, hostTimeouts: [...host.values()], outerTimeouts: [...outer.entries()].map(([provider, timeouts]) => ({ provider, timeouts })), skipped };
}

/**
 * The Analyzer tab's report.
 * @param {any[]} details  run details: {summary, events}; legacy records (no events) are ignored
 * @returns {any}
 */
function analyze(details) {
  const runs = (Array.isArray(details) ? details : [])
    .filter((d) => d && typeof d === "object" && Array.isArray(d.events))
    .map((d) => ({ summary: d.summary && typeof d.summary === "object" ? d.summary : {}, events: d.events.filter((/** @type {any} */ e) => e && typeof e === "object") }));
  return { runs: runs.length, projects: projectsView(runs), models: modelsView(runs), ...sizeView(runs), constants: C };
}

module.exports = { analyze, C, timeoutKey, dropKey, fit };
