---
name: ask-openrouter
description: Ask a single configured OpenRouter model for a second opinion. Advisory only. Single-shot or multi-turn.
allowed-tools: mcp__deliberation__ask-openrouter, mcp__deliberation-openrouter__openrouter, mcp__deliberation-openrouter__openrouter-reply, mcp__deliberation-openrouter__openrouter-list, Read, Bash
timeout: 660000
---

# Ask OpenRouter

Delegate a question to the default OpenRouter model or a specific configured delegate (advisory only; OpenRouter cannot edit files).

## Input

`$ARGUMENTS` is `[alias] <question>`. If the first whitespace-delimited token matches a
configured delegate alias, it selects that delegate and the rest is the question. Otherwise the
whole string is the question and the default OpenRouter model configured in `config.json`
(via `models.<id>.default: true` or `providers.openrouter.defaultModel` / `model`) is called.

## Workflow

1. Identify the expert role from the question via `~/.claude/rules/deliberation/triggers.md` (default Architect). Then load that expert's prompt:
   1. Glob `~/.claude/plugins/cache/*/deliberation/*/prompts/[expert].md` and pick the match with the highest semver version segment (the segment immediately after `deliberation/`, parsed as semver - not lexical compare).
   2. If no match is found, abort with: `Error: deliberation plugin cache missing for expert "[Expert]". Run /plugin install deliberation or /reload-plugins.`
2. Build the 7-section delegation prompt per `~/.claude/rules/deliberation/delegation-format.md`.
   Time-sensitive facts: when the question turns on latest or current versions, pricing,
   a roadmap, or whether a model or tool exists, verify it with your own tools first and add
   the facts with as-of date and source (the delegate cannot look anything up).
   If the question references local files, attach them with
   `files: [{ path: "...", mode: "auto" }]` (text-inline; `{ dir: "..." }` also supported).
3. Print: `OpenRouter (<alias-or-default>) working (typical 30-60s)...` where `<alias-or-default>` is the selected alias, or `default` when no alias was given.
4. Call OpenRouter:
   - If using the unified deliberation MCP server (`mcp__deliberation__ask-openrouter`):
     ```
     mcp__deliberation__ask-openrouter({
       prompt: "[7-section prompt]",
       developerInstructions: "[expert prompt]",
       cwd: "[repo root]",
       files: [ /* optional text-inline files */ ]
     })
     ```
   - If using the standalone OpenRouter bridge (`mcp__deliberation-openrouter__openrouter`):
     ```
     mcp__deliberation-openrouter__openrouter({
       prompt: "[7-section prompt]",
       "developer-instructions": "[expert prompt]",
       alias: "[selected alias, or omit to call default]",
       cwd: "[repo root]",
       files: [ /* optional text-inline files */ ]
     })
     ```
5. On `result.isError`, report the `errorKind` (`model-not-allowed` => bad alias; `auth` =>
   the env var named by `apiKeyEnv` is empty; `config` => a hard config failure, fix
   `config.json`). A single bad model entry no longer breaks the whole config: this
   single-shot call still works as long as the requested alias or default model is valid.
6. Synthesize the answer; never paste raw output. For a follow-up turn, reuse the returned
   `threadId` via `mcp__deliberation-openrouter__openrouter-reply`.

## Rules

- Advisory only - OpenRouter has no filesystem access; route implementation tasks to
  Codex/Gemini.
- Single delegate per call. For parallel multi-model opinions use `/ask-all`.
