"use strict";

/**
 * core/sessions.js - opt-in per-session store for deliberation.
 *
 * Zero runtime dependencies (node builtins only). SYNCHRONOUS API to match
 * core/paths.js and server/grok/cache.js. JSDoc-typed so it passes strict `tsc`
 * (it is inside the strict tsconfig include).
 *
 * One JSON file per session at `<dir>/<id>.json`, written atomically
 * (temp -> rename) with mode 0600. No global lock - each file is independent;
 * the only read-modify-write race is `annotateSession` on ONE file, documented
 * last-writer-wins (acceptable for a local single-user stdio server).
 *
 * SECURITY: `scrubSecrets` is best-effort. User-provided transcript text may
 * still carry secrets in shapes this does not recognize.
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

/**
 * Current on-disk record shape version. A single stamp written on every record;
 * nothing reads or branches on it today (it is a cheap migration signal for the
 * future). Pre-1.0 with no users, so there is only ONE shape - no compatibility
 * path. Loop runs (the `consensus` tool) carry extra optional fields
 * (per-opinion verdict/criticalIssues, synthesis, converged/confidence/rounds)
 * that one-shot/ask-all runs simply omit.
 */
const SCHEMA_VERSION = 1;
/** Anchored id guard: rejects `../`, dots, slashes - no path traversal. */
const ID_RE = /^[A-Za-z0-9-]+$/;
/** Exact shape of a write temp file (`<id>.json.tmp.<pid>.<ms>`) - reaped if orphaned. */
const TMP_RE = /^[A-Za-z0-9-]+\.json\.tmp\.\d+\.\d+$/;
/** ~100 KB cap per stored opinion/verdict text, so a runaway response can't bloat the store. */
const MAX_TEXT_BYTES = 100 * 1024;

const DEFAULT_MAX_RECORDS = 200;
const DEFAULT_MAX_AGE_DAYS = 30;

/**
 * @typedef {Object} SessionCriticalIssue
 * @property {string} category
 * @property {string} description
 */

/**
 * @typedef {Object} SessionOpinion
 * @property {string} provider
 * @property {string} [model]
 * @property {string} [text]
 * @property {(("APPROVE"|"REQUEST_CHANGES"|"REJECT")|null)} [verdict]  consensus loop review verdict
 * @property {SessionCriticalIssue[]} [criticalIssues]  consensus loop tagged issues
 */

/**
 * Input attachment REF (never the body). Mirrors the request FileRef shape so a
 * revisit re-runs with the same context regardless of ref kind. Location strings
 * (path/dir) are scrubbed; file_id/file_url/mode pass through.
 * @typedef {Object} SessionFileRef
 * @property {string} [path]
 * @property {string} [dir]
 * @property {string} [file_id]
 * @property {string} [file_url]
 * @property {string} [mode]
 */

/**
 * @typedef {Object} SessionAnnotation
 * @property {string} note
 * @property {string} at  ISO timestamp
 */

/**
 * @typedef {Object} SessionArbiter
 * @property {string} mode
 * @property {(string|null)} [provider]
 */

/**
 * @typedef {Object} SessionRecord
 * @property {string} id
 * @property {(string|null)} parentId
 * @property {number} schemaVersion
 * @property {string} createdAt  ISO timestamp
 * @property {("consensus"|"ask-all")} tool
 * @property {string} question
 * @property {(string|null)} [expert]
 * @property {(SessionFileRef[]|null)} [files]
 * @property {SessionOpinion[]} opinions
 * @property {(string|null)} [blindVerdict]
 * @property {(string|null)} [verdict]  loop verdict enum (APPROVE|REQUEST_CHANGES|REJECT); null in synthesize mode
 * @property {(string|null)} [synthesis]  free-text arbiter synthesis (synthesizeAlways runs); null in loop mode
 * @property {boolean} [synthesizeAlways]  the run was a one-pass synthesis, not the convergence loop
 * @property {(SessionArbiter|null)} [arbiter]
 * @property {string[]} [warnings]
 * @property {SessionAnnotation[]} [annotations]
 * @property {boolean} [converged]  consensus loop: did the loop converge
 * @property {string} [confidence]  consensus loop: final confidence (none|low|medium|high)
 * @property {number} [rounds]  consensus loop: number of rounds the loop ran
 */

/**
 * Redact common API-key shapes from a string. Best-effort - see module note.
 * @param {string} text
 * @returns {string}
 */
