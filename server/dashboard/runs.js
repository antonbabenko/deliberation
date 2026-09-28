"use strict";

/**
 * server/dashboard/runs.js - journal reader and run index for the local dashboard.
 *
 * Zero runtime dependencies (node builtins only). Reads the per-run JSONL files
 * core/journal.js writes, plus the legacy per-session JSON records in
 * core/sessions.js, and turns both into one filterable run index. Never
 * throws: a missing/corrupt file is skipped, not fatal (this module is read
 * by an HTTP handler, and a bad journal line must not 500 the dashboard).
 *
 * Not in the strict tsconfig include, but JSDoc-typed anyway per the task
 * brief so the shapes stay honest for the HTTP layer (Task 8) that consumes
 * this module.
 */

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { isSafeId } = require("../../core/journal.js");
const { readSession, listSessions } = require("../../core/sessions.js");

/**
 * @typedef {("running"|"done"|"converged"|"unresolved"|"error"|"abandoned")} RunStatus
 */

/**
 * @typedef {Object} RunSummary
 * @property {string} runId
 * @property {(string|null)} tool
 * @property {(string|null)} workflow
 * @property {RunStatus} status
 * @property {number} startedAt
 * @property {(number|null)} endedAt
 * @property {string[]} providers
 * @property {number} rounds
 * @property {number} errors
 * @property {number} tokens
 * @property {boolean} legacy
 */

/** @typedef {(pid: number, procStartedAt: number) => boolean} IsAliveFn */

/** Linux jiffies-per-second assumption (USER_HZ). Node has no sysconf(_SC_CLK_TCK); 100
 * is the near-universal value on modern Linux. ponytail: wrong only on an exotic kernel
 * build, upgrade to reading it from `getconf CLK_TCK` if that ever matters here. */
const LINUX_CLK_TCK = 100;
/** Tolerance (ms) between the journal's recorded procStartedAt and /proc's own start time
 * before we call it a pid-reuse mismatch. Generous because the two are computed from
 * different clocks (process uptime vs system boot time) with independent rounding.
 * ponytail: a fixed tolerance, not a proper clock-skew estimate. */
const PROC_START_TOLERANCE_MS = 60000;

/**
 * Best-effort process start time from /proc/<pid>/stat, in epoch ms. Returns null when
 * unreadable or unparseable (missing /proc, permission denied, exited between the
 * liveness check and this read). Field 22 (starttime, in clock ticks since boot) is
 * found by skipping past the last ")" in the line, because the comm field (field 2) can
 * itself contain spaces or parens.
 * @param {number} pid
 * @returns {(number|null)}
 */
function linuxProcStartedAt(pid) {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const afterComm = raw.slice(raw.lastIndexOf(")") + 1).trim();
    const fields = afterComm.split(/\s+/);
    // fields[0] is field 3 (state) of /proc/pid/stat; starttime is field 22, index 19 here.
    const starttimeTicks = Number(fields[19]);
    if (!Number.isFinite(starttimeTicks)) return null;
    const bootEpochMs = Date.now() - os.uptime() * 1000;
    return bootEpochMs + (starttimeTicks / LINUX_CLK_TCK) * 1000;
  } catch {
    return null;
  }
}

/**
 * Default `isAlive`: true when `pid` is a live process. `process.kill(pid, 0)` throws
 * ESRCH (no such process) or succeeds/throws EPERM (process exists, owned by someone
 * else - still alive). On Linux, when /proc is readable, also checks the process's own
 * start time against `procStartedAt` so a reused pid (same number, different process)
 * is not reported alive; elsewhere (or when /proc can't be read) this is pid-only - see
 * PROC_START_TOLERANCE_MS.
 * @type {IsAliveFn}
 */
function isAlive(pid, procStartedAt) {
  try {
    process.kill(pid, 0);
  } catch (e) {
    return !!(e && /** @type {NodeJS.ErrnoException} */ (e).code === "EPERM");
  }
  if (process.platform === "linux") {
    const started = linuxProcStartedAt(pid);
    if (started !== null && typeof procStartedAt === "number" && Number.isFinite(procStartedAt)) {
      if (Math.abs(started - procStartedAt) > PROC_START_TOLERANCE_MS) return false;
    }
  }
  return true;
}

