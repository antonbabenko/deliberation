// telemetry.js - pure debate convergence trajectory and provider latency analytics for runs.
// Pure derivation functions are Node-testable (no DOM); renderers use dom.js element builders.

import { providerLabel, h, s, fmtMs, fmtInt, verdictLabel, num } from "./dom.js";
import { inkOf } from "./graph.js";

const isConsensus = (wf) => wf === "consensus" || wf === "consensus-step";
const roundOf = (v) => (num(v) !== null && v > 0 ? v : 1);

/**
 * Derive the round-by-round convergence trajectory of a consensus debate.
 * Pure function: takes run state object, returns array of round trajectory records.
 * @param {any} run
 * @returns {Array<{
 *   round: number,
 *   peers: Array<{ provider: string, model: string|null, verdict: string|null, ms: number|null, isError: boolean, issuesCount: number }>,
 *   arbiter: { action: string|null, verdict: string|null, hasRevision: boolean, text?: string },
 *   converged: boolean,
 *   agreedCount: number,
 *   totalPeers: number,
 *   summary: string
 * }>}
 */
export function deriveDebateTrajectory(run) {
  if (!run || !isConsensus(run.workflow)) return [];

  const calls = (run.callOrder || []).map((id) => run.calls[id]).filter(Boolean);
  const arbiterEvents = Array.isArray(run.arbiter) ? run.arbiter : [];
  const stateEvents = Array.isArray(run.states) ? run.states : [];

  // Determine all rounds present in the run
  let maxRound = num(run.rounds) || 1;
  for (const c of calls) maxRound = Math.max(maxRound, roundOf(c.round));
  for (const a of arbiterEvents) maxRound = Math.max(maxRound, roundOf(a.round));
  for (const st of stateEvents) maxRound = Math.max(maxRound, roundOf(st.round));

  const rounds = [];

  for (let r = 1; r <= maxRound; r++) {
    // Peer calls in this round (ignoring superseded retried attempts)
    const peerCalls = calls.filter((c) => c.role === "peer" && roundOf(c.round) === r && !c.retried);

    // Fall back to state events if peer calls are not yet recorded (or in step mode)
    const stRound = stateEvents.find((st) => roundOf(st.round) === r && Array.isArray(st.verdicts));
    const stateVerdicts = new Map();
    if (stRound && Array.isArray(stRound.verdicts)) {
      for (const v of stRound.verdicts) {
        if (v && v.provider) stateVerdicts.set(v.provider, v);
      }
    }

    const peers = peerCalls.map((c) => {
      const vFromState = stateVerdicts.get(c.provider);
      const issues = (Array.isArray(c.criticalIssues) && c.criticalIssues.length) ||
        (vFromState && Array.isArray(vFromState.categories) ? vFromState.categories.length : 0);
      return {
        provider: c.provider,
        model: c.model || null,
        verdict: c.verdict || (vFromState ? vFromState.verdict : null),
        ms: c.ms,
        isError: !!c.isError,
        issuesCount: issues,
      };
    });

    // If no peer calls recorded but state has verdicts
    if (peers.length === 0 && stateVerdicts.size > 0) {
      for (const [provider, sv] of stateVerdicts.entries()) {
        peers.push({
          provider,
          model: null,
          verdict: sv.verdict || null,
          ms: null,
          isError: false,
          issuesCount: Array.isArray(sv.categories) ? sv.categories.length : 0,
        });
      }
    }

    // Arbiter events for this round
    const roundArbiter = arbiterEvents.filter((a) => roundOf(a.round) === r);
    const adjEvent = roundArbiter.find((a) => a.action === "submit_adjudication");
    const blindEvent = roundArbiter.find((a) => a.action === "record_blind");
    const revEvent = roundArbiter.find((a) => a.action === "submit_revision");

    // Also check for arbiter calls (automated arbiter); prioritize call with verdict
    const arbCalls = calls.filter((c) => (c.role === "arbiter" || c.role === "blind") && roundOf(c.round) === r);
    const verdictArbCall = arbCalls.slice().reverse().find((c) => c.verdict) || (arbCalls.length ? arbCalls[arbCalls.length - 1] : null);

    const arbiterVerdict = (adjEvent && adjEvent.verdict) || (verdictArbCall && verdictArbCall.verdict) || (blindEvent && blindEvent.verdict) || null;
    const arbiterAction = (adjEvent && adjEvent.action) || (verdictArbCall && verdictArbCall.role) || (blindEvent && blindEvent.action) || (revEvent ? "submit_revision" : null);

    const approvedPeers = peers.filter((p) => String(p.verdict || "").toUpperCase() === "APPROVE");
    const dissentingPeers = peers.filter((p) => {
      const v = String(p.verdict || "").toUpperCase();
      return v === "REQUEST_CHANGES" || v === "REJECT";
    });

    const isLastRound = r === maxRound;
    const isConvergedState = stateEvents.some((st) => (num(st.round) !== null ? st.round === r : isLastRound) && st.state === "converged") ||
      (isLastRound && run.status === "converged");

    let summary = "";
    if (isConvergedState || (peers.length > 0 && approvedPeers.length === peers.length && (!arbiterVerdict || arbiterVerdict === "APPROVE"))) {
      summary = `Consensus reached (${approvedPeers.length}/${peers.length} agreed)`;
    } else if (dissentingPeers.length > 0) {
      const dissenterNames = dissentingPeers.map((p) => providerLabel(p.provider)).join(", ");
      summary = `Dissent: ${dissenterNames}${revEvent ? " (revised)" : ""}`;
    } else if (peers.length > 0) {
      summary = `${approvedPeers.length}/${peers.length} approved`;
    } else {
      summary = "Round in progress";
    }

    rounds.push({
      round: r,
      peers,
      arbiter: {
        action: arbiterAction,
        verdict: arbiterVerdict,
        hasRevision: !!revEvent,
        text: (revEvent && revEvent.text) || (adjEvent && adjEvent.text) || undefined,
      },
      converged: isConvergedState,
      agreedCount: approvedPeers.length,
      totalPeers: peers.length,
      summary,
    });
  }

  return rounds;
}

