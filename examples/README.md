# Per-host rule snippets

Copy-pasteable rule blocks that tell each host's model to use the deliberation
MCP tools. Install the server first (see the project README), then drop the
matching block into your host's rule file.

- `cursor.md` - Cursor (`.cursor/rules/*.mdc` or legacy `.cursorrules`).
- `codex.md` - Codex CLI (`AGENTS.md` in the repo root).
- `kiro.md` - Kiro (`.kiro/steering/*.md`).

The tools referenced in every block: `ask-all`, `consensus`,
`ask-gpt` / `ask-gemini` / `ask-grok` / `ask-openrouter`, and the experts
`architect`, `plan-reviewer`, `scope-analyst`, `code-reviewer`,
`security-analyst`, `researcher`, `debugger`, `writing-editor`.
