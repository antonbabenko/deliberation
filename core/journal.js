"use strict";

/**
 * core/journal.js - per-run JSONL journal writer for the local dashboard.
 *
 * Zero runtime dependencies (node builtins only). SYNCHRONOUS, same style as
 * core/sessions.js and core/debug-log.js. One file per run at
 * `<dir>/<runId>.jsonl`, dir mode 0700, file mode 0600. Each line is one JSON
 * event envelope `{ v:1, kind, runId, at, seq, ...fields }`.
 *
 * Journaling must NEVER throw into a delegation: every public method is
 * failure-isolated the same way debug-log.js is. `getSettings()` is read on
 * every `emit` call so a config hot-reload takes effect immediately, and it is
 * itself wrapped so a throwing settings reader cannot break a caller.
 *
 * Content fields (prompt/request/response/text/finalReport, and
 * criticalIssues[].description) are written ONLY when the resolved
 * `capture === "content"`, and always pass through `scrubSecrets` then
 * `capText` first - same privacy contract as core/sessions.js.
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { scrubSecrets, capText } = require("./sessions.js");

/** Anchored id guard: rejects `../`, dots, slashes - no path traversal via runId. */
const ID_RE = /^[A-Za-z0-9-]+$/;

const DEFAULT_MAX_RUNS = 200;
const DEFAULT_MAX_AGE_DAYS = 30;

/**
 * @typedef {("run_start"|"state"|"call_start"|"call_end"|"arbiter"|"run_end")} JournalKind
 */

/**
 * @typedef {Object} DashboardSettings
 * @property {boolean} enabled
 * @property {("metadata"|"content")} capture
 * @property {boolean} showPII
 * @property {number} port
 * @property {number} maxRuns
 * @property {number} maxAgeDays
 */

/**
 * @typedef {Object} Journal
 * @property {() => boolean} enabled
 * @property {() => string} newRunId
 * @property {(runId: string, kind: JournalKind, fields: Record<string, unknown>) => void} emit
 * @property {() => void} prune
 */

/**
 * The exact per-kind field whitelist from the spec's "Journal format" table
 * (docs/superpowers/specs/2026-09-28-dashboard-design.md). `meta` fields are
 * always eligible; `content` fields are written only under `capture:"content"`.
 * The two `criticalIssues[].*` entries are not plain object keys - `emit`
 * special-cases them to split each critical issue into its category (meta)
 * and description (content) parts.
 * @type {Record<JournalKind, {meta: readonly string[], content: readonly string[]}>}
 */
const JOURNAL_KEYS = Object.freeze({
  run_start: Object.freeze({
    meta: Object.freeze(["tool", "pid", "procStartedAt", "expert", "workflow", "providers", "configId", "activationId", "runtimeId", "firstSeenAt", "activatedAt", "snapshot", "configLoadState", "project"]),
    content: Object.freeze(["prompt"]),
  }),
  state: Object.freeze({
    meta: Object.freeze(["state", "round", "status", "verdicts"]),
    content: Object.freeze([]),
  }),
  call_start: Object.freeze({
    meta: Object.freeze(["callId", "provider", "model", "role", "round", "timeoutMs", "reasoningEffort", "settings", "configuredTimeoutMs", "deadlineAt", "limitingReason", "promptChars", "fileCount", "orientationFiles", "fileBytes", "grantedMs", "hostCapMs", "ceilingSource", "sharedBy", "sharedLimitMs"]),
    content: Object.freeze(["request"]),
  }),
  call_end: Object.freeze({
    meta: Object.freeze(["callId", "provider", "model", "ms", "usage", "isError", "errorKind", "errorCode", "verdict", "criticalIssues[].category", "cached", "provenance", "reasoningEffort"]),
    content: Object.freeze(["response", "criticalIssues[].description"]),
  }),
  arbiter: Object.freeze({
    meta: Object.freeze(["action", "round", "verdict", "decisions[].source", "decisions[].category", "decisions[].action"]),
    content: Object.freeze(["text", "decisions[].description", "decisions[].reason"]),
  }),
  run_end: Object.freeze({
    meta: Object.freeze(["status", "stopReason", "rounds", "droppedProviders", "undispatched"]),
    content: Object.freeze(["finalReport"]),
  }),
});

/**
 * The MCP process start time, computed from the current uptime. Injected into
 * every `run_start` event as `procStartedAt` (abandoned-run detection compares
 * this against the live process's own uptime - a pid whose start time differs
 * means the pid was reused by an unrelated process).
 * @returns {number} epoch ms
 */
function procStartedAt() {
  return Math.round(Date.now() - process.uptime() * 1000);
}

/**
 * True only for a non-empty id matching the anchored safe-id shape.
 * @param {unknown} id
 * @returns {id is string}
 */
