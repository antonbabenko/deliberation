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

This command runs in three phases: ONE main Bash call (checks + seed config + migrate + install rules + status), then
isolated question turns for the optional aliases and the optional GitHub star. Do not batch a Bash
call with an AskUserQuestion, and do not split the main block.

## Step 1: Run setup

> Run the block below as ONE Bash call. Do NOT split it into smaller calls, and do NOT batch it
> with any other tool call. It is idempotent - safe to re-run.
>
> **Run it with the Bash sandbox DISABLED.** The block writes `~/.claude/rules/deliberation/`
> and `~/.claude.json`, both outside a typical sandbox write allowlist. Under a sandbox those
> writes fail silently; the block verifies the result at the end and prints a `CRITICAL` block
> telling you to re-run unsandboxed if it detects a problem.

The MCP servers are registered by the plugin manifest (inline `mcpServers` in
`.claude-plugin/plugin.json`), so they load automatically when the plugin is enabled and update
with `/plugin marketplace update antonbabenko` + `/reload-plugins`.
This block is non-interactive: it seeds a default `config.json`, checks the provider CLIs, installs
the rules, and prints a status report.

```bash
set -u

# --- resolve plugin root: env var -> marketplace cache (highest semver) -> current checkout ---
# A candidate is valid only if it contains server/mcp/index.js.
resolve_plugin_root() {
  if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -f "$CLAUDE_PLUGIN_ROOT/server/mcp/index.js" ]; then
    printf '%s' "$CLAUDE_PLUGIN_ROOT"; return 0; fi
  # marketplace cache, highest version (use find, not a glob - a failed zsh glob warns on stderr)
  local c
  c=$(find "$HOME/.claude/plugins/cache" -maxdepth 6 -path '*/deliberation/*/server/mcp/index.js' -type f 2>/dev/null | sort -V | tail -1)
  if [ -n "$c" ]; then printf '%s' "${c%/server/mcp/index.js}"; return 0; fi
  if [ -f "$PWD/server/mcp/index.js" ] && grep -q '"name": "deliberation"' "$PWD/.claude-plugin/plugin.json" 2>/dev/null; then
    printf '%s' "$PWD"; return 0; fi
  return 1
}
PLUGIN_ROOT="$(resolve_plugin_root)" || { echo "Error: cannot locate the deliberation plugin root. Install via /plugin, run from the plugin checkout, or set CLAUDE_PLUGIN_ROOT."; exit 1; }

# --- config path: env override > canonical XDG ---
# Mirrors core/paths.js: DELIBERATION_CONFIG wins; else the canonical
# ${XDG_CONFIG_HOME or ~/.config}/deliberation/config.json. Per the XDG spec a
# RELATIVE XDG_CONFIG_HOME is ignored and the default used.
if [ -n "${DELIBERATION_CONFIG:-}" ]; then
  CFG="$DELIBERATION_CONFIG"
else
  if [ -n "${XDG_CONFIG_HOME:-}" ] && [ "${XDG_CONFIG_HOME#/}" != "${XDG_CONFIG_HOME}" ]; then
    XDG_BASE="$XDG_CONFIG_HOME"
  else
    XDG_BASE="$HOME/.config"
  fi
  CFG="$XDG_BASE/deliberation/config.json"
fi

# --- sessions store dir: env override > canonical XDG cache ---
# Mirrors core/paths.js resolveSessionsDir / canonicalCacheDir: DELIBERATION_SESSIONS
# wins; else ${XDG_CACHE_HOME or ~/.cache}/deliberation/sessions. A RELATIVE
# XDG_CACHE_HOME is ignored (XDG spec) and the default used.
if [ -n "${DELIBERATION_SESSIONS:-}" ]; then
  SESSIONS_DIR="$DELIBERATION_SESSIONS"
else
  if [ -n "${XDG_CACHE_HOME:-}" ] && [ "${XDG_CACHE_HOME#/}" != "${XDG_CACHE_HOME}" ]; then
    CACHE_BASE="$XDG_CACHE_HOME"
  else
    CACHE_BASE="$HOME/.cache"
  fi
  SESSIONS_DIR="$CACHE_BASE/deliberation/sessions"
fi

# --- seed a default config on first run (never clobber an existing file) ---
# Codex/Gemini/Grok enabled; OpenRouter disabled with two example model records
# (also disabled). Edit $CFG to turn OpenRouter / the models on, then re-run setup.
CONFIG_CREATED=0
if [ ! -f "$CFG" ]; then
  mkdir -p "$(dirname "$CFG")"
  if cp "$PLUGIN_ROOT/config/config.default.json" "$CFG" 2>/dev/null; then
    CONFIG_CREATED=1
  else
    echo "WARN: could not seed default config at $CFG"
  fi
fi

# Helpers take their first arg WITHOUT the literal $1/$2 tokens: Claude Code
# interpolates $1..$9 / $ARGUMENTS in a command body before bash runs, and this is a
# no-arg command, so any $1 here would be blanked. `for x in "$@"; do break; done`
# binds x to the first arg; the guarded shift drops it so "$@" is the remainder.
# `$@` is NOT a slash-command placeholder, so it survives intact.
json_eval() {
  local prog="" ; for prog in "$@"; do break; done ; [ "$#" -gt 0 ] && shift
  node -e "$prog" "$CFG" "$@" 2>/dev/null
}
# openrouter on iff providers.openrouter.enabled!=false AND (>=1 models record OR defaultModel).
# Unified v1 shape: connection lives under providers.openrouter; models is the top-level map.
openrouter_enabled() {
  json_eval 'try{const c=require(process.argv[1]);const p=(c.providers&&c.providers.openrouter)||{};const hasModel=(c.models&&typeof c.models==="object"&&Object.keys(c.models).length)||p.defaultModel;const on=p.enabled!==false&&hasModel;process.stdout.write(on?"1":"0")}catch(e){process.stdout.write("0")}'
}
or_key_env() {
  json_eval 'try{const c=require(process.argv[1]);const p=(c.providers&&c.providers.openrouter)||{};process.stdout.write(p.apiKeyEnv||"OPENROUTER_API_KEY")}catch(e){process.stdout.write("OPENROUTER_API_KEY")}'
}
# sessions: "ON|OFF" + max records + max age, rendering -1 as "unlimited". Missing
# config or block => default OFF / 200 / 30d. Output shape: "<ON|OFF>|<recs>|<age>".
sessions_summary() {
  json_eval 'try{const c=require(process.argv[1]);const s=c.sessions||{};const on=s.persist===true?"ON":"OFF";const mr=Number.isInteger(s.maxRecords)?s.maxRecords:200;const md=Number.isInteger(s.maxAgeDays)?s.maxAgeDays:30;const recs=mr===-1?"unlimited":String(mr);const age=md===-1?"unlimited":md+"d";process.stdout.write(on+"|"+recs+"|"+age)}catch(e){process.stdout.write("OFF|200|30d")}'
}

# Remove a user-scope MCP registration so it cannot shadow the manifest entry. Tolerant of absence.
remove_mcp() {
  local name="" ; for name in "$@"; do break; done
  claude mcp remove --scope user "$name" >/dev/null 2>&1 || true
}
# List any user-scope deliberation-* / deliberation entries in ~/.claude.json (a sandbox blocks
# WRITES to it, not reads, so this read is the source of truth). Echoes a space-joined list.
stale_userscope() {
  node -e 'const fs=require("fs"),h=require("os").homedir();try{const j=JSON.parse(fs.readFileSync(h+"/.claude.json","utf8"));const m=j.mcpServers||{};process.stdout.write(Object.keys(m).filter(k=>k==="deliberation"||k.indexOf("deliberation-")===0).join(" "))}catch(e){process.stdout.write("")}'
}

# --- CLI presence (external tools; bridges ship with the plugin so are not checked) ---
# Read --version from stdout only. Folding in stderr (2>&1) would capture codex's
# "WARNING: proceeding, even though we could not update PATH" line (emitted when codex
# cannot rewrite PATH, e.g. under a sandbox) and report it as the version. The grep
# fallback covers builds that print the version on stderr while still dropping the warning.
if command -v codex >/dev/null 2>&1; then
  CODEX_STATUS="$(codex --version 2>/dev/null | head -1)"
  [ -z "$CODEX_STATUS" ] && CODEX_STATUS="$(codex --version 2>&1 | grep -ivE 'warning|could not update path' | head -1)"
  [ -z "$CODEX_STATUS" ] && CODEX_STATUS="installed"
else
  CODEX_STATUS="MISSING (npm i -g @openai/codex)"
fi
command -v agy   >/dev/null 2>&1 && AGY_STATUS="installed" || AGY_STATUS="MISSING (https://antigravity.google)"

# --- keep the plugin manifest as the only MCP registration ---
# The manifest (inline mcpServers in .claude-plugin/plugin.json) registers the servers with
# ${CLAUDE_PLUGIN_ROOT}, which Claude Code re-resolves on each load. Clear any user-scope copies
# so they cannot shadow it.
# Per-provider enable/disable is gated in config via the unified server's fan-out (/ask-all,
# /consensus); the direct provider tools always load.
for s in deliberation deliberation-codex deliberation-gemini deliberation-grok deliberation-openrouter; do
  remove_mcp "$s"
done

# OpenRouter auth note (the manifest registers the server; this is only a key reminder).
if [ "$(openrouter_enabled)" = "1" ]; then
  KEYENV="$(or_key_env)"; [ -z "$(printenv "$KEYENV" 2>/dev/null)" ] && echo "Note: \$$KEYENV is empty; OpenRouter calls return auth errors until you export it."
fi

# --- install orchestration rules (copy only; never deletes) ---
mkdir -p "$HOME/.claude/rules/deliberation"
cp "$PLUGIN_ROOT"/rules/*.md "$HOME/.claude/rules/deliberation/" 2>/dev/null || true
RULE_COUNT=$(find "$HOME/.claude/rules/deliberation" -maxdepth 1 -name '*.md' 2>/dev/null | wc -l | tr -d ' ')

# --- confirm no user-scope entry shadows the manifest (catches a sandbox-blocked write) ---
# A sandbox blocks the WRITE to ~/.claude.json, so a user-scope entry can survive the removal
# above. Collect anything that remains; clean state is empty.
USERSCOPE_LEFT="$(stale_userscope)"

# --- status ---
echo
echo "deliberation setup"
echo "--------------------------------------------------"
echo "Codex CLI:       $CODEX_STATUS"
echo "Antigravity CLI: $AGY_STATUS"
echo "Config file:     $CFG"
[ "$CONFIG_CREATED" = "1" ] && echo "                 (created from default - codex/gemini/grok on, OpenRouter off, 2 example models off)"
echo "                 Edit it to enable OpenRouter and the example models, then re-run /deliberation:setup."
SESS="$(sessions_summary)"; SESS_STATE="${SESS%%|*}"; SESS_REST="${SESS#*|}"; SESS_RECS="${SESS_REST%%|*}"; SESS_AGE="${SESS_REST#*|}"
echo "Sessions:        persistence $SESS_STATE (opt-in; default OFF)"
[ "$SESS_STATE" = "OFF" ] && echo "                 turn on: set \"sessions\": { \"persist\": true } in $CFG"
echo "                 store: $SESSIONS_DIR (max records: $SESS_RECS, max age: $SESS_AGE; -1 = unlimited)"
echo "Rules:           $RULE_COUNT files in ~/.claude/rules/deliberation/"
echo "Grok auth:       $([ -n "${XAI_API_KEY:-}" ] && echo "XAI_API_KEY set" || echo "XAI_API_KEY not set (calls return missing-auth)")"
echo "OpenRouter auth: $([ -n "${OPENROUTER_API_KEY:-}" ] && echo set || echo "not set")"
if [ -n "$USERSCOPE_LEFT" ]; then
  echo "MCP servers:     CRITICAL - user-scope entries shadow the manifest:$USERSCOPE_LEFT"
  echo "                 A Bash sandbox most likely blocked the write to ~/.claude.json. Re-run"
  echo "                 /deliberation:setup with the sandbox DISABLED (see /sandbox)."
else
  echo "MCP servers:     registered by the plugin manifest (inline in .claude-plugin/plugin.json); load on enable."
  echo "                 'claude mcp list' shows them once the plugin loads."
fi
echo
echo "Update flow: '/plugin update' then '/reload-plugins' (or restart Claude Code)."
echo "If the deliberation-* tools are not visible yet, run /reload-plugins or restart Claude Code."
```

