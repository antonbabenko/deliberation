"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { PROMPTS } = require("../core/prompts/index.js");
const { PERSONA_KEYS, readPersonas, renderModule, OUT_FILE } = require("../scripts/sync-prompts.js");

const EXPERT_KEYS = [
  "architect",
  "plan-reviewer",
  "scope-analyst",
  "code-reviewer",
  "security-analyst",
  "researcher",
  "debugger",
  "writing-editor",
];

test("P1: PROMPTS map exports all 8 experts plus arbiter as non-empty strings", () => {
  for (const key of [...EXPERT_KEYS, "arbiter"]) {
    assert.equal(typeof PROMPTS[key], "string", `${key} should be a string`);
    assert.ok(PROMPTS[key].length > 50, `${key} persona should be substantial`);
  }
  assert.deepEqual(Object.keys(PROMPTS).sort(), PERSONA_KEYS.slice().sort());
});

test("P2: committed core/prompts/index.js matches regenerating from prompts/*.md (drift guard)", () => {
  // Regenerate in memory - do NOT rewrite the file - and compare byte-for-byte.
  const regenerated = renderModule(readPersonas());
  const committed = fs.readFileSync(OUT_FILE, "utf8");
  assert.equal(
    committed,
    regenerated,
    "core/prompts/index.js is stale - run `node scripts/sync-prompts.js` to regenerate from prompts/*.md"
  );
});

test("P3: personas carry no runtime fs/.md reads (data only)", () => {
  const committed = fs.readFileSync(OUT_FILE, "utf8");
  assert.equal(/readFileSync|require\(.*\.md/.test(committed), false);
});
