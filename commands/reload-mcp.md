---
name: reload-mcp
description: Gracefully cycle dashboard and audit MCP processes after deliberation is updated.
allowed-tools: Bash
timeout: 60000
---

# Reload MCP

Audits running Deliberation MCP server processes and safely cycles the dashboard daemon after a plugin or package update.

## Step 1: Run the reload script (ONE Bash call, sandbox DISABLED)

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/commands/reload-mcp.sh"
```

If your host does not set `CLAUDE_PLUGIN_ROOT`, pass the plugin directory instead:
`bash <plugin-root>/scripts/commands/reload-mcp.sh`.

## Step 2: Reconnection

Print the script's output as-is.

- **Dashboard Daemon**: If a dashboard daemon was running, the script cycles it via SIGTERM and relaunches it on the latest code, preserving the active port.
- **MCP Stdio Workers**: Connected host stdio pipes are preserved to prevent unexpected `EPIPE` session errors.
- **Claude Code**: Suggest running `/reload-plugins` so Claude Code reads the latest manifests and respawns MCP workers cleanly.
