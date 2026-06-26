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

### Repository layout

- **`core/`** - host-neutral, zero runtime deps, strict-typed. Provider interface +
  `toErrorResult` + the opinion schema/envelope (`types.js` / `provider.js`): `OPINION_SCHEMA`
  (`recommendation` + `confidence` enum + optional `dissent_points`/`assumptions`/`tradeoffs`
  `string[]`), `parseOpinion(text) -> OpinionEnvelope` (best-effort, never throws; `structured` =
  parse provenance), advisory `validateOpinion` (`{valid, wellFormed, warnings}`), `OPINION_INSTRUCTIONS`,
  and `parseReview(text) -> {verdict, criticalIssues}` (best-effort, never-throws: fenced-code-skipped
  verdict ladder - `VERDICT:` sentinel / same-line keyword / `Verdict` heading-split / bare token - plus
  the closed 6-category taxonomy with next-line continuation-join) used by the convergence loop. `registry.js` (`selectForAskAll` /
  `selectForConsensus`); `orchestrate.js` (`askAll` / `askOne` / `consensus` / `runToConvergence` -
  the non-Claude server-side loop driver); `consensus-loop.js` (the PURE convergence state machine -
  the SSOT for round counting, the convergence rule, the configurable max-rounds cap, history, and the
  confidence label); `loop-store.js` (ephemeral sliding-TTL + LRU `Map` holding `LoopState` across the
  stateless `consensus-step` calls; independent of `sessions.persist`); `providers/*.js`
  adapters (`codex.js` spawns the Codex CLI; `antigravity.js` / `grok.js` /
  `openai-compatible.js` wrap their bridge via an injectable `opts.bridge`); `paths.js`
  (config + cache path resolver, `DELIBERATION_CONFIG` override).
- **`server/mcp/`** - stdio JSON-RPC MCP server over `core`. Published as
  `@antonbabenko/deliberation-mcp`: an esbuild `prepack` step bundles `core` + the three bridges
  into a self-contained `dist/index.js` (build-time devDep only; `dist/` gitignored). `server.json`
  at the repo root is the Official MCP Registry manifest.
- **`server/{gemini,grok,openrouter}/`** - the provider bridges (gemini wraps the `agy` CLI;
  grok = xAI HTTP; openrouter = any OpenAI-compatible HTTP) plus openrouter `config.js`
  (`validateConfig` / `makeConfigReader`, the config SSOT). Registered (with the unified
  `server/mcp` server) inline in `.claude-plugin/plugin.json` under the `mcpServers` key
  (`deliberation-*` / `deliberation`) - this inline block is the SOLE runtime MCP registration.
  Claude Code reads MCP servers from a plugin's root `.mcp.json` OR inline in `plugin.json`; the
  inline form is used so the manifest is NOT also auto-loaded as a project-scope `.mcp.json` when
  working inside this repo (which would duplicate every server with an unresolved
  `${CLAUDE_PLUGIN_ROOT}`). The args use `${CLAUDE_PLUGIN_ROOT}`, which Claude Code resolves to the
  installed version on every load, so updating is just `/plugin marketplace update antonbabenko` + `/reload-plugins`. `/deliberation:setup` seeds config and installs rules; it does not register MCP servers.
- **Typecheck gate** - `tsconfig.json` strict `checkJs` over `core/**` + `server/mcp/**/*.js`
  (excludes `server/mcp/dist`). `npm run check` = `typecheck` + `node --test test/*.test.js`,
  enforced in CI by `.github/workflows/validate.yml`.

### Consensus engine (single source of truth)

The multi-round convergence loop lives in `core/consensus-loop.js` as a pure state machine
(`init -> await_blind -> await_peers -> await_adjudication -> converged|await_revision -> ...`),
shared by two drivers so there is ONE rules layer, not a Claude copy and a non-Claude copy:

