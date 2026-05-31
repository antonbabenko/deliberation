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
 * Minimal single-round advisory consensus: fan out to all providers, then run
 * ONE arbiter pass over the successful opinions. No blind multi-round; the
 * arbiter is just another Provider (default: the first in the set).
 * @param {Provider[]} providers
 * @param {DelegationRequest} req
 * @param {{arbiter?:Provider, arbiterInstructions?:string}} [opts]
 * @returns {Promise<{opinions:DelegationResult[], verdict:(DelegationResult|null), error?:string}>}
 */
async function consensus(providers, req, opts = {}) {
  const opinions = await askAll(providers, req);
  // The union guarantees `text` on the success branch, so `!o.isError` alone
  // narrows each survivor to DelegationSuccess - no `&& o.text` guard needed.
  const ok = /** @type {DelegationSuccess[]} */ (opinions.filter((o) => !o.isError));
  if (!ok.length) return { opinions, verdict: null, error: "all-providers-failed" };
  const arbiter = opts.arbiter || providers[0];
  if (!arbiter) return { opinions, verdict: null, error: "no-arbiter" };
  try {
    const verdict = await arbiter.ask({
      ...req,
      files: req.files ? req.files.map((f) => ({ ...f })) : undefined,
      prompt: buildArbiterPrompt(req.prompt, ok),
      developerInstructions: opts.arbiterInstructions || req.developerInstructions,
    });
    return { opinions, verdict };
  } catch {
    return { opinions, verdict: null, error: "arbiter-failed" };
  }
}

module.exports = { askAll, askOne, consensus, buildArbiterPrompt };
