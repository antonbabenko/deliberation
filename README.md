# Claude Delegator

GPT (Codex), Gemini, and Grok (xAI) expert subagents for Claude Code. Six specialists that can analyze and implement: architecture, plan review, scope, code review, security, and external research. Use any of the three providers, single-shot or multi-turn, advisory or implementation.

[![License](https://img.shields.io/github/license/antonbabenko/claude-delegator?v=2)](LICENSE)
[![Stars](https://img.shields.io/github/stars/antonbabenko/claude-delegator?v=2)](https://github.com/antonbabenko/claude-delegator/stargazers)

![Claude Delegator in action](claude-delegator.png)

## What is Claude Delegator?

Claude gains a team of GPT, Gemini, and Grok specialists over MCP: GPT through the Codex CLI's native MCP server, Gemini through a bundled MCP bridge, and Grok through a bundled bridge over the xAI HTTP API. Each expert has a distinct specialty and can advise or implement.

You can use any subset of the three providers. The plugin detects which are configured and routes accordingly.

| What you get | Why it matters |
|--------------|----------------|
| 6 domain experts | The right specialist for each problem type |
| GPT, Gemini, or Grok | Use your preferred provider(s) |
| Dual mode | Experts analyze (read-only) or implement (write) |
| Auto-routing | Claude detects when to delegate from your request |
| Synthesized responses | Claude interprets expert output, never raw passthrough |

## Install

Inside a Claude Code instance, run:

**1. Add the marketplace - [antonbabenko/agent-plugins](https://github.com/antonbabenko/agent-plugins)**
```
/plugin marketplace add antonbabenko/agent-plugins
```

**2. Install the plugin**
```
/plugin install claude-delegator@antonbabenko
```

**3. Run setup**
```
/claude-delegator:setup
```

Claude now routes complex tasks to your GPT, Gemini, and Grok experts.

The canonical marketplace is [`antonbabenko/agent-plugins`](https://github.com/antonbabenko/agent-plugins) (above), which also bundles the other plugins.

## Commands

Bundled with the plugin (available once installed):

| Command | Purpose |
|---------|---------|
| `/claude-delegator:setup` | Configure Codex/Gemini/Grok MCP servers + orchestration rules |
| `/claude-delegator:consensus` | 🔥🔥🔥 Arbiter-mediated GPT + Gemini + Grok + Claude convergence loop |
| `/claude-delegator:ask-all` | 🔥 GPT + Gemini + Grok in parallel, synthesized |
| `/claude-delegator:ask-gpt` | One-shot GPT (Codex) second opinion |
| `/claude-delegator:ask-gemini` | One-shot Gemini second opinion |
| `/claude-delegator:ask-grok` | One-shot Grok (xAI) second opinion (advisory-only) |
| `/claude-delegator:uninstall` | Remove MCP config, rules, and aliases |
| `/claude-delegator:grok-files` | List or prune Grok-uploaded files (storage cleanup) |

`/setup` can also install short aliases (`/ask-gpt`, `/ask-gemini`, `/ask-grok`, `/ask-all`, `/consensus`, `/grok-files`) into `~/.claude/commands/`. This is opt-in. Existing same-named commands are kept by default; setup asks before overwriting any of them. `/uninstall` removes an alias only if it is byte-identical to the bundled copy.

## The Experts

| Expert | What they do | Example triggers |
|--------|--------------|------------------|
| **Architect** | System design, tradeoffs, complex debugging | "How should I structure this?" / "What are the tradeoffs?" |
| **Plan Reviewer** | Validate plans before you start | "Review this migration plan" / "Is this approach sound?" |
| **Scope Analyst** | Catch ambiguities early | "What am I missing?" / "Clarify the scope" |
| **Code Reviewer** | Find bugs, improve quality | "Review this PR" / "What's wrong with this?" |
| **Security Analyst** | Vulnerabilities, threat modeling | "Is this secure?" / "Harden this endpoint" |
| **Researcher** | External libraries, docs, best practices | "How do I use X?" / "Find examples of Y" |

### When experts help most

- **Architecture decisions** - "Should I use Redis or in-memory caching?"
- **Stuck debugging** - after two or more failed attempts, get a fresh perspective
- **Pre-implementation** - validate a plan before writing code
- **Security concerns** - "Is this auth flow safe?"
- **Code quality** - a second opinion on your implementation

### When not to use experts

- Simple file operations (Claude handles these directly)
- First attempt at any fix (try yourself first)
- Trivial questions (no need to delegate)

## How to Use

Describe your task. Claude detects when an expert helps and delegates automatically:

```
You: "Is this authentication flow secure?"
Claude: routes to the Security Analyst, then synthesizes the findings.
```

You can also ask explicitly: "Ask GPT to review this architecture", "Ask Gemini to...", or "Ask Grok to...". Each expert runs read-only for analysis or with write access to apply fixes, and Claude picks the mode from your request.

The bundled commands give you direct control: `/ask-gpt`, `/ask-gemini`, `/ask-grok`, `/ask-all` (all three in parallel, synthesized), and `/consensus` (arbiter-mediated: the providers vote, Claude commits a blind verdict and adjudicates to agreement).

## How It Works

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

For the bridge internals, retry behavior, and recovery paths, see [TECHNICAL.md](TECHNICAL.md).

## Bias hardening (consensus + ask-*)

`/consensus` has a built-in conflict of interest: Claude writes the review prompt, casts a vote, decides which objections are real, and runs the loop. Left alone, an orchestrator like that can quietly rubber-stamp its own plan. Four guards stop that:

- **Blind verdict.** Claude posts its own verdict (APPROVE / REQUEST CHANGES / REJECT) in a message sent *before* the one that calls the models. The pre-commitment is right there in the transcript, so Claude cannot reshape its opinion after seeing the panel.
- **Arbiter-mediated, not majority vote.** The external models vote; Claude adjudicates and rewrites the plan between rounds. The command says so plainly instead of dressing it up as a democratic tally.
- **No self-approval.** A round converges only when every responding external approves and at least one external actually answered. Claude's own approval never carries a round by itself. A provider that errors (an unconfigured Grok returning `missing-auth`, for example) drops out of the count instead of jamming the loop.
- **No silent dismissal.** Every critical issue that gets dismissed or deferred ships with a one-line reason in the final report, including the times Claude walks back one of its own blind objections.

The single and parallel commands carry a lighter version of the same rule. `/ask-gpt`, `/ask-gemini`, `/ask-grok`, and `/ask-all` each state that the external model only advises: Claude reads the output, applies its own judgment, and owns the synthesized answer. When the models agree, that is input, not a verdict.

## Configuration

Every expert supports two modes, chosen automatically from your request:

| Mode | Sandbox | Use when |
|------|---------|----------|
| Advisory | `read-only` | Analysis, recommendations, reviews |
| Implementation | `workspace-write` | Making changes, fixing issues |

Common defaults:

- Codex (GPT) reads `~/.codex/config.toml` for its sandbox and approval defaults.
- Gemini (via the Antigravity CLI `agy`) defaults to `auto-gemini-3`. The model is read from `~/.gemini/settings.json` (`model.name`); there is no per-call model flag (the MCP `model` param is advisory). Override the bridge default with `GEMINI_DEFAULT_MODEL`, or point at a different `agy` binary with `AGY_BIN`.
- Grok defaults to `grok-4.3` and needs `XAI_API_KEY`; override with `GROK_DEFAULT_MODEL`.

For the full environment-variable reference and manual MCP setup, see [TECHNICAL.md](TECHNICAL.md#environment-variables).

## Requirements

You need at least one provider:

- **Codex CLI** (GPT): `npm install -g @openai/codex`, then `codex login`.
- **Antigravity CLI**: [Getting Started with Antigravity CLI](https://antigravity.google/docs/cli-getting-started) and [Migrating from Gemini CLI](https://antigravity.google/docs/gcli-migration), then run `agy` and login.
- **Grok (xAI)**: no CLI to install; the bridge ships with the plugin (needs Node 18+). Set `XAI_API_KEY` (get a key at https://console.x.ai).

## Troubleshooting

| Issue | Solution |
|-------|----------|
| MCP server not found | Restart Claude Code after setup |
| Provider not authenticated | Codex: `codex login`. Gemini: run `agy` once (or set `GOOGLE_API_KEY`). Grok: export `XAI_API_KEY` (else calls return `errorKind: missing-auth`) |
| Tool not appearing | Run `claude mcp list` and verify registration |
| Expert not triggered | Ask explicitly: "Ask GPT to review...", "Ask Gemini to review...", or "Ask Grok to review..." |
| Gemini writes don't land in the workspace | Expected: `agy` print mode writes to a scratch dir, so Gemini-via-agy is advisory-effective (great for analysis and review, but it cannot mutate the real workspace). Use Codex for implementation. |

`agy` print mode does not enforce folder trust, so there is no trust prompt to clear. Soft-timeout recovery (stdout-drain) is documented in [TECHNICAL.md](TECHNICAL.md#gemini-timeout-recovery).

## Contributing

Contributions welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow, commit conventions, and the automated release process. To work on the plugin locally:

```bash
git clone https://github.com/antonbabenko/claude-delegator
cd claude-delegator

# Test locally without reinstalling
claude --plugin-dir /path/to/claude-delegator
```

## Credits

Claude Delegator started as a fork of [jarrodwatts/claude-delegator](https://github.com/jarrodwatts/claude-delegator) - credit to Jarrod Watts for the original solution and inspiration. Original work and MIT copyright are retained. This fork adds Grok support, Gemini bridge reliability (timeout and trust recovery), provider configuration overrides, and the bundled delegation commands. It is not an official continuation of the upstream project.

Expert prompts are adapted from [oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent) (snapshot `03eb9fff`, 2026-05-25).

## License

MIT - see [LICENSE](LICENSE)
