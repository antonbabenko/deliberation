#!/usr/bin/env bash
# Fake agy (Antigravity CLI): records argv to $CDG_ARGV_LOG, emits plain-text
# answer on stdout, exits 0. Optionally writes the cwd->conversation-id map so
# the bridge's resolveConversationId returns a deterministic id.
set -euo pipefail

# Startup probe + capability probe: bridge runs `agy --help`. Mimics agy >= 1.0.9,
# which advertises --model (see fake-agy-nomodel.sh for the older shape).
if [ "${1:-}" = "--help" ]; then
  echo "Usage of agy:"
  echo "  --model                         Model for the current CLI session"
  echo "  -p                              Short alias for --print"
  exit 0
fi

printf '%s\0' "$@" >> "${CDG_ARGV_LOG:-/tmp/cdg-argv.log}"
printf '\n' >> "${CDG_ARGV_LOG:-/tmp/cdg-argv.log}"

# Mimic agy's cwd->id cache so resolveConversationId(effCwd) can find the id.
if [ -n "${AGY_LAST_CONVERSATIONS:-}" ]; then
  printf '{"%s":"11111111-2222-3333-4444-555555555555"}' "$PWD" > "$AGY_LAST_CONVERSATIONS"
fi

echo "FAKE AGY OK"
exit 0
