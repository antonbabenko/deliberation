"use strict";

/**
 * core/resolve-bin.js - resolve a provider CLI name into something Node can actually spawn.
 *
 * Zero runtime dependencies. CommonJS. JSDoc-typed for the strict `tsc` gate.
 *
 * Why this exists: on Windows, npm installs a CLI as a `codex.cmd` / `codex.ps1` shim rather
 * than an executable. Node's `spawn` with `shell:false` cannot execute a `.cmd` - since the
 * CVE-2024-27980 hardening in Node 18.20 / 20.12 it fails outright (ENOENT/EINVAL), so the
 * process never starts. See https://github.com/antonbabenko/deliberation/issues/170.
 *
 * `shell: true` would "fix" it and quietly break something worse: the shell becomes the child,
 * so a `child.kill("SIGKILL")` on timeout kills the shell and leaves the real CLI running. The
 * provider timeouts are load-bearing (they feed the consensus circuit breaker), so this module
 * resolves an actually-spawnable target instead and every caller keeps `shell:false`.
 *
 * Platform, env, and the filesystem probe are all INJECTABLE, mirroring `core/paths.js`, so the
 * win32 branch is unit-testable on macOS and Linux - which matters because CI has no Windows
 * runner.
 */

const path = require("node:path");
const fs = require("node:fs");

/** Windows extensions Node/libuv can hand straight to CreateProcess. */
const DIRECT_EXTS = new Set([".exe", ".com"]);
/** Windows extensions that need an interpreter - the npm-shim case this module exists for. */
const SHIM_EXTS = new Set([".cmd", ".bat", ".ps1"]);
/** Fallback when PATHEXT is unset, matching the Windows default. */
const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

/**
 * @typedef {Object} NpmEntryHint
 * @property {string} pkg  npm package name, e.g. "@openai/codex"
 * @property {string} bin  entry path inside the package, e.g. "bin/codex.js"
 */

/**
 * @typedef {Object} SpawnTarget
 * @property {string} cmd  what to pass as spawn's first argument
 * @property {string[]} prefixArgs  args to prepend before the caller's own argv
 * @property {boolean} shim  true when the only match needs a shell we refuse to use - the
 *   caller should fail with an actionable message rather than spawn it
 */

/**
 * @typedef {Object} ResolveOpts
 * @property {string} [platform]  defaults to process.platform
 * @property {Record<string, (string|undefined)>} [env]  defaults to process.env
 * @property {(p: string) => boolean} [exists]  defaults to fs.existsSync
 * @property {string} [nodePath]  defaults to process.execPath
 * @property {NpmEntryHint} [npmEntry]  enables the shim bypass; omit when the CLI is not on npm
 */

/**
 * Resolve a command name into a spawnable target.
 *
 * Pass-through cases (identical behaviour to a bare `spawn(name, argv)`):
 *   - any name containing a path separator - an explicit path is the caller's business, and the
 *     test harness relies on this (it points AGY_BIN at an absolute fixture)
 *   - any non-win32 platform - this module must not change macOS or Linux behaviour at all
 *   - win32 with no PATH match - preserve today's ENOENT rather than invent a different failure
 *
 * @param {string} name
 * @param {ResolveOpts} [opts]
 * @returns {SpawnTarget}
 */
