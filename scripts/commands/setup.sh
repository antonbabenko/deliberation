#!/usr/bin/env bash
# Interactive setup: resolve the plugin root, seed the config, and report what is present.
#
# Lives in a file rather than inline in the command prompt because a PreToolUse command
# analyzer has to parse whatever the agent pastes into Bash, and a 60-160 line script with
# functions is enough to make one give up and block the call. One file, one invocation.

set -u

# shellcheck source=scripts/commands/lib.sh
. "$(dirname "$0")/lib.sh"

# --- resolve plugin root: env var -> marketplace cache (highest semver) -> current checkout ---
# A candidate is valid only if it contains server/mcp/index.js.
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
# `deliberation-codex` is legacy: it was dropped from the manifest (codex-cli ships no MCP
# server), but an older install may still have a user-scope copy. Keep removing it.
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
