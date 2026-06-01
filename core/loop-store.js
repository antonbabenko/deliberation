"use strict";

/**
 * core/loop-store.js - an in-memory, sliding-TTL store for in-flight consensus
 * LoopState, keyed by sessionId. Used by the server `consensus-step` tool so a
 * Claude-driven multi-round loop survives across stateless MCP tool calls
 * WITHOUT requiring `sessions.persist` (which governs only the durable audit
 * record). State is intentionally ephemeral: a server restart drops it and the
 * driver restarts the loop (see PLAN_point1.md).
 *
 * Zero deps. The clock is injectable (`opts.now`) so the TTL/eviction logic is
 * deterministically testable.
 */

const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 min
const DEFAULT_MAX_ENTRIES = 100;

/**
 * @param {{ttlMs?:number, maxEntries?:number, now?:() => number}} [opts]
 * @returns {{
 *   put:(id:string, state:any)=>void,
 *   get:(id:string)=>any,
 *   delete:(id:string)=>boolean,
 *   sweep:()=>number,
 *   size:()=>number,
 * }}
 */
function makeLoopStore(opts) {
  const o = opts || {};
  const ttlMs = Number.isFinite(o.ttlMs) && /** @type {number} */ (o.ttlMs) > 0 ? /** @type {number} */ (o.ttlMs) : DEFAULT_TTL_MS;
  const maxEntries = Number.isInteger(o.maxEntries) && /** @type {number} */ (o.maxEntries) > 0 ? /** @type {number} */ (o.maxEntries) : DEFAULT_MAX_ENTRIES;
  const now = typeof o.now === "function" ? o.now : Date.now;

  /** @type {Map<string, {state:any, touchedAt:number, seq:number}>} */
  const map = new Map();
  // Monotonic access counter for TRUE LRU eviction, independent of wall-clock
  // resolution (Date.now() ms-granularity collisions would otherwise break the
  // tie-break) and immune to a pathological/non-finite injected clock.
  let seq = 0;

  /** @param {number} t */
  function isExpired(/** @type {{touchedAt:number}} */ entry, t) {
    return t - entry.touchedAt > ttlMs;
  }

  /** Evict the single least-recently-used entry (lowest seq) after a put pushes over cap. */
  function evictOldest() {
    /** @type {string|null} */
    let lruId = null;
    let lruSeq = Infinity;
    for (const [id, entry] of map) {
      if (entry.seq < lruSeq) { lruSeq = entry.seq; lruId = id; }
    }
    if (lruId !== null) map.delete(lruId);
  }

  return {
    put(id, state) {
      map.set(id, { state, touchedAt: now(), seq: ++seq });
      while (map.size > maxEntries) evictOldest();
    },
    get(id) {
      const entry = map.get(id);
      if (!entry) return null;
      const t = now();
      if (isExpired(entry, t)) { map.delete(id); return null; }
      entry.touchedAt = t; // sliding TTL: access keeps an active loop alive
      entry.seq = ++seq;   // mark as most-recently-used for LRU eviction
      return entry.state;
    },
    delete(id) {
      return map.delete(id);
    },
    sweep() {
      const t = now();
      let removed = 0;
      for (const [id, entry] of map) {
        if (isExpired(entry, t)) { map.delete(id); removed++; }
      }
      return removed;
    },
    size() {
      return map.size;
    },
  };
}

module.exports = { makeLoopStore, DEFAULT_TTL_MS, DEFAULT_MAX_ENTRIES };
