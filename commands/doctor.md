---
name: doctor
description: Check Deliberation's health - config, provider CLIs, sessions/debug, and path drift - and suggest fixes. Read-only; never changes anything.
allowed-tools: Bash, Read, mcp__deliberation__doctor
timeout: 60000
---

# Doctor

A quick health check for Deliberation. It looks at what is actually set up on
this machine - your config, the provider CLIs, the session store - and tells you
what is fine, what is off, and the exact command to fix each problem.

It never changes anything. Every fix is yours to run.

## How it works

Two steps in order:

1. **One Bash call** - prints the session store dir your shell resolves. The server cannot
   see your shell's env, so this is the only check that runs outside it.
2. **One `doctor` tool call** - every other check, run by the unified server: config,
   provider CLIs and keys, sessions/debug flags, the host tool-call cap, the session store,
   path drift (from the dir step 1 printed) and stale MCP registrations. The same tool
   serves any MCP host that runs only the npx server.

Render a `flutter doctor`-style report: one line per finding, tagged `[OK]`, `[WARN]`,
`[FAIL]` or `[INFO]` from its `status`, and its `fix` on an indented line under anything
that is not OK. End with a one-line summary. If everything passes, say so in one line - do
not pad it.

## Step 1: Shell sessions dir (ONE Bash call)

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/commands/doctor.sh"
```

If your host does not set `CLAUDE_PLUGIN_ROOT` (see [docs/hosts/](../docs/hosts/)),
pass the plugin directory instead: `bash <plugin-root>/scripts/commands/doctor.sh`.
It prints one line, `SHELL_SESSIONS_DIR=<dir>`.

## Step 2: All checks (ONE `doctor` call)

```
mcp__deliberation__doctor({ shellSessionsDir: "<SHELL_SESSIONS_DIR from step 1>" })
```

The result is `{ findings[], summary, paths }`. Each finding has `check`, `status`
(`ok` | `warn` | `fail` | `info`), `message`, and `fix` when there is one. Print every
finding in order, verbatim; do not drop, merge or reword them.

- A `sessions-path` finding with status `fail` is the drift bug: the shell that wrote
  records and the process that launched the MCP server resolve different session dirs.
- If the `doctor` call fails or returns nothing, the unified `deliberation` server isn't
  reachable -> `[FAIL] MCP server not responding; fix: restart Claude Code, or
  /deliberation:setup`.

## Step 3: Summary + optional update check

- Print one summary line from `summary`: `N OK, M warnings, K failures`.
- If there are failures, lead with the single most important one.
- Offer (do NOT run): "Want me to check for a newer Deliberation release?" If the user
  says yes, `/plugin marketplace update antonbabenko` then `/reload-plugins` - their call.

## Rules

- **Read-only.** Never write config, never register/unregister MCP, never delete. Diagnose
  and suggest; the user runs the fix.
- **Never trigger an interactive login.** Check CLI presence and key env vars; do not run a
  command that could open a browser auth flow. Real auth is confirmed by an actual `/ask-*` call.
- **No secrets.** Report keys as set / unset, never their values.
- **Quiet when healthy.** All green -> one summary line, not a victory lap.
