#!/usr/bin/env bash
# Local health checks for the deliberation plugin: plugin root, config, provider CLIs,
# API keys, sessions and MCP registrations. Prints one tagged line per check.
#
# Lives in a file rather than inline in the command prompt because a PreToolUse command
# analyzer has to parse whatever the agent pastes into Bash, and a 60-160 line script with
# functions is enough to make one give up and block the call. One file, one invocation.

set -u

# shellcheck source=scripts/commands/lib.sh
. "$(dirname "$0")/lib.sh"

# --- plugin root + version: env -> marketplace cache (highest semver) -> checkout ---
echo "== deliberation doctor =="
PR="$(resolve_plugin_root || true)"
if [ -n "$PR" ]; then
  VER="$(node -e "process.stdout.write(require('$PR/package.json').version||'?')" 2>/dev/null || echo '?')"
  ok "plugin found ($PR, v$VER)"
else
  fail "plugin root not found"; echo "       fix: reinstall with /plugin, then /deliberation:setup"
fi

# --- config: env override > canonical XDG ---
CFG="${DELIBERATION_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/deliberation/config.json}"
case "$CFG" in /*) ;; *) CFG="$HOME/.config/deliberation/config.json";; esac
if [ -f "$CFG" ]; then
  if node -e "JSON.parse(require('fs').readFileSync('$CFG','utf8'))" 2>/dev/null; then
    ok "config valid ($CFG)"
    node -e '
      const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
      const s=c.sessions||{}, d=c.debug||{};
      console.log((s.persist?"[OK]   ":"[WARN] ")+"sessions.persist: "+(!!s.persist)+(s.persist?"":"  fix: set sessions.persist:true for /analyze Lens B"));
      console.log((d.enabled?"[OK]   ":"[WARN] ")+"debug.enabled: "+(!!d.enabled)+(d.enabled?"":"  fix: set debug.enabled:true for /analyze Lens A"));
    ' "$CFG"
  else
    fail "config is not valid JSON ($CFG)"; echo "       fix: correct the JSON, or move it aside and run /deliberation:setup"
  fi
else
  warn "no config at $CFG"; echo "       fix: run /deliberation:setup"
fi

# --- provider CLIs (presence + version only; auth is confirmed by a real /ask-* call) ---
if command -v codex >/dev/null 2>&1; then ok "codex CLI on PATH ($(codex --version 2>/dev/null | head -1))"; else warn "codex (GPT) not on PATH"; echo "       fix: install the Codex CLI, or ignore if you don't use GPT"; fi
if command -v agy >/dev/null 2>&1; then ok "agy CLI on PATH (Gemini)"; else warn "agy (Gemini) not on PATH"; echo "       fix: install the Antigravity CLI, or ignore if you don't use Gemini"; fi
if [ -n "${XAI_API_KEY:-}" ]; then
  ok "XAI_API_KEY set (Grok)"
else
  warn "XAI_API_KEY unset - Grok calls return missing-auth"
fi
if [ -n "${OPENROUTER_API_KEY:-}" ]; then
  ok "OPENROUTER_API_KEY set"
else
  warn "OPENROUTER_API_KEY unset - OpenRouter models will error"
fi

# --- sessions dir the SHELL resolves (compared to the server's in step 2) ---
SD="${DELIBERATION_SESSIONS:-${XDG_CACHE_HOME:-$HOME/.cache}/deliberation/sessions}"
case "$SD" in /*) ;; *) SD="$HOME/.cache/deliberation/sessions";; esac
echo "SHELL_SESSIONS_DIR=$SD"
if [ -d "$SD" ]; then
  N=$(find "$SD" -maxdepth 1 -name '*.json' -type f 2>/dev/null | wc -l | tr -d ' ')
  ok "sessions dir exists ($SD, $N record(s))"
else
  warn "sessions dir not found ($SD) - nothing persisted there yet"
fi

# --- stale user-scope MCP registrations (the inline plugin manifest is the SSOT) ---
LEFT="$(node -e 'try{const fs=require("fs"),h=require("os").homedir();const j=JSON.parse(fs.readFileSync(h+"/.claude.json","utf8"));const m=j.mcpServers||{};process.stdout.write(Object.keys(m).filter(k=>k==="deliberation"||k.indexOf("deliberation-")===0).join(" "))}catch(e){}')"
if [ -n "$LEFT" ]; then
  warn "user-scope MCP entries shadow the plugin manifest: $LEFT"
  echo "       fix: /deliberation:uninstall (then they load from the plugin)"
else
  ok "no shadowing user-scope MCP registrations"
fi
echo "== end local checks =="
