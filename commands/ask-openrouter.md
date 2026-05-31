---
name: ask-openrouter
description: Ask a single configured OpenRouter model for a second opinion. Advisory only. Single-shot or multi-turn.
allowed-tools: mcp__deliberation-openrouter__openrouter, mcp__deliberation-openrouter__openrouter-reply, mcp__deliberation-openrouter__openrouter-list, Read, Bash
timeout: 300000
---

# Ask OpenRouter

Delegate a question to one configured OpenRouter delegate (advisory only; OpenRouter cannot edit files).

## Input

`$ARGUMENTS` is `[alias] <question>`. If the first whitespace-delimited token matches a
configured alias (see `openrouter-list`), it selects that delegate and the rest is the
question. Otherwise the whole string is the question and the `openrouter-default` delegate
is used.

## Workflow

1. Call `mcp__deliberation-openrouter__openrouter-list`. If the tool is unavailable, tell the user
   OpenRouter is not configured (add models to `~/.config/deliberation/config.json` -
   the canonical path, Windows `%APPDATA%\deliberation\config.json` - then run
   `/deliberation:setup`) and stop.
2. Parse `$ARGUMENTS`: if the first token equals a delegate `alias`, use it; else use no
   alias (the bridge falls back to `openrouter-default`; if `defaultModelSet` is false in
   the list output, tell the user to pass an explicit alias and stop).
3. Identify the expert role from the question via `~/.claude/rules/deliberation/triggers.md` (default Architect). Then load that expert's prompt:
   1. Glob `~/.claude/plugins/cache/*/deliberation/*/prompts/[expert].md` and pick the match with the highest semver version segment (the segment immediately after `deliberation/`, parsed as semver - not lexical compare).
   2. If no match is found, abort with: `Error: deliberation plugin cache missing for expert "[Expert]". Run /plugin install deliberation or /reload-plugins.`
4. Build the 7-section delegation prompt per `~/.claude/rules/deliberation/delegation-format.md`.
   If the question references local files, attach them with
   `files: [{ path: "...", mode: "auto" }]` (text-inline; `{ dir: "..." }` also supported).
5. Print: `OpenRouter (<alias-or-default>) working (typical 30-60s)...` where `<alias-or-default>` is the selected alias, or `openrouter-default` when no alias was given.
6. Call:
   ```
   mcp__deliberation-openrouter__openrouter({
     prompt: "[7-section prompt]",
     "developer-instructions": "[expert prompt]",
     alias: "[selected alias, omit to use openrouter-default]",
     sandbox: "read-only",
     cwd: "[repo root]",
     files: [ /* optional text-inline files */ ]
   })
   ```
7. On `result.isError`, report the `errorKind` (`model-not-allowed` => bad alias; `auth` =>
   the env var named by `apiKeyEnv` is empty; `config` => a hard config failure, fix
   `config.json`). A single bad model entry no longer breaks the whole config: this
   single-shot call still works as long as the requested alias is valid. To see which
   entries the bridge skipped (and their `suggestedAlias` repairs), run
   `mcp__deliberation-openrouter__openrouter-list` and check `invalidModels`, then either hand-edit
   `config.json` or run `/ask-all` or `/consensus`, which offer a Fix & proceed prompt.
8. Synthesize the answer; never paste raw output. For a follow-up turn, reuse the returned
   `threadId` via `mcp__deliberation-openrouter__openrouter-reply`.

## Rules

- Advisory only - OpenRouter has no filesystem access; route implementation tasks to
  Codex/Gemini.
- Single delegate per call. For parallel multi-model opinions use `/ask-all`.
- **Serial prep is correct here** - `openrouter-list` (step 1) MUST run before the expert-prompt `Glob` (step 3): alias-stripping consumes the list, the stripped question determines the expert, and the expert determines the `Glob` target. This is a genuine data dependency, so the two reads CANNOT be merged into one parallel block (unlike `/ask-all`). Do not "optimize" them together. See `rules/deliberation/orchestration.md` Step 5.5.
