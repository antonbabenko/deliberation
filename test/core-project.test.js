"use strict";
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { resolveProject, projectIdOf } = require("../core/project.js");

/** @type {string[]} */
const tmpDirs = [];
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

function tmp() {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "proj-")));
  tmpDirs.push(d);
  return d;
}

/** A main checkout at <base>/<name> with a real .git dir. */
function mainRepo(/** @type {string} */ base, name = "app") {
  const root = path.join(base, name);
  fs.mkdirSync(path.join(root, ".git", "worktrees"), { recursive: true });
  fs.mkdirSync(path.join(root, "src", "deep"), { recursive: true });
  return root;
}

/** A linked worktree of `main` at <base>/<wt>, gitdir written absolute or relative. */
function worktree(/** @type {string} */ base, /** @type {string} */ main, wt = "wt-1", relative = false) {
  const gitdir = path.join(main, ".git", "worktrees", wt);
  fs.mkdirSync(gitdir, { recursive: true });
  fs.writeFileSync(path.join(gitdir, "commondir"), "../..\n");
  const root = path.join(base, wt);
  fs.mkdirSync(root, { recursive: true });
  const target = relative ? path.relative(root, gitdir) : gitdir;
  fs.writeFileSync(path.join(root, ".git"), `gitdir: ${target}\n`);
  return root;
}

test("PRJ1: repo root and a subdir resolve to the same project", () => {
  const root = mainRepo(tmp());
  const a = resolveProject(root);
  const b = resolveProject(path.join(root, "src", "deep"));
  assert.ok(a && b);
  assert.equal(a.name, "app");
  assert.equal(a.root, root);
  assert.deepEqual(b, a);
  assert.match(a.id, /^[0-9a-f]{12}$/);
});

test("PRJ2: a worktree (absolute and relative gitdir) groups under the main repo id and name", () => {
  const base = tmp();
  const main = mainRepo(base);
  const abs = worktree(base, main, "wt-abs", false);
  const rel = worktree(base, main, "wt-rel", true);
  const m = resolveProject(main), w1 = resolveProject(abs), w2 = resolveProject(rel);
  assert.ok(m && w1 && w2);
  assert.equal(w1.id, m.id);
  assert.equal(w2.id, m.id);
  assert.equal(w1.name, "app");
  assert.equal(w1.root, abs, "root stays the worktree path for hover");
  assert.equal(w2.root, rel);
});

test("PRJ3: a submodule (.git file, no commondir) is its own project", () => {
  const base = tmp();
  const main = mainRepo(base);
  const modDir = path.join(main, ".git", "modules", "lib");
  fs.mkdirSync(modDir, { recursive: true });
  const sub = path.join(main, "lib");
  fs.mkdirSync(sub);
  fs.writeFileSync(path.join(sub, ".git"), "gitdir: ../.git/modules/lib\n");
  const s = resolveProject(sub), m = resolveProject(main);
  assert.ok(s && m);
  assert.equal(s.name, "lib");
  assert.notEqual(s.id, m.id);
});

test("PRJ4: no git falls back to the directory itself", () => {
  const dir = path.join(tmp(), "plain");
  fs.mkdirSync(dir);
  const p = resolveProject(dir);
  assert.ok(p);
  assert.equal(p.name, "plain");
  assert.equal(p.root, dir);
  assert.equal(p.id, projectIdOf(dir));
});

test("PRJ5: a missing dir returns null and is retried, never memoized as a miss", () => {
  const dir = path.join(tmp(), "later");
  assert.equal(resolveProject(dir), null);
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  const p = resolveProject(dir);
  assert.ok(p);
  assert.equal(p.name, "later");
});

test("PRJ6: non-string or empty input returns null without throwing", () => {
  assert.equal(resolveProject(/** @type {any} */ (undefined)), null);
  assert.equal(resolveProject(""), null);
  assert.equal(resolveProject(/** @type {any} */ (42)), null);
});

test("PRJ7: a malformed .git file is treated as a plain repo root, not a throw", () => {
  const dir = path.join(tmp(), "odd");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, ".git"), "garbage\n");
  const p = resolveProject(dir);
  assert.ok(p);
  assert.equal(p.name, "odd");
  assert.equal(p.root, dir);
});
