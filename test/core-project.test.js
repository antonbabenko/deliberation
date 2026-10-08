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

/** Write `[remote]` sections into a git dir's config. @param {string} gitDir @param {Record<string, string>} remotes */
function remotes(gitDir, remotes) {
  fs.writeFileSync(path.join(gitDir, "config"), "[core]\n\tbare = false\n" + Object.entries(remotes).map(([n, u]) => `[remote "${n}"]\n\turl = ${u}\n\tfetch = +refs/heads/*:refs/remotes/${n}/*\n`).join(""));
}

test("PRJ8: parseRemote reads org/repo from scp, ssh and https forms and rejects local remotes", () => {
  const { parseRemote } = require("../core/project.js");
  const cases = /** @type {[string, (null|{host: string, path: string})][]} */ ([
    ["git@github.com:acme/app.git", { host: "github.com", path: "acme/app" }],
    ["ssh://git@github.com:22/acme/app", { host: "github.com", path: "acme/app" }],
    ["https://user:secret@GitHub.com/acme/app.git/", { host: "github.com", path: "acme/app" }],
    ["https://gitlab.com/group/sub/repo", { host: "gitlab.com", path: "group/sub/repo" }],
    ["file:///srv/git/app.git", null],
    ["/srv/git/app.git", null],
    ["../app", null],
    ["C:/repos/app", null],
    ["git@host:onlyname", null],
  ]);
  for (const [url, want] of cases) assert.deepEqual(parseRemote(url), want, url);
});

test("PRJ9: clones and worktrees of one remote share the group id and org/repo name, with separate workspaces", () => {
  const base = tmp();
  const main = mainRepo(base, "app");
  remotes(path.join(main, ".git"), { upstream: "git@github.com:someone/other.git", origin: "git@github.com:acme/app.git" });
  const wt = worktree(base, main, "t3-1234");
  const clone = mainRepo(base, "app-review");
  remotes(path.join(clone, ".git"), { origin: "https://github.com/acme/app" });
  const m = resolveProject(main), w = resolveProject(wt), c = resolveProject(clone);
  assert.ok(m && w && c);
  assert.equal(m.name, "acme/app", "origin wins over the first remote");
  assert.equal(w.id, m.id);
  assert.equal(c.id, m.id, "a separate clone joins the group");
  assert.equal(c.name, "acme/app");
  assert.equal(c.root, clone);
  assert.equal(new Set([m.ws, w.ws, c.ws]).size, 3, "each checkout is its own workspace");
  assert.equal(m.ws, projectIdOf(main));
  assert.ok(!JSON.stringify(c).includes("github.com"), "no URL or host is stored");
});

test("PRJ10: a repo with no usable remote keeps the git-dir id it had before remotes were read", () => {
  const root = mainRepo(tmp(), "local");
  remotes(path.join(root, ".git"), { origin: "/srv/git/local.git" });
  const p = resolveProject(root);
  assert.ok(p);
  assert.equal(p.id, projectIdOf(path.join(root, ".git")));
  assert.equal(p.name, "local");
});

test("PRJ11: normalizeProject regroups a pre-ws run whose root still exists, keeps the old group otherwise", () => {
  const { normalizeProject } = require("../core/project.js");
  const root = mainRepo(tmp(), "svc");
  remotes(path.join(root, ".git"), { origin: "git@github.com:acme/svc.git" });
  const now = resolveProject(root);
  assert.deepEqual(normalizeProject({ id: "aaaaaaaaaaaa", name: "svc", root }), now);
  const gone = normalizeProject({ id: "bbbbbbbbbbbb", name: "old", root: "/no/such/dir" });
  assert.deepEqual(gone, { id: "bbbbbbbbbbbb", name: "old", root: "/no/such/dir", ws: projectIdOf("/no/such/dir") });
  const current = { id: "cccccccccccc", name: "acme/svc", root: "/elsewhere", ws: "dddddddddddd" };
  assert.deepEqual(normalizeProject(current), current, "a run that has ws is taken as recorded");
  assert.equal(normalizeProject("/raw"), null);
});
