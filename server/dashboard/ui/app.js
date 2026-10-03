// app.js - run state (the pure `reduce`), the app shell, routing, the SSE link and the
// live ticker. `reduce` and `emptyRun` touch no DOM, so node tests import this module.

import { api, store, openEvents } from "./api.js";
import { h, put, num } from "./dom.js";
import * as live from "./views/live.js";
import * as runsView from "./views/runs.js";
import * as runView from "./views/run.js";
import * as configView from "./views/config.js";
import * as statsView from "./views/stats.js";

const TERMINAL = new Set(["done", "converged", "unresolved", "error"]);

/** A run nothing is known about yet. */
export function emptyRun(runId) {
  return {
    runId, tool: null, workflow: null, expert: null, providers: [], status: "running",
    startedAt: 0, endedAt: null, lastAt: 0, seq: -1, rounds: 0, tokens: 0, errors: 0,
    prompt: undefined, stopReason: null, finalReport: undefined, dropped: [], undispatched: [], ended: false,
    states: [], calls: {}, callOrder: [], arbiter: [], events: [], erroredByKey: {},
    loaded: false, legacy: null,
  };
}

function tokensOf(usage) {
  if (!usage || typeof usage !== "object") return 0;
  if (num(usage.totalTokens) !== null) return usage.totalTokens;
  return (num(usage.promptTokens) || 0) + (num(usage.completionTokens) || 0);
}

const strings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);

// A retry is a call_start for the same (provider, role, round) after an earlier call with
// that key ended in an error; only the final attempt counts. Same rule as server/dashboard/runs.js.
const retryKey = (c) => `${c.provider}|${c.role}|${c.round}`;
const errorsOf = (calls) => Object.values(calls).filter((c) => c.isError && !c.retried).length;

function step(r, ev, at) {
  switch (ev.kind) {
    case "run_start":
      return {
        ...r,
        tool: typeof ev.tool === "string" ? ev.tool : r.tool,
        workflow: typeof ev.workflow === "string" ? ev.workflow : r.workflow,
        expert: typeof ev.expert === "string" ? ev.expert : r.expert,
        providers: [...new Set([...strings(ev.providers), ...r.providers])],
        startedAt: at,
        prompt: typeof ev.prompt === "string" ? ev.prompt : r.prompt,
        loaded: r.loaded || ev.seq === 0,
      };
    case "state": {
      const st = { state: String(ev.state || ""), round: num(ev.round), status: ev.status || null, at, verdicts: Array.isArray(ev.verdicts) ? ev.verdicts : null };
      return { ...r, states: [...r.states, st], rounds: Math.max(r.rounds, st.round || 0) };
    }
    case "call_start": {
      const id = String(ev.callId || `call-${ev.seq}`);
      const c = {
        callId: id, provider: String(ev.provider || "unknown"), model: ev.model || null, role: ev.role || null,
        round: num(ev.round), startAt: at, endAt: null, ms: null, timeoutMs: num(ev.timeoutMs),
        reasoningEffort: ev.reasoningEffort || null, request: typeof ev.request === "string" ? ev.request : undefined,
        usage: null, isError: false, errorKind: null, errorCode: null, verdict: null, criticalIssues: [], response: undefined,
      };
      const key = retryKey(c);
      const calls = { ...r.calls, [id]: c };
      const retriedId = r.erroredByKey[key];
      if (retriedId && calls[retriedId]) calls[retriedId] = { ...calls[retriedId], retried: true };
      const { [key]: _, ...erroredByKey } = r.erroredByKey;
      // A call after the server called a fan-out done (a late join) makes it live again.
      const reopened = r.workflow === "fanout" && !r.ended ? { status: "running", endedAt: null } : {};
      return {
        ...r, ...reopened, calls, erroredByKey, errors: errorsOf(calls),
        callOrder: r.calls[id] ? r.callOrder : [...r.callOrder, id], rounds: Math.max(r.rounds, c.round || 0),
      };
    }
    case "call_end": {
      const id = String(ev.callId || `call-${ev.seq}`);
      const prev = r.calls[id] || {
        callId: id, provider: String(ev.provider || "unknown"), model: null, role: null, round: null,
        startAt: at - (num(ev.ms) || 0), timeoutMs: null, reasoningEffort: null, request: undefined,
      };
      const c = {
        ...prev,
        provider: ev.provider || prev.provider, model: ev.model || prev.model, endAt: at, ms: num(ev.ms),
        usage: ev.usage || null, isError: !!ev.isError, errorKind: ev.errorKind || null, errorCode: ev.errorCode || null,
        verdict: ev.verdict || null, criticalIssues: Array.isArray(ev.criticalIssues) ? ev.criticalIssues : [],
        response: typeof ev.response === "string" ? ev.response : undefined,
      };
      const calls = { ...r.calls, [id]: c };
      // A fan-out opened by `panel` has no run_end: its status comes from the server summary.
      return {
        ...r,
        calls,
        callOrder: r.calls[id] ? r.callOrder : [...r.callOrder, id],
        erroredByKey: c.isError && r.calls[id] ? { ...r.erroredByKey, [retryKey(c)]: id } : r.erroredByKey,
        tokens: r.tokens + tokensOf(ev.usage),
        errors: errorsOf(calls),
      };
    }
    case "arbiter":
      return { ...r, arbiter: [...r.arbiter, { action: String(ev.action || ""), round: num(ev.round), verdict: ev.verdict || null, text: typeof ev.text === "string" ? ev.text : undefined, at }] };
    case "run_end":
      return {
        ...r,
        status: typeof ev.status === "string" ? ev.status : "done",
        ended: true,
        stopReason: ev.stopReason || null,
        rounds: num(ev.rounds) ?? r.rounds,
        dropped: strings(ev.droppedProviders),
        finalReport: typeof ev.finalReport === "string" ? ev.finalReport : r.finalReport,
        endedAt: at,
      };
    default:
      return r;
  }
}

