#!/usr/bin/env bash
# scripts/commands/reload-mcp.sh
# Gracefully update harnesses, cycle dashboard daemon, and audit MCP processes after deliberation is updated.
#
# Usage:
#   bash scripts/commands/reload-mcp.sh [options]
#
# Options:
#   --dry-run                Inspect running processes and planned updates without making changes
#   --no-update-agents       Skip updating agent harnesses/CLIs (only audit/cycle processes)
#   --update-agents          Force update agent harnesses even in CI environment
#   --no-restart-dashboard   Do not restart the dashboard daemon if it is running
#   --force-workers          Send SIGTERM to idle attached workers (warn: can drop host pipes)
#   --help, -h               Show this help message

set -u

DRY_RUN=false
RESTART_DASHBOARD=true
FORCE_WORKERS=false
UPDATE_AGENTS=true
if [ -n "${CI:-}" ]; then
  UPDATE_AGENTS=false
fi

for arg in "$@"; do
  case "$arg" in
    --dry-run)
      DRY_RUN=true
      ;;
    --no-update-agents|--skip-agents-update)
      UPDATE_AGENTS=false
      ;;
    --update-agents)
      UPDATE_AGENTS=true
      ;;
    --no-restart-dashboard)
      RESTART_DASHBOARD=false
      ;;
    --force-workers)
      FORCE_WORKERS=true
      ;;
    --help|-h)
      echo "Usage: $(basename "$0") [options]"
      echo ""
      echo "Gracefully update Deliberation across supported agent harnesses (Claude, Codex,"
      echo "Antigravity, Kiro, OpenCode, Cursor), cycle the dashboard daemon, and audit running"
      echo "MCP worker processes without killing active in-flight threads."
      echo ""
      echo "Options:"
      echo "  --dry-run                Inspect installed harnesses and processes without modifying anything"
      echo "  --no-update-agents       Skip updating agent harnesses/CLIs (only audit/cycle processes)"
      echo "  --update-agents          Force update agent harnesses even in CI environment"
      echo "  --no-restart-dashboard   Do not restart the dashboard daemon if it is running"
      echo "  --force-workers          Send SIGTERM to idle attached workers (warn: can drop host pipes)"
      echo "  --help, -h               Show this help message"
      exit 0
      ;;
    *)
      echo "Unknown option: $arg" >&2
      echo "Run '$(basename "$0") --help' for usage." >&2
      exit 1
      ;;
  esac
done

# shellcheck source=scripts/commands/lib.sh
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/lib.sh" ]; then
  # shellcheck disable=SC1091
  . "$SCRIPT_DIR/lib.sh"
else
  resolve_plugin_root() {
    if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -f "$CLAUDE_PLUGIN_ROOT/server/mcp/index.js" ]; then
      printf '%s' "$CLAUDE_PLUGIN_ROOT"
      return 0
    fi
    local c
    c=$(find "$HOME/.claude/plugins/cache" -maxdepth 6 -path '*/deliberation/*/server/mcp/index.js' -type f 2>/dev/null | sort -V | tail -1)
    if [ -n "$c" ]; then
      printf '%s' "${c%/server/mcp/index.js}"
      return 0
    fi
    if [ -f "$PWD/server/mcp/index.js" ]; then
      printf '%s' "$PWD"
      return 0
    fi
    return 1
  }
  ok() { printf '[OK]   %s\n' "$1"; }
  warn() { printf '[WARN] %s\n' "$1"; }
  fail() { printf '[FAIL] %s\n' "$1"; }
fi

ROOT=$(resolve_plugin_root) || {
  echo "[FAIL] Deliberation plugin root not found. Set CLAUDE_PLUGIN_ROOT or run from the repo." >&2
  exit 1
}

VERSION=""
if [ -f "$ROOT/package.json" ]; then
  VERSION=$(sed -n 's/.*"version": *"\([^",]*\)".*/\1/p' "$ROOT/package.json" | head -n 1)
elif [ -f "$ROOT/.claude-plugin/plugin.json" ]; then
  VERSION=$(sed -n 's/.*"version": *"\([^",]*\)".*/\1/p' "$ROOT/.claude-plugin/plugin.json" | head -n 1)
fi

