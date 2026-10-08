"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

/**
 * @typedef {object} ProjectRef
 * @property {string} id    12 hex chars, stable across a repo's checkouts; never a path
 * @property {string} name  display name (the main repo's folder name for a worktree)
 * @property {string} root  the checkout the run came from (absolute path; masked at serve time)
 */

const MEMO_MAX = 256;
/** @type {Map<string, ProjectRef>} successes only, so a dir that appears later is resolved again */
const memo = new Map();

/** @param {string} basis @returns {string} */
const projectIdOf = (basis) => crypto.createHash("sha256").update(basis).digest("hex").slice(0, 12);

/** @param {string} p @returns {string} */
const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

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
  let ref = { id: projectIdOf(real(start)), name: path.basename(start) || start, root: start };
  try {
    for (let cur = start; ; cur = path.dirname(cur)) {
      const dotGit = path.join(cur, ".git");
      let st = null;
      try { st = fs.statSync(dotGit); } catch { /* keep walking */ }
      if (st && st.isDirectory()) {
        ref = { id: projectIdOf(real(dotGit)), name: path.basename(cur) || cur, root: cur };
        break;
      }
      if (st && st.isFile()) {
        const g = readGitFile(dotGit);
        if (!g) ref = { id: projectIdOf(real(cur)), name: path.basename(cur) || cur, root: cur };
        else {
          const mainRoot = path.dirname(g.mainGitDir);
          ref = { id: projectIdOf(real(g.mainGitDir)), name: path.basename(g.worktree ? mainRoot : cur) || cur, root: cur };
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

module.exports = { resolveProject, projectIdOf };