/**
 * Fold one journal event into the run map. Pure: returns a new map (or the same map
 * when the event changes nothing, such as a replay of an already-applied seq).
 * @param {Record<string, any>} runs
 * @param {any} event
 * @returns {Record<string, any>}
 */
export function reduce(runs, event) {
  if (!event || typeof event !== "object" || typeof event.runId !== "string" || !event.runId) return runs;
  const prev = runs[event.runId] || emptyRun(event.runId);
  const seq = num(event.seq);
  if (seq !== null && seq <= prev.seq) return runs;
  const at = num(event.at) ?? prev.lastAt;
  const base = { ...prev, seq: seq ?? prev.seq, lastAt: Math.max(prev.lastAt, at), events: [...prev.events, event] };
  const next = step(base, event, at);
  // A skipped seq means events were missed (an SSE resume replays only the run named in
  // Last-Event-ID): mark the run unloaded so the caller fetches it again.
  const gap = prev.loaded && seq !== null && seq > prev.seq + 1;
  return { ...runs, [event.runId]: gap ? { ...next, loaded: false } : next };
}

/**
 * Apply a server RunSummary. The server's status is authoritative: it alone can tell an
 * abandoned run or a finished fan-out, and it may move a fan-out from done back to running
 * when a late call joins. Only a run_end seen live is final, so an older summary that
 * still says running cannot roll it back.
 */
export function applySummary(runs, sum) {
  if (!sum || typeof sum.runId !== "string") return runs;
  const r = runs[sum.runId] || emptyRun(sum.runId);
  const status = r.ended && TERMINAL.has(r.status) ? r.status : sum.status;
  return {
    ...runs,
    [sum.runId]: {
      ...r,
      tool: r.tool || sum.tool,
      workflow: r.workflow || sum.workflow,
      providers: r.providers.length ? r.providers : strings(sum.providers),
      startedAt: r.startedAt || sum.startedAt,
      endedAt: r.ended ? r.endedAt : sum.endedAt ?? null,
      stopReason: r.ended ? r.stopReason : sum.stopReason ?? r.stopReason ?? null,
      undispatched: strings(sum.undispatched),
      lastAt: Math.max(r.lastAt, sum.endedAt || sum.startedAt || 0),
      status,
      rounds: Math.max(r.rounds, sum.rounds || 0),
      tokens: r.loaded ? r.tokens : sum.tokens || 0,
      errors: r.loaded ? r.errors : sum.errors || 0,
      isLegacy: !!sum.legacy,
    },
  };
}

/**
 * After an SSE reconnect, Last-Event-ID resumes only the run named in the id: events other
 * runs wrote while the link was down are gone, and a run whose last events were among them
 * never gets a later event to reveal the gap. Mark every loaded run that was not terminal
 * as unloaded; `refetch` names the ones on screen, which the caller fetches now (the rest
 * load lazily). Pure.
 * @param {Record<string, any>} runs
 * @param {Iterable<string>} onScreenIds
 * @returns {{runs: Record<string, any>, refetch: string[]}}
 */
