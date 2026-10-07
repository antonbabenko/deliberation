// views/stats.js - latency, tokens, errors and verdict agreement per model (the analyze
// tool's two lenses), its tuning suggestions, and runs per day.

import { api } from "../api.js";
import { h, put, s, fmtMs, fmtK, fmtInt, num, fmtTime, providerLabel } from "../dom.js";
import { inkOf } from "../graph.js";

/** The one rounding for every rate on this page (matches core/analyze.js). */
const pct = (v) => (num(v) === null ? "-" : `${Math.round(v * 100)}%`);

function latencyTable(stats) {
  const max = Math.max(1, ...stats.map((m) => num(m.ms && m.ms.p95) || 0));
  return h("div", { class: "table-wrap" }, h("table", { class: "grid-table stats-table" },
    h("thead", {}, h("tr", {}, ["model", "calls", "errors", "p50", "p95", "", "tokens/call", "effort"].map((t, i) => h("th", { class: i && i < 5 ? "num" : i === 6 ? "num" : "" }, t)))),
    h("tbody", {}, stats.map((m) => {
      const p50 = num(m.ms && m.ms.p50);
      const p95 = num(m.ms && m.ms.p95);
      // A 10-division scale, the p95 bar in the provider's ink, and a p50 tick, as SVG geometry.
      const scale = s("svg", { class: "range-scale", viewBox: "0 0 100 14", preserveAspectRatio: "none", "aria-hidden": "true" },
        Array.from({ length: 11 }, (_, i) => s("line", { x1: i * 10, x2: i * 10, y1: i % 5 ? 3 : 0, y2: i % 5 ? 11 : 14, class: "range-div" })),
        p95 !== null ? s("rect", { x: 0, y: 4, width: (p95 / max) * 100, height: 6, class: `range ink-${inkOf(m.provider)}` }) : null,
        p50 !== null ? s("line", { x1: (p50 / max) * 100, x2: (p50 / max) * 100, y1: 1, y2: 13, class: "range-p50" }) : null);
      return h("tr", {},
        h("td", { class: "strong" }, `${providerLabel(m.provider)} `, h("span", { class: "muted" }, m.model)),
        h("td", { class: "num" }, fmtInt(m.calls)),
        h("td", { class: `num${m.errors ? " has-errors" : ""}` }, m.errors ? `${m.errors} (${pct(m.errorRate)})` : "0"),
        h("td", { class: "num" }, fmtMs(p50)),
        h("td", { class: "num" }, fmtMs(p95)),
        h("td", { class: "range-cell", "aria-hidden": "true" }, scale),
        h("td", { class: "num" }, fmtK(m.meanTokens)),
        h("td", {}, (m.reasoningEfforts || []).join(" ") || "-"));
    }))));
}

function dailyChart(daily) {
  // Drawn at the width it is shown at, so its labels keep their size on a phone.
  const W = typeof window !== "undefined" && window.innerWidth < 760 ? Math.max(300, window.innerWidth - 32) : 720;
  const H = 150;
  const days = daily.slice(-30);
  // Gridlines sit on whole runs: an integer step, and the top of the axis is 4 steps.
  const step = Math.max(1, Math.ceil(Math.max(1, ...days.map((d) => d.runs)) / 4));
  const maxRuns = step * 4;
  const bw = Math.max(4, Math.min(28, (W - 40) / days.length - 4));
  const kids = [];
  for (let i = 0; i <= 4; i++) {
    const y = 10 + ((H - 40) * i) / 4;
    kids.push(s("line", { x1: 32, x2: W, y1: y, y2: y, class: "grat" }));
    kids.push(s("text", { x: 28, y: y + 4, class: "tick-label", "text-anchor": "end" }, String(step * (4 - i))));
  }
  days.forEach((d, i) => {
    const x = 40 + i * (bw + 4);
    const hRuns = ((H - 40) * d.runs) / maxRuns;
    const hErr = ((H - 40) * Math.min(d.errors, d.runs)) / maxRuns;
    kids.push(s("rect", { x, y: 10 + (H - 40) - hRuns, width: bw, height: hRuns, class: "bar" }, s("title", { text: `${d.day}: ${d.runs} runs, ${fmtK(d.tokens)} tokens, ${d.errors} errors` })));
    if (hErr > 0) kids.push(s("rect", { x, y: 10 + (H - 40) - hErr, width: bw, height: hErr, class: "bar-err" }));
    if (days.length <= 10 || i % Math.ceil(days.length / 8) === 0) kids.push(s("text", { x: x + bw / 2, y: H - 14, class: "tick-label", "text-anchor": "middle" }, d.day.slice(5)));
  });
  return s("svg", { viewBox: `0 0 ${W} ${H}`, class: "daily", role: "img", "aria-label": `Runs per day over ${days.length} days; errors drawn in the fault color` }, kids);
}

