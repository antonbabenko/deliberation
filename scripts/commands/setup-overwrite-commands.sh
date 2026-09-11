#!/usr/bin/env bash
# Overwrite the user-scope copies of the commands named as arguments.
#
# Was a template in the setup prompt (`for c in <collided names>`), which meant the agent
# hand-built a shell loop every run and no linter could ever see it. The names are
# arguments now, so this is a real script: shellcheck can read it and an analyzer can
# parse the call.

set -u

# shellcheck source=scripts/commands/lib.sh
. "$(dirname "$0")/lib.sh"

if [ "$#" -eq 0 ]; then
  echo "usage: ${0##*/} <command-name>..." >&2
  exit 2
fi

PLUGIN_ROOT="$(resolve_plugin_root)" || {
  echo "Error: cannot locate the deliberation plugin root."
  exit 1
}

for c in "$@"; do
  cp -f "$PLUGIN_ROOT/commands/$c.md" "$HOME/.claude/commands/$c.md" && echo "overwrote /$c"
done
