"use strict";
/** @typedef {import("./types.js").Provider} Provider */
/** @typedef {import("./types.js").DelegationRequest} DelegationRequest */
/** @typedef {import("./types.js").DelegationResult} DelegationResult */
/** @typedef {import("./types.js").DelegationSuccess} DelegationSuccess */

const { parseReview } = require("./provider.js");
const loop = require("./consensus-loop.js");
const { NULL_LOGGER } = require("./debug-log.js");

/** @typedef {import("./debug-log.js").Logger} Logger */

/**
 * Emit one `provider_result` debug event for a settled call. Never throws.
 * @param {Logger} logger
 * @param {string} tool
 * @param {DelegationResult} r
 */
function logProviderResult(logger, tool, r) {
  try {
    logger.logEvent({
      event: "provider_result",
      at: Date.now(),
      tool,
      provider: r.provider,
      model: r.model,
      reasoningEffort: r.reasoningEffort ?? null,
      ms: r.ms,
      isError: r.isError,
      errorKind: r.isError ? r.errorKind : undefined,
      usage: r.isError ? undefined : r.usage,
    });
  } catch { /* logging must never break a call */ }
}

/**
 * Return `req` with the orientation bundle attached IFF the provider is file-blind
 * (capabilities.walksFilesystem === false) AND the caller attached no files of its
 * own. Otherwise return `req` unchanged. Shared by callProvider (peers) and the
 * arbiter blind pass so the gate is defined exactly once.
 * @param {Provider} provider
 * @param {DelegationRequest} req
 * @param {(import("./types.js").FileRef[]|undefined)} orientationFiles
 * @returns {DelegationRequest}
 */
function withOrientation(provider, req, orientationFiles) {
  if (
    Array.isArray(orientationFiles) && orientationFiles.length &&
    !(Array.isArray(req.files) && req.files.length) &&
    provider.capabilities && provider.capabilities.walksFilesystem === false
  ) {
    return { ...req, files: orientationFiles };
  }
  return req;
}

/**
 * One provider call with optional in-session cache + debug logging. On a cache
 * hit, returns the cached SUCCESS instantly (no model call) and still logs the
 * (cached) result so progress output is consistent. Only successes are cached.
 * @param {Provider} provider
 * @param {DelegationRequest} req
 * @param {Logger} logger
 * @param {string} tool
 * @param {(import("./result-cache.js").ResultCache|undefined)} cache
 * @param {(import("./types.js").FileRef[]|undefined)} [orientationFiles]  bundle auto-attached to file-blind providers
 * @returns {Promise<DelegationResult>}
 */
async function callProvider(provider, req, logger, tool, cache, orientationFiles) {
  // Auto-attach orientation to file-blind providers BEFORE the cache key is computed,
  // so the now-file-bearing request correctly bypasses the cwd-agnostic dedup cache
  // (keyFor excludes cwd; caching an oriented result would risk a cross-repo false hit).
  req = withOrientation(provider, req, orientationFiles);
  // File-bearing requests skip the cache: file CONTENT can change under the same
  // path, and the key only fingerprints the reference, not the bytes.
  const useCache = cache && !(Array.isArray(req.files) && req.files.length);
  if (useCache) {
    const hit = cache.get(provider.name, req);
    if (hit) { logProviderResult(logger, tool, hit); return hit; }
  }
  const started = Date.now();
  /** @type {DelegationResult} */
  let r;
  // One ask attempt, cloning files so a provider cannot mutate the caller's refs.
  const askOnce = () => provider.ask({ ...req, files: req.files ? req.files.map((f) => ({ ...f })) : undefined });
  try {
    r = await askOnce();
    // Consume `retryable` for the ONE safe case: a pre-response transport failure
    // (errorKind "network" == connect/DNS/socket error before any bytes). Retry it
    // exactly once. NEVER retry timeout (may have burned tokens / risks the
    // slow-but-good case), rate-limit (same limit), or auth/config (won't self-heal).
    if (r.isError && r.errorKind === "network") {
      r = await askOnce();
    }
  } catch (e) {
    // A provider that REJECTS (rather than returning an error envelope) must not
    // break the call OR vanish from the log. Synthesize + log a uniform error -
    // `unknown` matches askAll's existing allSettled-rejection fallback vocabulary.
    r = {
      provider: provider.name, model: "unknown", isError: true, errorKind: "unknown",
      retryable: false, message: String((e && /** @type {any} */ (e).message) || e), ms: Date.now() - started,
    };
  }
  logProviderResult(logger, tool, r);
  if (useCache) cache.set(provider.name, req, r);
  return r;
}

