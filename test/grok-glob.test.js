"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const glob = require("../server/grok/glob.js");

test("matchPattern: ** matches any depth", () => {
  assert.equal(glob.matchPattern("**/*.tf", "main.tf"), true);
  assert.equal(glob.matchPattern("**/*.tf", "modules/web/main.tf"), true);
  assert.equal(glob.matchPattern("**/*.tf", "main.js"), false);
});

test("matchPattern: * does not cross /", () => {
  assert.equal(glob.matchPattern("*.tf", "main.tf"), true);
  assert.equal(glob.matchPattern("*.tf", "modules/main.tf"), false);
});

test("matchPattern: ? matches single non-/ char", () => {
  assert.equal(glob.matchPattern("a?c.tf", "abc.tf"), true);
  assert.equal(glob.matchPattern("a?c.tf", "a/c.tf"), false);
});

test("matchPattern: character class [abc]", () => {
  assert.equal(glob.matchPattern("[abc].tf", "a.tf"), true);
  assert.equal(glob.matchPattern("[abc].tf", "d.tf"), false);
});

test("matchPattern: bare directory name (no slash) matches at any depth", () => {
  assert.equal(glob.matchPattern("node_modules", "node_modules"), true);
  assert.equal(glob.matchPattern("node_modules", "src/node_modules"), true);
  assert.equal(glob.matchPattern("node_modules", "node_modules/foo"), false);
});

test("matchPattern: dir/** matches everything under dir", () => {
  assert.equal(glob.matchPattern("dist/**", "dist/index.js"), true);
  assert.equal(glob.matchPattern("dist/**", "dist/foo/bar.js"), true);
  assert.equal(glob.matchPattern("dist/**", "dist"), false);
});

test("rejectBackslashes throws for patterns containing backslash", () => {
  assert.throws(() => glob.rejectBackslashes("src\\*.tf"), /backslash/i);
  assert.doesNotThrow(() => glob.rejectBackslashes("src/*.tf"));
});

test("**/* matches root-level files", () => {
  assert.equal(glob.matchPattern("**/*", "README.md"), true);
});

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function makeTree(spec) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-glob-"));
  for (const [rel, contents] of Object.entries(spec)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents);
  }
  return root;
}

test("walk returns files matching include and excludes excluded dirs (prune-before-descend)", () => {
  const root = makeTree({
    "a.tf": "1",
    "modules/web/main.tf": "2",
    "node_modules/dep/index.js": "3",
    ".git/HEAD": "ref",
  });
  const out = glob.walk(root, {
    include: ["**/*.tf"],
    exclude: ["node_modules", ".git"],
    maxFiles: 100,
    maxBytes: 1024 * 1024,
  });
  assert.deepEqual(out.files.map((f) => f.rel).sort(), ["a.tf", "modules/web/main.tf"]);
});

test("walk normalises backslashes to forward slashes in walked rel paths", () => {
  const root = makeTree({ "sub/deep/x.tf": "ok" });
  const out = glob.walk(root, { include: ["**/*.tf"], exclude: [], maxFiles: 100, maxBytes: 1024 });
  assert.deepEqual(out.files.map((f) => f.rel), ["sub/deep/x.tf"]);
});

test("walk throws when maxFiles exceeded", () => {
  const root = makeTree({ "a.tf": "1", "b.tf": "2", "c.tf": "3" });
  assert.throws(
    () => glob.walk(root, { include: ["**/*"], exclude: [], maxFiles: 2, maxBytes: 1024 }),
    /exceeded maxFiles=2/,
  );
});

test("walk throws when maxBytes exceeded", () => {
  const root = makeTree({ "a.tf": "x".repeat(60), "b.tf": "y".repeat(60) });
  assert.throws(
    () => glob.walk(root, { include: ["**/*"], exclude: [], maxFiles: 100, maxBytes: 100 }),
    /exceeded maxBytes=100/,
  );
});

test("walk throws early inside descend once maxFiles is exceeded (does not exhaust the tree first)", () => {
  const root = makeTree({ "a.tf": "1", "b.tf": "2", "c.tf": "3", "d.tf": "4" });
  assert.throws(
    () => glob.walk(root, { include: ["**"], exclude: [], maxFiles: 1, maxBytes: 1024 * 1024 }),
    /exceeded maxFiles=1/,
  );
});

test("walk produces deterministic POSIX-sorted file order", () => {
  const root = makeTree({ "z.tf": "1", "a.tf": "2", "m/n.tf": "3" });
  const out = glob.walk(root, { include: ["**/*"], exclude: [], maxFiles: 100, maxBytes: 1024 });
  assert.deepEqual(out.files.map((f) => f.rel), ["a.tf", "m/n.tf", "z.tf"]);
});
