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
const { redactString } = require("../../core/redact.js");
// The loop store's TTL: past it a consensus-step loop's state is gone, so the host cannot resume it.
const { DEFAULT_TTL_MS: STEP_TTL_MS } = require("../../core/loop-store.js");

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
 * @property {any} [provenance]
 * @property {any} [configId]
 * @property {any} [activationId]
 * @property {number} [tokenCoverage]
 * @property {number} [reused]
 * @property {number} [retries]
 * @property {number} [attempts]
 * @property {number} tokens
 * @property {boolean} legacy
 * @property {(string|null)} stopReason
 * @property {string[]} [undispatched]  a quiet fan-out's listed providers that were never called
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
 * `{events: [], offset: fromOffset, offsets: []}`.
 *
 * `offsets[i]` is the absolute byte offset just past the line that produced
 * `events[i]` - one per event, in order - so a caller that needs a resume
 * point per event (the dashboard's SSE tailer) doesn't have to re-parse lines
 * itself.
 *
 * Reads only the bytes from `fromOffset` to EOF (`fs.openSync` + `fstatSync` +
 * `readSync`, not `readFileSync` of the whole file) - this is the SSE
 * tailer's hot path, called once per subscriber on every sweep tick, so a
 * multi-MB content-capture journal must not be re-read whole each time.
 * @param {string} file
 * @param {number} [fromOffset]
 * @returns {{events: Record<string, unknown>[], offset: number, offsets: number[]}}
 */
function readEvents(file, fromOffset) {
  const start = typeof fromOffset === "number" && fromOffset > 0 ? fromOffset : 0;
  let fd;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return { events: [], offset: start, offsets: [] };
  }
  let slice;
  try {
    let size;
    try {
      size = fs.fstatSync(fd).size;
    } catch {
      return { events: [], offset: start, offsets: [] };
    }
    if (start >= size) return { events: [], offset: start, offsets: [] };
    const buf = Buffer.allocUnsafe(size - start);
    let bytesRead;
    try {
      bytesRead = fs.readSync(fd, buf, 0, buf.length, start);
    } catch {
      return { events: [], offset: start, offsets: [] };
    }
    slice = buf.subarray(0, bytesRead);
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // already closed
    }
  }
  /** @type {Record<string, unknown>[]} */
  const events = [];
  /** @type {number[]} */
  const offsets = [];
  let consumed = 0; // bytes of `slice` consumed by complete lines
  let lineStart = 0;
  for (let i = 0; i < slice.length; i++) {
    if (slice[i] !== 0x0a) continue; // "\n"
    const line = slice.subarray(lineStart, i).toString("utf8").trim();
    if (line) {
      try {
        const obj = JSON.parse(line);
        if (obj && typeof obj === "object") {
          events.push(obj);
          offsets.push(start + i + 1);
        }
      } catch {
        // skip non-JSON line
      }
    }
    lineStart = i + 1;
    consumed = lineStart;
  }
  return { events, offset: start + consumed, offsets };
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

/** A fan-out with no call in flight and no event for this long is done; the providers
 * it never dispatched are reported as `undispatched`. */
const QUIET_MS = 60000;
/** A fan-out that has dispatched nothing this long after run_start was abandoned. */
const NEVER_DISPATCHED_MS = 20 * 60 * 1000;

/** @param {any} v @returns {(number|null)} */
const numOr = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * @typedef {Object} DerivedStatus
 * @property {RunStatus} status
 * @property {(number|null)} endedAt
 * @property {(string|null)} stopReason
 * @property {string[]} [undispatched]  fan-out only: listed providers that were never called
 */

/**
 * A run's status at time `now`. Pure apart from `isAliveFn`, which is consulted only by the
 * last rule. In order:
 *   1. a run_end gives the status (and stopReason);
 *   2. a `fanout` is done once every provider run_start lists has a LATEST call (by
 *      callId, so a retry in flight after an errored attempt keeps it open) with a call_end;
 *   3. a `fanout` with at least one call_start, none of them still open, and no event for
 *      QUIET_MS is done, with the providers it never called as `undispatched`;
 *   4. a `fanout` with no call_start NEVER_DISPATCHED_MS after it started is abandoned
 *      ("never-dispatched");
 *   5. a `consensus-step` whose last event is older than the loop store's TTL is abandoned
 *      ("expired"): the host stopped driving it and the loop state is gone;
 *   6. otherwise the run is running while its writer pid is alive, else abandoned.
 * @param {Record<string, unknown>[]} events
 * @param {number} now  epoch ms
 * @param {IsAliveFn} [isAliveFn]
 * @returns {DerivedStatus}
 */
