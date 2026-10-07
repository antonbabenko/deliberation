// graph.js - the run timeline. `graphModel` (pure, node-testable) derives per-provider
// lanes of calls, phase markers and verdicts from a reduced run; `renderGraph` draws it
// into an <svg>.

import { s, fmtMs, verdictLabel, num, providerLabel } from "./dom.js";

const ENDED = new Set(["done", "converged", "unresolved", "error"]);
const PHASE_ORDER = ["init", "request", "start", "blind", "peers", "adjudicate", "synthesize", "revise", "converged", "unresolved", "done"];
const HOST_OPENS = new Set(["init", "adjudicate", "revise"]);
const KNOWN_INKS = { codex: 1, gpt: 1, gemini: 2, grok: 3 };

const orderOf = (phase) => {
  const i = PHASE_ORDER.indexOf(phase);
  return i === -1 ? PHASE_ORDER.length : i;
};
const isConsensus = (wf) => wf === "consensus" || wf === "consensus-step";
const callsOf = (run) => (run.callOrder || []).map((id) => run.calls[id]).filter(Boolean);
const roundOf = (v) => (num(v) !== null && v > 0 ? v : 1);

/** The ink slot (1-5) for a provider channel; stable per name. */
export function inkOf(provider) {
  const base = String(provider || "").split(":")[0];
  if (KNOWN_INKS[base]) return KNOWN_INKS[base];
  let hsh = 0;
  for (const ch of String(provider || "")) hsh = (hsh * 31 + ch.charCodeAt(0)) >>> 0;
  return 4 + (hsh % 2);
}

/** Node/segment state of one provider call. */
export function callState(c, run) {
  if (c.endAt === null || c.endAt === undefined) {
    if (run.status === "running") return "running";
    return run.status === "abandoned" ? "abandoned" : "failed";
  }
  if (c.isError) return c.errorKind === "timeout" ? "timeout" : "failed";
  return "succeeded";
}

/** Earliest entry per (phase, round), from explicit states plus what calls and arbiter events imply. */
function phaseEntries(run) {
  const wf = run.workflow;
  const hasSynth = run.states.some((st) => st.state === "synthesize");
  const map = new Map();
  const add = (phase, round, at) => {
    if (!phase || num(at) === null) return;
    const key = `${phase}@${round}`;
    const cur = map.get(key);
    if (!cur || at < cur.at) map.set(key, { phase, round, at });
  };
  for (const st of run.states) add(st.state, roundOf(st.round), st.at);
  if (isConsensus(wf)) {
    for (const c of callsOf(run)) {
      const r = roundOf(c.round);
      if (c.role === "peer") add("peers", r, c.startAt);
      else if (c.role === "blind") add("blind", r, c.startAt);
      else if (c.role === "arbiter") add(hasSynth ? "synthesize" : "adjudicate", r, c.startAt);
    }
    for (const a of run.arbiter) {
      const r = roundOf(a.round);
      if (a.action === "record_blind") add("blind", r, a.at);
      else if (a.action === "submit_adjudication") add("adjudicate", r, a.at);
      else if (a.action === "submit_revision") add("revise", r, a.at);
    }
  }
  const list = [...map.values()].sort((a, b) => a.at - b.at || a.round - b.round || orderOf(a.phase) - orderOf(b.phase));
  const revisedAt = new Map(run.arbiter.filter((a) => a.action === "submit_revision").map((a) => [roundOf(a.round), a.at]));
  list.forEach((e, i) => {
    const next = list[i + 1];
    let exit = next ? next.at : ENDED.has(run.status) ? run.endedAt ?? run.lastAt : null;
    if (e.phase === "revise" && revisedAt.has(e.round)) exit = revisedAt.get(e.round);
    e.exit = exit;
  });
  return list;
}

/** Round spans for the consensus workflows; [] for single and fan-out. */
function roundsOf(run, now) {
  if (!isConsensus(run.workflow)) return [];
  let max = 1;
  const minAt = new Map();
  const note = (r, at) => {
    const rr = roundOf(r);
    max = Math.max(max, rr);
    if (num(at) !== null && (!minAt.has(rr) || at < minAt.get(rr))) minAt.set(rr, at);
  };
  for (const st of run.states) note(st.round, st.at);
  for (const c of callsOf(run)) note(c.round, c.startAt);
  for (const a of run.arbiter) note(a.round, a.at);
  const revisedAt = new Map(run.arbiter.filter((a) => a.action === "submit_revision").map((a) => [roundOf(a.round), a.at]));
  const end = run.status === "running" ? Math.max(now, run.lastAt) : run.endedAt ?? run.lastAt;
  const out = [];
  for (let r = 1; r <= max; r++) {
    const t0 = r === 1 ? run.startedAt || minAt.get(1) || run.lastAt : revisedAt.get(r - 1) ?? minAt.get(r) ?? out[r - 2].t1;
    out.push({ n: r, t0, t1: end });
    if (r > 1) out[r - 2].t1 = t0;
  }
  return out;
}

function templateFor(run, round, entries) {
  const wf = run.workflow;
  const entered = (p) => entries.some((e) => e.phase === p && e.round === round);
  const hasSynth = run.states.some((st) => st.state === "synthesize");
  const terminal = run.status === "unresolved" ? "unresolved" : hasSynth ? "done" : "converged";
  if (wf === "consensus-step") return [...(round === 1 ? ["init"] : []), "blind", "peers", "adjudicate", terminal, "revise"];
  if (hasSynth) return [...(entered("blind") ? ["blind"] : []), "peers", "synthesize", "done"];
  return [...(entered("blind") ? ["blind"] : []), "peers", "adjudicate", terminal, "revise"];
}

