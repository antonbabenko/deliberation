// views/run.js - one run as a capture (header strip, trigger sequence, waveform, event
// table), the inspector drawer, and the run detail route (#/runs/<id>).

import { h, put, fmtMs, fmtClock, fmtInt, fmtK, fmtTime, shortId, verdictLabel, num } from "../dom.js";
import { graphModel, renderGraph } from "../graph.js";

const ENDED = new Set(["done", "converged", "unresolved", "error"]);

const elapsedOf = (run, now) => {
  if (!run.startedAt) return null;
  const end = run.status === "running" ? now : run.endedAt ?? run.lastAt;
  return Math.max(0, end - run.startedAt);
};

function readout(label, value, extra) {
  return h("div", { class: `readout${extra ? ` ${extra}` : ""}` }, h("dt", {}, label), h("dd", {}, value));
}

export function statusMark(status) {
  return h("span", { class: `status-mark st-${status}` }, status);
}

function eventDetail(e) {
  const kv = (k, v) => (v === null || v === undefined || v === "" ? null : `${k}=${v}`);
  const parts = [];
  switch (e.kind) {
    case "run_start":
      parts.push(e.tool, e.workflow, kv("providers", (e.providers || []).join(",")), kv("expert", e.expert));
      break;
    case "state":
      parts.push(e.state, kv("status", e.status));
      for (const v of e.verdicts || []) parts.push(`${v.provider}:${verdictLabel(v.verdict) || "-"}`);
      break;
    case "call_start":
      parts.push(kv("role", e.role), kv("effort", e.reasoningEffort), kv("limit", num(e.timeoutMs) ? fmtMs(e.timeoutMs) : null));
      break;
    case "call_end":
      if (e.isError) parts.push("ERR", e.errorKind, kv("code", e.errorCode));
      else parts.push("ok", verdictLabel(e.verdict));
      parts.push(fmtMs(e.ms), e.usage ? `${fmtK((e.usage.totalTokens) ?? ((e.usage.promptTokens || 0) + (e.usage.completionTokens || 0)))} tok` : null, kv("model", e.model));
      break;
    case "arbiter":
      parts.push(String(e.action || "").replace(/_/g, " "), verdictLabel(e.verdict));
      break;
    case "run_end":
      parts.push(e.status, kv("rounds", e.rounds), kv("stop", e.stopReason), kv("dropped", (e.droppedProviders || []).join(",")));
      break;
    default:
      break;
  }
  return parts.filter(Boolean).join("  ");
}

const channelOf = (e) => (e.kind === "arbiter" ? "arbiter (host)" : e.provider || "");

function eventTable(ctx, run) {
  const rows = run.events.map((e) => {
    const key = e.callId || null;
    const selected = key && ctx.S.selection && ctx.S.selection.key === key;
    const open = () => key && ctx.select(run.runId, key);
    const round = e.round ?? (key && run.calls[key] ? run.calls[key].round : null);
    return h("tr", {
      class: `${key ? "is-link" : ""}${selected ? " is-selected" : ""}${e.isError ? " is-error" : ""}`, tabindex: key ? "0" : null,
      onclick: open, onkeydown: (ev) => { if (key && (ev.key === "Enter" || ev.key === " ")) { ev.preventDefault(); open(); } },
    },
    h("td", { class: "num" }, String(e.seq ?? "")),
    h("td", { class: "num" }, run.startedAt && num(e.at) !== null ? `+${fmtMs(e.at - run.startedAt)}` : "-"),
    h("td", {}, h("span", { class: `kind kind-${e.kind}` }, e.kind)),
    h("td", { class: "col-ch" }, channelOf(e)),
    h("td", { class: "num col-rnd" }, round ?? ""),
    h("td", { class: "detail" }, eventDetail(e)));
  });
  return h("table", { class: "events" },
    h("thead", {}, h("tr", {}, h("th", { class: "num" }, "seq"), h("th", { class: "num" }, "t"), h("th", {}, "kind"), h("th", { class: "col-ch" }, "channel"), h("th", { class: "num col-rnd" }, "rnd"), h("th", {}, "decode"))),
    h("tbody", {}, rows));
}

