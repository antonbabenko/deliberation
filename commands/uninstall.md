---
name: uninstall
description: Uninstall claude-delegator (remove MCP config and rules)
allowed-tools: Bash, Read, Write, Edit, AskUserQuestion
timeout: 30000
---

# Uninstall

Remove claude-delegator from Claude Code.

## Confirm Removal

**Question**: "Remove Codex/Gemini/Grok/OpenRouter MCP configuration and plugin rules?"
**Options**:
- "Yes, uninstall"
- "No, cancel"

If cancelled, stop here.

## Remove MCP Configuration

```bash
claude mcp remove --scope user codex
claude mcp remove --scope user gemini
claude mcp remove --scope user grok
claude mcp remove --scope user openrouter
```

## Remove Installed Rules

```bash
rm -rf ~/.claude/rules/delegator/
```

## Remove Local Grok File Cache (optional)

The Grok bridge keeps a SHA-256 dedup cache at
`~/.claude/cache/claude-delegator/grok-files.json`. It only holds upload metadata
(no payload), but it is orphaned once the plugin is gone. Remove it explicitly:

```bash
rm -rf ~/.claude/cache/claude-delegator/
```

If you still have an `XAI_API_KEY` and want to also drain the remote uploads on
xAI's side before uninstall, run `/grok-files prune --older-than 0s --yes` first
(or `/grok-files gc` to discover what's already gone), then this `rm -rf`.

## Remove Short Command Aliases (if installed)

Only the aliases that `/setup` may have copied; the namespaced
`claude-delegator:*` commands are removed by uninstalling the plugin itself.
Ownership-aware: a copied alias is removed only if it is byte-identical to the
plugin's bundled command (so an unrelated user-authored same-named command,
which `/setup` would have skipped rather than overwritten, is left untouched).
```bash
for c in ask-gpt ask-gemini ask-grok ask-openrouter ask-all consensus grok-files; do
  dest=~/.claude/commands/$c.md
  src="${CLAUDE_PLUGIN_ROOT}/commands/$c.md"
  if [ ! -e "$dest" ]; then
    continue
  elif [ -f "$src" ] && cmp -s "$src" "$dest"; then
    rm -f "$dest" && echo "removed /$c"
  else
    echo "skip $c: ~/.claude/commands/$c.md differs from plugin copy (left untouched)"
  fi
done

# ask-both was renamed to ask-all in 1.7.0; the plugin no longer ships ask-both.md.
# Remove a copied ask-both alias only when it carries the delegator fingerprint
# (so a user-authored ask-both.md is left untouched).
olddest=~/.claude/commands/ask-both.md
if [ -e "$olddest" ] && grep -q "claude-delegator/claude-delegator" "$olddest" && grep -q "name: ask-both" "$olddest"; then
  rm -f "$olddest" && echo "removed obsolete /ask-both (renamed to /ask-all)"
elif [ -e "$olddest" ]; then
  echo "skip ask-both: ~/.claude/commands/ask-both.md not recognized as a plugin alias (left untouched)"
fi
```

## Confirm Completion

```
✓ Removed providers from MCP servers
✓ Removed rules from ~/.claude/rules/delegator/
✓ Removed short command aliases from ~/.claude/commands/ (if present)

To reinstall: /claude-delegator:setup
```
