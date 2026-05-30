---
name: setup
description: Configure deliberation with Codex (GPT), Gemini, Grok, and OpenRouter MCP servers
allowed-tools: Bash, Read, AskUserQuestion
timeout: 60000
---

# Setup

Configure GPT (via Codex), Gemini, Grok, and OpenRouter as expert subagents via MCP, install the
orchestration rules, and (optionally) the short command aliases. Grok and OpenRouter are
advisory-only.

This command runs in three phases: ONE main Bash call (checks + register + install + status), then
isolated question turns for the optional aliases and the optional GitHub star. Do not batch a Bash
call with an AskUserQuestion, and do not split the main block.

## Step 1: Run setup

> Run the block below as ONE Bash call. Do NOT split it into smaller calls, and do NOT batch it
> with any other tool call. It is idempotent - safe to re-run.

It does everything non-interactive: checks CLIs, reads `config.json` once, registers the enabled
MCP servers at user scope (namespaced `deliberation-*`), installs the rules, and prints a status
report.

```bash
set -u
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:?CLAUDE_PLUGIN_ROOT is required (run this via /deliberation:setup)}"

# --- config path: env override > default deliberation path ---
CFG="${DELIBERATION_CONFIG:-$HOME/.claude/deliberation/config.json}"

json_eval() { node -e "$1" "$CFG" 2>/dev/null; }
# providers.<name>.enabled: missing => enabled (returns 1); explicit false => 0.
provider_enabled() {
  json_eval 'try{const c=require(process.argv[1]);const p=(c.providers&&c.providers[process.argv[2]])||{};process.stdout.write(p.enabled===false?"0":"1")}catch(e){process.stdout.write("1")}' "$1"
}
# openrouter on iff enabled!=false AND (non-empty models[] OR defaultModel).
openrouter_enabled() {
  json_eval 'try{const c=require(process.argv[1]);const o=c.openrouter||{};const on=o.enabled!==false&&((Array.isArray(o.models)&&o.models.length)||o.defaultModel);process.stdout.write(on?"1":"0")}catch(e){process.stdout.write("0")}'
}
or_key_env() {
  json_eval 'try{const c=require(process.argv[1]);process.stdout.write((c.openrouter&&c.openrouter.apiKeyEnv)||"OPENROUTER_API_KEY")}catch(e){process.stdout.write("OPENROUTER_API_KEY")}'
}

remove_mcp() { claude mcp remove "$1" >/dev/null 2>&1 || true; }
# remove-then-add (do not assume `claude mcp add` upserts). Never aborts the rest on one failure.
add_mcp() { name="$1"; shift; remove_mcp "$name"; claude mcp add --transport stdio --scope user "$name" -- "$@" || echo "WARN: failed to register $name"; }

# --- CLI presence (external tools; bridges ship with the plugin so are not checked) ---
command -v codex >/dev/null 2>&1 && CODEX_STATUS="$(codex --version 2>&1 | head -1)" || CODEX_STATUS="MISSING (npm i -g @openai/codex)"
command -v agy   >/dev/null 2>&1 && AGY_STATUS="installed" || AGY_STATUS="MISSING (https://antigravity.google)"

# --- register servers (each gated on provider_enabled; missing config = all on) ---
# Codex: inherits model from ~/.codex/config.toml. Pin with `-c model=<id>` (see notes below).
if [ "$(provider_enabled codex)" = "1" ]; then add_mcp deliberation-codex codex mcp-server; else remove_mcp deliberation-codex; fi

if [ "$(provider_enabled gemini)" = "1" ]; then add_mcp deliberation-gemini node "$PLUGIN_ROOT/server/gemini/index.js"; else remove_mcp deliberation-gemini; fi

if [ "$(provider_enabled grok)" = "1" ]; then add_mcp deliberation-grok node "$PLUGIN_ROOT/server/grok/index.js"; else remove_mcp deliberation-grok; fi

if [ "$(openrouter_enabled)" = "1" ]; then
  add_mcp deliberation-openrouter node "$PLUGIN_ROOT/server/openrouter/index.js"
  KEYENV="$(or_key_env)"; [ -z "$(printenv "$KEYENV" 2>/dev/null)" ] && echo "Note: \$$KEYENV is empty; OpenRouter calls return auth errors until you export it."
else
  remove_mcp deliberation-openrouter
fi

# Unified fan-out server (powers /ask-all and /consensus). Always on.
add_mcp deliberation node "$PLUGIN_ROOT/server/mcp/index.js"

# --- install orchestration rules (copy only; never deletes) ---
mkdir -p "$HOME/.claude/rules/deliberation"
cp "$PLUGIN_ROOT"/rules/*.md "$HOME/.claude/rules/deliberation/" 2>/dev/null || true
RULE_COUNT=$(find "$HOME/.claude/rules/deliberation" -maxdepth 1 -name '*.md' 2>/dev/null | wc -l | tr -d ' ')

# --- status ---
echo
echo "deliberation setup"
echo "--------------------------------------------------"
echo "Codex CLI:       $CODEX_STATUS"
echo "Antigravity CLI: $AGY_STATUS"
echo "config:          $([ -f "$CFG" ] && echo "$CFG" || echo "none (defaults: 3 built-ins on, no OpenRouter)")"
echo "Rules:           $RULE_COUNT files in ~/.claude/rules/deliberation/"
echo "Grok auth:       $([ -n "${XAI_API_KEY:-}" ] && echo "XAI_API_KEY set" || echo "XAI_API_KEY not set (calls return missing-auth)")"
echo "OpenRouter auth: $([ -n "${OPENROUTER_API_KEY:-}" ] && echo set || echo "not set")"
echo "MCP servers registered (user scope). Run 'claude mcp list' to confirm."
echo
echo "Restart Claude Code so the deliberation-* tools load; until then /ask-* may not find them."
```

