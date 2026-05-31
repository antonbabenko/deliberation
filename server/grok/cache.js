// @ts-nocheck -- legacy bridge; predates the strict typecheck gate (core-only). Opt-in is a separate pass.
"use strict";
// crypto + fs helpers are used by buildCacheKey, readCache/writeCache, lookup/store/evict in T2-T7.
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { mkdirSync, readFileSync, writeFileSync, renameSync } = require("node:fs");
const lock = require("./lock.js");

// Single cache path: DELIBERATION_CACHE override else the canonical XDG path.
const CACHE_FILE = require("../../core/paths.js").resolveGrokCachePath();
const CACHE_DIR = path.dirname(CACHE_FILE);
const CACHE_VERSION = 1;

function normalize(apiBase) {
  let u;
  try { u = new URL(apiBase); }
  catch (_) {
    u = new URL(`https://${apiBase}`);
  }
  const proto = u.protocol.toLowerCase();
  const host = u.host.toLowerCase();
  let pathname = u.pathname;
  if (pathname.length > 1 && pathname.endsWith("/")) pathname = pathname.slice(0, -1);
  return `${proto}//${host}${pathname}`;
}

function buildCacheKey({ bytes, apiKey, apiBase, filename }) {
  const contentHash = crypto.createHash("sha256").update(bytes).digest("hex");
  const keyFp = crypto.createHash("sha256").update(String(apiKey)).digest("hex").slice(0, 16);
  const baseNorm = normalize(apiBase);
  return `${contentHash}@${keyFp}@${baseNorm}@${filename}`;
}

function readCache(file) {
  try {
    const raw = readFileSync(file, "utf8");
    const obj = JSON.parse(raw);
    if (obj && typeof obj === "object" && obj.entries && typeof obj.entries === "object") {
      return { version: obj.version || CACHE_VERSION, entries: obj.entries };
    }
  } catch (e) {
    if (e && e.code !== "ENOENT") {
      process.stderr.write(`[grok] cache read failed (${e.message}); treating as empty\n`);
    }
  }
  return { version: CACHE_VERSION, entries: {} };
}

function writeCache(file, data) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(data));
  renameSync(tmp, file);
}

const _inflight = new Map();

function withInflight(key, worker) {
  if (_inflight.has(key)) return _inflight.get(key);
  const p = Promise.resolve().then(worker);
  _inflight.set(key, p);
  // Use then(onFulfilled, onRejected) so the cleanup branch does NOT create a
  // dangling rejected promise (a `.finally` chain would). Returned `p` retains
  // the rejection for the original caller.
  p.then(
    () => { _inflight.delete(key); },
    () => { _inflight.delete(key); },
  );
  return p;
}

function lookup(file, key, { apiBase, keyFp } = {}) {
  const data = readCache(file);
  const entry = data.entries[key];
  if (!entry) return null;
  const now = Math.floor(Date.now() / 1000);
  if (entry.expiresAt - now < 60) return null;
  if (apiBase && entry.apiBase !== apiBase) return null;
  if (keyFp && entry.keyFp !== keyFp) return null;
  return entry;
}

async function store(file, key, entry) {
  if (!file) return;
  const handle = lock.acquire(file, { maxWaitMs: 1000 });
  if (!handle) {
    process.stderr.write("[grok] cache lock contention; skipping persist\n");
    return;
  }
  try {
    const data = readCache(file);
    data.entries[key] = entry;
    writeCache(file, data);
  } finally {
    lock.release(handle);
  }
}

async function evict(file, fileId) {
  if (!file) return;
  const handle = lock.acquire(file, { maxWaitMs: 1000 });
  if (!handle) return;
  try {
    const data = readCache(file);
    for (const k of Object.keys(data.entries)) {
      if (data.entries[k].fileId === fileId) delete data.entries[k];
    }
    writeCache(file, data);
  } finally {
    lock.release(handle);
  }
}

module.exports = { normalize, buildCacheKey, readCache, writeCache, withInflight, lookup, store, evict, CACHE_DIR, CACHE_FILE, CACHE_VERSION };
