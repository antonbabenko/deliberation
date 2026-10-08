"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

/**
 * @typedef {object} ProjectRef
 * @property {string} id    group id, 12 hex chars: the git remote (host + path) when one is
 *                          found, else the main git dir, so every clone and worktree of a remote
 *                          shares it; never a path
 * @property {string} name  `org/repo` from the remote, else the main repo's folder name
 * @property {string} root  the checkout the run came from (absolute path; masked at serve time)
 * @property {string} ws    workspace id, 12 hex chars of the checkout's real path
 */

const MEMO_MAX = 256;
/** @type {Map<string, ProjectRef>} successes only, so a dir that appears later is resolved again */
const memo = new Map();

/** @param {string} basis @returns {string} */
const projectIdOf = (basis) => crypto.createHash("sha256").update(basis).digest("hex").slice(0, 12);

/** @param {string} p @returns {string} */
const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

/**
 * `{host, path}` of a remote URL, or null for a local or unparseable one. Credentials and a
 * `.git` suffix are dropped; the raw URL is never kept (an https URL can carry a token).
 * @param {string} url
 * @returns {({host: string, path: string}|null)}
 */
function parseRemote(url) {
  const u = String(url || "").trim();
  let m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(u);
  if (m && /^file:/i.test(u)) return null;
  if (!m) m = /^(?:[^@/:]+@)?([^/:]+):(?!\/)(.+)$/.exec(u); // scp form: git@host:org/repo
  if (!m) return null;
  const repoPath = m[2].replace(/\/+$/, "").replace(/\.git$/i, "").replace(/^\/+/, "");
  if (!repoPath || !repoPath.includes("/")) return null;
  return { host: m[1].toLowerCase(), path: repoPath };
}

/**
 * The `origin` remote of a git dir's config, else its first remote; null when none parses.
 * @param {string} gitDir
 * @returns {({host: string, path: string}|null)}
 */
function remoteOf(gitDir) {
  let text;
  try { text = fs.readFileSync(path.join(gitDir, "config"), "utf8"); } catch { return null; }
  /** @type {Map<string, string>} */
  const urls = new Map();
  /** @type {(string|null)} */
  let section = null;
  for (const line of text.split(/\r?\n/)) {
    const head = /^\s*\[\s*remote\s+"([^"]+)"\s*\]/.exec(line);
    if (head) { section = head[1]; continue; }
    if (/^\s*\[/.test(line)) { section = null; continue; }
    const kv = section !== null && /^\s*url\s*=\s*(.+?)\s*$/i.exec(line);
    if (kv && section !== null && !urls.has(section)) urls.set(section, kv[1]);
  }
  const url = urls.get("origin") ?? urls.values().next().value;
  return url ? parseRemote(url) : null;
}

/**
 * Group a checkout by its remote when it has one. `gitDir` is the main git dir.
 * @param {string} gitDir @param {string} fallbackName @param {string} root
 * @returns {ProjectRef}
 */
function gitRef(gitDir, fallbackName, root) {
  const r = remoteOf(gitDir);
  const ws = projectIdOf(real(root));
  if (r) return { id: projectIdOf(`remote\0${r.host}/${r.path.toLowerCase()}`), name: r.path, root, ws };
  return { id: projectIdOf(real(gitDir)), name: fallbackName, root, ws };
}

/**
 * Read a `.git` FILE (`gitdir: X`). Returns the main git dir that identifies the
 * repo, and whether the checkout is a worktree, or null when the file is not a
 * gitdir pointer.
 * @param {string} gitFile
 * @returns {({gitDir: string, mainGitDir: string, worktree: boolean}|null)}
 */
function readGitFile(gitFile) {
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(gitFile, "utf8"));
  if (!m) return null;
  const gitDir = path.resolve(path.dirname(gitFile), m[1]);
  let common = null;
  try { common = fs.readFileSync(path.join(gitDir, "commondir"), "utf8").trim(); } catch { /* no commondir: submodule or separate git dir */ }
  if (!common) return { gitDir, mainGitDir: gitDir, worktree: false };
  return { gitDir, mainGitDir: path.resolve(gitDir, common), worktree: true };
}

/**
 * Where a run was called from. Walks up from `dir` to the nearest `.git` entry:
 * a main checkout, a linked worktree (grouped under its main repo), or a submodule
 * (its own project). No git anywhere above -> the directory itself. Stat/read only,
 * no `git` spawn; never throws.
 * @param {string} dir
 * @returns {(ProjectRef|null)} null when `dir` is not an existing directory
 */
function resolveProject(dir) {
  if (typeof dir !== "string" || !dir) return null;
  const start = path.resolve(dir);
  const hit = memo.get(start);
  if (hit) return hit;
  try {
    if (!fs.statSync(start).isDirectory()) return null;
  } catch {
    return null;
  }
  /** @type {ProjectRef} */
  let ref = { id: projectIdOf(real(start)), name: path.basename(start) || start, root: start, ws: projectIdOf(real(start)) };
  try {
    for (let cur = start; ; cur = path.dirname(cur)) {
      const dotGit = path.join(cur, ".git");
      let st = null;
      try { st = fs.statSync(dotGit); } catch { /* keep walking */ }
      if (st && st.isDirectory()) {
        ref = gitRef(dotGit, path.basename(cur) || cur, cur);
        break;
      }
      if (st && st.isFile()) {
        const g = readGitFile(dotGit);
        if (!g) ref = { id: projectIdOf(real(cur)), name: path.basename(cur) || cur, root: cur, ws: projectIdOf(real(cur)) };
        else {
          const mainRoot = path.dirname(g.mainGitDir);
          ref = gitRef(g.mainGitDir, path.basename(g.worktree ? mainRoot : cur) || cur, cur);
        }
        break;
      }
      if (path.dirname(cur) === cur) break;
    }
  } catch {
    // Unreadable .git file or similar: keep the plain-directory fallback.
  }
  if (memo.size >= MEMO_MAX) memo.delete(/** @type {string} */ (memo.keys().next().value));
  memo.set(start, ref);
  return ref;
}

const HEX12 = /^[0-9a-f]{12}$/;

/**
 * A journal `project` in today's shape, or null. A run recorded before `ws` existed is
 * re-resolved from its root when that dir still exists (so it joins its remote group);
 * otherwise it keeps its old group and gets a ws from the root path.
 * @param {unknown} p
 * @returns {(ProjectRef|null)}
 */
function normalizeProject(p) {
  const v = /** @type {any} */ (p);
  if (!v || typeof v !== "object" || typeof v.id !== "string") return null;
  const root = String(v.root || "");
  const base = { id: v.id, name: String(v.name || v.id), root };
  if (typeof v.ws === "string" && HEX12.test(v.ws)) return { ...base, ws: v.ws };
  const now = root && path.isAbsolute(root) ? resolveProject(root) : null;
  if (now && now.root === root) return now;
  return { ...base, ws: projectIdOf(root || v.id) };
}

module.exports = { resolveProject, normalizeProject, parseRemote, projectIdOf };
