# Model Selection Guidelines

GPT (Codex), Gemini, Grok (xAI), and OpenRouter experts serve as specialized consultants for complex problems. Grok and OpenRouter are advisory-only.

## Provider Selection

Before delegating, check which MCP tools are available in the current environment:

1. **If multiple are available**:
   - Use **Gemini** (Gemini 3 via the Antigravity CLI, `agy`) for tasks requiring large context or multimodal analysis. Gemini-via-agy is **advisory-effective**: agy print-mode writes are sandboxed to a scratch dir, so it can read context to advise but cannot mutate the real workspace. Prefer it for analysis/review over file-editing (`workspace-write` is best-effort).
   - Use **GPT (Codex)** when the user explicitly asks for "GPT" or "Codex".
   - Use **Grok (xAI)** when the user explicitly asks for "Grok". Grok is advisory-only (it cannot edit files), so never route file-editing / implementation tasks to it. It reads attached files (PDF/code/docs) via `files:[{path|file_id|file_url|dir}]` on the `mcp__grok__grok` call. Entries resolve under the top-level `roots: string[]` (first-root-wins for relative paths; absolute paths must lie under one of the roots) or `cwd` when `roots` is omitted. `{dir}` entries expand recursively via a bundled glob walker (`include`/`exclude`/`maxFiles`/`maxBytes`). Uploads are SHA-256 dedup-cached locally so repeated calls with the same content skip the upload step. Full reference: [TECHNICAL.md § Grok files and cleanup](../TECHNICAL.md#grok-files-and-cleanup). **Context parity vs GPT/Gemini:** GPT (Codex) and Gemini (agy) walk the filesystem at `cwd` under `sandbox: "read-only"` - they can glob and read any file in the repo. Grok sees ONLY what is in the `files` array. For any open-ended, repo-wide question routed to Grok (or to a parallel pattern like `/ask-all` / `/consensus`), attach an orientation bundle (2-6 files: project `CLAUDE.md` / `AGENTS.md`, top-level entrypoints, modules the question targets, total <= 48 MB) - or pass a `{dir}` entry with a tight `include` pattern - so Grok answers from real source instead of the textual description alone. Skipping this is the dominant reason Grok loses argument rounds against GPT/Gemini in repo-audit prompts.
   - Use **OpenRouter** when the user explicitly asks for an OpenRouter alias, or when `/ask-all` / `/consensus` fan-out is configured. OpenRouter is **advisory-only** - never route implementation or file-editing tasks to it. Alias selection, expert eligibility, and fan-out participation are all declared in `~/.claude/claude-delegator/config.json` (hot-reload; see [TECHNICAL.md - OpenRouter bridge](../TECHNICAL.md#openrouter-bridge)). For `/ask-all`, models with `askAll !== false` are included up to `maxFanout` (default 3). For `/consensus`, models with `consensus === true` are included without a fanout cap (warn if >3). `openrouter-default` is the single-shot fallback for bare `/ask-openrouter` calls and is never included in fan-out. Parameter precedence: per-model overrides > `openrouter.defaults` > bridge built-ins.
   - Default to **Gemini** for general reasoning.
   - For **Researcher** (external library/docs research): prefer GPT or Gemini (tool-capable); route to Grok or OpenRouter only when the user names them, since both answer from knowledge and mark claims `[unverified]`.
2. **If only one is available**: Use the available provider regardless of the task type (but Grok and OpenRouter cannot implement file changes - only advise).
3. **If none are available**: Do not delegate; inform the user that they need to run `/claude-delegator:setup`.

## Expert Directory

| Expert | Specialty | Best For |
|--------|-----------|----------|
| **Architect** | System design | Architecture, tradeoffs, complex debugging |
| **Plan Reviewer** | Plan validation | Reviewing plans before execution |
| **Scope Analyst** | Requirements analysis | Catching ambiguities, pre-planning |
| **Code Reviewer** | Code quality | Code review, finding bugs |
| **Security Analyst** | Security | Vulnerabilities, threat modeling, hardening |
| **Researcher** | External libraries and docs | Library usage, best practices, third-party source |
| **Debugger** | Root-cause debugging | Ranked hypotheses, minimal fixes |

## Operating Modes

Every expert can operate in two modes:

| Mode | Sandbox | Approval | Use When |
|------|---------|----------|----------|
| **Advisory** | `read-only` | `on-request` | Analysis, recommendations, reviews |
| **Implementation** | `workspace-write` | `on-failure` | Making changes, fixing issues |

**Key principle**: The mode is determined by the task, not the expert. An Architect can implement architectural changes. A Security Analyst can fix vulnerabilities.

## Expert Details

### Architect

**Specialty**: System design, technical strategy, complex decision-making

**When to use**:
- System design decisions
- Database schema design
- API architecture
- Multi-service interactions
- After 2+ failed fix attempts
- Tradeoff analysis

**Philosophy**: Pragmatic minimalism - simplest solution that works.

**Output format**:
- Advisory: Bottom line, action plan, effort estimate
- Implementation: Summary, files modified, verification

### Plan Reviewer

**Specialty**: Plan validation, catching gaps and ambiguities

**When to use**:
- Before starting significant work
- After creating a work plan
- Before delegating to other agents

**Philosophy**: Ruthlessly critical - finds every gap before work begins.

**Output format**: APPROVE/REJECT with justification and criteria assessment

### Scope Analyst

**Specialty**: Pre-planning analysis, requirements clarification

**When to use**:
- Before planning unfamiliar work
- When requirements feel vague
- When multiple interpretations exist
- Before irreversible decisions

**Philosophy**: Surface problems before they derail work.

**Output format**: Intent classification, findings, questions, risks, recommendation

### Code Reviewer

**Specialty**: Code quality, bugs, maintainability

**When to use**:
- Before merging significant changes
- After implementing features (self-review)
- For security-sensitive changes

**Philosophy**: Review like you'll maintain it at 2 AM during an incident.

**Output format**:
- Advisory: Issues list with APPROVE/REQUEST CHANGES/REJECT
- Implementation: Issues fixed, files modified, verification

### Security Analyst

**Specialty**: Vulnerabilities, threat modeling, security hardening

**When to use**:
- Authentication/authorization changes
- Handling sensitive data
- New API endpoints
- Third-party integrations
- Periodic security audits

**Philosophy**: Attacker's mindset - find vulnerabilities before they do.

**Output format**:
- Advisory: Threat summary, vulnerabilities, risk rating
- Implementation: Vulnerabilities fixed, files modified, verification

### Researcher

**Specialty**: External libraries, frameworks, APIs, and open-source code

**When to use**:
- "How do I use [library]?" or "best practice for [framework feature]?"
- "Why does [dependency] behave this way?"
- Finding real-world usage examples
- Working with unfamiliar packages

**Philosophy**: Evidence over memory - cite what you can verify, mark the rest `[unverified]`, never fabricate links.

**Provider routing**: prefer GPT or Gemini (tool-capable). Grok is advisory-only with no retrieval tools; route to it only when named or with attached files.

**Output format**:
- Advisory: Bottom line, evidence (cited or `[unverified]`), caveats
- Implementation: Written findings document

### Debugger

**Specialty**: Root-cause analysis of reported defects

**When to use**:
- A reported runtime error, crash, failing test, or wrong output
- After 2+ failed fix attempts (fresh ranked hypotheses)

**Philosophy**: Evidence over hunches - rank hypotheses, propose the minimal fix, and say so honestly when the evidence shows no bug.

**Provider routing**: prefer GPT/Codex first, Gemini second. Grok only for an alternate hypothesis (advisory-only).

**Output format**:
- Advisory: ranked hypotheses with minimal fix + regression note, or a no-bug-found result with questions
- Implementation: the minimal fix applied + verification

## Codex Parameters Reference

### `mcp__codex__codex` (Start Session)

| Parameter | Values | Notes |
|-----------|--------|-------|
| `prompt` | string | **Required.** The delegation prompt (use 7-section format) |
| `developer-instructions` | string | Expert prompt injection (from `prompts/*.md`) |
| `sandbox` | `read-only`, `workspace-write`, `danger-full-access` | Controls file access. Default from `~/.codex/config.toml` |
| `approval-policy` | `untrusted`, `on-failure`, `on-request`, `never` | Controls shell command approval. Default from config |
| `model` | e.g. `gpt-5.5` | Override the model for this call only |
| `config` | key-value object | Override `config.toml` settings per-call |
| `cwd` | path | Working directory for the task |
| `base-instructions` | string | Override default system instructions |
| `compact-prompt` | string | Prompt used when compacting conversation |
| `profile` | string | Configuration profile from config.toml |

**Default model:** Codex is registered without a model flag, so the default comes
from the `model` key in `~/.codex/config.toml` (or a `-c model=<id>` override on
the MCP registration). The `model` parameter above overrides it for a single call.

### `mcp__codex__codex-reply` (Continue Session)

| Parameter | Values | Notes |
|-----------|--------|-------|
| `threadId` | string | **Required.** Thread ID from previous `codex` call |
| `prompt` | string | **Required.** Follow-up instruction |

## Gemini Parameters Reference

### `mcp__gemini__gemini` (Start Session)

| Parameter | Values | Notes |
|-----------|--------|-------|
| `prompt` | string | **Required.** The delegation prompt (use 7-section format) |
| `developer-instructions` | string | Expert prompt injection (from `prompts/*.md`) |
| `sandbox` | `read-only`, `workspace-write` | Controls file access. `read-only` is advisory; `workspace-write` is best-effort (agy print-mode writes are sandboxed to a scratch dir). |
| `model` | e.g. `auto-gemini-3`, `gemini-3-pro-preview` | Advisory only. agy reads the model from `~/.gemini/settings.json` (`model.name`) and has no per-call flag; the bridge defaults to `auto-gemini-3`. |
| `cwd` | path | Working directory for the task |
| `include-directories` | string[] | Extra dirs to include alongside `cwd`. Maps to repeated `--add-dir`. |
| `timeout` | number (ms) | Soft timeout. 1..600000. Default 300000. On expiry the bridge keeps agy alive and drains buffered stdout (stdout-drain). |
| `recovery-grace` | number (ms) | Extra drain budget after the soft timeout. 0..600000. Default 120000. 0 disables drain. |

### `mcp__gemini__gemini-reply` (Continue Session)

| Parameter | Values | Notes |
|-----------|--------|-------|
| `threadId` | string | **Required.** Thread ID from previous `gemini` call |
| `prompt` | string | **Required.** Follow-up instruction |
| `sandbox` | `read-only`, `workspace-write` | Controls file access. `workspace-write` is best-effort (agy print-mode writes are scratch-sandboxed). |
| `cwd` | path | Working directory for the task |
| `include-directories` | string[] | Extra dirs to include alongside `cwd`. Maps to repeated `--add-dir`. |
| `timeout` | number (ms) | Soft timeout. 1..600000. Default 300000. On expiry the bridge keeps agy alive and drains buffered stdout (stdout-drain). |
| `recovery-grace` | number (ms) | Extra drain budget after the soft timeout. 0..600000. Default 120000. 0 disables drain. |

## Grok Parameters Reference

### `mcp__grok__grok` (Start Session)

| Parameter | Values | Notes |
|-----------|--------|-------|
| `prompt` | string | **Required.** The delegation prompt (use 7-section format) |
| `developer-instructions` | string | Expert prompt injection (from `prompts/*.md`) |
| `files` | array | Attach local files for Grok to read. Each entry is EXACTLY ONE of `{ path }`, `{ file_id }`, `{ file_url }`, or `{ dir, include?, exclude?, maxFiles?, maxBytes? }`. Path/dir entries support optional `mode: "auto" \| "inline" \| "upload"` (default `"upload"`): inline embeds content as `input_text` so Grok reads line-by-line; auto picks inline for text ≤ `GROK_INLINE_MAX_BYTES` (default 256 KB), else upload. Uploaded files are SHA-256 dedup-cached locally. See `TECHNICAL.md` § "Grok files and cleanup". |
| `roots` | string[] | Optional absolute directory roots used to resolve `files[].path` and `files[].dir`. First root containing the entry wins. Falls back to `[cwd]` when omitted. Use for cross-repo attachments. |
| `cwd` | path | Base directory used when `roots` is omitted. Set it to the repo root that contains the files. Defaults to the server cwd. |
| `model` | e.g. `grok-4.3` | Defaults to `GROK_DEFAULT_MODEL` or `grok-4.3`. |
| `reasoning_effort` | `low` \| `medium` \| `high` \| `none` | Defaults to `GROK_REASONING_EFFORT` or `high`. |

### `mcp__grok__grok-reply` (Continue Session)

| Parameter | Values | Notes |
|-----------|--------|-------|
| `threadId` | string | **Required.** Thread ID from a previous `grok` call (in-memory; lost on MCP restart) |
| `prompt` | string | **Required.** Follow-up instruction |
| `files` | array | Same shape as `grok.files` (path/file_id/file_url/dir). Attach new files for the follow-up turn. |
| `roots` | string[] | Same as `grok.roots`. |
| `cwd` | path | Base directory used when `roots` is omitted. |

### Response Format (both providers)

Success:

| Field | Type | Description |
|-------|------|-------------|
| `threadId` | string | Session ID for multi-turn follow-ups |
| `content` | string | The expert's text response |
| `recovered` | boolean | Present and `true` when the answer was recovered from disk after a soft timeout (drain). Normal success - no special handling needed. |

Error (Gemini bridge only - bridge sets `isError: true` and adds these fields):

| Field | Type | Description |
|-------|------|-------------|
| `isError` | boolean | `true` on bridge-side failure. |
| `errorKind` | `timeout` \| `parse` \| `missing-cli` \| `upstream-abort` \| `unknown` | Machine-readable category. |
| `retryable` | boolean | `true` means the orchestrator may retry; see `orchestration.md`. |

## OpenRouter Parameters Reference

### `mcp__openrouter__openrouter` (Start Session)

| Parameter | Values | Notes |
|-----------|--------|-------|
| `prompt` | string | **Required.** The delegation prompt (use 7-section format) |
| `developer-instructions` | string | Expert prompt injection (from `prompts/*.md`) |
| `alias` | string | Model alias from config. Omit to use `defaultModel` (openrouter-default). |
| `files` | array | `{path}` or `{dir}` only. `file_id`/`file_url` are rejected. Mode coerced to inline. Per-file 256 KB cap; aggregate 1 MB cap. |
| `cwd` | path | Working directory for resolving file paths |

### `mcp__openrouter__openrouter-reply` (Continue Session)

| Parameter | Values | Notes |
|-----------|--------|-------|
| `threadId` | string | **Required.** Thread ID from previous `openrouter` call |
| `prompt` | string | **Required.** Follow-up instruction |

### `mcp__openrouter__openrouter-list` (List Models)

| Parameter | Values | Notes |
|-----------|--------|-------|
| `expert` | string | Optional. Filter by expert key to see eligible aliases only |

Returns configured model aliases with their `askAll`, `consensus`, and `experts` fields.

## When NOT to Delegate

- Simple questions you can answer
- First attempt at any fix
- Trivial decisions
- Research tasks (use other tools)
- When user just wants quick info
- Implementation or file-editing tasks (route to Codex or Gemini, not OpenRouter/Grok)