After it runs, report the printed status to the user.

### Optional provider tuning (no extra setup calls needed)

- **Codex model:** by default Codex reads its model from `~/.codex/config.toml` (`model` key). To
  pin it on the server, append `-c model=<id>` to the `deliberation-codex` registration (re-run with
  the flag, e.g. `claude mcp add --transport stdio --scope user deliberation-codex -- codex mcp-server -c model=gpt-5.5`),
  or pass `model:` per call to `mcp__deliberation-codex__codex(...)`. Other Codex flags go before
  `mcp-server` (e.g. `-p nosandbox`).
- **Grok key in config (vs env):** the `deliberation-grok` registration omits `--env` so no secret
  is written to `~/.claude.json`; the bridge inherits `XAI_API_KEY` from Claude Code's launch
  environment (export it in your shell profile). To persist it in config instead, re-register with
  `--env XAI_API_KEY="$XAI_API_KEY"` before `-- node ...` (writes the key in plaintext to
  `~/.claude.json`).
- **Grok file TTL / reasoning:** uploads default to a 7-day `expires_after`; override with
  `GROK_FILE_TTL_SECONDS=<3600..2592000>`. Reasoning effort defaults to `high`; override with
  `GROK_REASONING_EFFORT=<low|medium|high|none>` (env, `--env` on the registration, or per call).
  Manage uploads with `/grok-files`. Full reference: [TECHNICAL.md](../TECHNICAL.md#grok-files-and-cleanup).

## Step 2: Optional short command names

The commands are always available namespaced (`/deliberation:ask-gpt`, `:ask-all`, `:consensus`,
...). The short aliases (`/ask-gpt` etc.) are an opt-in copy into `~/.claude/commands/`.

Ask with `AskUserQuestion` (this turn has NO Bash call): "Also install short command names
(/ask-gpt etc.) into ~/.claude/commands?" Options: "Yes (recommended)" / "No, keep namespaced
only".

**If yes**, run this as ONE isolated Bash call (installs only missing aliases; collects collisions):

```bash
set -u
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:?CLAUDE_PLUGIN_ROOT is required}"
mkdir -p "$HOME/.claude/commands"
collisions=""
for c in ask-gpt ask-gemini ask-grok ask-openrouter ask-all consensus grok-files; do
  dest="$HOME/.claude/commands/$c.md"
  if [ -e "$dest" ]; then collisions="$collisions $c"
  else cp "$PLUGIN_ROOT/commands/$c.md" "$dest" && echo "installed /$c"; fi
done
echo "COLLISIONS:${collisions:- none}"
```

If `COLLISIONS` is `none`, done. If it lists names, ask with `AskUserQuestion` (own turn, no Bash):
"These alias file(s) already exist:[list]. Overwrite with the bundled versions?" Options (default
first = overwrite): "Yes, overwrite (recommended)" / "No, keep existing".

**Only if "Yes, overwrite"**, run this as ONE isolated Bash call (collided names only):

```bash
set -u
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:?CLAUDE_PLUGIN_ROOT is required}"
for c in <collided names>; do
  cp -f "$PLUGIN_ROOT/commands/$c.md" "$HOME/.claude/commands/$c.md" && echo "overwrote /$c"
done
```

**If no**, skip - the namespaced commands still work.

## Step 3: Provider auth reminders

Print only the reminders relevant to what the Step-1 status showed as missing:

- Codex: `codex login`
- Gemini: run `agy` once and complete sign-in (or set the model in `~/.gemini/settings.json`)
- Grok: `export XAI_API_KEY=xai-...` (https://console.x.ai) in your shell profile, then restart
- OpenRouter: export the key named by `apiKeyEnv` (default `OPENROUTER_API_KEY`)

Seven experts are available, auto-detected from the request (or explicit: "Ask GPT to...", "Ask
Gemini to...", "Ask Grok to..."), each able to advise (read-only) or implement (write; Grok and
OpenRouter advisory-only): Architect, Plan Reviewer, Scope Analyst, Code Reviewer, Security
Analyst, Researcher, Debugger.

## Step 4: Ask about starring

Ask with `AskUserQuestion` (own turn): would the user like to star the deliberation repo to support
the project? Options: "Yes, star the repo" / "No thanks".

**If yes**, run as ONE isolated Bash call:

```bash
gh api -X PUT /user/starred/antonbabenko/deliberation 2>/dev/null && echo "Starred. Thank you!" || echo "Could not star via gh; star manually at https://github.com/antonbabenko/deliberation"
```

**If no**, thank them and finish.
