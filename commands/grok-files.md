---
name: grok-files
description: List, prune, or gc Grok (xAI) uploaded files. Cleanup for bridge-owned uploads only.
allowed-tools: Bash, Read
timeout: 120000
---

# Grok Files (storage cleanup)

List, prune, or gc the xAI files uploaded by the Grok bridge. Uploads are tagged with
the filename prefix `deliberation-`, so the remote-side cleanup ONLY ever targets
those - your own xAI files are never touched. Uploads also carry `expires_after`
(default 7 days) so they self-delete; this command is for pruning orphans early,
auditing what exists, or syncing the local SHA-256 cache with remote state.

## Input

Sub-command + flags: $ARGUMENTS
(e.g. `list`, `prune --older-than 24h`, `prune --older-than 7d --yes`,
`gc`, `gc --all-keys --force-local-prune`)

## Workflow

1. **Resolve the admin script** via this sequence:
   1. Glob `~/.claude/plugins/cache/*/deliberation/*/server/grok/files-admin.js`;
      pick the highest-semver match.
   2. Fall back to `${CLAUDE_PLUGIN_ROOT}/server/grok/files-admin.js`.
   3. If none exists, abort: `Error: deliberation plugin cache missing. Run /plugin install deliberation.`

2. **Check auth**: the script needs `XAI_API_KEY` in the environment. If it is unset, tell the
   user to `export XAI_API_KEY=xai-...` and stop (the script will error otherwise).

3. **Run the script** with the user's sub-command (default `list` when `$ARGUMENTS` is empty):
   ```bash
   node "<resolved files-admin.js>" $ARGUMENTS
   ```
   - `list` - prints total file count and every `deliberation-*` upload (id, created, expires, name).
   - `prune --older-than <30m|24h|7d|seconds>` - **dry run** by default; prints what it WOULD delete (remote files).
   - `prune --older-than <...> --yes` - actually deletes the matched bridge-owned **remote** files.
   - `gc` - syncs the **local** SHA-256 cache (`~/.cache/deliberation/grok-files.json`; Windows `%LOCALAPPDATA%\deliberation\grok-files.json`, override with `DELIBERATION_CACHE`)
     with remote state via one paginated `GET /v1/files`. Prunes local rows whose `fileId` is no
     longer on xAI. Default scope: current `XAI_API_KEY` + `XAI_API_BASE` rows only.
   - `gc --all-keys` - widens the diff to foreign rows but leaves them when remote absence is
     ambiguous (the current key can't always see foreign files).
   - `gc --all-keys --force-local-prune` - drops ambiguous foreign rows anyway. May orphan
     files on xAI under foreign accounts.

4. **Report** the script's output to the user. For `prune` without `--yes`, remind them to
   re-run with `--yes` to actually delete. For `gc`, the printed `pruned N local cache row(s)`
   message is the receipt.

## Rules

- **Never** pass `--prefix ""` or any prefix that would match non-bridge files; the default
  `deliberation-` prefix is the safety boundary for `prune`.
- Always run `prune` as a dry run first and show the user the candidate list before suggesting `--yes`.
- `gc` is read-modify-write under the cache lock; never edit the cache file by hand while a
  Grok bridge is running.
- This command does not need the Grok MCP server; it calls the xAI Files API directly via `XAI_API_KEY`.

## prune vs gc

`prune` is the **remote** cleaner: deletes bridge-owned files on xAI by filename prefix + age.
Works even when the local cache file is missing or lost. Use after a long absence to drain
orphaned uploads.

`gc` is the **local-side reconciliation**: it does NOT delete anything on xAI - it discovers
what xAI already considers gone (TTL elapsed, deleted out-of-band, etc.) and prunes the
matching rows from the local cache so future calls cache-miss and re-upload. Use after a
TTL window has passed, or after running `prune --yes`, to keep the cache file lean.
