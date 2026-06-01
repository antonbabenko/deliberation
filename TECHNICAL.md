# Technical Reference

Advanced and internal details for Deliberation. For install and everyday use,
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
- [OpenRouter bridge](#openrouter-bridge)
- [Session persistence](#session-persistence)
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
   |  mcp__deliberation-codex__codex /   |
   |  mcp__deliberation-gemini__gemini / |
   |  mcp__deliberation-grok__grok       |
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

`/consensus` is a thin driver over the `consensus-step` tool; the multi-round loop lives in
the core state machine (`core/consensus-loop.js`). Each round: Claude commits a blind verdict,
the server fans out to the panel (`dispatch_peers`) and parses each voice's verdict + critical
issues, Claude adjudicates (accept/dismiss/defer, every dismiss carries a reason), then revises
the plan. The loop converges only when at least one responding peer APPROVES, none REJECT, zero
accepted critical issues remain, and Claude's adjudicated verdict is APPROVE - so Claude cannot
self-approve. The cap is `consensus.maxRounds` (default 5).

**Critical-issue taxonomy** (the closed set every critical issue is tagged with, parsed by
`parseReview` in `core/provider.js`):

- `security` - auth, secrets, injection, data exposure, privilege boundary
- `correctness` - wrong behaviour, broken invariant, missing case, race condition
- `scope` - undefined boundary, missing acceptance criteria, deliverable unclear
- `ambiguity` - reference too vague to act on, contradictory steps, missing context
- `performance` - latency, throughput, resource use, scaling limit
- `ops` - rollback, observability, deploy, migration, on-call surface

**Stage 2 (anonymized peer cross-review) is not part of the current loop.** Earlier revisions ran
a command-layer Stage 2 (each reviewer scored the others' anonymized answers, with a shuffle
mapping in the report). The engine-driven rewrite removed it: the core loop has no Stage 2 model,
and keeping it in command prose re-introduced the duplication the rewrite eliminated. If anonymized
cross-review proves valuable it returns as an engine feature (a new `consensus-step` action), not as
prose.

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
bridge delivers them per the `mode` setting - uploaded to the xAI Files API
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
| `DELIBERATION_SESSIONS` | sessions | `<XDG cache>/deliberation/sessions` | Override the session store directory (see [Session persistence](#session-persistence)) |

Codex has no bridge environment variables: it ships its own native MCP server and
reads `~/.codex/config.toml` directly. The **model** comes from the `model` key in
that file by default (the Codex analog of `GEMINI_DEFAULT_MODEL` /
`GROK_DEFAULT_MODEL`). Override it on the server with `-c model=<id>` on the
`claude mcp add ... deliberation-codex` registration, or per call with the `model` parameter of
`mcp__deliberation-codex__codex(...)`. See [Configuration in the README](README.md#configuration).

## Manual MCP setup

If `/setup` does not work, register the MCP servers manually. Each command is
idempotent (safe to rerun):

```bash
# Codex (GPT) - inherits its model from ~/.codex/config.toml.
# Pin a model on the server with `-c model=<id>` (e.g. `codex mcp-server -c model=gpt-5.5`).
claude mcp remove codex >/dev/null 2>&1 || true
claude mcp add --transport stdio --scope user codex -- codex mcp-server

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

- `path` - a local file. Delivery is controlled by `mode` (default `"upload"` - bridge uploads to the xAI Files API; `"inline"` embeds as `input_text`; `"auto"` picks per heuristic - see "Inline vs upload delivery" below).
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
mcp__deliberation-grok__grok({
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

- `"upload"` (default) - always uses the xAI Files API. Matches the v2.0 behavior.
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

- Cache file: `~/.cache/deliberation/grok-files.json` (canonical XDG path; Windows
  `%LOCALAPPDATA%\deliberation\grok-files.json`). Override with `DELIBERATION_CACHE`.
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

Stored upload filenames are `deliberation-{sha256[:16]}-{basename}`. Uploads also
carry `expires_after` set by `GROK_FILE_TTL_SECONDS` (default `604800` = 7 days,
clamped 1h..30d).

### Cleanup (`/grok-files`)

The bundled `server/grok/files-admin.js` supports three subcommands:

- `list` - shows total xAI file count and every `deliberation-*` upload.
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
the local cache aligned with remote state. The `deliberation-` filename prefix
is a hard safety invariant on both paths - your own xAI files are never touched.

## OpenRouter bridge

The OpenRouter bridge (`server/openrouter/index.js`) is a zero-dependency Node MCP server
that calls any OpenAI-compatible `POST {apiBase}/chat/completions` endpoint.
It is **advisory-only** - it cannot edit files or run shell commands.

### Configuration file

The bridge and the fan-out commands (`/ask-all`, `/consensus`) read
`~/.config/deliberation/config.json` at call time - the canonical XDG path (Windows:
`%APPDATA%\deliberation\config.json`). Override the path with `DELIBERATION_CONFIG`. The file is stat-gated: the bridge re-reads it only when
the mtime changes, so edits to `models`, `routing`, or the `providers.openrouter` block
take effect immediately without restarting Claude Code or re-running `/setup`. Toggling a
**built-in** provider (codex / gemini / grok) still requires `/setup` to re-register
or de-register the MCP server.

### Concepts

The config has four top-level sections, each with one job:

- **`providers`** - transport / connection only. Per provider: `enabled` (default true)
  plus auth/endpoint keys. `providers.openrouter` also carries the OpenRouter-specific
  connection keys (`apiBase`, `allowRawModel`, `defaultModel`, per-call `defaults`).
- **`models`** - named model records, keyed by id. Each record names its `provider` and
  `model` slug and sets routing flags. This is where you declare the models the panel uses.
- **`routing`** - global fan-out policy (`maxFanout`).
- **`consensus`** - `arbiter` (who synthesizes the consensus verdict) and `blindVote`
  (optional blind arbiter pre-vote; boolean, default `false`).

Config file schema (strict JSON, `version` must be `1`):

```json
{
  "$schema": "https://raw.githubusercontent.com/antonbabenko/deliberation/master/config/config.schema.json",
  "version": 1,
  "providers": {
    "codex":  { "enabled": true },
    "gemini": { "enabled": true },
    "grok":   { "enabled": true, "apiKeyEnv": "XAI_API_KEY" },
    "openrouter": {
      "enabled": true,
      "apiKeyEnv": "OPENROUTER_API_KEY",
      "apiBase": "https://openrouter.ai/api/v1",
      "allowRawModel": false,
      "defaultModel": "openai/gpt-4.1-mini",
      "defaults": { "reasoningEffort": "high", "temperature": 0.2, "timeout": 120000 }
    }
  },
  "models": {
    "claude-arb": {
      "provider": "openrouter",
      "model": "anthropic/claude-3.7-sonnet",
      "askAll": true,
      "consensus": true,
      "experts": ["architect"],
      "reasoningEffort": "high",
      "temperature": 0.2,
      "timeout": 60000
    }
  },
  "routing": { "maxFanout": 3 },
  "consensus": { "arbiter": { "model": "claude-arb" }, "blindVote": true }
}
```

**`providers.openrouter` fields** (connection only; these are OpenRouter-specific and
are not globalized):

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `enabled` | boolean | `true` | Whether OpenRouter participates |
| `apiKeyEnv` | string | `OPENROUTER_API_KEY` | Env var holding the API key |
| `apiBase` | string | `https://openrouter.ai/api/v1` | OpenAI-compatible base URL |
| `allowRawModel` | boolean | `false` | Allow raw slugs (not just configured records) |
| `defaultModel` | string | absent | Slug for the bare `/ask-openrouter` call |
| `defaults` | object | `{}` | Per-call defaults: `reasoningEffort`, `temperature`, `timeout` |

**`models` record fields** (the map key is the record id, matching `^[a-z0-9-]+$` and not
the reserved `openrouter-default`):

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `provider` | string | required | Must be `"openrouter"` in v1 (codex/gemini/grok are CLI-managed / singleton built-ins, out of scope) |
| `model` | string | required | Provider model slug (e.g. `openai/gpt-4.1`) |
| `experts` | array or absent | absent = all 7 | `[]` = none / explicit-only; array = subset of the 7 expert keys |
| `askAll` | boolean | `true` | Include this record in `/ask-all` fan-out when eligible |
| `consensus` | boolean | `false` | Include this record in `/consensus` voting |
| `reasoningEffort` | string | from `defaults` | Per-record override (maps to the wire `reasoning_effort`) |
| `timeout` | number (ms) | from `defaults` | Per-record override |
| `temperature` | number | from `defaults` | Per-record override |
| `apiBase` | string | from `providers.openrouter.apiBase` | Per-record override (use for mixing endpoints) |

**On `temperature`:** most deliberation work is analytical - code review, debugging,
security audits, architecture and plan verdicts - where you want focused, repeatable
answers. Leave `temperature` unset and the field is omitted, so the provider default
applies (commonly around `1.0`); set a low value (roughly `0.1`-`0.3`) when you want
that focused, repeatable behavior. Raise it (roughly `0.6`-`0.9`) only for generative
fan-out where spread across models is the point: brainstorming, naming, "give me 20
options". Keep it low for `/consensus` rounds; you want the models reasoning, not
improvising.

### consensus.arbiter

`consensus.arbiter` names who synthesizes the verdict. Two forms:

- A **shorthand string**: `"auto"` (default - pick a healthy voice, preferring an
  OpenRouter one), `"host"` (the host arbitrates; the server runs no arbiter pass), or a
  built-in provider name `"codex"` / `"gemini"` / `"grok"`.
- An **object** `{ "model": "<id>" }` referencing a `models` record. The record can be
  any entry - even one with `askAll: false` and `consensus: false` - which is the
  dedicated-arbiter case (an out-of-panel model that adjudicates without voting). Arbiter
  eligibility is independent of voting-panel membership.

A cross-host recommendation: a dedicated Claude record used only as the arbiter
(`{ "model": "claude-arb" }`) lets a non-Claude host synthesize with a model that is not
one of the voting providers. An unusable arbiter (unknown shorthand, a `{ model }` id that
is not configured, or a disabled provider) soft-degrades to `"auto"` with a warning - it
never hard-fails the config.

### consensus.blindVote

`consensus.blindVote` is an optional boolean (default `false`). When `true`, the arbiter
ALSO answers the original question cold - with no peer opinions - to produce a
`blindVerdict`, fired in parallel with the peer fan-out (no extra round). The blind pass
reduces the arbiter anchoring on the peers' framing.

Constraints and behavior:

- **Concrete / server-arbiter mode only.** It runs only when a real arbiter pass runs
  (`"auto"`, a built-in, or a `{ model }` record). In `"host"` mode the server runs no
  arbiter pass, so there is no blind pass either - `blindVerdict` is `null`.
- **Cost.** It adds one extra arbiter call (parallel, no extra round), which is why it is
  off by default.
- **Failure-isolated.** A thrown blind pass yields `blindVerdict: null` and never fails the
  run. `blindVerdict` is also `null` when `blindVote` is off or no arbiter exists.
- **Validation.** A non-boolean value soft-degrades to `false` with a warning - it never
  hard-fails the config.

Behavior source of truth: `consensus()` in `core/orchestrate.js` and the `blindVote`
validation in `server/openrouter/config.js`.

### consensus.maxRounds

`consensus.maxRounds` is an optional positive integer (default `5`) that caps the
server-side convergence loop used by the `consensus-auto` and `consensus-step` tools.
The loop ends `unresolved` once it hits the cap without converging.

- **Range.** `1`..`50`. A value above `50` is clamped to `50` with a warning; a
  non-integer or non-positive value is dropped (the default `5` applies) with a warning -
  it never hard-fails the config.
- **Scope.** It governs only the multi-round loop tools. The one-shot `consensus` tool is
  a single arbiter pass and is unaffected.
- Validation lives in `resolveConsensus` (`server/openrouter/config.js`); the cap is
  enforced in `core/consensus-loop.js`.

### camelCase config keys, wire mapping

Config keys are camelCase: `reasoningEffort`, `temperature`, `timeout`. The bridge sends
`reasoning_effort` on the wire; the camelCase -> wire mapping happens in one place - the
resolved layer in `server/openrouter/config.js`, which carries `reasoning_effort` on each
resolved record and on `defaults`. `temperature` and `timeout` pass through unchanged.

**Which params apply on which path:** the unified `/ask-all`, `/consensus`, and the
`{ model: <id> }` arbiter path apply a record's per-model `reasoningEffort`, `temperature`,
and `timeout` (forwarded with arg-wins precedence by `pinAlias` in `core/registry.js`). A
record's per-model `apiBase` and the `providers.openrouter.defaults` block apply only on the
standalone `/ask-openrouter` bridge path, because the unified server's OpenRouter provider
fixes `apiBase` / `apiKeyEnv` at construction. That is a pre-existing limitation, not a goal
of the arbiter feature.

### Routing

- **`/ask-all`**: includes all records where `askAll !== false` and the record is eligible
  for the requested expert; capped to `routing.maxFanout` records (default 3).
- **`/consensus`**: includes records where `consensus === true`; NOT subject to `maxFanout`.
  A warning is logged when more than 3 records enter a consensus round (cost).
- **`openrouter-default`** is the reserved id for the bare `mcp__deliberation__openrouter`
  call and `/ask-openrouter` with no record specified. It resolves to `defaultModel`, is the
  single-shot fallback only, and is never included in fan-out or consensus.
- Implementation tasks always route to Codex or Gemini, never to OpenRouter.

### Editor validation (VS Code, no extension)

The config carries a `$schema` key pointing at `config/config.schema.json` (JSON Schema draft
2020-12). VS Code's built-in JSON support reads that key and gives you validation,
autocomplete, and lint with **no third-party extension** - and it works on the user's real
config outside this repo, because the file itself carries `$schema`. The in-repo `.vscode/`
folder additionally wires a `json.schemas` mapping so example configs inside the repo
validate even without the `$schema` line.

### Config validation (partial) and the `openrouter-list` contract

Validation is **per-entry**, not all-or-nothing. A single malformed `models` record
(bad id characters, reserved id, non-`openrouter` provider, missing `model`, unknown
expert, or a bad per-record override) no longer rejects the whole config - the bridge keeps
every valid record and collects the bad ones into `invalidModels`. Only **top-level/schema**
problems hard-fail the whole config: malformed JSON, a non-object root, an unsupported
`version`, or a non-integer/`< 1` `routing.maxFanout`.

`mcp__deliberation__openrouter-list` returns (each delegate keeps the `alias` field, equal
to the record id, so selection and the wire stay stable):

```jsonc
{
  "delegates": [ { "alias", "model", "experts", "askAll", "consensus", "reasoning_effort" } ],
  "defaultModelSet": true,
  "maxFanout": 3,
  "maxFanoutHigh": false,
  "invalidModels": [ { "index": 2, "alias": "qwen3.7-max",
                       "reason": "models id \"qwen3.7-max\" must match [a-z0-9-]+ ...",
                       "suggestedAlias": "qwen3-7-max" } ]
}
```

- On a hard config failure the object instead carries `error: "<message>"` with
  `delegates: []` (and `invalidModels` absent/empty). `/ask-all` and `/consensus` treat
  the `error` form as "OpenRouter set EMPTY".
- `invalidModels[].suggestedAlias` is present only when a safe deterministic repair exists:
  id-format errors are sanitized to `[a-z0-9-]+` (e.g. `qwen3.7-max` -> `qwen3-7-max`), and
  collisions get a free `-N` suffix. Suggestions are collision-checked against every existing
  id and the reserved `openrouter-default`. Entries with no safe fix (missing `model`, unknown
  expert, non-`openrouter` provider, reserved-id clash) have no `suggestedAlias`.
- The bridge never edits `config.json`. The `/ask-all` and `/consensus` commands surface
  `invalidModels` and offer **Fix & proceed** (default - apply each `suggestedAlias` to
  `config.json`, drop the unrepairable, re-list), **Run valid only**, or **Skip all
  OpenRouter**.

### Authentication (optional)

The Authorization header is sent **only** when the key env var resolves to a non-empty
string. Keyless local endpoints (Ollama, vLLM, LM Studio) work without a dummy key.
`openrouter.ai` returns HTTP 401 if the key is absent; local endpoints accept no-auth
requests.

### apiBase override matrix

| Endpoint | apiBase value |
|----------|---------------|
| OpenRouter | `https://openrouter.ai/api/v1` (default) |
| HuggingFace Inference | `https://router.huggingface.co/v1` |
| Ollama (local) | `http://localhost:11434/v1` |
| LM Studio | `http://localhost:1234/v1` |
| vLLM | `http://localhost:8000/v1` |

### File attachment (text-inline only)

OpenRouter accepts `{path}` and `{dir}` entries only. `file_id` and `file_url`
entries are rejected (`-32602`). The `mode` field is coerced to `"inline"` regardless
of what is set - there is no upload path. Content is embedded as text blocks in the
request body.

Per-file cap: `OPENROUTER_INLINE_MAX_BYTES` (default 262144 = 256 KB).
Aggregate cap: `OPENROUTER_INLINE_MAX_TOTAL_BYTES` (default 1048576 = 1 MB).
Exceeding either cap returns a hard error with counts.

### Session model persistence

A model alias is bound at the start of a session via `mcp__deliberation__openrouter`
and is preserved for the life of that `threadId`. `-reply` calls on the same thread
always use the same model.

### Consensus cost model

Each consensus round uses approximately `N models x bundle tokens x rounds` tokens.
When more than 3 models participate, the bridge emits a warning with an estimated
token count. There is no hard spend cap - the warning is informational only.

### MCP tools

| Tool | Purpose |
|------|---------|
| `mcp__deliberation__openrouter` | Start a new advisory session |
| `mcp__deliberation__openrouter-reply` | Continue a session (multi-turn via threadId) |
| `mcp__deliberation__openrouter-list` | List configured model aliases and their eligibility flags |

### Error kinds

| errorKind | Meaning |
|-----------|---------|
| `auth` | API key missing or rejected (HTTP 401/403) |
| `rate-limit` | HTTP 429 from upstream |
| `timeout` | Request exceeded the configured timeout |
| `network` | Connection error or DNS failure |
| `parse` | Response body could not be parsed |
| `upstream` | Non-2xx from the endpoint (other than auth/rate-limit) |
| `config` | Config file missing, invalid JSON, or schema violation |
| `model-not-allowed` | Requested alias is not in the config, or a raw `model` was passed with `allowRawModel:false`, or no alias/model was given and no `defaultModel` is set |
| `unknown-thread` | `-reply` called with a threadId that does not exist |
| `unknown` | Catch-all for unclassified errors |

## Session persistence

An opt-in, single-user local store that records each `/consensus` and `/ask-all`
run so it can be fetched, re-run, and annotated later. Default OFF - nothing is
written to disk unless `sessions.persist` is true. Implemented in `core/sessions.js`
(synchronous, zero-dep); the store directory is resolved by `resolveSessionsDir` in
`core/paths.js`; config is validated by `resolveSessions` in
`server/openrouter/config.js`; the MCP wiring lives in `server/mcp/index.js`.

### Configuration

```json
"sessions": { "persist": false, "maxRecords": 200, "maxAgeDays": 30 }
```

| Key | Type | Default | Meaning |
|-----|------|---------|---------|
| `persist` | boolean | `false` | Save each run and return a `sessionId`. Non-boolean degrades to `false` + warning. |
| `maxRecords` | integer | `200` | Keep at most this many newest records. `-1` = unlimited (never trim by count). `0`/invalid -> default + warning. |
| `maxAgeDays` | integer | `30` | Delete records older than this. `-1` = unlimited (never delete by age). `0`/invalid -> default + warning. |

Validation soft-degrades: a bad value never rejects the config, it falls back to the
default and the reason rides the same `consensusWarnings` channel the bridge already
surfaces.

### Store layout

- One JSON file per session at `<dir>/<id>.json`, where `<dir>` is
  `DELIBERATION_SESSIONS` if set, else `<XDG cache>/deliberation/sessions` (macOS/Linux
  `~/.cache/...`; Windows `%LOCALAPPDATA%\...`).
- Written atomically: the temp file is created with mode `0600` directly (no
  world-readable window), then renamed into place; a failed rename removes the temp.
- No global lock - each file is independent. The only read-modify-write is
  `session-annotate` on one file, documented last-writer-wins (fine for a local
  single-user stdio server).
- Retention runs after every write: delete by age, then trim by count (both honoring
  `-1` = unlimited). Orphaned `<id>.json.tmp.<pid>.<ts>` fragments older than an hour
  are also reaped.

### Record shape (`schemaVersion: 2`)

```
{ id, parentId|null, schemaVersion: 2, createdAt: <ISO>,
  tool: "consensus"|"ask-all"|"consensus-auto", question, expert|null,
  files: [{ path|dir|file_id|file_url, mode? }]|null,   // attachment REFS, never bodies
  opinions: [{ provider, model, text,
               verdict?, criticalIssues? }],            // verdict/criticalIssues on consensus-auto opinions
  blindVerdict|null, verdict|null,
  arbiter: { mode, provider }|null, warnings: [], annotations: [{ note, at }],
  converged?, confidence?, rounds? }                    // consensus-auto loop summary
```

v2 is additive: v1 records (no `verdict`/`criticalIssues`/loop-summary fields) still read
back fine - `readSession` returns the object as-is and callers treat the v2 fields as
optional. The `verdict`/`criticalIssues` and `converged`/`confidence`/`rounds` fields are
populated only for `consensus-auto` runs (the multi-round loop); one-shot `consensus` and
`ask-all` records omit them.

Before writing, `scrubSecrets` redacts common key shapes (OpenAI `sk-`, OpenRouter
`sk-or-`, xAI `xai-`, GitHub `gh[pousr]_`, AWS `AKIA`, Google `AIza`, and `Bearer`
tokens) in the question, opinion/verdict text, each critical-issue description, `warnings`,
annotation notes, and the file `path`/`dir` strings; the question and each opinion/verdict
are capped at ~100 KB, and an opinion `verdict` is whitelisted to the closed enum (anything
else is coerced to `null`) so no free text rides the unscrubbed verdict field. Scrubbing is
best-effort - user transcript text may still carry secrets in unrecognized shapes.

### Tools

Each takes its own input schema (no `prompt`), and reports
`"session persistence is disabled (set sessions.persist)"` when off.

| Tool | Input | Effect |
|------|-------|--------|
| `session-get` | `{ sessionId }` | Return the record, or a not-found message. Read-only. |
| `session-revisit` | `{ sessionId, cwd? }` | Re-run the record's original question (and its file refs) with the CURRENT providers/config, write a CHILD record (`parentId` = original id), return the new `sessionId` + result. Re-run, not snapshot-replay. A `consensus-auto` record re-runs the full multi-round LOOP, not a one-shot pass. |
| `session-annotate` | `{ sessionId, note }` | Append `{ note, at }` to the record's audit trail and rewrite the file. |

When `persist` is on, `consensus`, `ask-all`, and `consensus-auto` also include a top-level
`sessionId` in their result.

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
