"use strict";
/** @typedef {import("./types.js").FileRef} FileRef */
const fs = require("node:fs");
const path = require("node:path");

// High-signal repo-orientation files, in priority order. Docs first (they state
// intent + conventions), then the entrypoint/manifest (stack + structure). This is
// a fixed, conservative list - NOT a directory walk or glob.
const ORIENTATION_CANDIDATES = [
  "CLAUDE.md", "AGENTS.md", "README.md",
  "package.json", "pyproject.toml", "Cargo.toml", "go.mod", "tsconfig.json", "main.tf",
];

const DEFAULT_MAX_FILES = 6;

/**
 * Resolve the high-signal orientation files that EXIST under `cwd`, in priority
 * order, capped at maxFiles. Pure stat-only read: returns FileRef[] of ABSOLUTE
 * paths; it never reads or uploads content (the provider bridges do that, applying
 * their own size caps + skip-notes). Never throws.
 * @param {string} [cwd]
 * @param {{maxFiles?:number, candidates?:string[]}} [opts] `maxFiles` must be a
 *   positive integer; any other value (0, NaN, float, missing) falls back to
 *   DEFAULT_MAX_FILES.
 * @returns {FileRef[]}
 */
function resolveOrientationFiles(cwd, opts = {}) {
  const base = cwd || process.cwd();
  const max = Number.isInteger(opts.maxFiles) && /** @type {number} */ (opts.maxFiles) > 0
    ? /** @type {number} */ (opts.maxFiles)
    : DEFAULT_MAX_FILES;
  const candidates = opts.candidates || ORIENTATION_CANDIDATES;
  /** @type {FileRef[]} */
  const out = [];
  for (const name of candidates) {
    if (out.length >= max) break;
    const abs = path.join(base, name);
    try {
      if (fs.statSync(abs).isFile()) out.push({ path: abs });
    } catch { /* missing -> skip */ }
  }
  return out;
}

/**
 * Config-gated wrapper: return the orientation bundle when `config.orientation.enabled`
 * is true, else `undefined` (the signal for "feature off"). Keeps the on/off decision
 * out of the hot dispatch path and unit-testable without a config file.
 * @param {{orientation?:{enabled?:boolean, maxFiles?:number}}|undefined} config
 * @param {string} [cwd]
 * @returns {(FileRef[]|undefined)}
 */
function orientationFilesFor(config, cwd) {
  const o = config && config.orientation;
  if (!o || o.enabled !== true) return undefined;
  return resolveOrientationFiles(cwd, { maxFiles: o.maxFiles });
}

module.exports = { resolveOrientationFiles, orientationFilesFor, ORIENTATION_CANDIDATES, DEFAULT_MAX_FILES };
