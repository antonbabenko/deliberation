# Per-host install guides

A second opinion from other models before you ship. Any host, any vendor, one verdict, and the disagreement stays visible.

Each guide gives one install string for its host. Where a host has more than one way, the guide
lists the rest under "Other ways to install".

Deliberation ships native plugin artifacts for non-Claude hosts, generated from
the canonical sources by `scripts/sync-hosts.js` (drift-guarded in CI). Full
install instructions per host:

- [Antigravity & Gemini Code Assist](antigravity.md) - native `.agents/skills/`, `.gemini/skills/`, and `.agents/mcp.json`, installed by copying `.agents/skills/` and `.agents/mcp.json` into your project.
- [Gemini CLI](gemini-cli.md) - `gemini-extension.json` at the repo root, installed via `gemini extensions install https://github.com/antonbabenko/deliberation`.
- [Cursor](cursor.md) - `.cursor/rules/deliberation.mdc` + the one-click MCP deeplink.
- [OpenAI Codex CLI](codex.md) - native plugin at `plugins/deliberation/`, installed via `codex plugin marketplace add antonbabenko/deliberation`.
- [Kiro](kiro.md) - a Kiro Power (`POWER.md` + `mcp.json` + `steering/`), installed via "Add power from GitHub".
- [OpenCode](opencode.md) - `.opencode/commands/` + `.opencode/agents/` + an `opencode.json` MCP snippet.

All route the same MCP tools (`ask-all`, `consensus`, `ask-gpt` / `ask-gemini`
/ `ask-grok` / `ask-openrouter`, plus `panel` + `ask-one` for per-provider progress,
and the read-only `analyze` and `doctor`) and the eight expert personas (`architect`, `plan-reviewer`, `scope-analyst`,
`code-reviewer`, `security-analyst`, `researcher`, `debugger`, `writing-editor`). Every result carries
`ms` + reasoning effort (HTTP providers add token usage), and an optional config-gated
debug log records latency / tokens / votes - all server-side, so they apply on every
host (see [the tool guide](../tool-guide.md)). Provider credentials come from the host
environment - set only the providers you use; missing keys just disable that one provider.

For the Claude Code plugin itself, see the repo [README](../../README.md).
