"use strict";
/**
 * Shared helpers + constants for the per-host artifact generators.
 *
 * Each host module (cursor.js, codex.js, kiro.js, opencode.js, antigravity.js) exports a
 * `build(ctx)` that returns a { repoRelativePath: content } map. The orchestrator
 * (scripts/sync-hosts.js) merges them and writes / checks. Keeping each host in
 * its own file lets independent contributors (or parallel agents) own one host
 * without colliding on a single generator file.
 *
 * Dev-only: never imported by the runtime or the esbuild bundle.
 */

const fs = require("fs");
const path = require("path");

const AUTHOR = { name: "Anton Babenko", url: "https://github.com/antonbabenko" };
const REPO_URL = "https://github.com/antonbabenko/deliberation";
const MCP_PACKAGE = "@antonbabenko/deliberation-mcp";

const SHORT_DESCRIPTION =
  "GPT, Gemini, Grok, and OpenRouter as expert subagents - second opinions, cross-model consensus, and review.";

/** The 8 expert personas + a one-line description for host skill/agent frontmatter. */
const EXPERTS = {
  architect: "System design, tradeoffs, and complex technical decisions.",
  "plan-reviewer": "Validate that a work plan is executable before work starts.",
  "scope-analyst": "Catch ambiguities and hidden requirements before planning.",
  "code-reviewer": "Find bugs, security holes, and maintainability issues in a diff or file.",
  "security-analyst": "Threat-model and find vulnerabilities, with practical remediation.",
  researcher: "Research external libraries, APIs, and best practices, with evidence.",
  debugger: "Rank root-cause hypotheses and propose the smallest safe fix.",
  "writing-editor": "Edit prose so it reads like its author wrote it, keeping every fact and the author's voice.",
};

/**
 * The fan-out / single-provider tools, for hosts that support custom slash
 * commands (OpenCode). Thin wrappers: each just invokes the MCP tool. The MCP
 * server already implements fan-out, persona injection, and the arbiter, so the
 * command body stays one line - NO ported Claude command workflow.
 */
const COMMANDS = {
  "ask-all": "Ask GPT, Gemini, Grok, and OpenRouter in parallel for independent second opinions.",
  consensus: "Fan out, then run one arbiter pass that synthesizes a single verdict.",
  "ask-gpt": "Ask GPT (Codex) for a single-shot second opinion.",
  "ask-gemini": "Ask Gemini for a single-shot second opinion.",
  "ask-grok": "Ask Grok (xAI) for a single-shot second opinion.",
  "ask-openrouter": "Ask a configured OpenRouter model for a single-shot second opinion.",
  analyze: "Analyze recent runs (latency, tokens, verdict agreement) and suggest model/reasoning/fanout tuning.",
};

/**
 * Body of the generated reload-mcp skill/command. Non-Claude hosts run the npm package,
 * which ships only dist/, so the steps must not depend on the repo's scripts/ folder.
 */
const RELOAD_BODY = [
  "Use this after deliberation is updated. The host keeps running the old server until the server restarts.",
  "",
  `The host starts the server with \`npx -y ${MCP_PACKAGE}\`. The npm package does not include the repository's \`scripts/\` folder, so follow these steps:`,
  "",
  `1. Stop the dashboard with \`npx -y ${MCP_PACKAGE} dashboard --stop\` (it prints "no running dashboard" if none runs). On Windows \`--stop\` is not supported: close the dashboard process instead, before step 2.`,
  "2. Remove the cached copy so `npx` fetches the new version: `find ~/.npm/_npx -type d -path '*/@antonbabenko/deliberation-mcp' -prune -exec rm -rf {} +` (macOS, Linux). On Windows, delete the `@antonbabenko\\deliberation-mcp` folders under `%LocalAppData%\\npm-cache\\_npx`.",
  "3. Tell the user to restart the deliberation MCP server in the host, or to restart the host.",
  `4. If the user runs the dashboard, start it again on the new version with \`npx -y ${MCP_PACKAGE} dashboard\`.`,
  "",
  "In a clone of the deliberation repository, `bash scripts/commands/reload-mcp.sh` clears the cached package, restarts the dashboard and audits the running deliberation processes.",
].join("\n");

/**
 * Read a repo file as LF text with a single trailing newline. Strips a leading
 * UTF-8 BOM so start-of-file regexes (and the drift compare) are stable across
 * editors/OSes.
 * @param {string} repoRoot @param {string} rel @returns {string}
 */
function readText(repoRoot, rel) {
  return (
    fs
      .readFileSync(path.join(repoRoot, rel), "utf8")
      .replace(/^﻿/, "")
      .replace(/\r\n/g, "\n")
      .replace(/\s+$/, "") + "\n"
  );
}

/**
 * Extract the first fenced code block tagged ```<lang> from a markdown file.
 * Tolerates a leading BOM, CRLF, and trailing whitespace after the lang tag.
 * @param {string} repoRoot @param {string} rel @param {string} lang @returns {string}
 */
function extractFencedBlock(repoRoot, rel, lang) {
  const src = fs
    .readFileSync(path.join(repoRoot, rel), "utf8")
    .replace(/^﻿/, "")
    .replace(/\r\n/g, "\n");
  const re = new RegExp("```" + lang + "[ \\t]*\\n([\\s\\S]*?)\\n```");
  const m = src.match(re);
  if (!m) throw new Error(`${rel}: no \`\`\`${lang} block found`);
  return m[1].replace(/\s+$/, "") + "\n";
}

/** JSON with 2-space indent + trailing newline (stable, diff-friendly). */
function json(obj) {
  return JSON.stringify(obj, null, 2) + "\n";
}

/**
 * A SKILL.md / agent doc: YAML frontmatter (name + description), a generated-by
 * note, then the body. The note sits AFTER the frontmatter so it never breaks
 * YAML parsing (frontmatter must be the first bytes). name/description are
 * emitted as JSON-quoted scalars so a colon or other special char in the value
 * can never corrupt the YAML.
 * @param {{name:string, description:string, body:string, extraFrontmatter?:string}} o
 */
function frontmatterDoc(o) {
  const extra = o.extraFrontmatter ? o.extraFrontmatter.replace(/\s+$/, "") + "\n" : "";
  return (
    "---\n" +
    `name: ${JSON.stringify(o.name)}\n` +
    `description: ${JSON.stringify(o.description)}\n` +
    extra +
    "---\n" +
    "<!-- GENERATED by scripts/sync-hosts.js - edit the source under prompts/, docs/tool-guide.md, or examples/, then regenerate. -->\n\n" +
    o.body.replace(/\s+$/, "") +
    "\n"
  );
}

module.exports = {
  AUTHOR,
  REPO_URL,
  MCP_PACKAGE,
  SHORT_DESCRIPTION,
  EXPERTS,
  COMMANDS,
  RELOAD_BODY,
  readText,
  extractFencedBlock,
  json,
  frontmatterDoc,
};
