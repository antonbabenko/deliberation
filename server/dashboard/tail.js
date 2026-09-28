"use strict";

/**
 * server/dashboard/tail.js - live SSE tailer over the run journal directory.
 *
 * Watches `runsDir` for appended journal lines and delivers each new event to
 * subscribers as `{id, event}`, `id` = "<runId>:<byteOffsetAfterLine>" so a
 * reconnecting client can resume with `since`. Zero runtime dependencies.
 * Never throws into a caller: a missing runs dir, a missing/truncated file,
 * or a subscriber callback that throws are all swallowed so one bad file or
 * client can't break delivery to the others.
 */

const fs = require("node:fs");
const path = require("node:path");
const { isSafeId } = require("../../core/journal.js");
const { readEvents } = require("./runs.js");

const DEBOUNCE_MS = 50;

/**
 * Parse a `Last-Event-ID`-shaped `since` value. Anything unsafe or malformed
 * (unknown/unsafe runId, non-integer offset) is treated as absent, per the
 * task's decision - the caller falls back to tailing that run from its
 * current end like every other run.
 * @param {string} [since]
 * @returns {{runId: string, offset: number}|null}
 */
function parseSince(since) {
  if (typeof since !== "string") return null;
  const i = since.lastIndexOf(":");
  if (i <= 0) return null;
  const runId = since.slice(0, i);
  if (!isSafeId(runId)) return null;
  const offset = Number(since.slice(i + 1));
  if (!Number.isInteger(offset) || offset < 0) return null;
  return { runId, offset };
}

/**
 * Safe run ids with a `.jsonl` file directly in `dir`. `[]` if `dir` doesn't
 * exist (yet) or isn't readable - never throws.
 * @param {string} dir
 * @returns {string[]}
 */
function listRunIds(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const ids = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const id = name.slice(0, -".jsonl".length);
    if (isSafeId(id)) ids.push(id);
  }
  return ids;
}

/**
 * @typedef {{fn: (msg: {id: string, event: object}) => void, offsets: Map<string, number>}} Subscriber
 */

/**
 * @param {{runsDir: string, sweepMs?: number, watch?: typeof fs.watch}} opts
 * @returns {{
 *   subscribe: (fn: (msg: {id: string, event: object}) => void, since?: string) => () => void,
 *   close: () => void
 * }}
 */
function createTailer(opts) {
  const runsDir = opts.runsDir;
  const sweepMs = typeof opts.sweepMs === "number" ? opts.sweepMs : 5000;
  const watchFn = typeof opts.watch === "function" ? opts.watch : fs.watch;

  let closed = false;
  /** @type {Set<Subscriber>} */
  const subscribers = new Set();
  /** @type {import("node:fs").FSWatcher|null} */
  let watcher = null;
  /** @type {NodeJS.Timeout|null} */
  let sweepTimer = null;
  /** @type {NodeJS.Timeout|null} */
  let debounceTimer = null;

  /**
   * Deliver every new complete line, for every current run file, to one
   * subscriber, advancing that subscriber's per-run offsets as it goes.
   * @param {Subscriber} sub
   */
  function sweepOne(sub) {
    const ids = listRunIds(runsDir);
    const current = new Set(ids);
    for (const runId of ids) {
      if (closed) return;
      const file = path.join(runsDir, `${runId}.jsonl`);
      let stat;
      try {
        stat = fs.statSync(file);
      } catch {
        sub.offsets.delete(runId); // gone between readdir and stat: treat as pruned
        continue;
      }
      let from = sub.offsets.has(runId) ? /** @type {number} */ (sub.offsets.get(runId)) : 0;
      if (stat.size < from) from = 0; // shrunk/replaced: drop tracked offset, restart at 0
      if (stat.size <= from) {
        sub.offsets.set(runId, from);
        continue;
      }
      const result = readEvents(file, from);
      sub.offsets.set(runId, result.offset);
      for (let i = 0; i < result.events.length; i++) {
        if (closed) return;
        try {
          sub.fn({ id: `${runId}:${result.offsets[i]}`, event: result.events[i] });
        } catch {
          // a subscriber's own callback must never break delivery to others
        }
      }
    }
    // Pruned files (deleted since the last sweep): drop the offset so a
    // recreated run of the same id starts from 0, per the task's decision.
    for (const runId of sub.offsets.keys()) {
      if (!current.has(runId)) sub.offsets.delete(runId);
    }
  }

  function sweepAll() {
    if (closed) return;
    for (const sub of subscribers) sweepOne(sub);
  }

  function scheduleSweep() {
    if (closed || debounceTimer) return;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      sweepAll();
    }, DEBOUNCE_MS);
    if (debounceTimer.unref) debounceTimer.unref();
  }

  // fs.watch throws synchronously if runsDir doesn't exist yet - fine, the
  // periodic sweep below (TL4/T7 brief) covers a dashboard started before
  // any run exists, no watcher needed for that case.
  try {
    watcher = watchFn(runsDir, {}, scheduleSweep);
  } catch {
    watcher = null;
  }
  sweepTimer = setInterval(sweepAll, sweepMs);
  if (sweepTimer.unref) sweepTimer.unref();

  /**
   * @param {(msg: {id: string, event: object}) => void} fn
   * @param {string} [since]
   * @returns {() => void} unsubscribe
   */
  function subscribe(fn, since) {
    if (closed) return () => {};
    const parsed = parseSince(since);
    /** @type {Map<string, number>} */
    const offsets = new Map();
    for (const runId of listRunIds(runsDir)) {
      if (parsed && parsed.runId === runId) {
        offsets.set(runId, parsed.offset);
        continue;
      }
      // Every other run tails from its current end (only future content).
      let size = 0;
      try {
        size = fs.statSync(path.join(runsDir, `${runId}.jsonl`)).size;
      } catch {
        // vanished between listing and stat; 0 is fine, a recreated file reads from the start
      }
      offsets.set(runId, size);
    }
    const sub = { fn, offsets };
    subscribers.add(sub);
    sweepOne(sub); // deliver the `since` backlog now, don't wait for the next sweep
    return () => {
      subscribers.delete(sub);
    };
  }

  function close() {
    closed = true;
    subscribers.clear();
    if (watcher) {
      try {
        watcher.close();
      } catch {
        // already closed
      }
      watcher = null;
    }
    if (sweepTimer) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  }

  return { subscribe, close };
}

module.exports = { createTailer };