function resolveCommand(name, opts) {
  const o = opts || {};
  const passthrough = { cmd: name, prefixArgs: [], shim: false };
  if (typeof name !== "string" || !name) return passthrough;

  const platform = o.platform || process.platform;
  if (platform !== "win32") return passthrough;

  const env = o.env || process.env;
  const exists = o.exists || fs.existsSync;
  const nodePath = o.nodePath || process.execPath;
  const bypass = (/** @type {string} */ shimPath) => npmBypass(shimPath, o.npmEntry, exists, nodePath);
  const dirs = String(env.PATH || env.Path || "").split(";").filter(Boolean);
  const exts = String(env.PATHEXT || DEFAULT_PATHEXT).split(";").filter(Boolean);

  // An explicitly named shim - `CODEX_BIN=codex.cmd`, or a full path to one. Handled BEFORE the
  // path-separator passthrough below, because passing it through spawns a shim Node cannot
  // execute and reports "set CODEX_BIN", which is circular advice for someone who just did.
  const named = path.win32.extname(name).toLowerCase();
  if (SHIM_EXTS.has(named)) {
    // A bare shim NAME still needs locating - only a path-bearing one is already located, and a
    // global install's entry point lives beside the shim, not beside the process's cwd.
    const located = name.includes("/") || name.includes("\\") ? name : findOnPath(name, dirs, exists) || name;
    return bypass(located) || { cmd: located, prefixArgs: [], shim: true };
  }

  // Any other explicit path (absolute or relative) is already a resolved target.
  if (name.includes("/") || name.includes("\\")) return passthrough;

  // FIRST MATCH WINS, in PATH order then PATHEXT order - the same precedence libuv and `where`
  // apply. Preferring a real .exe from a LATER directory would silently run a different install
  // than the one the user's own shell resolves.
  /** @type {string|null} */
  let firstShim = null;
  for (const dir of dirs) {
    for (const raw of exts) {
      // PATHEXT is conventionally UPPERCASE while npm writes `codex.cmd`. Windows paths are
      // case-insensitive so either probes fine there, but the lowercase form is the one that
      // matches the file as it actually sits on disk - which keeps error messages honest.
      const lower = raw.toLowerCase();
      const candidate = path.win32.join(dir, name + lower);
      if (!exists(candidate)) continue;
      // A real executable is spawnable as-is. Node already resolves this case via PATHEXT, so
      // nothing changes for a native install.
      if (DIRECT_EXTS.has(lower)) return { cmd: candidate, prefixArgs: [], shim: false };
      if (!SHIM_EXTS.has(lower)) continue;
      // The winning entry is a shim: bypass it via the package's own JS entry point if we can.
      const viaNode = bypass(candidate);
      if (viaNode) return viaNode;
      // No entry point behind it - a broken or partial install. Remember it and keep scanning.
      // Anything usable further down PATH (a real .exe, or another shim that DOES have its
      // package) is out of the order the user's shell would pick, but it beats failing outright
      // when a working install exists. The first shim is still what gets REPORTED if nothing
      // usable turns up, since that is the one the user believes they are running.
      if (firstShim === null) firstShim = candidate;
    }
  }

  if (firstShim === null) return passthrough;

  // Only unusable shims exist. Report one, so the caller can explain the real problem instead
  // of surfacing a bare EINVAL that tells a user nothing.
  return { cmd: firstShim, prefixArgs: [], shim: true };
}

/**
 * Find an exact filename on PATH. No extension is appended - the caller already has one.
 * @param {string} file
 * @param {string[]} dirs
 * @param {(p: string) => boolean} exists
 * @returns {string|null}
 */
function findOnPath(file, dirs, exists) {
  for (const dir of dirs) {
    const candidate = path.win32.join(dir, file);
    if (exists(candidate)) return candidate;
  }
  return null;
}

/**
 * Turn an npm shim into a directly spawnable `node <entry>` target, or null when there is no
 * entry point behind it. The shim itself is never executed.
 *
 * Two layouts are probed, because both put a `.cmd` on a Windows machine:
 *   - global:  <prefix>\codex.cmd            -> <prefix>\node_modules\<pkg>\<bin>
 *   - local:   <root>\node_modules\.bin\codex.cmd -> <root>\node_modules\<pkg>\<bin>
 *
 * @param {string} shimPath
 * @param {(NpmEntryHint|undefined)} npmEntry
 * @param {(p: string) => boolean} exists
 * @param {string} nodePath
 * @returns {SpawnTarget|null}
 */
function npmBypass(shimPath, npmEntry, exists, nodePath) {
  if (!npmEntry || !npmEntry.pkg || !npmEntry.bin) return null;
  const dir = path.win32.dirname(shimPath);
  const roots = [dir];
  // npm puts a locally installed CLI's shim in node_modules/.bin, one level below the package.
  if (path.win32.basename(dir).toLowerCase() === ".bin") roots.push(path.win32.dirname(path.win32.dirname(dir)));
  for (const root of roots) {
    const entry = path.win32.join(root, "node_modules", npmEntry.pkg, npmEntry.bin);
    if (exists(entry)) return { cmd: nodePath, prefixArgs: [entry], shim: false };
  }
  return null;
}

/**
 * One-line explanation for a `shim: true` resolution, so every caller says the same thing.
 * @param {string} name  the command that was looked up
 * @param {string} shimPath  the shim that was found
 * @param {string} envVar  the override the user can set, e.g. "CODEX_BIN"
 * @returns {string}
 */
function shimMessage(name, shimPath, envVar) {
  return (
    `${name} resolved only to a shell shim (${shimPath}), which Node cannot execute directly. ` +
    `Set ${envVar} to the real executable, or reinstall ${name} so a .exe is on PATH.`
  );
}

module.exports = { resolveCommand, shimMessage, DIRECT_EXTS, SHIM_EXTS, DEFAULT_PATHEXT };