function scrubSecrets(text) {
  if (typeof text !== "string" || text.length === 0) return text;
  return text
    // Leading \b so a key embedded in a normal word (e.g. "risk-analysis" ->
    // "sk-analysis") is NOT matched. {20,} (not {8,}) so short hyphenated terms
    // (e.g. "sk-folding-cube", "xai-explainability") are not mistaken for keys -
    // real OpenAI/OpenRouter/xAI keys are well over 20 chars. OpenRouter (sk-or-)
    // BEFORE OpenAI (sk-) so the more specific shape wins.
    .replace(/\bsk-or-[A-Za-z0-9_-]{20,}/g, "[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{20,}/g, "[REDACTED]")
    // xAI keys.
    .replace(/\bxai-[A-Za-z0-9_-]{20,}/g, "[REDACTED]")
    // GitHub tokens (ghp_/gho_/ghu_/ghs_/ghr_) and AWS access key ids (AKIA...).
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "[REDACTED]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]")
    // Google API keys: AIza + >=35 chars. {35,} (not {35}) so a longer-than-39
    // key cannot leak its tail; over-matching only redacts MORE, never less.
    .replace(/\bAIza[0-9A-Za-z_-]{35,}/g, "[REDACTED]")
    // URL-embedded credentials: scheme://user:SECRET@host -> redact the password only.
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)[^\s@/]{6,}@/gi, "$1[REDACTED]@")
    // Non-Bearer "Token <value>" auth headers (e.g. GitHub "Authorization: token ...").
    .replace(/\bToken\s+[A-Za-z0-9._~+/-]{20,}={0,2}/g, "Token [REDACTED]")
    // `Bearer <token>` headers. No `i` flag (HTTP uses capital "Bearer") so the
    // English word "bearer" is not matched; {20,} min + base64/base64url charset
    // (+ / ~ -) and optional = padding so a real token is fully redacted, not
    // partially leaked.
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{20,}={0,2}/g, "Bearer [REDACTED]");
}

/**
 * Cap text at MAX_TEXT_BYTES (byte-aware so multibyte text cannot exceed the
 * cap); append a truncation note when cut.
 * @param {string} text
 * @returns {string}
 */
function capText(text) {
  if (typeof text !== "string") return text;
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= MAX_TEXT_BYTES) return text;
  const suffix = `\n\n[truncated: original ${buf.length} bytes]`;
  // Reserve room for the suffix so the RETURNED string stays within the cap, and
  // back up off any UTF-8 continuation byte so we never split a codepoint (which
  // would otherwise emit a 3-byte U+FFFD and bloat past the budget).
  let end = Math.max(0, MAX_TEXT_BYTES - Buffer.byteLength(suffix, "utf8"));
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString("utf8") + suffix;
}

/**
 * True only for a non-empty id matching the anchored safe-id shape.
 * @param {unknown} id
 * @returns {id is string}
 */
function isSafeId(id) {
  return typeof id === "string" && ID_RE.test(id);
}

/** The closed consensus verdict set. The writer coerces anything else to null. */
const VERDICTS = ["APPROVE", "REQUEST_CHANGES", "REJECT"];
/**
 * @param {unknown} v
 * @returns {v is ("APPROVE"|"REQUEST_CHANGES"|"REJECT")}
 */
function isVerdict(v) {
  return typeof v === "string" && VERDICTS.indexOf(v) !== -1;
}

/** @returns {string} a fresh session id ([0-9a-f-], matches the safe-id guard). */
function newSessionId() {
  return crypto.randomUUID();
}

/**
 * Scrub secrets + cap large text on a record before it is written. Returns a NEW
 * record; never mutates the input. Applies to question, each opinion text,
 * verdict, blindVerdict, and the `files[].path` refs.
 * @param {SessionRecord} record
 * @returns {SessionRecord}
 */