/**
 * Fan out ONE request to N providers concurrently. The whole serialization fix:
 * the host harness sees a single tool call, so it cannot stagger the providers.
 * Failures are isolated - the batch never rejects. Each provider is logged AS IT
 * SETTLES (not after the barrier), so the injected logger - file sink and/or live
 * MCP-notification sink - reports per-provider progress during the one call.
 * @param {Provider[]} providers
 * @param {DelegationRequest} req
 * @param {{logger?:Logger, tool?:string, cache?:import("./result-cache.js").ResultCache, orientationFiles?:import("./types.js").FileRef[]}} [opts]
 * @returns {Promise<DelegationResult[]>}
 */
async function askAll(providers, req, opts = {}) {
  const logger = opts.logger || NULL_LOGGER;
  const tool = opts.tool || "ask-all";
  const settled = await Promise.allSettled(
    providers.map((/** @type {Provider} */ p) => callProvider(p, req, logger, tool, opts.cache, opts.orientationFiles))
  );
  return settled.map((s, i) =>
    s.status === "fulfilled"
      ? s.value
      : {
          provider: providers[i].name,
          model: "unknown",
          isError: true,
          errorKind: "unknown",
          retryable: false,
          message: String((s.reason && s.reason.message) || s.reason || "rejected"),
          ms: 0,
        }
  );
}

/**
 * Single-provider call (advisory one-shot). Shared entrypoint for ask-* tools.
 * @param {Provider} provider
 * @param {DelegationRequest} req
 * @param {{logger?:Logger, tool?:string, cache?:import("./result-cache.js").ResultCache, orientationFiles?:import("./types.js").FileRef[]}} [opts]
 * @returns {Promise<DelegationResult>}
 */
async function askOne(provider, req, opts = {}) {
  return callProvider(provider, req, opts.logger || NULL_LOGGER, opts.tool || "ask-one", opts.cache, opts.orientationFiles);
}

// Per-opinion cap for the arbiter prompt. The arbiter inlines every peer opinion
// into ONE prompt, so worst-case size is (peers x opinion length). Cap each block
// so one rambly model can't blow the arbiter's context or crowd out the others.
// ~2k chars keeps a full verdict + rationale while bounding the total.
const MAX_PEER_OPINION_CHARS = 2000;

/**
 * Cap a peer opinion's text for inlining, appending a marker when truncated.
 * @param {string} text
 * @returns {string}
 */
function capPeerOpinion(text) {
  if (typeof text !== "string" || text.length <= MAX_PEER_OPINION_CHARS) return text;
  return text.slice(0, MAX_PEER_OPINION_CHARS) + "\n...[truncated]";
}

/**
 * Assemble the arbiter prompt from independent opinions for blind cross-review.
 * @param {string} question
 * @param {DelegationSuccess[]} opinions  // successful opinions only (text guaranteed)
 * @returns {string}
 */
function buildArbiterPrompt(question, opinions) {
  // Labels are anonymized (### Opinion N, no provider name) so the arbiter
  // judges substance, not source reputation. The opinions array returned to the
  // caller keeps provider names; only this prompt is anonymized. Each opinion is
  // capped (MAX_PEER_OPINION_CHARS) so the combined prompt stays bounded.
  const blocks = opinions.map((o, i) => `### Opinion ${i + 1}\n${capPeerOpinion(o.text)}`).join("\n\n");
  return [
    "You are the arbiter. Below are independent expert opinions on the same question.",
    "Cross-review them: note where they agree, where they disagree, and which view is best supported.",
    "Then produce ONE synthesized verdict.",
    "",
    `## Original question\n${question}`,
    "",
    `## Opinions\n${blocks}`,
    "",
    "## Your verdict\nBottom line, points of agreement, points of disagreement, final recommendation.",
  ].join("\n");
}

