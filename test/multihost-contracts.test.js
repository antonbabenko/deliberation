"use strict";
/**
 * Hermetic Multi-Host Contract Test Suite.
 *
 * 100% offline, deterministic verification of:
 * 1. Skill structure & YAML frontmatter schema across host skill trees (Codex, Antigravity/Gemini).
 * 2. Host manifests & MCP config files (.claude-plugin, .codex-plugin, mcp.json, .agents, .opencode, .cursor).
 * 3. JSON-RPC 2.0 protocol handshake, version negotiation, and error contracts.
 * 4. MCP tool declarations & JSON Schema Draft-07 compliance.
 * 5. Multi-host client identity & arbiter default behavioral parity (Claude, Codex, Cursor, Kiro, OpenCode, Antigravity).
 * 6. Hermetic tool call execution invariants (zero network, pure isolation).
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..");
const { buildServer } = require("../server/mcp/index.js");
const { readVersion, CLAUDE_ONLY_TOKENS } = require("../scripts/sync-hosts.js");

const CANONICAL_SKILLS = [
  "architect",
  "code-reviewer",
  "debugger",
  "deliberation",
  "plan-reviewer",
  "researcher",
  "scope-analyst",
  "security-analyst",
];

const SKILL_HOST_TREES = [
  { host: "codex-plugin", dir: "plugins/deliberation/skills" },
  { host: "antigravity-agents", dir: ".agents/skills" },
  { host: "antigravity-gemini", dir: ".gemini/skills" },
];

const CANONICAL_PERSONAS = [
  "architect",
  "code-reviewer",
  "debugger",
  "plan-reviewer",
  "researcher",
  "scope-analyst",
  "security-analyst",
];

/**
 * Parse simple YAML frontmatter between leading `---` fences.
 * Returns { frontmatter: Record<string, string>, body: string }
 */
function parseFrontmatter(raw) {
  const normalized = raw.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    throw new Error("File does not start with YAML frontmatter fence '---'");
  }
  const endIdx = normalized.indexOf("\n---\n", 4);
  if (endIdx === -1) {
    throw new Error("YAML frontmatter closing fence '\\n---\\n' not found");
  }
  const yamlBlock = normalized.slice(4, endIdx);
  const body = normalized.slice(endIdx + 5);
  const frontmatter = {};
  for (const line of yamlBlock.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;
    const key = trimmed.slice(0, colonIdx).trim();
    let val = trimmed.slice(colonIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    frontmatter[key] = val;
  }
  return { frontmatter, body };
}

/**
 * Mock provider for hermetic server testing.
 */
function mockProvider(name, verdict = "APPROVE", text = "looks good") {
  return {
    name,
    capabilities: { canImplement: false, fileUpload: false, multiTurn: false },
    async health() { return { ok: true }; },
    async ask(req) {
      return {
        provider: name,
        model: "mock-model",
        text: `VERDICT: ${verdict}\n\n${text} for: ${req.prompt}`,
        verdict,
        criticalIssues: [],
        isError: false,
        ms: 5,
      };
    },
  };
}

// ============================================================================
// 1. Skill Structure & Frontmatter Schema Contracts
// ============================================================================

test("MHC-S1: all 8 canonical skills exist in every supported host skill tree", () => {
  for (const { host, dir } of SKILL_HOST_TREES) {
    const fullDir = path.join(REPO_ROOT, dir);
    assert.ok(fs.existsSync(fullDir), `host '${host}' skill directory missing: ${dir}`);
    for (const skill of CANONICAL_SKILLS) {
      const skillFile = path.join(fullDir, skill, "SKILL.md");
      assert.ok(fs.existsSync(skillFile), `host '${host}' missing skill file: ${path.join(dir, skill, "SKILL.md")}`);
    }
  }
});

test("MHC-S2: every SKILL.md adheres to valid YAML frontmatter schema", () => {
  for (const { host, dir } of SKILL_HOST_TREES) {
    for (const skill of CANONICAL_SKILLS) {
      const skillPath = path.join(REPO_ROOT, dir, skill, "SKILL.md");
      const content = fs.readFileSync(skillPath, "utf8");
      const { frontmatter, body } = parseFrontmatter(content);

      // name must match the skill slug or be a valid identifier
      assert.ok(frontmatter.name, `${host}/${skill}: frontmatter missing 'name'`);
      assert.strictEqual(frontmatter.name, skill, `${host}/${skill}: frontmatter 'name' mismatch`);

      // description must be non-empty and substantive
      assert.ok(frontmatter.description, `${host}/${skill}: frontmatter missing 'description'`);
      assert.ok(frontmatter.description.length >= 10, `${host}/${skill}: description too short (<10 chars)`);

      // body markdown must be present and substantive
      assert.ok(body.trim().length >= 50, `${host}/${skill}: skill markdown body too short (<50 chars)`);
    }
  }
});

