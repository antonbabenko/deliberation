"use strict";
/**
 * Drift guard for the plugin manifest's per-server tool-call timeout.
 *
 * Claude Code resolves a server's tool-call cap as
 * `config.timeout ?? MCP_TOOL_TIMEOUT ?? default`, so the manifest raises the cap
 * on capped hosts (Claude Code on the web exports MCP_TOOL_TIMEOUT=60000) without
 * touching the host environment. The server process still INHERITS the host's
 * MCP_TOOL_TIMEOUT, and core/host-budget.js clamps every provider ceiling under
 * that value - so the manifest must also mirror the timeout into the server's own
 * env, or the clamp cancels the override. Both numbers must stay equal.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const MANIFEST = path.resolve(__dirname, "..", ".claude-plugin", "plugin.json");
const CODEX_CEILING_MS = 600000; // the largest built-in provider ceiling (core/providers/codex.js)

test("every plugin MCP server declares a tool-call timeout above the provider ceilings and mirrors it into its env", () => {
  const { mcpServers } = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
  const names = Object.keys(mcpServers || {});
  assert.ok(names.length > 0, "manifest registers no MCP servers");
  for (const name of names) {
    const s = mcpServers[name];
    assert.equal(typeof s.timeout, "number", `${name}: timeout missing`);
    assert.ok(s.timeout >= CODEX_CEILING_MS, `${name}: timeout ${s.timeout} is under the codex ceiling ${CODEX_CEILING_MS}`);
    assert.equal(Number(s.env && s.env.MCP_TOOL_TIMEOUT), s.timeout, `${name}: env.MCP_TOOL_TIMEOUT must equal timeout so host-budget clamps against the real cap`);
  }
});