/**
 * One run as a capture.
 * @param {any} ctx
 * @param {string} runId
 * @param {{full?: boolean}} [opts]  full: event table too
 */
export function createCapture(ctx, runId, opts = {}) {
  const el = h("section", { class: "capture", "aria-label": `Run ${runId}` });
  const strip = h("dl", { class: "strip" });
  const seq = h("ol", { class: "seq", "aria-label": "Trigger sequence" });
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("role", "group");
  svg.setAttribute("aria-label", "Waveform capture");
  const scope = h("figure", { class: "scope" }, svg);
  const note = h("p", { class: "capture-note" });
  const events = h("details", { class: "events-panel", ontoggle: () => ctx.panel("events", events.open) });
  let eventsLen = "";
  let lastRun = null;
  let clock = null;
  el.append(strip, seq, scope, note);
  if (opts.full) {
    events.open = ctx.panel("events");
    el.append(events);
  }

  function draw(run, now) {
    const model = graphModel(run, { now, round: ctx.roundFor(runId), health: ctx.S.health });
    const sel = ctx.S.selection && ctx.S.selection.runId === runId ? ctx.S.selection.key : null;
    model.ui = {
      selected: sel,
      cursors: ctx.cursorsFor(runId),
      onSelect: (key) => ctx.select(runId, key),
      onRound: (n, focus) => {
        ctx.setRound(runId, n);
        if (focus) requestAnimationFrame(() => {
          const t = svg.querySelector(`[data-key="round:${n}"]`);
          if (t) t.focus();
        });
      },
      onCursor: (a, b) => ctx.setCursors(runId, a, b),
    };
    renderGraph(svg, model.workflow, model);
    return model;
  }

  function drawStrip(run, model, now) {
    const el2 = elapsedOf(run, now);
    put(strip,
      readout("tool", run.tool || "-"),
      readout("workflow", run.workflow || "-"),
      readout("run", h("a", { href: `#/runs/${encodeURIComponent(run.runId)}`, title: run.runId }, shortId(run.runId))),
      clock = readout("elapsed", el2 === null ? "-" : fmtClock(el2), "is-clock"),
      readout("status", statusMark(run.status)),
      model && model.rounds.length ? readout("round", `${model.round}/${model.rounds.length}`) : null,
      readout("tokens", fmtK(run.tokens)),
      readout("errors", String(run.errors || 0), run.errors ? "has-errors" : ""),
      run.expert ? readout("expert", run.expert) : null,
    );
  }

  function drawSeq(model) {
    const items = [];
    const nodes = model.nodes;
    const forkAt = nodes.findIndex((n) => n.id === "adjudicate" || n.id === "synthesize");
    const key = (n) => h("li", {}, h("button", {
      type: "button", class: `seq-key st-${n.state}`, "data-node": n.id, "data-state": n.state,
      "aria-pressed": ctx.S.selection && ctx.S.selection.key === n.key ? "true" : "false",
      onclick: () => ctx.select(runId, n.key),
    }, h("span", { class: "seq-mark", "aria-hidden": "true" }), h("span", { class: "seq-label" }, n.label), n.sub ? h("span", { class: "seq-sub" }, n.sub) : null, h("span", { class: "visually-hidden" }, `, ${n.state}`)));
    if (forkAt !== -1 && nodes.length > forkAt + 2) {
      items.push(...nodes.slice(0, forkAt + 1).map(key));
      items.push(h("li", { class: "fork" }, h("ol", { class: "fork-keys" }, nodes.slice(forkAt + 1).map(key))));
    } else items.push(...nodes.map(key));
    put(seq, ...items);
  }

  function update(run, now = Date.now()) {
    lastRun = run;
    if (!run) return;
    if (run.legacy || (run.isLegacy && !run.events.length)) {
      drawStrip(run, null, now);
      put(seq);
      put(scope, legacyPanel(run));
      note.textContent = "";
      return;
    }
    if (!run.events.length) {
      drawStrip(run, null, now);
      put(seq);
      put(scope, run.loadError
        ? h("p", { class: "error-note" }, `Could not load this run: ${run.loadError}. It may have been pruned; the runs list refreshes every 15 seconds.`)
        : h("div", { class: "skeleton-scope", "aria-label": "Loading capture" }, h("span"), h("span"), h("span")));
      return;
    }
    if (!scope.contains(svg)) put(scope, svg);
    const model = draw(run, now);
    drawStrip(run, model, now);
    drawSeq(model);
    const facts = [];
    if (run.dropped.length) facts.push(`dropped by the circuit breaker: ${run.dropped.join(", ")}`);
    if (run.stopReason) facts.push(`stop reason: ${run.stopReason}`);
    note.textContent = facts.join(". ");
    const sig = `${run.events.length}|${ctx.S.selection ? ctx.S.selection.key : ""}`;
    if (opts.full && sig !== eventsLen) {
      eventsLen = sig;
      put(events, h("summary", {}, `Event table `, h("span", { class: "count" }, `${run.events.length} events`)), eventTable(ctx, run));
    }
  }

  return {
    el,
    update,
    /** redraw false: advance only the elapsed readout (reduced motion). */
    tick(now, redraw = true) {
      if (!lastRun || lastRun.status !== "running") return;
      if (redraw) return update(lastRun, now);
      const el2 = elapsedOf(lastRun, now);
      if (clock && el2 !== null) clock.querySelector("dd").textContent = fmtClock(el2);
    },
  };
}

