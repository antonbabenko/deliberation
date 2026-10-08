---
name: dashboard
description: Start (or `restart`) the local read-only dashboard (live and past deliberation runs as state graphs, config, health, stats, analyzer) and print its URL. Needs a browser on the same machine.
argument-hint: "[restart] [--port N]"
allowed-tools: Bash
timeout: 30000
---

# Dashboard

Starts the local dashboard: a read-only web page on `127.0.0.1` that draws each
`/consensus`, `/ask-all` and `/ask-*` run as a state graph while it runs, plus run
history, the effective config, provider health, usage stats, and an analyzer (which models
agree more than they add, per-project failures and latency, request size vs timeouts). It
never changes deliberation state. Nothing is recorded until `dashboard.enabled` is `true` in the config.

## Step 1: Start it (ONE Bash call, sandbox DISABLED)

Run it with the **sandbox disabled**: it binds a local port and writes its pidfile under
`~/.cache`, which a sandbox blocks. Pass `--port N` only if the user asked for a port.

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/commands/dashboard.sh"
```

If the arguments start with `restart` (the user wants a fresh dashboard, for example after
an update, or a new token), run the restart script instead with the remaining arguments:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/commands/dashboard-restart.sh"
```

It stops the running dashboard only when its pid is provably the dashboard, then starts a
new one and prints its URL (a new token every time).

If your host does not set `CLAUDE_PLUGIN_ROOT`, pass the plugin directory instead:
`bash <plugin-root>/scripts/commands/dashboard.sh`.

The script needs a POSIX shell (Git Bash on Windows). Without one, tell the user to run
`deliberation-mcp dashboard` (or `node <plugin-root>/server/mcp/index.js dashboard`) in a
terminal instead.

The script starts `node server/mcp/index.js dashboard` detached, so the dashboard keeps
running after this session ends, and waits for its first output line. A second run finds
the live dashboard and prints the same URL.

## Step 2: Report

Print the script's output **as-is**, then act on its exit code:

- `0` - the output is `Deliberation dashboard: http://127.0.0.1:<port>/?t=<token>`. The
  browser opens on it; tell the user to open that URL if it did not. The token in it is the
  only credential: say it is for this machine only and should not be pasted anywhere.
- `1` - the dashboard did not start and the output says why. Most often:
  - `dashboard is disabled: set dashboard.enabled to true in <path>` - tell the user to add
    `"dashboard": { "enabled": true }` to that config file (it hot-reloads) and run
    `/deliberation:dashboard` again. Runs made before that are not recorded.
  - `port <n> is in use; pass --port` - rerun with `--port <another port>`.
  - `port <n> is in use and did not answer as this dashboard; the pidfile names pid <pid>, ...` -
    most likely a dashboard started before an update. Tell the user to check that pid and end
    it if it is the old dashboard, or rerun with `--port <another port>`. Do not kill it yourself.
  - `deliberation <version> at <path> has no dashboard; update it: ...` - the installed plugin
    predates the dashboard; tell the user to update it as the message says.
- `2` - a remote session (Claude Code on the web): the dashboard needs a browser on the
  same machine, and `localhost` here is the remote container. Stop.
- `3` (restart only) - `pid <n> from the pidfile was left alone: <why>`. A process holds
  the pidfile but could not be proven to be the dashboard, so nothing was stopped or
  started. Tell the user to check that pid and end it if it is the dashboard; do not kill
  it yourself. (`1` from the restart script can also mean `--stop is not supported on
  Windows`.)

## Rules

- Do not edit the config yourself; name the key and let the user set it.
- Do not print, log, or store the token anywhere except the one URL line above.
- To stop the dashboard without starting a new one, the user runs
  `deliberation-mcp dashboard --stop` (or `node <plugin-root>/server/mcp/index.js dashboard --stop`).
  This command stops a dashboard only as part of `restart`.
