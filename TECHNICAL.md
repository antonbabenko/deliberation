# Technical Reference

Advanced and internal details for Claude Delegator. For install and everyday use,
see the [README](README.md). This document covers the provider bridges, the full
environment-variable reference, manual MCP setup, multi-turn and retry behavior,
and the Gemini recovery paths.

## Contents

- [Architecture](#architecture)
- [Provider bridges](#provider-bridges)
- [Environment variables](#environment-variables)
- [Manual MCP setup](#manual-mcp-setup)
- [Multi-turn and retry](#multi-turn-and-retry)
- [Gemini trust recovery](#gemini-trust-recovery)
- [Gemini timeout recovery](#gemini-timeout-recovery)
- [Grok files and cleanup](#grok-files-and-cleanup)
- [Customizing expert prompts](#customizing-expert-prompts)
- [Known limitations](#known-limitations)

## Architecture

Claude acts as the orchestrator. It reads your request, picks an expert, and
delegates to a provider over MCP. Each provider reaches Claude Code differently:

- **Codex (GPT)** - the Codex CLI ships a native MCP server (`codex mcp-server`).
- **Gemini** - a bundled zero-dependency Node bridge (`server/gemini/index.js`)
  wraps the Gemini CLI.
- **Grok (xAI)** - a bundled zero-dependency Node bridge (`server/grok/index.js`)
  talks to the xAI Responses API (`/v1/responses`) over HTTP. Advisory-only: it
  cannot edit files, but it can read attached files.

Responses are synthesized by Claude, never passed through verbatim.

## Provider bridges

### Gemini bridge

The bridge wraps the Gemini CLI and adds three reliability behaviors:

- **Soft-timeout drain** - on timeout it keeps Gemini alive and recovers the
  disk-flushed answer instead of failing. See
  [Gemini timeout recovery](#gemini-timeout-recovery).
- **Trust-failure signal** - when the CLI refuses an untrusted directory, the
  bridge returns a structured `errorKind: "trust"` envelope the orchestrator
  retries with `skip-trust`. See [Gemini trust recovery](#gemini-trust-recovery).
- **Hardened JSON parsing** - tolerant of the CLI's mixed stdout.

The bridge default model is `gemini-2.5-flash` (it does not read the Gemini CLI's
`~/.gemini/settings.json`). Override per call with the `model` parameter or globally
with `GEMINI_DEFAULT_MODEL`.

### Grok bridge

A bundled zero-dependency Node bridge over the xAI Responses API
(`/v1/responses`). It is advisory-only (it cannot edit files) but it can read
attached files: pass `files: [{ path | file_id | file_url }]` and the bridge
uploads to the xAI Files API and references them. Uploads are tagged
`claude-delegator-*` and carry an `expires_after` (default 7 days); prune early
with `/grok-files`. See [Grok files and cleanup](#grok-files-and-cleanup).

The bridge default model is `grok-4.3`. It needs `XAI_API_KEY` in its environment;
a missing key surfaces `errorKind: "missing-auth"`.

## Environment variables

This is the single source of truth for the bridge environment variables.

| Variable | Provider | Default | Purpose |
|----------|----------|---------|---------|
| `GEMINI_DEFAULT_MODEL` | Gemini | `gemini-2.5-flash` | Default model when the call sets none |
| `GEMINI_DISABLE_TIMEOUT_RECOVERY` | Gemini | unset | `1` forces legacy timeout (no drain) |
| `XAI_API_KEY` | Grok | unset (required) | xAI API key; missing key returns `missing-auth` |
| `GROK_DEFAULT_MODEL` | Grok | `grok-4.3` | Default model when the call sets none |
| `XAI_API_BASE` | Grok | `https://api.x.ai/v1` | API endpoint override |
| `GROK_REASONING_EFFORT` | Grok | `high` | `low`/`medium`/`high`; `none` or `off` omits the field |
| `GROK_FILE_TTL_SECONDS` | Grok | `604800` (7 days) | Upload lifetime, clamped 1h..30d |

Codex reads its own config from `~/.codex/config.toml` (see
[Configuration in the README](README.md#configuration)).

## Manual MCP setup

If `/setup` does not work, register the MCP servers manually. Each command is
idempotent (safe to rerun):

```bash
# Codex (GPT)
claude mcp remove codex >/dev/null 2>&1 || true
claude mcp add --transport stdio --scope user codex -- codex -m gpt-5.3-codex mcp-server

# Gemini
claude mcp remove gemini >/dev/null 2>&1 || true
claude mcp add --transport stdio --scope user gemini -- node ${CLAUDE_PLUGIN_ROOT}/server/gemini/index.js

# Grok (xAI) - API-based, advisory-only. Needs XAI_API_KEY.
# Default registers WITHOUT --env, so the key is NOT written to ~/.claude.json;
# export XAI_API_KEY in Claude Code's launch environment (e.g. your shell profile).
claude mcp remove grok >/dev/null 2>&1 || true
claude mcp add --transport stdio --scope user grok -- node ${CLAUDE_PLUGIN_ROOT}/server/grok/index.js
# Alternative (persists the key in ~/.claude.json in plaintext): append
#   --env XAI_API_KEY="$XAI_API_KEY"
# before the `-- node ...` part of the command above.
```

Verify:

```bash
claude mcp list
printf '{"jsonrpc":"2.0","id":"health","method":"initialize","params":{}}\n' | node ${CLAUDE_PLUGIN_ROOT}/server/gemini/index.js
printf '{"jsonrpc":"2.0","id":"health","method":"initialize","params":{}}\n' | node ${CLAUDE_PLUGIN_ROOT}/server/grok/index.js
```

## Multi-turn and retry

For chained implementation steps, an expert preserves context across turns:

```
Turn 1: mcp__*__*       -> returns threadId
Turn 2: mcp__*__*-reply(threadId) -> expert remembers turn 1
Turn 3: mcp__*__*-reply(threadId) -> expert remembers turns 1-2
```

Use single-shot (`codex`, `gemini`, `grok`) for advisory tasks. Use multi-turn for
implementation chains and retries. Grok is advisory-only.

Implementation retries up to 3 attempts total (1 initial + 2 `*-reply` retries),
then escalates to you. Retries reuse the `threadId` so the expert remembers the
earlier attempts.

## Gemini trust recovery

The Gemini CLI refuses to run from a directory it has not been told to trust
(entries live in `~/.gemini/trustedFolders.json`). When that happens the bridge
returns a structured signal:

```json
{
  "content": [{ "type": "text", "text": "Error: <message>" }],
  "isError": true,
  "errorKind": "trust",
  "retryable": true,
  "hint": "skip-trust"
}
```

`content` (the MCP text payload) is always present; `hint` is included only when
set. Other failures use the same envelope with a different `errorKind` (for
example `timeout`).

The orchestration rules (`rules/orchestration.md`, "Trust Failure Recovery")
instruct Claude to retry the same call once with `"skip-trust": true`, preserving
`threadId` for `gemini-reply`. A second consecutive trust failure (when
`skip-trust: true` was already set) escalates to you instead of looping. Callers
that already know they want to bypass the check can pass `"skip-trust": true` from
the start.

## Gemini timeout recovery

`timeout` is a soft deadline (default 300000ms; Gemini 3 deep prompts run
200-260s). The Gemini CLI ignores SIGTERM and persists its full answer to disk at
`~/.gemini/tmp/<slug>/chats/session-*.jsonl` regardless. When the soft timeout
fires, the bridge does not fail immediately: it drains - keeps Gemini alive and
polls that jsonl for a record newer than the call's start - for up to
`recovery-grace` ms (default 120000, range 0..600000). If the answer appears it is
returned as a normal success with a top-level `"recovered": true` flag and a stderr
log line; `content` is unmodified so response parsers keep working. If the grace
budget is exhausted with no answer, the call fails with `errorKind: "timeout"`
(still `retryable`).

- `"recovery-grace": 0` disables the drain (immediate legacy timeout).
- `GEMINI_DISABLE_TIMEOUT_RECOVERY=1` (env) forces full legacy behavior.
- The call resolves within `timeout + recovery-grace`. The Gemini child process is
  then killed `SIGTERM`, with a `SIGKILL` about 1s later; that kill is async
  cleanup and does not delay the response.

Manual recovery (any session, even without this plugin): find the project slug under
`~/.gemini/tmp/` (its `.project_root` file holds the absolute cwd), then in that
slug's `chats/` open the newest `session-*.jsonl`; the last record with
`"type":"gemini"` has the full answer in `.content`.

## Grok files and cleanup

Grok can read attached files. Pass `files: [{ path | file_id | file_url }]`:

- `path` - a local file the bridge uploads to the xAI Files API, then references.
- `file_id` - an already-uploaded xAI file id.
- `file_url` - a public URL.

Uploads are tagged `claude-delegator-*` and carry an `expires_after` set by
`GROK_FILE_TTL_SECONDS` (default `604800` = 7 days, clamped 1h..30d). List or prune
bridge-owned uploads early with `/grok-files`. A path outside the working directory
is refused (no exfiltration); an oversize file returns `file-too-large`.

## Customizing expert prompts

Expert prompts live in `prompts/`. Each follows the same structure: role definition
and context, advisory vs implementation modes, response-format guidance, and when
to invoke or not invoke. Edit these to change expert behavior for your workflow.

## Known limitations

- Heavy parallel calls from the same cwd (for example `/ask-all`, `/consensus`) can
  race on "newest session file" during Gemini timeout recovery. A spawn-start
  timestamp guard (2000ms skew tolerance) makes mis-attribution unlikely but not
  impossible.