function legacyPanel(run) {
  const rec = run.legacy || {};
  const ops = Array.isArray(rec.opinions) ? rec.opinions : [];
  return h("div", { class: "legacy" },
    h("p", { class: "legacy-head" }, "Summary only. This run was recorded by the session store before the run journal existed, so it has no step graph."),
    typeof rec.question === "string" ? h("section", { class: "block" }, h("h3", {}, "Question"), h("pre", { class: "payload" }, rec.question)) : null,
    ops.length ? h("table", { class: "grid-table" },
      h("thead", {}, h("tr", {}, h("th", {}, "provider"), h("th", {}, "model"), h("th", {}, "verdict"), h("th", { class: "num" }, "ms"))),
      h("tbody", {}, ops.map((o) => h("tr", {}, h("td", {}, o.provider || "-"), h("td", {}, o.model || "-"), h("td", {}, verdictLabel(o.verdict) || "-"), h("td", { class: "num" }, fmtMs(o.ms)))))) : null,
    rec.converged !== undefined ? h("p", {}, `Converged: ${rec.converged ? "yes" : "no"}. Rounds: ${rec.rounds ?? "-"}.`) : null);
}

// ---------------------------------------------------------------------------- inspector

function contentBlock(ctx, title, text) {
  if (typeof text === "string") return h("section", { class: "block" }, h("h3", {}, title), h("pre", { class: "payload", tabindex: "0" }, text));
  const why = ctx.captureMode() === "content" ? "content not captured for this event" : "content not captured (capture: metadata)";
  return h("section", { class: "block" }, h("h3", {}, title), h("p", { class: "absent" }, why));
}

function facts(pairs) {
  return h("dl", { class: "facts" }, pairs.filter((p) => p[1] !== null && p[1] !== undefined && p[1] !== "").map(([k, v]) => h("div", {}, h("dt", {}, k), h("dd", {}, v))));
}