/**
 * Single-round advisory consensus: fan out to all providers, then run ONE arbiter
 * pass over the successful opinions. The arbiter is just another Provider
 * (default: the first in the set).
 *
 * Optional `blindVote`: the arbiter ALSO answers the original question cold (no
 * peer opinions) to produce a `blindVerdict`, fired in PARALLEL with the peer
 * fan-out (no extra round). It reduces the arbiter anchoring on the peers' framing.
 * Failure-isolated: a thrown blind pass yields `blindVerdict:null`, never failing
 * the run. `blindVerdict` is `null` when `blindVote` is off or no arbiter exists.
 * @param {Provider[]} providers
 * @param {DelegationRequest} req
 * @param {{arbiter?:Provider, arbiterInstructions?:string, blindVote?:boolean, logger?:Logger, orientationFiles?:import("./types.js").FileRef[]}} [opts]
 * @returns {Promise<{opinions:DelegationResult[], blindVerdict:(DelegationResult|null), verdict:(DelegationResult|null), error?:string}>}
 */
async function consensus(providers, req, opts = {}) {
  const arbiter = opts.arbiter || providers[0];
  // Blind pre-vote runs concurrently with the peer fan-out. It uses the ORIGINAL
  // prompt (no opinions) + the arbiter persona. `.then(v, () => null)` isolates a
  // blind-pass failure so it can never reject the batch.
  const blindPromise = opts.blindVote && arbiter
    ? // Promise.resolve().then(...) so even a SYNCHRONOUS throw in ask() is caught
      // by the rejection handler (a bare arbiter.ask() could throw before awaiting).
      Promise.resolve()
        .then(() =>
          arbiter.ask(withOrientation(arbiter, {
            ...req,
            files: req.files ? req.files.map((f) => ({ ...f })) : undefined,
            developerInstructions: opts.arbiterInstructions || req.developerInstructions,
          }, opts.orientationFiles))
        )
        .then((v) => v, () => null)
    : Promise.resolve(/** @type {DelegationResult|null} */ (null));

  const [opinions, blindVerdict] = await Promise.all([askAll(providers, req, { logger: opts.logger, tool: "consensus", orientationFiles: opts.orientationFiles }), blindPromise]);
  // The union guarantees `text` on the success branch, so `!o.isError` alone
  // narrows each survivor to DelegationSuccess - no `&& o.text` guard needed.
  const ok = /** @type {DelegationSuccess[]} */ (opinions.filter((o) => !o.isError));
  if (!ok.length) return { opinions, blindVerdict, verdict: null, error: "all-providers-failed" };
  if (!arbiter) return { opinions, blindVerdict, verdict: null, error: "no-arbiter" };
  try {
    // The verdict pass is NOT oriented (unlike the blind pass above): by this
    // point every peer opinion is inlined into buildArbiterPrompt, so a file-blind
    // arbiter is reasoning over peer text, not the cold repo - orientation files
    // would be redundant context. Keep this asymmetry intentional.
    const verdict = await arbiter.ask({
      ...req,
      files: req.files ? req.files.map((f) => ({ ...f })) : undefined,
      prompt: buildArbiterPrompt(req.prompt, ok),
      developerInstructions: opts.arbiterInstructions || req.developerInstructions,
    });
    return { opinions, blindVerdict, verdict };
  } catch {
    return { opinions, blindVerdict, verdict: null, error: "arbiter-failed" };
  }
}

/**
 * Build the per-round adjudication prompt for the provider arbiter. Embeds each
 * peer's verdict + issues verbatim (so the arbiter - and a deterministic test
 * stub - can see dissent), and asks for a single overall verdict.
 * @param {{currentPlan:string}} state
 * @param {Array<{source:string, isError:boolean, verdict:(string|null), criticalIssues:{category:string,description:string}[]}>} results
 * @returns {string}
 */
function buildAdjudicationPrompt(state, results) {
  const peerBlocks = results.map((r) => {
    if (r.isError) return `Peer ${r.source}: ERRORED`;
    const issues = (r.criticalIssues || []).map((i) => `  - [${i.category}] ${i.description}`).join("\n");
    // Cap each peer block (same bound as buildArbiterPrompt): a peer with many
    // long issue descriptions must not blow the arbiter's per-round context.
    return capPeerOpinion(`Peer ${r.source}: ${r.verdict || "UNKNOWN"}${issues ? "\n" + issues : ""}`);
  }).join("\n");
  return [
    "ADJUDICATE the peer reviews below and give ONE overall verdict.",
    `## Plan\n${state.currentPlan}`,
    `## Peer reviews\n${peerBlocks}`,
    "End with **Verdict**: APPROVE | REQUEST_CHANGES | REJECT.",
  ].join("\n\n");
}

