# Coming from Zen or PAL

This guide is for people who use [PAL MCP server](https://github.com/BeehiveInnovations/pal-mcp-server)
(formerly Zen MCP) and want to try deliberation. It maps PAL tools to deliberation tools and
commands, translates PAL's `.env` settings into deliberation's `config.json`, and lists what
deliberation does differently or does not do.

Both are MCP servers registered under different server names, so you can register both in the
same host and try deliberation next to PAL. For a side-by-side view of the two
projects, see [deliberation and PAL](pal.md).

Facts about PAL on this page come from its README, `.env.example` and tool docs as of
2026-11-17.

## Install next to PAL

Claude Code:

```
/plugin marketplace add antonbabenko/agent-plugins
/plugin install deliberation@antonbabenko
/deliberation:setup
```

Any other MCP host: add a second server entry next to the `pal` entry.

```json
{
  "mcpServers": {
    "deliberation": {
      "command": "npx",
      "args": ["-y", "@antonbabenko/deliberation-mcp"],
      "env": {
        "XAI_API_KEY": "xai-...",
        "OPENROUTER_API_KEY": "sk-or-v1-..."
      }
    }
  }
}
```

Run `/deliberation:doctor` in Claude Code, or call the `panel` tool on other hosts, to see
which providers are ready.

## Tools and concepts

PAL tools are on the left. On the right are the deliberation tool (any MCP host) and the Claude
Code command, where one exists.

| PAL | deliberation | Notes |
|-----|--------------|-------|
| `chat` | `ask-gpt`, `ask-gemini`, `ask-grok`, `ask-openrouter`, `ask-one`; `/deliberation:ask-gpt` and the other `ask-*` commands | One question to one provider. To call one model record, pass its panel name to `ask-one` as `provider`, for example `openrouter:<id>` or `ollama:<id>`; `panel` lists the names. |
| `consensus` | `ask-all` or `consensus` / `consensus-step`; `/deliberation:ask-all`, `/deliberation:consensus` | `ask-all` sends one prompt to the panel in parallel and keeps the answers separate. `/consensus` runs a multi-round review loop until the panel agrees or a round cap is hit. There is no per-model stance (for, against, neutral): every model gets the same prompt. |
| `thinkdeep` | `architect` expert, or any `ask-*` with a higher reasoning effort | Set effort per provider (`providers.codex.reasoningEffort`, `providers.grok.reasoningEffort`) or per model record (`reasoningEffort`). |
| `planner` | `plan-reviewer` and `scope-analyst` experts | deliberation does not write plans. Your agent writes the plan; these experts check it. |
| `codereview` | `code-reviewer` expert | Pass the diff or file paths in the prompt. |
| `precommit` | no dedicated tool | Ask the `code-reviewer` expert, or run `/deliberation:consensus`, on `git diff` output. |
| `debug` | `debugger` expert | Returns ranked hypotheses and the smallest fix. |
| `secaudit` | `security-analyst` expert | |
| `apilookup` | `researcher` expert | Grok and OpenRouter models have no retrieval tools here; they answer from model knowledge and mark claims `[unverified]`. |
| `analyze` (code analysis) | `architect` or `code-reviewer` expert | deliberation also has a tool named `analyze`, but it does something else: it reports latency, tokens and verdict agreement from your own past runs. |
| `refactor`, `testgen`, `docgen`, `tracer` | no equivalent | |
| `challenge` | no dedicated tool | `/consensus` has rules against an agent approving its own plan (see below), which covers a related problem. |
| `clink` | no equivalent | deliberation calls `codex exec` and `agy` for one answer each, not interactive CLI subagents. For a Codex subagent in Claude Code, see [the Codex plugin page](codex-plugin.md). |
| `listmodels` | `panel` tool, `/deliberation:doctor` | `panel` lists the providers a fan-out would call and the ones that cannot answer right now. |
| `continuation_id` threads | `threadId` on the `gemini-reply`, `grok-reply` and `openrouter-reply` tools (Claude Code plugin) | GPT calls are single-shot. Threads live in memory and are lost when the server restarts. |
| Context revival ("continue with O3") | no equivalent | |
| Vision (images) | no equivalent | deliberation sends text only. |

deliberation adds eight expert personas that apply to any provider: Architect, Plan Reviewer,
Scope Analyst, Code Reviewer, Security Analyst, Researcher, Debugger and Writing Editor. Call an
expert as a tool (`code-reviewer`), or pass `expert` to `ask-all` and `consensus` to apply one
persona to every model on the panel.

## Configuration

PAL reads provider keys and options from `.env` or the `env` block of its MCP entry. deliberation
reads provider keys from the environment, and its own settings from
`~/.config/deliberation/config.json` (Windows: `%APPDATA%\deliberation\config.json`; override the
path with `DELIBERATION_CONFIG`). To write a starter file:

```bash
npx -y --package @antonbabenko/deliberation-mcp deliberation-setup
```

It never overwrites an existing file. In Claude Code, run `/deliberation:setup` instead.

### Providers and keys

| PAL setting | deliberation |
|-------------|--------------|
| `OPENAI_API_KEY` | Not read. GPT runs through the Codex CLI: `npm install -g @openai/codex`, then `codex login` (a ChatGPT subscription). A ChatGPT Business or Enterprise workspace can set `CODEX_ACCESS_TOKEN` instead. With neither a login nor that token, Codex uses `CODEX_API_KEY`. |
| `GEMINI_API_KEY` | Not read. Gemini runs through the Antigravity CLI (`agy`) and its own login. See [Getting Started with Antigravity CLI](https://antigravity.google/docs/cli-getting-started). |
| `XAI_API_KEY` | Same variable. The Grok provider reads it (`providers.grok.apiKeyEnv`). |
| `OPENROUTER_API_KEY` | Same variable. Also set `providers.openrouter.enabled: true` and declare each model you want as a record in `models` (next section). |
| `CUSTOM_API_URL`, `CUSTOM_API_KEY`, `CUSTOM_MODEL_NAME` (Ollama, LM Studio) | `providers.ollama.apiBase` (default `http://localhost:11434/v1`) or `providers.lmstudio.apiBase` (default `http://localhost:1234/v1`). Both are keyless by default; set `apiKeyEnv` to the name of a variable that holds a key. Declare models with `provider: "ollama"` or `provider: "lmstudio"`. |
| Other OpenAI-compatible endpoints (vLLM, Hugging Face Inference) | `providers.openrouter.apiBase`. |
| `AZURE_OPENAI_*`, `DIAL_*` | No equivalent provider. |
| `DEFAULT_MODEL=auto` | No automatic model choice. Your agent picks the expert and the providers; each built-in provider uses the model you pin: `providers.codex.model`, `providers.gemini.model` (default `auto-gemini-3`), `providers.grok.model` (default `grok-4.6`). If `providers.codex.model` is unset, Codex uses its own `~/.codex/config.toml`. |
| `OPENAI_ALLOWED_MODELS`, `GOOGLE_ALLOWED_MODELS`, `XAI_ALLOWED_MODELS` | No allow list. The built-in providers (Codex, Gemini, Grok) join when they are enabled and ready. OpenRouter and local models join only as records you declare in `models`, and each record says where it may join (`askAll`, `consensus`, `experts`). `routing.maxFanout` (default 3) caps how many records join `ask-all`. |
| `DEFAULT_THINKING_MODE_THINKDEEP` | `reasoningEffort` per provider or per model record. |
| `DISABLED_TOOLS` | No equivalent. The tool set is fixed. |
| `CONVERSATION_TIMEOUT_HOURS`, `MAX_CONVERSATION_TURNS` | No equivalent for threads. For a record of past runs, turn on `sessions.persist` (with `maxRecords` and `maxAgeDays`). |
| `CUSTOM_CONNECT_TIMEOUT`, `CUSTOM_READ_TIMEOUT` | `providers.defaults.timeout` for every provider, `providers.<name>.timeout` for one, `models.<id>.timeout` for one record. Values are in milliseconds. |

### Model aliases

PAL lists models and their aliases in `conf/openrouter_models.json` and `conf/custom_models.json`.
In deliberation, each model is a named record in the `models` map. The record id is the name you
use: `<provider>:<id>` in `ask-one` (for example `openrouter:deepseek`), or, for an OpenRouter
record, the alias argument of `/deliberation:ask-openrouter`. Record ids use lowercase letters,
digits and hyphens.

A PAL `.env` like this:

```bash
OPENROUTER_API_KEY=sk-or-v1-...
XAI_API_KEY=xai-...
CUSTOM_API_URL=http://localhost:11434/v1
CUSTOM_MODEL_NAME=llama3.2
```

becomes the provider blocks and the `llama` record in this `config.json` (keys stay in the
environment). The `deepseek` record shows how to declare an OpenRouter model; it does not come
from the `.env` above.

```json
{
  "$schema": "https://raw.githubusercontent.com/antonbabenko/deliberation/master/config/config.schema.json",
  "version": 1,
  "providers": {
    "grok": { "enabled": true, "apiKeyEnv": "XAI_API_KEY" },
    "openrouter": { "enabled": true, "apiKeyEnv": "OPENROUTER_API_KEY" },
    "ollama": { "enabled": true, "apiBase": "http://localhost:11434/v1" }
  },
  "models": {
    "deepseek": {
      "provider": "openrouter",
      "model": "deepseek/deepseek-v4-pro",
      "askAll": true,
      "consensus": true,
      "reasoningEffort": "high"
    },
    "llama": {
      "provider": "ollama",
      "model": "llama3.2",
      "askAll": true,
      "consensus": false
    }
  },
  "routing": { "maxFanout": 3 }
}
```

The schema at `config/config.schema.json` lists every key. [SETUP.md](../../SETUP.md) walks
through each section.

### Restarts

PAL's README asks you to restart your session after you change its configuration. In
deliberation, changes to `models`, `routing` and
the `providers.openrouter` block take effect without a restart. Changing `apiBase` for Ollama or
LM Studio needs a server restart. Turning a built-in provider (Codex, Gemini, Grok) on or off in
Claude Code goes through `/deliberation:setup`.

## What works differently

- **Writes.** PAL providers can return code for your agent to apply. In deliberation every
  provider advises. Only Gemini, through the Claude Code plugin's Gemini bridge, can also edit
  files (`workspace-write`). The standalone MCP server is advisory only.
- **Login instead of API keys for GPT and Gemini.** deliberation shells out to the `codex` and
  `agy` CLIs, so these calls use your existing CLI logins and plans. PAL calls the OpenAI and
  Gemini APIs with keys.
- **Consensus.** PAL's `consensus` gives each model a stance and your agent combines the
  answers. deliberation's `/consensus` has your agent record its own verdict before it sees the
  panel. A round converges only when at least `consensus.quorumFloor` models answer (default 2),
  every one of them approves, no accepted critical issue is left, and the agent approves too. The
  agent cannot approve a plan on its own vote. For every issue the agent dismisses, the
  final report includes a written reason. The loop stops at `consensus.maxRounds` (default 5).
- **Disagreement stays visible.** `ask-all` returns each model's answer separately, and the
  synthesis names where they agree and where they split.
- **Repo context for HTTP models.** GPT and Gemini read the repository through their CLIs. Grok,
  OpenRouter and local models get a small bundle of repo files (AGENTS.md or CLAUDE.md,
  manifests, README) attached automatically. Turn it off with `orientation.enabled: false`.
- **Run history and metrics.** These features are opt-in: a debug log of latency, tokens and votes
  (`debug.enabled`), saved runs (`sessions.persist`), and a local read-only dashboard
  (`dashboard.enabled`).

## What deliberation does not have

- Vision input.
- Azure OpenAI and DIAL providers.
- Automatic model selection.
- CLI-to-CLI subagents (`clink`) and context revival.
- `precommit`, `refactor`, `testgen`, `docgen`, `tracer` and `challenge` as separate tools.
- A way to work around the MCP prompt size limit; deliberation relies on each provider's
  context window.
- Implementation mode for any provider other than Gemini.

If you depend on any of these, keep PAL for that work. Both servers can stay registered.