export function create() {
  const el = h("section", { class: "view view-stats", "data-view": "stats" });
  el.append(h("section", { class: "panel" }, h("h2", {}, "Latency and measured tokens per model"), h("div", { class: "skeleton-rows" }, h("span"), h("span"), h("span"))));

  const params=new URLSearchParams(location.search);
  let filters={since:params.get('since')||undefined,configId:params.get('configId')||undefined};
  let generation=0,disposed=false;
  function load(){const n=++generation;api.stats(filters).then(st=>{if(!disposed&&n===generation)draw(st);},e=>{if(!disposed&&n===generation)draw({error:e.message});});}
  function change(key,value){filters={...filters,[key]:value||undefined};const url=new URL(location.href);for(const [k,v]of Object.entries(filters)){if(v)url.searchParams.set(k,v);else url.searchParams.delete(k);}history.replaceState(null,'',url);load();}
  function draw(st) {
    if (st.error) {
      put(el, h("section", { class: "panel" }, h("h2", {}, "Stats"), h("p", { class: "error-note" }, `Stats are unavailable: ${st.error}`)));
      return;
    }
    const meta = st.meta || {};
    const stats = Array.isArray(st.stats) ? st.stats : [];
    const agreement = Array.isArray(st.agreement) ? st.agreement : [];
    const recs = (st.configs||[]).flatMap(c=>(c.recommendations||[]).map(r=>({...r,subject:`${c.label} / ${providerLabel(r.subject)} (${r.workload})`})));
    const outliers = Array.isArray(st.outliers) ? st.outliers : [];
    const daily = Array.isArray(st.daily) ? st.daily : [];
    const time=h('select',{'aria-label':'Time window',onchange:e=>change('since',e.target.value)},[['','All time'],['1h','Last hour'],['24h','Last 24 hours'],['7d','Last 7 days'],['14d','Last 14 days']].map(([v,t])=>h('option',{value:v,selected:(filters.since||'')===v},t)));
    const configs=h('select',{'aria-label':'Configuration',onchange:e=>change('configId',e.target.value)},h('option',{value:'',selected:!filters.configId},'All configs'),(st.configOptions||[]).map(c=>h('option',{value:c.configId,selected:c.configId===filters.configId},c.configId==='unknown'?'Unknown / legacy config':`${c.label} — first used ${fmtTime(c.firstSeenAt)} ${Intl.DateTimeFormat().resolvedOptions().timeZone}`)));
    put(el,
      h('section',{class:'panel stats-filters'},h('label',{},'Time ',time),h('label',{},'Configuration ',configs),h('button',{onclick:load},'Refresh')),
      h('section',{class:'panel'},h('h2',{},'Configuration comparison'),h('p',{class:'hint'},'Whole runs selected by start time. Timing and agreement remain independent. CLI tokens are unknown; reuse is excluded from fresh samples.'),
        h('div',{class:'table-wrap'},h('table',{class:'grid-table'},h('thead',{},h('tr',{},['config','runs','live','success','errors','p50','p95','measured tokens','usage coverage','reuse'].map(t=>h('th',{},t)))),h('tbody',{},(st.configs||[]).map(c=>h('tr',{},h('td',{},h('a',{href:`?configId=${c.configId}#/stats`},c.label)),...[c.runCount,c.liveRuns,c.successRuns,c.errorRuns,fmtMs(c.elapsed?.p50),fmtMs(c.elapsed?.p95),c.tokenCoverageRuns?fmtK(c.measuredTokens):"unknown",`${c.tokenCoverageRuns}/${c.runCount}`,c.reusedResults].map(v=>h('td',{},String(v)))))))),
        (st.configs||[]).map(c=>h('details',{},h('summary',{},`${c.label}: recorded settings and activations`),h('pre',{class:'payload'},JSON.stringify({snapshot:c.snapshot,activations:c.activations,partitions:c.partitions,warnings:c.warnings},null,2))))),
      h("section", { class: "panel" }, h("h2", {}, "Latency and measured tokens per model"),
        stats.length ? [h("p", { class: "hint" }, "p50 tick and p95 bar share one scale, successful calls only. Slowest p95 first."), latencyTable(stats)]
          : h("p", { class: "empty" }, meta.debugEnabled === false
            ? "No timing data: the debug log is off. Set debug.enabled to true in the deliberation config; calls are measured from then on."
            : "No calls in the debug log yet. Run /ask-all or /consensus and come back.")),
      h("section", { class: "panel" }, h("h2", {}, "Verdict agreement"),
        agreement.length ? h("div", { class: "table-wrap" }, h("table", { class: "grid-table" },
          h("thead", {}, h("tr", {}, ["model", "votes", "agreed", "rate", "abstained"].map((t, i) => h("th", { class: i ? "num" : "" }, t)))),
          h("tbody", {}, agreement.map((a) => h("tr", {}, h("td", { class: "strong" }, `${providerLabel(a.provider)} `, h("span", { class: "muted" }, a.model)), h("td", { class: "num" }, fmtInt(a.votes)), h("td", { class: "num" }, fmtInt(a.agreed)), h("td", { class: "num" }, pct(a.agreementRate)), h("td", { class: "num" }, fmtInt(a.abstained)))))))
          : h("p", { class: "empty" }, meta.sessionsPersist === false ? "No agreement data: sessions.persist is off, so finished consensus runs are not kept." : "No consensus verdicts recorded yet.")),
      h("section", { class: "panel" }, h("h2", {}, "Suggestions"),
        recs.length || outliers.length ? h("ul", { class: "recs" },
          outliers.map((o) => h("li", {}, h("span", { class: "kind" }, o.kind), ` ${providerLabel(o.provider)} ${o.model}: ${o.detail}`)),
          recs.map((r) => h("li", {}, h("span", { class: "kind" }, r.target === "external" ? "external" : "config"), ` ${r.subject}: ${r.action}`, r.configKey ? h("code", {}, ` ${r.configKey}`) : null, h("span", { class: "muted" }, ` ${r.rationale}`))))
          : h("p", { class: "empty" }, "No suggestions: nothing stands out in the measured window.")),
      h("section", { class: "panel" }, h("h2", {}, "Runs per day"),
        daily.length ? [dailyChart(daily), h("p", { class: "hint" }, `${fmtInt(daily.reduce((n, d) => n + d.runs, 0))} runs, ${fmtK(daily.reduce((n, d) => n + d.tokens, 0))} tokens, ${fmtInt(daily.reduce((n, d) => n + d.errors, 0))} errors in the journal.`)]
          : h("p", { class: "empty" }, "No journaled runs yet.")),
      Array.isArray(meta.warnings) && meta.warnings.length ? h("section", { class: "panel" }, h("h2", {}, "Warnings"), h("ul", { class: "recs" }, meta.warnings.map((w) => h("li", {}, w)))) : null,
    );
  }

  load();
  return { el, update: () => {}, tick: () => {},destroy:()=>{disposed=true;generation++;} };
}