function phaseNodes(run, round, lastRound, entries) {
  const calls = callsOf(run);
  const hostVerdict = new Map(run.arbiter.filter((a) => a.action === "submit_adjudication").map((a) => [roundOf(a.round), a.verdict]));
  return templateFor(run, round, entries).map((phase) => {
    const key = `phase:${phase}:${round}`;
    if (phase === "converged" || phase === "unresolved" || phase === "done") {
      const isLast = round === lastRound && ENDED.has(run.status);
      let state = "pending";
      if (isLast) state = run.status === "unresolved" || run.status === "error" ? "failed" : "succeeded";
      return { id: phase, label: phase, state, key, round, at: isLast ? run.endedAt : null, sub: isLast && run.stopReason ? run.stopReason : null };
    }
    const e = entries.find((x) => x.phase === phase && x.round === round);
    let state = "pending";
    if (e) {
      if (e.exit !== null && e.exit !== undefined) state = run.status === "error" && e.exit === run.endedAt ? "failed" : "succeeded";
      else state = run.status === "running" ? "running" : run.status === "abandoned" ? "abandoned" : "failed";
    } else if (phase === "peers" && round === lastRound && run.stopReason === "all-providers-circuit-broken") {
      state = "broken";
    }
    // consensus-step journals "blind" when the host records it, so its span is not the writing time.
    let sub = e && e.exit && !(phase === "blind" && run.workflow === "consensus-step") ? fmtMs(e.exit - e.at) : null;
    if (phase === "peers" && e) {
      const pc = calls.filter((c) => c.role === "peer" && roundOf(c.round) === round);
      if (pc.some((c) => c.endAt === null)) state = run.status === "running" ? "running" : run.status === "abandoned" ? "abandoned" : state;
      else if (pc.length && pc.every((c) => c.isError)) state = pc.every((c) => c.errorKind === "timeout") ? "timeout" : "failed";
      if (pc.length) sub = `${pc.filter((c) => c.endAt !== null && !c.isError).length}/${pc.length} ok`;
    }
    if (phase === "adjudicate" && hostVerdict.get(round)) sub = verdictLabel(hostVerdict.get(round));
    return { id: phase, label: phase, state, key, round, at: e ? e.at : null, sub };
  });
}

function flatNodes(run) {
  const calls = callsOf(run);
  const ended = ENDED.has(run.status);
  const endState = run.status === "error" ? "failed" : run.status === "abandoned" ? "abandoned" : ended ? "succeeded" : "pending";
  if (run.workflow === "fanout") {
    const names = [...new Set([...run.providers, ...calls.map((c) => c.provider)])];
    const branches = names.map((p) => {
      const mine = calls.filter((c) => c.provider === p);
      const last = mine[mine.length - 1];
      // A provider the panel listed but no call ever reached (the server's `undispatched`) is
      // skipped, not failed: nothing was asked of it.
      const skipped = !last && (run.undispatched || []).includes(p);
      let state = last ? callState(last, run) : skipped ? "skipped" : run.status === "abandoned" ? "abandoned" : ended ? "failed" : "pending";
      if (run.dropped.includes(p)) state = "broken";
      const sub = last && last.ms !== null ? fmtMs(last.ms) : skipped ? "not dispatched" : null;
      return { id: p, label: providerLabel(p), state, key: last ? last.callId : `phase:${p}:1`, round: 1, at: last ? last.startAt : null, sub };
    });
    return [
      { id: "start", label: "start", state: "succeeded", key: "phase:start:1", round: 1, at: run.startedAt, sub: null },
      ...branches,
      { id: "join", label: "join", state: endState, key: "phase:join:1", round: 1, at: ended ? run.endedAt : null, sub: null },
    ];
  }
  const call = calls[calls.length - 1];
  const failed = run.status === "error" || (call && call.isError && ended);
  return [
    { id: "request", label: "request", state: "succeeded", key: "phase:request:1", round: 1, at: run.startedAt, sub: null },
    {
      id: "provider", label: providerLabel((call && call.provider) || run.providers[0] || "provider"),
      state: call ? callState(call, run) : run.status === "running" ? "pending" : endState,
      key: call ? call.callId : "phase:provider:1", round: 1, at: call ? call.startAt : null, sub: call && call.model ? call.model : null,
    },
    { id: "result", label: "result", state: failed ? "failed" : endState, key: "phase:result:1", round: 1, at: ended ? run.endedAt : null, sub: null },
  ];
}

function decodeOf(c, verdicts) {
  if (c.endAt === null) return null;
  if (c.isError) return String(c.errorKind || "error").toUpperCase().replace(/_/g, "-");
  return verdictLabel(c.verdict) || verdictLabel(verdicts.get(`${c.provider}@${roundOf(c.round)}`)) || "OK";
}

