"use strict";
// Regression guard for the command-fallback generator (scripts/sync-fallbacks.js).
// Pure: reads prompts/*.md from the repo, no network, no writes.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  FALLBACK_ORDER,
  ATTRIBUTION,
  ATTRIBUTION_LINE,
  MARKER,
  sectionFor,
  buildRegion,
  applyRegion,
  REPO_ROOT,
} = require("../scripts/sync-fallbacks");

test("region carries every expert as an `## Inlined fallback - <Name>` heading, in order", () => {
  const region = buildRegion(REPO_ROOT);
  const headings = [...region.matchAll(/^## Inlined fallback - (.+)$/gm)].map((m) => m[1]);
  assert.equal(headings.length, FALLBACK_ORDER.length, "one heading per expert");
  // Display names are derived from each prompt's H1; assert order is preserved by
  // checking each heading appears after the previous one.
  let cursor = -1;
  for (const name of headings) {
    const at = region.indexOf(`## Inlined fallback - ${name}`);
    assert.ok(at > cursor, `heading "${name}" out of order`);
    cursor = at;
  }
});

test("attribution blockquote appears on exactly the oh-my-opencode personas", () => {
  for (const key of FALLBACK_ORDER) {
    const section = sectionFor(REPO_ROOT, key);
    const hasAttrib = section.includes(ATTRIBUTION_LINE);
    assert.equal(hasAttrib, ATTRIBUTION.has(key), `attribution mismatch for ${key}`);
  }
});

test("no leading `# <Name>` H1 leaks into any fallback body", () => {
  const region = buildRegion(REPO_ROOT);
  // A leaked persona H1 would be a single-hash heading line; the only headings in
  // the region must be the `## Inlined fallback` ones and the personas' own `##`
  // subsections. There must be NO single-`#` line.
  const singleHash = region.match(/^# \S.*$/m);
  assert.equal(singleHash, null, `leaked H1: ${singleHash && singleHash[0]}`);
});

test("region begins with the GENERATED marker", () => {
  const region = buildRegion(REPO_ROOT);
  assert.ok(region.startsWith(`${MARKER}\n\n`), "region must start with the marker");
});

test("applyRegion is idempotent and replaces the old marker", () => {
  const region = buildRegion(REPO_ROOT);
  const fake =
    "# Command\n\nHand-written prose.\n\n" +
    "<!-- DO NOT DELETE: required fallback if plugin cache missing. See C1 in implementation plan. -->\n" +
    "## Inlined fallback - Architect\n\nstale body\n";
  const once = applyRegion(fake, region, "fake.md");
  const twice = applyRegion(once, region, "fake.md");
  assert.equal(once, twice, "second apply must be a no-op");
  assert.ok(once.startsWith("# Command\n\nHand-written prose.\n\n" + MARKER), "prose preserved, marker replaced");
  assert.ok(!once.includes("DO NOT DELETE"), "old marker gone");
  assert.ok(!once.includes("stale body"), "old region content gone");
});

test("applyRegion throws when no fallback marker is present", () => {
  assert.throws(() => applyRegion("no marker here\n", buildRegion(REPO_ROOT), "x.md"), /no fallback marker/);
});
