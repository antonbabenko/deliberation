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