/**
 * Derive per-provider latency breakdown for all calls within a run.
 * Pure function: takes run state object, returns array of provider latency records.
 * @param {any} run
 * @returns {Array<{
 *   provider: string,
 *   model: string|null,
 *   calls: number,
 *   totalMs: number,
 *   meanMs: number,
 *   maxMs: number,
 *   errors: number,
 *   share: number
 * }>}
 */
export function deriveProviderLatency(run) {
  if (!run || !run.calls) return [];

  const calls = (run.callOrder || []).map((id) => run.calls[id]).filter(Boolean);
  if (calls.length === 0) return [];

  const byProvider = new Map();

  for (const c of calls) {
    if (!c.provider || c.cached) continue;
    let entry = byProvider.get(c.provider);
    if (!entry) {
      entry = {
        provider: c.provider,
        model: c.model || null,
        calls: 0,
        durations: [],
        errors: 0,
      };
      byProvider.set(c.provider, entry);
    }
    entry.calls += 1;
    if (c.model && !entry.model) entry.model = c.model;
    if (num(c.ms) !== null) entry.durations.push(c.ms);
    if (c.isError) entry.errors += 1;
  }

  const out = [];
  let maxTotalMs = 1;

  for (const entry of byProvider.values()) {
    const totalMs = entry.durations.reduce((sum, d) => sum + d, 0);
    const meanMs = entry.durations.length ? Math.round(totalMs / entry.durations.length) : 0;
    const maxMs = entry.durations.reduce((max, d) => Math.max(max, d), 0);
    maxTotalMs = Math.max(maxTotalMs, totalMs);

    out.push({
      provider: entry.provider,
      model: entry.model,
      calls: entry.calls,
      totalMs,
      meanMs,
      maxMs,
      errors: entry.errors,
      share: 0, // computed below
    });
  }

  // Compute share relative to max provider time
  for (const item of out) {
    item.share = Math.min(1, Math.max(0, item.totalMs / maxTotalMs));
  }

  // Sort slowest total latency first
  out.sort((a, b) => b.totalMs - a.totalMs || b.meanMs - a.meanMs);
  return out;
}

// ------------------------------------------------------------------ DOM Renderers

/**
 * Render verdict tag pill with semantic status color.
 * @param {string|null} verdict
 * @returns {HTMLElement}
 */
export function renderVerdictPill(verdict) {
  const norm = String(verdict || "").toUpperCase().replace(/\s+/g, "_");
  let tone = "neutral";
  if (norm === "APPROVE") tone = "ok";
  else if (norm === "REQUEST_CHANGES" || norm === "REJECT") tone = "bad";
  else if (norm === "ABSTAIN") tone = "neutral";

  const label = verdictLabel(verdict) || (verdict ? String(verdict) : "NONE");
  return h("span", { class: `verdict-pill tone-${tone}` }, label);
}

/**
 * Render the Debate Convergence Trajectory table/cards.
 * @param {ReturnType<typeof deriveDebateTrajectory>} trajectory
 * @param {(round: number) => void} [onSelectRound]
 * @returns {HTMLElement}
 */
