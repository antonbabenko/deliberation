---
name: ask-all
description: Ask models in parallel for independent opinions, then synthesize.
---

# Ask All (Parallel Deliberation)

Use this skill to query all configured deliberation models simultaneously for
independent opinions on the same question with zero cross-talk.

## Execution Patterns

### 1. Progressive Pattern (Recommended)
1. Call `panel` (MCP `deliberation:panel`) to inspect active delegates (e.g.
   `google:gemini-3.8-flash-high`, `lmstudio:qwen3-coder-next`,
   `ollama:nemotron-3-ultra:cloud`, `ollama:glm-5.3:cloud`).
2. Dispatch `ask-one` for each provider in parallel in a single turn so progress
   is visible and each model streams back independently.

### 2. Single-Call Pattern
- Call `ask-all` (MCP `deliberation:ask-all`) with `{ prompt, expert }` to fan
  out across all active providers in one call.

## Guidelines
- Always provide self-contained context in `prompt` (relevant code,
  constraints, file snippets), especially for file-blind delegates.
- Synthesize all returned opinions, highlight areas of unanimous agreement, and
  clearly contrast dissenting viewpoints.