function deriveStatus(events, now, isAliveFn) {
  const aliveCheck = typeof isAliveFn === "function" ? isAliveFn : isAlive;
  /** @type {any} */
  let start = null;
  /** @type {any} */
  let end = null;
  /** @type {(number|null)} */
  let lastAt = null;
  /** @type {(number|null)} */
  let minAt = null;
  /** @type {Map<string, {started: boolean, ended: boolean, endAt: (number|null)}>} */
  const calls = new Map();
  /** @type {Map<string, string>} provider -> its latest callId */
  const latest = new Map();
  for (const e of Array.isArray(events) ? events : []) {
    if (!e || typeof e !== "object") continue;
    const ev = /** @type {any} */ (e);
    const at = numOr(ev.at);
    if (at !== null) {
      lastAt = lastAt === null ? at : Math.max(lastAt, at);
      minAt = minAt === null ? at : Math.min(minAt, at);
    }
    if (ev.kind === "run_start") start = ev;
    else if (ev.kind === "run_end") end = ev;
    else if (ev.kind === "call_start" || ev.kind === "call_end") {
      const id = typeof ev.callId === "string" ? ev.callId : `seq-${ev.seq}`;
      const c = calls.get(id) || { started: false, ended: false, endAt: null };
      calls.set(id, c);
      const provider = typeof ev.provider === "string" ? ev.provider : "";
      if (ev.kind === "call_start") {
        c.started = true;
        latest.set(provider, id);
      } else {
        c.ended = true;
        c.endAt = at;
        if (!latest.has(provider)) latest.set(provider, id);
      }
    }
  }
  if (end) {
    return {
      status: /** @type {RunStatus} */ (typeof end.status === "string" ? end.status : "done"),
      endedAt: numOr(end.at),
      stopReason: typeof end.stopReason === "string" ? end.stopReason : null,
    };
  }
  const workflow = start && typeof start.workflow === "string" ? start.workflow : null;
  if (workflow === "fanout") {
    const listed = Array.isArray(start.providers) ? start.providers.filter((/** @type {any} */ p) => typeof p === "string") : [];
    const latestCalls = listed.map((/** @type {string} */ p) => (latest.has(p) ? calls.get(/** @type {string} */ (latest.get(p))) : undefined));
    if (listed.length && latestCalls.every((/** @type {any} */ c) => c && c.ended)) {
      const ends = latestCalls.map((/** @type {any} */ c) => c.endAt).filter((/** @type {any} */ x) => x !== null);
      return { status: "done", endedAt: ends.length ? Math.max(...ends) : lastAt, stopReason: null };
    }
    const started = [...calls.values()].filter((c) => c.started);
    if (started.length && started.every((c) => c.ended) && lastAt !== null && now - lastAt >= QUIET_MS) {
      return { status: "done", endedAt: lastAt, stopReason: null, undispatched: listed.filter((/** @type {string} */ p) => !latest.has(p)) };
    }
    const startedAt = numOr(start.at) ?? minAt;
    if (!started.length && startedAt !== null && now - startedAt > NEVER_DISPATCHED_MS) {
      return { status: "abandoned", endedAt: null, stopReason: "never-dispatched" };
    }
  }
  if (workflow === "consensus-step" && lastAt !== null && now - lastAt > STEP_TTL_MS) {
    return { status: "abandoned", endedAt: null, stopReason: "expired" };
  }
  const pid = start ? numOr(start.pid) : null;
  // NaN, not 0, when run_start carried no procStartedAt: 0 is finite and would pass
  // isAlive's Number.isFinite guard, enabling the pid-reuse check against epoch 0 and
  // reporting a live pid as abandoned. NaN makes isAlive fall back to pid-only liveness.
  const procStarted = start ? numOr(start.procStartedAt) : null;
  const alive = pid !== null && aliveCheck(pid, procStarted === null ? NaN : procStarted);
  return { status: alive ? "running" : "abandoned", endedAt: null, stopReason: null };
}

/**
 * Fold the time-independent part of a run's summary: everything but the status fields
 * (deriveStatus). Tolerant of a run file missing `run_start` (rare legacy/pruned case):
 * `tool`/`workflow` come back null and `startedAt` falls back to the earliest event seen.
 *
 * `errors` counts a call's final attempt only. A retry is a call_start for the same
 * (provider, role, round) that begins after an earlier call with that key ended in an
 * error; that earlier error no longer counts. Two legs that overlap in time (a
 * consensus round's concurrent arbiter calls) are separate calls. Never throws.
 * @param {Record<string, unknown>[]} events
 * @returns {Omit<RunSummary, "status"|"endedAt"|"stopReason"|"undispatched">}
 */
