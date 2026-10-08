# Architecture

How the repo is put together. Read before changing `core/`, `server/`, or the consensus engine. Design history and the reasons behind each choice are in [design-decisions.md](design-decisions.md).

## Repository layout

- **`core/`** - host-neutral, zero runtime deps, strict-typed. Provider interface +
  `toErrorResult` + the opinion schema/envelope (`types.js` / `provider.js`): `OPINION_SCHEMA`
  (`recommendation` + `confidence` enum + optional `dissent_points`/`assumptions`/`tradeoffs`
  `string[]`), `parseOpinion(text) -> OpinionEnvelope` (best-effort, never throws; `structured` =
  parse provenance), advisory `validateOpinion` (`{valid, wellFormed, warnings}`), `OPINION_INSTRUCTIONS`,
  and `parseReview(text) -> {verdict, criticalIssues}` (best-effort, never-throws: fenced-code-skipped
  verdict ladder - `VERDICT:` sentinel / same-line keyword / `Verdict` heading-split / bare token - plus
  the closed 6-category taxonomy with next-line continuation-join and per-reply dedup of repeated issues) used by the convergence loop. `registry.js` (`selectForAskAll` /
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
- **`server/dashboard/`** - the local read-only dashboard (`index.js` CLI + pidfile, `server.js`
  routes/guards/SSE, `runs.js` run index, `tail.js` byte-offset tailer, `ui/` static page),
  reached as `node server/mcp/index.js dashboard`. It reads the run journal that `core/journal.js`
  writes; `core/redact.js` masks PII on serve. See Key Design Decision #17.
- **Typecheck gate** - `tsconfig.json` strict `checkJs` over `core/**` + `server/mcp/**/*.js`
  (excludes `server/mcp/dist`). `npm run check` = `typecheck` + `node --test test/*.test.js`,
  enforced in CI by `.github/workflows/validate.yml`.

## Consensus engine (single source of truth)

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

The cap is `consensus.maxRounds` (config, default 5, clamped to 50; a per-call `maxRounds` overrides it). A configurable quorum floor `consensus.quorumFloor` (default 2, min 1) guarantees consensus cannot converge when surviving responding peers drop below the quorum threshold. A wall-time budget `consensus.maxWallMs` (default 1 800 000 ms, 30 min) stops the provider-arbiter `consensus` loop before the next round when the budget is spent, returning `stopReason: "budget-exhausted"`; the host-driven `consensus-step` path is not affected. The Codex provider is no longer unbounded: `core/providers/codex.js` caps each `codex exec` call to `CODEX_DEFAULT_TIMEOUT_MS` (600 000 ms), and a run killed by that timer reports `errorKind: "timeout"` from the kill flag rather than from a stderr substring (a SIGKILL'd codex often writes nothing, and an `unknown` can never trip the circuit breaker). Every provider's ceiling is configurable: `providers.defaults.timeout` covers all four at once, `providers.<name>.timeout` overrides one (`providers.openrouter.defaults.timeout` for OpenRouter), and a pinned alias's `models.<id>.timeout` still wins - the ladder resolves in `server/openrouter/config.js resolveProviders`, so the composition root just reads the resolved value. Both HTTP bridges keep the `AbortController` armed until the response BODY is read, so a slow body is a `timeout` rather than an unbounded run. `callProvider` retries once - and only once - on `network`, `rate-limit` (waiting for the upstream's `Retry-After`, clamped to 30s), or `empty`; it does not retry timeout or application errors.
The `consensus` tool AND the host-driven `consensus-step` loop persist a session record on a
terminal transition - converged or unresolved (when `sessions.persist` is on, with the mode flag).
`consensus-step` uses an atomic `loopStore.take()` before the write so a terminal transition writes
at most one record, lock-free; the record's `question` is the ORIGINAL prompt, not the final
revision. `session-revisit` replays the recorded mode (loop or synthesize), not a one-shot pass.

## Orchestration Flow

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

## How Delegation Works

1. **Match trigger** - Check `rules/triggers.md` for semantic patterns
2. **Read expert prompt** - Load from `prompts/[expert].md`
3. **Build 7-section prompt** - Use format from `rules/delegation-format.md`
4. **Call provider tool** - `mcp__deliberation__ask-gpt` (GPT; no dedicated server, `core` spawns `codex exec`), `mcp__deliberation-gemini__gemini`, `mcp__deliberation-grok__grok`, or `mcp__deliberation-openrouter__openrouter`
5. **Synthesize response** - Never show raw output; interpret and verify

## The 7-Section Delegation Format

Every delegation prompt must include: TASK, EXPECTED OUTCOME, CONTEXT, CONSTRAINTS, MUST DO, MUST NOT DO, OUTPUT FORMAT. See `rules/delegation-format.md` for templates.

## Retry Handling

Retries use multi-turn (`*-reply` with `threadId`) so the expert remembers previous attempts:
- Attempt 1 fails → retry with error details (context preserved)
- Up to 3 attempts → then escalate to user
- Fallback: new call with full history if multi-turn unavailable

## Component Relationships

| Component | Purpose | Notes |
|-----------|---------|-------|
| `rules/*.md` | When/how to delegate | Installed to `~/.claude/rules/deliberation/` |
| `prompts/*.md` | Expert personalities | Injected via `developer-instructions` |
| `commands/*.md` | Slash commands | `/setup`, `/uninstall`, `/help`, `/doctor`, `/analyze`, `/dashboard` |
| `server/dashboard/` | Local read-only dashboard | `deliberation-mcp dashboard`: loopback HTTP + SSE over the run journal; UI in `ui/` (shipped as `dist/dashboard-ui/` in the npm bundle). See Key Design Decision #17 |
| `<XDG cache>/deliberation/runs/` | Dashboard run journal | One `<runId>.jsonl` per run, written by `core/journal.js` only while `dashboard.enabled`; override with `DELIBERATION_RUNS` |
| `config/providers.json` | Provider metadata | Not used at runtime |
| `config/config.schema.json` | JSON Schema (in `config/`) | Validates `config.json` in editors (VS Code built-in JSON support, no extension); `.vscode/` wires it for in-repo example configs |
| `~/.config/deliberation/config.json` | Unified user config | Live SSOT; stat-gated hot-reload. Sections: `providers` (connection), `models` (named records map keyed by id), `routing` (fan-out), `consensus` (`arbiter` + `blindVote` + `maxRounds`: the loop cap, default 5, clamped to 50; `maxWallMs`: the provider-arbiter wall-time budget, default 1800000 ms), `sessions` (opt-in run persistence: `persist`/`maxRecords`/`maxAgeDays`, default off; single `schemaVersion:1` stamp), `debug` (opt-in debug log: `enabled`/`path`, default off - see Observability), `orientation` (opt-in auto-attach of a repo bundle to file-blind providers: `enabled`/`maxFiles`, default off - see Key Design Decisions #8), `dashboard` (opt-in run journal + local viewer: `enabled`/`capture`/`showPII`/`port`/`maxRuns`/`maxAgeDays`, default off - see Key Design Decisions #17). Carries a `$schema` key for editor validation. Canonical XDG path (Windows: `%APPDATA%\deliberation\config.json`); override with `DELIBERATION_CONFIG` |

> Expert prompts adapted from [oh-my-opencode](https://github.com/code-yeongyu/oh-my-opencode)

## Seven experts

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

Grok reads attached files via `files[]` and resolves them under `roots[]` (top-level array of absolute directories) or `cwd`. `path` and `dir` entries take an optional `mode: "auto" | "inline" | "upload"` - inline embeds the file as `input_text` so Grok reads it line-by-line (best for source code); upload routes through the xAI Files API and is SHA-256 dedup-cached locally. `file_id` / `file_url` entries pass through unchanged and do not accept `mode`. Directory expansion via `{dir}` entries. See **[TECHNICAL.md: Grok files and cleanup](../../TECHNICAL.md#grok-files-and-cleanup)** for parameters, the inline-vs-upload tradeoff, cross-repo usage, cache layout, and the `gc` cleanup subcommand.

When `orientation.enabled` is true, the server auto-attaches a small bundle of high-signal repo files (CLAUDE.md, AGENTS.md, README.md, entrypoints - up to `maxFiles`, default 6) to Grok and OpenRouter calls that carry no files of their own, giving them the same repo grounding that Codex/Gemini get by walking the filesystem. Default OFF. See Key Design Decisions #8 and the Orientation auto-attach section in TECHNICAL.md.
