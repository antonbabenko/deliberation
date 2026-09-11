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
>
> **Run it with the Bash sandbox DISABLED.** It writes `~/.claude.json` (MCP removal) and deletes
> under `~/.claude/`; a sandbox blocks those and the servers stay registered. The block verifies
> the removal at the end and prints a `CRITICAL` line if any `deliberation*` entry survives.

It removes the namespaced `deliberation-*` servers, the unified `deliberation` server, the rules
dir, the Grok cache dir, and only the aliases that are byte-identical to the bundled commands (a
user-authored same-named command is left untouched).

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/commands/uninstall.sh"
```

If your host does not set `CLAUDE_PLUGIN_ROOT` (see [docs/hosts/](../docs/hosts/)),
pass the plugin directory instead: `bash <plugin-root>/scripts/commands/uninstall.sh`.


After it runs, report the printed summary. The plugin itself is removed via `/plugin` (this command
only cleans up the user-scope MCP registrations, rules, cache, and copied aliases).

## Notes

- Grok remote uploads: if you still have `XAI_API_KEY` and want to drain xAI-side uploads before
  uninstalling, run `/grok-files prune --older-than 0s --yes` (or `/grok-files gc` to see what is
  already gone) BEFORE Step 2.
- Config is left in place - it holds your OpenRouter model setup and API-key env names. Remove it
  manually if you want a full wipe: `~/.config/deliberation/config.json` (Windows:
  `%APPDATA%\deliberation\config.json`), or the path set by `DELIBERATION_CONFIG`.