function foldRun(events) {
  let runId = "";
  /** @type {(string|null)} */
  let tool = null;
  /** @type {(string|null)} */
  let workflow = null;
  /** @type {(number|null)} */
  let runStartAt = null;
  /** @type {string[]} */
  let providersFromStart = [];
  /** @type {any} */
  let runEnd = null;
  let maxRound = 0;
  let tokens = 0;
  let tokenCoverage=0,reused=0,attempts=0,retries=0;
  /** @type {any} */ let provenance=null;
  /** @type {(number|null)} */
  let minAt = null;
  /** @type {Set<string>} */
  const callEndProviders = new Set();
  /** @type {Map<string, string>} callId -> retry key */
  const keyOf = new Map();
  /** @type {Map<string, string>} retry key -> the errored callId a retry would replace */
  const erroredByKey = new Map();
  /** @type {Set<string>} */
  const errored = new Set();

  for (const e of Array.isArray(events) ? events : []) {
    if (!e || typeof e !== "object") continue;
    const ev = /** @type {any} */ (e);
    if (typeof ev.runId === "string" && !runId) runId = ev.runId;
    const at = numOr(ev.at);
    if (at !== null) minAt = minAt === null ? at : Math.min(minAt, at);
    const callId = typeof ev.callId === "string" ? ev.callId : `seq-${ev.seq}`;
    switch (ev.kind) {
      case "run_start":
        provenance=require("../../core/config-history.js").safeProvenance(ev);
        if (typeof ev.tool === "string") tool = ev.tool;
        if (typeof ev.workflow === "string") workflow = ev.workflow;
        if (at !== null) runStartAt = at;
        if (Array.isArray(ev.providers)) providersFromStart = ev.providers.filter((/** @type {any} */ p) => typeof p === "string");
        break;
      case "run_end":
        runEnd = ev;
        break;
      case "state":
        if (typeof ev.round === "number") maxRound = Math.max(maxRound, ev.round);
        break;
      case "call_start": {
        attempts++;
        if (typeof ev.round === "number") maxRound = Math.max(maxRound, ev.round);
        const key = `${ev.provider}|${ev.role}|${ev.round}`;
        keyOf.set(callId, key);
        const prev = erroredByKey.get(key);
        if (prev !== undefined) {
          retries++;
          errored.delete(prev);
          erroredByKey.delete(key);
        }
        break;
      }
      case "call_end":
        if (typeof ev.round === "number") maxRound = Math.max(maxRound, ev.round);
        if (typeof ev.provider === "string") callEndProviders.add(ev.provider);
        if (ev.isError) {
          errored.add(callId);
          const key = keyOf.get(callId);
          if (key !== undefined) erroredByKey.set(key, callId);
        }
        if(ev.cached)reused++;
        else {tokens += tokensOf(ev.usage);if(ev.usage)tokenCoverage++;}
        break;
      default:
        break;
    }
  }

  return {
    runId,
    tool,
    workflow,
    startedAt: runStartAt !== null ? runStartAt : (minAt !== null ? minAt : 0),
    providers: providersFromStart.length ? providersFromStart : Array.from(callEndProviders).sort(),
    rounds: runEnd && typeof runEnd.rounds === "number" ? runEnd.rounds : maxRound,
    errors: errored.size,
    tokens,
    legacy: false,
    provenance,configId:provenance?.configId||null,activationId:provenance?.activationId||null,tokenCoverage,reused,attempts,retries,
  };
}

/**
 * Fold one run's events into a `RunSummary` as of `now`. Never throws.
 * @param {Record<string, unknown>[]} events
 * @param {IsAliveFn} [isAliveFn]
 * @param {number} [now]  epoch ms, default Date.now()
 * @returns {RunSummary}
 */
function summarize(events, isAliveFn, now = Date.now()) {
  return { ...foldRun(events), ...deriveStatus(events, now, isAliveFn) };
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
    runId: isSafeId(record.runId)?record.runId:id,
    provenance:require("../../core/config-history.js").safeProvenance(record.provenance),
    configId:record.provenance?.configId||null,activationId:record.provenance?.activationId||null,
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
    stopReason: null,
  };
}