/**
 * Parse complete JSONL lines from `file`, starting at byte offset `fromOffset`
 * (default 0). Stops before a trailing line with no `\n` (returned via `offset`
 * so a caller can resume from there once more bytes land) and silently skips
 * lines that are not valid JSON objects. Never throws: a missing file yields
 * `{events: [], offset: fromOffset}`.
 * @param {string} file
 * @param {number} [fromOffset]
 * @returns {{events: Record<string, unknown>[], offset: number}}
 */
function readEvents(file, fromOffset) {
  const start = typeof fromOffset === "number" && fromOffset > 0 ? fromOffset : 0;
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch {
    return { events: [], offset: start };
  }
  if (start >= buf.length) return { events: [], offset: start };
  const slice = buf.subarray(start);
  /** @type {Record<string, unknown>[]} */
  const events = [];
  let consumed = 0; // bytes of `slice` consumed by complete lines
  let lineStart = 0;
  for (let i = 0; i < slice.length; i++) {
    if (slice[i] !== 0x0a) continue; // "\n"
    const line = slice.subarray(lineStart, i).toString("utf8").trim();
    if (line) {
      try {
        const obj = JSON.parse(line);
        if (obj && typeof obj === "object") events.push(obj);
      } catch {
        // skip non-JSON line
      }
    }
    lineStart = i + 1;
    consumed = lineStart;
  }
  return { events, offset: start + consumed };
}

/**
 * Sum of `usage.totalTokens`, falling back to `promptTokens + completionTokens`.
 * @param {any} usage
 * @returns {number}
 */
function tokensOf(usage) {
  if (!usage || typeof usage !== "object") return 0;
  if (typeof usage.totalTokens === "number" && Number.isFinite(usage.totalTokens)) return usage.totalTokens;
  const p = typeof usage.promptTokens === "number" ? usage.promptTokens : 0;
  const c = typeof usage.completionTokens === "number" ? usage.completionTokens : 0;
  return p + c;
}

/**
 * Fold one run's events into a `RunSummary`. Tolerant of a run file missing
 * `run_start` (rare legacy/pruned case): `tool`/`workflow` come back null and
 * `startedAt` falls back to the earliest event seen. Never throws.
 * @param {Record<string, unknown>[]} events
 * @param {IsAliveFn} [isAliveFn]
 * @returns {RunSummary}
 */
function summarize(events, isAliveFn) {
  const list = Array.isArray(events) ? events : [];
  const aliveCheck = typeof isAliveFn === "function" ? isAliveFn : isAlive;

  let runId = "";
  /** @type {(string|null)} */
  let tool = null;
  /** @type {(string|null)} */
  let workflow = null;
  /** @type {(number|null)} */
  let pid = null;
  /** @type {(number|null)} */
  let procStartedAtVal = null;
  /** @type {(number|null)} */
  let runStartAt = null;
  /** @type {string[]} */
  let providersFromStart = [];
  /** @type {any} */
  let runEnd = null;
  let maxRound = 0;
  let tokens = 0;
  let errors = 0;
  /** @type {(number|null)} */
  let minAt = null;
  /** @type {(number|null)} */
  let lastCallEndAt = null;
  /** @type {Set<string>} */
  const callEndProviders = new Set();

  for (const e of list) {
    if (!e || typeof e !== "object") continue;
    const ev = /** @type {any} */ (e);
    if (typeof ev.runId === "string" && !runId) runId = ev.runId;
    if (typeof ev.at === "number" && Number.isFinite(ev.at)) {
      minAt = minAt === null ? ev.at : Math.min(minAt, ev.at);
    }
    switch (ev.kind) {
      case "run_start":
        if (typeof ev.tool === "string") tool = ev.tool;
        if (typeof ev.workflow === "string") workflow = ev.workflow;
        if (typeof ev.pid === "number") pid = ev.pid;
        if (typeof ev.procStartedAt === "number") procStartedAtVal = ev.procStartedAt;
        if (typeof ev.at === "number") runStartAt = ev.at;
        if (Array.isArray(ev.providers)) providersFromStart = ev.providers.filter((/** @type {any} */ p) => typeof p === "string");
        break;
      case "run_end":
        runEnd = ev;
        break;
      case "state":
      case "call_start":
        if (typeof ev.round === "number") maxRound = Math.max(maxRound, ev.round);
        break;
      case "call_end":
        if (typeof ev.round === "number") maxRound = Math.max(maxRound, ev.round);
        if (typeof ev.provider === "string") callEndProviders.add(ev.provider);
        if (ev.isError) errors += 1;
        tokens += tokensOf(ev.usage);
        if (typeof ev.at === "number") lastCallEndAt = lastCallEndAt === null ? ev.at : Math.max(lastCallEndAt, ev.at);
        break;
      default:
        break;
    }
  }

  const providers = providersFromStart.length ? providersFromStart : Array.from(callEndProviders).sort();
  // Fan-out done rule: a "fanout" run with no run_end is done once every provider
  // run_start named has a call_end.
  const fanoutDone = workflow === "fanout" && providersFromStart.length > 0
    && providersFromStart.every((p) => callEndProviders.has(p));

  /** @type {RunStatus} */
  let status;
  /** @type {(number|null)} */
  let endedAt = null;
  if (runEnd && typeof runEnd.status === "string") {
    status = /** @type {RunStatus} */ (runEnd.status);
    endedAt = typeof runEnd.at === "number" ? runEnd.at : null;
  } else if (fanoutDone) {
    status = "done";
    endedAt = lastCallEndAt;
  } else {
    status = pid !== null && aliveCheck(pid, procStartedAtVal === null ? 0 : procStartedAtVal) ? "running" : "abandoned";
  }

  return {
    runId,
    tool,
    workflow,
    status,
    startedAt: runStartAt !== null ? runStartAt : (minAt !== null ? minAt : 0),
    endedAt,
    providers,
    rounds: runEnd && typeof runEnd.rounds === "number" ? runEnd.rounds : maxRound,
    errors,
    tokens,
    legacy: false,
  };
}