export function staleAfterReconnect(runs, onScreenIds) {
  const shown = new Set(onScreenIds);
  const out = { ...runs };
  const refetch = [];
  for (const [id, r] of Object.entries(runs)) {
    if (!r.loaded || r.legacy || TERMINAL.has(r.status)) continue;
    out[id] = { ...r, loaded: false };
    if (shown.has(id)) refetch.push(id);
  }
  return { runs: out, refetch };
}

/**
 * Compare the index poll with the loaded runs: a summary whose status differs from the
 * local one, or that is ahead of it (a later end time or more rounds), means events were
 * missed. A run that saw its own run_end is final and skipped. Call it BEFORE applySummary,
 * which overwrites the local status. Pure.
 * @param {Record<string, any>} runs
 * @param {any[]} list  RunSummary[]
 * @param {Iterable<string>} onScreenIds
 * @returns {{runs: Record<string, any>, refetch: string[]}}
 */
export function staleFromIndex(runs, list, onScreenIds) {
  const shown = new Set(onScreenIds);
  const out = { ...runs };
  const refetch = [];
  for (const s of list) {
    const r = s && runs[s.runId];
    if (!r || !r.loaded || r.legacy || r.ended) continue;
    const ahead = (num(s.endedAt) || 0) > r.lastAt || (num(s.rounds) || 0) > r.rounds;
    if (s.status === r.status && !ahead) continue;
    out[r.runId] = { ...r, loaded: false };
    if (shown.has(r.runId)) refetch.push(r.runId);
  }
  return { runs: out, refetch };
}

/**
 * Detail fetches, guarded by a reconnect epoch. A fetch that started before a reconnect
 * may hold a snapshot that misses events the dropped link lost, so its result is discarded
 * (never applied, never marks the run loaded) and, if the run is still wanted, fetched once
 * more under the new epoch. A stale in-flight promise is never handed to a caller. Failures
 * are retried at most once per `retryMs`, not on every live event. Injected I/O keeps it
 * testable without a DOM.
 * @param {{fetchRun: (id: string) => Promise<any>, get: (id: string) => any,
 *   apply: (id: string, body: any) => void, fail: (id: string, e: any) => void,
 *   settled: () => void, shown: (id: string) => boolean, now?: () => number, retryMs?: number}} io
 */
export function createLoader(io) {
  const now = io.now || Date.now;
  const retryMs = io.retryMs === undefined ? 30000 : io.retryMs;
  let epoch = 0;
  /** @type {Map<string, {epoch: number, p: Promise<void>}>} */
  const loading = new Map();
  function ensure(id) {
    const r = io.get(id);
    const cur = loading.get(id);
    if (r && (r.loaded || r.legacy)) return cur ? cur.p : Promise.resolve();
    if (cur && cur.epoch === epoch) return cur.p;
    if (r && r.loadError && now() - (r.loadErrorAt || 0) < retryMs) return Promise.resolve();
    const startEpoch = epoch;
    const entry = { epoch: startEpoch, p: Promise.resolve() };
    entry.p = io.fetchRun(id).then((body) => {
      if (startEpoch === epoch) io.apply(id, body);
    }).catch((e) => {
      if (startEpoch === epoch) io.fail(id, e);
    }).then(() => {
      if (loading.get(id) === entry) loading.delete(id);
      io.settled();
      // Discarded: the reconnect's own refetch may already be running; otherwise start one.
      if (startEpoch !== epoch && io.shown(id)) return ensure(id);
    });
    loading.set(id, entry);
    return entry.p;
  }
  return { ensure, reconnected: () => { epoch += 1; } };
}

/** The metadata-only summary of a run, as the runs index shows it. */
export function summaryOf(r) {
  return {
    runId: r.runId, tool: r.tool, workflow: r.workflow, status: r.status, startedAt: r.startedAt, endedAt: r.endedAt,
    providers: r.providers, rounds: r.rounds, errors: r.errors, tokens: r.tokens, stopReason: r.stopReason, undispatched: r.undispatched,
    legacy: !!(r.isLegacy !== undefined ? r.isLegacy : r.legacy),
  };
}

