# Technical Reference

Advanced and internal details for Claude Delegator. For install and everyday use,
see the [README](README.md). This document covers the provider bridges, the full
environment-variable reference, manual MCP setup, multi-turn and retry behavior,
and the Gemini recovery paths.

## Contents

- [Architecture](#architecture)
- [Consensus flow details](#consensus-flow-details)
- [Provider bridges](#provider-bridges)
- [Environment variables](#environment-variables)
- [Manual MCP setup](#manual-mcp-setup)
- [Multi-turn and retry](#multi-turn-and-retry)
- [Gemini timeout recovery](#gemini-timeout-recovery)
- [Grok files and cleanup](#grok-files-and-cleanup)
- [Customizing expert prompts](#customizing-expert-prompts)
- [Troubleshooting](#troubleshooting)
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

End-to-end flow on a typical request:

```
You: "Is this authentication flow secure?"
                |
                v
Claude: detects a security question, selects the Security Analyst
                |
                v
   +-------------------------------------+
   |  mcp__codex__codex /                |
   |  mcp__gemini__gemini /              |
   |  mcp__grok__grok                    |
   |    -> Security Analyst prompt       |
   |    -> expert analyzes your code     |
   +-------------------------------------+
                |
                v
Claude: "I found 3 issues..." (synthesizes, applies judgment)
```

- Each expert has a specialized system prompt (in `prompts/`).
- Claude reads your request, picks the expert, and delegates over MCP.
- Responses are synthesized, not passed through raw.
- Multi-turn conversations preserve context via `threadId` for chained work, and implementation retries before escalating to you.

## Consensus flow details

The README's `## How /consensus and /ask-* keep models honest` section covers the 3-stage flow narrative inside a `<details>` block. The two reference pieces below live here so the README stays narrative:

**Stage 2 scoring vocabulary** (the closed taxonomy `/consensus` uses for all critical-issue categories):

- `security` - auth, secrets, injection, data exposure, privilege boundary
- `correctness` - wrong behaviour, broken invariant, missing case, race condition
- `scope` - undefined boundary, missing acceptance criteria, deliverable unclear
- `ambiguity` - reference too vague to act on, contradictory steps, missing context
- `performance` - latency, throughput, resource use, scaling limit
- `ops` - rollback, observability, deploy, migration, on-call surface

**Operator-visible debug.** The final `/consensus` report logs a Stage 2 shuffle mapping per round so you can audit which model rated which anonymized answer. The mapping lives in the final report only - reviewers never see it during Stage 2.

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
attached files: pass `files: [{ path | file_id | file_url | dir }]` and the
bridge delivers them per the `mode` setting — uploaded to the xAI Files API
(default), inlined as `input_text` (for line-by-line reading of source files),
or expanded via the bundled glob walker for directories. Resolution is against
the top-level `roots: string[]` (first-root-wins) or `cwd` when `roots` is
omitted. Uploaded files are SHA-256 dedup-cached locally and carry an
`expires_after` (default 7 days); manage with `/grok-files`
(`list` / `prune` / `gc`). See [Grok files and cleanup](#grok-files-and-cleanup).

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

Grok reads attached files via the `files[]` parameter. Each entry has EXACTLY ONE of:

- `path` - a local file. Delivery is controlled by `mode` (default `"upload"` — bridge uploads to the xAI Files API; `"inline"` embeds as `input_text`; `"auto"` picks per heuristic — see "Inline vs upload delivery" below).
- `file_id` - an already-uploaded xAI file id (passed through, no upload).
- `file_url` - a public URL (passed through).
- `dir` - a local directory expanded recursively. Same `mode` rules; the walker
  applies the chosen mode to every selected file (see below).

A `path` or `dir` resolves against the top-level `roots[]` array (absolute directories,
first-root-wins for relative entries) or, when `roots` is omitted, against `cwd`. A
path that resolves outside every declared root is refused (no exfiltration); symlinks
that escape via `realpath` are also refused. An oversize file (>48 MB) returns
`file-too-large`.

### Cross-repo example

```js
mcp__grok__grok({
  prompt: "Compare the auth strategy in these two services.",
  cwd: "/Users/me/work/service-a",
  roots: ["/Users/me/work/service-a", "/Users/me/work/service-b"],
  files: [
    { path: "src/auth.ts" },                          // resolves under service-a (first root)
    { path: "/Users/me/work/service-b/src/auth.ts" }, // absolute, must lie under one root
    { dir: "docs", include: ["**/*.md"], maxFiles: 20 }, // expands service-a/docs
  ],
})
```

### Directory expansion (`{dir}`)

The bridge bundles a zero-dep glob walker (`server/grok/glob.js`) so you do not have
to enumerate every file by hand:

- `include` (default `["**/*"]`).
- `exclude` is **appended** to the bridge's safe defaults (it does NOT replace
  them). Defaults cover: VCS (`.git`); JS/Node (`node_modules`, `dist`, `build`,
  `out`, `.next`, `.svelte-kit`, `.nuxt`, `.turbo`, `.cache`, `.parcel-cache`,
  `.pnpm-store`); Yarn Berry (`.yarn/cache`, `.yarn/unplugged`); lockfiles
  (`**/*.lock`); Python (`.venv`, `venv`, `__pycache__`, `.tox`, `.pytest_cache`,
  `.mypy_cache`, `.ruff_cache`, `.ipynb_checkpoints`, `.eggs`, `htmlcov`);
  coverage (`coverage`, `.nyc_output`); Rust/Java/Gradle (`target`, `.gradle`);
  Go/PHP (`vendor`); Terraform (`.terraform`, `.terragrunt-cache`); plus
  security: `**/*.tfstate*`, granular `.env` variants (keeps `.env.example`
  readable), `.ssh/**`, SSH keypairs (`id_rsa`, `id_ed25519`, `id_ecdsa`,
  `id_dsa` and `.pub`), and `**/*.pem`/`**/*.key`.
- To replace defaults entirely instead of appending, set `excludeReset: true`
  on the same `{dir}` entry. `excludeReset` is validated as a strict boolean by
  `validateFiles`; non-boolean values are rejected. Use only when reviewing
  files defaults would block (e.g., Terraform state in a security audit, or
  legitimate `.pem` public certs). Tradeoff is explicit: the bridge prefers a
  false positive (blocking a legitimate `.pem`) over a false negative
  (leaking a private key).
- `maxFiles` (default 50), `maxBytes` (default 128 MB). Exceeding either throws a
  hard error with counts - no silent truncation.
- Walker is symlink-safe: dirs are pruned **before** descent; symlinks to dirs are
  not followed (cycle safety); symlinks to files are followed only when `realpath`
  stays inside the resolved root.
- Patterns are POSIX (`/` separator). Backslash escape sequences are rejected at
  validation; literal `path`/`dir` values **may** contain backslashes (Windows OK).

### Inline vs upload delivery (`mode`)

xAI's `input_file` references are searchable attachments; for large source files
the model may enumerate them rather than read line-by-line. To force a full
line-by-line read, deliver the content as `input_text` instead:

```js
files: [
  { path: "app/apps/api/routes.py", mode: "inline" },   // forced inline
  { path: "modules/web.tm.hcl",     mode: "auto" },     // text + small → inline
  { path: "design.pdf",             mode: "auto" },     // binary or big → upload
  { dir:  "src", include: ["**/*.ts"], mode: "auto" },  // each walked file decides
]
```

- `"upload"` (default) - always uses the xAI Files API. Back-compat with v2.0.
- `"inline"` - embeds the file content directly as a separate `input_text` part
  with a `=== {filename} ===` header. No `/files` call, no cache row, no
  `uploadedFileIds` entry. Best for source code review.
- `"auto"` - inlines when the file is probably text (no NUL byte; <5%
  non-printable bytes in the first 4 KB) AND its size is at or below
  `GROK_INLINE_MAX_BYTES` (default 262144 = 256 KB). Otherwise uploads.

For `{dir}` entries the `mode` is inherited by every walked file. `mode` must
NOT be set on `file_id` / `file_url` entries (those bypass the upload path
entirely; setting `mode` on them returns `-32602` from `validateFiles`).
Override the inline ceiling with `GROK_INLINE_MAX_BYTES=<bytes>` in the bridge
environment.

### Content-hash cache

Uploads are deduplicated by SHA-256 content hash. A reuse hit requires the SAME content
**plus** the same API key, the same normalised `apiBase`, and the same effective filename
(see cache-key below); identical bytes uploaded under a different filename or a different
key produce separate cache rows:

- Cache file: `~/.claude/cache/claude-delegator/grok-files.json`
- Cache key: `sha256(bytes)@sha256(XAI_API_KEY)[:16]@normalize(apiBase)@effectiveFilename`
  - Key rotation auto-invalidates entries (different `keyFp`).
  - Different `apiBase` (including port/protocol differences) → separate rows.
  - Different effective filename (basename or `filename` override) → separate rows.
- Reuse check: hit + `expiresAt > now + 60s` + `apiBase` + `keyFp` all match.
- In-process Promise dedup (`withInflight`): concurrent uploads of the same content
  collapse into a single network call.
- Cross-process safety: mkdir-based lock (`server/grok/lock.js`) with token-specific
  owner markers + stale reclaim via atomic rename. (`lock.heartbeat()` is provided
  for long-running holders; cache writes complete sub-second so the 5s stale window
  is not at risk and the bridge does not call it.)
- Stale xAI file id mid-`/v1/responses`: when the responses call returns a 4xx
  whose body names a `file_*` / `file-*` id from the current refs (and the ref has a
  `sourcePath`), the bridge evicts the cached row, re-uploads from the original
  disk path, and retries the responses call **once**. Errors that don't name a
  known file id are surfaced unchanged.
- `XAI_DISABLE_FILE_CACHE=1` (env) skips the cache layer entirely (debugging).

Stored upload filenames are `claude-delegator-{sha256[:16]}-{basename}`. Uploads also
carry `expires_after` set by `GROK_FILE_TTL_SECONDS` (default `604800` = 7 days,
clamped 1h..30d).

### Cleanup (`/grok-files`)

The bundled `server/grok/files-admin.js` supports three subcommands:

- `list` - shows total xAI file count and every `claude-delegator-*` upload.
- `prune --older-than <30m|24h|7d|seconds> [--yes]` - dry run by default; deletes
  **remote** bridge-owned files matched by filename prefix + age. Works without the
  local cache; safe for environments where the cache was lost or never existed.
- `gc [--all-keys] [--force-local-prune]` - syncs the **local** cache with the
  remote file list via one paginated `GET /v1/files`. Prunes local rows whose
  `fileId` is no longer on xAI. Default scope is the current `XAI_API_KEY` +
  `XAI_API_BASE` rows only. `--all-keys` widens to foreign rows but leaves them
  in place when remote absence is ambiguous (the current key can't see foreign
  files). `--force-local-prune` drops ambiguous foreign rows anyway.

`prune` and `gc` are complementary: `prune` is the remote-side cleaner; `gc` keeps
the local cache aligned with remote state. The `claude-delegator-` filename prefix
is a hard safety invariant on both paths - your own xAI files are never touched.

## Customizing expert prompts

Expert prompts live in `prompts/`. Each follows the same structure: role definition
and context, advisory vs implementation modes, response-format guidance, and when
to invoke or not invoke. Edit these to change expert behavior for your workflow.

## Troubleshooting

| Issue | Solution |
|-------|----------|
| MCP server not found | Restart Claude Code after setup |
| Provider not authenticated | Codex: `codex login`. Gemini: run `agy` once (or set `GOOGLE_API_KEY`). Grok: export `XAI_API_KEY` (else calls return `errorKind: missing-auth`) |
| Tool not appearing | Run `claude mcp list` and verify registration |
| Expert not triggered | Ask explicitly: "Ask GPT to review...", "Ask Gemini to review...", or "Ask Grok to review..." |
| Gemini writes don't land in the workspace | Expected: `agy` print mode writes to a scratch dir, so Gemini-via-agy is advisory-effective (great for analysis and review, but it cannot mutate the real workspace). Use Codex for implementation. |

`agy` print mode does not enforce folder trust, so there is no trust prompt to clear. Soft-timeout recovery (stdout-drain) is documented in [Gemini timeout recovery](#gemini-timeout-recovery).

## Known limitations

- `agy` print mode writes to a scratch dir, so the Gemini expert is
  advisory-effective: it cannot mutate the real workspace even under
  `workspace-write`. Route implementation work to Codex (GPT).
- `agy` resolves a conversation id per cwd (in
  `~/.gemini/antigravity-cli/cache/last_conversations.json`). Heavy parallel calls
  from the same cwd (for example `/ask-all`, `/consensus`) share that single
  per-cwd slot, so a `gemini-reply` could attach to a sibling run's conversation.
  This mirrors `agy`'s own per-cwd model.