/**
 * Build the per-round revision prompt for the provider arbiter.
 * @param {{currentPlan:string}} state
 * @param {Array<{source:string, isError:boolean, verdict:(string|null), criticalIssues:{category:string,description:string}[]}>} results
 * @returns {string}
 */
function buildRevisionPrompt(state, results) {
  const feedback = results
    .filter((r) => !r.isError && r.verdict !== "APPROVE")
    .flatMap((r) => (r.criticalIssues || []).map((i) => `- [${i.category}] ${i.description}`))
    .join("\n");
  return [
    "REVISE THE PLAN to address the critical issues below. Return ONLY the revised plan.",
    `## Current plan\n${state.currentPlan}`,
    `## Must-fix issues\n${feedback || "(reviewers gave no specific issues; tighten the weakest part)"}`,
  ].join("\n\n");
}

/** Resolve a provider reply to non-empty text, or null. */
function okText(/** @type {any} */ res) {
  return res && res.isError === false && typeof res.text === "string" && res.text.trim() ? res.text : null;
}

/**
 * Drive the full multi-round consensus loop to convergence using a PROVIDER
 * arbiter - the non-Claude host path. Shares the exact core/consensus-loop.js
 * state machine the Claude command drives client-side (single source of truth);
 * here the arbiter's blind/adjudication/revision steps are provider calls and
 * the blind pass runs in PARALLEL with the peer fan-out (no interactive stall).
 * Failure-isolated and never rejects: a failed blind pass degrades to a
 * sentinel, a failed adjudication holds the verdict at REQUEST_CHANGES, a failed
 * revision keeps the current plan.
 * @param {Provider[]} providers  peer panel
 * @param {DelegationRequest} req  `prompt` is the initial plan
 * @param {{arbiter?:Provider, maxRounds?:number, maxWallMs?:number, now?:()=>number, logger?:Logger, orientationFiles?:import("./types.js").FileRef[]}} [opts]
 * @returns {Promise<{converged:boolean, verdict:(string|null), confidence:string, finalReport?:string, rounds:any[], opinions:any[], error?:string, stopReason?:string}>}
 */