/** The host model's working spans between its arbiter actions (consensus-step). */
function hostSegments(run) {
  const marks = [];
  for (const st of run.states) if (HOST_OPENS.has(st.state)) marks.push({ open: true, at: st.at, round: roundOf(st.round), phase: st.state });
  for (const a of run.arbiter) marks.push({ open: false, at: a.at, round: roundOf(a.round), ev: a });
  marks.sort((a, b) => a.at - b.at || (a.open ? 1 : -1));
  const segs = [];
  let open = null;
  const decode = { record_blind: "BLIND", submit_adjudication: "ADJUDICATED", submit_revision: "REVISED" };
  for (const m of marks) {
    if (m.open) {
      if (!open) open = m;
      continue;
    }
    const a = m.ev;
    segs.push({
      key: `host:${segs.length}`, kind: "host", t0: open ? open.at : a.at, t1: a.at, state: "succeeded",
      round: roundOf(a.round), decode: verdictLabel(a.verdict) || decode[a.action] || "OK", ceiling: null, arbiter: a,
      label: a.action.replace(/_/g, " "),
    });
    open = a.action === "submit_revision" ? { at: a.at, round: roundOf(a.round) + 1 } : null;
  }
  if (open && (run.status === "running" || run.status === "abandoned")) {
    segs.push({
      key: `host:${segs.length}`, kind: "host", t0: open.at, t1: null, state: run.status === "running" ? "running" : "abandoned",
      round: open.round, decode: null, ceiling: null, arbiter: null, label: "host working",
    });
  }
  return segs;
}

function channelsOf(run, health) {
  const wf = run.workflow;
  const list = [];
  const byId = new Map();
  const ch = (id, label, kind, provider) => {
    if (!byId.has(id)) {
      const c = { id, label:providerLabel(label), kind, provider, ink: kind === "host" ? "host" : inkOf(provider), model: null, effort: null, flags: [], segments: [] };
      byId.set(id, c);
      list.push(c);
    }
    return byId.get(id);
  };
  if (wf === "consensus-step") ch("host", "arbiter (host)", "host", null).segments.push(...hostSegments(run));
  for (const p of run.providers) ch(p, p, "provider", p);
  const verdicts = new Map();
  for (const st of run.states) {
    for (const v of Array.isArray(st.verdicts) ? st.verdicts : []) {
      if (v && v.provider) verdicts.set(`${v.provider}@${roundOf(st.round)}`, v.verdict);
    }
  }
  for (const c of callsOf(run)) {
    const arb = wf === "consensus" && (c.role === "arbiter" || c.role === "blind");
    const channel = arb ? ch(`arbiter:${c.provider}`, `arbiter ${providerLabel(c.provider)}`, "arbiter", c.provider) : ch(c.provider, c.provider, "provider", c.provider);
    if (c.model) channel.model = c.model;
    if (c.reasoningEffort) channel.effort = c.reasoningEffort;
    channel.segments.push({
      key: c.callId, kind: "call", t0: c.startAt, t1: c.endAt, state: callState(c, run), round: roundOf(c.round),
      decode: decodeOf(c, verdicts), ceiling: num(c.timeoutMs) ? c.startAt + c.timeoutMs : null, call: c,
      label: `${providerLabel(c.provider)} ${c.role || "call"}`,
    });
  }
  const hp = new Map(((health && health.providers) || []).map((p) => [p.name, p]));
  for (const c of list) {
    if (c.kind === "host") continue;
    if (run.dropped.includes(c.provider)) c.flags.push("DROPPED");
    if (!c.segments.length && (run.undispatched || []).includes(c.provider)) c.flags.push("SKIPPED");
    const h = hp.get(c.provider);
    if (h && h.needsLogin) c.flags.push("LOGIN");
    else if (h && h.ok === false) c.flags.push("UNAVAILABLE");
  }
  return list;
}

/**
 * GraphModel for one run.
 * @param {any} run  a reduced run (app.js)
 * @param {{now?: number, round?: number|null, health?: any}} [opts]
 */
export function graphModel(run, opts = {}) {
  const now = num(opts.now) ?? Date.now();
  const live = run.status === "running";
  const rounds = roundsOf(run, now);
  const lastRound = rounds.length || 1;
  const round = rounds.length ? Math.min(Math.max(1, opts.round || lastRound), lastRound) : undefined;
  const entries = isConsensus(run.workflow) ? phaseEntries(run) : [];
  const nodes = isConsensus(run.workflow) ? phaseNodes(run, round, lastRound, entries) : flatNodes(run);
  let t0;
  let t1;
  if (rounds.length) ({ t0, t1 } = rounds[round - 1]);
  else {
    t0 = run.startedAt || run.lastAt;
    t1 = live ? Math.max(now, run.lastAt) : run.endedAt ?? run.lastAt;
  }
  const following = live && (!rounds.length || round === lastRound);
  const span = Math.max(1000, (t1 || 0) - (t0 || 0));
  return {
    workflow: run.workflow || "single",
    runStart: run.startedAt || t0,
    round,
    rounds,
    t0,
    t1: t0 + span * (following ? 1.06 : 1.02),
    now,
    live: following,
    nodes,
    // Health describes providers now, so it marks live runs only, never history.
    channels: channelsOf(run, live ? opts.health : null),
  };
}

// ---------------------------------------------------------------------------- render

const CHAR = 6.7; // advance of the 11px monospace face, px
const TRACE_H = 28;
const DECODE_H = 18;
const LANE = 64; // trace + decode + room for four 13px gutter rows
const ROW = 13;
const PAD = 12; // inner left margin of the scope face
let uid = 0;

const tick = ms => `+${fmtMs(ms)}`;

const SEVERITY = ["succeeded", "skipped", "pending", "running", "abandoned", "broken", "timeout", "failed"];

/** The state a merged marker shows: the most severe of its members. */
export function worstState(states) {
  return states.reduce((w, st) => (SEVERITY.indexOf(st) > SEVERITY.indexOf(w) ? st : w), "succeeded");
}

/**
 * Merge trigger points closer than `gap` px into one cluster. Input sorted by x.
 * @param {{x: number, node: any}[]} points
 * @param {number} [gap]
 * @returns {{x: number, nodes: any[], state: string, label: string}[]}
 */
