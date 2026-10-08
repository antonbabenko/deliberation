// views/runs.js - the capture index: every run, newest first, with a bar whose length is
// the run's duration. Filters go to the server; live runs update in place.

import { api, store } from "../api.js";
import { h, put, fmtMs, fmtK, fmtTime, midId, providerLabel } from "../dom.js";
import { statusMark } from "./run.js";

const STATUSES = ["running", "done", "converged", "unresolved", "error", "abandoned"];
const TOOLS = ["consensus-step", "consensus", "panel", "ask-all", "ask-one", "ask-gpt", "ask-gemini", "ask-grok", "ask-openrouter"];

function field(label, control) {
  return h("label", { class: "field" }, h("span", {}, label), control);
}

/**
 * Project choices from the runs in view, as a tree: each repo group (value `p:<id>`, all its
 * workspaces) then, when it has more than one, each workspace (value `w:<ws>`). A group with
 * one workspace shows it inline: `org/repo (/path)`. Same-named groups get a short id. The
 * selected value stays listed even if no run shows it.
 * @param {any[]} runs @param {string} selected
 * @returns {{id: string, label: string, depth: number}[]}
 */
export function projectOptions(runs, selected) {
  /** @type {Map<string, {name: string, ws: Map<string, string>}>} */
  const by = new Map();
  for (const r of runs) {
    const p = r.project;
    if (!p || typeof p.id !== "string") continue;
    const g = by.get(p.id) || { name: String(p.name || p.id), ws: new Map() };
    by.set(p.id, g);
    if (typeof p.ws === "string") g.ws.set(p.ws, String(p.root || ""));
  }
  const names = [...by.values()].map((g) => g.name);
  const groups = [...by.entries()].map(([id, g]) => {
    const name = names.filter((n) => n === g.name).length > 1 ? `${g.name} [${id.slice(0, 6)}]` : g.name;
    const ws = [...g.ws.entries()].sort((a, b) => a[1].localeCompare(b[1]));
    const label = ws.length === 1 && ws[0][1] ? `${name} (${ws[0][1]})` : ws.length > 1 ? `${name} (${ws.length} workspaces)` : name;
    return { name, head: { id: `p:${id}`, label, depth: 0 }, kids: ws.length > 1 ? ws.map(([w, root]) => ({ id: `w:${w}`, label: root || w, depth: 1 })) : [] };
  }).sort((a, b) => a.name.localeCompare(b.name));
  const out = groups.flatMap((g) => [g.head, ...g.kids]);
  if (runs.some((r) => !r.project)) out.push({ id: "p:unknown", label: "(unknown)", depth: 0 });
  const sel = selectionOf(selected);
  if (selected && !out.some((o) => o.id === sel)) out.push({ id: sel, label: sel === "p:unknown" ? "(unknown)" : sel.slice(2, 14), depth: 0 });
  return out;
}

/** A stored selection in `p:`/`w:` form; a bare id (stored before workspaces) is a project. @param {string} v */
export function selectionOf(v) {
  return !v ? "" : /^[pw]:/.test(v) ? v : `p:${v}`;
}

/** The API filter for a selection: `{project}` or `{ws}`. @param {string} v */
export function projectFilter(v) {
  const s = selectionOf(v);
  return s.startsWith("w:") ? { project: "", ws: s.slice(2) } : { project: s.slice(2), ws: "" };
}

/** @param {{id: string, label: string, depth: number}[]} options @param {string} value @param {((e: Event) => void)|null} onchange */
export function projectSelect(options, value, onchange) {
  const sel = selectionOf(value);
  return h("select", { name: "project", onchange }, h("option", { value: "" }, "any"),
    options.map((o) => h("option", { value: o.id, selected: o.id === sel }, `${o.depth ? "\u00a0\u00a0\u2514 " : ""}${o.label}`)));
}

function select(name, options, value, onchange) {
  return h("select", { name, onchange }, h("option", { value: "" }, "any"), options.map((o) => h("option", { value: o, selected: o === value }, o)));
}

