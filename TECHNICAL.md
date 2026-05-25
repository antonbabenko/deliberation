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
- [Gemini timeout recovery](#gemini-timeout-recovery)
- [Grok files and cleanup](#grok-files-and-cleanup)
- [Customizing expert prompts](#customizing-expert-prompts)
- [Known limitations](#known-limitations)

## Architecture

Claude acts as the orchestrator. It reads your request, picks an expert, and
delegates to a provider over MCP. Each provider reaches Claude Code differently:

- **Codex (GPT)** - the Codex CLI ships a native MCP server (`codex mcp-server`).
- **Gemini** - a bundled zero-dependency Node bridge (`server/gemini/index.js`)
  wraps the Antigravity CLI (`agy`).
- **Grok (xAI)** - a bundled zero-dependency Node bridge (`server/grok/index.js`)
  talks to the xAI Responses API (`/v1/responses`) over HTTP. Advisory-only: it
  cannot edit files, but it can read attached files.

Responses are synthesized by Claude, never passed through verbatim.

## Provider bridges

### Gemini bridge

The bridge wraps the Antigravity CLI (`agy`) in print mode (`agy -p`) and adds two
reliability behaviors:

- **Soft-timeout drain** - on timeout it keeps `agy` alive, keeps buffering its
  streamed stdout, and returns the answer if `agy` completes cleanly within the
  grace budget. See [Gemini timeout recovery](#gemini-timeout-recovery).
- **Plain-stdout answer with an `Error:` sentinel** - `agy -p` prints the answer as
  plain UTF-8 text on stdout and exits 0; there is no `-o json` mode. The bridge
  treats stdout as the answer unless it matches `/^\s*Error:/` (agy reports
  failures as `Error: <message>` on stdout, still at exit 0), in which case it
  classifies the failure into an error envelope.

Flag mapping the bridge applies to `agy`:

| Bridge input | `agy` flag |
|--------------|------------|
| `sandbox: read-only` (advisory) | `--sandbox` |
| `sandbox: workspace-write` | `--dangerously-skip-permissions` (best-effort) |
| `include-directories: [...]` | repeated `--add-dir <dir>` |
| `gemini-reply` (multi-turn) | `--conversation <id>` |
| always | `--print-timeout <duration>` and `-p <prompt>` |

There is no `-m`/`--model` flag and no `-o json`. The model is read from
`~/.gemini/settings.json` (`model.name`, default `auto-gemini-3`); the MCP `model`
parameter is advisory only. The bridge default model is `auto-gemini-3`; override the
default with `GEMINI_DEFAULT_MODEL`, or point at a different `agy` binary with
`AGY_BIN`. `agy` print mode does not enforce folder trust.

`agy` print-mode writes go to a scratch dir, so Gemini-via-agy is advisory-effective:
it can read context to advise but cannot mutate the real workspace, even under
`workspace-write`.

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
| `GEMINI_DEFAULT_MODEL` | Gemini | `auto-gemini-3` | Default model when the call sets none |
| `GEMINI_DISABLE_TIMEOUT_RECOVERY` | Gemini | unset | `1` forces legacy timeout (no drain) |
| `AGY_BIN` | Gemini | `agy` | Override the path to the `agy` binary |
| `AGY_LAST_CONVERSATIONS` | Gemini | `~/.gemini/antigravity-cli/cache/last_conversations.json` | Override the conversation-id map file (mainly for tests) |
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

## Gemini timeout recovery

`timeout` is a soft deadline (default 300000ms; Gemini 3 deep prompts run
200-260s). `agy -p` streams its answer to stdout incrementally, so the bridge
recovers by draining that stream rather than scraping disk. When the soft timeout
fires, the bridge does not fail immediately: it keeps `agy` alive and keeps
buffering its streamed stdout for up to `recovery-grace` ms (default 120000, range
0..600000). If `agy` completes cleanly within the grace budget (exit 0, no `Error:`
sentinel on stdout), the buffered output is returned as a normal success with a
top-level `"recovered": true` flag and a stderr log line; `content` is the full
answer so response parsers keep working. If `agy` is still running when the grace
budget is exhausted, the call fails with `errorKind: "timeout"` (still
`retryable`).

- `"recovery-grace": 0` disables the drain (immediate legacy timeout).
- `GEMINI_DISABLE_TIMEOUT_RECOVERY=1` (env) forces full legacy behavior.
- The call resolves within `timeout + recovery-grace`. The `agy` child process is
  then killed `SIGTERM`, with a `SIGKILL` about 1s later; that kill is async
  cleanup and does not delay the response.

## Grok files and cleanup

Grok can read attached files. Pass `files: [{ path | file_id | file_url }]`:

- `path` - a local file the bridge uploads to the xAI Files API, then references.
- `file_id` - an already-uploaded xAI file id.
- `file_url` - a public URL.

A `path` resolves against the call's `cwd` (default = the server's cwd), so set `cwd`
to the directory that contains the files - for a repo, the repo root - or the upload
is refused as outside the working directory. Attach referenced local files by default.

Uploads are tagged `claude-delegator-*` and carry an `expires_after` set by
`GROK_FILE_TTL_SECONDS` (default `604800` = 7 days, clamped 1h..30d). List or prune
bridge-owned uploads early with `/grok-files`. A path outside the working directory
is refused (no exfiltration); an oversize file returns `file-too-large`.

## Customizing expert prompts

Expert prompts live in `prompts/`. Each follows the same structure: role definition
and context, advisory vs implementation modes, response-format guidance, and when
to invoke or not invoke. Edit these to change expert behavior for your workflow.

## Known limitations

- `agy` print mode writes to a scratch dir, so the Gemini expert is
  advisory-effective: it cannot mutate the real workspace even under
  `workspace-write`. Route implementation work to Codex (GPT).
- `agy` resolves a conversation id per cwd (in
  `~/.gemini/antigravity-cli/cache/last_conversations.json`). Heavy parallel calls
  from the same cwd (for example `/ask-all`, `/consensus`) share that single
  per-cwd slot, so a `gemini-reply` could attach to a sibling run's conversation.
  This mirrors `agy`'s own per-cwd model.
