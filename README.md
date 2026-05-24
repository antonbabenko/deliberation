# Claude Delegator

GPT (Codex), Gemini, and Grok (xAI) expert subagents for Claude Code. Five specialists that can analyze AND implement: architecture, plan review, scope, code review, security. Use any of the three providers, single-shot or multi-turn, advisory or implementation (Grok is advisory-only).

[![License](https://img.shields.io/github/license/antonbabenko/claude-delegator?v=2)](LICENSE)
[![Stars](https://img.shields.io/github/stars/antonbabenko/claude-delegator?v=2)](https://github.com/antonbabenko/claude-delegator/stargazers)

![Claude Delegator in action](claude-delegator.png)

> Maintained fork of [`jarrodwatts/claude-delegator`](https://github.com/jarrodwatts/claude-delegator)
> (upstream currently inactive). Original work and MIT copyright by Jarrod
> Watts; this fork adds: a third provider (Grok via a bundled xAI bridge, with
> file attachments + storage cleanup), Gemini bridge timeout / trust-recovery /
> JSON-parsing robustness, `GEMINI_DEFAULT_MODEL` / `GROK_DEFAULT_MODEL` env
> overrides, and the bundled delegation commands below (the former `ask-both` is
> now `ask-all`, covering all three providers). Not an official continuation of
> the upstream project.

## Install

Inside a Claude Code instance, run the following commands:

**Step 1: Add the marketplace**
```
/plugin marketplace add antonbabenko/claude-delegator
```

**Step 2: Install the plugin**
```
/plugin install claude-delegator
```

**Step 3: Run setup**
```
/claude-delegator:setup
```

Done! Claude now routes complex tasks to your GPT (Codex), Gemini, and/or Grok experts automatically.

> **Note**: Requires at least one provider - [Codex CLI](https://github.com/openai/codex), [Gemini CLI](https://github.com/google/gemini-cli), or Grok (no CLI to install; just set `XAI_API_KEY`). Setup guides you through installation.

## Commands

Bundled with the plugin (available once installed):

| Command | Purpose |
|---------|---------|
| `/claude-delegator:setup` | Configure Codex/Gemini/Grok MCP servers + orchestration rules |
| `/claude-delegator:uninstall` | Remove MCP config, rules, and aliases |
| `/claude-delegator:ask-gpt` | One-shot GPT (Codex) second opinion |
| `/claude-delegator:ask-gemini` | One-shot Gemini second opinion |
| `/claude-delegator:ask-grok` | One-shot Grok (xAI) second opinion (advisory-only; can read attached files) |
| `/claude-delegator:ask-all` | GPT + Gemini + Grok in parallel, synthesized |
| `/claude-delegator:consensus` | Iterate GPT + Gemini + Grok + Claude to consensus |
| `/claude-delegator:grok-files` | List or prune Grok-uploaded files (storage cleanup) |

`/setup` can also install short aliases (`/ask-gpt`, `/ask-gemini`,
`/ask-grok`, `/ask-all`, `/consensus`, `/grok-files`) into `~/.claude/commands/` (opt-in; never
overwrites an existing same-named command). `/uninstall` removes an alias
only if it is byte-identical to the bundled copy, so an unrelated same-named
command you authored is left untouched.

---

## What is Claude Delegator?

Claude gains a team of GPT, Gemini, and Grok specialists via MCP: GPT through the Codex CLI's native MCP server, Gemini through the bundled Gemini MCP bridge, and Grok through a bundled bridge over the xAI HTTP API. Each expert has a distinct specialty and can advise OR implement (Grok is advisory-only).

**Note:** You can use any subset of the three providers (GPT, Gemini, Grok). The plugin auto-detects which are configured and routes accordingly.

### Features

- **Three providers, one interface** - GPT via the Codex CLI, Gemini and Grok via bundled zero-dependency Node bridges (Grok over the xAI HTTP API, advisory-only). Mix them or run just one.
- **Five domain experts** - Architect, Plan Reviewer, Scope Analyst, Code Reviewer, Security Analyst. Each has a dedicated system prompt in `prompts/`.
- **Advisory or implementation** - every expert runs read-only for analysis or `workspace-write` to apply fixes. Mode is auto-selected from your request.
- **Auto-routing** - Claude reads your message, picks the expert, and delegates. No manual selection needed; explicit "ask GPT/Gemini to..." also works.
- **Multi-turn chaining** - the initial call returns a `threadId`; follow-up `*-reply` calls preserve full context for iterative implementation and retries.
- **Synthesized output** - Claude interprets and applies judgment to expert results; raw provider text is never passed through verbatim.
- **Gemini bridge resilience** - soft-timeout drain that recovers disk-flushed answers (`recovered: true`), structured trust-failure errors the orchestration retries with `skip-trust` (or sets preflight), and hardened JSON parsing. `GEMINI_DEFAULT_MODEL` env overrides the model.
- **Grok bridge** - bundled zero-dependency Node bridge over the xAI **Responses API** (`/v1/responses`). Advisory-only (it cannot edit files) but it **can read attached files** - pass `files:[{path|file_id|file_url}]` and the bridge uploads to the xAI Files API and references them. Uploads are tagged `claude-delegator-*` and carry `expires_after` (default 7 days, `GROK_FILE_TTL_SECONDS`); prune early with `/grok-files`. Needs `XAI_API_KEY`; `GROK_DEFAULT_MODEL` (default `grok-4.3`) and `XAI_API_BASE` also override model/endpoint.
- **Bundled delegation commands** - `ask-gpt`, `ask-gemini`, `ask-grok`, `ask-all` (parallel + synthesized), and `consensus` (GPT + Gemini + Grok + Claude iterate to agreement) ship with the plugin.

| What You Get | Why It Matters |
|--------------|----------------|
| **5 domain experts** | Right specialist for each problem type |
| **GPT, Gemini, or Grok** | Use your preferred model provider(s) |
| **Dual mode** | Experts can analyze (read-only) or implement (write) |
| **Auto-routing** | Claude detects when to delegate based on your request |
| **Synthesized responses** | Claude interprets expert output, never raw passthrough |

### The Experts

| Expert | What They Do | Example Triggers |
|--------|--------------|------------------|
| **Architect** | System design, tradeoffs, complex debugging | "How should I structure this?" / "What are the tradeoffs?" |
| **Plan Reviewer** | Validate plans before you start | "Review this migration plan" / "Is this approach sound?" |
| **Scope Analyst** | Catch ambiguities early | "What am I missing?" / "Clarify the scope" |
| **Code Reviewer** | Find bugs, improve quality | "Review this PR" / "What's wrong with this?" |
| **Security Analyst** | Vulnerabilities, threat modeling | "Is this secure?" / "Harden this endpoint" |

### When Experts Help Most

- **Architecture decisions** - "Should I use Redis or in-memory caching?"
- **Stuck debugging** - After 2+ failed attempts, get a fresh perspective
- **Pre-implementation** - Validate your plan before writing code
- **Security concerns** - "Is this auth flow safe?"
- **Code quality** - Get a second opinion on your implementation

### When NOT to Use Experts

- Simple file operations (Claude handles these directly)
- First attempt at any fix (try yourself first)
- Trivial questions (no need to delegate)

---

## How It Works

```
You: "Is this authentication flow secure?"
                    ↓
Claude: [Detects security question → selects Security Analyst]
                    ↓
        ┌───────────────────────────────┐
        │  mcp__codex__codex /          │
        │  mcp__gemini__gemini /        │
        │  mcp__grok__grok              │
        │  → Security Analyst prompt    │
        │  → Expert analyzes your code  │
        └───────────────────────────────┘
                    ↓
Claude: "Based on the analysis, I found 3 issues..."
        [Synthesizes response, applies judgment]
```

**Key details:**
- Each expert has a specialized system prompt (in `prompts/`)
- Claude reads your request → picks the right expert → delegates via MCP (GPT, Gemini, or Grok)
- Responses are synthesized, not passed through raw
- Implementation retries up to 3 attempts total (1 initial + 2 `*-reply` retries), then escalates to you
- Multi-turn conversations preserve context via `threadId` for chained tasks

### Multi-Turn Conversations

For chained implementation steps, the expert preserves context across turns:

```
Turn 1: mcp__*__* → returns threadId
Turn 2: mcp__*__*-reply(threadId) → expert remembers turn 1
Turn 3: mcp__*__*-reply(threadId) → expert remembers turns 1-2
```

Use single-shot (`codex`, `gemini`, or `grok`) for advisory tasks. Use multi-turn for implementation chains and retries. (Grok is advisory-only.)

---

## Configuration

### Operating Modes

Every expert supports two modes based on the task:

| Mode | Sandbox | Use When |
|------|---------|----------|
| **Advisory** | `read-only` | Analysis, recommendations, reviews |
| **Implementation** | `workspace-write` | Making changes, fixing issues |

Claude automatically selects the mode based on your request.

### Configuration Defaults

**Codex (GPT):** set global defaults in `~/.codex/config.toml` instead of passing parameters on every call:

```toml
sandbox_mode = "workspace-write"
approval_policy = "on-failure"
```

Per-call parameters override these defaults. See [Codex CLI docs](https://github.com/openai/codex) for all config options.

**Gemini:** the bridge defaults to `gemini-2.5-flash` (it does not read the Gemini CLI's `~/.gemini/settings.json`). Override per call with the `model` parameter, or globally with the `GEMINI_DEFAULT_MODEL` environment variable - set this if you want a different default model.

**Grok:** the bridge defaults to `grok-4.3`. Override per call with the `model` parameter, or globally with `GROK_DEFAULT_MODEL`. The endpoint defaults to `https://api.x.ai/v1`; override with `XAI_API_BASE`. Grok needs `XAI_API_KEY` in the bridge's environment and is advisory-only (it can read attached files, but cannot edit them).

**Reasoning effort** is controllable: the bridge sends a `reasoning_effort` on every `/v1/responses` call, defaulting to **`high`**. Override per call with the `reasoning_effort` parameter, or globally with the `GROK_REASONING_EFFORT` env var (for example `low`, `medium`, `high`); set it to `none` (or `off`) to omit the field entirely and let the model use its own default. Valid values depend on the chosen model - an unsupported value surfaces the xAI API error verbatim. Uploaded files auto-expire after `GROK_FILE_TTL_SECONDS` (default `604800` = 7 days, clamped 1h..30d); prune early with `/grok-files`.

### Manual MCP Setup

If `/setup` doesn't work, register the MCP server(s) manually:

```bash
# For Codex (GPT)
# Idempotent: safe to rerun
claude mcp remove codex >/dev/null 2>&1 || true
claude mcp add --transport stdio --scope user codex -- codex -m gpt-5.3-codex mcp-server

# For Gemini
# Idempotent: safe to rerun
claude mcp remove gemini >/dev/null 2>&1 || true
claude mcp add --transport stdio --scope user gemini -- node ${CLAUDE_PLUGIN_ROOT}/server/gemini/index.js

# For Grok (xAI) - API-based, advisory-only. Needs XAI_API_KEY.
# Idempotent: safe to rerun. --env persists the key in ~/.claude.json (plaintext);
# omit it if you prefer to export XAI_API_KEY in Claude Code's launch environment.
claude mcp remove grok >/dev/null 2>&1 || true
claude mcp add --transport stdio --scope user grok --env XAI_API_KEY="$XAI_API_KEY" -- node ${CLAUDE_PLUGIN_ROOT}/server/grok/index.js
```

Verify with:

```bash
claude mcp list
printf '{"jsonrpc":"2.0","id":"health","method":"initialize","params":{}}\n' | node ${CLAUDE_PLUGIN_ROOT}/server/gemini/index.js
printf '{"jsonrpc":"2.0","id":"health","method":"initialize","params":{}}\n' | node ${CLAUDE_PLUGIN_ROOT}/server/grok/index.js
```

### Customizing Expert Prompts

Expert prompts live in `prompts/`. Each follows the same structure:
- Role definition and context
- Advisory vs Implementation modes
- Response format guidelines
- When to invoke / when NOT to invoke

Edit these to customize expert behavior for your workflow.

---

## Requirements

You need at least one of the following providers configured:

- **Codex CLI** (for GPT): `npm install -g @openai/codex`
- **Gemini CLI** (for Gemini): `npm install -g @google/gemini-cli`
- **Grok (xAI)**: no CLI to install - the bridge ships with the plugin (needs Node 18+). Just set `XAI_API_KEY` (get a key at https://console.x.ai). Advisory-only.

**Authentication**:
- Codex: run `codex login`
- Gemini: run `gemini` once and complete the sign-in flow (or set `GOOGLE_API_KEY`)
- Grok: `export XAI_API_KEY=xai-...`

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| MCP server not found | Restart Claude Code after setup |
| Provider not authenticated | Codex: run `codex login`. Gemini: run `gemini` once to complete sign-in (or set `GOOGLE_API_KEY`). Grok: export `XAI_API_KEY` (else calls return `errorKind: missing-auth`) |
| Tool not appearing | Run `claude mcp list` and verify registration |
| Expert not triggered | Try explicit: "Ask GPT to review...", "Ask Gemini to review...", or "Ask Grok to review..." |
| Gemini blocked by trust check | The bridge returns `errorKind: "trust"` with `hint: "skip-trust"`. The orchestrator auto-retries the call once with `skip-trust: true` and prints a notice. To opt in up front, pass `"skip-trust": true` on the call. |

### Untrusted directories

The Gemini CLI refuses to run from a directory it has not been told to trust (entries live in `~/.gemini/trustedFolders.json`). When that happens the bridge surfaces a structured signal:

```json
{
  "content": [{ "type": "text", "text": "Error: <message>" }],
  "isError": true,
  "errorKind": "trust",
  "retryable": true,
  "hint": "skip-trust"
}
```

`content` (the MCP text payload) is always present; `hint` is included only
when set. Other failures use the same envelope with a different `errorKind`
(e.g. `timeout`).

The orchestration rules (`rules/orchestration.md` -> "Trust Failure Recovery") instruct Claude to retry the same call once with `"skip-trust": true`, preserving `threadId` for `gemini-reply`. A second consecutive trust failure (when `skip-trust: true` was already set) escalates to the user instead of looping.

Callers that already know they want to bypass the trust check can pass `"skip-trust": true` from the start.

### Timeouts and recovery

`timeout` is a **soft** deadline (default 300000ms; Gemini 3 deep prompts run
200-260s). The Gemini CLI ignores SIGTERM and persists its full answer to disk at
`~/.gemini/tmp/<slug>/chats/session-*.jsonl` regardless. When the soft timeout
fires the bridge does not fail immediately: it drains - keeps Gemini alive and
polls that jsonl for a record newer than the call's start - for up to
`recovery-grace` ms (default 120000, range 0..600000). If the answer appears it is
returned as a normal success with a top-level `"recovered": true` flag and a
stderr log line; `content` is unmodified so response parsers keep working. If the
grace budget is exhausted with no answer, the call fails with the usual
`errorKind: "timeout"` (still `retryable`).

- `"recovery-grace": 0` disables the drain (immediate legacy timeout).
- `GEMINI_DISABLE_TIMEOUT_RECOVERY=1` (env) forces full legacy behavior.
- The call resolves within `timeout + recovery-grace`. The Gemini child
  process is then killed `SIGTERM`, with a `SIGKILL` ~1s later; that kill is
  async cleanup and does not delay the response.

Manual recovery (any session, even without this plugin): find the project slug
under `~/.gemini/tmp/` (its `.project_root` file holds the absolute cwd), then in
that slug's `chats/` open the newest `session-*.jsonl`; the last record with
`"type":"gemini"` has the full answer in `.content`.

Known limitation: heavy parallel calls from the same cwd (e.g. `ask-all`,
`consensus`) can race on "newest session file". A spawn-start timestamp guard
(2000ms skew tolerance) makes mis-attribution unlikely but not impossible.

---

## Development

```bash
git clone https://github.com/antonbabenko/claude-delegator
cd claude-delegator

# Test locally without reinstalling
claude --plugin-dir /path/to/claude-delegator
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

---

## Acknowledgments

Expert prompts adapted from [oh-my-opencode](https://github.com/code-yeongyu/oh-my-opencode) by [@code-yeongyu](https://github.com/code-yeongyu).

---

## License

MIT - see [LICENSE](LICENSE)

---

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=antonbabenko/claude-delegator&type=Date&v=2)](https://star-history.com/#antonbabenko/claude-delegator&Date)
