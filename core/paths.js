"use strict";

/**
 * core/paths.js - shared config + cache path resolver for deliberation.
 *
 * Zero runtime dependencies. CommonJS. JSDoc-typed so it passes strict `tsc`
 * (it is inside the strict tsconfig include).
 *
 * Resolves which on-disk file the bridges and the unified server should use.
 * Host-neutral: the canonical location is the OS-standard XDG base dir, so a
 * standalone (Codex/Kiro/Cursor) user need not have Claude Code installed. An
 * explicit env override wins; otherwise the canonical XDG path is THE location.
 *
 * Exports:
 *   - resolveConfigPath(opts?)    -> DELIBERATION_CONFIG override else canonical config.json
 *   - resolveGrokCachePath(opts?) -> DELIBERATION_CACHE override else canonical grok-files.json
 *
 * Both accept an optional `{ home, env, platform }` injection so callers (and
 * tests) can point at a temp HOME, a fake env, and a fixed platform without
 * touching real process state. When omitted they default to os.homedir(),
 * process.env, and process.platform.
 */

const os = require("node:os");
const path = require("node:path");

/**
 * @typedef {Object} ResolveOptions
 * @property {string} [home] Home directory to resolve `~/...` against. Defaults to os.homedir().
 * @property {NodeJS.ProcessEnv} [env] Environment to read overrides from. Defaults to process.env.
 * @property {NodeJS.Platform} [platform] Platform string. Defaults to process.platform.
 */

/**
 * Resolve `{home, env, platform}` with defaults. Internal helper so each
 * resolver reads the same injection points.
 * @param {ResolveOptions} [opts]
 */
function resolveInjection(opts) {
  return {
    home: (opts && opts.home) || os.homedir(),
    env: (opts && opts.env) || process.env,
    platform: (opts && opts.platform) || process.platform,
  };
}

/**
 * True only for a non-empty, absolute path string. Per the XDG Base Directory
 * spec, a relative base-dir value MUST be ignored and the default used. The
 * Windows `%APPDATA%`/`%LOCALAPPDATA%` branches apply the same gate for symmetry.
 *
 * Absoluteness is judged with the platform-appropriate implementation
 * (`path.win32` vs `path.posix`) rather than the host default, so the resolver
 * stays deterministic across hosts (a `C:\...` base is absolute for win32 even
 * when this runs on POSIX, and vice versa).
 * @param {unknown} value
 * @param {NodeJS.Platform} platform
 * @returns {value is string}
 */
function isUsableBase(value, platform) {
  if (typeof value !== "string" || value.length === 0) return false;
  const impl = platform === "win32" ? path.win32 : path.posix;
  return impl.isAbsolute(value);
}

/**
 * Canonical config dir per platform (no filename). macOS/Linux use
 * `$XDG_CONFIG_HOME` or `~/.config`; Windows uses `%APPDATA%` or
 * `~/AppData/Roaming`. A relative env base is ignored (XDG spec) and the default
 * used instead.
 * @param {string} home
 * @param {NodeJS.ProcessEnv} env
 * @param {NodeJS.Platform} platform
 * @returns {string}
 */
function canonicalConfigDir(home, env, platform) {
  if (platform === "win32") {
    const appData = env.APPDATA;
    const base = isUsableBase(appData, platform) ? appData : path.join(home, "AppData", "Roaming");
    return path.join(base, "deliberation");
  }
  const xdg = env.XDG_CONFIG_HOME;
  const base = isUsableBase(xdg, platform) ? xdg : path.join(home, ".config");
  return path.join(base, "deliberation");
}

/**
 * Resolve the absolute path to the config.json the caller should use.
 *
 * Precedence:
 *   1. DELIBERATION_CONFIG if non-empty -> return it verbatim.
 *   2. Else the canonical XDG config path.
 *
 * Pure path logic - no FS access, no side effects.
 *
 * @param {ResolveOptions} [opts]
 * @returns {string} absolute path to the config.json to use
 */
function resolveConfigPath(opts) {
  const { home, env, platform } = resolveInjection(opts);

  const override = env.DELIBERATION_CONFIG;
  if (typeof override === "string" && override.length > 0) {
    return override;
  }

  return path.join(canonicalConfigDir(home, env, platform), "config.json");
}

/**
 * Canonical cache dir per platform (no filename). macOS/Linux use
 * `$XDG_CACHE_HOME` or `~/.cache`; Windows uses `%LOCALAPPDATA%` (LOCAL, not
 * Roaming) or `~/AppData/Local`. A relative env base is ignored (XDG spec) and
 * the default used instead.
 * @param {string} home
 * @param {NodeJS.ProcessEnv} env
 * @param {NodeJS.Platform} platform
 * @returns {string}
 */
function canonicalCacheDir(home, env, platform) {
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA;
    const base = isUsableBase(localAppData, platform) ? localAppData : path.join(home, "AppData", "Local");
    return path.join(base, "deliberation");
  }
  const xdg = env.XDG_CACHE_HOME;
  const base = isUsableBase(xdg, platform) ? xdg : path.join(home, ".cache");
  return path.join(base, "deliberation");
}

/**
 * Resolve the absolute path to the Grok files cache the caller should use.
 *
 * Precedence:
 *   1. DELIBERATION_CACHE if non-empty -> return it verbatim.
 *   2. Else the canonical XDG cache path.
 *
 * Pure path logic - no FS access, no side effects.
 *
 * @param {ResolveOptions} [opts]
 * @returns {string} absolute path to the grok-files.json cache to use
 */
function resolveGrokCachePath(opts) {
  const { home, env, platform } = resolveInjection(opts);

  const override = env.DELIBERATION_CACHE;
  if (typeof override === "string" && override.length > 0) {
    return override;
  }

  return path.join(canonicalCacheDir(home, env, platform), "grok-files.json");
}

module.exports = {
  resolveConfigPath,
  resolveGrokCachePath,
};
