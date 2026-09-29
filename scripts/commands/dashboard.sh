#!/usr/bin/env bash
# Start the local dashboard detached and print its URL line, or why it did not start.
# Arguments pass through to `deliberation-mcp dashboard` (e.g. --port N, --no-open).
#
# Detached (nohup, stdin closed) so the dashboard outlives this shell and the session;
# a second run finds the live instance through its pidfile and reprints the same URL.
# Exit codes: 0 URL printed, 1 the dashboard refused (stderr names the config key or
# port), 2 remote session.

set -u
if [ "${CLAUDE_CODE_REMOTE:-}" = "true" ]; then
  echo "The dashboard needs a browser on the same machine as the MCP server. In a remote session (Claude Code on the web) localhost is the remote container, which your browser cannot reach. Run deliberation on your own machine to use it."
  exit 2
fi

# shellcheck source=scripts/commands/lib.sh
. "$(dirname "$0")/lib.sh"
root=$(resolve_plugin_root) || { echo "deliberation plugin root not found; set CLAUDE_PLUGIN_ROOT"; exit 1; }

tmp=$(mktemp -d) || exit 1
# The URL line carries the token: both files live in a private mktemp dir, removed on exit.
trap 'rm -rf "$tmp" 2>/dev/null' EXIT
trap 'exit 1' INT TERM
nohup node "$root/server/mcp/index.js" dashboard "$@" >"$tmp/out" 2>"$tmp/err" </dev/null &
pid=$!

i=0
while [ "$i" -lt 100 ]; do
  if [ -s "$tmp/out" ]; then
    head -n 1 "$tmp/out"
    exit 0
  fi
  if ! kill -0 "$pid" 2>/dev/null; then
    # It exited: a live instance's URL (exit 0), or a refusal on stderr (exit 1).
    if [ -s "$tmp/out" ]; then head -n 1 "$tmp/out"; exit 0; fi
    cat "$tmp/err"
    exit 1
  fi
  sleep 0.1
  i=$((i + 1))
done
# Stopped rather than left running: a URL it printed later would land in a removed file.
kill "$pid" 2>/dev/null
echo "dashboard did not print its URL within 10s and was stopped; its stderr:"
cat "$tmp/err"
exit 1
