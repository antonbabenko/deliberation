#!/usr/bin/env bash
# Stop the running dashboard (only if it is provably this dashboard), then start a fresh
# one and print its URL line - a new port token every time. Arguments pass through to
# dashboard.sh (e.g. --port N, --no-open).
# Exit codes: 0 URL printed, 1 the dashboard refused to start (or --stop is unsupported
# here), 2 remote session, 3 a process holds the pidfile but is not provably the dashboard,
# so it was left alone and nothing was started.

set -u
if [ "${CLAUDE_CODE_REMOTE:-}" = "true" ]; then
  echo "The dashboard needs a browser on the same machine as the MCP server. In a remote session (Claude Code on the web) localhost is the remote container, which your browser cannot reach. Run deliberation on your own machine to use it."
  exit 2
fi

# shellcheck source=scripts/commands/lib.sh
. "$(dirname "$0")/lib.sh"
root=$(resolve_plugin_root) || { echo "deliberation plugin root not found; set CLAUDE_PLUGIN_ROOT"; exit 1; }
if [ ! -f "$root/server/dashboard/stop.js" ]; then
  ver=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$root/.claude-plugin/plugin.json" 2>/dev/null | head -n 1)
  echo "deliberation ${ver:-(unknown version)} at $root cannot restart the dashboard; update it: /plugin marketplace update antonbabenko, then /reload-plugins"
  exit 1
fi

node "$root/server/mcp/index.js" dashboard --stop
case $? in
  0) ;;
  2) exit 3 ;;
  *) exit 1 ;;
esac
CLAUDE_PLUGIN_ROOT="$root" exec bash "$(dirname "$0")/dashboard.sh" "$@"