function isSafeId(id) {
  return typeof id === "string" && ID_RE.test(id);
}

/**
 * `-1` means unlimited; any other non-positive or non-integer value falls
 * back to `def`. Mirrors core/sessions.js pruneSessions.
 * @param {unknown} v
 * @param {number} def
 * @returns {number}
 */
function normalizeLimit(v, def) {
  return typeof v === "number" && Number.isInteger(v) && (v === -1 || v > 0) ? v : def;
}

/**
 * Best-effort, ENOENT-tolerant delete.
 * @param {string} file
 * @returns {void}
 */
function removeFile(file) {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // best-effort
  }
}

/**
 * List run journal files (`<dir>/<runId>.jsonl`) newest-first by mtime. A
 * missing dir yields []. Best-effort: a file that disappears mid-listing, or
 * an id that fails the safe-id guard, is skipped.
 * @param {string} dir
 * @returns {{id: string, file: string, mtimeMs: number}[]}
 */
function listRunFiles(dir) {
  /** @type {string[]} */
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  /** @type {{id: string, file: string, mtimeMs: number}[]} */
  const out = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const id = name.slice(0, -".jsonl".length);
    if (!isSafeId(id)) continue;
    const file = path.join(dir, name);
    let mtimeMs;
    try {
      mtimeMs = fs.statSync(file).mtimeMs;
    } catch {
      continue;
    }
    out.push({ id, file, mtimeMs });
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

/**
 * Build the field object for one event, per the JOURNAL_KEYS whitelist for
 * `kind`. Unknown keys on `fields` are dropped. Content values are strings only (a non-string content value is dropped), and are
 * scrubbed + capped before being written.
 * @param {JournalKind} kind
 * @param {Record<string, unknown>} fields
 * @param {boolean} isContent
 * @returns {Record<string, unknown>}
 */
function buildFields(kind, fields, isContent) {
  const spec = JOURNAL_KEYS[kind];
  /** @type {Record<string, unknown>} */
  const out = {};
  const src = fields && typeof fields === "object" ? fields : {};
  for (const key of spec.meta) {
    if (key.indexOf("[]") !== -1) continue; // criticalIssues[].category - handled below
    if (Object.prototype.hasOwnProperty.call(src, key)) out[key] = src[key];
  }
  const hist=require('./config-history.js');
  if(out.snapshot&&!hist.validSnapshot(out.snapshot))delete out.snapshot;
  if(out.provenance)out.provenance=hist.safeCallProvenance(out.provenance);
  if(out.settings)out.settings=hist.safeCallProvenance({settings:out.settings}).settings;
  sanitizeShapes(out);
  if (isContent) {
    for (const key of spec.content) {
      if (key.indexOf("[]") !== -1) continue; // criticalIssues[].description - handled below
      // Content is text or nothing: a non-string (object, number) would skip the scrub and
      // the cap, so it is dropped. criticalIssues has its own handling below.
      const v = src[key];
      if (typeof v === "string") out[key] = capText(scrubSecrets(v));
    }
  }
  if (spec.meta.indexOf("criticalIssues[].category") !== -1 && Array.isArray(src.criticalIssues)) {
    out.criticalIssues = src.criticalIssues.map((/** @type {any} */ ci) => {
      /** @type {Record<string, unknown>} */
      const item = { category: ci && ci.category != null ? String(ci.category) : "" };
      if (isContent) item.description = capText(scrubSecrets(String(ci && ci.description != null ? ci.description : "")));
      return item;
    });
  }
  if (spec.meta.indexOf("decisions[].source") !== -1 && Array.isArray(src.decisions)) {
    const str = (/** @type {unknown} */ v) => (v != null ? String(v) : "");
    out.decisions = src.decisions.map((/** @type {any} */ d) => {
      /** @type {Record<string, unknown>} */
      const item = { source: str(d && d.source), category: str(d && d.category), action: str(d && d.action) };
      if (isContent) {
        item.description = capText(scrubSecrets(str(d && d.description)));
        item.reason = capText(scrubSecrets(str(d && d.reason)));
      }
      return item;
    });
  }
  return out;
}

const CEILING_SOURCES = new Set(["own", "shared", "outer", "host"]);
const NUM_OR_NULL_KEYS = ["promptChars", "fileCount", "orientationFiles", "fileBytes", "grantedMs", "hostCapMs", "sharedLimitMs"];

/**
 * Keep the analyzer fields in the shape it reads, dropping anything else: a
 * caller bug must not turn a metadata line into a free-form blob.
 * @param {Record<string, unknown>} out  mutated in place (it is the fresh object buildFields owns)
 * @returns {void}
 */
function sanitizeShapes(out) {
  if ("project" in out) {
    const p = /** @type {any} */ (out.project);
    if (p && typeof p === "object" && typeof p.id === "string" && typeof p.name === "string" && typeof p.root === "string") out.project = { id: p.id, name: p.name, root: p.root };
    else delete out.project;
  }
  for (const k of NUM_OR_NULL_KEYS) {
    if (k in out && out[k] !== null && !(typeof out[k] === "number" && Number.isFinite(out[k]))) delete out[k];
  }
  if ("ceilingSource" in out && !CEILING_SOURCES.has(/** @type {string} */ (out.ceilingSource))) delete out.ceilingSource;
  if ("sharedBy" in out) {
    if (Array.isArray(out.sharedBy)) out.sharedBy = out.sharedBy.filter((v) => typeof v === "string");
    else delete out.sharedBy;
  }
}

/**
 * The no-op journal. `createJournal` callers that resolve `dashboard.enabled`
 * as false can use this directly instead of constructing a real one.
 * @type {Journal}
 */
const NULL_JOURNAL = Object.freeze({
  enabled() {
    return false;
  },
  newRunId() {
    return crypto.randomUUID();
  },
  emit(/** @type {string} */ _runId, /** @type {JournalKind} */ _kind, /** @type {Record<string, unknown>} */ _fields) {},
  prune() {},
});

/**
 * Build a real journal writer.
 * @param {{dir: string, getSettings: () => DashboardSettings, now?: () => number, pid?: number}} opts
 * @returns {Journal}
 */
function createJournal(opts) {
  const dir = opts.dir;
  const getSettings = opts.getSettings;
  const now = typeof opts.now === "function" ? opts.now : Date.now;
  const pid = typeof opts.pid === "number" ? opts.pid : process.pid;
  /** @type {Map<string, number>} */
  const seqByRun = new Map();

  /** @returns {(DashboardSettings|null)} */
  function readSettings() {
    try {
      const s = getSettings();
      return s && typeof s === "object" ? s : null;
    } catch {
      return null;
    }
  }

  /** @returns {boolean} */
  function enabled() {
    const s = readSettings();
    return !!(s && s.enabled);
  }

  /** @returns {string} */
  function newRunId() {
    return crypto.randomUUID();
  }

  /**
   * @param {string} runId
   * @returns {number}
   */
  function nextSeq(runId) {
    const n = seqByRun.get(runId) || 0;
    seqByRun.set(runId, n + 1);
    return n;
  }

  /**
   * @param {string} runId
   * @param {JournalKind} kind
   * @param {Record<string, unknown>} fields
   * @returns {void}
   */
  function emit(runId, kind, fields) {
    try {
      const settings = readSettings();
      if (!settings || !settings.enabled) return;
      if (!isSafeId(runId)) return;
      if (!Object.prototype.hasOwnProperty.call(JOURNAL_KEYS, kind)) return;
      const isContent = settings.capture === "content";
      const built = buildFields(kind, fields, isContent);
      if (kind === "run_start") {
        built.pid = pid;
        built.procStartedAt = procStartedAt();
      }
      const envelope = { v: 1, kind, runId, at: now(), seq: nextSeq(runId), ...built };
      // A run ends once: drop its counter (even if the write below fails) so seqByRun
      // holds open runs only.
      if (kind === "run_end") seqByRun.delete(runId);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const file = path.join(dir, `${runId}.jsonl`);
      fs.appendFileSync(file, JSON.stringify(envelope) + "\n", { mode: 0o600 });
    } catch {
      // Journaling must never throw into a delegation.
    }
  }

  /** @returns {void} */
  function prune() {
    try {
      const settings = readSettings();
      const maxRuns = normalizeLimit(settings && settings.maxRuns, DEFAULT_MAX_RUNS);
      const maxAgeDays = normalizeLimit(settings && settings.maxAgeDays, DEFAULT_MAX_AGE_DAYS);
      const entries = listRunFiles(dir);
      const cutoff = maxAgeDays === -1 ? null : now() - maxAgeDays * 24 * 60 * 60 * 1000;
      /** @type {{id: string, file: string, mtimeMs: number}[]} */
      const survivors = [];
      for (const e of entries) {
        if (cutoff !== null && e.mtimeMs < cutoff) removeFile(e.file);
        else survivors.push(e);
      }
      if (maxRuns !== -1 && survivors.length > maxRuns) {
        for (const e of survivors.slice(maxRuns)) removeFile(e.file);
      }
    } catch {
      // Pruning must never throw into a delegation.
    }
  }

  return { enabled, newRunId, emit, prune };
}

module.exports = { createJournal, NULL_JOURNAL, JOURNAL_KEYS, procStartedAt, isSafeId };
