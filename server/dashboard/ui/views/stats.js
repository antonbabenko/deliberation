// views/stats.js - latency, tokens, errors and verdict agreement per model (the analyze
// tool's two lenses), its tuning suggestions, and runs per day.

import { api } from "../api.js";
import { h, put, s, fmtMs, fmtK, fmtInt, num } from "../dom.js";

const pct = (v) => (num(v) === null ? "-" : `${Math.round(v * 100)}%`);

function latencyTable(stats) {
  const max = Math.max(1, ...stats.map((m) => num(m.ms && m.ms.p95) || 0));
  return h("div", { class: "table-wrap" }, h("table", { class: "grid-table stats-table" },
    h("thead", {}, h("tr", {}, ["model", "calls", "errors", "p50", "p95", "", "tokens/call", "effort"].map((t, i) => h("th", { class: i && i < 5 ? "num" : i === 6 ? "num" : "" }, t)))),
    h("tbody", {}, stats.map((m) => {
      const p50 = num(m.ms && m.ms.p50);
      const p95 = num(m.ms && m.ms.p95);
      const range = h("span", { class: "range" });
      const tickEl = h("span", { class: "range-p50" });
      if (p95 !== null) range.style.width = `${(p95 / max) * 100}%`;
      if (p50 !== null) tickEl.style.left = `${(p50 / max) * 100}%`;
      return h("tr", {},
        h("td", { class: "strong" }, `${m.provider} `, h("span", { class: "muted" }, m.model)),
        h("td", { class: "num" }, fmtInt(m.calls)),
        h("td", { class: `num${m.errors ? " has-errors" : ""}` }, m.errors ? `${m.errors} (${pct(m.errorRate)})` : "0"),
        h("td", { class: "num" }, fmtMs(p50)),
        h("td", { class: "num" }, fmtMs(p95)),
        h("td", { class: "range-cell", "aria-hidden": "true" }, h("span", { class: "range-track" }, range, p50 !== null ? tickEl : null)),
        h("td", { class: "num" }, fmtK(m.meanTokens)),
        h("td", {}, (m.reasoningEfforts || []).join(" ") || "-"));
    }))));
}

function dailyChart(daily) {
  const W = 720;
  const H = 150;
  const days = daily.slice(-30);
  const maxRuns = Math.max(1, ...days.map((d) => d.runs));
  const bw = Math.max(4, Math.min(28, (W - 40) / days.length - 4));
  const kids = [];
  for (let i = 0; i <= 4; i++) {
    const y = 10 + ((H - 40) * i) / 4;
    kids.push(s("line", { x1: 32, x2: W, y1: y, y2: y, class: "grat" }));
    kids.push(s("text", { x: 28, y: y + 3, class: "tick-label", "text-anchor": "end" }, String(Math.round(maxRuns * (1 - i / 4)))));
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
  el.append(h("section", { class: "panel" }, h("h2", {}, "Latency and cost per model"), h("div", { class: "skeleton-rows" }, h("span"), h("span"), h("span"))));

  function draw(st) {
    if (st.error) {
      put(el, h("section", { class: "panel" }, h("h2", {}, "Stats"), h("p", { class: "error-note" }, `Stats are unavailable: ${st.error}`)));
      return;
    }
    const meta = st.meta || {};
    const stats = Array.isArray(st.stats) ? st.stats : [];
    const agreement = Array.isArray(st.agreement) ? st.agreement : [];
    const recs = Array.isArray(st.recommendations) ? st.recommendations : [];
    const outliers = Array.isArray(st.outliers) ? st.outliers : [];
    const daily = Array.isArray(st.daily) ? st.daily : [];
    put(el,
      h("section", { class: "panel" }, h("h2", {}, "Latency and cost per model"),
        stats.length ? [h("p", { class: "hint" }, "p50 tick and p95 bar share one scale, successful calls only. Slowest p95 first."), latencyTable(stats)]
          : h("p", { class: "empty" }, meta.debugEnabled === false
            ? "No timing data: the debug log is off. Set debug.enabled to true in the deliberation config; calls are measured from then on."
            : "No calls in the debug log yet. Run /ask-all or /consensus and come back.")),
      h("section", { class: "panel" }, h("h2", {}, "Verdict agreement"),
        agreement.length ? h("div", { class: "table-wrap" }, h("table", { class: "grid-table" },
          h("thead", {}, h("tr", {}, ["model", "votes", "agreed", "rate", "abstained"].map((t, i) => h("th", { class: i ? "num" : "" }, t)))),
          h("tbody", {}, agreement.map((a) => h("tr", {}, h("td", { class: "strong" }, `${a.provider} `, h("span", { class: "muted" }, a.model)), h("td", { class: "num" }, fmtInt(a.votes)), h("td", { class: "num" }, fmtInt(a.agreed)), h("td", { class: "num" }, pct(a.agreementRate)), h("td", { class: "num" }, fmtInt(a.abstained)))))))
          : h("p", { class: "empty" }, meta.sessionsPersist === false ? "No agreement data: sessions.persist is off, so finished consensus runs are not kept." : "No consensus verdicts recorded yet.")),
      h("section", { class: "panel" }, h("h2", {}, "Suggestions"),
        recs.length || outliers.length ? h("ul", { class: "recs" },
          outliers.map((o) => h("li", {}, h("span", { class: "kind" }, o.kind), ` ${o.provider} ${o.model}: ${o.detail}`)),
          recs.map((r) => h("li", {}, h("span", { class: "kind" }, r.target === "external" ? "external" : "config"), ` ${r.subject}: ${r.action}`, r.configKey ? h("code", {}, ` ${r.configKey}`) : null, h("span", { class: "muted" }, ` ${r.rationale}`))))
          : h("p", { class: "empty" }, "No suggestions: nothing stands out in the measured window.")),
      h("section", { class: "panel" }, h("h2", {}, "Runs per day"),
        daily.length ? [dailyChart(daily), h("p", { class: "hint" }, `${fmtInt(daily.reduce((n, d) => n + d.runs, 0))} runs, ${fmtK(daily.reduce((n, d) => n + d.tokens, 0))} tokens, ${fmtInt(daily.reduce((n, d) => n + d.errors, 0))} errors in the journal.`)]
          : h("p", { class: "empty" }, "No journaled runs yet.")),
      Array.isArray(meta.warnings) && meta.warnings.length ? h("section", { class: "panel" }, h("h2", {}, "Warnings"), h("ul", { class: "recs" }, meta.warnings.map((w) => h("li", {}, w)))) : null,
    );
  }

  api.stats().then(draw, (e) => draw({ error: `${e.message || e}. ${e.status === 401 ? "The dashboard restarted; open the URL it printed." : "Check that the dashboard process is still running."}` }));
  return { el, update: () => {}, tick: () => {} };
}
