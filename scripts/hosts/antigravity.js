"use strict";
/**
 * Antigravity CLI & Gemini Code Assist host artifacts.
 *
 * Antigravity CLI (`agy`) and Gemini Code Assist discover workspace and agent
 * skills from `.agents/skills/<name>/SKILL.md` and `.gemini/skills/<name>/SKILL.md`.
 * They discover project-level MCP servers from `.agents/mcp.json`.
 *
 * Generated artifacts:
 * - `.agents/skills/deliberation/SKILL.md` (from docs/tool-guide.md)
 * - `.agents/skills/<expert>/SKILL.md` (from prompts/<expert>.md)
 * - `.agents/skills/reload-mcp/SKILL.md`
 * - `.gemini/skills/deliberation/SKILL.md`
 * - `.gemini/skills/<expert>/SKILL.md`
 * - `.gemini/skills/reload-mcp/SKILL.md`
 * - `.agents/mcp.json`
 *
 * @param {{ repoRoot:string, version:string }} ctx
 * @returns {Record<string,string>}
 */
const S = require("./_shared");

function build(ctx) {
  /** @type {Record<string,string>} */
  const out = {};

  // Project MCP configuration for Antigravity and Agent hosts.
  out[".agents/mcp.json"] = S.json({
    mcpServers: {
      deliberation: { command: "npx", args: ["-y", S.MCP_PACKAGE], type: "stdio" },
    },
  });

  // "When to delegate" meta-skill, generated from the host-neutral docs/tool-guide.md.
  const agents = S.readText(ctx.repoRoot, "docs/tool-guide.md").replace(/^# Deliberation tool guide\n/, "# Deliberation\n");
  const deliberationSkill = S.frontmatterDoc({
    name: "deliberation",
    description:
      "When and how to delegate to GPT, Gemini, Grok, and OpenRouter expert subagents via the deliberation MCP tools.",
    body: agents,
  });

  out[".agents/skills/deliberation/SKILL.md"] = deliberationSkill;
  out[".gemini/skills/deliberation/SKILL.md"] = deliberationSkill;

  // One skill per expert in both .agents/skills/ and .gemini/skills/
  for (const key of Object.keys(S.EXPERTS)) {
    const expertSkill = S.frontmatterDoc({
      name: key,
      description: S.EXPERTS[key],
      body: S.readText(ctx.repoRoot, `prompts/${key}.md`),
    });
    out[`.agents/skills/${key}/SKILL.md`] = expertSkill;
    out[`.gemini/skills/${key}/SKILL.md`] = expertSkill;
  }

  // Reload MCP skill for cycle & process audits after updates
  const reloadSkill = S.frontmatterDoc({
    name: "reload-mcp",
    description: "Gracefully cycle dashboard and audit MCP processes after deliberation is updated.",
    body: [
      "# Reload Deliberation MCP",
      "",
      "Use this skill when Deliberation has been updated to cycle running background services and verify MCP worker states.",
      "",
      "## Instructions",
      "",
      "Run the reload script to audit running processes and gracefully restart the dashboard daemon on the latest code:",
      "",
      "```bash",
      "bash scripts/commands/reload-mcp.sh",
      "```",
      "",
      "- Safely preserves connected host stdio pipes.",
      "- Automatically detects and cleans up orphaned worker processes.",
      "- Restarts the background dashboard daemon with the active configuration.",
      "- New sessions or subagent turns will automatically run the updated server.",
    ].join("\n"),
  });
  out[".agents/skills/reload-mcp/SKILL.md"] = reloadSkill;
  out[".gemini/skills/reload-mcp/SKILL.md"] = reloadSkill;

  return out;
}

build.id = "antigravity";
module.exports = build;