After it runs, report the printed status to the user.

### Optional provider tuning (no extra setup calls needed)

- **Codex model:** by default Codex reads its model from `~/.codex/config.toml` (`model` key). To
  pin it without touching config, pass `model:` per call to `mcp__deliberation-codex__codex(...)`.
  To pin it on the server itself, add the args to the `deliberation-codex` entry in
  `.claude-plugin/mcp.json` (e.g. `"args": ["mcp-server", "-c", "model=gpt-5.5"]`); other Codex
  flags go before `mcp-server` (e.g. `-p nosandbox`).
- **Grok key (env vs manifest):** the `deliberation-grok` manifest entry sets no `env`, so the
  bridge inherits `XAI_API_KEY` from Claude Code's launch environment (export it in your shell
  profile - no secret in any committed file). To pin it on the server instead, add an `"env":
  { "XAI_API_KEY": "..." }` block to that entry in `.claude-plugin/mcp.json` (note this writes the
  key in plaintext into the manifest - prefer the shell-env path).
- **Grok file TTL / reasoning:** uploads default to a 7-day `expires_after`; override with
  `GROK_FILE_TTL_SECONDS=<3600..2592000>`. Reasoning effort defaults to `high`; override with
  `GROK_REASONING_EFFORT=<low|medium|high|none>` (env, `--env` on the registration, or per call).
  Manage uploads with `/grok-files`. Full reference: [TECHNICAL.md](../TECHNICAL.md#grok-files-and-cleanup).

## Step 2: Optional short command names

The commands are always available namespaced (`/deliberation:ask-gpt`, `:ask-all`, `:consensus`,
...). The short aliases (`/ask-gpt` etc.) are an opt-in copy into `~/.claude/commands/`.
`analyze` is NOT among them - `/analyze` is a common name and a bare copy collides with any
other plugin that ships one.

Ask with `AskUserQuestion` (this turn has NO Bash call): "Also install short command names
(/ask-gpt etc.) into ~/.claude/commands?" Options: "Yes (recommended)" / "No, keep namespaced
only".

**If yes**, run this as ONE isolated Bash call (installs only missing aliases; collects collisions):

```bash
set -u
resolve_plugin_root() {
  if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -f "$CLAUDE_PLUGIN_ROOT/server/mcp/index.js" ]; then printf '%s' "$CLAUDE_PLUGIN_ROOT"; return 0; fi
  local c; c=$(find "$HOME/.claude/plugins/cache" -maxdepth 6 -path '*/deliberation/*/server/mcp/index.js' -type f 2>/dev/null | sort -V | tail -1)
  if [ -n "$c" ]; then printf '%s' "${c%/server/mcp/index.js}"; return 0; fi
  if [ -f "$PWD/server/mcp/index.js" ] && grep -q '"name": "deliberation"' "$PWD/.claude-plugin/plugin.json" 2>/dev/null; then printf '%s' "$PWD"; return 0; fi
  return 1
}
PLUGIN_ROOT="$(resolve_plugin_root)" || { echo "Error: cannot locate the deliberation plugin root."; exit 1; }
mkdir -p "$HOME/.claude/commands"
collisions=""
for c in ask-gpt ask-gemini ask-grok ask-openrouter ask-all consensus; do
  dest="$HOME/.claude/commands/$c.md"
  if [ -e "$dest" ]; then collisions="$collisions $c"
  else cp "$PLUGIN_ROOT/commands/$c.md" "$dest" && echo "installed /$c"; fi
done
echo "COLLISIONS:${collisions:- none}"
[ -e "$HOME/.claude/commands/analyze.md" ] && echo "LEGACY_ANALYZE:$HOME/.claude/commands/analyze.md"
```

`analyze` is deliberately NOT in that list. `/analyze` is a common name and a bare copy
collides with any other plugin that ships one; use `/deliberation:analyze`, which is always
available and never collides.

If the output contains a `LEGACY_ANALYZE:` line, an older setup installed that alias. Tell the
user the path and that deleting it removes the collision - do NOT delete it yourself, since a
file at that path may be their own.

If `COLLISIONS` is `none`, done. If it lists names, ask with `AskUserQuestion` (own turn, no Bash):
"These alias file(s) already exist:[list]. Overwrite with the bundled versions?" Options (default
first = overwrite): "Yes, overwrite (recommended)" / "No, keep existing".

**Only if "Yes, overwrite"**, run this as ONE isolated Bash call (collided names only):

```bash
set -u
resolve_plugin_root() {
  if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -f "$CLAUDE_PLUGIN_ROOT/server/mcp/index.js" ]; then printf '%s' "$CLAUDE_PLUGIN_ROOT"; return 0; fi
  local c; c=$(find "$HOME/.claude/plugins/cache" -maxdepth 6 -path '*/deliberation/*/server/mcp/index.js' -type f 2>/dev/null | sort -V | tail -1)
  if [ -n "$c" ]; then printf '%s' "${c%/server/mcp/index.js}"; return 0; fi
  if [ -f "$PWD/server/mcp/index.js" ] && grep -q '"name": "deliberation"' "$PWD/.claude-plugin/plugin.json" 2>/dev/null; then printf '%s' "$PWD"; return 0; fi
  return 1
}
PLUGIN_ROOT="$(resolve_plugin_root)" || { echo "Error: cannot locate the deliberation plugin root."; exit 1; }
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
