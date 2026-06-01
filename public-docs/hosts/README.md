# Per-host install guides

deliberation ships native plugin artifacts for non-Claude hosts, generated from
the canonical sources by `scripts/sync-hosts.js` (drift-guarded in CI). Full
install instructions per host:

- [Cursor](cursor.md) - `.cursor/rules/deliberation.mdc` + the one-click MCP deeplink.
- [OpenAI Codex CLI](codex.md) - native plugin at `plugins/deliberation/`, installed via `codex plugin marketplace add antonbabenko/deliberation`.
- [Kiro](kiro.md) - a Kiro Power (`POWER.md` + `mcp.json` + `steering/`), installed via "Add power from GitHub".
- [OpenCode](opencode.md) - `.opencode/commands/` + `.opencode/agents/` + an `opencode.json` MCP snippet.

All four route the same MCP tools (`ask-all`, `consensus`, `ask-gpt` / `ask-gemini`
/ `ask-grok` / `ask-openrouter`) and the seven expert personas (`architect`,
`plan-reviewer`, `scope-analyst`, `code-reviewer`, `security-analyst`, `researcher`,
`debugger`). Provider credentials come from the host environment - set only the
providers you use; missing keys just disable that one provider.

For the Claude Code plugin itself, see the repo [README](../../README.md).
