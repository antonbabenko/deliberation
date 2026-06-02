# Setup & Configuration

How to configure deliberation: the two expert modes, the `config.json` schema and its
sections, OpenRouter model records, and opt-in session persistence. For provider
internals, environment variables, and manual MCP setup, see [TECHNICAL.md](TECHNICAL.md).

## Modes

Every expert supports two modes, chosen automatically from your request:

| Mode | Sandbox | Use when |
|------|---------|----------|
| Advisory | `read-only` | Analysis, recommendations, reviews |
| Implementation | `workspace-write` | Making changes, fixing issues |

## OpenRouter config

OpenRouter models are declared in `~/.config/deliberation/config.json` - the canonical
XDG path (Windows: `%APPDATA%\deliberation\config.json`). You can override the path
with `DELIBERATION_CONFIG`. The file is the live single source of
truth: changes to `models`, `routing`, or the `providers.openrouter` block hot-reload
without restarting Claude Code. Toggling a built-in provider (codex / gemini / grok)
still requires `/setup`.

The config has six sections: `providers` (transport / connection per provider),
`models` (named model records keyed by id), `routing` (fan-out policy),
`consensus` (`arbiter` = who synthesizes the verdict; optional `blindVote` for a blind
arbiter pre-vote), `sessions` (opt-in run persistence; default off - see
[Session persistence](#session-persistence)), and `debug` (opt-in debug log; default off).
The `$schema` key gives editors validation and autocomplete - VS Code needs no extension.

Minimal example:

```json
{
  "$schema": "https://raw.githubusercontent.com/antonbabenko/deliberation/master/config/config.schema.json",
  "version": 1,
  "providers": {
    "codex":  { "enabled": true },
    "gemini": { "enabled": true },
    "grok":   { "enabled": true, "apiKeyEnv": "XAI_API_KEY" },
    "openrouter": {
      "enabled": true,
      "apiKeyEnv": "OPENROUTER_API_KEY",
      "apiBase": "https://openrouter.ai/api/v1",
      "defaultModel": "openai/gpt-4.1-mini",
      "defaults": { "reasoningEffort": "medium" }
    }
  },
  "models": {
    "gpt-4-or": {
      "provider": "openrouter",
      "model": "openai/gpt-4.1",
      "askAll": true,
      "consensus": false
    },
    "claude-arb": {
      "provider": "openrouter",
      "model": "anthropic/claude-haiku-4-5",
      "askAll": true,
      "consensus": true,
      "reasoningEffort": "high"
    }
  },
  "routing": { "maxFanout": 3 },
  "consensus": { "arbiter": { "model": "claude-arb" }, "blindVote": true, "maxRounds": 5 },
  "sessions": { "persist": false, "maxRecords": 200, "maxAgeDays": 30 },
  "debug": { "enabled": false }
}
```

`debug.enabled` (default `false`) appends one JSON line per provider call and per consensus
round to `<XDG cache>/deliberation/debug.jsonl` (override with `debug.path` or
`DELIBERATION_DEBUG_LOG`): latency, reasoning effort, HTTP token usage, and voting/approval
outcomes - never prompts, responses, or issue text. Useful for debugging slow runs.

Browse model slugs at [openrouter.ai/models](https://openrouter.ai/models?input_modalities=text);
the `model` field takes any slug listed there. Each record's `provider` must be
`"openrouter"` in v1 (codex / gemini / grok are managed by their own CLI / API).

`reasoningEffort` (`low` / `medium` / `high`) sets how hard a reasoning model
thinks. Put it on `providers.openrouter.defaults` to cover every model, or on a single
record to override the default for that one. Precedence runs call argument over
per-record override over `defaults`.

`/ask-all` includes records where `askAll !== false`, capped to `routing.maxFanout`.
`/consensus` includes records where `consensus === true`, with no fanout cap (a warning
is emitted when more than 3 models participate). `consensus.arbiter` picks who synthesizes:
a shorthand string (`"auto"` / `"host"` / `"codex"` / `"gemini"` / `"grok"`) or
`{ "model": "<id>" }` naming a record (even an out-of-panel one). `consensus.blindVote`
(boolean, default `false`) runs the arbiter cold in parallel with the panel to reduce
anchoring - concrete-arbiter / non-host mode only. `consensus.maxRounds` (integer, default
`5`, clamped to `50`) caps the multi-round convergence loop used by the `consensus` /
`consensus-step` tools (a per-call `maxRounds` overrides it). Implementation tasks always route to Codex or Gemini - never OpenRouter.

For the full schema, the `$schema` / VS Code validation story, apiBase override matrix
(Ollama, vLLM, LM Studio, HuggingFace), file-attachment caps, session model persistence,
consensus cost model, and error kinds, see
[TECHNICAL.md - OpenRouter bridge](TECHNICAL.md#openrouter-bridge).

## Session persistence

Opt-in, **default off**: nothing about your questions or results is written to disk
unless you turn it on. Enable it with a `sessions` block in the config:

```json
"sessions": { "persist": true, "maxRecords": 200, "maxAgeDays": 30 }
```

- `persist` (boolean, default `false`) - when true, each `/consensus` and `/ask-all`
  run is saved as one JSON file and the tool result includes a `sessionId`. When off,
  the `session-*` tools report "persistence disabled".
- `maxRecords` (default `200`) - keep at most this many newest records; older ones are
  trimmed after each write. Use `-1` for unlimited (never trim by count).
- `maxAgeDays` (default `30`) - delete records older than this. Use `-1` for unlimited
  (never delete by age).

Records live at `<XDG cache>/deliberation/sessions/<id>.json` (macOS/Linux:
`~/.cache/deliberation/sessions`; Windows: `%LOCALAPPDATA%\deliberation\sessions`),
written atomically with mode `0600`. Override the directory with `DELIBERATION_SESSIONS`.
API-key shapes are scrubbed and each opinion/verdict is capped (~100 KB) before writing;
attachment **paths** are stored (scrubbed), never file bodies.

Three MCP tools operate on the store (they appear always but report "disabled" until
`persist` is on): `session-get` (fetch a record), `session-revisit` (re-run a record's
original question with the *current* providers/config and save a linked child record),
and `session-annotate` (append a note to the audit trail). Full details:
[TECHNICAL.md - Session persistence](TECHNICAL.md#session-persistence).

> Distinct from "session model persistence" above, which is OpenRouter multi-turn
> (`threadId`) reuse - unrelated to this on-disk store.

For provider defaults, environment variables, and manual MCP setup, see [TECHNICAL.md](TECHNICAL.md#environment-variables).