function callInspector(ctx, run, c) {
  const u = c.usage || {};
  const state = c.endAt === null ? (run.status === "running" ? "running" : "abandoned") : c.isError ? (c.errorKind === "timeout" ? "timeout" : "failed") : "succeeded";
  return [
    h("header", { class: "insp-head" }, h("h2", {}, `${c.provider} ${c.role || "call"}`), h("span", { class: `status-mark st-${state}` }, state)),
    facts([
      ["model", c.model || "pending"], ["effort", c.reasoningEffort], ["round", c.round],
      ["started", run.startedAt ? `+${fmtMs(c.startAt - run.startedAt)}` : fmtTime(c.startAt)],
      ["duration", c.endAt !== null ? fmtMs(c.ms ?? c.endAt - c.startAt) : "running"], ["limit", num(c.timeoutMs) ? fmtMs(c.timeoutMs) : null],
      ["tokens in", num(u.promptTokens) !== null ? fmtInt(u.promptTokens) : null], ["tokens out", num(u.completionTokens) !== null ? fmtInt(u.completionTokens) : null],
      ["tokens", num(u.totalTokens) !== null ? fmtInt(u.totalTokens) : null],
      ["error", c.isError ? c.errorKind || "error" : null], ["error code", c.errorCode], ["verdict", verdictLabel(c.verdict)],
    ]),
    c.criticalIssues && c.criticalIssues.length ? h("section", { class: "block" }, h("h3", {}, "Critical issues"),
      h("ul", { class: "issues" }, c.criticalIssues.map((ci) => h("li", {}, h("span", { class: "kind" }, ci.category || "issue"), ci.description ? ` ${ci.description}` : "")))) : null,
    contentBlock(ctx, "Request", c.request),
    contentBlock(ctx, "Response", c.response),
  ];
}