async function runToConvergence(providers, req, opts = {}) {
  const arbiter = opts.arbiter;
  const logger = opts.logger || NULL_LOGGER;
  const now = typeof opts.now === "function" ? opts.now : Date.now;
  const maxWallMs = typeof opts.maxWallMs === "number" && opts.maxWallMs > 0 ? opts.maxWallMs : null;
  const startedAt = now();
  /** @type {(string|null)} */
  let stopReason = null;
  if (!arbiter) return { converged: false, verdict: null, confidence: "none", rounds: [], opinions: [], error: "no-arbiter" };

  let state = loop.initConsensusLoop({
    plan: typeof req.prompt === "string" ? req.prompt : "",
    maxRounds: opts.maxRounds,
    expert: req.expert,
    arbiterMode: "provider",
  });
  /** @type {any[]} */
  let lastResults = [];

  // Top-level guard: a synchronous throw from a malformed provider (e.g. askAll's
  // map building) or any state-machine transition must NOT reject - the loop is
  // failure-isolated. Return a structured error with whatever we have so far.
  try {
    while (state.status !== "converged" && state.status !== "unresolved") {
      // Budget gates STARTING a round; it never interrupts the in-flight fan-out
      // below, so a legitimately slow peer answer is always collected in full.
      if (maxWallMs !== null && now() - startedAt >= maxWallMs) { stopReason = "budget-exhausted"; break; }
      const { peerPrompt, blindPrompt } = loop.prepareRound(state);
      // Blind pass runs concurrently with the peer fan-out; isolate its failure.
      const roundNo = state.round;
      const [blindRes, peerResults] = await Promise.all([
        Promise.resolve().then(() => arbiter.ask(withOrientation(arbiter, { ...req, prompt: blindPrompt }, opts.orientationFiles))).then((r) => r, () => null),
        askAll(providers, { ...req, prompt: peerPrompt }, { logger, tool: "consensus", orientationFiles: opts.orientationFiles }),
      ]);
      state = loop.recordBlindVerdict(state, okText(blindRes) || "(blind pass unavailable)");

      lastResults = peerResults.map((r) =>
        r.isError
          ? { source: r.provider, isError: true, errorKind: r.errorKind, verdict: null, criticalIssues: [] }
          // parseReview spread FIRST so the explicit structural fields always win.
          : { ...parseReview(typeof r.text === "string" ? r.text : ""), source: r.provider, isError: false, ms: r.ms }
      );
      state = loop.addOpinions(state, lastResults);

      // Peer dissent => this round CANNOT converge (checkConvergence requires every
      // responding peer to APPROVE), so the revision is GUARANTEED needed: overlap it
      // with adjudication for free. All-approve => the round may converge, so do NOT
      // speculate a revision we might discard. Net: same arbiter-call COUNT as the
      // serial loop in every outcome, one serial leg saved per dissent (non-final) round.
      //
      // CONTRACT this parallelization relies on (revert to serial if either breaks):
      //   1. buildRevisionPrompt depends only on state.currentPlan + the peer results,
      //      NOT on the arbiter's adjudicated verdict.
      //   2. loop.submitAdjudication does not mutate state.currentPlan, so the revision
      //      prompt is identical whether built before or after adjudication.
      const peerDissent = lastResults.some((r) => !r.isError && r.verdict !== "APPROVE");
      // Isolate a whole arbiter branch (ask + parse) so neither a synchronous throw, a
      // rejected ask, nor a parse fault can reject Promise.all - matching the per-call
      // try/catch scope of the serial version and the blind-pass wrapper above. The
      // adjudication/revision passes are intentionally NOT oriented (unlike the blind
      // pass): the arbiter reasons over inlined peer text, not the cold repo.
      const askIsolated = (/** @type {string} */ prompt) =>
        Promise.resolve().then(() => arbiter.ask({ ...req, prompt })).then((r) => r, () => null);
      /** @param {(DelegationResult|null)} res @returns {"APPROVE"|"REQUEST_CHANGES"|"REJECT"} */
      const verdictFrom = (res) => {
        const t = okText(res);
        if (!t) return "REQUEST_CHANGES"; // null/empty -> hold (the serial default)
        try { return parseReview(t).verdict || "REQUEST_CHANGES"; } catch { return "REQUEST_CHANGES"; }
      };

      /** @type {"APPROVE"|"REQUEST_CHANGES"|"REJECT"} */
      let verdict = "REQUEST_CHANGES";
      let revised = state.currentPlan;
      if (peerDissent) {
        // Guaranteed non-final: adjudication || revision, both used (no waste).
        const [adjRes, revRes] = await Promise.all([
          askIsolated(buildAdjudicationPrompt(state, lastResults)),
          askIsolated(buildRevisionPrompt(state, lastResults)),
        ]);
        verdict = verdictFrom(adjRes);
        revised = okText(revRes) || state.currentPlan;
      } else {
        // May converge: adjudication only - do not burn a revision call we might discard.
        verdict = verdictFrom(await askIsolated(buildAdjudicationPrompt(state, lastResults)));
      }
      state = loop.submitAdjudication(state, { verdict, decisions: [] });
      try {
        logger.logEvent({
          event: "round", at: Date.now(), tool: "consensus", round: roundNo,
          verdict, converged: state.status === "converged",
          blindVerdict: okText(blindRes) ? "(recorded)" : null,
          voices: lastResults.length,
        });
      } catch { /* logging must never break the loop */ }
      if (state.status === "converged") break;

      if (!peerDissent) {
        // Rare: all peers APPROVED but the arbiter blocked -> revise now (serial; there
        // was nothing to overlap, since convergence was still possible at fan-out time).
        revised = okText(await askIsolated(buildRevisionPrompt(state, lastResults))) || state.currentPlan;
      }
      state = loop.submitRevision(state, revised, "arbiter revision");
    }
  } catch (e) {
    return {
      converged: false,
      verdict: null,
      confidence: "none",
      rounds: state.history,
      opinions: lastResults,
      error: `loop-failed: ${String((e && /** @type {any} */ (e).message) || e)}`,
    };
  }

  const { finalReport, confidence } = loop.finalize(state);
  return {
    converged: state.status === "converged",
    verdict: state.hostVerdict ? state.hostVerdict.verdict : null,
    confidence,
    finalReport,
    rounds: state.history,
    opinions: lastResults,
    ...(stopReason ? { stopReason } : {}),
  };
}

module.exports = { askAll, askOne, consensus, buildArbiterPrompt, buildAdjudicationPrompt, runToConvergence };
