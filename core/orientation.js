"use strict";
/** @typedef {import("./types.js").FileRef} FileRef */
const fs = require("node:fs");
const path = require("node:path");
const { MARKER_RESERVE } = require("./head-read.js");

// High-signal repo-orientation files, in priority order. One instruction file
// (AGENTS.md, written for non-Claude agents, else CLAUDE.md - never both), then the
// small manifests, then README (the likeliest to be truncated). A fixed list, NOT a
// directory walk or glob.
const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md"];
const ORIENTATION_CANDIDATES = [
  ...INSTRUCTION_FILES,
  "package.json", "pyproject.toml", "Cargo.toml", "go.mod", "tsconfig.json", "main.tf",
  "README.md",
];

const DEFAULT_MAX_FILES = 6;
const DEFAULT_MAX_BYTES = 16000;
// Per-file ceiling: both bridges' default inline cap (256 KiB) minus the marker reserve.
const PER_FILE_MAX = 256 * 1024 - MARKER_RESERVE;
// A budget-partial file smaller than this is not worth sending.
const MIN_PARTIAL = 2048;

/** @param {unknown} v @param {number} dflt @param {boolean} allowZero */
function intOpt(v, dflt, allowZero) {
  return Number.isInteger(v) && (/** @type {number} */ (v) > 0 || (allowZero && v === 0)) ? /** @type {number} */ (v) : dflt;
}

/**
 * Resolve the orientation bundle under `cwd`: existing non-empty regular files, in
 * priority order, within `maxFiles` and a `maxBytes` content budget (0 = no budget).
 * Stat-only (never reads content). Every entry carries `headBytes` (the most a bridge
 * may read) and `mode: "inline"`, so what is sent equals what was budgeted. Two
 * passes: files that fit whole first, then at most one budget-partial file - the
 * highest-priority one skipped for size - when at least MIN_PARTIAL bytes remain.
 * Never throws.
 * @param {string} [cwd]
 * @param {{maxFiles?:number, maxBytes?:number, candidates?:string[]}} [opts] invalid
 *   values fall back to the defaults (maxFiles 6, maxBytes 16000).
 * @returns {FileRef[]}
 */
function resolveOrientationFiles(cwd, opts = {}) {
  const base = cwd || process.cwd();
  const maxFiles = intOpt(opts.maxFiles, DEFAULT_MAX_FILES, false);
  const budget = intOpt(opts.maxBytes, DEFAULT_MAX_BYTES, true);
  /** @type {{abs:string, head:number, cost:number}[]} */
  const found = [];
  let haveInstruction = false;
  for (const name of opts.candidates || ORIENTATION_CANDIDATES) {
    const isInstruction = INSTRUCTION_FILES.includes(name);
    if (isInstruction && haveInstruction) continue;
    const abs = path.join(base, name);
    try {
      const st = fs.statSync(abs);
      if (!st.isFile() || st.size === 0) continue;
      // A file over the per-file max is always cut, so its cost includes the marker.
      found.push({ abs, head: Math.min(st.size, PER_FILE_MAX), cost: st.size > PER_FILE_MAX ? PER_FILE_MAX + MARKER_RESERVE : st.size });
      if (isInstruction) haveInstruction = true;
    } catch { /* missing -> skip */ }
  }
  /** @type {Map<number, {head:number, cost:number}>} index in `found` -> pick */
  const picked = new Map();
  let remaining = budget;
  let skipped = -1;
  for (let i = 0; i < found.length && picked.size < maxFiles; i++) {
    const f = found[i];
    if (budget === 0 || f.cost <= remaining) {
      picked.set(i, { head: f.head, cost: f.cost });
      remaining -= f.cost;
    } else if (skipped === -1) {
      skipped = i;
    }
  }
  if (budget > 0 && skipped !== -1) {
    // The skipped file outranks every whole pick after it: drop those, lowest
    // priority first, when that is what it takes to fit the partial.
    const below = [...picked.keys()].filter((i) => i > skipped).sort((a, b) => b - a);
    const fits = () => picked.size < maxFiles && remaining - MARKER_RESERVE >= MIN_PARTIAL;
    const freeable = below.reduce((n, i) => n + /** @type {{cost:number}} */ (picked.get(i)).cost, 0);
    if (remaining + freeable - MARKER_RESERVE >= MIN_PARTIAL) {
      for (const i of below) {
        if (fits()) break;
        remaining += /** @type {{cost:number}} */ (picked.get(i)).cost;
        picked.delete(i);
      }
    }
    if (fits()) picked.set(skipped, { head: remaining - MARKER_RESERVE, cost: remaining });
  }
  return [...picked.keys()].sort((a, b) => a - b)
    .map((i) => ({ path: found[i].abs, headBytes: /** @type {{head:number}} */ (picked.get(i)).head, mode: /** @type {"inline"} */ ("inline") }));
}

/**
 * Config-gated wrapper: return the orientation bundle when `config.orientation.enabled`
 * is true, else `undefined` (the signal for "feature off"). Keeps the on/off decision
 * out of the hot dispatch path and unit-testable without a config file.
 * @param {{orientation?:{enabled?:boolean, maxFiles?:number, maxBytes?:number}}|undefined} config
 * @param {string} [cwd]
 * @returns {(FileRef[]|undefined)}
 */
function orientationFilesFor(config, cwd) {
  const o = config && config.orientation;
  if (!o || o.enabled !== true) return undefined;
  return resolveOrientationFiles(cwd, { maxFiles: o.maxFiles, maxBytes: o.maxBytes });
}

module.exports = { resolveOrientationFiles, orientationFilesFor, ORIENTATION_CANDIDATES, DEFAULT_MAX_FILES, DEFAULT_MAX_BYTES, PER_FILE_MAX };