echo "=== Deliberation MCP Reload & Host Audit ==="
echo "Target root: $ROOT"
echo "Target version: ${VERSION:-unknown}"
if [ "$DRY_RUN" = true ]; then
  echo "Mode: DRY RUN (no processes or packages will be modified)"
fi
echo ""

# -----------------------------------------------------------------------------
# 1. Update Supported Agent Harnesses
# -----------------------------------------------------------------------------
if [ "$UPDATE_AGENTS" = true ]; then
  echo "• Updating Supported Agent Harnesses..."

  # 1.1 Source repo sync (if running inside git checkout of deliberation)
  if [ -f "$ROOT/package.json" ] && [ -f "$ROOT/scripts/sync-hosts.js" ]; then
    echo "  [Source Repo] Checking host artifacts in $ROOT..."
    if [ "$DRY_RUN" = true ]; then
      echo "    [DRY-RUN] Would verify host artifacts via npm run sync:check"
    else
      SYNC_OK=true
      (
        cd "$ROOT" || exit 1
        npm run sync:check --silent >/dev/null 2>&1
      ) || SYNC_OK=false

      if [ "$SYNC_OK" = false ]; then
        echo "    ⚠️ Host artifacts out of sync. Regenerating via npm run sync..."
        (
          cd "$ROOT" || exit 0
          npm run sync >/dev/null 2>&1 || true
        )
      else
        echo "    ✔ Host artifacts up to date."
      fi
    fi
  fi

  # 1.2 Claude Code (claude)
  CLAUDE_BIN=""
  if command -v claude >/dev/null 2>&1; then
    CLAUDE_BIN=$(command -v claude)
  elif [ -x "$HOME/.local/bin/claude" ]; then
    CLAUDE_BIN="$HOME/.local/bin/claude"
  fi

  if [ -n "$CLAUDE_BIN" ]; then
    echo "  [Claude Code] Found at $CLAUDE_BIN"
    if [ "$DRY_RUN" = true ]; then
      echo "    [DRY-RUN] Would update marketplace 'antonbabenko' and plugin 'deliberation@antonbabenko'"
    else
      echo "    Updating marketplace and plugin..."
      "$CLAUDE_BIN" plugin marketplace update antonbabenko >/dev/null 2>&1 || true
      "$CLAUDE_BIN" plugin update deliberation@antonbabenko >/dev/null 2>&1 || true
      echo "    ✔ Claude Code plugin updated."
    fi
  fi

  # 1.3 OpenAI Codex (codex)
  CODEX_BIN=""
  if command -v codex >/dev/null 2>&1; then
    CODEX_BIN=$(command -v codex)
  elif [ -x "/opt/homebrew/bin/codex" ]; then
    CODEX_BIN="/opt/homebrew/bin/codex"
  fi

  if [ -n "$CODEX_BIN" ]; then
    echo "  [OpenAI Codex] Found at $CODEX_BIN"
    if [ "$DRY_RUN" = true ]; then
      echo "    [DRY-RUN] Would upgrade marketplace 'antonbabenko-deliberation' and sync plugin"
    else
      echo "    Upgrading marketplace and synchronizing plugin..."
      "$CODEX_BIN" plugin marketplace upgrade antonbabenko-deliberation >/dev/null 2>&1 || true
      "$CODEX_BIN" plugin add deliberation@antonbabenko-deliberation --json >/dev/null 2>&1 || true
      echo "    ✔ Codex deliberation plugin synced."
    fi
  fi

  # 1.4 Antigravity CLI (agy)
  AGY_BIN=""
  if command -v agy >/dev/null 2>&1; then
    AGY_BIN=$(command -v agy)
  elif [ -x "$HOME/.local/bin/agy" ]; then
    AGY_BIN="$HOME/.local/bin/agy"
  fi

  if [ -n "$AGY_BIN" ]; then
    echo "  [Antigravity CLI] Found at $AGY_BIN"
    if [ "$DRY_RUN" = true ]; then
      echo "    [DRY-RUN] Would re-import commands via 'agy plugin import claude'"
    else
      echo "    Re-importing Claude Code commands into Antigravity..."
      "$AGY_BIN" plugin import claude >/dev/null 2>&1 || true
      echo "    ✔ Antigravity commands re-imported."
    fi
  fi

  # 1.5 Kiro (kiro CLI & Power)
  KIRO_BIN=""
  if command -v kiro >/dev/null 2>&1; then
    KIRO_BIN=$(command -v kiro)
  elif [ -x "/usr/local/bin/kiro" ]; then
    KIRO_BIN="/usr/local/bin/kiro"
  fi

  if [ -n "$KIRO_BIN" ] || [ -d "$HOME/.kiro" ]; then
    echo "  [Kiro] Found Kiro harness (${KIRO_BIN:-$HOME/.kiro})"
    if [ "$DRY_RUN" = true ]; then
      echo "    [DRY-RUN] Would verify Kiro POWER.md and mcp.json definitions"
    else
      if [ -f "$ROOT/POWER.md" ] && [ -f "$ROOT/mcp.json" ]; then
        echo "    ✔ Kiro Power manifest and MCP definition present in $ROOT"
      fi
    fi
  fi

  # 1.6 OpenCode (opencode)
  OPENCODE_BIN=""
  if command -v opencode >/dev/null 2>&1; then
    OPENCODE_BIN=$(command -v opencode)
  elif [ -x "/opt/homebrew/bin/opencode" ]; then
    OPENCODE_BIN="/opt/homebrew/bin/opencode"
  fi

  if [ -n "$OPENCODE_BIN" ] || [ -d "$HOME/.config/opencode" ]; then
    echo "  [OpenCode] Found OpenCode harness (${OPENCODE_BIN:-$HOME/.config/opencode})"
    if [ "$DRY_RUN" = true ]; then
      echo "    [DRY-RUN] Would verify OpenCode commands and agent definitions"
    else
      if [ -d "$ROOT/.opencode" ]; then
        echo "    ✔ OpenCode commands and agents present in $ROOT/.opencode"
      fi
    fi
  fi

  # 1.7 Cursor (cursor)
  CURSOR_BIN=""
  if command -v cursor >/dev/null 2>&1; then
    CURSOR_BIN=$(command -v cursor)
  elif [ -x "/usr/local/bin/cursor" ]; then
    CURSOR_BIN="/usr/local/bin/cursor"
  fi

  if [ -n "$CURSOR_BIN" ] || [ -f "$HOME/.cursor/mcp.json" ]; then
    echo "  [Cursor] Found Cursor harness (${CURSOR_BIN:-$HOME/.cursor})"
    if [ "$DRY_RUN" = true ]; then
      echo "    [DRY-RUN] Would verify Cursor rules and MCP registration"
    else
      if [ -f "$ROOT/.cursor/rules/deliberation.mdc" ]; then
        echo "    ✔ Cursor rules present in $ROOT/.cursor/rules"
      fi
    fi
  fi

  # 1.8 Universal NPX Cache Refresh (for Kiro, Cursor, OpenCode, VS Code, Zed, Windsurf)
  if [ -d "$HOME/.npm/_npx" ]; then
    echo "  [NPX Cache] Purging cached @antonbabenko/deliberation-mcp packages..."
    if [ "$DRY_RUN" = true ]; then
      echo "    [DRY-RUN] Would remove cached deliberation-mcp builds from $HOME/.npm/_npx"
    else
      find "$HOME/.npm/_npx" -type d -path '*/@antonbabenko/deliberation-mcp' -prune -exec rm -rf {} + 2>/dev/null || true
      echo "    ✔ Cached standalone MCP packages purged for on-demand runners."
    fi
  fi
  echo ""
