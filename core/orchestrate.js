"use strict";
/** @typedef {import("./types.js").Provider} Provider */
/** @typedef {import("./types.js").DelegationRequest} DelegationRequest */
/** @typedef {import("./types.js").DelegationResult} DelegationResult */
/** @typedef {import("./types.js").DelegationSuccess} DelegationSuccess */

/**
 * Fan out ONE request to N providers concurrently. The whole serialization fix:
 * the host harness sees a single tool call, so it cannot stagger the providers.
 * Failures are isolated - the batch never rejects.
 * @param {Provider[]} providers
 * @param {DelegationRequest} req
 * @returns {Promise<DelegationResult[]>}
 */
async function askAll(providers, req) {
  const settled = await Promise.allSettled(
    providers.map((/** @type {Provider} */ p) =>
      p.ask({ ...req, files: req.files ? req.files.map((f) => ({ ...f })) : undefined })
    )
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
 * @returns {Promise<DelegationResult>}
 */
async function askOne(provider, req) {
  return provider.ask({ ...req, files: req.files ? req.files.map((f) => ({ ...f })) : undefined });
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
  // caller keeps provider names; only this prompt is anonymized.
  const blocks = opinions.map((o, i) => `### Opinion ${i + 1}\n${o.text}`).join("\n\n");
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
 * @param {{arbiter?:Provider, arbiterInstructions?:string, blindVote?:boolean}} [opts]
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
          arbiter.ask({
            ...req,
            files: req.files ? req.files.map((f) => ({ ...f })) : undefined,
            developerInstructions: opts.arbiterInstructions || req.developerInstructions,
          })
        )
        .then((v) => v, () => null)
    : Promise.resolve(/** @type {DelegationResult|null} */ (null));

  const [opinions, blindVerdict] = await Promise.all([askAll(providers, req), blindPromise]);
  // The union guarantees `text` on the success branch, so `!o.isError` alone
  // narrows each survivor to DelegationSuccess - no `&& o.text` guard needed.
  const ok = /** @type {DelegationSuccess[]} */ (opinions.filter((o) => !o.isError));
  if (!ok.length) return { opinions, blindVerdict, verdict: null, error: "all-providers-failed" };
  if (!arbiter) return { opinions, blindVerdict, verdict: null, error: "no-arbiter" };
  try {
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

module.exports = { askAll, askOne, consensus, buildArbiterPrompt };
