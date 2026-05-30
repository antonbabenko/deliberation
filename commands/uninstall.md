---
name: uninstall
description: Uninstall deliberation (remove MCP config and rules)
allowed-tools: Bash, Read, AskUserQuestion
timeout: 30000
---

# Uninstall

Remove deliberation from Claude Code: MCP registrations, installed rules, the local Grok cache,
and any short command aliases that `/setup` copied.

This runs as one confirmation turn, then ONE main Bash call. Do not batch the Bash call with the
AskUserQuestion.

## Step 1: Confirm

Ask with `AskUserQuestion` (this turn has NO Bash call): "Remove deliberation MCP servers, rules,
Grok cache, and short command aliases?" Options: "Yes, uninstall" / "No, cancel".

If cancelled, stop here.

## Step 2: Remove everything

> Run the block below as ONE Bash call. Do NOT split it, and do NOT batch it with any other tool
> call. Every removal is tolerant of absence (no error if already gone).

It removes the namespaced `deliberation-*` servers, the unified `deliberation` server, the rules
dir, the Grok cache dir, and only the aliases that are byte-identical to the bundled commands (a
user-authored same-named command is left untouched).

```bash
set -u
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-}"

# --- MCP registrations (namespaced + unified) ---
for s in deliberation deliberation-codex deliberation-gemini deliberation-grok deliberation-openrouter; do
  claude mcp remove --scope user "$s" >/dev/null 2>&1 || true
done
echo "Removed MCP registrations (user scope)."

# --- rules dir ---
rm -rf "$HOME/.claude/rules/deliberation/" 2>/dev/null || true
echo "Removed rules dir."

# --- Grok dedup cache; metadata only, safe to drop ---
rm -rf "$HOME/.claude/cache/deliberation/" 2>/dev/null || true
echo "Removed Grok file cache."

# --- short command aliases: remove ONLY if byte-identical to the bundled command ---
removed=""; kept=""
for c in ask-gpt ask-gemini ask-grok ask-openrouter ask-all consensus grok-files; do
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
echo "Uninstall complete. Restart Claude Code so the removed MCP servers drop from the session."
echo "To reinstall: /deliberation:setup"
```

After it runs, report the printed summary. The plugin itself is removed via `/plugin` (this command
only cleans up the user-scope MCP registrations, rules, cache, and copied aliases).

## Notes

- Grok remote uploads: if you still have `XAI_API_KEY` and want to drain xAI-side uploads before
  uninstalling, run `/grok-files prune --older-than 0s --yes` (or `/grok-files gc` to see what is
  already gone) BEFORE Step 2.
- Config (`~/.claude/deliberation/config.json`) is left in place - it holds your OpenRouter model
  setup and API-key env names. Remove it manually if you want a full wipe.