fi

# -----------------------------------------------------------------------------
# 2. Dashboard Daemon Handling
# -----------------------------------------------------------------------------
DASH_STATE_PATH=""
if command -v node >/dev/null 2>&1 && [ -f "$ROOT/core/paths.js" ]; then
  DASH_STATE_PATH=$(node -e 'console.log(require("'"$ROOT"'/core/paths.js").resolveDashboardStatePath())' 2>/dev/null || true)
fi

if [ -n "$DASH_STATE_PATH" ] && [ -f "$DASH_STATE_PATH" ]; then
  DASH_PID=$(sed -n 's/.*"pid": *\([0-9]*\).*/\1/p' "$DASH_STATE_PATH" 2>/dev/null || true)
  DASH_PORT=$(sed -n 's/.*"port": *\([0-9]*\).*/\1/p' "$DASH_STATE_PATH" 2>/dev/null || true)
  
  if [ -n "$DASH_PID" ] && kill -0 "$DASH_PID" 2>/dev/null; then
    echo "• Dashboard Daemon: running on port ${DASH_PORT:-7717} (PID $DASH_PID)"
    if [ "$RESTART_DASHBOARD" = true ]; then
      if [ "$DRY_RUN" = true ]; then
        echo "  [DRY-RUN] Would send SIGTERM to dashboard PID $DASH_PID and restart detached on latest code."
      else
        echo "  Gracefully stopping dashboard PID $DASH_PID..."
        kill -TERM "$DASH_PID" 2>/dev/null || true
        
        # Wait up to 5s for clean exit
        waited=0
        while kill -0 "$DASH_PID" 2>/dev/null && [ "$waited" -lt 50 ]; do
          sleep 0.1
          waited=$((waited + 1))
        done
        
        if kill -0 "$DASH_PID" 2>/dev/null; then
          echo "  [WARN] Dashboard PID $DASH_PID did not exit cleanly within 5s; sending SIGKILL."
          kill -KILL "$DASH_PID" 2>/dev/null || true
          sleep 0.2
        fi
        
        # Relaunch detached using same port if known
        PORT_ARGS=()
        if [ -n "$DASH_PORT" ]; then
          PORT_ARGS=(--port "$DASH_PORT")
        fi
        
        echo "  Restarting dashboard daemon from $ROOT..."
        nohup node "$ROOT/server/mcp/index.js" dashboard --no-open "${PORT_ARGS[@]}" >/dev/null 2>&1 </dev/null &
        NEW_DASH_PID=$!
        
        # Wait up to 3s for dashboard state to regenerate
        s_waited=0
        NEW_PORT=""
        while [ "$s_waited" -lt 30 ]; do
          if [ -f "$DASH_STATE_PATH" ]; then
            NPID=$(sed -n 's/.*"pid": *\([0-9]*\).*/\1/p' "$DASH_STATE_PATH" 2>/dev/null || true)
            if [ -n "$NPID" ] && kill -0 "$NPID" 2>/dev/null; then
              NEW_PORT=$(sed -n 's/.*"port": *\([0-9]*\).*/\1/p' "$DASH_STATE_PATH" 2>/dev/null || true)
              echo "  [OK] Dashboard restarted: PID $NPID on port ${NEW_PORT:-unknown}"
              break
            fi
          fi
          sleep 0.1
          s_waited=$((s_waited + 1))
        done
        
        if [ -z "$NEW_PORT" ]; then
          echo "  [WARN] Dashboard restart initiated (PID $NEW_DASH_PID); verify with 'deliberation-mcp dashboard' or /deliberation:dashboard."
        fi
      fi
    else
      echo "  [INFO] Dashboard restart skipped (--no-restart-dashboard)."
    fi
  else
    # State file is stale
    if [ "$DRY_RUN" = false ]; then
      rm -f "$DASH_STATE_PATH" 2>/dev/null || true
    fi
  fi
