---
name: doctor
description: Check deliberation's health - config, provider CLIs, sessions/debug, and path drift - and suggest fixes. Read-only; never changes anything.
allowed-tools: Bash, Read, mcp__deliberation__analyze
timeout: 60000
---

# Doctor

A quick health check for deliberation. It looks at what is actually set up on
this machine - your config, the provider CLIs, the session store - and tells you
what is fine, what is off, and the exact command to fix each problem.

It never changes anything. Every fix is yours to run.

## How it works

Two steps in order:

1. **One Bash call** - all the local checks (config, CLIs, keys, sessions dir,
   stale registrations). Run it with the **sandbox disabled** - it reads
   `~/.claude.json`, `~/.config`, and `~/.cache`, which a sandbox blocks.
2. **One `analyze` tool call** - to learn the path the *running server* resolved,
   so we can catch the one drift bug a local check can't see on its own.

Render a `flutter doctor`-style report: one line per check, tagged `[OK]`,
`[WARN]`, or `[FAIL]`, and a fix line under anything that is not OK. End with a
one-line summary. If everything passes, say so in one line - do not pad it.

## Step 1: Local checks (ONE Bash call, sandbox DISABLED)

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/commands/doctor.sh"
```

If your host does not set `CLAUDE_PLUGIN_ROOT` (see [docs/hosts/](../docs/hosts/)),
pass the plugin directory instead: `bash <plugin-root>/scripts/commands/doctor.sh`.


## Step 2: Runtime path drift (ONE `analyze` call)

Call the tool, then compare the server's resolved sessions dir to the shell's:

```
mcp__deliberation__analyze({ sessions: 20, configuredOnly: false })
```

Both args are deliberate: a bounded `sessions` keeps this diagnostic cheap (the default is
uncapped), and `configuredOnly: false` shows every model that ever ran, because this step is
diagnosing read paths and persistence, not tuning a panel.

- Read `meta.sessionsDir` (the dir the **running server** uses) and compare it to
  `SHELL_SESSIONS_DIR` from step 1.
  - **Match** -> `[OK] sessions path: server and shell agree`.
  - **Differ** -> this is the drift bug:
    ```
    [FAIL] sessions path drift
           server reads: <meta.sessionsDir>
           shell wrote:  <SHELL_SESSIONS_DIR>
           cause: XDG_CACHE_HOME / DELIBERATION_SESSIONS differs between the shell
                  that wrote records and the process that launched the MCP server.
           fix: set DELIBERATION_SESSIONS to one path in both places, then restart.
    ```
- If `meta.sessionsRead > 0` but `meta.agreementVotes === 0`, add an `[INFO]`: records
  exist but carry no per-opinion verdicts (old or `ask-all` runs); run a fresh
  `/consensus` to populate `/analyze` Lens B.
- If the `analyze` call fails or returns nothing, the unified `deliberation` server
  isn't reachable -> `[FAIL] MCP server not responding; fix: restart Claude Code, or
  /deliberation:setup`.

## Step 3: Summary + optional update check

- Print one summary line: `N OK, M warnings, K failures`.
- If there are failures, lead with the single most important one.
- Offer (do NOT run): "Want me to check for a newer deliberation release?" If the user
  says yes, `/plugin marketplace update antonbabenko` then `/reload-plugins` - their call.

## Rules

- **Read-only.** Never write config, never register/unregister MCP, never delete. Diagnose
  and suggest; the user runs the fix.
- **Never trigger an interactive login.** Check CLI presence and key env vars; do not run a
  command that could open a browser auth flow. Real auth is confirmed by an actual `/ask-*` call.
- **No secrets.** Report keys as set / unset, never their values.
- **Quiet when healthy.** All green -> one summary line, not a victory lap.