test("MHC-S3: no non-Claude host skill leaks Claude-Code-only tokens", () => {
  const violations = [];
  for (const { dir } of SKILL_HOST_TREES) {
    for (const skill of CANONICAL_SKILLS) {
      const skillRel = path.join(dir, skill, "SKILL.md");
      const content = fs.readFileSync(path.join(REPO_ROOT, skillRel), "utf8");
      for (const tokenRegex of CLAUDE_ONLY_TOKENS) {
        if (tokenRegex.test(content)) {
          violations.push(`${skillRel} matches ${tokenRegex}`);
        }
      }
    }
  }
  assert.deepStrictEqual(violations, [], `Claude-only tokens leaked into host skills:\n${violations.join("\n")}`);
});

// ============================================================================
// 2. Host Manifests & Configuration Contracts
// ============================================================================

test("MHC-M1: Claude plugin manifest (.claude-plugin/plugin.json) validity", () => {
  const manifestPath = path.join(REPO_ROOT, ".claude-plugin", "plugin.json");
  assert.ok(fs.existsSync(manifestPath), "Claude plugin manifest missing");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.strictEqual(manifest.name, "deliberation");
  assert.strictEqual(manifest.version, readVersion());
  assert.ok(manifest.mcpServers && manifest.mcpServers.deliberation, "missing mcpServers.deliberation");
  assert.strictEqual(manifest.mcpServers.deliberation.command, "node");
});

test("MHC-M2: Codex plugin manifest (plugins/deliberation/.codex-plugin/plugin.json) and MCP config", () => {
  const manifestPath = path.join(REPO_ROOT, "plugins/deliberation/.codex-plugin/plugin.json");
  assert.ok(fs.existsSync(manifestPath), "Codex plugin manifest missing");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.strictEqual(manifest.name, "deliberation");
  assert.strictEqual(manifest.version, readVersion());
  assert.ok(typeof manifest.description === "string" && manifest.description.length > 0);

  const mcpPath = path.join(REPO_ROOT, "plugins/deliberation/.mcp.json");
  assert.ok(fs.existsSync(mcpPath), "Codex .mcp.json missing");
  const mcpCfg = JSON.parse(fs.readFileSync(mcpPath, "utf8"));
  assert.ok(mcpCfg.mcpServers && mcpCfg.mcpServers.deliberation);
  assert.strictEqual(mcpCfg.mcpServers.deliberation.command, "npx");
});

test("MHC-M3: Kiro specification (POWER.md) and MCP configuration (mcp.json) validity", () => {
  const configPath = path.join(REPO_ROOT, "mcp.json");
  assert.ok(fs.existsSync(configPath), "Kiro root mcp.json missing");
  const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.ok(cfg.mcpServers && cfg.mcpServers.deliberation, "missing deliberation server in mcp.json");
  assert.strictEqual(cfg.mcpServers.deliberation.command, "npx");
  assert.ok(Array.isArray(cfg.mcpServers.deliberation.args), "args must be an array");

  const powerPath = path.join(REPO_ROOT, "POWER.md");
  assert.ok(fs.existsSync(powerPath), "POWER.md missing");
  assert.ok(fs.readFileSync(powerPath, "utf8").includes("deliberation"));
});

test("MHC-M4: OpenCode agent definitions (.opencode/agents/) validity", () => {
  const agentsDir = path.join(REPO_ROOT, ".opencode", "agents");
  assert.ok(fs.existsSync(agentsDir), "OpenCode agents dir missing");
  for (const persona of CANONICAL_PERSONAS) {
    const agentFile = path.join(agentsDir, `${persona}.md`);
    assert.ok(fs.existsSync(agentFile), `OpenCode agent missing: ${persona}.md`);
    const { frontmatter, body } = parseFrontmatter(fs.readFileSync(agentFile, "utf8"));
    assert.ok(frontmatter.description, `${persona}.md missing frontmatter description`);
    assert.strictEqual(frontmatter.mode, "subagent", `${persona}.md mode must be 'subagent'`);
    assert.ok(body.length > 50, `${persona}.md body too short`);
  }
});

