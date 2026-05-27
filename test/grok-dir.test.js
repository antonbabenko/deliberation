"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const idx = require("../server/grok/index.js");

function tmpTree(spec) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-dir-"));
  for (const [rel, contents] of Object.entries(spec)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents);
  }
  return root;
}

test("validateFiles accepts {dir, include, exclude, maxFiles, maxBytes}", () => {
  const err = idx.validateFiles([{ dir: "modules", include: ["**/*.tf"], maxFiles: 10 }]);
  assert.equal(err, null);
});

test("validateFiles rejects {dir} combined with {path}", () => {
  const err = idx.validateFiles([{ dir: "a", path: "b" }]);
  assert.match(err || "", /exactly one of/);
});

test("validateFiles rejects {dir} with backslashes in include pattern", () => {
  const err = idx.validateFiles([{ dir: "a", include: ["src\\*.tf"] }]);
  assert.match(err || "", /backslash/i);
});

module.exports = { tmpTree };