/**
 * Bound the in-memory run map to the server index. Running and kept runs stay as they
 * are; other runs the index does not list are dropped; finished runs that are not kept go back to summary only, and
 * ensureLoaded fetches them again when they are shown. Pure.
 * @param {Record<string, any>} runs
 * @param {{runId: string}[]} index
 * @param {Set<string>} keep  selected or on-screen run ids
 * @returns {Record<string, any>}
 */
export function compactRuns(runs, index, keep) {
  const listed = new Set(index.map((x) => x.runId));
  const out = {};
  for (const [id, r] of Object.entries(runs)) {
    // A live run may reach us over SSE before the index lists it: never drop or reset one.
    if (r.status === "running" || keep.has(id)) out[id] = r;
    else if (!listed.has(id)) continue;
    else if (!r.loaded) out[id] = r;
    else out[id] = { ...r, events: [], calls: {}, callOrder: [], arbiter: [], states: [], erroredByKey: {}, seq: -1, loaded: false, prompt: undefined, finalReport: undefined, legacy: null };
  }
  return out;
}

// ---------------------------------------------------------------------------- browser

const VIEWS = { live, runs: runsView, run: runView, config: configView, stats: statsView };
const MODES = [["live", "Live", "l"], ["runs", "Runs", "r"], ["config", "Config", "c"], ["stats", "Stats", "s"]];
const THEMES = ["auto", "light", "dark"];

