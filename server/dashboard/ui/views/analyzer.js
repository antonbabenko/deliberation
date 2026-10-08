// views/analyzer.js - which models earn their place in the panel, which projects fail or
// run slow, and whether request size predicts latency and timeouts. Numbers come from the
// run journal (server/dashboard/analyzer.js); this view only lays them out.

import { api, store } from "../api.js";
import { h, put, fmtMs, fmtInt, num, providerLabel } from "../dom.js";
import { projectOptions, projectSelect, projectFilter } from "./runs.js";

const pct = (v) => (num(v) === null ? "-" : `${Math.round(v * 100)}%`);
const DAYS = [[7, "Last 7 days"], [30, "Last 30 days"], [90, "Last 90 days"], [365, "Last year"]];

function table(head, rows, numeric = () => false) {
  return h("div", { class: "table-wrap" }, h("table", { class: "grid-table" },
    h("thead", {}, h("tr", {}, head.map((t, i) => h("th", { class: numeric(i) ? "num" : "" }, t)))),
    h("tbody", {}, rows)));
}

function verdictOf(m) {
  if (m.candidate) return h("span", { class: "kind kind-drop" }, "drop candidate");
  if (m.unconfirmed) return h("span", { class: "kind", title: "Redundant and costly, but no arbiter decisions were recorded to confirm it. Run /consensus to collect them." }, "unconfirmed");
  return h("span", { class: "muted" }, "keep");
}

function modelsPanel(models, C) {
  const rows = models.filter((m) => m.rounds || m.calls).map((m) => h("tr", { class: m.candidate ? "is-flagged" : "" },
    h("td", { class: "strong" }, providerLabel(m.provider)),
    h("td", { class: "num" }, fmtInt(m.rounds)),
    h("td", { class: "num" }, pct(m.addsNothing)),
    h("td", { class: "num" }, pct(m.loneDissent)),
    h("td", { class: "num", title: `${m.decisionRounds} rounds with arbiter decisions` }, m.decisionRounds ? `${pct(m.acceptedRate)} of ${m.decisionRounds}` : "-"),
    h("td", { class: "num", title: `${m.coRounds} rounds with another responder` }, pct(m.slowShare)),
    h("td", { class: `num${m.errors ? " has-errors" : ""}` }, m.calls ? `${pct(m.errorRate)} of ${m.calls}` : "-"),
    h("td", {}, verdictOf(m)),
    h("td", {}, m.candidate || m.unconfirmed ? h("code", {}, `${m.configKey}: false`) : "")));
  return h("section", { class: "panel" }, h("h2", {}, "Models: agreement vs findings"),
    h("p", { class: "hint" },
      `Consensus rounds only (ask-all answers carry no verdict). "Adds nothing" = every issue category it raised was also raised by another voice that round. `,
      `A drop candidate has at least ${C.MIN_ROUNDS} rounds, adds nothing in ${pct(C.ADDS_NOTHING_MIN)}+ of them, is the lone objector in ${pct(C.LONE_DISSENT_MAX)} or fewer (a lone APPROVE does not count), `,
      `had ${pct(C.ACCEPTED_MAX)} or fewer of its rounds produce an issue the arbiter accepted (over ${C.MIN_DECISION_ROUNDS}+ rounds with decisions), `,
      `and is slow (${C.SLOW_RATIO}x the other responders' median in ${pct(C.SLOW_SHARE_MIN)}+ of rounds) or errors in ${pct(C.ERROR_RATE_MIN)}+ of calls. Categories are coarse, so treat it as advice.`),
    rows.length
      ? table(["model", "rounds", "adds nothing", "lone dissent", "accepted", "slow", "errors", "verdict", "config"], rows, (i) => i >= 1 && i <= 6)
      : h("p", { class: "empty" }, "No consensus rounds in this window. Run /consensus with dashboard.enabled on."));
}

