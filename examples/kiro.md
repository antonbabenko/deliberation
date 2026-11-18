# Kiro steering rule for Deliberation

Kiro reads steering files from `.kiro/steering/*.md`. Save the block below as
`.kiro/steering/deliberation.md`. The frontmatter `inclusion: always` keeps it
in context for every interaction.

```md
---
inclusion: always
---

# Deliberation MCP experts

The Deliberation MCP server provides GPT, Gemini, Grok, and OpenRouter as expert
subagents. Call its tools when a task warrants outside input:

- Plan or architecture review: call `consensus`, `architect`, or
  `plan-reviewer`.
- Security review of auth, untrusted input, or a new endpoint: call
  `security-analyst`.
- A second opinion, or after a fix has failed twice: call `ask-all` or a single
  `ask-gpt` / `ask-gemini` / `ask-grok` tool.

Pass full context in the `prompt` - the experts do not share your session. Read
the result, then apply your own judgment. Skip delegation for simple edits and
first-attempt fixes.
```