export function clusterTriggers(points, gap = 18) {
  const out = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && p.x - last.xEnd < gap) {
      last.nodes.push(p.node);
      last.xEnd = p.x;
    } else out.push({ x: p.x, xEnd: p.x, nodes: [p.node] });
  }
  return out.map((c) => ({ x: c.x, nodes: c.nodes, ...clusterFace(c.nodes) }));
}

function clusterFace(nodes) {
  const names = nodes.map((n) => n.label);
  const joined = names.join(", ");
  return { state: worstState(nodes.map((n) => n.state)), label: names.length > 1 && joined.length > 22 ? `${names[0]} +${names.length - 1}` : joined };
}

/**
 * Lay trigger clusters out on two label rows at the current pixel width. A cluster
 * whose label fits in neither row joins the cluster before it, so no label overlaps.
 * @param {{x: number, node: any}[]} points  sorted by x
 * @param {{x1: number, charW?: number, gap?: number}} opts  x1: right edge of the plot
 * @returns {{x: number, nodes: any[], state: string, label: string, row: number, lx: number, w: number}[]}
 */
export function layoutTriggers(points, opts) {
  const charW = opts.charW || CHAR;
  const rows = [-Infinity, -Infinity];
  const out = [];
  const place = (c) => {
    const w = c.label.length * charW + 6;
    const lx = c.x - 4 + w > opts.x1 + 8 ? c.x + 4 - w : c.x - 4;
    return { w, lx };
  };
  for (const c of clusterTriggers(points, opts.gap)) {
    const { w, lx } = place(c);
    const row = rows[0] <= lx - 4 ? 0 : rows[1] <= lx - 4 ? 1 : -1;
    const prev = out[out.length - 1];
    if (row === -1 && prev) {
      prev.nodes.push(...c.nodes);
      Object.assign(prev, clusterFace(prev.nodes));
      Object.assign(prev, place(prev));
      rows[prev.row] = prev.lx + prev.w;
      continue;
    }
    const at = Math.max(row, 0);
    rows[at] = lx + w;
    out.push({ ...c, row: at, lx, w });
  }
  return out;
}

const BOUNDARY = /[\s:(\-]/;

/** Cut `text` to `max` code points at a word boundary, marking the cut with "...". */
export function ellipsize(text, max) {
  const cp = Array.from(text);
  if (cp.length <= max) return text;
  let cut = max - 3;
  while (cut > 3 && !BOUNDARY.test(cp[cut])) cut--;
  if (cut <= 3) cut = max - 3;
  return `${cp.slice(0, cut).join("").replace(/[\s:(\-]+$/, "")}...`;
}

/** Cut at exactly `max` code points, for ids where a word boundary would drop the useful part. */
export function clip(text, max) {
  const cp = Array.from(text);
  return cp.length <= max ? text : `${cp.slice(0, Math.max(1, max - 3)).join("")}...`;
}

/** Split an id into at most two rows of `max` code points, after the last hyphen or space that fits. */
export function splitId(text, max) {
  const cp = Array.from(text);
  if (cp.length <= max) return [text];
  let cut = max;
  while (cut > 3 && cp[cut - 1] !== "-" && cp[cut - 1] !== " ") cut--;
  if (cut <= 3) cut = max;
  return [cp.slice(0, cut).join("").trimEnd(), clip(cp.slice(cut).join("").trimStart(), max)];
}

/** Split `text` into at most two lines of `max` code points at word boundaries. */
export function wrap2(text, max) {
  const cp = Array.from(text);
  if (cp.length <= max) return [text];
  let cut = max;
  while (cut > 3 && !BOUNDARY.test(cp[cut])) cut--;
  if (cut <= 3) return [ellipsize(text, max)];
  const head = cp.slice(0, cp[cut] === " " ? cut : cut + (cp[cut] === "(" ? 0 : 1)).join("").trimEnd();
  return [head, ellipsize(cp.slice(Array.from(head).length).join("").trimStart(), max)];
}

const SHORT = { APPROVE: "APV", REQ_CHANGES: "REQ", REJECT: "REJ", TIMEOUT: "TMO", "RATE-LIMIT": "RL", NETWORK: "NET", ERROR: "ERR", EMPTY: "EMP", ADJUDICATED: "ADJ", REVISED: "REV", BLIND: "BLD" };
/** The short form of a decode label, for segments too narrow for the full one. */
export const shortDecode = (label) => SHORT[label] || label.slice(0, 3);

function hexagon(xa, xb, y, hgt) {
  const n = Math.min(4, (xb - xa) / 2);
  const m = y + hgt / 2;
  return `${xa},${m} ${xa + n},${y} ${xb - n},${y} ${xb},${m} ${xb - n},${y + hgt} ${xa + n},${y + hgt}`;
}

/** Update geometry/text in place so a pressed SVG control survives a live redraw. */
function patchControl(el, draft) {
  for (const attr of [...el.attributes]) if (!draft.hasAttribute(attr.name)) el.removeAttribute(attr.name);
  for (const attr of draft.attributes) el.setAttribute(attr.name, attr.value);
  const children=[...draft.childNodes];
  children.forEach((next,i)=>{
    const prev=el.childNodes[i];
    if(prev&&prev.nodeType===next.nodeType&&prev.nodeName===next.nodeName) {
      if(next.nodeType===3)prev.nodeValue=next.nodeValue;
      else patchControl(prev,next);
    }else if(prev)el.replaceChild(next,prev);
    else el.append(next);
  });
  while(el.childNodes.length>children.length)el.lastChild.remove();
}

/** Keyboard + click activation for an SVG control, retaining its DOM identity. */
function control(el, label, activate, extraKeys, previous) {
  el.setAttribute("tabindex", "0");
  el.setAttribute("aria-label", label);
  el.append(s("title", { text: label }));
  if(previous&&previous.nodeName===el.nodeName) {
    patchControl(previous,el);
    previous.__activate=activate;
    previous.__extraKeys=extraKeys;
    return previous;
  }
  el.__activate=activate;
  el.__extraKeys=extraKeys;
  el.addEventListener("click", (e) => {
    if (e.defaultPrevented) return;
    el.__activate();
  });
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      el.__activate();
    } else if (el.__extraKeys) el.__extraKeys(e);
  });
  return el;
}

