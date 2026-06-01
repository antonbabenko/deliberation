"use strict";
/**
 * Cursor host artifacts.
 *
 * Cursor reads project rules from .cursor/rules/*.mdc (frontmatter + body).
 * We generate the rule verbatim from the curated fenced block in
 * examples/cursor.md, so that one file stays the single source of truth.
 *
 * MCP install for Cursor is the one-click deeplink documented in the README
 * (cursor://anysphere.cursor-deeplink/mcp/install?...) - no generated artifact.
 *
 * @param {{ repoRoot: string }} ctx
 * @returns {Record<string,string>}
 */
const S = require("./_shared");

function build(ctx) {
  return {
    ".cursor/rules/deliberation.mdc": S.extractFencedBlock(ctx.repoRoot, "examples/cursor.md", "mdc"),
  };
}

build.id = "cursor";
module.exports = build;
