# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A Claude Code plugin that provides GPT (via Codex CLI), Gemini 3 (via the Antigravity CLI `agy`), Grok (via the xAI HTTP API), and OpenRouter (config-driven, advisory-only, 400+ models) as specialized expert subagents. Seven domain experts that can advise OR implement: Architect, Plan Reviewer, Scope Analyst, Code Reviewer, Security Analyst, Researcher, and Debugger. (Grok and OpenRouter are advisory-only - they cannot edit files. Grok reads attached files via the xAI Files API; OpenRouter inlines text files only.)

## Development Commands

```bash
# Test plugin locally (loads from working directory)
claude --plugin-dir /path/to/deliberation

# Run setup to test installation flow
/deliberation:setup

# Run uninstall to test removal flow
/deliberation:uninstall
```

No build step, no dependencies. Codex exposes a native MCP server; Gemini, Grok, and OpenRouter use bundled zero-dependency Node bridges (`server/gemini/index.js`, `server/grok/index.js`, `server/openrouter/index.js`). The Gemini bridge wraps the Antigravity CLI (`agy`) in print mode. The OpenRouter bridge calls any OpenAI-compatible `/chat/completions` endpoint.

## Architecture

### Orchestration Flow

Claude acts as orchestrator - delegates to specialized experts based on task type. Supports both **single-shot** (independent calls) and **multi-turn** (context preserved via `threadId`).

```
User Request → Claude Code → [Match trigger → Select expert & provider]
                                    ↓
              ┌─────────────────────┼─────────────────────┐
              ↓                     ↓                     ↓
         Architect            Code Reviewer        Security Analyst
              ↓                     ↓                     ↓
    [Advisory (read-only) OR Implementation (workspace-write)]
              ↓                     ↓                     ↓
    Claude synthesizes response ←──┴──────────────────────┘
```

### How Delegation Works

1. **Match trigger** - Check `rules/triggers.md` for semantic patterns
2. **Read expert prompt** - Load from `prompts/[expert].md`
3. **Build 7-section prompt** - Use format from `rules/delegation-format.md`
4. **Call provider tool** - `mcp__deliberation-codex__codex`, `mcp__deliberation-gemini__gemini`, `mcp__deliberation-grok__grok`, or `mcp__deliberation-openrouter__openrouter`
5. **Synthesize response** - Never show raw output; interpret and verify

### The 7-Section Delegation Format

Every delegation prompt must include: TASK, EXPECTED OUTCOME, CONTEXT, CONSTRAINTS, MUST DO, MUST NOT DO, OUTPUT FORMAT. See `rules/delegation-format.md` for templates.

### Retry Handling

Retries use multi-turn (`*-reply` with `threadId`) so the expert remembers previous attempts:
- Attempt 1 fails → retry with error details (context preserved)
- Up to 3 attempts → then escalate to user
- Fallback: new call with full history if multi-turn unavailable

### Component Relationships

| Component | Purpose | Notes |
|-----------|---------|-------|
| `rules/*.md` | When/how to delegate | Installed to `~/.claude/rules/deliberation/` |
| `prompts/*.md` | Expert personalities | Injected via `developer-instructions` |
| `commands/*.md` | Slash commands | `/setup`, `/uninstall` |
| `config/providers.json` | Provider metadata | Not used at runtime |
| `~/.claude/deliberation/config.json` | OpenRouter model config | Live SSOT; stat-gated hot-reload |

