"use strict";
/**
 * Drift guard for the generated per-host plugin artifacts.
 *
 * Asserts that every file scripts/sync-hosts.js would write matches what is
 * committed on disk (CRLF-normalized), and that the Codex plugin manifest's
 * version equals version.json. If this fails, run `node scripts/sync-hosts.js`
 * and commit the result.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..");
const { buildArtifacts, readVersion, readDiskLF, CLAUDE_ONLY_TOKENS } = require("../scripts/sync-hosts.js");

const CODEX_MANIFEST = "plugins/deliberation/.codex-plugin/plugin.json";

test("host artifacts on disk match the generator (no drift)", () => {
  const artifacts = buildArtifacts();
  const drifted = [];
  for (const [rel, content] of Object.entries(artifacts)) {
    if (readDiskLF(path.join(REPO_ROOT, rel)) !== content) drifted.push(rel);
  }
  assert.deepStrictEqual(drifted, [], `out of date - run \`node scripts/sync-hosts.js\`: ${drifted.join(", ")}`);
});

test("Codex plugin manifest version matches version.json", () => {
  const version = readVersion();
  const manifest = JSON.parse(buildArtifacts()[CODEX_MANIFEST]);
  assert.strictEqual(manifest.version, version);
});

test("no host artifact leaks a Claude-Code-only reference", () => {
  // buildArtifacts() also throws via the assertHostClean guard; this scans every
  // file explicitly so a violation names the exact artifact + token.
  const offenders = [];
  for (const [rel, content] of Object.entries(buildArtifacts())) {
    for (const re of CLAUDE_ONLY_TOKENS) {
      if (re.test(content)) offenders.push(`${rel} :: ${re}`);
    }
  }
  assert.deepStrictEqual(offenders, [], `Claude-only refs leaked into host artifacts:\n${offenders.join("\n")}`);
});
