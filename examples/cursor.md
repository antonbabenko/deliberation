# Cursor rule for Deliberation

Cursor reads project rules from `.cursor/rules/*.mdc` (newer) or a single
`.cursorrules` file (legacy). Save the block below as
`.cursor/rules/deliberation.mdc` with the frontmatter, or paste the body into
`.cursorrules`.

```mdc
---
description: Use Deliberation MCP experts for review and second opinions
alwaysApply: true
---

The Deliberation MCP server gives you GPT, Gemini, Grok, and OpenRouter as
expert subagents. Call its tools when a task warrants outside input:

- Plan or architecture review: call `consensus` or the `architect` /
  `plan-reviewer` tool.
- Security review of auth, untrusted input, or a new endpoint: call
  `security-analyst`.
- A second opinion, or after a fix has failed twice: call `ask-all` or a single
  `ask-gpt` / `ask-gemini` / `ask-grok` tool.

Pass full context in the `prompt` - the experts do not share your session.
Read the result, then apply your own judgment. Skip delegation for simple edits
and first-attempt fixes.
```