/**
 * Draw `model` into `svg`. Interaction hooks ride on `model.ui`:
 * `{selected, cursors: {a, b}, onSelect(key), onRound(n), onCursor(a, b)}`.
 * @param {SVGSVGElement} svg
 * @param {"single"|"fanout"|"consensus-step"|"consensus"} workflow
 * @param {ReturnType<typeof graphModel> & {ui?: any}} model
 */
export function renderGraph(svg, workflow, model) {
  const ui = model.ui || {};
  const previousControls=new Map([...svg.querySelectorAll('[data-key]')].map(el=>[el.getAttribute('data-key'),el]));
  const bindControl=(el,label,activate,extraKeys)=>control(el,label,activate,extraKeys,previousControls.get(el.getAttribute('data-key')));
  const active = document.activeElement;
  const focusKey = active && svg.contains(active) && active.matches(":focus-visible") ? active.getAttribute("data-key") : null;
  const id = svg.dataset.uid || (svg.dataset.uid = `g${++uid}`);
  const W = Math.max(300, Math.floor((svg.parentElement && svg.parentElement.clientWidth) || 960));
  const narrow = W < 640;
  const G = narrow ? 118 : 212;
  const x0 = G;
  const x1 = W - (narrow ? 10 : 18);
  const span = Math.max(1, model.t1 - model.t0);
  const tx = (t) => x0 + ((Math.min(Math.max(t, model.t0), model.t1) - model.t0) / span) * (x1 - x0);
  const inWin = (t) => t >= model.t0 && t <= model.t1;
  const rel = (t) => t - model.runStart;
  const kids = [];

  kids.push(s("defs", {}, s("pattern", { id: `${id}-hatch`, width: 5, height: 5, patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)" },
    s("line", { x1: 0, y1: 0, x2: 0, y2: 5, class: "hatch" }))));

  let y = 6;
  // Memory-position bar: the whole run, one tab per round. The selected round is the window.
  if (model.rounds.length) {
    const r0 = model.rounds[0].t0;
    const rspan = Math.max(1, model.rounds[model.rounds.length - 1].t1 - r0);
    const rx = (t) => x0 + ((t - r0) / rspan) * (x1 - x0);
    kids.push(s("text", { x: PAD, y: y + 17, class: "gutter-label" }, narrow ? "ROUND" : "ROUNDS"));
    kids.push(s("line", { x1: x0, x2: x1, y1: y + 13, y2: y + 13, class: "memory-track" }));
    const tablist = s("g", { role: "tablist", "aria-label": "Rounds" });
    kids.push(tablist);
    for (const r of model.rounds) {
      const xa = rx(r.t0);
      const xb = Math.max(xa + 18, rx(r.t1));
      const sel = r.n === model.round;
      const wide = xb - xa;
      const text = wide > 70 ? `R${r.n} ${fmtMs(r.t1 - r.t0)}` : `R${r.n}`;
      let g = s("g", { class: `round-tab${sel ? " is-selected" : ""}`, role: "tab", "aria-selected": sel ? "true" : "false", "data-key": `round:${r.n}`, "data-round": r.n },
        s("rect", { x: xa, y: y + 1, width: wide, height: 22, class: "tab-hit" }),
        s("rect", { x: xa + 1, y: y + 9, width: wide - 2, height: 8, class: "tab-bar" }),
        wide >= 18 ? s("text", { x: xa + 3, y: y + 7, class: "tab-label" }, text) : null);
      g=bindControl(g, `Round ${r.n}, ${fmtMs(r.t1 - r.t0)}${sel ? ", selected" : ""}`, () => ui.onRound && ui.onRound(r.n), (e) => {
        if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
          e.preventDefault();
          const n = r.n + (e.key === "ArrowRight" ? 1 : -1);
          if (n >= 1 && n <= model.rounds.length && ui.onRound) ui.onRound(n, true);
        }
      });
      tablist.append(g);
    }
    y += 32;
  }

  // Time ruler: 10 divisions, run-relative labels, one trigger per phase entry.
  const rulerTop = y;
  const base = y + 46;
  kids.push(s("text", { x: PAD, y: base - 4, class: "gutter-label" }, "TRIG"));
  const divs = Math.max(4, Math.min(10, Math.floor((x1 - x0) / 72)));
  // The T tag and cursor flags sit on the tick-label row; a tick label they would cover is left out.
  const cur = ui.cursors || {};
  const tagged = inWin(model.runStart) && model.runStart > model.t0 - 1;
  const marks = [];
  if (tagged) marks.push(tx(model.runStart));
  for (const w of ["a", "b"]) if (num(cur[w]) !== null && inWin(cur[w])) marks.push(tx(cur[w]));
  for (let i = 0; i <= divs; i++) {
    const x = x0 + ((x1 - x0) * i) / divs;
    kids.push(s("line", { x1: x, x2: x, y1: base - 6, y2: base, class: "tick" }));
    if (i < divs) {
      for (let j = 1; j < 5; j++) {
        const xm = x + ((x1 - x0) / divs) * (j / 5);
        kids.push(s("line", { x1: xm, x2: xm, y1: base - 3, y2: base, class: "tick minor" }));
      }
    }
    const label = tick(rel(model.t0 + (span * i) / divs));
    const anchor = i === 0 ? "start" : i === divs ? "end" : "middle";
    const lw = label.length * CHAR;
    const la = anchor === "start" ? x : anchor === "end" ? x - lw : x - lw / 2;
    if (!marks.some((m) => m + 8 > la && m - 8 < la + lw)) kids.push(s("text", { x, y: base + 13, class: "tick-label", "text-anchor": anchor }, label));
  }
  kids.push(s("line", { x1: x0, x2: x1, y1: base, y2: base, class: "ruler" }));
  const timed = model.nodes.filter((n) => num(n.at) !== null && inWin(n.at)).sort((a, b) => a.at - b.at);
  // Triggers within a few px of each other would stack unreadably: one marker per cluster,
  // coloured by its worst member, with an empty element per member for tests and assistive tech.
  // Run start (T) and, on a live capture, the now line are drawn distinct from phase triggers.
  if (tagged) {
    const xt = tx(model.runStart);
    kids.push(s("rect", { x: xt - 6, y: base + 2, width: 12, height: 12, class: "t-tag" }));
    kids.push(s("text", { x: xt, y: base + 11.5, class: "t-tag-text", "text-anchor": "middle" }, "T"));
  }
  for (const c of layoutTriggers(timed.map((n) => ({ x: tx(n.at), node: n })), { x1 })) {
    const n = c.nodes[0];
    const x = c.x;
    const { lx, row } = c;
    const single = c.nodes.length === 1;
    let g = s("g", { class: `trig st-${c.state}`, "data-key": `trig:${n.key}`, role: "button", ...(single ? { "data-node": n.id, "data-state": n.state } : { "data-cluster": c.nodes.length }) },
      s("rect", { x: x - 7, y: rulerTop + 2, width: 14, height: base - rulerTop - 2, class: "trig-hit" }),
      s("path", { d: `M${x - 5},${base - 18} L${x + 5},${base - 18} L${x},${base - 10} Z`, class: "trig-mark" }),
      single ? null : s("path", { d: `M${x - 5},${base - 21} L${x + 5},${base - 21}`, class: "trig-stack" }),
      s("text", { x: lx, y: rulerTop + 11 + row * 13, class: "trig-label" }, c.label),
      single ? null : c.nodes.map((m) => s("g", { class: "trig-member", "data-node": m.id, "data-state": m.state })));
    const said = c.nodes.map((m) => `${m.label}${m.round && model.rounds.length ? ` round ${m.round}` : ""}: ${m.state}`).join("; ");
    g=bindControl(g, `${said}, ${tick(rel(n.at))}${single ? "" : `. Opens ${n.label}; the sequence row lists each one.`}`, () => ui.onSelect && ui.onSelect(n.key));
    kids.push(g);
  }
  y = base + 30;

  // Channels.
  const top = y;
  const bottom = top + model.channels.length * LANE;
  const plotH = bottom - top;
  const grid = [];
  for (let i = 0; i <= divs; i++) {
    const x = x0 + ((x1 - x0) * i) / divs;
    grid.push(s("line", { x1: x, x2: x, y1: top - 4, y2: bottom, class: i === 0 || i === divs ? "grat edge" : "grat" }));
  }
  let bg = s("rect", { x: x0, y: top - 4, width: x1 - x0, height: plotH + 4, class: "plot", "data-key": "plot" });
  bg=bindControl(bg, "Capture plot. Drag to place cursors A and B. Arrow keys move cursor A, Shift with arrow keys moves cursor B, Escape clears them.", () => {}, (e) => {
    const step = span / 100;
    const c = { ...(ui.cursors || {}) };
    if (e.key === "Escape") return ui.onCursor && ui.onCursor(null, null);
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const which = e.shiftKey ? "b" : "a";
    const d = e.key === "ArrowRight" ? step : -step;
    const cur = num(c[which]) ?? model.t0 + span / 2;
    c[which] = Math.min(model.t1, Math.max(model.t0, cur + d));
    if (ui.onCursor) ui.onCursor(c.a ?? null, c.b ?? null);
  });
  kids.push(bg, ...grid);

  const hits = [];
  model.channels.forEach((c, i) => {
    const ly = top + i * LANE;
    const hi = ly + 4;
    const lo = ly + TRACE_H - 2;
    // A dropped or unavailable channel draws in the dimmed ink; its label says why.
    const dimmed = c.flags.includes("DROPPED") || c.flags.includes("UNAVAILABLE") || c.flags.includes("SKIPPED");
    const inkCls = dimmed ? "ink-dropped" : `ink-${c.ink}`;
    kids.push(s("line", { x1: x0, x2: x1, y1: lo, y2: lo, class: "lane-rule" }));
    const segs = c.segments
      .map((g) => ({ ...g, end: g.t1 ?? (g.state === "running" ? model.now : g.t0) }))
      .filter((g) => g.end > model.t0 && g.t0 < model.t1)
      .sort((a, b) => a.t0 - b.t0);

    // Gutter: channel key, name (two lines at most), model and effort, then flags and the
    // fault reasons in this window, so a failure is readable even where its decode is short.
    const maxChars = Math.floor((G - PAD - 15 - 6) / CHAR);
    const faults = [...new Set(segs.filter((g) => g.state === "failed" || g.state === "timeout").map((g) => g.decode).filter(Boolean))];
    const flagText = [...c.flags, ...faults].join(" ");
    const modelId = c.model || (c.kind === "host" ? "Claude, in session" : "model pending");
    const meta = [c.model, c.effort].filter(Boolean).join(" ") || modelId;
    // Four rows. The model id always keeps its row(s), split after a hyphen or space so its
    // distinguishing tail stays visible; flags take what is left, then the rest of the model, then effort.
    const oneLine = Array.from(meta).length <= maxChars;
    const nameRows = wrap2(c.label, maxChars);
    const modelRows = oneLine ? [meta] : splitId(modelId, maxChars);
    let free = 4 - nameRows.length - 1;
    const flagRows = flagText && free > 0 ? (free === 1 ? [ellipsize(flagText, maxChars)] : wrap2(flagText, maxChars)) : [];
    free -= flagRows.length;
    const shownModel = modelRows.length > 1 && free <= 0 ? [clip(modelId, maxChars)] : modelRows;
    free -= shownModel.length - 1;
    const lines = [
      ...nameRows.map((t) => [t, `ch-name${dimmed ? " is-dropped" : ""}`]),
      // SKIPPED is not a fault (nothing was asked), so it is not written in the fault ink.
      ...flagRows.map((t) => [t, c.flags.includes("SKIPPED") ? "ch-flag is-quiet" : "ch-flag"]),
      ...shownModel.map((t) => [t, "ch-meta"]),
      ...(!oneLine && c.effort && free > 0 ? [[clip(c.effort, maxChars), "ch-meta"]] : []),
    ];
    kids.push(s("line", { x1: PAD, x2: PAD + 10, y1: hi + 6, y2: hi + 6, class: `ch-key ${inkCls}` }));
    const gutter = s("text", { class: "ch-gutter" }, s("title", { text: [c.label, meta, flagText].filter(Boolean).join(", ") }));
    lines.forEach(([t, cls], k) => gutter.append(s("tspan", { x: PAD + 15, y: hi + 10 + k * ROW, class: cls }, t)));
    kids.push(gutter);

    // Trace: low baseline, high while a call runs. Faults and timeouts draw on top.
    const edge = model.live ? tx(model.now) : x1;
    let d = `M${x0},${lo}`;
    let high = false;
    for (const g of segs) {
      if (g.state === "failed" || g.state === "timeout") continue;
      const xa = tx(g.t0);
      const xb = Math.max(xa + 1, tx(g.end));
      d += ` L${xa},${lo} L${xa},${hi} L${xb},${hi}`;
      // A running call is still high at the live edge; it has not fallen yet.
      if (g.state === "running" && model.live) { high = true; break; }
      d += ` L${xb},${lo}`;
    }
    if (!high) d += ` L${Math.max(x0, edge)},${lo}`;
    kids.push(s("path", { d, class: `trace ${inkCls}` }));
    for (const g of segs) {
      const xa = tx(g.t0);
      const xb = Math.max(xa + 3, tx(g.end));
      const dim = model.round && g.round !== model.round ? " is-other-round" : "";
      if (g.state === "failed") {
        kids.push(s("rect", { x: xa, y: hi, width: xb - xa, height: lo - hi, class: "fault-fill", fill: `url(#${id}-hatch)` }));
        kids.push(s("path", { d: `M${xa},${lo} L${xa},${hi} L${xb},${hi} L${xb},${lo}`, class: `fault${dim}` }));
        kids.push(s("path", { d: `M${xb - 4},${hi - 4} L${xb + 4},${hi + 4} M${xb - 4},${hi + 4} L${xb + 4},${hi - 4}`, class: "fault-x" }));
      } else if (g.state === "timeout") {
        kids.push(s("path", { d: `M${xa},${lo} L${xa},${hi} L${xb},${hi} L${xb},${lo}`, class: `tmo${dim}` }));
      } else if (g.state === "abandoned") {
        kids.push(s("path", { d: `M${xb},${hi} L${xb},${lo}`, class: "abandoned-edge" }));
      }
      if (g.ceiling !== null && (g.state === "running" || g.state === "timeout") && inWin(g.ceiling)) {
        const xc = tx(g.ceiling);
        kids.push(s("line", { x1: xc, x2: xc, y1: hi - 4, y2: lo + 2, class: "ceiling" }));
        kids.push(s("text", { x: xc - 3, y: hi - 5, class: "ceiling-label", "text-anchor": "end" }, "LIMIT"));
      }
      if (g.state === "running" && model.live) kids.push(s("rect", { x: xb - 1.5, y: hi - 1.5, width: 3, height: 3, class: `live-edge ${inkCls}` }));
      // Decode row.
      const dy = ly + TRACE_H + 3;
      // A segment that only begins in the right-edge headroom has no room for a decode.
      if (g.decode && xa < x1 - 14) {
        const tone = /^(APPROVE|OK)$/.test(g.decode) ? "ok" : g.decode === "REQ_CHANGES" ? "warn" : g.decode === "REJECT" ? "bad" : g.kind === "host" ? "neutral" : "err";
        // Never a blank box: the full label, else its short form with the box widened to fit it.
        const text = g.decode.length * CHAR + 10 <= xb - xa ? g.decode : shortDecode(g.decode);
        const xe = Math.min(Math.max(xb, xa + text.length * CHAR + 10), W - 2);
        kids.push(s("polygon", { points: hexagon(xa, xe, dy, DECODE_H - 2), class: `decode tone-${tone}${dim}` }));
        kids.push(s("text", { x: (xa + xe) / 2, y: dy + 12, class: `decode-text tone-${tone}${dim}`, "text-anchor": "middle" }, text));
      }
      const hitW = Math.max(10, xb - xa);
      let hit = s("rect", {
        x: xa - (hitW - (xb - xa)) / 2, y: ly, width: hitW, height: TRACE_H + DECODE_H + 2,
        class: `hit${ui.selected === g.key ? " is-selected" : ""}`, "data-key": g.key, role: "button",
      });
      const len = g.t1 !== null && g.t1 !== undefined ? fmtMs(g.t1 - g.t0) : "running";
      hit=bindControl(hit, `${g.label}${model.rounds.length ? ` round ${g.round}` : ""}: ${g.state}, ${len}${g.decode ? `, ${g.decode}` : ""}`, () => ui.onSelect && ui.onSelect(g.key));
      hits.push(hit);
    }
  });
  kids.push(...hits);

  if (model.live && inWin(model.now)) {
    const xn = tx(model.now);
    kids.push(s("line", { x1: xn, x2: xn, y1: base + 2, y2: bottom, class: "now-line" }));
    kids.push(s("text", { x: xn - 4, y: bottom - 4, class: "now-label", "text-anchor": "end" }, "NOW"));
  }

  // Cursors A and B with a delta readout.
  for (const which of ["a", "b"]) {
    const t = num(cur[which]);
    if (t === null || !inWin(t)) continue;
    const x = tx(t);
    kids.push(s("line", { x1: x, x2: x, y1: base - 4, y2: bottom, class: `cursor cursor-${which}` }));
    kids.push(s("rect", { x: x - 6, y: base - 2, width: 12, height: 12, class: `cursor-tag cursor-${which}` }));
    kids.push(s("text", { x, y: base + 7.5, class: "cursor-tag-text", "text-anchor": "middle" }, which.toUpperCase()));
  }
  const fy = bottom + 16;
  const perDiv = fmtMs(span / divs);
  kids.push(s("text", { x: PAD, y: fy, class: "gutter-label" }, `${perDiv}/div`));
  const a = num(cur.a);
  const b = num(cur.b);
  const parts = [];
  if (a !== null) parts.push(`A ${tick(rel(a))}`);
  if (b !== null) parts.push(`B ${tick(rel(b))}`);
  if (a !== null && b !== null) parts.push(`B-A ${fmtMs(Math.abs(b - a))}`);
  kids.push(s("text", { x: x1, y: fy, class: "cursor-readout", "text-anchor": "end" }, parts.length ? parts.join("   ") : narrow ? "drag: cursors" : "drag across the plot to place cursors A and B"));

  // Move retained controls instead of removing them between pointerdown and click.
  kids.forEach((kid,i)=>{if(svg.childNodes[i]!==kid)svg.insertBefore(kid,svg.childNodes[i]||null);});
  while(svg.childNodes.length>kids.length)svg.lastChild.remove();
  const H = fy + 8;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("width", String(W));
  svg.setAttribute("height", String(H));
  svg.setAttribute("class", `capture-svg wf-${workflow}`);

  // Drag places cursors; a short press stays a click on whatever is under it.
  if (!svg.dataset.drag) {
    svg.dataset.drag = "1";
    let start = null;
    svg.addEventListener("pointerdown", (e) => {
      const g = svg.__geom;
      if (!g || e.button !== 0) return;
      const p = g.point(e);
      const target=e.target.closest('[data-key]');
      const activate=target?.__activate;
      const canDrag=p.x>=g.x0&&p.x<=g.x1&&p.y>=g.top-4;
      if (!canDrag && !activate) return;
      start = { x: p.x, moved: false, id: e.pointerId, canDrag, activate };
      // Keep the press on this SVG even if a live redraw moves the hit geometry.
      svg.setPointerCapture(e.pointerId);
    });
    svg.addEventListener("pointermove", (e) => {
      const g = svg.__geom;
      if (!start || !g || e.pointerId !== start.id || !start.canDrag) return;
      const p = g.point(e);
      if (!start.moved && Math.abs(p.x - start.x) < 4) return;
      if (!start.moved) svg.setPointerCapture(e.pointerId);
      start.moved = true;
      g.ui.onCursor && g.ui.onCursor(g.t(start.x), g.t(p.x));
    });
    const finish = (e) => {
      const gesture=start;
      if (gesture && (gesture.moved || gesture.activate)) {
        const stop = (ev) => { ev.preventDefault(); ev.stopPropagation(); };
        svg.addEventListener("click", stop, { capture: true, once: true });
        setTimeout(() => svg.removeEventListener("click", stop, { capture: true }), 0);
      }
      start = null;
      if (svg.hasPointerCapture && e && svg.hasPointerCapture(e.pointerId)) svg.releasePointerCapture(e.pointerId);
      if(gesture&&!gesture.moved&&e.type==='pointerup')gesture.activate?.();
    };
    svg.addEventListener("pointerup", finish);
    svg.addEventListener("pointercancel", finish);
  }
  svg.__geom = {
    x0, x1, top, ui,
    t: (x) => model.t0 + ((Math.min(Math.max(x, x0), x1) - x0) / (x1 - x0)) * span,
    point: (e) => {
      const r = svg.getBoundingClientRect();
      return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
    },
  };

  if (focusKey) {
    const el = svg.querySelector(`[data-key="${CSS.escape(focusKey)}"]`);
    if (el) el.focus({ preventScroll: true });
  }
}