function projectsPanel(projects, pick) {
  const cells = (p) => [
    h("td", { class: "num" }, fmtInt(p.runs)),
    h("td", { class: "num" }, fmtInt(p.calls)),
    h("td", { class: `num${p.timeouts ? " has-errors" : ""}` }, p.timeouts ? `${p.timeouts} (${pct(p.timeoutRate)})` : "0"),
    h("td", { class: `num${num(p.errorRate) ? " has-errors" : ""}` }, pct(p.errorRate)),
    h("td", { class: "num" }, fmtMs(p.p50)),
    h("td", { class: "num" }, fmtMs(p.p95)),
    h("td", {}, (p.topErrors || []).map((e) => `${e.kind} ${e.n}`).join(", ") || "-")];
  const link = (label, value, title) => h("button", { type: "button", class: "linkish", title, onclick: () => pick(value) }, label);
  const rows = projects.flatMap((p) => {
    const ws = Array.isArray(p.workspaces) ? p.workspaces : [];
    const one = ws.length === 1 ? ws[0].root : "";
    const kids = ws.length > 1 ? ws.map((w) => h("tr", { class: "ws-row", hidden: true },
      h("td", { class: "ws-name" }, link(w.root || w.ws, `w:${w.ws}`, `Only runs from ${w.root || w.ws}`)), ...cells(w))) : [];
    const toggle = kids.length ? h("button", { type: "button", class: "tree-toggle", "aria-expanded": "false", "aria-label": `Show ${kids.length} workspaces of ${p.name}`, onclick: (e) => {
      const open = e.currentTarget.getAttribute("aria-expanded") !== "true";
      e.currentTarget.setAttribute("aria-expanded", String(open));
      for (const k of kids) k.hidden = !open;
    } }, `${kids.length}`) : null;
    return [h("tr", {},
      h("td", { class: "strong" }, toggle, link(one ? `${p.name} (${one})` : p.name, `p:${p.id}`, p.id === "unknown" ? "no project recorded" : `All workspaces of ${p.name}`)), ...cells(p)), ...kids];
  });
  return h("section", { class: "panel" }, h("h2", {}, "Projects"),
    h("p", { class: "hint" }, "Where each run was called from, grouped by git remote (org/repo), then by workspace dir: every clone and worktree of a repo lands under one row. Expand a row for its workspaces; click a name to filter to it. Cached answers are excluded from latency."),
    rows.length ? table(["project", "runs", "calls", "timeouts", "errors", "p50", "p95", "top errors"], rows, (i) => i >= 1 && i <= 6) : h("p", { class: "empty" }, "No runs in this window."));
}

function adviceText(a) {
  if (!a) return "-";
  if (a.kind === "censored") return h("span", {}, `censored: raise to ${fmtMs(a.suggestedMs)} `, h("code", {}, a.configKey), h("span", { class: "muted" }, ` (now ${fmtMs(a.currentMs)})`));
  if (a.kind === "trend") return h("span", {}, `size trend: ${fmtMs(a.suggestedMs)} covers p95 `, h("code", {}, a.configKey));
  if (a.kind === "early-warning") return h("span", { class: "has-errors" }, `${a.timeouts} of ${a.n} calls timed out; too few for a number, but `, h("code", {}, a.configKey), " is likely too low");
  if (a.kind === "host-limit") return h("span", { class: "has-errors" }, `host cap is the limit: raise MCP_TOOL_TIMEOUT${a.hostCapMs ? ` (now ${fmtMs(a.hostCapMs)})` : ""}`);
  return h("span", { class: "muted" }, a.reason || "no size effect shown");
}

