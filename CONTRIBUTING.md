# Contributing to deliberation

Contributions welcome. This document covers how to contribute effectively.

---

## Quick Start

```bash
# Clone the repo
git clone https://github.com/antonbabenko/deliberation
cd deliberation

# Run every check (typecheck + all test suites)
npm run check

# Claude Code: load the plugin from this checkout without reinstalling
claude --plugin-dir /path/to/deliberation

# Any other MCP host (Codex, Cursor, Kiro, Antigravity, OpenCode, ...):
# point its MCP config at the server in this checkout
node /path/to/deliberation/server/mcp/index.js
```

Agent instructions for working on this repo (any coding agent) are in [AGENTS.md](AGENTS.md).

---

## What to Contribute

| Area | Examples |
|------|----------|
| **New Providers** | Ollama, Mistral, local model integrations |
| **Role Prompts** | New roles for `prompts/`, improved existing prompts |
| **Rules** | Better delegation triggers, model selection logic |
| **Bug Fixes** | Command issues, error messages |
| **Documentation** | README improvements, examples, troubleshooting |

---

## Project Structure

```
deliberation/
├── core/                   # Host-neutral engine: providers, orchestration, consensus loop
├── server/                 # MCP server (server/mcp), provider bridges, local dashboard
├── prompts/                # Expert personas
├── rules/                  # Delegation rules (installed to ~/.claude/rules/ by the Claude Code plugin)
├── commands/               # Claude Code slash commands
├── config/                 # Config schema + defaults
├── scripts/                # sync-hosts.js (generates per-host files) and helpers
├── docs/                   # Tool guide, per-host docs, developer docs (docs/dev/)
├── .claude-plugin/         # Claude Code plugin manifest
├── AGENTS.md               # Instructions for coding agents working on this repo
└── README.md               # User-facing docs
```

Details: [docs/dev/architecture.md](docs/dev/architecture.md).

---

## Pull Request Process

### Before Submitting

1. **Test your changes** - `npm run check`, then try the change through a real MCP host
2. **Update docs** - If you change behavior, update relevant docs
3. **Keep commits atomic** - One logical change per commit

### PR Guidelines

| Do | Don't |
|----|-------|
| Focus on one change | Bundle unrelated changes |
| Write clear commit messages | Leave vague descriptions |
| Test with actual MCP calls | Assume it works |
| Update docs (see the checklist in AGENTS.md) | Ignore developer docs |

### Commit Message Format

```
type: short description

Longer explanation if needed.
```

| Prefix | Version bump |
|--------|--------------|
| `feat!:` or `BREAKING CHANGE:` | Major |
| `feat:` | Minor |
| `fix:` | Patch |
| `docs`, `refactor`, `build`, `chore`, `style`, `test`, `ci`, `perf` | None |

Only `feat:`, `fix:` and breaking changes cut a release. A push that contains only the other
types produces an empty changelog and is skipped; those commits ship with the next release.

Examples:
- `feat: add Ollama provider support`
- `fix: handle Codex timeout correctly`
- `docs: add troubleshooting for auth issues`

---

## Release Process

