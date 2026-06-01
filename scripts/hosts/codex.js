"use strict";
/**
 * OpenAI Codex CLI host artifacts (native plugin).
 *
 * Codex plugins (added March 2026) use a `.codex-plugin/plugin.json` manifest
 * that points at bundled skills + an MCP config, discoverable via a repo-scoped
 * `.agents/plugins/marketplace.json` (installable with
 * `codex plugin marketplace add antonbabenko/deliberation`).
 *
 * The plugin lives in a SUBDIRECTORY (plugins/deliberation/), not the repo root:
 * Codex's marketplace path validator (openai/codex#17066) rejects a source.path
 * that resolves to the marketplace root (".", "./"); it requires a strict
 * subdirectory. So the manifest, its `.mcp.json`, and `skills/` all live under
 * plugins/deliberation/ and the marketplace entry points at "./plugins/deliberation".
 *
 * Source of truth: AGENTS.md (the "when to delegate" meta-skill) and
 * prompts/<expert>.md (one skill per expert). The MCP server injects personas
 * server-side too; the skills give Codex the same guidance natively.
 *
 * @param {{ repoRoot:string, version:string }} ctx
 * @returns {Record<string,string>}
 */
const S = require("./_shared");

const PLUGIN_DIR = "plugins/deliberation";

function build(ctx) {
  /** @type {Record<string,string>} */
  const out = {};

  // Plugin manifest. skills/mcpServers paths are relative to the plugin root
  // (= PLUGIN_DIR). interface.{displayName,developerName,category,capabilities}
  // are REQUIRED by the Codex plugin schema; the rest are optional.
  out[`${PLUGIN_DIR}/.codex-plugin/plugin.json`] = S.json({
    name: "deliberation",
    version: ctx.version,
    description: S.SHORT_DESCRIPTION,
    author: S.AUTHOR,
    skills: "./skills/",
    mcpServers: "./.mcp.json",
    interface: {
      displayName: "Deliberation",
      developerName: S.AUTHOR.name,
      category: "Developer Tools",
      capabilities: ["Interactive", "Write"],
      shortDescription: S.SHORT_DESCRIPTION,
      longDescription:
        "Seven expert subagents (Architect, Plan Reviewer, Scope Analyst, Code Reviewer, " +
        "Security Analyst, Researcher, Debugger) backed by GPT, Gemini, Grok, and OpenRouter, " +
        "plus ask-all fan-out and arbiter-mediated consensus. Advisory or implementation.",
      websiteURL: S.REPO_URL,
    },
  });

  // MCP server config at the plugin root. Provider keys come from the host env
  // (OPENAI/Codex auth, XAI_API_KEY, OPENROUTER_API_KEY, Gemini via the agy CLI).
  out[`${PLUGIN_DIR}/.mcp.json`] = S.json({
    mcpServers: {
      deliberation: { command: "npx", args: ["-y", S.MCP_PACKAGE], type: "stdio" },
    },
  });

  // Repo-scoped marketplace so `codex plugin marketplace add antonbabenko/deliberation`
  // discovers the plugin. source.path must be a strict subdirectory (not ".").
  out[".agents/plugins/marketplace.json"] = S.json({
    name: "antonbabenko-deliberation",
    plugins: [
      {
        name: "deliberation",
        description: S.SHORT_DESCRIPTION,
        source: { source: "local", path: `./${PLUGIN_DIR}` },
        policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
        category: "Developer Tools",
      },
    ],
  });

  // "When to delegate" meta-skill, generated from the host-neutral AGENTS.md.
  const agents = S.readText(ctx.repoRoot, "AGENTS.md").replace(/^# AGENTS\.md\n/, "# Deliberation\n");
  out[`${PLUGIN_DIR}/skills/deliberation/SKILL.md`] = S.frontmatterDoc({
    name: "deliberation",
    description:
      "When and how to delegate to GPT, Gemini, Grok, and OpenRouter expert subagents via the deliberation MCP tools.",
    body: agents,
  });

  // One skill per expert, body = the canonical persona.
  for (const key of Object.keys(S.EXPERTS)) {
    out[`${PLUGIN_DIR}/skills/${key}/SKILL.md`] = S.frontmatterDoc({
      name: key,
      description: S.EXPERTS[key],
      body: S.readText(ctx.repoRoot, `prompts/${key}.md`),
    });
  }

  return out;
}

build.id = "codex";
module.exports = build;