/** Line diff (LCS); falls back to whole-text replace for very long plans. */
function lineDiff(a, b) {
  const A = a.split("\n");
  const B = b.split("\n");
  if (A.length * B.length > 250000) return [...A.map((t) => ["-", t]), ...B.map((t) => ["+", t])];
  const dp = Array.from({ length: A.length + 1 }, () => new Uint16Array(B.length + 1));
  for (let i = A.length - 1; i >= 0; i--) for (let j = B.length - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0;
  let j = 0;
  while (i < A.length && j < B.length) {
    if (A[i] === B[j]) { out.push([" ", A[i]]); i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) out.push(["-", A[i++]]);
    else out.push(["+", B[j++]]);
  }
  while (i < A.length) out.push(["-", A[i++]]);
  while (j < B.length) out.push(["+", B[j++]]);
  return out;
}

function phaseInspector(ctx, run, phase, round) {
  const calls = run.callOrder.map((id) => run.calls[id]);
  const head = h("header", { class: "insp-head" }, h("h2", {}, round && run.workflow && run.workflow.startsWith("consensus") ? `${phase}, round ${round}` : phase));
  if (phase === "peers" || (run.workflow === "fanout" && (phase === "start" || phase === "join"))) {
    const peers = calls.filter((c) => (run.workflow === "fanout" ? true : c.role === "peer" && (c.round || 1) === round));
    const verdicts = new Map();
    for (const st of run.states) if ((st.round || 1) === round) for (const v of st.verdicts || []) verdicts.set(v.provider, v.verdict);
    return [head, h("p", { class: "insp-lede" }, run.workflow === "fanout" ? `${peers.length} answers.` : `${peers.length} opinions from round ${round}.`),
      h("div", { class: "opinions" }, peers.map((c) => h("article", { class: "opinion" },
        h("h3", {}, c.provider, " ", h("span", { class: "decode-inline" }, verdictLabel(c.verdict || verdicts.get(c.provider)) || (c.isError ? String(c.errorKind || "error").toUpperCase() : c.endAt === null ? "RUNNING" : "OK"))),
        h("p", { class: "opinion-meta" }, [c.model, c.endAt !== null ? fmtMs(c.ms) : null].filter(Boolean).join("  ")),
        typeof c.response === "string" ? h("pre", { class: "payload", tabindex: "0" }, c.response)
          : c.isError ? h("p", { class: "absent" }, `no answer: ${c.errorKind || "error"}${c.errorCode ? ` (${c.errorCode})` : ""}`)
          : h("p", { class: "absent" }, ctx.captureMode() === "content" ? "content not captured for this event" : "content not captured (capture: metadata)"))))];
  }
  if (phase === "revise") {
    const revs = run.arbiter.filter((a) => a.action === "submit_revision");
    const cur = revs.find((a) => (a.round || 1) === round);
    const prevRev = revs.filter((a) => (a.round || 1) < round).pop();
    const before = prevRev ? prevRev.text : run.prompt;
    if (!cur) return [head, h("p", { class: "absent" }, "No revision in this round.")];
    if (typeof cur.text !== "string" || typeof before !== "string") return [head, contentBlock(ctx, "Plan diff", undefined)];
    return [head, h("section", { class: "block" }, h("h3", {}, prevRev ? `Plan diff, round ${prevRev.round} to ${round}` : "Plan diff, original to round 1"),
      h("pre", { class: "payload diff", tabindex: "0" }, lineDiff(before, cur.text).map(([op, t]) => h("span", { class: `diff-line op-${op === "+" ? "add" : op === "-" ? "del" : "same"}` }, `${op} ${t}\n`))))];
  }
  if (phase === "adjudicate" || phase === "blind" || phase === "init") {
    const action = phase === "adjudicate" ? "submit_adjudication" : "record_blind";
    const a = run.arbiter.find((x) => x.action === action && (x.round || 1) === round);
    const arbCalls = calls.filter((c) => (c.role === "arbiter" || c.role === "blind") && (c.round || 1) === round);
    if (arbCalls.length && !a) return callInspector(ctx, run, arbCalls[arbCalls.length - 1]);
    return [head, facts([["verdict", a ? verdictLabel(a.verdict) : null], ["at", a && run.startedAt ? `+${fmtMs(a.at - run.startedAt)}` : null]]),
      contentBlock(ctx, phase === "adjudicate" ? "Adjudication" : "Blind verdict", a ? a.text : undefined)];
  }
  // Terminal or template-only nodes: the run's outcome.
  return [head, facts([["status", run.status], ["stop reason", run.stopReason], ["rounds", run.rounds || null], ["dropped", run.dropped.join(", ")]]),
    ENDED.has(run.status) ? contentBlock(ctx, "Final report", run.finalReport) : h("p", { class: "absent" }, "Not reached yet."),
    contentBlock(ctx, "Prompt", run.prompt)];
}

/** Fill the inspector drawer for one selected segment, trigger or row. */
export function renderInspector(drawer, ctx, run, key) {
  let body;
  if (run.calls[key]) body = callInspector(ctx, run, run.calls[key]);
  else if (key.startsWith("host:")) {
    const segIdx = Number(key.slice(5));
    const acts = run.arbiter;
    const a = acts[segIdx];
    body = a
      ? [h("header", { class: "insp-head" }, h("h2", {}, `arbiter (host) ${a.action.replace(/_/g, " ")}`)), facts([["round", a.round], ["verdict", verdictLabel(a.verdict)], ["at", run.startedAt ? `+${fmtMs(a.at - run.startedAt)}` : null]]), contentBlock(ctx, "Text", a.text)]
      : [h("header", { class: "insp-head" }, h("h2", {}, "arbiter (host)")), h("p", { class: "insp-lede" }, "Claude is writing the next arbiter step in the Claude Code session.")];
  } else {
    const m = /^phase:([^:]+):(\d+)$/.exec(key);
    body = m ? phaseInspector(ctx, run, m[1], Number(m[2])) : [h("p", { class: "absent" }, "Nothing selected.")];
  }
  document.body.classList.toggle("is-wide", /^phase:(peers|start|join):/.test(key));
  put(drawer,
    h("div", { class: "insp-bar" }, h("span", { class: "insp-run" }, `${run.tool || "run"} ${shortId(run.runId)}`),
      h("button", { type: "button", class: "key", onclick: () => ctx.select(null, null), "aria-keyshortcuts": "Escape" }, "Close")),
    h("div", { class: "insp-body" }, body),
  );
}

// ---------------------------------------------------------------------------- route

export function create(ctx, runId) {
  const el = h("section", { class: "view view-run", "data-view": "run" });
  const back = h("p", { class: "crumbs" }, h("a", { href: "#/runs" }, "Runs"), ` / ${runId}`);
  const cap = createCapture(ctx, runId, { full: true });
  el.append(back, cap.el);
  ctx.ensureLoaded(runId);
  return {
    el,
    update() {
      cap.update(ctx.S.runs[runId]);
    },
    tick: (now, redraw) => cap.tick(now, redraw),
    runIds: () => [runId],
  };
}
