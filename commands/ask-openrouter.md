---
name: ask-openrouter
description: Ask a single configured OpenRouter model for a second opinion. Advisory only. Single-shot or multi-turn.
allowed-tools: mcp__openrouter__openrouter, mcp__openrouter__openrouter-reply, mcp__openrouter__openrouter-list, Read, Bash
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

1. Call `mcp__openrouter__openrouter-list`. If the tool is unavailable, tell the user
   OpenRouter is not configured (add models to `~/.claude/claude-delegator/config.json`,
   then run `/claude-delegator:setup`) and stop.
2. Parse `$ARGUMENTS`: if the first token equals a delegate `alias`, use it; else use no
   alias (the bridge falls back to `openrouter-default`; if `defaultModelSet` is false in
   the list output, tell the user to pass an explicit alias and stop).
3. Identify the expert role from the question via `~/.claude/rules/delegator/triggers.md`
   (default Architect) and load the expert prompt the same way `ask-all.md` does.
4. Build the 7-section delegation prompt per `~/.claude/rules/delegator/delegation-format.md`.
   If the question references local files, attach them with
   `files: [{ path: "...", mode: "auto" }]` (text-inline; `{ dir: "..." }` also supported).
5. Print: `OpenRouter (<alias>) working (typical 30-60s)...`
6. Call:
   ```
   mcp__openrouter__openrouter({
     prompt: "[7-section prompt]",
     "developer-instructions": "[expert prompt]",
     alias: "[selected alias, omit to use openrouter-default]",
     sandbox: "read-only",
     cwd: "[repo root]",
     files: [ /* optional text-inline files */ ]
   })
   ```
7. On `result.isError`, report the `errorKind` (`model-not-allowed` => bad alias; `auth` =>
   the env var named by `apiKeyEnv` is empty; `config` => fix `config.json`).
8. Synthesize the answer; never paste raw output. For a follow-up turn, reuse the returned
   `threadId` via `mcp__openrouter__openrouter-reply`.

## Rules

- Advisory only - OpenRouter has no filesystem access; route implementation tasks to
  Codex/Gemini.
- Single delegate per call. For parallel multi-model opinions use `/ask-all`.