test("MHC-M5: Antigravity MCP configuration (.agents/mcp.json) validity", () => {
  const configPath = path.join(REPO_ROOT, ".agents", "mcp.json");
  assert.ok(fs.existsSync(configPath), "Antigravity .agents/mcp.json missing");
  const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.ok(cfg.mcpServers && cfg.mcpServers.deliberation, "missing deliberation server in .agents/mcp.json");
  assert.strictEqual(cfg.mcpServers.deliberation.command, "npx");
  assert.ok(Array.isArray(cfg.mcpServers.deliberation.args), "args must be an array");
});

test("MHC-M6: Cursor rule (.cursor/rules/deliberation.mdc) validity", () => {
  const mdcPath = path.join(REPO_ROOT, ".cursor", "rules", "deliberation.mdc");
  assert.ok(fs.existsSync(mdcPath), ".cursor/rules/deliberation.mdc missing");
  const { frontmatter, body } = parseFrontmatter(fs.readFileSync(mdcPath, "utf8"));
  assert.ok(frontmatter.description, "deliberation.mdc missing description");
  assert.ok(body.length > 50, "deliberation.mdc body too short");
});

// ============================================================================
// 3. MCP JSON-RPC 2.0 Protocol Invariants
// ============================================================================

test("MHC-P1: JSON-RPC initialize handshake across negotiated protocol versions", async () => {
  const srv = buildServer({
    providers: [mockProvider("codex"), mockProvider("gemini")],
    getConfig: () => ({ providers: {}, openrouter: { maxFanout: 3, models: [] } }),
  });

  // Default / unspecified version negotiation
  const r1 = await srv.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  assert.strictEqual(r1.result.protocolVersion, "2024-11-05");
  assert.strictEqual(r1.result.serverInfo.name, "deliberation-mcp");
  assert.strictEqual(r1.result.serverInfo.version, readVersion());
  assert.ok(r1.result.capabilities.tools);
  assert.ok(r1.result.capabilities.logging);

  // Explicit modern protocol versions
  const r2 = await srv.handle({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  assert.strictEqual(r2.result.protocolVersion, "2025-06-18");

  const r3 = await srv.handle({ jsonrpc: "2.0", id: 3, method: "initialize", params: { protocolVersion: "2025-11-25" } });
  assert.strictEqual(r3.result.protocolVersion, "2025-11-25");
});

test("MHC-P2: JSON-RPC error contract conformance", async () => {
  const srv = buildServer({
    providers: [mockProvider("codex")],
    getConfig: () => ({ providers: {}, openrouter: { maxFanout: 3, models: [] } }),
  });

  // Method not found: -32601
  const errRes = await srv.handle({ jsonrpc: "2.0", id: 99, method: "nonexistent/method", params: {} });
  assert.ok(errRes.error);
  assert.strictEqual(errRes.error.code, -32601);
  assert.match(errRes.error.message, /method not found/i);

  // Invalid log level: -32602
  const logErr = await srv.handle({ jsonrpc: "2.0", id: 100, method: "logging/setLevel", params: { level: "bogus-level" } });
  assert.ok(logErr.error);
  assert.strictEqual(logErr.error.code, -32602);
});

// ============================================================================
// 4. Tool Declarations & JSON Schema Draft-07 Compliance
// ============================================================================

test("MHC-T1: tools/list returns all required core and persona tools", async () => {
  const srv = buildServer({
    providers: [mockProvider("codex"), mockProvider("gemini")],
    getConfig: () => ({ providers: {}, openrouter: { maxFanout: 3, models: [] } }),
  });

  const res = await srv.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.ok(Array.isArray(res.result.tools));
  const toolNames = new Set(res.result.tools.map((t) => t.name));

  const expectedCore = ["ask-all", "ask-one", "consensus", "consensus-step", "panel", "analyze"];
  for (const name of expectedCore) {
    assert.ok(toolNames.has(name), `expected core tool '${name}' missing from tools/list`);
  }

  for (const name of CANONICAL_PERSONAS) {
    assert.ok(toolNames.has(name), `expected persona tool '${name}' missing from tools/list`);
  }
});

test("MHC-T2: every tool schema conforms strictly to JSON Schema Draft-07", async () => {
  const srv = buildServer({
    providers: [mockProvider("codex"), mockProvider("gemini")],
    getConfig: () => ({ providers: {}, openrouter: { maxFanout: 3, models: [] } }),
  });

  const res = await srv.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  for (const tool of res.result.tools) {
    assert.ok(typeof tool.name === "string" && tool.name.length > 0, "tool missing name");
    assert.ok(typeof tool.description === "string" && tool.description.length > 0, `${tool.name} missing description`);

    const schema = tool.inputSchema;
    assert.ok(schema && typeof schema === "object", `${tool.name} inputSchema missing or not object`);
    assert.strictEqual(schema.type, "object", `${tool.name} inputSchema type must be 'object'`);
    assert.ok(schema.properties && typeof schema.properties === "object", `${tool.name} inputSchema missing properties`);

    const propNames = Object.keys(schema.properties);
    if (schema.required) {
      assert.ok(Array.isArray(schema.required), `${tool.name} required must be an array`);
      for (const req of schema.required) {
        assert.ok(propNames.includes(req), `${tool.name} required property '${req}' not found in properties`);
      }
    }

    for (const [propName, propDef] of Object.entries(schema.properties)) {
      assert.ok(propDef && typeof propDef === "object", `${tool.name}.${propName} property definition not an object`);
      const hasType = typeof propDef.type === "string" || Array.isArray(propDef.type) || Array.isArray(propDef.enum) || Array.isArray(propDef.anyOf) || Array.isArray(propDef.oneOf);
      assert.ok(hasType, `${tool.name}.${propName} must specify type/enum/anyOf/oneOf`);
    }
  }
});

test("MHC-T3: tool annotations correctly flag read-only hints", async () => {
  const srv = buildServer({
    providers: [mockProvider("codex"), mockProvider("gemini")],
    getConfig: () => ({ providers: {}, openrouter: { maxFanout: 3, models: [] } }),
  });

  const res = await srv.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const byName = Object.fromEntries(res.result.tools.map((t) => [t.name, t]));

  // Inspection & query tools must be marked read-only
  assert.strictEqual(byName["ask-all"].annotations?.readOnlyHint, true);
  assert.strictEqual(byName["ask-one"].annotations?.readOnlyHint, true);
  assert.strictEqual(byName["panel"].annotations?.readOnlyHint, true);
  assert.strictEqual(byName["analyze"].annotations?.readOnlyHint, true);
  assert.strictEqual(byName["architect"].annotations?.readOnlyHint, true);

  // State-advancing consensus-step must NOT be marked read-only
  assert.notStrictEqual(byName["consensus-step"].annotations?.readOnlyHint, true);
});

// ============================================================================
// 5. Multi-Host Client Identity & Arbiter Parity Contracts
// ============================================================================

test("MHC-H1: Claude client identity defaults unconfigured arbiter to host", async () => {
  const defaultedConfig = {
    providers: {},
    openrouter: { maxFanout: 3, models: [] },
    consensus: { arbiter: "auto", arbiterDefaulted: true, blindVote: false },
  };

  const srv = buildServer({
    providers: [mockProvider("codex"), mockProvider("gemini")],
    getConfig: () => defaultedConfig,
  });

  // Client identifies as Claude Code
  await srv.handle({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { clientInfo: { name: "claude-code" } },
  });

  // synthesizeAlways: true allows one-shot consensus collection under host arbiter
  const callRes = await srv.handle({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "consensus", arguments: { prompt: "review architecture", expert: "architect", synthesizeAlways: true } },
  });

  const payload = JSON.parse(callRes.result.content[0].text);
  assert.strictEqual(payload.arbiter.mode, "host");
  assert.strictEqual(payload.verdict, null);
  assert.ok(Array.isArray(payload.opinions));
  assert.strictEqual(payload.opinions.length, 2);
});

test("MHC-H2: Non-Claude host identities default unconfigured arbiter to auto (server synthesis)", async () => {
  const nonClaudeHosts = ["codex", "cursor", "kiro", "opencode", "antigravity", "generic-agent"];

  for (const hostName of nonClaudeHosts) {
    const defaultedConfig = {
      providers: {},
      openrouter: { maxFanout: 3, models: [] },
      consensus: { arbiter: "auto", arbiterDefaulted: true, blindVote: false },
    };

    const srv = buildServer({
      providers: [mockProvider("codex"), mockProvider("gemini")],
      getConfig: () => defaultedConfig,
    });

    await srv.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: hostName } },
    });

    const callRes = await srv.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "consensus", arguments: { prompt: "review code", expert: "code-reviewer" } },
    });

    const payload = JSON.parse(callRes.result.content[0].text);
    // Non-Claude host gets automated server consensus synthesis
    assert.strictEqual(payload.arbiter.mode, "server", `host '${hostName}' failed to set server arbiter mode`);
    assert.strictEqual(payload.verdict, "APPROVE", `host '${hostName}' failed to auto-synthesize verdict`);
    assert.strictEqual(payload.converged, true);
  }
});

