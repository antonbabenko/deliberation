#!/usr/bin/env bash
# Register the deliberation MCP servers with the host CLI.
#
# Lives in a file rather than inline in the command prompt because a PreToolUse command
# analyzer has to parse whatever the agent pastes into Bash, and a 60-160 line script with
# functions is enough to make one give up and block the call. One file, one invocation.

set -u

# shellcheck source=scripts/commands/lib.sh
. "$(dirname "$0")/lib.sh"
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
