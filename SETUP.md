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
    "defaults": { "timeout": 600000 },
    "codex":  { "enabled": true },
    "gemini": { "enabled": true, "model": "auto-gemini-3" },
    "grok":   { "enabled": true, "apiKeyEnv": "XAI_API_KEY", "model": "grok-4.6", "reasoningEffort": "high" },
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
  "consensus": { "arbiter": { "model": "claude-arb" }, "blindVote": true, "maxRounds": 5, "maxWallMs": 1800000 },
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

`providers.gemini.model` and `providers.grok.model` pin those two providers without
touching their own config files. Precedence for both: per-call `model` argument, then
this key, then the env var (`GEMINI_DEFAULT_MODEL` / `GROK_DEFAULT_MODEL`), then the
built-in default. Both are read once at MCP start, so changing them needs a restart.

`providers.grok.reasoningEffort` (`low` / `medium` / `high` / `none`) sets how hard Grok
reasons, on the same ladder: per-call `reasoning_effort`, then this key, then
`GROK_REASONING_EFFORT`, then `high`. `none` omits the field entirely so the model uses
its own default. Unlike the model pin this one is read per call, so it picks up an edit
without a restart. Gemini has no equivalent key - agy fuses reasoning effort into the
model id itself (`gemini-3.6-flash-high` vs `gemini-3.6-flash-low`), so you change it by
changing `providers.gemini.model`.

For Gemini, run `agy models` to see the catalog on your machine - ids fuse family and
reasoning effort (`gemini-3.6-flash-high`); a bare family is rejected with `requires
--effort`. The shipped default is the portable `auto-gemini-3` router alias, because a
concrete id that does not exist locally fails every call. On agy 1.1.x that alias is
not in the catalog either; agy rejects it with `invalid model selection`, and the bridge
then retries the call without the pin (agy uses `~/.gemini/settings.json`), prints one
stderr warning per process, and reports the run as `pinDropped` / `model:
"agy-settings-default"`. Only that shipped alias falls back: a concrete id you pin that
agy does not know fails as `model-not-allowed` with agy's catalog in the message. **Pin a
concrete id if you have one:** the alias routes server-side and agy's catalog also carries Claude and
GPT-OSS entries, so a routed call can seat a non-Gemini model in the Gemini slot and
quietly cost you the cross-model independence that `/ask-all` and `/consensus` rely on.

Codex has no such key - it resolves its model from `~/.codex/config.toml` and
deliberation never overrides it.

### Windows: the CLI providers

GPT and Gemini launch a real CLI (`codex`, `agy`); Grok and OpenRouter are HTTP bridges and
launch nothing, so they need none of this.

`npm install -g` on Windows installs `codex.cmd`, a shell shim rather than an executable, and
Node cannot launch one directly. deliberation resolves the CLI before spawning it - preferring a
real `.exe` on PATH, otherwise running the package's own entry point with Node - so a standard
npm install works with no setup.

If it still cannot find your CLI, name it explicitly:

```json
"env": {
  "CODEX_BIN": "C:\\Path\\To\\codex.exe",
  "AGY_BIN": "C:\\Path\\To\\agy.exe"
}
```

Point them at an **executable**, not at a `.cmd` shim or a `.js` file: a full path is passed
through and spawned as given, with no resolution and no shell. When only a shim can be found, the
call fails naming that shim and the variable to set, instead of reporting the CLI as missing.

### Claude Code on the web (and other capped hosts)

Three things differ in a web container, and the plugin now handles each:

