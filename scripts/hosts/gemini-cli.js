"use strict";
/**
 * Gemini CLI extension manifest.
 *
 * `gemini extensions install https://github.com/antonbabenko/deliberation` clones
 * the repo and reads `gemini-extension.json` at its root. The gallery
 * (geminicli.com/extensions) also needs the manifest at the repo root plus the
 * `gemini-cli-extension` GitHub topic. Format verified against
 * google-gemini/gemini-cli docs/extensions/reference.md (CLI v0.68.0, 2026-11).
 *
 * - The MCP server runs from the clone with plain node, so no npm install.
 * - contextFileName points at docs/tool-guide.md, the host-neutral guide.
 * - Gemini CLI strips env vars named like *KEY* / *TOKEN* from stdio MCP servers
 *   unless the manifest declares them in `settings`, so the HTTP providers'
 *   keys are declared here. Each is optional: a blank answer skips it.
 * - `version` is also patched by .github/release/pre-commit.js on release.
 *
 * @param {{ repoRoot:string, version:string }} ctx
 * @returns {Record<string,string>}
 */
const S = require("./_shared");

function build(ctx) {
  return {
    "gemini-extension.json": S.json({
      name: "deliberation",
      version: ctx.version,
      description: S.SHORT_DESCRIPTION,
      mcpServers: {
        deliberation: { command: "node", args: ["${extensionPath}/server/mcp/index.js"] },
      },
      contextFileName: "docs/tool-guide.md",
      settings: [
        {
          name: "Gemini API key",
          description: "Google AI Studio key (https://aistudio.google.com/apikey). Enables Gemini without the Antigravity CLI. Leave blank to skip.",
          envVar: "GEMINI_API_KEY",
          sensitive: true,
        },
        {
          name: "xAI API key",
          description: "Enables Grok. Leave blank to skip.",
          envVar: "XAI_API_KEY",
          sensitive: true,
        },
        {
          name: "OpenRouter API key",
          description: "Enables OpenRouter models. Leave blank to skip.",
          envVar: "OPENROUTER_API_KEY",
          sensitive: true,
        },
      ],
    }),
  };
}

build.id = "gemini-cli";
module.exports = build;
