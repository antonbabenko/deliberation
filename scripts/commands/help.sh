#!/usr/bin/env bash
# Print the plugin version and the commands this install provides.
#
# Lives in a file rather than inline in the command prompt because a PreToolUse command
# analyzer has to parse whatever the agent pastes into Bash, and a 60-160 line script with
# functions is enough to make one give up and block the call. One file, one invocation.

set -u
host="Claude Code"
[ -n "${CURSOR_TRACE_ID:-}${CURSOR:-}" ] && host="Cursor"
[ -n "${KIRO_VERSION:-}${KIRO:-}" ] && host="Kiro"
[ -n "${CODEX_HOME:-}" ] && [ -z "${CLAUDECODE:-}" ] && host="Codex CLI"
echo "Host: $host"
CFG="${DELIBERATION_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/deliberation/config.json}"
case "$CFG" in /*) ;; *) CFG="$HOME/.config/deliberation/config.json";; esac
[ -f "$CFG" ] && echo "Config: found" || echo "Config: missing - run /deliberation:setup first"
[ -n "${XAI_API_KEY:-}" ] && echo "Grok key: set" || echo "Grok key: unset (Grok will skip)"
[ -n "${OPENROUTER_API_KEY:-}" ] && echo "OpenRouter key: set" || echo "OpenRouter key: unset (OpenRouter will skip)"