test("MHC-H3: CLAUDECODE=1 env override forces host arbiter on any host", async () => {
  const prevEnv = process.env.CLAUDECODE;
  try {
    process.env.CLAUDECODE = "1";
    const defaultedConfig = {
      providers: {},
      openrouter: { maxFanout: 3, models: [] },
      consensus: { arbiter: "auto", arbiterDefaulted: true, blindVote: false },
    };

    const srv = buildServer({
      providers: [mockProvider("codex"), mockProvider("gemini")],
      getConfig: () => defaultedConfig,
    });

    // Even if clientInfo says kiro or antigravity
    await srv.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "antigravity" } },
    });

    const callRes = await srv.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "consensus", arguments: { prompt: "test prompt", synthesizeAlways: true } },
    });

    const payload = JSON.parse(callRes.result.content[0].text);
    assert.strictEqual(payload.arbiter.mode, "host", "CLAUDECODE=1 should force host arbiter");
    assert.strictEqual(payload.verdict, null, "CLAUDECODE=1 should leave verdict null");
  } finally {
    if (prevEnv === undefined) delete process.env.CLAUDECODE;
    else process.env.CLAUDECODE = prevEnv;
  }
});

// ============================================================================
// 6. Hermetic Tool Call Execution Invariants (Zero Network)
// ============================================================================