export function renderDebateTrajectory(trajectory, onSelectRound) {
  if (!trajectory || trajectory.length === 0) return h("div");

  const rows = trajectory.map((item) => {
    const peerPills = item.peers.map((p) =>
      h("span", { class: "peer-verdict-group", title: `${providerLabel(p.provider)}: ${p.verdict || "pending"}${p.ms ? ` (${fmtMs(p.ms)})` : ""}` },
        h("span", { class: `provider-tag ink-${inkOf(p.provider)}` }, providerLabel(p.provider)),
        renderVerdictPill(p.verdict),
        p.issuesCount > 0 ? h("span", { class: "issues-count", title: `${p.issuesCount} critical issues` }, `[${p.issuesCount}]`) : null
      )
    );

    const arbiterCell = (item.arbiter.verdict || item.arbiter.hasRevision)
      ? h("div", { class: "arbiter-verdict-group" },
          item.arbiter.verdict ? renderVerdictPill(item.arbiter.verdict) : null,
          item.arbiter.hasRevision ? h("span", { class: "revision-tag" }, "revised") : null
        )
      : h("span", { class: "muted" }, "-");

    const roundBtn = h("button", {
      type: "button",
      class: "round-btn",
      onclick: () => onSelectRound && onSelectRound(item.round),
      title: `Filter waveform to round ${item.round}`
    }, `Round ${item.round}`);

    return h("tr", { class: item.converged ? "is-converged" : "" },
      h("td", { class: "round-cell" }, roundBtn),
      h("td", { class: "peers-cell" }, peerPills.length ? peerPills : h("span", { class: "muted" }, "waiting for peers...")),
      h("td", { class: "arbiter-cell" }, arbiterCell),
      h("td", { class: "summary-cell" },
        h("span", { class: `trajectory-status ${item.converged ? "st-converged" : "st-pending"}` }, item.summary)
      )
    );
  });

  return h("section", { class: "panel trajectory-panel" },
    h("h2", {}, "Debate Convergence Trajectory"),
    h("p", { class: "hint" }, "Progression of peer votes, arbiter revisions, and convergence state per round."),
    h("div", { class: "table-wrap" },
      h("table", { class: "grid-table trajectory-table" },
        h("thead", {},
          h("tr", {},
            h("th", {}, "Round"),
            h("th", {}, "Peer Opinions"),
            h("th", {}, "Arbiter"),
            h("th", {}, "Outcome")
          )
        ),
        h("tbody", {}, rows)
      )
    )
  );
}

/**
 * Render the Provider Latency Breakdown table with SVG range bars.
 * @param {ReturnType<typeof deriveProviderLatency>} latencies
 * @returns {HTMLElement}
 */
export function renderProviderLatency(latencies) {
  if (!latencies || latencies.length === 0) return h("div");

  const rows = latencies.map((m) => {
    const pct = Math.round(m.share * 100);
    const bar = s("svg", { class: "range-scale", viewBox: "0 0 100 14", preserveAspectRatio: "none", "aria-hidden": "true" },
      Array.from({ length: 11 }, (_, i) => s("line", { x1: i * 10, x2: i * 10, y1: i % 5 ? 3 : 0, y2: i % 5 ? 11 : 14, class: "range-div" })),
      s("rect", { x: 0, y: 4, width: pct, height: 6, class: `range ink-${inkOf(m.provider)}` })
    );

    return h("tr", {},
      h("td", { class: "strong" },
        `${providerLabel(m.provider)} `,
        m.model ? h("span", { class: "muted" }, m.model) : null
      ),
      h("td", { class: "num" }, fmtInt(m.calls)),
      h("td", { class: "num" }, fmtMs(m.meanMs)),
      h("td", { class: "num" }, fmtMs(m.maxMs)),
      h("td", { class: "num" }, fmtMs(m.totalMs)),
      h("td", { class: "range-cell", "aria-hidden": "true" }, bar),
      h("td", { class: `num${m.errors ? " has-errors" : ""}` }, String(m.errors || 0))
    );
  });

  return h("section", { class: "panel latency-panel" },
    h("h2", {}, "Provider Latency Breakdown"),
    h("p", { class: "hint" }, "Per-provider thinking time and call latency distribution in this run. Slowest total time first."),
    h("div", { class: "table-wrap" },
      h("table", { class: "grid-table latency-table" },
        h("thead", {},
          h("tr", {},
            h("th", {}, "Provider"),
            h("th", { class: "num" }, "Calls"),
            h("th", { class: "num" }, "Mean"),
            h("th", { class: "num" }, "Max"),
            h("th", { class: "num" }, "Total"),
            h("th", {}, "Share"),
            h("th", { class: "num" }, "Errors")
          )
        ),
        h("tbody", {}, rows)
      )
    )
  );
}