export function create(ctx) {
  const saved = store.get("filters", {});
  const f = { q: "", tool: "", provider: "", status: "", since: "", ...(saved && typeof saved === "object" ? saved : {}), project: store.get("project", "") || "" };
  const el = h("section", { class: "view view-runs", "data-view": "runs" });
  const list = h("ol", { class: "index", "aria-label": "Runs" });
  const foot = h("p", { class: "index-foot", role: "status" });
  let rows = null;
  let error = null;
  let seq = 0;

  const providers = () => [...new Set(ctx.runList().flatMap((r) => r.providers))].sort();
  const projects = () => projectOptions(ctx.runList(), f.project);
  const active = () => Object.values(f).some(Boolean);

  function fetchRows() {
    const mine = ++seq;
    store.set("filters", { ...f, project: undefined });
    store.set("project", f.project);
    if (!active()) {
      rows = null;
      error = null;
      return update();
    }
    const since = f.since ? new Date(`${f.since}T00:00:00`).getTime() : "";
    api.runs({ q: f.q, tool: f.tool, provider: f.provider, status: f.status, ...projectFilter(f.project), since }).then((body) => {
      if (mine !== seq) return;
      rows = Array.isArray(body && body.runs) ? body.runs : [];
      error = null;
      update();
    }).catch((e) => {
      if (mine !== seq) return;
      error = String(e.message || e);
      update();
    });
  }

  let debounce = 0;
  const search = h("input", { type: "search", name: "q", value: f.q, placeholder: "prompt text", autocomplete: "off", oninput: () => {
    f.q = search.value.trim();
    clearTimeout(debounce);
    debounce = setTimeout(fetchRows, 250);
  } });
  const onSel = (k) => (e) => { f[k] = e.target.value; fetchRows(); };
  const provSel = select("provider", providers(), f.provider, onSel("provider"));
  const projSel = projectSelect(projects(), f.project, onSel("project"));
  const filters = h("form", { class: "filters", role: "search", onsubmit: (e) => e.preventDefault() },
    field("search", search),
    field("project", projSel),
    field("tool", select("tool", TOOLS, f.tool, onSel("tool"))),
    field("provider", provSel),
    field("status", select("status", STATUSES, f.status, onSel("status"))),
    field("since", h("input", { type: "date", name: "since", value: f.since, onchange: (e) => { f.since = e.target.value; fetchRows(); } })),
    h("button", { type: "button", class: "key", onclick: () => {
      Object.assign(f, { q: "", tool: "", provider: "", status: "", since: "", project: "" });
      for (const c of filters.querySelectorAll("input, select")) c.value = "";
      fetchRows();
    } }, "Clear"));
  const hint = h("p", { class: "hint" });
  el.append(filters, hint, list, foot);

  function update() {
    const known = providers();
    if (provSel.options.length - 1 !== known.length) {
      put(provSel, h("option", { value: "" }, "any"), known.map((o) => h("option", { value: o, selected: o === f.provider }, o)));
    }
    const knownProjects = projects();
    if (projSel.options.length - 1 !== knownProjects.length) put(projSel, ...projectSelect(knownProjects, f.project, null).children);
    hint.textContent = ctx.captureMode() === "content"
      ? "Search matches the prompt text of each run."
      : "Search matches prompt text, which is recorded only with capture: content. Metadata runs match the other filters.";
    // Live runs override their cached summary; with no filter, runs seen only over the stream join the list.
    const liveSum = (s) => (ctx.S.runs[s.runId] && ctx.S.runs[s.runId].events.length ? { ...s, ...ctx.summaryOf(ctx.S.runs[s.runId]), legacy: s.legacy } : s);
    const base = rows || ctx.runList().map((r) => ctx.summaryOf(r));
    const items = base.map(liveSum).sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
    const now = Date.now();
    const dur = (s) => Math.max(0, (s.status === "running" ? now : s.endedAt ?? s.startedAt) - (s.startedAt || now));
    const max = Math.max(1, ...items.map(dur));
    const selected = store.get("selectedRun", null);
    if (error) {
      put(list, h("li", { class: "empty" }, `Could not filter runs: ${error}. Clear the filters or reload the page.`));
    } else if (!items.length) {
      put(list, h("li", { class: "empty" }, active() ? "No run matches these filters. Clear one to widen the index." : "No runs recorded yet. Runs appear here once dashboard.enabled is true and a deliberation tool runs."));
    } else {
      put(list, ...items.map((s) => {
        const bar = h("span", { class: `dur-fill st-${s.status}` });
        bar.style.width = `${Math.max(0.5, (dur(s) / max) * 100)}%`;
        return h("li", {}, h("a", { class: `index-row${s.runId === selected ? " is-selected" : ""}`, href: `#/runs/${encodeURIComponent(s.runId)}` },
          h("span", { class: "c-status" }, statusMark(s.status)),
          h("span", { class: "c-time num" }, fmtTime(s.startedAt)),
          h("span", { class: "c-proj", title: s.project ? `${s.project.name} (${s.project.root})` : "no project recorded" }, s.project ? s.project.name : "-",
            s.project && s.project.root ? h("span", { class: "c-ws" }, ` (${s.project.root})`) : null),
          h("span", { class: "c-tool" }, s.tool || "-", s.legacy ? h("span", { class: "flag" }, "summary only") : null),
          h("span", { class: "c-wf" }, s.workflow || "-"),
          h("span", { class: "c-id", title: s.runId }, midId(s.runId, 16)),
          h("span", { class: "c-prov" }, (s.providers || []).join(" ") || "-"),
          h("span", { class: "c-num num", title: "rounds" }, s.rounds ? `R${s.rounds}` : ""),
          h("span", { class: "c-num num", title: "tokens" }, s.tokens ? `${fmtK(s.tokens)} tok` : ""),
          h("span", { class: `c-num num${s.errors ? " has-errors" : ""}`, title: "errors" }, s.errors ? `${s.errors} err` : ""),
          h("span", { class: "c-dur" }, h("span", { class: "dur-track" }, bar), h("span", { class: "dur-val num" }, fmtMs(dur(s))))));
      }));
    }
    foot.textContent = items.length ? `${items.length} runs${rows ? " match" : ""}. Bar length is run duration, longest ${fmtMs(max)}.` : "";
  }

  if (active()) fetchRows();
  return { el, update, tick: () => {} };
}
