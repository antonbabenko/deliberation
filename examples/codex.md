# Codex CLI rule for Deliberation

Codex reads instructions from an `AGENTS.md` file in the repo root (and from
`~/.codex/AGENTS.md` for a global rule). Add the section below to that file.

```md
## Deliberation MCP experts

The Deliberation MCP server exposes GPT, Gemini, Grok, and OpenRouter as expert
subagents. Use its tools when a task benefits from outside input:

- Plan or architecture review: call `consensus`, `architect`, or
  `plan-reviewer`.
- Security review of auth, untrusted input, or a new endpoint: call
  `security-analyst`.
- A second opinion, or after a fix has failed twice: call `ask-all` or a single
  `ask-gpt` / `ask-gemini` / `ask-grok` tool.

Put full context in the `prompt` - the experts do not share your session. Read
the result and apply your own judgment. Skip delegation for simple edits and
first-attempt fixes.
```
