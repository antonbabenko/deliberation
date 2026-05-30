"use strict";

/**
 * core/paths.js - shared config + cache path resolver for deliberation.
 *
 * Zero runtime dependencies. CommonJS. JSDoc-typed so it passes strict `tsc`
 * (it is inside the strict tsconfig include).
 *
 * Resolves which on-disk file the bridges and the unified server should use.
 * Deliberation-only: there is no fallback or migration from older path layouts.
 *
 * Exports:
 *   - resolveConfigPath(opts?)    -> absolute path to the config.json to use
 *   - resolveGrokCachePath(opts?) -> absolute path to the grok-files.json cache to use
 *
 * Both accept an optional `{ home, env }` injection so callers (and tests) can
 * point at a temp HOME and a fake env without mutating real process state. When
 * omitted they default to `os.homedir()` and `process.env`.
 */

const os = require("node:os");
const path = require("node:path");

/**
 * @typedef {Object} ResolveOptions
 * @property {string} [home] Home directory to resolve `~/.claude/...` against. Defaults to os.homedir().
 * @property {NodeJS.ProcessEnv} [env] Environment to read overrides from. Defaults to process.env.
 */

/**
 * Resolve the absolute path to the config.json the caller should use.
 *
 * Precedence:
 *   1. DELIBERATION_CONFIG if non-empty -> return it verbatim.
 *   2. else -> `~/.claude/deliberation/config.json`.
 *
 * @param {ResolveOptions} [opts]
 * @returns {string} absolute path to the config.json to use
 */
function resolveConfigPath(opts) {
  const home = (opts && opts.home) || os.homedir();
  const env = (opts && opts.env) || process.env;

  const override = env.DELIBERATION_CONFIG;
  if (typeof override === "string" && override.length > 0) {
    return override;
  }

  return path.join(home, ".claude", "deliberation", "config.json");
}

/**
 * Resolve the absolute path to the Grok files cache the caller should use.
 *
 * Always `~/.claude/cache/deliberation/grok-files.json` (no env override).
 *
 * @param {ResolveOptions} [opts]
 * @returns {string} absolute path to the grok-files.json cache to use
 */
function resolveGrokCachePath(opts) {
  const home = (opts && opts.home) || os.homedir();
  return path.join(home, ".claude", "cache", "deliberation", "grok-files.json");
}

module.exports = {
  resolveConfigPath,
  resolveGrokCachePath,
};