> Expert prompts adapted from [oh-my-opencode](https://github.com/code-yeongyu/oh-my-opencode)

## Seven GPT Experts

| Expert | Prompt | Specialty | Triggers |
|--------|--------|-----------|----------|
| **Architect** | `prompts/architect.md` | System design, tradeoffs | "how should I structure", "tradeoffs of", design questions |
| **Plan Reviewer** | `prompts/plan-reviewer.md` | Plan validation | "review this plan", before significant work |
| **Scope Analyst** | `prompts/scope-analyst.md` | Requirements analysis | "clarify the scope", vague requirements |
| **Code Reviewer** | `prompts/code-reviewer.md` | Code quality, bugs | "review this code", "find issues" |
| **Security Analyst** | `prompts/security-analyst.md` | Vulnerabilities | "is this secure", "harden this" |
| **Researcher** | `prompts/researcher.md` | External libraries, docs, best practices | "how do I use X", "find examples of Y" |
| **Debugger** | `prompts/debugger.md` | Root-cause analysis, minimal fixes | "why does this crash", "debug this failing test" |

Every expert can operate in **advisory** (`sandbox: read-only`) or **implementation** (`sandbox: workspace-write`) mode based on the task. OpenRouter models are always advisory - per-model expert eligibility is controlled by the `experts` field in `~/.claude/deliberation/config.json`.

## Grok file access

Grok reads attached files via `files[]` and resolves them under `roots[]` (top-level array of absolute directories) or `cwd`. `path` and `dir` entries take an optional `mode: "auto" | "inline" | "upload"` - inline embeds the file as `input_text` so Grok reads it line-by-line (best for source code); upload routes through the xAI Files API and is SHA-256 dedup-cached locally. `file_id` / `file_url` entries pass through unchanged and do not accept `mode`. Directory expansion via `{dir}` entries. See **[TECHNICAL.md: Grok files and cleanup](TECHNICAL.md#grok-files-and-cleanup)** for parameters, the inline-vs-upload tradeoff, cross-repo usage, cache layout, and the `gc` cleanup subcommand.

## Key Design Decisions

1. **Native & Bridge MCP** - Codex has a native `mcp-server` command. Gemini requires a bundled bridge (`server/gemini/index.js`) that wraps the Antigravity CLI (`agy`) in print mode. Grok has no MCP or CLI server mode, so a bundled bridge (`server/grok/index.js`) wraps the xAI **Responses API** (`/v1/responses`) directly - advisory-only (no file editing), but it can READ attached files (`files:[{path|file_id|file_url|dir}]`, optional `roots[]`, per-entry `mode` for upload-vs-inline delivery); uploaded files are SHA-256 dedup-cached locally, auto-expire (7-day default, `GROK_FILE_TTL_SECONDS`), and are managed with `/grok-files` (`server/grok/files-admin.js`: `list`/`prune`/`gc`). Details in [TECHNICAL.md § Grok files and cleanup](TECHNICAL.md#grok-files-and-cleanup). OpenRouter uses a bundled bridge (`server/openrouter/index.js`) that calls any OpenAI-compatible `POST {apiBase}/chat/completions` endpoint - advisory-only, text-inline file attachment only (`{path}`/`{dir}`; no upload path), config-driven via `~/.claude/deliberation/config.json`. Details in [TECHNICAL.md § OpenRouter bridge](TECHNICAL.md#openrouter-bridge).
2. **Single-shot + multi-turn** - Single-shot for advisory (full context per call), multi-turn via `threadId` for chained implementation and retries
3. **Dual mode** - Any expert can advise or implement based on task
4. **Synthesize, don't passthrough** - Claude interprets expert output, applies judgment
5. **Proactive triggers** - Claude checks for delegation triggers on every message

## Commit Conventions & Releases

Releases are automated from Conventional Commits on `master`. Do not hand-edit version numbers.

| Commit prefix | Version bump |
|---------------|--------------|
| `feat!:` or `BREAKING CHANGE:` | Major |
| `feat:` | Minor |
| `fix:` | Patch |
| Other (`chore`, `docs`, `refactor`, ...) | Patch |

`version.json` is the single source of truth. On merge to `master`, `automated-release.yml`
bumps it, regenerates `CHANGELOG.md`, and runs `.github/release/pre-commit.js` to sync the
version in `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, and
`package.json`. After the release PR merges, `tag-release.yml` tags `vX.Y.Z`, publishes the
GitHub Release, and nudges the `antonbabenko/agent-plugins` marketplace to re-pin. The
`validate` check fails if any of those version fields drift from `version.json`. See
CONTRIBUTING.md for the full flow.

## When NOT to Delegate

- Simple syntax questions (answer directly)
- First attempt at any fix (try yourself first)
- Trivial file operations
- Research/documentation tasks
