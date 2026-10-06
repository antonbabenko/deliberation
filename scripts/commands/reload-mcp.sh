#!/usr/bin/env bash
# scripts/commands/reload-mcp.sh
# Gracefully cycle dashboard and audit MCP processes after deliberation is updated.
#
# Usage:
#   bash scripts/commands/reload-mcp.sh [options]
#
# Options:
#   --dry-run                Inspect running processes without signaling or restarting
#   --no-restart-dashboard   Do not restart the dashboard daemon if it is running
#   --force-workers          Send SIGTERM to idle attached workers (may cause host pipe disconnect)
#   --help, -h               Show this help message

set -u

DRY_RUN=false
RESTART_DASHBOARD=true
FORCE_WORKERS=false

for arg in "$@"; do
  case "$arg" in
    --dry-run)
      DRY_RUN=true
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
      echo "Gracefully cycle the dashboard daemon and audit running Deliberation MCP"
      echo "processes after a plugin or package update."
      echo ""
      echo "Options:"
      echo "  --dry-run                Inspect running processes without signaling or restarting"
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
  VERSION=$(sed -n 's/.*"version": *"\{0,1\}\([^",]*\)"\{0,1\}.*/\1/p' "$ROOT/package.json" | head -n 1)
elif [ -f "$ROOT/.claude-plugin/plugin.json" ]; then
  VERSION=$(sed -n 's/.*"version": *"\{0,1\}\([^",]*\)"\{0,1\}.*/\1/p' "$ROOT/.claude-plugin/plugin.json" | head -n 1)
fi

echo "=== Deliberation MCP Reload & Process Audit ==="
echo "Plugin root: $ROOT"
echo "Target version: ${VERSION:-unknown}"
if [ "$DRY_RUN" = true ]; then
  echo "Mode: DRY RUN (no processes will be signaled or started)"
fi
echo ""

# -----------------------------------------------------------------------------
# 1. Dashboard Daemon Handling
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
        PORT_ARG=""
        if [ -n "$DASH_PORT" ]; then
          PORT_ARG="--port $DASH_PORT"
        fi
        
        echo "  Restarting dashboard daemon from $ROOT..."
        nohup node "$ROOT/server/mcp/index.js" dashboard --no-open $PORT_ARG >/dev/null 2>&1 </dev/null &
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
# 2. Worker / Stdio Process Audit & Safeguards
# -----------------------------------------------------------------------------
echo "• Auditing Deliberation MCP Server Processes..."

# Find matching processes (avoiding grep, self, and the dashboard daemon)
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
    CMD=$(echo "$line" | awk '{$1=""; $2=""; print $0}' | sed 's/^ *//')

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
      # Attached to active host (claude, codex, agy, Cursor, opencode, etc.)
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
echo "• OpenCode / Cursor: Restart MCP server via host command or palette if needed."
echo ""