test("MHC-E1: panel execution returns deterministic structure offline", async () => {
  const srv = buildServer({
    providers: [mockProvider("codex"), mockProvider("gemini")],
    getConfig: () => ({ providers: {}, openrouter: { maxFanout: 3, models: [] } }),
  });

  const res = await srv.handle({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "panel", arguments: {} },
  });

  const data = JSON.parse(res.result.content[0].text);
  assert.ok(Array.isArray(data.providers));
  assert.deepStrictEqual(data.providers.sort(), ["codex", "gemini"]);
  assert.ok(Array.isArray(data.needsLogin));
  assert.strictEqual(data.needsLogin.length, 0);
});

test("MHC-E2: consensus-step state machine executes hermetically without network", async () => {
  const srv = buildServer({
    providers: [mockProvider("codex"), mockProvider("gemini")],
    getConfig: () => ({ providers: {}, openrouter: { maxFanout: 3, models: [] } }),
  });

  // Action: init
  const initRes = await srv.handle({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "consensus-step", arguments: { action: "init", prompt: "ship hermetic test suite" } },
  });
  const initData = JSON.parse(initRes.result.content[0].text);
  assert.ok(initData.sessionId);
  assert.strictEqual(initData.status, "await_blind");
  assert.strictEqual(initData.round, 1);

  // Out of order action returns structured error without throwing
  const oooRes = await srv.handle({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "consensus-step", arguments: { action: "submit_adjudication", sessionId: initData.sessionId, verdict: "APPROVE", decisions: [] } },
  });
  const oooData = JSON.parse(oooRes.result.content[0].text);
  assert.strictEqual(oooData.error, "unexpected-action-for-status");
  assert.match(oooData.detail, /await_adjudication/);

  // Missing session id returns structured error
  const missingRes = await srv.handle({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "consensus-step", arguments: { action: "dispatch_peers" } },
  });
  const missingData = JSON.parse(missingRes.result.content[0].text);
  assert.strictEqual(missingData.error, "missing-sessionId");

  // Unknown action returns structured error
  const unknownRes = await srv.handle({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "consensus-step", arguments: { action: "bogus", sessionId: initData.sessionId } },
  });
  const unknownData = JSON.parse(unknownRes.result.content[0].text);
  assert.match(unknownData.error, /unknown action/i);
});
