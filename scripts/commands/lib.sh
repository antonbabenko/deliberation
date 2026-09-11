#!/usr/bin/env bash
# Shared by the command scripts in this directory. Sourced, never executed.
#
# resolve_plugin_root was copy-pasted identically into four command prompts; it lives here
# once instead. The resolution order is unchanged: the host's env var, then the newest
# version in the marketplace cache, then a checkout you are standing in.

resolve_plugin_root() {
  if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -f "$CLAUDE_PLUGIN_ROOT/server/mcp/index.js" ]; then
    printf '%s' "$CLAUDE_PLUGIN_ROOT"
    return 0
  fi
  local c
  c=$(find "$HOME/.claude/plugins/cache" -maxdepth 6 -path '*/deliberation/*/server/mcp/index.js' -type f 2>/dev/null | sort -V | tail -1)
  if [ -n "$c" ]; then
    printf '%s' "${c%/server/mcp/index.js}"
    return 0
  fi
  if [ -f "$PWD/server/mcp/index.js" ] && grep -q '"name": "deliberation"' "$PWD/.claude-plugin/plugin.json" 2>/dev/null; then
    printf '%s' "$PWD"
    return 0
  fi
  return 1
}

# The doctor report's three line prefixes, also used by setup and uninstall.
ok() { printf '[OK]   %s\n' "$1"; }
warn() { printf '[WARN] %s\n' "$1"; }
fail() { printf '[FAIL] %s\n' "$1"; }