function boot() {
  const S = {
    runs: {}, index: store.get("index", []), config: null, health: null, link: "connecting", authError: false,
    selection: null, rounds: new Map(), cursors: new Map(), panels: store.get("panels", { events: true }),
    reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)"),
  };
  if (!Array.isArray(S.index)) S.index = [];
  for (const sum of S.index) S.runs = applySummary(S.runs, sum);

  let theme = store.get("theme", "auto");
  const applyTheme = () => {
    if (theme === "auto") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    themeKey.textContent = `Theme ${theme}`;
  };

  // Shell: top bar with mode keys, capture badge, link state and theme key.
  const keys = MODES.map(([id, label, hot]) => h("a", { class: "mode-key", href: `#/${id}`, "data-mode": id, "aria-keyshortcuts": hot.toUpperCase() }, label));
  const badge = h("span", { class: "badge", title: "Content capture and PII redaction, from dashboard config" }, "capture ...");
  const link = h("span", { class: "link", role: "status" }, "link");
  const themeKey = h("button", { class: "key", type: "button", onclick: () => {
    theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
    store.set("theme", theme);
    applyTheme();
  } });
  const main = h("main", { id: "main", class: "main", tabindex: "-1" });
  const drawer = h("aside", { class: "inspector", "aria-label": "Inspector", hidden: true });
  put(document.body, 
    h("header", { class: "topbar" },
      h("span", { class: "brand" }, "deliberation"),
      h("nav", { class: "modes", "aria-label": "Mode" }, keys),
      h("div", { class: "status-line" }, badge, link, themeKey)),
    h("div", { class: "shell" }, main, drawer),
  );
  applyTheme();

  let view = null;
  let viewKey = "";
  let frame = 0;

  const ctx = {
    S,
    now: () => Date.now(),
    runList: () => Object.values(S.runs).sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0)),
    captureMode: () => (S.config && S.config.dashboard && S.config.dashboard.capture) || "metadata",
    roundFor: (id) => S.rounds.get(id) || null,
    setRound: (id, n) => { S.rounds.set(id, n); invalidate(); },
    cursorsFor: (id) => S.cursors.get(id) || {},
    setCursors: (id, a, b) => { S.cursors.set(id, { a, b }); invalidate(); },
    select: (runId, key) => {
      S.selection = key ? { runId, key } : null;
      renderDrawer();
      invalidate();
    },
    panel: (name, open) => {
      if (open === undefined) return S.panels[name] !== false;
      S.panels = { ...S.panels, [name]: open };
      store.set("panels", S.panels);
      return open;
    },
    summaryOf,
    ensureLoaded,
    invalidate,
  };

  // Re-render the drawer only when what it shows changed, keeping scroll and focus.
  let drawerSig = "";
  function renderDrawer() {
    const sel = S.selection;
    const run = sel && S.runs[sel.runId];
    drawer.hidden = !run;
    document.body.classList.toggle("has-inspector", !!run);
    if (!run) {
      drawerSig = "";
      put(drawer);
      return;
    }
    const sig = `${run.runId}|${sel.key}|${run.seq}|${run.status}|${ctx.captureMode()}`;
    if (sig === drawerSig) return;
    drawerSig = sig;
    const scrolls = [...drawer.querySelectorAll(".payload")].map((el) => el.scrollTop);
    const top = drawer.scrollTop;
    const focusables = () => [...drawer.querySelectorAll("button, [tabindex]")];
    const focusIdx = drawer.contains(document.activeElement) ? focusables().indexOf(document.activeElement) : -1;
    runView.renderInspector(drawer, ctx, run, sel.key);
    drawer.querySelectorAll(".payload").forEach((el, i) => { if (scrolls[i]) el.scrollTop = scrolls[i]; });
    drawer.scrollTop = top;
    if (focusIdx !== -1) {
      const el = focusables()[focusIdx];
      if (el) el.focus({ preventScroll: true });
    }
  }

  function invalidate() {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      badge.textContent = `capture ${ctx.captureMode()}  pii ${S.config && S.config.dashboard && S.config.dashboard.showPII ? "shown" : "redacted"}`;
      link.textContent = S.authError ? "link: token expired" : `link ${S.link}`;
      link.dataset.link = S.authError ? "down" : S.link;
      if (view && view.update) view.update();
      if (S.selection) renderDrawer();
      ensureTicker();
    });
  }

  function route() {
    const parts = (location.hash || "#/live").replace(/^#\/?/, "").split("/");
    const mode = VIEWS[parts[0]] && parts[0] !== "run" ? parts[0] : "live";
    let key = mode;
    if (mode === "runs" && parts[1]) {
      try {
        key = `run:${decodeURIComponent(parts[1])}`;
      } catch {
        location.hash = "#/runs";
        return;
      }
    }
    for (const k of keys) {
      if (k.dataset.mode === mode) k.setAttribute("aria-current", "page");
      else k.removeAttribute("aria-current");
    }
    if (key === viewKey) return;
    if (view && view.destroy) view.destroy();
    viewKey = key;
    const mod = key.startsWith("run:") ? runView : VIEWS[mode];
    view = mod.create(ctx, key.startsWith("run:") ? key.slice(4) : undefined);
    put(main, view.el);
    if (view.update) view.update();
    if (key.startsWith("run:")) store.set("selectedRun", key.slice(4));
  }

  // Detail loading: fold the fetched journal, then replay any live events newer than it.
  const loader = createLoader({
    fetchRun: (id) => api.run(id),
    get: (id) => S.runs[id],
    apply: (id, body) => {
      const cur = S.runs[id] || emptyRun(id);
      if (body && Array.isArray(body.events)) {
        let fresh = body.events.reduce((acc, e) => reduce(acc, e), { [id]: emptyRun(id) });
        for (const e of cur.events) fresh = reduce(fresh, e);
        fresh = applySummary(fresh, body.summary);
        S.runs = { ...S.runs, [id]: { ...fresh[id], loaded: true } };
      } else if (body && body.legacy) {
        S.runs = applySummary({ ...S.runs, [id]: { ...cur, legacy: body.legacy, loaded: true, loadError: undefined } }, body.summary);
      }
    },
    fail: (id, e) => {
      if (e && e.status === 401) S.authError = true;
      S.runs = { ...S.runs, [id]: { ...(S.runs[id] || emptyRun(id)), loadError: String((e && e.message) || e), loadErrorAt: Date.now() } };
    },
    settled: () => invalidate(),
    shown: (id) => onScreen().has(id),
  });
  function ensureLoaded(id) {
    return loader.ensure(id);
  }

  const onScreen = () => {
    const ids = new Set(view && view.runIds ? view.runIds() : []);
    if (S.selection) ids.add(S.selection.runId);
    return ids;
  };

  function setIndex(list) {
    S.index = list;
    const keep = onScreen();
    S.runs = compactRuns(S.runs, list, keep);
    const stale = staleFromIndex(S.runs, list, keep);
    S.runs = stale.runs;
    for (const m of [S.rounds, S.cursors]) for (const id of m.keys()) if (!S.runs[id]) m.delete(id);
    for (const sum of list) S.runs = applySummary(S.runs, sum);
    store.set("index", list.slice(0, 200).map(summaryOf));
    stale.refetch.forEach(ensureLoaded);
  }

  // A fan-out's done status is the server's call (runs.js deriveStatus), so ask for it soon
  // after an answer lands instead of waiting for the 15 s index poll.
  let soon = 0;
  const refreshSoon = () => {
    clearTimeout(soon);
    soon = setTimeout(() => refreshIndex(), 1000);
  };

  function onEvent(e) {
    const before = S.runs[e.runId];
    S.runs = reduce(S.runs, e);
    const after = S.runs[e.runId];
    if (after && !after.loaded && e.kind !== "run_start") ensureLoaded(e.runId);
    if (after && after.workflow === "fanout" && e.kind === "call_end") refreshSoon();
    if (after && after !== before) {
      const i = S.index.findIndex((x) => x.runId === e.runId);
      const sum = summaryOf(after);
      S.index = i === -1 ? [sum, ...S.index] : S.index.map((x, j) => (j === i ? sum : x));
    }
    invalidate();
  }

  // Live link first, so nothing between the index fetch and the subscription is lost.
  // A CLOSED EventSource (a 401 after a dashboard restart) never retries on its own: the
  // index poll re-opens it, backing off from 15 s to 4 min. Every open after the first
  // (this one or the browser's own retry) marks the non-terminal runs unloaded, because
  // events sent while the link was down are gone.
  let ready = false;
  const early = [];
  let closeEvents = null;
  let reopenDelay = 15000;
  let reopenAt = 0;
  let wasUp = false;
  // Every open after the first, whether the browser re-opened it or connect() did.
  function onReconnect() {
    loader.reconnected();
    const stale = staleAfterReconnect(S.runs, onScreen());
    S.runs = stale.runs;
    stale.refetch.forEach(ensureLoaded);
  }
  function connect() {
    if (closeEvents) closeEvents();
    closeEvents = openEvents((e) => (ready ? onEvent(e) : early.push(e)), (state) => {
      S.link = state;
      if (state === "up") {
        reopenDelay = 15000;
        if (wasUp) onReconnect();
        wasUp = true;
      }
      invalidate();
    });
  }
  connect();

  const refreshIndex = () => api.runs().then((body) => {
    S.authError = false;
    setIndex(Array.isArray(body && body.runs) ? body.runs : []);
    if (S.link === "down" && Date.now() >= reopenAt) {
      reopenAt = Date.now() + reopenDelay;
      reopenDelay = Math.min(reopenDelay * 2, 240000);
      connect();
    }
    invalidate();
  }).catch((e) => {
    if (e && e.status === 401) S.authError = true;
    invalidate();
  });
  const refreshHealth = () => api.health().then((body) => { S.health = body; invalidate(); }).catch(() => {});

  Promise.all([refreshIndex(), api.config().then((c) => { S.config = c; }).catch(() => {})]).then(() => {
    const list = ctx.runList();
    for (const r of list.filter((x) => x.status === "running")) ensureLoaded(r.runId);
    if (list[0]) ensureLoaded(list[0].runId);
    ready = true;
    for (const e of early.splice(0)) onEvent(e);
  });
  refreshHealth();
  setInterval(refreshIndex, 15000);
  setInterval(refreshHealth, 30000);

  window.addEventListener("hashchange", route);
  window.addEventListener("keydown", (e) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName))) return;
    if (e.key === "Escape" && S.selection) return ctx.select(null, null);
    const mode = MODES.find((m) => m[2] === e.key.toLowerCase());
    if (mode && !e.shiftKey) location.hash = `#/${mode[0]}`;
  });
  let resizeFrame = 0;
  window.addEventListener("resize", () => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => view && view.update && view.update());
  });

  // The ticker runs only while some run is running. It redraws the growing trace every
  // 100 ms; under reduced motion it only advances the elapsed readout once a second, and
  // the graph redraws when events arrive.
  let ticking = false;
  let last = 0;
  function ensureTicker() {
    if (ticking || !Object.values(S.runs).some((r) => r.status === "running")) return;
    ticking = true;
    requestAnimationFrame(loop);
  }
  function loop(t) {
    const reduced = S.reducedMotion.matches;
    if (t - last >= (reduced ? 1000 : 100)) {
      last = t;
      if (!Object.values(S.runs).some((r) => r.status === "running")) {
        ticking = false;
        return;
      }
      if (view && view.tick && !document.hidden) view.tick(Date.now(), !reduced);
    }
    requestAnimationFrame(loop);
  }

  route();
}

if (typeof document !== "undefined" && typeof window !== "undefined") boot();