function sanitizeRecord(record) {
  /** @type {SessionRecord} */
  const out = { ...record };
  out.question = capText(scrubSecrets(String(record.question == null ? "" : record.question)));
  if (Array.isArray(record.opinions)) {
    out.opinions = record.opinions.map((o) => {
      /** @type {SessionOpinion} */
      const so = {
        provider: o.provider,
        model: o.model,
        text: typeof o.text === "string" ? capText(scrubSecrets(o.text)) : undefined,
      };
      // consensus-auto opinions carry a structured verdict + tagged issues.
      // The writer is the trust boundary: do NOT assume the caller honored
      // parseReview's enum contract. Whitelist the verdict to the closed set
      // (anything else -> null) so no free-text can ride the unscrubbed verdict
      // field. Issue descriptions are free provider text -> scrub + cap; the
      // category tag is bounded but capped defensively against a bloated value.
      if (o.verdict !== undefined) so.verdict = isVerdict(o.verdict) ? o.verdict : null;
      if (Array.isArray(o.criticalIssues)) {
        so.criticalIssues = o.criticalIssues.map((ci) => ({
          category: capText(String(ci && ci.category != null ? ci.category : "")),
          description: capText(scrubSecrets(String(ci && ci.description != null ? ci.description : ""))),
        }));
      }
      return so;
    });
  }
  if (record.verdict != null) out.verdict = capText(scrubSecrets(String(record.verdict)));
  if (record.synthesis != null) out.synthesis = capText(scrubSecrets(String(record.synthesis)));
  if (record.blindVerdict != null) out.blindVerdict = capText(scrubSecrets(String(record.blindVerdict)));
  if (Array.isArray(record.files)) {
    out.files = record.files.map((f) => {
      /** @type {SessionFileRef} */
      const ref = {};
      if (f && typeof f.path === "string") ref.path = scrubSecrets(f.path);
      if (f && typeof f.dir === "string") ref.dir = scrubSecrets(f.dir);
      if (f && typeof f.file_id === "string") ref.file_id = f.file_id;
      if (f && typeof f.file_url === "string") ref.file_url = f.file_url;
      if (f && typeof f.mode === "string") ref.mode = f.mode;
      return ref;
    });
  }
  // warnings come from config/provider error channels and can echo a key in an
  // error string; scrub them too (they would otherwise ride the spread untouched).
  if (Array.isArray(record.warnings)) {
    out.warnings = record.warnings.map((w) => scrubSecrets(String(w == null ? "" : w)));
  }
  // Defensive: a hand-built record could carry annotation notes; scrub them too
  // (annotateSession already scrubs on append - this just makes write idempotent).
  if (Array.isArray(record.annotations)) {
    out.annotations = record.annotations.map((a) => ({
      note: capText(scrubSecrets(String(a && a.note != null ? a.note : ""))),
      at: a && a.at,
    }));
  }
  return out;
}

/**
 * Write a session record atomically as `<dir>/<id>.json`. Secrets are scrubbed
 * and large text capped first. The temp file is created with mode 0600 DIRECTLY
 * (not write-then-chmod, which would leave a world-readable window). Prunes the
 * store after the write.
 * @param {SessionRecord} record  must carry a safe `id`
 * @param {{dir:string, maxRecords?:number, maxAgeDays?:number}} opts
 * @returns {string} the written id
 */