- **`consensus`** (MCP tool) - runs the whole loop server-side in one call with a CONCRETE
  provider arbiter (`core/orchestrate.js runToConvergence`). `maxRounds` overrides the config cap;
  `synthesizeAlways:true` runs a SINGLE arbiter synthesis pass instead of the loop (free-text
  `synthesis`, for open questions) - one unified tool, one return envelope (split `verdict`/`synthesis`,
  loop-only fields nullable). For non-Claude hosts that want the loop without driving it.
  Per round, the arbiter's adjudication and revision calls run CONCURRENTLY when a peer
  dissents (which guarantees the round cannot converge, so the revision is always used);
  on an all-approve round only adjudication runs. Same external-call count as a serial loop
  in every outcome, one serial arbiter leg saved per dissent round.
- **`consensus-step`** (MCP tool) - the host model (Claude) is the arbiter and drives ONE action per
  call (`init / record_blind / dispatch_peers / submit_adjudication / submit_revision`); `LoopState`
  is held server-side in the ephemeral `loop-store` by `sessionId`. The live `/consensus` slash command
  (`commands/consensus.md`) is a THIN DRIVER over this tool - the loop mechanics are in the engine, not
  the prose. This is the transcript-visible host-arbiter path; the `consensus` tool is the
  provider-arbiter path.

