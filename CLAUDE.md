# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A Claude Code plugin that provides GPT (via Codex CLI), Gemini 3 (via the
Antigravity CLI `agy`), Grok (via the xAI HTTP API), local models (via Ollama
and LM Studio), and OpenRouter (config-driven, advisory-only, 400+ models) as
specialized expert subagents. Seven domain experts: Architect, Plan Reviewer,
Scope Analyst, Code Reviewer, Security Analyst, Researcher, and Debugger. Only
Gemini can advise OR implement. (GPT, Grok, local models, and OpenRouter are
advisory-only - they cannot edit files. Grok reads attached files via the xAI
Files API; OpenRouter and local models inline text files only.)

## Development Commands

```bash
# Test plugin locally (loads from working directory)
claude --plugin-dir /path/to/deliberation

# Run setup to test installation flow
/deliberation:setup

# Run uninstall to test removal flow
/deliberation:uninstall
```

No build step, no dependencies. Codex exposes a native MCP server; Gemini, Grok,
and OpenRouter/local use bundled zero-dependency Node bridges
(`server/gemini/index.js`, `server/grok/index.js`,
`server/openrouter/index.js`). The Gemini bridge wraps the Antigravity CLI
(`agy`) in print mode. The OpenAI-compatible bridge calls any
`/chat/completions` endpoint (OpenRouter, Ollama, LM Studio).

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
  (config + cache path resolver, `DELIBERATION_CONFIG` override); `sse.js`
  (provider-agnostic SSE framing - CRLF/CR/LF tolerant, returns `{event, data}` - shared
  so a second streaming bridge needs no second parser).
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

