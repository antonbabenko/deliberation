# deliberation and PAL

[PAL MCP server](https://github.com/BeehiveInnovations/pal-mcp-server) (formerly Zen MCP) and
deliberation solve a similar problem: your coding agent asks other models for help over MCP.
PAL covers more providers and has more tools. deliberation is smaller and focuses on
cross-model review, with rules that keep the orchestrating agent from approving its own plan.

Already on PAL? The [migration guide](migrate-from-pal.md) maps tools and settings.

## PAL at a glance

As of 2026-11-17, from the GitHub API and PAL's README:

- 11,842 GitHub stars, Apache-2.0 (the license in its `LICENSE` file).
- Latest release v9.8.2, published 2025-12-15. The last push to the repository was also on
  2025-12-15.
- Python 3.10+. Install with `git clone` and `./run-server.sh`, or with `uvx` in an MCP config.
- Providers: Gemini, OpenAI, Azure OpenAI, X.AI (Grok), OpenRouter, DIAL, Ollama and other
  custom OpenAI-compatible endpoints. A provider turns on when its key is in `.env`.
- Tools enabled by default: `clink`, `chat`, `thinkdeep`, `planner`, `consensus`, `codereview`,
  `precommit`, `debug`, `apilookup`, `challenge`. Disabled by default to save context: `analyze`,
  `refactor`, `testgen`, `secaudit`, `docgen`, `tracer`.

## Where PAL is the better fit

- **Provider breadth.** Azure OpenAI and DIAL have no deliberation equivalent. PAL calls the
  OpenAI and Gemini APIs with keys; deliberation needs the `codex` and `agy` CLIs for those two.
- **Code from capable models.** PAL's `chat` can return complete code from capable models.
  deliberation's experts are prompted to advise; only Gemini, through the Claude Code plugin, can
  edit files itself.
- **Tool range.** `clink` starts other AI CLIs (Gemini CLI, Codex CLI, Claude Code) as subagents
  with their own context. `precommit`, `refactor`, `testgen`, `docgen`, `tracer`, `apilookup` and
  `challenge` have no dedicated deliberation tool.
- **Vision.** PAL sends images to models that accept them. deliberation is text only.
- **Long threads.** PAL carries a conversation across tools and models, and can revive Claude's
  context after a reset ("continue with O3"). deliberation keeps follow-up threads only for
  Gemini, Grok and OpenRouter in the Claude Code plugin, and they are lost on restart.
- **Large prompts.** PAL works around the MCP prompt size limit. deliberation relies on each
  provider's context window.
- **Adoption.** PAL has 11,842 GitHub stars and deliberation has 184 (both as of
  2026-11-17).

## Where deliberation is the better fit

- **Consensus that guards against the orchestrator.** In `/consensus`, the agent that runs the
  loop also votes and decides which objections count, so it could pass its own plan. These rules
  stop that:
  - The agent records its verdict before the panel answers, and the engine holds the panel back
    until it does.
  - A round converges only when at least `consensus.quorumFloor` models answer (default 2), every
    one of them approves, no accepted critical issue is left, and the agent approves too.
  - Every dismissed issue needs a written reason, and the engine rejects a dismissal without one.

  The loop stops at `consensus.maxRounds` (default 5). PAL's `consensus` assigns stances (for,
  against, neutral) and the agent combines the answers.
- **Disagreement you can read.** `/ask-all` returns each model's answer separately and the
  synthesis lists where they agree and where they split.
- **CLI logins instead of API keys.** GPT runs through `codex exec` and Gemini through `agy`, so
  those calls use your CLI logins and plans instead of separate API keys.
- **Live config.** Model records, routing and the OpenRouter block in
  `~/.config/deliberation/config.json` take effect without a restart. Each record says whether it
  joins `ask-all` and `consensus`, and which experts it serves.
- **Packaging.** A Claude Code plugin from a marketplace, an npm package
  (`@antonbabenko/deliberation-mcp`, Node 18+), and native plugins for Codex, Cursor, Kiro,
  Antigravity, Gemini CLI and OpenCode.
- **Measuring the panel.** An opt-in debug log, saved runs, the `analyze` tool (latency, tokens and
  verdict agreement per model) and a local read-only dashboard help you drop models that add
  little.

## Side by side

| | PAL | deliberation |
|-|-----|--------------|
| License | Apache-2.0 | MIT |
| Language | Python | JavaScript, no runtime dependencies |
| Install | `git clone` + `./run-server.sh`, or `uvx` | Claude Code plugin, `npx -y @antonbabenko/deliberation-mcp`, native host plugins |
| GPT | OpenAI API key | Codex CLI login |
| Gemini | Gemini API key | Antigravity CLI login |
| Grok | `XAI_API_KEY` | `XAI_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY`, models in `conf/openrouter_models.json` | `OPENROUTER_API_KEY`, models as records in `config.json` |
| Local models | Custom endpoint (Ollama, vLLM, LM Studio) | Ollama and LM Studio providers; other endpoints through `providers.openrouter.apiBase` |
| Azure OpenAI, DIAL | Yes | No |
| Vision | Yes | No |
| Code | Any capable model returns code for your agent to apply | Any provider can return code as text; only Gemini (Claude Code plugin) edits files itself |
| Consensus | Stances per model, agent combines | Blind verdict first, no self-approval, reasons for every dismissal, round cap |
| Parallel answers | Through `consensus` | `ask-all` |
| Personas | One system prompt per tool | Eight experts usable with any provider |
| Pre-commit check | `precommit` | Run `code-reviewer` or `/consensus` on the diff |
| CLI subagents | `clink` | No |
| Config changes | Edit `.env`, restart | Model records, routing and the OpenRouter block reload live |

## Using both

The two servers register under different server names, so you can keep both. One way to split
the work: PAL for `clink`, `precommit`, vision and Azure, and deliberation for `/consensus` and
`/ask-all` reviews.