The cap is `consensus.maxRounds` (config, default 5, clamped to 50; a per-call `maxRounds` overrides it). A wall-time budget `consensus.maxWallMs` (default 1 200 000 ms, 20 min) stops the provider-arbiter `consensus` loop before the next round when the budget is spent, returning `stopReason: "budget-exhausted"`; the host-driven `consensus-step` path is not affected. The Codex provider is no longer unbounded: `core/providers/codex.js` caps each `codex exec` call to `CODEX_DEFAULT_TIMEOUT_MS` (600 000 ms). `callProvider` retries once on a `network` error only (pre-response transport failures); it does not retry on timeout or application errors.
The `consensus` tool AND the host-driven `consensus-step` loop persist a session record on a
terminal transition - converged or unresolved (when `sessions.persist` is on, with the mode flag).
`consensus-step` uses an atomic `loopStore.take()` before the write so a terminal transition writes
at most one record, lock-free; the record's `question` is the ORIGINAL prompt, not the final
revision. `session-revisit` replays the recorded mode (loop or synthesize), not a one-shot pass.

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
| `commands/*.md` | Slash commands | `/setup`, `/uninstall`, `/help`, `/doctor`, `/analyze` |
| `config/providers.json` | Provider metadata | Not used at runtime |
| `config/config.schema.json` | JSON Schema (in `config/`) | Validates `config.json` in editors (VS Code built-in JSON support, no extension); `.vscode/` wires it for in-repo example configs |
| `~/.config/deliberation/config.json` | Unified user config | Live SSOT; stat-gated hot-reload. Sections: `providers` (connection), `models` (named records map keyed by id), `routing` (fan-out), `consensus` (`arbiter` + `blindVote` + `maxRounds`: the loop cap, default 5, clamped to 50; `maxWallMs`: the provider-arbiter wall-time budget, default 1200000 ms), `sessions` (opt-in run persistence: `persist`/`maxRecords`/`maxAgeDays`, default off; single `schemaVersion:1` stamp), `debug` (opt-in debug log: `enabled`/`path`, default off - see Observability), `orientation` (opt-in auto-attach of a repo bundle to file-blind providers: `enabled`/`maxFiles`, default off - see Key Design Decisions #8). Carries a `$schema` key for editor validation. Canonical XDG path (Windows: `%APPDATA%\deliberation\config.json`); override with `DELIBERATION_CONFIG` |

> Expert prompts adapted from [oh-my-opencode](https://github.com/code-yeongyu/oh-my-opencode)

## AGENTS.md vs CLAUDE.md

Two host-facing docs, read by different agents:

- **CLAUDE.md** (this file) - read natively by Claude Code. Holds the plugin-dev,
  architecture, and release content above.
- **AGENTS.md** - read by other hosts (Cursor, Codex, Kiro, and any agent that
  picks up an `AGENTS.md`). It is the host-neutral tool guide: what deliberation
  is, the MCP tool surface, and when to delegate.

AGENTS.md is intentionally standalone - it is NOT an `@CLAUDE.md` include. The
plugin-dev and release content here is internal to this repo and would mislead a
non-Claude host. Keep AGENTS.md self-contained so a future edit does not re-merge
CLAUDE.md into it. Per-host rule snippets live in `examples/`.

## Documentation upkeep (MANDATORY on feature completion)

**A feature or behavior change is NOT done until its docs are updated in the SAME
PR.** Code without doc updates is incomplete - do not open the PR, and do not
claim completion, until every surface below that the change touches is current.

When you add/change a tool, config key, flag, default, persisted shape, or any
user-visible behavior, sweep and update ALL of these that apply:

- **`README.md`** - feature list + the config-section summaries.
- **`TECHNICAL.md`** - the deep reference: config tables, record/shape blocks,
  threat-model notes, and the relevant `##` section.
- **`SETUP.md`** - the user-facing config walkthrough + example blocks.
- **`CLAUDE.md`** (this file) - Architecture, Key Design Decisions, the consensus
  engine notes, and any tool/flag description.
- **`AGENTS.md`** - the host-neutral tool/behavior surface (see generation rule
  below).
- **`config/config.schema.json`** AND **`config/config.default.json`** - every
  new config key needs the schema property (with a description that states any
  threat model) AND a default entry. The `validate` CI check fails on drift.
- Command/skill prose under `commands/` and `plugins/.../skills/` when the
  behavior they describe changed.

**Generated artifacts - never hand-edit.** `AGENTS.md` (plus `prompts/`, `rules/`,
`examples/`) is the SOURCE. `POWER.md`, `plugins/deliberation/skills/.../SKILL.md`,
and the per-host files are GENERATED by `scripts/sync-hosts.js`. Edit the source,
then run `node scripts/sync-hosts.js` to regenerate. The `host-artifacts` test
fails if they drift, so regenerate BEFORE committing. (Each generated file also
carries a `GENERATED by scripts/sync-hosts.js` banner - if you see it, edit the
source instead.)

**Do NOT hand-edit** `CHANGELOG.md` or `version.json` - they are owned by the
release automation (see Commit Conventions & Releases).

Verification before you call it done: `npm run check` passes (this runs the
`host-artifacts` + `validate` drift guards), and a `git grep` for the old
behavior/flag name turns up no stale references in docs.

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

Every expert can operate in **advisory** (`sandbox: read-only`) or **implementation** (`sandbox: workspace-write`) mode based on the task. OpenRouter models are always advisory - per-model expert eligibility is controlled by the `experts` field in `~/.config/deliberation/config.json` (Windows: `%APPDATA%\deliberation\config.json`; override with `DELIBERATION_CONFIG`).

Implementation today reaches end users through the per-provider bridges (the native `codex mcp-server` and the standalone gemini bridge's `workspace-write` opt-in). The unified `deliberation` server's `core` providers now also carry a **gated** implement capability (see Key Design Decision #3), but it is not yet exposed through a unified-server tool - that surface lands with the MCP consolidation.

## Grok file access

Grok reads attached files via `files[]` and resolves them under `roots[]` (top-level array of absolute directories) or `cwd`. `path` and `dir` entries take an optional `mode: "auto" | "inline" | "upload"` - inline embeds the file as `input_text` so Grok reads it line-by-line (best for source code); upload routes through the xAI Files API and is SHA-256 dedup-cached locally. `file_id` / `file_url` entries pass through unchanged and do not accept `mode`. Directory expansion via `{dir}` entries. See **[TECHNICAL.md: Grok files and cleanup](TECHNICAL.md#grok-files-and-cleanup)** for parameters, the inline-vs-upload tradeoff, cross-repo usage, cache layout, and the `gc` cleanup subcommand.

When `orientation.enabled` is true, the server auto-attaches a small bundle of high-signal repo files (CLAUDE.md, AGENTS.md, README.md, entrypoints - up to `maxFiles`, default 6) to Grok and OpenRouter calls that carry no files of their own, giving them the same repo grounding that Codex/Gemini get by walking the filesystem. Default OFF. See Key Design Decisions #8 and the Orientation auto-attach section in TECHNICAL.md.

## Key Design Decisions

1. **Native & Bridge MCP** - Codex has a native `mcp-server` command. Gemini requires a bundled bridge (`server/gemini/index.js`) that wraps the Antigravity CLI (`agy`) in print mode. Grok has no MCP or CLI server mode, so a bundled bridge (`server/grok/index.js`) wraps the xAI **Responses API** (`/v1/responses`) directly - advisory-only (no file editing), but it can READ attached files (`files:[{path|file_id|file_url|dir}]`, optional `roots[]`, per-entry `mode` for upload-vs-inline delivery); uploaded files are SHA-256 dedup-cached locally, auto-expire (7-day default, `GROK_FILE_TTL_SECONDS`), and are managed with `/grok-files` (`server/grok/files-admin.js`: `list`/`prune`/`gc`). Details in [TECHNICAL.md § Grok files and cleanup](TECHNICAL.md#grok-files-and-cleanup). OpenRouter uses a bundled bridge (`server/openrouter/index.js`) that calls any OpenAI-compatible `POST {apiBase}/chat/completions` endpoint - advisory-only, text-inline file attachment only (`{path}`/`{dir}`; no upload path), config-driven via `~/.config/deliberation/config.json` (Windows: `%APPDATA%\deliberation\config.json`; override with `DELIBERATION_CONFIG`). Details in [TECHNICAL.md § OpenRouter bridge](TECHNICAL.md#openrouter-bridge).
2. **Single-shot + multi-turn** - Single-shot for advisory (full context per call), multi-turn via `threadId` for chained implementation and retries
3. **Dual mode** - Any expert can advise or implement based on task. In `core`, implementation is **two-lock gated**: a write happens only when the provider was constructed with `allowImplement:true` (construction lock, in `core/providers/codex.js` + `antigravity.js`) AND the request carries `mode:"implement"` (request lock, `DelegationRequest.mode`, a closed `"advisory"|"implement"` enum defaulting to advisory). A stray or injected `mode` alone never writes; the OS sandbox string (`workspace-write`) stays provider-internal so callers cannot smuggle argv. `capabilities.canImplement` reflects the construction lock, so discovery is honest per process. Gemini's credential env-scrub (`*_KEY`/`*_TOKEN`/`GIT_ASKPASS`/`SSH_AUTH_SOCK`) runs in **both** read-only and write mode - a write run edits the worktree but never receives the operator's keys. The construction lock is left OFF in the live composition root today, so the running server stays read-only; the unified-server `implement` tool + cache-bypass + forced audit record are part of the MCP consolidation. Grok/OpenRouter remain advisory-only (`canImplement:false`). See [TECHNICAL.md § Implementation mode](TECHNICAL.md#implementation-mode-core-capability).
4. **Synthesize, don't passthrough** - Claude interprets expert output, applies judgment
5. **Proactive triggers** - Claude checks for delegation triggers on every message
6. **Opt-in session store** - `consensus`/`consensus-step`/`ask-all` runs persist only when `sessions.persist` is on (default off); per-file JSON at `<XDG cache>/deliberation/sessions/` (override `DELIBERATION_SESSIONS`), secrets scrubbed, retention by count + age (`-1` = unlimited). Single `schemaVersion:1` (no dual-version support; loop runs carry per-opinion verdict/criticalIssues + converged/confidence/rounds, synthesize runs carry `synthesis`). Tools: `session-get`/`session-revisit`/`session-annotate`. **Body capture is a separate opt-in**: the per-opinion RESPONSE body (`opinion.text`) is stored ONLY when `sessions.captureText` is also on (default off) - off = summaries only (question + verdict/criticalIssues); on = body, secret-scrubbed (mandatory) then best-effort PII (email) stripped. Gated uniformly at the single writer (`persistRun`); `debug.jsonl` NEVER receives body text regardless. Details in [TECHNICAL.md § Session persistence](TECHNICAL.md#session-persistence).
7. **Consensus engine SSOT** - one pure state machine (`core/consensus-loop.js`) behind two drivers (`consensus` server-side, `consensus-step` host-driven); the live `/consensus` is a thin driver over `consensus-step`. See [Consensus engine](#consensus-engine-single-source-of-truth).
8. **Opt-in orientation auto-attach** - `core/orientation.js` resolves a small bundle of high-signal repo files (fixed priority: CLAUDE.md, AGENTS.md, README.md, package.json, pyproject.toml, Cargo.toml, go.mod, tsconfig.json, main.tf; capped at `orientation.maxFiles`, default 6; stat-only, never reads content, never throws). `orchestrate.js` `withOrientation` gate injects the bundle into file-blind providers (Grok, OpenRouter - those where `walksFilesystem === false` in `ProviderCapabilities`) ONLY when the caller passed no files of its own. Injection happens BEFORE the dedup cache key is computed so a now-file-bearing request correctly skips the in-session result cache. The peer fan-out AND the arbiter blind pass are oriented; verdict/adjudication/revision passes are NOT. Bundle travels in `files[]`, never the shared prompt - zero cross-contamination. Provider bridge caps apply. Config: `orientation: { enabled: false, maxFiles: 6 }` (default OFF). Details in [TECHNICAL.md § Orientation auto-attach](TECHNICAL.md#orientation-auto-attach).
9. **Observability + per-provider progress** (host-neutral; every result carries `ms` + effective `reasoningEffort`, HTTP results add token `usage`):
   - **`panel` + `ask-one` tools** - `panel` echoes the exact `selectForAskAll` set (fanout cap applied) WITHOUT dispatching; `ask-one` runs one named provider. `/ask-all` (`commands/ask-all.md`) calls `panel` then issues N parallel `ask-one` calls in ONE turn, so each provider renders independently as it lands (visible progress) while keeping parallel wall-time. The legacy single-call `ask-all` tool is retained. Empirically, Claude Code does NOT render mid-call MCP `notifications/message`, but DOES surface each parallel tool result as it settles - so the per-provider path is the progress lever on this host.
   - **Universal debug log** (`core/debug-log.js`, config `debug.enabled`, OFF by default) - an injected logger emitted AT THE SOURCE in `core` (`askAll`/`askOne`/`consensus`/`runToConvergence`), so the Claude host-arbiter path and the in-core provider-arbiter loop log identically. Records latency, reasoning effort, HTTP token usage, and voting/approval outcomes; NEVER prompts/responses/issue text (`ALLOWED_KEYS` whitelist enforced on write). Default path `<XDG cache>/deliberation/debug.jsonl` (override `DELIBERATION_DEBUG_LOG`).
   - **In-session dedup cache** (`core/result-cache.js`) - identical advisory re-asks return instantly; LRU + 10-min TTL; errors never cached; file-bearing requests skip it; `session-revisit` bypasses it. Wired to the advisory `ask-all`/`ask-one` paths only (NOT the consensus loop).
   - **`analyze` tool** (`core/analyze.js` + `commands/analyze.md`) - reads the debug log back (tail-bounded, pre-aggregated server-side) for per-model latency/tokens/error/effort (Lens A) and the session store for verdict agreement-rate (Lens B), then returns advisory tuning suggestions (disable a slow/redundant model in `ask-all`, lower an OpenRouter model's reasoning, adjust `maxFanout`). The two lenses are NOT joined (no shared run id). This operationalizes the deferred "measure-then-recommend" lever. Read-only; writes nothing. Codex/Gemini reasoning is surfaced as external advice (it lives in `~/.codex/config.toml` / agy, outside deliberation's config).
   - **MCP `logging` capability + `notifications/message` sink** - declared + emitted per provider settle; spec-compliant, so a host that renders server log notifications gets live progress for free.

## Commit Conventions & Releases

Releases are automated from Conventional Commits on `master`. Do not hand-edit version numbers.

| Commit prefix | Version bump |
|---------------|--------------|
| `feat!:` or `BREAKING CHANGE:` | Major |
| `feat:` | Minor |
| `fix:` | Patch |
| `docs`, `refactor`, `build`, `chore`, `style`, `test`, `ci`, `perf` | No release |

Only `feat:` / `fix:` / breaking cut a release. The release uses the `conventionalcommits`
preset with `skip-on-empty: true`; the other types are "hidden" in that preset, so a push that
contains ONLY hidden-type commits produces an empty changelog and is skipped (no bump, no PR).
Those commits still ship - they ride along in the next `feat:` / `fix:` release's tag and
changelog. (The release-PR job also self-skips its own `chore(release):` commit as a loop guard.)

`version.json` is the single source of truth. When a releasable commit lands on `master`,
`automated-release.yml` bumps it, regenerates `CHANGELOG.md`, and runs `.github/release/pre-commit.js` to sync the
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
