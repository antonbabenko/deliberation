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
set -u

ok(){ printf '[OK]   %s\n' "$1"; }
warn(){ printf '[WARN] %s\n' "$1"; }
fail(){ printf '[FAIL] %s\n' "$1"; }

# --- plugin root + version: env -> marketplace cache (highest semver) -> checkout ---
resolve_plugin_root() {
  if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -f "$CLAUDE_PLUGIN_ROOT/server/mcp/index.js" ]; then printf '%s' "$CLAUDE_PLUGIN_ROOT"; return 0; fi
  local c; c=$(find "$HOME/.claude/plugins/cache" -maxdepth 6 -path '*/deliberation/*/server/mcp/index.js' -type f 2>/dev/null | sort -V | tail -1)
  if [ -n "$c" ]; then printf '%s' "${c%/server/mcp/index.js}"; return 0; fi
  if [ -f "$PWD/server/mcp/index.js" ] && grep -q '"name": "deliberation"' "$PWD/.claude-plugin/plugin.json" 2>/dev/null; then printf '%s' "$PWD"; return 0; fi
  return 1
}
echo "== deliberation doctor =="
PR="$(resolve_plugin_root || true)"
if [ -n "$PR" ]; then
  VER="$(node -e "process.stdout.write(require('$PR/package.json').version||'?')" 2>/dev/null || echo '?')"
  ok "plugin found ($PR, v$VER)"
else
  fail "plugin root not found"; echo "       fix: reinstall with /plugin, then /deliberation:setup"
fi

# --- config: env override > canonical XDG ---
CFG="${DELIBERATION_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/deliberation/config.json}"
case "$CFG" in /*) ;; *) CFG="$HOME/.config/deliberation/config.json";; esac
if [ -f "$CFG" ]; then
  if node -e "JSON.parse(require('fs').readFileSync('$CFG','utf8'))" 2>/dev/null; then
    ok "config valid ($CFG)"
    node -e '
      const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
      const s=c.sessions||{}, d=c.debug||{};
      console.log((s.persist?"[OK]   ":"[WARN] ")+"sessions.persist: "+(!!s.persist)+(s.persist?"":"  fix: set sessions.persist:true for /analyze Lens B"));
      console.log((d.enabled?"[OK]   ":"[WARN] ")+"debug.enabled: "+(!!d.enabled)+(d.enabled?"":"  fix: set debug.enabled:true for /analyze Lens A"));
    ' "$CFG"
  else
    fail "config is not valid JSON ($CFG)"; echo "       fix: correct the JSON, or move it aside and run /deliberation:setup"
  fi
else
  warn "no config at $CFG"; echo "       fix: run /deliberation:setup"
fi

# --- provider CLIs (presence + version only; auth is confirmed by a real /ask-* call) ---
if command -v codex >/dev/null 2>&1; then ok "codex CLI on PATH ($(codex --version 2>/dev/null | head -1))"; else warn "codex (GPT) not on PATH"; echo "       fix: install the Codex CLI, or ignore if you don't use GPT"; fi
if command -v agy >/dev/null 2>&1; then ok "agy CLI on PATH (Gemini)"; else warn "agy (Gemini) not on PATH"; echo "       fix: install the Antigravity CLI, or ignore if you don't use Gemini"; fi
[ -n "${XAI_API_KEY:-}" ] && ok "XAI_API_KEY set (Grok)" || warn "XAI_API_KEY unset - Grok calls return missing-auth"
[ -n "${OPENROUTER_API_KEY:-}" ] && ok "OPENROUTER_API_KEY set" || warn "OPENROUTER_API_KEY unset - OpenRouter models will error"

# --- sessions dir the SHELL resolves (compared to the server's in step 2) ---
SD="${DELIBERATION_SESSIONS:-${XDG_CACHE_HOME:-$HOME/.cache}/deliberation/sessions}"
case "$SD" in /*) ;; *) SD="$HOME/.cache/deliberation/sessions";; esac
echo "SHELL_SESSIONS_DIR=$SD"
if [ -d "$SD" ]; then
  N=$(ls -1 "$SD"/*.json 2>/dev/null | wc -l | tr -d ' ')
  ok "sessions dir exists ($SD, $N record(s))"
else
  warn "sessions dir not found ($SD) - nothing persisted there yet"
fi

# --- stale user-scope MCP registrations (the inline plugin manifest is the SSOT) ---
LEFT="$(node -e 'try{const fs=require("fs"),h=require("os").homedir();const j=JSON.parse(fs.readFileSync(h+"/.claude.json","utf8"));const m=j.mcpServers||{};process.stdout.write(Object.keys(m).filter(k=>k==="deliberation"||k.indexOf("deliberation-")===0).join(" "))}catch(e){}')"
[ -n "$LEFT" ] && { warn "user-scope MCP entries shadow the plugin manifest: $LEFT"; echo "       fix: /deliberation:uninstall (then they load from the plugin)"; } || ok "no shadowing user-scope MCP registrations"
echo "== end local checks =="
```

## Step 2: Runtime path drift (ONE `analyze` call)

Call the tool, then compare the server's resolved sessions dir to the shell's:

```
mcp__deliberation__analyze({})
```

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