Releases are automated from [Conventional Commits](https://www.conventionalcommits.org/).
You never bump versions by hand.

1. Merge a PR to `master`.
2. The release workflow reads the commits since the last release and computes the next
   version (`feat:` -> minor, `fix:` -> patch, `feat!:` / `BREAKING CHANGE:` -> major).
3. It opens a `chore(release): vX.Y.Z` PR that updates `version.json`, `CHANGELOG.md`, and
   the synced manifests, then auto-merges it once the `validate` check passes.
4. On merge, a second workflow tags `vX.Y.Z` and publishes the GitHub Release.
5. The `antonbabenko/agent-plugins` marketplace then re-pins `deliberation` to the new
   release (immediately if its dispatch token is set, otherwise within a day via cron).

`version.json` is the single source of truth. `.claude-plugin/plugin.json`,
`.claude-plugin/marketplace.json`, `package.json`, `server.json` (both version lines),
`server/mcp/package.json`, `plugins/deliberation/.codex-plugin/plugin.json`, and the
`serverInfo.version` literal in `server/mcp/index.js` are kept in sync by CI
(`.github/release/pre-commit.js`). Do not edit those version fields by hand - the `validate`
check fails if they drift.

---

## Adding a New Provider

First decide whether you need code at all.

### OpenAI-compatible endpoint: config only

Any endpoint that serves `POST /chat/completions` (Ollama, LM Studio, Mistral, DeepSeek, a
self-hosted vLLM, ...) runs through the OpenRouter transport with no code change. OpenRouter
is off by default, so enable it and declare a model record in
`~/.config/deliberation/config.json`:

```json
{
  "providers": {
    "openrouter": { "enabled": true, "apiBase": "http://127.0.0.1:11434/v1" }
  },
  "models": {
    "local-qwen": { "provider": "openrouter", "model": "qwen2.5-coder:32b", "askAll": true }
  }
}
```

Where the endpoint comes from depends on the server:

- The unified `deliberation` server (every non-Claude host, and `ask-all` / `consensus`)
  uses ONE endpoint for every record: `providers.openrouter.apiBase`, read at startup
  (restart the server after changing it). It always reads the key from `OPENROUTER_API_KEY`.
- The standalone `deliberation-openrouter` bridge (Claude Code's `/ask-openrouter`) also
  honours a per-record `apiBase` and `providers.openrouter.apiKeyEnv`.

Either way the key is sent to that endpoint whenever the variable is set (an
`Authorization` header is added only when it is), so point `apiBase` only at endpoints you
trust with it. Record fields: `config/config.schema.json` (`modelRecord`) and
[TECHNICAL.md](TECHNICAL.md#openrouter-bridge).

### New transport: a built-in provider

Use this when the provider needs its own CLI, protocol, or file handling. Codex
(`core/providers/codex.js`, spawns a CLI), Grok (`core/providers/grok.js` +
`server/grok/`, HTTP bridge) and Gemini (`core/providers/antigravity.js` + `server/gemini/`)
are the working examples. Read [docs/dev/architecture.md](docs/dev/architecture.md) first,
and the matching entries in [docs/dev/design-decisions.md](docs/dev/design-decisions.md)
(timeouts, retries, stub answers, CLI resolution).

1. **Adapter** - `core/providers/<name>.js` returns a `Provider` (`core/types.js`): `name`,
   `capabilities` (`canImplement: false` unless it can write behind both implement locks),
   `health()` and `ask(req)`. `health()` is stat-only and side-effect-free: report a missing
   CLI or key as `{ ok: false, reason }` so the panel skips the peer. `ask()` returns a
   `DelegationResult` and never throws; turn failures into results with `toErrorResult`
   (`core/provider.js`) and a correct `errorKind`, because `callProvider` retries
   `network`, `rate-limit`, `upstream` and `empty` once, and the circuit breaker counts
   every error. Core never reads config or a bridge directly: take both through `opts`.
2. **Shared rules every adapter or bridge applies** - prepend `groundingNote()`
   (`core/grounding.js`) to the prompt; clamp every ceiling with `clampToHostBudget`
   (`core/host-budget.js`) and honour `req.hostBudgetRemainingMs`; reject preamble-only
   replies with `stubReason` (`core/answer-floor.js`); resolve a CLI with
   `core/resolve-bin.js`, never `shell: true`.
3. **Bridge** (HTTP or a CLI that needs its own MCP server) - `server/<name>/index.js`,
   zero dependencies. Register it in `.claude-plugin/plugin.json` `mcpServers` only if it
   should also run as a standalone server, with the same `timeout` and `MCP_TOOL_TIMEOUT`
   pair the other entries carry (`test/plugin-manifest.test.js` checks them).
4. **Wire it in** - construct it in `makeRuntime` in `server/mcp/index.js` (read
   `providers.<name>` config there), then add the name to:
   - `BUILTINS` in `core/registry.js` (panel selection)
   - `BUILTIN_NAMES`, `ASK_PROVIDER` and `ASK_AUTH` in `server/mcp/index.js` (plus an
     `ask-<name>` tool if it gets one)
   - `KNOWN_PROVIDERS` and, if it can arbitrate, `BUILTIN_ARBITERS` in
     `server/openrouter/config.js` (timeout ladder and arbiter validation)
   - `core/settings.js` and `core/analyze.js` defaults, the provider lists in
     `core/config-history.js` (config provenance), and `FIXED_KEY_ENVS` in
     `server/dashboard/server.js` if it reads a fixed key env

   `rg -n '"grok"' core server --glob '!**/dist/**'` finds every list a built-in appears in;
   a new one belongs in each.
5. **Config** - add `providers.<name>` to `config/config.schema.json` AND
   `config/config.default.json`. State any threat model (where keys or files go) in the
   schema description.
6. **Tests** - an adapter test like `test/core-grok.test.js` (inject a fake bridge or CLI
   via `CODEX_BIN`/`AGY_BIN`-style overrides; no network) and a registry case in
   `test/core-registry.test.js`. `npm run check` must pass.
7. **Host surfaces and docs** - `commands/setup.md` and `commands/doctor.md` (detect the CLI
   or key), an `/ask-<name>` command if it gets a tool, the docs checklist in
   [AGENTS.md](AGENTS.md), then `npm run sync`.

---

## Code Style

### Markdown (Rules/Prompts)

- Use tables for structured data
- Keep prompts concise and actionable
- Test with a real MCP host

### JavaScript

- Plain CommonJS on Node, no runtime dependencies (esbuild is a build-time devDep for the npm bundle only)
- `core/**` and `server/mcp/**` are type-checked (`tsconfig.json`, strict `checkJs`): give
  exported functions JSDoc parameter and return types
- No `any` without explicit justification; no `@ts-ignore` or `@ts-expect-error`

---

## Testing

### Manual Testing

After changes, verify with actual MCP calls:

1. Load this checkout in an MCP host (see Quick Start)
2. Claude Code only: run `/deliberation:setup`
3. Verify the tools are listed (`ask-gpt`, `ask-all`, `consensus`, ...)
4. Call a few tools, including an expert (`architect`, `code-reviewer`)
5. Verify responses are properly synthesized
6. Test error cases (timeout, missing CLI)

---

## Questions?

Open an issue for:
- Feature requests
- Bug reports
- Documentation gaps
- Architecture discussions
