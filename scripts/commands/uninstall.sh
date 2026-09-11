#!/usr/bin/env bash
# Remove the deliberation MCP registrations and report what is left behind.
#
# Lives in a file rather than inline in the command prompt because a PreToolUse command
# analyzer has to parse whatever the agent pastes into Bash, and a 60-160 line script with
# functions is enough to make one give up and block the call. One file, one invocation.

set -u

# shellcheck source=scripts/commands/lib.sh
. "$(dirname "$0")/lib.sh"

# --- resolve plugin root (non-fatal): env var -> cache (highest semver) -> current checkout ---
# Only the byte-identical alias check below needs it; empty is fine - MCP/rules/cache still purge.
PLUGIN_ROOT="$(resolve_plugin_root || true)"

# --- MCP registrations (namespaced + unified) ---
for s in deliberation deliberation-codex deliberation-gemini deliberation-grok deliberation-openrouter; do
  claude mcp remove --scope user "$s" >/dev/null 2>&1 || true
done
echo "Removed MCP registrations (user scope)."

# --- rules dir ---
rm -rf "$HOME/.claude/rules/deliberation/" 2>/dev/null || true
echo "Removed rules dir."

# --- Grok dedup cache; metadata only, safe to drop. Canonical XDG. ---
# Mirror core/paths.js: a RELATIVE XDG_CACHE_HOME is ignored (else rm -rf would
# target a path relative to $PWD) and the default ~/.cache used.
if [ -n "${XDG_CACHE_HOME:-}" ] && [ "${XDG_CACHE_HOME#/}" != "${XDG_CACHE_HOME}" ]; then
  CACHE_BASE="$XDG_CACHE_HOME"
else
  CACHE_BASE="$HOME/.cache"
fi
rm -rf "$CACHE_BASE/deliberation/" 2>/dev/null || true
echo "Removed Grok file cache."

# --- short command aliases: remove ONLY if byte-identical to the bundled command ---
removed=""; kept=""
# Superset of every name any setup version ever installed: `grok-files` and `analyze` are no
# longer installed, but older installs still have them and should still be cleaned up.
for c in ask-gpt ask-gemini ask-grok ask-openrouter ask-all consensus grok-files analyze; do
  dest="$HOME/.claude/commands/$c.md"
  src="$PLUGIN_ROOT/commands/$c.md"
  [ ! -e "$dest" ] && continue
  if [ -n "$PLUGIN_ROOT" ] && [ -f "$src" ] && cmp -s "$src" "$dest"; then
    rm -f "$dest" && removed="$removed /$c"
  else
    kept="$kept /$c"
  fi
done
# Obsolete /ask-both (renamed to /ask-all in 1.7.0): remove only if it carries the bundled
# fingerprint, so a user-authored ask-both.md is left untouched.
ob="$HOME/.claude/commands/ask-both.md"
if [ -e "$ob" ] && grep -q "name: ask-both" "$ob" 2>/dev/null && grep -q "deliberation" "$ob" 2>/dev/null; then
  rm -f "$ob" && removed="$removed /ask-both"
elif [ -e "$ob" ]; then
  kept="$kept /ask-both"
fi
echo "Aliases removed:${removed:- none}"
[ -n "$kept" ] && echo "Aliases left untouched (differ from bundled / user-authored):$kept"

echo
# --- verify the removals landed (catches silent sandbox write failures on ~/.claude.json) ---
LEFT="$(node -e 'const fs=require("fs"),h=require("os").homedir();try{const j=JSON.parse(fs.readFileSync(h+"/.claude.json","utf8"));const m=j.mcpServers||{};process.stdout.write(Object.keys(m).filter(k=>k==="deliberation"||k.indexOf("deliberation-")===0).join(" "))}catch(e){process.stdout.write("")}')"
if [ -n "$LEFT" ]; then
  echo "CRITICAL: these MCP entries still remain: $LEFT"
  echo "A Bash sandbox likely blocked the write to ~/.claude.json. Re-run /deliberation:uninstall"
  echo "with the sandbox DISABLED (see /sandbox)."
  echo
fi
echo "Uninstall complete. Restart Claude Code so the removed MCP servers drop from the session."
echo "To reinstall: /deliberation:setup"