function writeSession(record, opts) {
  const dir = opts.dir;
  const id = record.id;
  if (!isSafeId(id)) throw new Error(`unsafe session id: ${String(id)}`);
  fs.mkdirSync(dir, { recursive: true });
  const json = JSON.stringify(sanitizeRecord(record));
  const dest = path.join(dir, `${id}.json`);
  const tmp = `${dest}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, json, { mode: 0o600 });
  try {
    fs.renameSync(tmp, dest);
  } catch (e) {
    // A failed rename would otherwise orphan the temp file (listSessions/prune
    // ignore non-.json names, so it would never be cleaned up). Remove it, then
    // surface the original error.
    removeFile(tmp);
    throw e;
  }
  pruneSessions({ dir, maxRecords: opts.maxRecords, maxAgeDays: opts.maxAgeDays });
  return id;
}

/**
 * Read + parse a session record. Returns null when the id is unsafe, the file is
 * absent, or the JSON is corrupt - never throws on those.
 * @param {string} id
 * @param {{dir:string}} opts
 * @returns {(SessionRecord|null)}
 */
function readSession(id, opts) {
  if (!isSafeId(id)) return null;
  const file = path.join(opts.dir, `${id}.json`);
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === "object") return /** @type {SessionRecord} */ (obj);
    return null;
  } catch {
    return null;
  }
}

/**
 * @typedef {Object} SessionListEntry
 * @property {string} id
 * @property {string} file
 * @property {number} mtimeMs
 */

/**
 * List records newest-first by mtime. A missing dir yields []. Best-effort: a
 * file that disappears mid-listing is skipped.
 * @param {{dir:string}} opts
 * @returns {SessionListEntry[]}
 */
function listSessions(opts) {
  const dir = opts.dir;
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  /** @type {SessionListEntry[]} */
  const out = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -5);
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
 * Best-effort, ENOENT-tolerant delete. A concurrent prune racing on the same
 * file never throws (rmSync force:true).
 * @param {string} file
 * @returns {boolean} true when a delete call succeeded
 */
function removeFile(file) {
  try {
    fs.rmSync(file, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Delete records older than maxAgeDays, then trim to the newest maxRecords.
 * Called after each write. Best-effort + ENOENT-tolerant.
 *
 * `-1` means UNLIMITED for either limit (skip that retention rule): maxAgeDays:-1
 * never deletes by age, maxRecords:-1 never trims by count. Any other non-positive
 * or non-integer value falls back to the default.
 * @param {{dir:string, maxRecords?:number, maxAgeDays?:number}} opts
 * @returns {{removed:number}}
 */
function pruneSessions(opts) {
  const mr = opts.maxRecords;
  const md = opts.maxAgeDays;
  const maxRecords = typeof mr === "number" && Number.isInteger(mr) && (mr === -1 || mr > 0) ? mr : DEFAULT_MAX_RECORDS;
  const maxAgeDays = typeof md === "number" && Number.isInteger(md) && (md === -1 || md > 0) ? md : DEFAULT_MAX_AGE_DAYS;
  // Sweep orphaned temp files first. A crash between writeFileSync(tmp) and the
  // rename leaves a `<id>.json.tmp.<pid>.<ts>` that listSessions ignores (non-.json),
  // so nothing else would ever reap it. Only sweep ones older than an hour to avoid
  // racing a write in flight from another process.
  const TMP_REAP_MS = 60 * 60 * 1000;
  try {
    for (const name of fs.readdirSync(opts.dir)) {
      if (!TMP_RE.test(name)) continue; // only OUR write temps, not any ".tmp." file
      const p = path.join(opts.dir, name);
      let mt;
      try { mt = fs.statSync(p).mtimeMs; } catch { continue; }
      if (Date.now() - mt > TMP_REAP_MS) removeFile(p);
    }
  } catch { /* missing dir: nothing to sweep */ }

  const entries = listSessions({ dir: opts.dir });
  // maxAgeDays === -1 -> unlimited age: never delete by age (cutoff stays null).
  const cutoff = maxAgeDays === -1 ? null : Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  /** @type {SessionListEntry[]} */
  const survivors = [];
  for (const e of entries) {
    if (cutoff !== null && e.mtimeMs < cutoff) {
      if (removeFile(e.file)) removed++;
    } else {
      survivors.push(e);
    }
  }
  // survivors stays newest-first; trim the tail beyond maxRecords. maxRecords === -1
  // -> unlimited count: never trim.
  if (maxRecords !== -1 && survivors.length > maxRecords) {
    for (const e of survivors.slice(maxRecords)) {
      if (removeFile(e.file)) removed++;
    }
  }
  return { removed };
}

/**
 * Append an annotation to an existing record and rewrite it. Returns the updated
 * record, or null when the id is unsafe/unknown. Last-writer-wins (documented;
 * single-user local server).
 * @param {string} id
 * @param {string} note
 * @param {{dir:string, at?:string, maxRecords?:number, maxAgeDays?:number}} opts
 * @returns {(SessionRecord|null)}
 */
function annotateSession(id, note, opts) {
  const rec = readSession(id, { dir: opts.dir });
  if (!rec) return null;
  const at = typeof opts.at === "string" && opts.at ? opts.at : new Date().toISOString();
  const annotations = Array.isArray(rec.annotations) ? rec.annotations.slice() : [];
  annotations.push({ note: capText(scrubSecrets(String(note == null ? "" : note))), at });
  /** @type {SessionRecord} */
  const updated = { ...rec, annotations };
  writeSession(updated, { dir: opts.dir, maxRecords: opts.maxRecords, maxAgeDays: opts.maxAgeDays });
  return updated;
}

module.exports = {
  SCHEMA_VERSION,
  MAX_TEXT_BYTES,
  DEFAULT_MAX_RECORDS,
  DEFAULT_MAX_AGE_DAYS,
  scrubSecrets,
  capText,
  sanitizeRecord,
  isSafeId,
  newSessionId,
  writeSession,
  readSession,
  listSessions,
  pruneSessions,
  annotateSession,
};