/**
 * Map a legacy `core/sessions.js` record onto a `RunSummary`. Legacy records are
 * written once, on completion, so `startedAt`/`endedAt` are both `createdAt` -
 * there is no separate "still running" state to represent. `workflow` mirrors
 * `tool` (legacy records predate the workflow taxonomy).
 * @param {string} id
 * @param {import("../../core/sessions.js").SessionRecord} record
 * @returns {RunSummary}
 */
function legacySummary(id, record) {
  const tool = typeof record.tool === "string" ? record.tool : null;
  /** @type {Set<string>} */
  const providers = new Set();
  for (const op of Array.isArray(record.opinions) ? record.opinions : []) {
    if (op && typeof op.provider === "string") providers.add(op.provider);
  }
  const parsed = typeof record.createdAt === "string" ? Date.parse(record.createdAt) : NaN;
  const at = Number.isFinite(parsed) ? parsed : 0;
  /** @type {RunStatus} */
  let status = "done";
  if (tool === "consensus" && typeof record.converged === "boolean") {
    status = record.converged ? "converged" : "unresolved";
  }
  return {
    runId: id,
    tool,
    workflow: tool,
    status,
    startedAt: at,
    endedAt: at,
    providers: Array.from(providers),
    rounds: typeof record.rounds === "number" ? record.rounds : 0,
    errors: 0,
    tokens: 0,
    legacy: true,
  };
}

/**
 * @typedef {Object} RunFilter
 * @property {string} [q]  matches run_start.prompt (journal) or question (legacy); case-insensitive substring
 * @property {string} [tool]
 * @property {string} [provider]
 * @property {string} [status]
 * @property {(number|string)} [since]  epoch ms, or an ISO/Date.parse-able string; keeps runs starting at/after it
 */

/**
 * @typedef {{summary: RunSummary, events: Record<string, unknown>[]}|{summary: RunSummary, legacy: import("../../core/sessions.js").SessionRecord}} RunDetail
 */

/**
 * Build a run index over a journal dir (`core/journal.js` `.jsonl` files) and a
 * legacy sessions dir (`core/sessions.js` `.json` records). Summaries are
 * cached per file by `(size, mtimeMs)`, so a `list()`/`get()` call re-reads a
 * file only when it changed on disk.
 * @param {{runsDir: string, sessionsDir?: string, isAlive?: IsAliveFn}} opts
 * @returns {{list: (filter?: RunFilter) => RunSummary[], get: (id: string) => (RunDetail|null)}}
 */
