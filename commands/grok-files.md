---
name: grok-files
description: List or prune Grok (xAI) uploaded files. Cleanup for bridge-owned uploads only.
allowed-tools: Bash, Read
timeout: 120000
---

# Grok Files (storage cleanup)

List or prune the xAI files uploaded by the Grok bridge. Uploads are tagged with the
filename prefix `claude-delegator-`, so prune ONLY ever targets those - your own xAI
files are never touched. Uploads also carry `expires_after` (default 7 days) so they
self-delete; this command is for pruning orphans early or auditing what exists.

## Input

Sub-command + flags: $ARGUMENTS
(e.g. `list`, `prune --older-than 24h`, `prune --older-than 7d --yes`)

## Workflow

1. **Resolve the admin script** via this sequence:
   1. Glob `~/.claude/plugins/cache/*claude-delegator/claude-delegator/*/server/grok/files-admin.js`;
      pick the highest-semver match.
   2. Fall back to `${CLAUDE_PLUGIN_ROOT}/server/grok/files-admin.js`.
   3. If neither exists, abort: `Error: claude-delegator plugin cache missing. Run /plugin install claude-delegator.`

2. **Check auth**: the script needs `XAI_API_KEY` in the environment. If it is unset, tell the
   user to `export XAI_API_KEY=xai-...` and stop (the script will error otherwise).

3. **Run the script** with the user's sub-command (default `list` when `$ARGUMENTS` is empty):
   ```bash
   node "<resolved files-admin.js>" $ARGUMENTS
   ```
   - `list` - prints total file count and every `claude-delegator-*` upload (id, created, expires, name).
   - `prune --older-than <30m|24h|7d|seconds>` - **dry run** by default; prints what it WOULD delete.
   - `prune --older-than <...> --yes` - actually deletes the matched bridge-owned files.

4. **Report** the script's output to the user. For `prune` without `--yes`, remind them to
   re-run with `--yes` to actually delete.

## Rules

- **Never** pass `--prefix ""` or any prefix that would match non-bridge files; the default
  `claude-delegator-` prefix is the safety boundary.
- Always run `prune` as a dry run first and show the user the candidate list before suggesting `--yes`.
- This command does not need the Grok MCP server; it calls the xAI Files API directly via `XAI_API_KEY`.