- **The host caps every tool call.** Claude Code on the web exports `MCP_TOOL_TIMEOUT=60000`,
  which kills any MCP call after 60s - far below the provider ceilings below. Claude Code
  applies a per-server `timeout` ahead of that variable, so the plugin manifest declares
  `"timeout": 1800000` (30 min) on every deliberation server and mirrors it into the server's
  env as `MCP_TOOL_TIMEOUT` (the process inherits the host's 60000 otherwise, and
  deliberation's own clamp would cancel the override). Nothing to configure. If a `timeout`
  result still names `MCP_TOOL_TIMEOUT=60000`, the install is older than this manifest:
  `claude plugin update deliberation@antonbabenko` and start a new session. Installing by hand
  through `.mcp.json` on a capped host: add the same `"timeout": 1800000` and
  `"env": {"MCP_TOOL_TIMEOUT": "1800000"}` to the server entry. `/deliberation:doctor`
  explains the shell's residual value.
- **Codex needs a credential of its own in the container.** `OPENAI_API_KEY` is never used
  for codex and never reaches the `codex exec` child. A ChatGPT credential (a `codex login` or
  `CODEX_ACCESS_TOKEN`) always wins, and a `CODEX_API_KEY` in the env is then dropped so it
  cannot bill the API instead. Do not copy your laptop's `~/.codex/auth.json` into the
  container: a ChatGPT login's refresh token works once, so when either copy refreshes
  (about every 8 days, or on a 401), the other one fails with `Your access token could not be
  refreshed because your refresh token was already used`. Restoring the same copy from a
  secret at every session start fails the same way. Pick one of these:
  - **ChatGPT Plus / Pro:** nothing to set up beyond turning on device code login in
    ChatGPT's security settings. The first GPT call in a session that has no working login
    starts `codex login --device-auth` and shows its link and one-time code. If the host
    supports MCP elicitation you get a dialog during the call: approve in the browser, accept,
    and that same call answers. Otherwise the code comes back in the result (`errorKind:
    "auth"`); approve it and GPT answers from the next call (in `/consensus`, from the next
    round). The login belongs to that container alone, so it never conflicts with your
    laptop. The environment's network allowlist must reach `auth.openai.com` and
    `chatgpt.com`. To log in ahead of time, run `! codex login --device-auth` yourself.
  - **ChatGPT Business / Enterprise:** create a Codex access token and set
    `CODEX_ACCESS_TOKEN` in the environment's variables. It never refreshes (it expires on the
    date the workspace allows, 90 days by default), so the same value works in every session.
  - **Seeded `auth.json` (fallback):** if a setup script must restore `auth.json` from a
    secret, seed it from a login made only for that purpose, never your laptop's:
    `d=$(mktemp -d); CODEX_HOME="$d" codex login --device-auth; jq -c . "$d/auth.json"`, and
    store that output. (Keep `$d`: a bare `CODEX_HOME=...` prefix lasts one command, so a
    later `$CODEX_HOME/auth.json` would be your laptop's own login.)
    It works in every session until the first refresh (about a week after the login). After
    that, re-seed it.
  - **API billing:** export `CODEX_API_KEY`, or run
    `printenv CODEX_API_KEY | codex login --with-api-key` once.

  When a login can no longer refresh (a copied `auth.json`), the same thing happens: the
  first GPT call starts a fresh device login, shows its code, and retries once you approve.
- **No `agy`.** The standalone Gemini bridge refuses to start (`CONNECTION_CLOSED` in the
  host's server list); the unified server lists gemini under `panel.unavailable` and the
  panel runs without it.

### Timeouts

Every provider ships a different built-in ceiling (codex 600s, gemini 300s, grok 180s,
OpenRouter 180s). To raise them all at once, set one key:

```json
"providers": {
  "defaults": { "timeout": 600000 }
}
```

Override a single provider with `providers.<name>.timeout` - except OpenRouter, whose
slot is the `defaults` block it already owns (`providers.openrouter.defaults.timeout`).
A pinned model's `models.<id>.timeout` still beats all of it. These are read once at MCP
start, so a change needs a restart; the `models` map keeps hot-reloading.

This covers both paths: the tools on the unified server, and the standalone bridges behind
`/ask-grok`, `/ask-gemini`, and `/ask-openrouter`.

If a fan-out drops a model at almost exactly 180000 ms, it hit the built-in ceiling -
that is the knob to turn. If it drops at `MCP_TOOL_TIMEOUT - 5000` ms and the message says
`Host MCP_TOOL_TIMEOUT=... caps every MCP tool call`, the host's cap is the knob - raise it
where the host is launched (see above); no config key reaches above it.

A rate-limited call (HTTP 429) is retried once, waiting for the upstream's `Retry-After`
when it sends one. A timeout is deliberately not retried: the call may already have
burned tokens, and a slow-but-good answer should not be thrown away.

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
`consensus-step` tools (a per-call `maxRounds` overrides it). `consensus.maxWallMs` (integer
ms, default `1800000` = 30 min) sets a global wall-time budget for the server-side
provider-arbiter loop (`consensus` tool only); when spent, the loop stops before the next
round and returns UNRESOLVED with `stopReason: "budget-exhausted"` - it never aborts an
in-flight call. Implementation tasks always route to Gemini - GPT, Grok, and OpenRouter are advisory-only.

For the full schema, the `$schema` / VS Code validation story, apiBase override matrix
(Ollama, vLLM, LM Studio, HuggingFace), file-attachment caps, session model persistence,
consensus cost model, and error kinds, see
[TECHNICAL.md - OpenRouter bridge](TECHNICAL.md#openrouter-bridge).

## Session persistence

Opt-in, **default off**: nothing about your questions or results is written to disk
unless you turn it on. Enable it with a `sessions` block in the config:

```json
"sessions": { "persist": true, "maxRecords": 200, "maxAgeDays": 30, "captureText": false }
```

- `persist` (boolean, default `false`) - when true, each `/consensus` run (including the
  host-driven loop, on a terminal converged/unresolved transition) and each `/ask-all` run
  is saved as one JSON file and the tool result includes a `sessionId`. When off, the
  `session-*` tools report "persistence disabled".
- `maxRecords` (default `200`) - keep at most this many newest records; older ones are
  trimmed after each write. Use `-1` for unlimited (never trim by count).
- `maxAgeDays` (default `30`) - delete records older than this. Use `-1` for unlimited
  (never delete by age).
- `captureText` (boolean, default `false`) - when true (and `persist` on), the record also
  stores each provider's raw **response body**. Default off keeps only the question and the
  verdict/issue summaries. Captured bodies are secret-scrubbed (mandatory) plus a best-effort
  email-PII strip; they are plaintext on local disk, and the metrics-only debug log never
  receives body text. Forward-gating: turning it off stops new capture but does not purge
  records already written.

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