/**
 * @typedef {Object} RunFilter
 * @property {string} [q]  matches run_start.prompt (journal) or question (legacy); case-insensitive substring
 * @property {boolean} [metadataOnly]  match `q` against runId, tool and providers only, never prompt/question text
 * @property {boolean} [redacted]  match `q` against the PII-redacted text, so a search cannot confirm a masked value
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
 * legacy sessions dir (`core/sessions.js` `.json` records). Events and the
 * time-independent summary fields are cached per file by `(size, mtimeMs)`, so a
 * `list()`/`get()` call re-reads a file only when it changed on disk. The status of
 * a run with no run_end depends on the clock and on its writer pid, so it is derived
 * again on every read (deriveStatus). ponytail: one liveness probe per open run per
 * read; cache it for a few seconds if the index ever grows past a few hundred runs.
 * @param {{runsDir: string, sessionsDir?: string, isAlive?: IsAliveFn, now?: () => number, maxRecords?:number,maxFileBytes?:number}} opts
 * @returns {{list: (filter?: RunFilter) => RunSummary[], get: (id: string) => (RunDetail|null), cacheSize: () => number, truncated:()=>boolean}}
 */
function createRunIndex(opts) {
  const maxRecords=opts.maxRecords??Infinity,maxFileBytes=opts.maxFileBytes??Infinity;
  let truncated=false;
  const runsDir = opts.runsDir;
  const sessionsDir = opts.sessionsDir;
  const aliveCheck = typeof opts.isAlive === "function" ? opts.isAlive : isAlive;
  const now = typeof opts.now === "function" ? opts.now : Date.now;

  /**
   * @typedef {{searchText: string, redactedText?: string}} Searchable
   * @typedef {Searchable & {size: number, mtimeMs: number, base: (ReturnType<typeof foldRun>|null), fixed: (DerivedStatus|null), events: Record<string, unknown>[]}} JournalEntry
   */
  /** @type {Map<string, JournalEntry>} */
  const journalCache = new Map();
  /** @type {Map<string, Searchable & {mtimeMs: number, summary: RunSummary}>} */
  const legacyCache = new Map();

  /**
   * The entry's summary as of now. Null for a file with no valid events.
   * @param {JournalEntry} entry
   * @returns {(RunSummary|null)}
   */
  function journalSummary(entry) {
    if (!entry.base) return null;
    return { ...entry.base, ...(entry.fixed || deriveStatus(entry.events, now(), aliveCheck)) };
  }

  /**
   * @param {Searchable} entry
   * @param {boolean} redacted
   * @returns {string}
   */
  function searchTextOf(entry, redacted) {
    if (!redacted) return entry.searchText;
    if (entry.redactedText === undefined) entry.redactedText = redactString(entry.searchText);
    return entry.redactedText;
  }

  /**
   * Load (or reuse a cached) journal entry for one run id. Returns undefined when
   * the file can't be stat'd (gone, a directory, etc - never thrown). A file with
   * zero parseable events (corrupt / not JSON) caches with `base: null` so it
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
    if (!stat.isFile() || stat.size > maxFileBytes) { truncated = true; return undefined; }
    const cached = journalCache.get(id);
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached;
    const { events } = readEvents(file);
    /** @type {JournalEntry} */
    const entry = { size: stat.size, mtimeMs: stat.mtimeMs, base: null, fixed: null, events, searchText: "" };
    if (events.length > 0) {
      entry.base = { ...foldRun(events), runId: id }; // filename is the source of truth, in case run_start is absent or mismatched
      // A run_end makes the status time-independent, so it is cached with the rest.
      if (events.some((e) => e && /** @type {any} */ (e).kind === "run_end")) entry.fixed = deriveStatus(events, 0, aliveCheck);
      const runStart = events.find((e) => e && typeof e === "object" && /** @type {any} */ (e).kind === "run_start");
      if (runStart && typeof (/** @type {any} */ (runStart)).prompt === "string") entry.searchText = /** @type {any} */ (runStart).prompt;
    }
    journalCache.set(id, entry);
    return entry;
  }

  /** @returns {(Searchable & {summary: RunSummary})[]} */
  function loadLegacyEntries() {
    if (!sessionsDir) return [];
    const out = [];
    const sessions = listSessions({ dir: sessionsDir });
    // Evict cache entries for ids no longer in the sessions dir before reading it -
    // a long-running dashboard process must not accumulate one entry per record it
    // has ever seen (deleted/pruned legacy records leak forever otherwise).
    const currentIds = new Set(sessions.map((e) => e.id));
    for (const id of legacyCache.keys()) {
      if (!currentIds.has(id)) legacyCache.delete(id);
    }
    if (sessions.length > maxRecords) truncated = true;
    for (const e of sessions.slice(0,maxRecords)) {
      const cached = legacyCache.get(e.id);
      if (cached && cached.mtimeMs === e.mtimeMs) {
        out.push(cached);
        continue;
      }
      const record = readSession(e.id, { dir: sessionsDir });
      if (!record) continue;
      const summary = legacySummary(e.id, record);
      const searchText = typeof record.question === "string" ? record.question : "";
      const entry = { mtimeMs: e.mtimeMs, summary, searchText,sessionId:e.id };
      legacyCache.set(e.id, entry);
      out.push(entry);
    }
    return out;
  }

  /**
   * @param {RunSummary} s
   * @param {Searchable} entry
   * @param {RunFilter} filter
   * @returns {boolean}
   */
  function matchesFilter(s, entry, filter) {
    if (filter.tool && s.tool !== filter.tool) return false;
    if (filter.status && s.status !== filter.status) return false;
    if (filter.provider && s.providers.indexOf(filter.provider) === -1) return false;
    if (filter.since !== undefined && filter.since !== null) {
      const sinceMs = typeof filter.since === "number" ? filter.since : Date.parse(String(filter.since));
      if (Number.isFinite(sinceMs) && s.startedAt < sinceMs) return false;
    }
    if (filter.q) {
      const needle = String(filter.q).toLowerCase();
      const text = filter.metadataOnly ? [s.runId, s.tool, ...s.providers].join(" ") : searchTextOf(entry, !!filter.redacted);
      if (!text || text.toLowerCase().indexOf(needle) === -1) return false;
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
    /** @type {{summary: RunSummary, entry: Searchable}[]} */
    const entries = [];
    /** @type {Set<string>} */
    const seenIds = new Set();
    /** @type {Set<string>} */
    const currentJournalIds = new Set();
    if(Number.isFinite(maxRecords)) {
      names=names.filter(n=>n.endsWith('.jsonl')).map(n=>{try{return {n,at:fs.statSync(path.join(runsDir,n)).mtimeMs};}catch{return {n,at:0};}}).sort((a,b)=>b.at-a.at).map(f=>f.n);
      if(names.length>maxRecords)truncated=true;names=names.slice(0,maxRecords);
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const id = name.slice(0, -".jsonl".length);
      if (!isSafeId(id)) continue;
      currentJournalIds.add(id);
      const entry = loadJournalEntry(id, path.join(runsDir, name));
      const summary = entry ? journalSummary(entry) : null;
      if (entry && summary) {
        entries.push({ summary, entry });
        seenIds.add(id);
      }
    }
    // Evict cache entries for run files no longer on disk - see loadLegacyEntries
    // for the same rule on the legacy side.
    for (const id of journalCache.keys()) {
      if (!currentJournalIds.has(id)) journalCache.delete(id);
    }
    for (const entry of loadLegacyEntries()) {
      if (seenIds.has(entry.summary.runId)) continue; // a live journal file wins on id collision
      entries.push({ summary: entry.summary, entry });
    }
    return entries
      .filter((x) => matchesFilter(x.summary, x.entry, f))
      .map((x) => x.summary)
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  /**
   * @param {string} id
   * @returns {(RunDetail|null)}
   */
  function get(id) {
    if (!isSafeId(id)) return null;
    const entry = loadJournalEntry(id, path.join(runsDir, `${id}.jsonl`));
    // A journal entry with a summary wins outright. One with no summary (the file
    // exists but is empty/corrupt - see loadJournalEntry) is NOT a valid run, but the
    // id may still name a legacy session record, exactly as list() already falls
    // back to the legacy store for ids the journal doesn't have - so fall through
    // instead of returning null here.
    const summary = entry ? journalSummary(entry) : null;
    if (entry && summary) return { summary, events: entry.events };
    if (!sessionsDir) return null;
    const record = readSession(id, { dir: sessionsDir }) || (()=>{const e=loadLegacyEntries().find(e=>e.summary.runId===id);return e?readSession(/** @type {any} */(e).sessionId,{dir:sessionsDir}):null;})();
    if (!record) return null;
    return { summary: legacySummary(id, record), legacy: record };
  }

  /** Combined journal + legacy cache entry count. Test/debug only - not part of
   * the documented interface, exposed so a leak test can assert it shrinks.
   * @returns {number} */
  function cacheSize() {
    return journalCache.size + legacyCache.size;
  }

  return { list, get, cacheSize,truncated:()=>truncated };
}

module.exports = { readEvents, summarize, deriveStatus, legacySummary, createRunIndex, isAlive, QUIET_MS, NEVER_DISPATCHED_MS };