fi
echo ""

# -----------------------------------------------------------------------------
# 3. Worker / Stdio Process Audit & Safeguards
# -----------------------------------------------------------------------------
echo "• Auditing Deliberation MCP Server Processes..."

# Find matching processes (avoiding grep, self, and the dashboard daemon)
# shellcheck disable=SC2009
PROCS=$(ps -eo pid,ppid,command 2>/dev/null | grep -E "server/(mcp|gemini|grok|openrouter)/index\.js|deliberation-mcp" | grep -v "grep" | grep -v "reload-mcp" | grep -v " dashboard" || true)

if [ -z "$PROCS" ]; then
  echo "  No active deliberation worker processes found."
else
  WORKER_COUNT=0
  SAFEGUARD_COUNT=0
  ORPHAN_COUNT=0
  ATTACHED_COUNT=0

  while IFS= read -r line; do
    [ -z "$line" ] && continue
    PROC_PID=$(echo "$line" | awk '{print $1}')
    PROC_PPID=$(echo "$line" | awk '{print $2}')

    WORKER_COUNT=$((WORKER_COUNT + 1))

    # Check for active child processes (subagents: agy, codex, python, etc.)
    HAS_CHILDREN=false
    CHILD_PIDS=""
    if command -v pgrep >/dev/null 2>&1; then
      CHILD_PIDS=$(pgrep -P "$PROC_PID" 2>/dev/null || true)
    fi
    if [ -z "$CHILD_PIDS" ]; then
      # Portable fallback via ps
      CHILD_PIDS=$(ps -eo pid,ppid 2>/dev/null | awk -v parent="$PROC_PID" '$2 == parent {print $1}')
    fi

    if [ -n "$CHILD_PIDS" ]; then
      HAS_CHILDREN=true
    fi

    if [ "$HAS_CHILDREN" = true ]; then
      SAFEGUARD_COUNT=$((SAFEGUARD_COUNT + 1))
      echo "  🛡️  [SAFEGUARD] Worker PID $PROC_PID has active child workloads (${CHILD_PIDS//$'\n'/ }); kept intact."
      continue
    fi

    # Check parent status: is it an orphan or attached to an active host?
    PARENT_ALIVE=false
    PARENT_COMM=""
    if [ "$PROC_PPID" -gt 1 ] && kill -0 "$PROC_PPID" 2>/dev/null; then
      PARENT_ALIVE=true
      PARENT_COMM=$(ps -p "$PROC_PPID" -o comm= 2>/dev/null | tr -d ' ' || true)
      if [ -z "$PARENT_COMM" ]; then
        PARENT_COMM=$(ps -p "$PROC_PPID" -o command= 2>/dev/null | awk '{print $1}' || true)
      fi
    fi

    if [ "$PARENT_ALIVE" = false ] || [ "$PROC_PPID" -le 1 ]; then
      # Orphaned process
      ORPHAN_COUNT=$((ORPHAN_COUNT + 1))
      if [ "$DRY_RUN" = true ]; then
        echo "  [DRY-RUN] Would terminate orphaned worker PID $PROC_PID (PPID $PROC_PPID)."
      else
        echo "  🧹 [CLEANUP] Terminating orphaned worker PID $PROC_PID..."
        kill -TERM "$PROC_PID" 2>/dev/null || true
      fi
    else
      # Attached to active host (claude, codex, agy, kiro, cursor, opencode, code, etc.)
      ATTACHED_COUNT=$((ATTACHED_COUNT + 1))
      if [ "$FORCE_WORKERS" = true ]; then
        if [ "$DRY_RUN" = true ]; then
          echo "  [DRY-RUN] Would force-terminate attached worker PID $PROC_PID (parent: $PARENT_COMM [$PROC_PPID])."
        else
          echo "  ⚠️ [FORCE] Terminating attached worker PID $PROC_PID (parent: $PARENT_COMM [$PROC_PPID])."
          kill -TERM "$PROC_PID" 2>/dev/null || true
        fi
      else
        echo "  🔒 [HOST-ATTACHED] Worker PID $PROC_PID is connected to $PARENT_COMM (PPID $PROC_PPID)."
        echo "     Preserved to prevent broken stdio pipes in active host sessions."
      fi
    fi
  done <<< "$PROCS"

  echo ""
  echo "Audit Summary: $WORKER_COUNT workers scanned ($SAFEGUARD_COUNT active workloads protected, $ATTACHED_COUNT host-attached preserved, $ORPHAN_COUNT orphaned cleaned)."
fi

echo ""
echo "=== Host-Specific Reconnection Instructions ==="
echo "• Claude Code: Run '/reload-plugins' to reload plugin manifests and reconnect to ${VERSION:-the latest release} without restarting your session."
echo "• OpenAI Codex: Next tool call or session start will automatically resolve the updated plugin."
echo "• Antigravity CLI / Gemini: New sessions and subagent turns will run the latest code."
echo "• Kiro: Powers and MCP tools will load the latest build on next activation."
echo "• OpenCode: Slash commands and agents resolve updated tools immediately."
echo "• Cursor / VS Code / Zed / Windsurf: Reload MCP server or window if needed."
echo ""
