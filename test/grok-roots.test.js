"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const idx = require("../server/grok/index.js");

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), "grok-roots-")); }

test("validateRoots accepts an array of absolute existing directories", () => {
  const a = tmpDir(); const b = tmpDir();
  assert.doesNotThrow(() => idx.validateRoots([a, b]));
});

test("validateRoots refuses a relative root", () => {
  assert.throws(() => idx.validateRoots(["./relative"]), /absolute/);
});

test("validateRoots refuses a non-existent root", () => {
  assert.throws(() => idx.validateRoots(["/no/such/dir/xyz/zzz"]), /not exist|does not exist|ENOENT/i);
});

test("validateRoots refuses a non-directory root", () => {
  const a = tmpDir();
  const filePath = path.join(a, "f");
  fs.writeFileSync(filePath, "x");
  assert.throws(() => idx.validateRoots([filePath]), /directory/i);
});

test("resolvePathUnderRoots picks the first root containing the file", () => {
  const a = tmpDir(); const b = tmpDir();
  fs.writeFileSync(path.join(b, "x.tf"), "ok");
  const r = idx.resolvePathUnderRoots("x.tf", [a, b], "file");
  assert.equal(r.root, fs.realpathSync(b));
  assert.equal(r.abs, fs.realpathSync(path.join(b, "x.tf")));
});

test("resolvePathUnderRoots refuses when no root contains the file", () => {
  const a = tmpDir(); const b = tmpDir();
  assert.throws(
    () => idx.resolvePathUnderRoots("missing.tf", [a, b], "file"),
    /not found in any root/,
  );
});

test("resolvePathUnderRoots refuses sibling-path escape", () => {
  const a = tmpDir();
  const sibling = a + "-sibling";
  fs.mkdirSync(sibling);
  fs.writeFileSync(path.join(sibling, "secret.tf"), "leak");
  assert.throws(
    () => idx.resolvePathUnderRoots(path.join(sibling, "secret.tf"), [a], "file"),
    /outside.*roots|not.*found/i,
  );
});

test("resolvePathUnderRoots requires isDirectory for type=dir", () => {
  const a = tmpDir();
  fs.mkdirSync(path.join(a, "modules"));
  fs.writeFileSync(path.join(a, "afile"), "x");
  const ok = idx.resolvePathUnderRoots("modules", [a], "dir");
  assert.equal(ok.abs, fs.realpathSync(path.join(a, "modules")));
  // afile is a regular file; under type=dir we walk all roots, fail to find a
  // directory, and surface a "not found in any root" error.
  assert.throws(
    () => idx.resolvePathUnderRoots("afile", [a], "dir"),
    /not found in any root|outside.*roots/i,
  );
});