function sizePanel(r) {
  const groups = (r.size || []).map((g) => {
    const f = g.fit || {};
    return h("div", { class: "size-group" },
      h("h3", {}, `${providerLabel(g.provider)} `, h("span", { class: "muted" }, `${g.model || ""} ${g.split === "files" ? "with files" : "text only"}`)),
      h("p", { class: "hint" }, num(f.r) === null
        ? `Fit: not enough spread (${f.n || 0} successful calls).`
        : `Fit over ${f.n} successful calls: ${fmtInt(f.msPer1k)} ms per 1k chars, r = ${f.r.toFixed(2)}. Successes only; timed-out calls are censored, so the real slope is steeper.`),
      table(["size", "calls", "timeouts", "near ceiling", "p50", "p95", "ceiling", "advice"], g.buckets.filter((b) => b.n).map((b) => h("tr", {},
        h("td", {}, b.label),
        h("td", { class: "num" }, fmtInt(b.n)),
        h("td", { class: `num${b.timeouts ? " has-errors" : ""}` }, `${b.timeouts} (${pct(b.timeoutRate)})`),
        h("td", { class: "num" }, pct(b.nearRate)),
        h("td", { class: "num" }, fmtMs(b.p50)),
        h("td", { class: "num" }, fmtMs(b.p95)),
        h("td", { class: "num" }, fmtMs(b.medianGrantedMs)),
        h("td", {}, adviceText(b.advice)))), (i) => i >= 1 && i <= 6));
  });
  const host = (r.hostTimeouts || []).map((t) => h("li", {}, `${providerLabel(t.provider)}: ${t.timeouts} timeouts hit the host cap; raise MCP_TOOL_TIMEOUT${t.hostCapMs ? ` (now ${fmtMs(t.hostCapMs)})` : ""} where the host is launched.`));
  const outer = (r.outerTimeouts || []).map((t) => h("li", {}, `${providerLabel(t.provider)}: ${t.timeouts} timeouts hit a run budget (consensus.maxWallMs or a caller deadline), not its own timeout.`));
  const sk = r.skipped || {};
  const skipped = [sk.noCeiling && `${sk.noCeiling} calls recorded before size and ceiling were journaled`, sk.noSize && `${sk.noSize} without a size`, sk.unknownFileBytes && `${sk.unknownFileBytes} with files of unknown size`, sk.cached && `${sk.cached} cached answers`].filter(Boolean);
  return h("section", { class: "panel" }, h("h2", {}, "Request size vs latency"),
    h("p", { class: "hint" }, "Size = request chars as sent to the provider (prompt, plus attached file bytes when present; persona text excluded). Ceiling = what the call was actually granted. Advice needs 20+ calls in a bucket and only uses timeouts this config controls."),
    groups.length ? groups : h("p", { class: "empty" }, "No sized calls yet: size and ceiling are journaled from this version on."),
    host.length || outer.length ? h("ul", { class: "recs" }, host, outer) : null,
    skipped.length ? h("p", { class: "hint" }, `Skipped: ${skipped.join("; ")}.`) : null);
}

export function create(ctx) {
  const el = h("section", { class: "view view-analyzer", "data-view": "analyzer" });
  el.append(h("section", { class: "panel" }, h("h2", {}, "Analyzer"), h("div", { class: "skeleton-rows" }, h("span"), h("span"), h("span"))));
  let project = store.get("project", "") || "";
  let days = store.get("analyzerDays", 30);
  let gen = 0, disposed = false, last = null;

  function load() {
    const n = ++gen;
    api.analyzer({ ...projectFilter(project), days }).then((r) => { if (!disposed && n === gen) draw(r); }, (e) => { if (!disposed && n === gen) draw({ error: e.message }); });
  }

  function draw(r) {
    last = r;
    const known = (r.projects || []).flatMap((p) => p.id === "unknown" ? [{ project: null }]
      : (p.workspaces || []).map((w) => ({ project: { id: p.id, name: p.name, root: w.root, ws: w.ws } })));
    const pick = (v) => { project = v; store.set("project", project); load(); };
    const sel = projectSelect(projectOptions([...ctx.runList(), ...known], project), project, (e) => pick(e.target.value));
    const win = h("select", { "aria-label": "Time window", onchange: (e) => { days = Number(e.target.value); store.set("analyzerDays", days); load(); } }, DAYS.map(([v, t]) => h("option", { value: v, selected: v === days }, t)));
    const w = r.window || {};
    const controls = h("section", { class: "panel stats-filters" },
      h("label", {}, "Project ", sel), h("label", {}, "Window ", win), h("button", { onclick: load }, "Refresh"),
      r.error ? null : h("span", { class: "muted" }, `${fmtInt(w.analyzed)} runs analyzed${w.truncated ? ` (window capped; ${fmtInt(w.runsInWindow)} in range)` : ""}`));
    if (r.error) return put(el, controls, h("section", { class: "panel" }, h("h2", {}, "Analyzer"), h("p", { class: "error-note" }, `The analyzer is unavailable: ${r.error}`)));
    const C = r.constants || {};
    put(el, controls, modelsPanel(r.models || [], C), projectsPanel(r.projects || [], pick), sizePanel(r));
  }

  load();
  return { el, update: () => {}, tick: () => {}, destroy: () => { disposed = true; gen++; }, last: () => last };
}