The cap is `consensus.maxRounds` (config, default 5, clamped to 50; a per-call `maxRounds` overrides it). A wall-time budget `consensus.maxWallMs` (default 1 800 000 ms, 30 min) stops the provider-arbiter `consensus` loop before the next round when the budget is spent, returning `stopReason: "budget-exhausted"`; the host-driven `consensus-step` path is not affected. The Codex provider is no longer unbounded: `core/providers/codex.js` caps each `codex exec` call to `CODEX_DEFAULT_TIMEOUT_MS` (600 000 ms), and a run killed by that timer reports `errorKind: "timeout"` from the kill flag rather than from a stderr substring (a SIGKILL'd codex often writes nothing, and an `unknown` can never trip the circuit breaker). Every provider's ceiling is configurable: `providers.defaults.timeout` covers all four at once, `providers.<name>.timeout` overrides one (`providers.openrouter.defaults.timeout` for OpenRouter), and a pinned alias's `models.<id>.timeout` still wins - the ladder resolves in `server/openrouter/config.js resolveProviders`, so the composition root just reads the resolved value. Both HTTP bridges keep the `AbortController` armed until the response BODY is read, so a slow body is a `timeout` rather than an unbounded run. `callProvider` retries once - and only once - on `network`, `rate-limit` (waiting for the upstream's `Retry-After`, clamped to 30s), or `empty`; it does not retry timeout or application errors.
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
4. **Call provider tool** - `mcp__deliberation__ask-gpt` (GPT; no dedicated server, `core` spawns `codex exec`), `mcp__deliberation-gemini__gemini`, `mcp__deliberation-grok__grok`, or `mcp__deliberation-openrouter__openrouter`
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
| `~/.config/deliberation/config.json` | Unified user config | Live SSOT; stat-gated hot-reload. Sections: `providers` (connection), `models` (named records map keyed by id), `routing` (fan-out), `consensus` (`arbiter` + `blindVote` + `maxRounds`: the loop cap, default 5, clamped to 50; `maxWallMs`: the provider-arbiter wall-time budget, default 1800000 ms), `sessions` (opt-in run persistence: `persist`/`maxRecords`/`maxAgeDays`, default off; single `schemaVersion:1` stamp), `debug` (opt-in debug log: `enabled`/`path`, default off - see Observability), `orientation` (opt-in auto-attach of a repo bundle to file-blind providers: `enabled`/`maxFiles`, default off - see Key Design Decisions #8). Carries a `$schema` key for editor validation. Canonical XDG path (Windows: `%APPDATA%\deliberation\config.json`); override with `DELIBERATION_CONFIG` |

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

## Pre-PR cross-model review (MANDATORY)

Before opening any PR, run `/consensus` as a code review of the branch diff against
`master`: feed it the `git diff master...HEAD` summary plus the issue or goal, and ask
for correctness, regressions, missing tests, and doc drift. The panel is GPT + Gemini +
Grok (plus configured OpenRouter delegates); Claude arbitrates per
`commands/consensus.md`. Fix every accepted CRITICAL issue and rerun until the loop
converges; every dismissed issue needs the arbiter's stated reason in the PR
description. This is not a substitute for `npm run check` - run that first so the
panel reviews green code. Skip only for `chore(release):` automation commits and
doc-only typo fixes.

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

Every expert can operate in **advisory** (`sandbox: read-only`) or **implementation** (`sandbox: workspace-write`) mode based on the task, but only Gemini still has a write surface: GPT, Grok, and OpenRouter are advisory-only. Per-model expert eligibility for OpenRouter is controlled by the `experts` field in `~/.config/deliberation/config.json` (Windows: `%APPDATA%\deliberation\config.json`; override with `DELIBERATION_CONFIG`).

Implementation today reaches end users through ONE surface: the standalone gemini bridge's `workspace-write` opt-in. GPT's write path went away with codex-cli's MCP server (issue #185); `mcp__deliberation__ask-gpt` is advisory-only. The unified `deliberation` server's `core` providers now also carry a **gated** implement capability (see Key Design Decision #3), but it is not yet exposed through a unified-server tool - that surface lands with the MCP consolidation.

## Grok file access

Grok reads attached files via `files[]` and resolves them under `roots[]` (top-level array of absolute directories) or `cwd`. `path` and `dir` entries take an optional `mode: "auto" | "inline" | "upload"` - inline embeds the file as `input_text` so Grok reads it line-by-line (best for source code); upload routes through the xAI Files API and is SHA-256 dedup-cached locally. `file_id` / `file_url` entries pass through unchanged and do not accept `mode`. Directory expansion via `{dir}` entries. See **[TECHNICAL.md: Grok files and cleanup](TECHNICAL.md#grok-files-and-cleanup)** for parameters, the inline-vs-upload tradeoff, cross-repo usage, cache layout, and the `gc` cleanup subcommand.

When `orientation.enabled` is true, the server auto-attaches a small bundle of high-signal repo files (CLAUDE.md, AGENTS.md, README.md, entrypoints - up to `maxFiles`, default 6) to Grok and OpenRouter calls that carry no files of their own, giving them the same repo grounding that Codex/Gemini get by walking the filesystem. Default OFF. See Key Design Decisions #8 and the Orientation auto-attach section in TECHNICAL.md.

## Key Design Decisions

1. **Native & Bridge MCP** - Codex has NO MCP server (it once did; codex-cli 0.154.0 ships none and `openai/codex` has no `mcp-server` crate left - `codex mcp` manages *external* servers and `app-server` is a different protocol), so GPT is reached by spawning `codex exec` from `core/providers/codex.js` behind the unified server's `ask-gpt` / expert tools - advisory-only, single-shot. Gemini requires a bundled bridge (`server/gemini/index.js`) that wraps the Antigravity CLI (`agy`) in print mode. Grok has no MCP or CLI server mode, so a bundled bridge (`server/grok/index.js`) wraps the xAI **Responses API** (`/v1/responses`) directly - advisory-only (no file editing), but it can READ attached files (`files:[{path|file_id|file_url|dir}]`, optional `roots[]`, per-entry `mode` for upload-vs-inline delivery); uploaded files are SHA-256 dedup-cached locally, auto-expire (7-day default, `GROK_FILE_TTL_SECONDS`), and are managed with `/grok-files` (`server/grok/files-admin.js`: `list`/`prune`/`gc`). Details in [TECHNICAL.md § Grok files and cleanup](TECHNICAL.md#grok-files-and-cleanup). OpenRouter uses a bundled bridge (`server/openrouter/index.js`) that calls any OpenAI-compatible `POST {apiBase}/chat/completions` endpoint - advisory-only, text-inline file attachment only (`{path}`/`{dir}`; no upload path), config-driven via `~/.config/deliberation/config.json` (Windows: `%APPDATA%\deliberation\config.json`; override with `DELIBERATION_CONFIG`). Details in [TECHNICAL.md § OpenRouter bridge](TECHNICAL.md#openrouter-bridge).
2. **Single-shot + multi-turn** - Single-shot for advisory (full context per call), multi-turn via `threadId` for chained implementation and retries
3. **Dual mode** - Any expert can advise or implement based on task. In `core`, implementation is **two-lock gated**: a write happens only when the provider was constructed with `allowImplement:true` (construction lock, in `core/providers/codex.js` + `antigravity.js`) AND the request carries `mode:"implement"` (request lock, `DelegationRequest.mode`, a closed `"advisory"|"implement"` enum defaulting to advisory). A stray or injected `mode` alone never writes; the OS sandbox string (`workspace-write`) stays provider-internal so callers cannot smuggle argv. `capabilities.canImplement` reflects the construction lock, so discovery is honest per process. Gemini's credential env-scrub (`*_KEY`/`*_TOKEN`/`GIT_ASKPASS`/`SSH_AUTH_SOCK`) runs in **both** read-only and write mode - a write run edits the worktree but never receives the operator's keys. The construction lock is left OFF in the live composition root today, so the running server stays read-only; the unified-server `implement` tool + cache-bypass + forced audit record are part of the MCP consolidation. Grok/OpenRouter remain advisory-only (`canImplement:false`). See [TECHNICAL.md § Implementation mode](TECHNICAL.md#implementation-mode-core-capability).
4. **Synthesize, don't passthrough** - Claude interprets expert output, applies judgment
5. **Proactive triggers** - Claude checks for delegation triggers on every message
6. **Opt-in session store** - `consensus`/`consensus-step`/`ask-all` runs persist only when `sessions.persist` is on (default off); per-file JSON at `<XDG cache>/deliberation/sessions/` (override `DELIBERATION_SESSIONS`), secrets scrubbed, retention by count + age (`-1` = unlimited). Single `schemaVersion:1` (no dual-version support; loop runs carry per-opinion verdict/criticalIssues + converged/confidence/rounds, synthesize runs carry `synthesis`). Tools: `session-get`/`session-revisit`/`session-annotate`. **Body capture is a separate opt-in**: the per-opinion RESPONSE body (`opinion.text`) is stored ONLY when `sessions.captureText` is also on (default off) - off = summaries only (question + verdict/criticalIssues); on = body, secret-scrubbed (mandatory) then best-effort PII (email) stripped. Gated uniformly at the single writer (`persistRun`); `debug.jsonl` NEVER receives body text regardless. Details in [TECHNICAL.md § Session persistence](TECHNICAL.md#session-persistence).
7. **Consensus engine SSOT** - one pure state machine (`core/consensus-loop.js`) behind two drivers (`consensus` server-side, `consensus-step` host-driven); the live `/consensus` is a thin driver over `consensus-step`. See [Consensus engine](#consensus-engine-single-source-of-truth).
8. **Opt-in orientation auto-attach** - `core/orientation.js` resolves a small bundle of high-signal repo files (fixed priority: CLAUDE.md, AGENTS.md, README.md, package.json, pyproject.toml, Cargo.toml, go.mod, tsconfig.json, main.tf; capped at `orientation.maxFiles`, default 6; stat-only, never reads content, never throws). `orchestrate.js` `withOrientation` gate injects the bundle into file-blind providers (Grok, OpenRouter - those where `walksFilesystem === false` in `ProviderCapabilities`) ONLY when the caller passed no files of its own. Injection happens BEFORE the dedup cache key is computed so a now-file-bearing request correctly skips the in-session result cache. The peer fan-out AND the arbiter blind pass are oriented; verdict/adjudication/revision passes are NOT. Bundle travels in `files[]`, never the shared prompt - zero cross-contamination. Provider bridge caps apply. Config: `orientation: { enabled: false, maxFiles: 6 }` (default OFF). Details in [TECHNICAL.md § Orientation auto-attach](TECHNICAL.md#orientation-auto-attach).
9. **A provider stub is an error, not an answer - but a terse answer is an answer** - `agy` can exit 0 having printed only a preamble ("I will begin by finding the repository directory..."), and `grok-4.6` (agentic-trained, reached with `tools: []`) can end its turn on "I'll verify the cited files..." (99-162 chars) waiting for a tool call that never comes. Any non-empty text used to flow downstream as a real opinion, and inside consensus `parseReview` turned it into `verdict: null` - silently blocking convergence with no diagnostic. The rule is ONE shared helper, `core/answer-floor.js stubReason(text, minChars)`, called by both bridges: a reply is a stub when it is shorter than `GEMINI_MIN_ANSWER_CHARS` / `GROK_MIN_ANSWER_CHARS` (default 1, i.e. empty; `0` disables both checks) OR is under 400 chars and opens with an intent phrase FOLLOWED BY an exploration verb ("I will begin by...", "Let me check..."; a bare "I will." or "I'll go with B" is an answer); it fails as `errorKind: "empty"` with the reason in the message, and `callProvider` retries once. The intent check is new for Gemini (Grok already had it). The first cut was an 80-char LENGTH floor; [issue #180](https://github.com/antonbabenko/deliberation/issues/180) showed why that is the wrong signal - the reporter's smoke prompt made `agy` answer `ok` (2 chars, exit 0) and every call failed while the CLI worked by hand. A character count cannot tell terse from stub; the opening phrase can, and it catches both observed stubs. Gemini applies it on the clean-exit AND the drain path (validity must not be timing-dependent). The Grok bridge also always seeds the system turn with a runtime note - no tools, no filesystem, no further turns, answer now. Two more lessons from #180: `toErrorResult` now forwards the bridge's `message` (bounded; never into the debug log or session store), because the coarse `errorKind` alone hid a one-line diagnosis behind hours of sandbox instrumentation; and `agy --help` prints to STDERR on 1.1.x, so the `--model` capability probe reads both streams - the pin had never actually been sent before, and agy rejects the built-in `auto-gemini-3` alias on 1.1.x (`invalid model selection`). That ONE pin self-heals because it ships in every install's config: `runGemini` retries once without it (within the remaining budget), warns once, omits it for the rest of the process, and the result says so (`pinDropped: true`; unified `model: "agy-settings-default"`). Any other rejected id is the operator's own pin and fails loudly as `model-not-allowed` with agy's catalog in the message - never a silent model swap. The pin is found by position (right before the `-p` tail), never by scanning argv values. Details in [TECHNICAL.md § Answer floor](TECHNICAL.md#answer-floor-gemini-grok).
10. **Observability + per-provider progress** (host-neutral; every result carries `ms` + effective `reasoningEffort`, HTTP results add token `usage`):
   - **`panel` + `ask-one` tools** - `panel` echoes the exact `selectForAskAll` set (fanout cap applied) WITHOUT dispatching; `ask-one` runs one named provider. `/ask-all` (`commands/ask-all.md`) calls `panel` then issues N parallel `ask-one` calls in ONE turn, so each provider renders independently as it lands (visible progress) while keeping parallel wall-time. The legacy single-call `ask-all` tool is retained. Empirically, Claude Code does NOT render mid-call MCP `notifications/message`, but DOES surface each parallel tool result as it settles - so the per-provider path is the progress lever on this host.
   - **Universal debug log** (`core/debug-log.js`, config `debug.enabled`, OFF by default) - an injected logger emitted AT THE SOURCE in `core` (`askAll`/`askOne`/`consensus`/`runToConvergence`), so the Claude host-arbiter path and the in-core provider-arbiter loop log identically. Records latency, reasoning effort, HTTP token usage, and voting/approval outcomes; NEVER prompts/responses/issue text (`ALLOWED_KEYS` whitelist enforced on write). Default path `<XDG cache>/deliberation/debug.jsonl` (override `DELIBERATION_DEBUG_LOG`).
   - **In-session dedup cache** (`core/result-cache.js`) - identical advisory re-asks return instantly; LRU + 10-min TTL; errors never cached; file-bearing requests skip it; `session-revisit` bypasses it. Wired to the advisory `ask-all`/`ask-one` paths only (NOT the consensus loop).
   - **`analyze` tool** (`core/analyze.js` + `commands/analyze.md`) - reads the debug log back (tail-bounded, pre-aggregated server-side) for per-model latency/tokens/error/effort (Lens A) and the session store for verdict agreement-rate (Lens B), then returns advisory tuning suggestions (disable a slow/redundant model in `ask-all`, lower an OpenRouter model's reasoning, adjust `maxFanout`). The two lenses are NOT joined (no shared run id). This operationalizes the deferred "measure-then-recommend" lever. Read-only; writes nothing. Codex/Gemini reasoning is surfaced as external advice (it lives in `~/.codex/config.toml` / agy, outside deliberation's config).
   - **MCP `logging` capability + `notifications/message` sink** - declared + emitted per provider settle; spec-compliant, so a host that renders server log notifications gets live progress for free.

11. **Resolve the CLI, never interpose a shell** - `core/resolve-bin.js` turns a bare command name into something Node can spawn, because `npm install -g` on Windows writes a `codex.cmd` shim that `spawn` with `shell:false` refuses to execute (issue #170: every GPT call failed, plus three `agy` sites in `server/gemini/index.js` including the boot gate that calls `process.exit(1)`). Resolution on win32 is FIRST-MATCH-WINS in PATH then PATHEXT order (libuv/`where` precedence): a `.exe`/`.com` is spawned directly; a `.cmd`/`.bat`/`.ps1` shim is bypassed via `process.execPath` + the npm package's own entry (`@openai/codex` -> `bin/codex.js`, probed in both the global and the `node_modules/.bin` layout; no such package exists for `agy`, so it errors explicitly); scanning continues past the first match ONLY when it is a shim with no package behind it, and then anything usable wins (a `.exe` or another shim that does have its package) - deliberately out of shell order, because failing while a working install sits on PATH is worse; nothing found passes through and keeps today's ENOENT. An explicitly NAMED shim (`CODEX_BIN=codex.cmd`) is recognised as one, so the error is not "set CODEX_BIN" to someone who just did. Every non-win32 platform and every other path-bearing name pass through untouched - the AGY_BIN fixtures in `test/_helpers.js` depend on it. `shell: true` was rejected on LIFECYCLE grounds, not injection (the prompt is stdin, argv is a constant): the shell would become the child, so `child.kill("SIGKILL")` would kill the shell and leave the CLI running past the timeout the consensus circuit breaker depends on. Overrides: `CODEX_BIN`, `AGY_BIN`. **Cross-platform part**: a failed launch now reports `not-found` (codex) / `missing-cli` (gemini) instead of `unknown`, keyed on a structural `spawnFailed` flag rather than a stderr pattern - the same precedent as `timedOut`, because a coding agent legitimately prints ENOENT about the user's own files. The Gemini gate lives in `runGemini`, NOT only behind `require.main === module`: `server/mcp/index.js` require()s the bridge, so a boot-only gate never runs in the process that serves calls. CI is ubuntu-only, so win32 is asserted through injected `platform`/`env`/`exists`, the `core/paths.js` pattern. Details in [TECHNICAL.md § Windows CLI resolution](TECHNICAL.md#windows-cli-resolution).

12. **A transport ceiling is not a network fault, and a dead peer is not a voice** - four defects that turned one bad provider into a 10-minute consensus round, all confirmed from `debug.jsonl`:
   - **undici's ceilings are not raisable.** Node's `fetch` gives up after 300s waiting for response headers and 300s between body chunks, with no public API to change either. The Grok bridge posted `stream: false`, and xAI sends nothing until the answer is done, so every `grok-4.6` call that thought for over five minutes died at exactly 300s - `providers.grok.timeout: 480000` was unreachable. Worse, the bare `TypeError: fetch failed` was classified `network`, which `callProvider` RETRIES, so the round paid 600s to fail. Now: `server/grok/index.js` streams (SSE, branching on the response `Content-Type` so a non-streaming upstream and every error status still work; `response.completed` carries the same object the non-streaming call returned, so the parser/usage/`output` path is unchanged; `GROK_STREAM=0` reverts), and `core/provider.js classifyFetchFailure` maps `UND_ERR_HEADERS_TIMEOUT`/`UND_ERR_BODY_TIMEOUT` to `timeout` - never retried. OpenRouter only escaped this because its API emits processing keepalives.
   - **`network` was a black box.** The message is dropped by `debug-log.js` `ALLOWED_KEYS`, the session store only writes on a terminal transition, and the panel prints the kind - so a DNS failure, a socket reset, a 300s undici ceiling and a local throw were one indistinguishable label in the only place provider health is diagnosed. `provider_result` now carries `errorCode` (the rejection's `cause.code`; the key was already whitelisted for `persist_failed`). A bare errno/undici symbol, never a message.
   - **The breaker was on the wrong path and counted the wrong thing.** `timeoutStreak` lived in `runToConvergence` (the provider-arbiter driver) and counted only `errorKind === "timeout"`. The live `/consensus` drives `consensus-step`, which had NO breaker: it re-ran `selectForConsensus` every round and re-dispatched peers that had failed every round since round 1. The streak now lives on `LoopState.errorStreak` in `core/consensus-loop.js` (`updateErrorStreak`/`trippedProviders`, folded in by `addOpinions`), counts ANY error, and is read by both drivers - the same SSOT rule as #7. `dispatch_peers` reports removals as `droppedProviders[]` and terminates with `stopReason: "all-providers-circuit-broken"` rather than looping on an empty fan-out.
   - **`consensus.maxWallMs` applied to one driver.** `consensus-step` is a series of stateless calls, so it now carries `startedAt` on its stored state and gates STARTING a round (never a fan-out in flight), returning `stopReason: "budget-exhausted"`.
   Also: the `network` retry no longer fires in the same millisecond as the failure (1s pause), and `upstream` is now actually in `RETRY_ONCE_KINDS` rather than merely documented as retryable. Details in [TECHNICAL.md § Circuit breaker](TECHNICAL.md#circuit-breaker) and [§ Grok streaming](TECHNICAL.md#grok-streaming).

   **Review follow-ups (same PR).** Code review found the first cut of the above wrong in ways worth recording, because each is a general trap:
   - **An abort has two shapes.** `classifyFetchFailure` caught the `AbortError` but not the WRAPPED form undici produces when the controller fires mid-body: `TypeError: terminated` whose `cause` is a DOMException named `AbortError`. Neither its name nor its message mentions aborting, so the bridge's own ceiling fell back into the retryable `network` bucket - reintroducing the exact double-billing through the door built to close it.
   - **A fixture that mirrors the parser can never disagree with it.** The SSE splitter matched only `"\n\n"`, so a CRLF stream never framed; the tests passed because the fixture also emitted `"\n\n"`. Protocol tests need spec-derived inputs. Framing now lives in `core/sse.js` (LF/CRLF/CR) with the xAI semantics in `server/grok/stream.js`, and the event name is read from the SSE `event:` line when the JSON carries no `type`.
   - **Prefer, do not trust.** `final || deltas` discarded a complete answer whenever a completion event arrived unparseable; `response.incomplete` (a truncated but usable answer on the non-streaming path) was thrown away as a failure; whitespace-only deltas escaped a truthiness check into a non-retryable `parse`.
   - **Streaming by default needs a way to be wrong.** A stream carrying no recognized event now retries once with `stream: false`, so a drift in the event vocabulary degrades instead of taking Grok offline - which, with the new breaker, would have silently dropped it from the panel.
   - **A terminal transition is not the same state as a round.** `terminateLoop` fires BEFORE a fan-out, so it must persist the last COMPLETED round's opinions from `history` (`results` was already reset by `submitRevision`) and report the rounds that finished, not the one about to start.
   - **Consolidating a rule means migrating every caller.** `no-providers` was added to `consensus-step` and not to `runToConvergence` on the same PR that argues for one rules layer; `droppedProviders` was recomputed from the whole streak map, so it re-announced every round and could name peers absent from the panel.

13. **Another tool's subcommand is not an API, and a CLI that forwards is worse than one that errors** - `.claude-plugin/plugin.json` registered a `deliberation-codex` server as `codex mcp-server` for as long as that subcommand existed. codex-cli removed it (0.154.0 ships no MCP server mode; `codex mcp` manages *external* servers, `app-server` is a different protocol, and no `mcp-server` crate remains in `openai/codex`). The removal was invisible at the only moment it mattered: codex forwards an UNKNOWN subcommand to the interactive CLI, which exits on `Error: stdin is not a terminal` - exit 0, no stderr about a missing command - so the host reported `CONNECTION_CLOSED` and two tools (`codex` / `codex-reply`) stayed advertised, forever unable to answer ([issue #185](https://github.com/antonbabenko/deliberation/issues/185)). Same shape as #9 one layer down: a stub is not an answer, and a forwarded subcommand is not a server. The fix was deletion, not a probe - `core/providers/codex.js` already spawns `codex exec` (a subcommand that exists), and the Codex/Kiro host manifests already shipped only the unified server, so dropping the entry left ONE GPT path instead of two advertised ones. What the delete costs, honestly: GPT multi-turn (`codex-reply`) and GPT `workspace-write` - both already dead upstream, so the docs claiming them were the remaining bug. Implementation now means Gemini. The lesson generalises to every vendored CLI invocation: pin to the narrowest subcommand that the vendor documents as stable (`exec`), and treat "the process started but said nothing useful" as a failure signal, never as a connection.

14. **The host's cap wins, so fail under it and name it; a peer that cannot answer is not a voice** - three independent defects made the plugin unusable in Claude Code on the web, each invisible from the error surface. (a) The web host exports `MCP_TOOL_TIMEOUT=60000` and kills any tool call at 60s; the provider ceilings (180-600s) were unreachable, so the host reported `tool "ask-grok" timed out after 60s` and the provider's own error path - `errorKind`, message, circuit-breaker input - never ran. `core/host-budget.js` reads the cap and clamps every ceiling to `cap - 5000` ms at the point it is applied (Codex `ask`, `runGrok`, `runGeminiOnce`, `callOpenRouter` - the standalone `/ask-*` bridges included); a timeout that fired because of the clamp says so in `message` (`Host MCP_TOOL_TIMEOUT=60000 caps every MCP tool call ...`). Review caught that a per-leg clamp alone re-arms the whole cap for every SEQUENTIAL leg (a retry, the arbiter passes of a round, Gemini's 120s drain after a 55s soft timeout = a 175s call under a 60s cap), so the server takes the clock at tool entry and every leg is stamped with what is LEFT (`fitToHostBudget` -> `req.hostBudgetRemainingMs`, a separate field so a shorter configured ceiling still wins; the adapters' clamp reads it); a retry whose backoff would not fit is not even slept on; the Grok fallback and stale-file retry spend the same budget; `runToConvergence` stops `budget-exhausted` once the cap is spent; and the Gemini drain is off under any cap (`graceWithinHostBudget`). Deliberately NOT a config key: the cap is the host's, so the fix (raise it where the host is launched) is named, not emulated. Follow-up: the clamp alone still left every web call at 55s, and Claude Code resolves the cap per server as `config.timeout ?? MCP_TOOL_TIMEOUT ?? default` (progress notifications never extend it), so `.claude-plugin/plugin.json` now declares `"timeout": 1800000` on every server AND mirrors it into the server env as `MCP_TOOL_TIMEOUT` - without the mirror the server inherits the host's 60000 and this very clamp cancels the override (`test/plugin-manifest.test.js` keeps them equal). The "still times out at 60s" report that prompted it came from a container whose seed marketplace pinned v3.14.8 two minutes before v3.14.9 shipped; `/deliberation:doctor` and the hint now say "older install" instead of "raise the variable". (b) Making the clamp fire exposed that Grok's ceiling was unenforceable while an SSE body was flowing: on Node 22 aborting the fetch signal does not reliably error a streaming body (chunks kept arriving 20s+ past the abort) and the `for await` loop holds the stream lock, so an outside `cancel()` is refused. `core/sse.js readSseStream` now takes the signal, races each `reader.read()` against it, and cancels the reader it owns - without awaiting the cancel, which is async and need not settle (review reproduced a pending `cancel()` holding the timeout hostage). (c) codex-cli 0.154 reads `CODEX_API_KEY` or `auth.json`, never `OPENAI_API_KEY` - the only key the web container exported - so every GPT call was `401 Missing bearer` after 17s of reconnects. The first fix forwarded `OPENAI_API_KEY` as `CODEX_API_KEY`, and that broke every laptop that exports `OPENAI_API_KEY` for other tools: codex ranks the env key above `auth.json`, so the ChatGPT subscription was bypassed and calls died on `You have no credits remaining`. The rule now (`codexEnv()`): a ChatGPT credential (a `codex login`, or a Business/Enterprise `CODEX_ACCESS_TOKEN`, which codex reads natively and ranks above `auth.json`) always wins and `CODEX_API_KEY` is dropped from the child's env; without one `CODEX_API_KEY` is used; `OPENAI_API_KEY` is never used and never reaches the child. A web host must get a login of its OWN: a ChatGPT refresh token works once, so an `auth.json` copied from a laptop (or restored from a secret every session) dies on the first refresh either side makes, with `...your refresh token was already used`. That text names neither "auth" nor "login", so it classified as `unknown`; `classifyCodex` now maps codex's exact phrase (`access token could not be refreshed`, stderr only - `codex exec` echoes the prompt there, so a bare `refresh token` match would turn a rate limit on a token-code review into a non-retryable `auth`) to `auth`, and the message LEADS with codex's line and the fix, because codex prints its banner and the whole echoed prompt on stderr before the error (codex builds its own result; it never passes through `toErrorResult`, so its message is not capped - an earlier version of this note claimed it was). The fix itself is #15. And `codex.health()` was hardcoded `{ok:true}` while `antigravity.health()` checked only that the bridge object existed, so the panel kept listing peers with no CLI or no credential and every `/consensus` round paid to discover it. Health is now stat-only and real (`codexHealth`, `bridge.cliAvailable`), `registry.selectFor*` takes the `unhealthy` map and reports `unavailable[]` with reasons, and `panel` / `ask-all` / `consensus` / `consensus-step` all consult it before dispatch. The Gemini bridge's boot `process.exit(1)` when `agy` is missing stays: an honest `CONNECTION_CLOSED` beats a server advertising tools it cannot serve (#13), and the unified server now simply omits gemini. `/deliberation:doctor` reports all three. Rule of thumb: every ceiling in the process must be at or under the outermost one, or the outermost one is the only one that ever fires - and it is the one that says nothing.

15. **Log in where the answer is needed, and show the code where the user is looking** - a Claude Code web container has no browser and must not borrow a laptop's `auth.json` (#14c), so a ChatGPT Plus user had to type `codex login --device-auth` in every session. The unified server now builds codex with `deviceLogin: true`: with no credential, or a spent one, `ask()` starts `codex login --device-auth` itself (`makeDeviceLogin`, one login per process, replaced when its code expires), parses the link and code (`parseDevicePrompt` - codex's human text, so loose, with the raw output as the fallback), and asks the HOST to show them through MCP elicitation (`confirmLogin`: URL mode when offered, else a form). That meant three protocol changes in `server/mcp/index.js`: negotiate the client's protocol version instead of always answering `2024-11-05` (elicitation is `2025-06-18`+), record the client's capabilities at `initialize`, and route replies to server-sent requests (the stdin loop handles a batch's replies before its requests, because a tool call earlier in the batch may be the one waiting). Timing is the whole design. A SessionStart hook cannot do this: a code lives 15 minutes, so a session-start code is spent before the first GPT call and wasted on sessions that never make one. A tool call cannot show output mid-call, so without elicitation the code rides in the RESULT and GPT answers on the next call; `dispatch_peers` therefore carries an errored voice's bounded `message` (`plainMessage`), and the command files say to print it as-is. The wait is bounded by the code's lifetime, 5 minutes, and half the remaining host budget; approving in the browser ends it even if the dialog is never answered; the codex run afterwards gets the budget minus the wait. Review found the traps: the link is the URL with `/device` in it (an update notice can print another URL first), one code gets one dialog, elicitation is gated on the NEGOTIATED version (capabilities alone are not enough), a login that died is reported without its dead code, the link leads the message so any truncation keeps it, and the anti-phishing line codex prints is carried into both the dialog and the result. A second review round added: a DECLINE kills that login (only a dismissal or silence keeps the code alive, because a device login someone else completes binds this machine's codex to THEIR account, and every later prompt goes to their history), only an openai.com / chatgpt.com URL is ever offered as the link, and an unused code is reaped at expiry by us rather than trusting codex to exit. Round three: no dialog under 15 s of host budget (the 1000 ms budget floor would otherwise open a dialog nobody can answer in time), and a decline that lands after the login completed says so and points at `codex logout` - deleting auth.json ourselves was rejected, because on the spent-login path that file is the user's own. A separate GPT review then reproduced six more, all fixed: the 20 s no-code timer was never cleared, so EVERY login died 20 s after showing its code (tests that finish in milliseconds could not see it - now `promptWaitMs` is injectable and CX-login-keepalive waits past it); killing the npm launcher left the native login polling (now a process group, killed as a tree); SIGTERM skips `exit` hooks and nothing handled stdin closing (now both kill live logins); a pipe chunk ending mid-code made the regex accept `ABCD-1234` (tokens now need trailing whitespace; CX-login-split tries every split point); a prompt quoting codex's exact error could start a login (lines that are part of the sent prompt are skipped); and an abandoned dialog stayed open (now `notifications/cancelled` once no caller waits, and on timeout). Its re-review then caught that the cancellation was dead in production - the composition root's `confirmLogin` lambda dropped the third argument, the AbortSignal, and each side's unit test passed alone (EL-e2e now drives the real server over stdio with a fake `codex` via `CODEX_BIN`) - plus a spent budget read back as a fresh one (`spendHostBudget` floors at 1 ms because `clampToHostBudget` treats a non-positive budget as none), the echo filter hiding a genuine error line that the prompt also quoted (each prompt line is now consumed once), shutdown not refusing logins started afterwards, and a decline misreported when credentials landed just before the kill (the `auth.json` mtime is the truth, not the exit code). A third pass found that baseline recorded per caller instead of per shared login (a caller joining after the approval was saved compared against the new file), and that waiting for codex to print its code was bounded only by the 20 s prompt timer, not by the host budget; both fixed, both reproduced first. Health reports "no credential" as `ok` while `deviceLogin` is on, because that is the one gap `ask()` closes itself; a panel that skipped codex could never deliver the code. Unverified at merge time: whether Claude Code on the web renders elicitation dialogs - the result path covers it either way. The first real web session then showed the design's blind spot: it assumed the agent always MAKES the GPT call. The agent read `codex.js`, decided a logged-out call "would only return the device-auth link, not an answer", and answered from local config, so the login never started. Fix (chosen via `/ask-all`, 4/4 agreeing): a `codex-login` tool (`provider.login()`, the same `signIn` without a question, joining the same shared login) and a `/deliberation:codex-login` command the USER can run without the agent's judgement, plus a "never skip a GPT call because GPT looks logged out" line in the command files and in the `ask-gpt` / `ask-one` tool descriptions (read when the call is decided). Rejected: starting a login from `panel`/health (a probe must stay side-effect-free) and making `ask-gpt` call `codex-login` first (one more step to skip, and ask() already logs in). A prompt rule is not a mechanism; a user-runnable command is. Then the first sessions that DID use it measured the last flaw: `ms: 300791`, exactly the 5-minute dialog cap. The web host advertises elicitation and never answers, so every login waited the full cap before showing a code codex had printed in a second, and burned a third of that code's 15-minute life. `/ask-all` was 5/5: **never await the dialog**. It is sent and the call returns; the outcome belongs to the LOGIN (accept lets it land, decline ends it whenever it arrives, a settled login cancels the dialog), and `DIALOG_WAIT_MAX_MS` / `DIALOG_MIN_BUDGET_MS` / the half-budget split are gone along with the same-call answer they bought. The same five rejected the tempting fix - prewarming a login at session start - for three reasons: a 15-minute code would be wasted on every session that never asks GPT, device codes are rate-limited, and a server-side prewarm cannot show the code anyway (Claude Code does not render `notifications/message`). Prewarm saves a second that no longer exists. The message now puts the link and the code each alone on a line: a code the user must retype is a UI, not a log line. **Login before the fan-out (reverses one rejection above).** Login on first use still lost GPT for the whole first run: `/ask-all` synthesized without it, and in `/consensus` a codex voice that errors every round is circuit-broken off the panel, so the user had to remember `/deliberation:codex-login` at the start of every web session. `codex.health()` now returns `{ ok: true, needsLogin: true }` (ok, so GPT stays on the panel), `panel` reports it as `needsLogin[]` (`for: "consensus"` for the consensus panel), and `/ask-all`, `/consensus` and `/ask-gpt` gate on that FIELD: `codex-login`, print the link and code, `AskUserQuestion` to approve, `codex-login` again to confirm `authenticated`, then dispatch. "Making `ask-gpt` call `codex-login` first" was rejected above as one more prose step to skip; the difference now is a structured flag the command reads, not a judgement about whether GPT looks logged out. What stays: `panel` never starts a login (it reads a flag), no SessionStart login (the code starts inside a command the user ran, so it is spent on that run), and the in-call login remains the fallback for a spent `auth.json` that `stat` cannot see.

16. **Ground the date in code, leave the lookup to the host** - external PR #204 proposed a standalone "mandatory temporal grounding" skill (run `date -u`, query AWS/Terraform MCP tools, search the web) pasted into AGENTS.md and the host rules. The problem is real - a delegate trained months ago calls a newer model or tool "hallucinated" and files a false critical issue that blocks a consensus round - but prose aimed at the delegates cannot fix it: Grok and OpenRouter run with `tools: []`, the vendor tool names exist only on some hosts, and persona text is paid on every call times panel size times rounds. `/ask-all` (5/5) split it by who can act. The date is a FACT only code can supply, so `core/grounding.js groundingNote()` stamps it, with a one-sentence no-denial rule (unrecognized = `[unverified]`, never "non-existent"), into every prompt builder (Codex `runOnce`, Gemini `buildAgyArgs`, Grok and OpenRouter `buildInitialTurns`) - the builders, not `orchestrate.js`, because they are the one place every path meets, standalone `/ask-*` bridges included. The rule ships WITH the date because a date alone still lets a model deny a name it does not know. Retrieval is the host's job: `AGENTS.md` "Time-sensitive questions", every `/ask-*` command, `/consensus`, and the CONTEXT section of `rules/delegation-format.md` tell the orchestrator to verify and inline facts with an as-of date and source. Personas are unchanged, no skill, no config key. Details in [TECHNICAL.md § Date grounding](TECHNICAL.md#date-grounding).

15. **Local Providers & Explicit Provider Attribution in `models`** - operators
    frequently run local inference runtimes (Ollama, LM Studio) alongside
    remote APIs, or configure multiple alternative Google/Gemini models (e.g.
    `gemini-3.8-flash-high`, `gpt-oss-120b-medium`). Previously, `models` was
    hardcoded to `"provider": "openrouter"`. In v1.1+, `models` records accept
    `"provider": "openrouter" | "ollama" | "lmstudio" | "google"`. Keyless
    local endpoints (`http://localhost:11434/v1` for Ollama and
    `http://localhost:1234/v1` for LM Studio) execute without an API key.
    To eliminate model ambiguity, shadowing, or silent model substitutions,
    `core/registry.js formatDelegateName` explicitly attributes every delegate
    in `panel`, `ask-all`, `consensus`, and `ask-one`: `google:<model>`,
    `ollama:<model>`, `lmstudio:<model>`, and `openrouter:<alias>`. Model
    slugs in `model` accept colons, dots, and slashes (e.g.
    `nemotron-3-ultra:cloud`), while record IDs remain restricted to
    `^[a-z0-9-]+$`.

16. **Mandatory Temporal Grounding & Live RAG Verification** - all LLM models
    suffer from training cutoff boundaries. When assessing plans or queries
    involving modern tools, library versions, cloud offerings, or foundation
    models released after a delegate's pre-training cutoff, ungrounded
    delegates consistently commit false-negative errors, asserting that real
    technologies are "hallucinated" or "fictional". To solve this, deliberation
    implements the `/temporal-grounding` protocol: (a) determine current UTC
    date (`date -u` or system metadata); (b) delta check: if current date is
    3+ months past cutoff, static weights cannot be trusted as authoritative
    for versioning or offerings; (c) strict prohibition on unverified negative
    claims; (d) mandatory live RAG retrieval via AWS MCP (`call_aws`,
    `suggest_aws_commands`), Terraform MCP (`search_providers`), and web
    search (`search_web`, `read_url_content`); (e) inlining retrieved facts
    into delegation prompts for `/ask-all` and `/consensus` so file-blind or
    cutoff-bound subagents debate technical merits rather than false cutoff
    objections. First-class slash commands (`/ask-all`, `/consensus`,
    `/temporal-grounding`) are supported across Claude Code, Antigravity CLI,
    and Codex CLI.

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
version in `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`,
`package.json`, `server.json`, `server/mcp/package.json`, the Codex host manifest, and the
`serverInfo.version` literal in `server/mcp/index.js` (what every MCP host displays).
After the release PR merges, `tag-release.yml` tags `vX.Y.Z`, publishes the
GitHub Release, nudges the `antonbabenko/agent-plugins` marketplace to re-pin, and
comments on every PR that shipped in the tag (version + how to update). The
`validate` check fails if any of those version fields drift from `version.json`. See
CONTRIBUTING.md for the full flow.

## When NOT to Delegate

- Simple syntax questions (answer directly)
- First attempt at any fix (try yourself first)
- Trivial file operations
- Research/documentation tasks
