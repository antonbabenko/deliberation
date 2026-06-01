"use strict";
/**
 * OpenCode (opencode.ai, by SST) host artifacts.
 *
 * OpenCode reads modular project artifacts from a `.opencode/` directory whose
 * subdirectories are PLURAL: `.opencode/commands/`, `.opencode/agents/`,
 * `.opencode/plugins/` (verified against opencode.ai/docs - the docs state
 * outright: "The .opencode and ~/.config/opencode directories use plural names
 * for subdirectories: agents/, commands/, modes/, plugins/, skills/, tools/").
 *
 * What we generate:
 * - `.opencode/commands/<name>.md` for each fan-out / single-provider tool in
 *   S.COMMANDS. THIN wrappers: a one/two-line prompt template that tells the
 *   agent to call the matching deliberation MCP tool. The MCP server already
 *   does fan-out, persona injection, and arbitration, so we do NOT port the
 *   giant Claude `commands/*.md` workflow files.
 * - `.opencode/agents/<expert>.md` for each of S.EXPERTS, body = the canonical
 *   persona from prompts/<expert>.md, frontmatter `mode: subagent`.
 *
 * What we deliberately do NOT generate:
 * - `opencode.json` - the config file does NOT live under `.opencode/` (docs:
 *   it lives at the project root or `~/.config/opencode/opencode.json`). We will
 *   not write a root `opencode.json` (it would hijack / could break this repo's
 *   own config). The MCP `mcp` block is documented in docs/hosts/opencode.md
 *   instead, for the user to paste into their own opencode.json.
 * - a `.opencode/plugins/` plugin - the verified plugin hook API (`event`,
 *   `tool.execute.before`, `shell.env`, ...) has no hook that injects a
 *   proactive delegation hint into the system prompt / context. The persona
 *   agents + command wrappers already give OpenCode the native delegation
 *   surface, so a plugin would add a runtime dependency for no verified win.
 *   See docs/hosts/opencode.md for the (reserved) optional npm package path.
 *
 * Frontmatter schemas used (verified against opencode.ai/docs):
 * - command: `description`, `agent` (optional), `model` (optional),
 *   `subtask` (optional bool). Body is the prompt template; `$ARGUMENTS` is the
 *   passed input.
 * - agent: `description` (required), `mode` (`subagent` for a subagent). Body is
 *   the agent system prompt.
 *
 * @param {{ repoRoot:string, version:string }} ctx
 * @returns {Record<string,string>}
 */
const S = require("./_shared");

/** MCP tool name that each command wrapper invokes. */
const MCP_SERVER = "deliberation";

function build(ctx) {
  /** @type {Record<string,string>} */
  const out = {};

  // Thin command wrappers. Each just instructs the agent to call the matching
  // deliberation MCP tool with the user's question ($ARGUMENTS). No workflow
  // port - the MCP server owns fan-out / personas / arbitration.
  for (const name of Object.keys(S.COMMANDS)) {
    const body =
      `Call the \`${MCP_SERVER}\` MCP server's \`${name}\` tool to ${lowerFirst(S.COMMANDS[name])}\n\n` +
      "Pass the full question and any needed context as the prompt - the expert does not share this session:\n\n" +
      "$ARGUMENTS\n\n" +
      "Read the tool result and apply your own judgment; do not relay raw output verbatim.";
    out[`.opencode/commands/${name}.md`] = S.frontmatterDoc({
      name,
      description: S.COMMANDS[name],
      body,
    });
  }

  // One subagent per expert. Body = the canonical persona; the deliberation MCP
  // server injects the same persona server-side, but a native OpenCode subagent
  // lets the user @-mention or route to it directly.
  for (const key of Object.keys(S.EXPERTS)) {
    out[`.opencode/agents/${key}.md`] = S.frontmatterDoc({
      name: key,
      description: S.EXPERTS[key],
      body: S.readText(ctx.repoRoot, `prompts/${key}.md`),
      extraFrontmatter: "mode: subagent",
    });
  }

  return out;
}

/** Lowercase the first character so the description flows after "to ...". */
function lowerFirst(s) {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

build.id = "opencode";
module.exports = build;