function createRunIndex(opts) {
  const runsDir = opts.runsDir;
  const sessionsDir = opts.sessionsDir;
  const aliveCheck = typeof opts.isAlive === "function" ? opts.isAlive : isAlive;

  /** @type {Map<string, {size: number, mtimeMs: number, summary: (RunSummary|null), events: Record<string, unknown>[], searchText: string}>} */
  const journalCache = new Map();
  /** @type {Map<string, {mtimeMs: number, summary: RunSummary, searchText: string}>} */
  const legacyCache = new Map();

  /**
   * Load (or reuse a cached) journal entry for one run id. Returns undefined when
   * the file can't be stat'd (gone, a directory, etc - never thrown). A file with
   * zero parseable events (corrupt / not JSON) caches with `summary: null` so it
   * is not re-read on every call, but is excluded from the index as "not a valid
   * run".
   * @param {string} id
   * @param {string} file
   */
  function loadJournalEntry(id, file) {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      journalCache.delete(id);
      return undefined;
    }
    const cached = journalCache.get(id);
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached;
    const { events } = readEvents(file);
    /** @type {(RunSummary|null)} */
    let summary = null;
    let searchText = "";
    if (events.length > 0) {
      summary = summarize(events, aliveCheck);
      summary.runId = id; // filename is the source of truth, in case run_start is absent or mismatched
      const runStart = events.find((e) => e && typeof e === "object" && /** @type {any} */ (e).kind === "run_start");
      if (runStart && typeof (/** @type {any} */ (runStart)).prompt === "string") searchText = /** @type {any} */ (runStart).prompt;
    }
    const entry = { size: stat.size, mtimeMs: stat.mtimeMs, summary, events, searchText };
    journalCache.set(id, entry);
    return entry;
  }

  /** @returns {{summary: RunSummary, searchText: string}[]} */
  function loadLegacyEntries() {
    if (!sessionsDir) return [];
    const out = [];
    for (const e of listSessions({ dir: sessionsDir })) {
      const cached = legacyCache.get(e.id);
      if (cached && cached.mtimeMs === e.mtimeMs) {
        out.push(cached);
        continue;
      }
      const record = readSession(e.id, { dir: sessionsDir });
      if (!record) continue;
      const summary = legacySummary(e.id, record);
      const searchText = typeof record.question === "string" ? record.question : "";
      const entry = { mtimeMs: e.mtimeMs, summary, searchText };
      legacyCache.set(e.id, entry);
      out.push(entry);
    }
    return out;
  }

  /**
   * @param {{summary: RunSummary, searchText: string}} entry
   * @param {RunFilter} filter
   * @returns {boolean}
   */
  function matchesFilter(entry, filter) {
    const s = entry.summary;
    if (filter.tool && s.tool !== filter.tool) return false;
    if (filter.status && s.status !== filter.status) return false;
    if (filter.provider && s.providers.indexOf(filter.provider) === -1) return false;
    if (filter.since !== undefined && filter.since !== null) {
      const sinceMs = typeof filter.since === "number" ? filter.since : Date.parse(String(filter.since));
      if (Number.isFinite(sinceMs) && s.startedAt < sinceMs) return false;
    }
    if (filter.q) {
      const needle = String(filter.q).toLowerCase();
      if (!entry.searchText || entry.searchText.toLowerCase().indexOf(needle) === -1) return false;
    }
    return true;
  }

  /**
   * @param {RunFilter} [filter]
   * @returns {RunSummary[]}
   */
  function list(filter) {
    const f = filter && typeof filter === "object" ? filter : {};
    /** @type {string[]} */
    let names;
    try {
      names = fs.readdirSync(runsDir);
    } catch {
      names = [];
    }
    /** @type {{summary: RunSummary, searchText: string}[]} */
    const entries = [];
    /** @type {Set<string>} */
    const seenIds = new Set();
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const id = name.slice(0, -".jsonl".length);
      if (!isSafeId(id)) continue;
      const entry = loadJournalEntry(id, path.join(runsDir, name));
      if (entry && entry.summary) {
        entries.push({ summary: entry.summary, searchText: entry.searchText });
        seenIds.add(id);
      }
    }
    for (const entry of loadLegacyEntries()) {
      if (seenIds.has(entry.summary.runId)) continue; // a live journal file wins on id collision
      entries.push(entry);
    }
    return entries
      .filter((entry) => matchesFilter(entry, f))
      .map((entry) => entry.summary)
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  /**
   * @param {string} id
   * @returns {(RunDetail|null)}
   */
  function get(id) {
    if (!isSafeId(id)) return null;
    const entry = loadJournalEntry(id, path.join(runsDir, `${id}.jsonl`));
    if (entry) return entry.summary ? { summary: entry.summary, events: entry.events } : null;
    if (!sessionsDir) return null;
    const record = readSession(id, { dir: sessionsDir });
    if (!record) return null;
    return { summary: legacySummary(id, record), legacy: record };
  }

  return { list, get };
}

module.exports = { readEvents, summarize, legacySummary, createRunIndex, isAlive };
