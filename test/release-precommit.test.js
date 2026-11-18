"use strict";
// Every manifest the validate workflow checks against version.json must also be bumped by the
// release pre-commit hook; otherwise the release branch fails its own version check.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

test("RPC-1: release pre-commit bumps every manifest the validate workflow version-checks", () => {
  const workflow = fs.readFileSync(path.join(ROOT, ".github/workflows/validate.yml"), "utf8");
  const hook = fs.readFileSync(path.join(ROOT, ".github/release/pre-commit.js"), "utf8");
  const checked = [...workflow.matchAll(/\['([^']+)', readJSON\('\1'\)/g)].map((m) => m[1]);
  assert.ok(checked.length >= 5, `expected the version-check list in validate.yml, found ${checked.length}`);
  for (const rel of checked) {
    if (rel === "version.json") continue;
    assert.ok(hook.includes(`rel: '${rel}'`), `${rel} is version-checked in CI but not bumped by .github/release/pre-commit.js`);
  }
});
