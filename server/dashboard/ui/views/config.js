// views/config.js - provider health and the effective config. Key values never reach
// the browser: every apiKeyEnv arrives as {env, set}.

import { api } from "../api.js";
import { h, put, providerLabel } from "../dom.js";

const yes = (v) => (v ? "yes" : "no");

function flatten(obj, prefix = "", out = []) {
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    const keys = Object.keys(obj);
    if (keys.length === 2 && "env" in obj && "set" in obj) {
      out.push([prefix, `${obj.env} (${obj.set ? "set" : "not set"})`]);
      return out;
    }
    if (!keys.length) out.push([prefix, "{}"]);
    for (const k of keys) flatten(obj[k], prefix ? `${prefix}.${k}` : k, out);
  } else if (Array.isArray(obj)) {
    if (!obj.length || obj.every((x) => typeof x !== "object" || x === null)) out.push([prefix, JSON.stringify(obj)]);
    else obj.forEach((x, i) => flatten(x, `${prefix}[${i}]`, out));
  } else out.push([prefix, obj === null ? "null" : String(obj)]);
  return out;
}

export function create(ctx) {
  const el = h("section", { class: "view view-config", "data-view": "config" });
  const health = h("section", { class: "panel" }, h("h2", {}, "Provider health"), h("div", { class: "skeleton-rows" }, h("span"), h("span"), h("span")));
  const runtime=h('div',{},h('p',{class:'hint'},'Select a runtime to inspect its active snapshot and pending restart changes.'));
  const cfg = h("section", { class: "panel" }, h("h2", {}, "Effective config"), h("div", { class: "skeleton-rows" }, h("span"), h("span"), h("span")));
  el.append(health, cfg);

  function drawHealth(hb) {
    const rows = [...(hb.providers || []).filter((p) => p.name !== "openrouter").map((p) => ({ ...p, kind: "provider" })), ...(hb.models || []).map((m) => ({ ...m, kind: "model", enabled: true, ok: true }))];
    const state = (p) => (p.enabled === false ? ["off", "st-pending"] : p.needsLogin ? ["needs login", "st-timeout"] : p.ok === false ? ["unavailable", "st-failed"] : ["ready", "st-succeeded"]);
    put(health, h("h2", {}, "Provider health"),
      h("p", { class: "hint" }, "The same stat-only checks panel uses: nothing here starts a login or calls a model."),
      rows.length ? h("div", { class: "table-wrap" }, h("table", { class: "grid-table" },
        h("thead", {}, h("tr", {}, ["provider", "state", "reason", "model", "Ask effort", "Consensus effort", "source", "ask-all", "consensus"].map((t) => h("th", {}, t)))),
        h("tbody", {}, rows.map((p) => {
          const [label, cls] = state(p);
          return h("tr", {}, h("td", { class: "strong" }, providerLabel(p.name)), h("td", {}, h("span", { class: `status-mark ${cls}` }, label)), h("td", { class: "wrap" }, p.reason || ""),
            h("td", {}, p.model || "-"), h("td", {}, p.askEffort || "inherited / unknown"),h("td", {}, p.consensusEffort || "inherited / unknown"),h("td", {}, p.effortSource || "unknown"), h("td", {}, yes(p.askAll)), h("td", {}, yes(p.consensus)));
        })))) : h("p", { class: "empty" }, "No providers configured."),
      hb.needsLogin && hb.needsLogin.length ? h("p", { class: "note-warn" }, `Needs login before the next run: ${hb.needsLogin.join(", ")}. Run /deliberation:codex-login in Claude Code.`) : null);
  }

  function drawConfig(c) {
    const observed=c.observedRuntimeSettings;
    const selected=observed?.runtimes.find(r=>r.runtimeId===observed.dashboardRuntimeId)||observed?.runtimes[0];
    if(selected)put(runtime,h('pre',{class:'payload'},JSON.stringify(selected,null,2)));
    const rows = flatten(Object.fromEntries(Object.entries(c).filter(([k])=>k!=='observedRuntimeSettings')));
    put(cfg, h("h2", {}, "Config file and observed runtimes"),
      observed?h('section',{},h('p',{class:'hint'},observed.note),h('label',{},'Observed runtime ',h('select',{'aria-label':'Observed runtime',onchange:e=>{const r=observed.runtimes.find(r=>r.runtimeId===e.target.value);put(runtime,h('pre',{class:'payload'},JSON.stringify(r,null,2)));}},observed.runtimes.map(r=>h('option',{value:r.runtimeId},`${r.runtimeId===observed.dashboardRuntimeId?'Dashboard runtime':'Delegation runtime'} ${r.runtimeId.slice(0,12)} — ${r.freshness}`)))),runtime):null,
      h("p", { class: "hint" }, "Current file values after defaults. Each observed runtime reports its own active and pending snapshots; the file alone is not proof of active dispatch settings."),
      h("div", { class: "table-wrap" }, h("table", { class: "grid-table kv" }, h("tbody", {}, rows.map(([k, v]) => h("tr", {}, h("th", { scope: "row" }, k), h("td", {}, v)))))));
  }

  const fail = (panel, title) => (e) => put(panel, h("h2", {}, title), h("p", { class: "error-note" }, `Could not load: ${e.message || e}. ${e.status === 401 ? "The dashboard restarted; open the URL it printed." : "Check that the dashboard process is still running."}`));
  api.health().then(drawHealth, fail(health, "Provider health"));
  api.config().then(drawConfig, fail(cfg, "Effective config"));
  return { el, update: () => {}, tick: () => {} };
}
