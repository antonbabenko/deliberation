#!/usr/bin/env bash
# Fake agy (Antigravity CLI): records argv to $CDG_ARGV_LOG, emits plain-text
# answer on stdout, exits 0. Optionally writes the cwd->conversation-id map so
# the bridge's resolveConversationId returns a deterministic id.
#
# Knobs (all optional):
#   FAKE_AGY_HELP_STREAM=stderr  print --help usage to stderr, as agy >= 1.1.x does (#180)
#   FAKE_AGY_REPLY=<text>        the answer to print instead of "FAKE AGY OK"
#   FAKE_AGY_REJECT_MODEL=1      reject any --model pin the way agy 1.1.x rejects an id
#                                that is not in its catalog (after logging the argv)
set -euo pipefail

# Startup probe + capability probe: bridge runs `agy --help`. Mimics agy >= 1.0.9,
# which advertises --model (see fake-agy-nomodel.sh for the older shape).
if [ "${1:-}" = "--help" ]; then
  usage() {
    echo "Usage of agy:"
    echo "  --model                         Model for the current CLI session"
    echo "  -p                              Short alias for --print"
  }
  if [ "${FAKE_AGY_HELP_STREAM:-stdout}" = "stderr" ]; then usage >&2; else usage; fi
  exit 0
fi

printf '%s\0' "$@" >> "${CDG_ARGV_LOG:-/tmp/cdg-argv.log}"
printf '\n' >> "${CDG_ARGV_LOG:-/tmp/cdg-argv.log}"

# agy validates --model against its fetched catalog and exits 1 with this text when the
# id is unknown (e.g. the built-in "auto-gemini-3" alias on agy 1.1.x).
if [ "${FAKE_AGY_REJECT_MODEL:-}" = "1" ]; then
  for arg in "$@"; do
    if [ "$arg" = "--model" ]; then
      echo 'Error: invalid model selection (--model "x" --effort ""): model x is not recognized as a known model or custom model in settings' >&2
      exit 1
    fi
  done
fi

# Mimic agy's cwd->id cache so resolveConversationId(effCwd) can find the id.
if [ -n "${AGY_LAST_CONVERSATIONS:-}" ]; then
  printf '{"%s":"11111111-2222-3333-4444-555555555555"}' "$PWD" > "$AGY_LAST_CONVERSATIONS"
fi

echo "${FAKE_AGY_REPLY:-FAKE AGY OK}"
exit 0
