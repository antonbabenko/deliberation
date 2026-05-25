---
name: setup
description: Configure claude-delegator with Codex (GPT) or Gemini MCP servers
allowed-tools: Bash, Read, Write, Edit, AskUserQuestion
timeout: 60000
---

# Setup

Configure GPT (via Codex) or Gemini as specialized expert subagents via native MCP. Five domain experts that can advise OR implement.

## Step 1: Check CLI Dependencies

### Codex (GPT)
```bash
which codex 2>/dev/null && codex --version 2>&1 | head -1 || echo "CODEX_MISSING"
```

### Gemini (Antigravity CLI)
```bash
# agy has no --version flag; presence on PATH is the install signal.
which agy 2>/dev/null && echo "agy: installed" || echo "GEMINI_MISSING"
```

### Grok (xAI)
```bash
# Grok is API-based (no CLI). It needs XAI_API_KEY in the environment.
[ -n "$XAI_API_KEY" ] && echo "Grok: XAI_API_KEY set" || echo "XAI_API_KEY_MISSING"
```

### If Missing

**Codex Missing:**
```
Codex CLI not found.
Install with: npm install -g @openai/codex
Then authenticate: codex login
```

**Gemini Missing:**
```
Antigravity CLI (agy) not found.
Install Antigravity from https://antigravity.google
Then authenticate: run `agy` once and complete sign-in (or set the model in ~/.gemini/settings.json)
```

**Grok key missing (XAI_API_KEY_MISSING):**
```
XAI_API_KEY is not set.
Grok is API-based - there is no CLI to install. Get a key at https://console.x.ai
then: export XAI_API_KEY=xai-...   (add it to your shell profile to persist)
```

**STOP here if no providers are installed.**

## Step 2: Configure MCP Servers

Register your preferred provider(s) as MCP servers using Claude Code's native command:

### Codex (GPT)
```bash
# Idempotent: safe to rerun setup
claude mcp remove codex >/dev/null 2>&1 || true
claude mcp add --transport stdio --scope user codex -- codex -m gpt-5.3-codex mcp-server
```

### Gemini
```bash
# Idempotent: safe to rerun setup
claude mcp remove gemini >/dev/null 2>&1 || true
claude mcp add --transport stdio --scope user gemini -- node ${CLAUDE_PLUGIN_ROOT}/server/gemini/index.js
```

### Grok (xAI)
```bash
# Idempotent: safe to rerun setup. Registered WITHOUT --env so the key is NOT
# written to ~/.claude.json. The bridge inherits XAI_API_KEY from the environment
# that launches Claude Code, so export it in your shell profile to persist it.
claude mcp remove grok >/dev/null 2>&1 || true
claude mcp add --transport stdio --scope user grok -- node ${CLAUDE_PLUGIN_ROOT}/server/grok/index.js
if [ -z "$XAI_API_KEY" ]; then
  echo "Note: XAI_API_KEY not set in this environment; Grok calls return missing-auth until you export it (add it to your shell profile) and restart Claude Code."
fi
```

Want the key persisted in config instead of an exported env var? Add `--env XAI_API_KEY="$XAI_API_KEY"` before `-- node ...` on the command above. That writes the key in plaintext into `~/.claude.json`, so only do it if you accept storing a secret on disk.

This registers the MCP servers at user scope (available across all projects).

**Grok file TTL (optional):** files Grok uploads default to a 7-day `expires_after` so they
self-delete. To change it, export `GROK_FILE_TTL_SECONDS=<seconds>` (1h..30d, i.e. 3600..2592000)
in Claude Code's launch environment, or add `--env GROK_FILE_TTL_SECONDS=<seconds>` on the `grok`
registration. Prune bridge-owned files early any time with `/grok-files prune --older-than <age>`.

**Grok reasoning effort (optional):** defaults to `high`. Override by exporting
`GROK_REASONING_EFFORT=<low|medium|high|none>` in Claude Code's launch environment, or add
`--env GROK_REASONING_EFFORT=<low|medium|high|none>` on the `grok` registration, or set it per
call with the `reasoning_effort` parameter; `none` omits the field so the model uses its default.

**Note:** To customise Codex behaviour, add CLI flags before `mcp-server`.
- For Codex: `-p nosandbox`

## Step 3: Install Orchestration Rules

```bash
mkdir -p ~/.claude/rules/delegator && cp ${CLAUDE_PLUGIN_ROOT}/rules/*.md ~/.claude/rules/delegator/
```

## Step 3b: Optional Short Command Names

The delegation commands ship with the plugin and are always available
namespaced: `/claude-delegator:ask-gpt`, `:ask-gemini`, `:ask-grok`,
`:ask-all`, `:consensus`.

Offer the short, unnamespaced aliases (`/ask-gpt` etc.) by copying them into
`~/.claude/commands/`.

Use AskUserQuestion: "Also install short command names (/ask-gpt etc.) into
~/.claude/commands?" Options: "Yes (recommended)" / "No, keep namespaced only".

**If yes**, run (installs only the missing aliases; pre-existing files are skipped
and collected so you can decide about them next):
```bash
mkdir -p ~/.claude/commands
collisions=""
for c in ask-gpt ask-gemini ask-grok ask-all consensus grok-files; do
  dest=~/.claude/commands/$c.md
  if [ -e "$dest" ]; then
    echo "skip $c: ~/.claude/commands/$c.md already exists (left untouched)"
    collisions="$collisions $c"
  else
    cp "${CLAUDE_PLUGIN_ROOT}/commands/$c.md" "$dest" && echo "installed /$c"
  fi
done
echo "COLLISIONS:$collisions"
```

If `COLLISIONS` is empty, you are done. If it lists names, ask before touching
those files. Use AskUserQuestion: "These alias file(s) already exist:[list].
Overwrite them with the bundled versions?" Options (default first = keep):
"No, keep existing (recommended)" / "Yes, overwrite".

**Only if the user picks "Yes, overwrite"**, force-copy just the collided names:
```bash
for c in <collided names>; do
  cp -f "${CLAUDE_PLUGIN_ROOT}/commands/$c.md" ~/.claude/commands/$c.md && echo "overwrote /$c"
done
```
Keeping the existing files is the default; overwrite only on explicit opt-in.

**If no**, skip - the namespaced commands still work.

## Step 4: Verify Installation

Run these checks and report results:

```bash
# Check 1: CLI versions
codex --version 2>&1 | head -1 || echo "Not installed"
agy --help 2>&1 | head -1 || echo "Not installed"

# Check 2: Codex MCP server
CODEX_CONFIG=$(claude mcp get codex 2>/dev/null)
if echo "$CODEX_CONFIG" | grep -q "codex"; then
  MODEL=$(echo "$CODEX_CONFIG" | grep -oE 'gpt-[0-9]+\.[0-9]+-?[a-z]*' | head -1)
  echo "Codex: OK (model: ${MODEL:-unknown})"
else
  echo "Codex: NOT CONFIGURED"
fi

# Check 3: Gemini MCP server
GEMINI_CONFIG=$(claude mcp get gemini 2>/dev/null)
if echo "$GEMINI_CONFIG" | grep -q "server/gemini/index.js"; then
  GEMINI_MODEL="${GEMINI_DEFAULT_MODEL:-auto-gemini-3}"
  echo "Gemini: OK (model: $GEMINI_MODEL)"
else
  echo "Gemini: NOT CONFIGURED"
fi

# Check 4: Gemini bridge health (initialize handshake)
if echo "$GEMINI_CONFIG" | grep -q "server/gemini/index.js"; then
  BRIDGE_HEALTH=$(printf '{"jsonrpc":"2.0","id":"health","method":"initialize","params":{}}\n' \
    | node "${CLAUDE_PLUGIN_ROOT}/server/gemini/index.js" 2>/dev/null \
    | grep -q '"id":"health"' && echo "Gemini Bridge: HEALTHY" || echo "Gemini Bridge: UNHEALTHY")
  echo "$BRIDGE_HEALTH"
else
  echo "Gemini Bridge: SKIPPED (Gemini MCP not configured)"
fi

# Check 4a: Gemini model validation
# agy reads the model from ~/.gemini/settings.json (model.name); the bridge cannot
# override it per call. Warn if the configured model is not a known Gemini 3 value.
GEMINI_SETTINGS_MODEL=$(node -e 'try{const s=require(require("os").homedir()+"/.gemini/settings.json");process.stdout.write((s.model&&s.model.name)||"")}catch(e){process.stdout.write("")}' 2>/dev/null)
case "$GEMINI_SETTINGS_MODEL" in
  auto-gemini-3|gemini-3-pro-preview|gemini-3-flash-preview)
    echo "Gemini model: $GEMINI_SETTINGS_MODEL (OK)"
    ;;
  "")
    echo "Gemini model: not set in ~/.gemini/settings.json (agy default: auto-gemini-3)"
    ;;
  *)
    echo "Gemini model: $GEMINI_SETTINGS_MODEL (WARNING: unexpected value)"
    echo "  The bridge cannot override the model per call. Set it via \`agy\` /model or by editing ~/.gemini/settings.json (model.name) to one of: auto-gemini-3, gemini-3-pro-preview, gemini-3-flash-preview."
    ;;
esac

# Check 4b: Grok MCP server + bridge health
GROK_CONFIG=$(claude mcp get grok 2>/dev/null)
if echo "$GROK_CONFIG" | grep -q "server/grok/index.js"; then
  GROK_MODEL="${GROK_DEFAULT_MODEL:-grok-4.3}"
  echo "Grok: OK (model: $GROK_MODEL)"
  GROK_HEALTH=$(printf '{"jsonrpc":"2.0","id":"health","method":"initialize","params":{}}\n' \
    | node "${CLAUDE_PLUGIN_ROOT}/server/grok/index.js" 2>/dev/null \
    | grep -q '"id":"health"' && echo "Grok Bridge: HEALTHY" || echo "Grok Bridge: UNHEALTHY")
  echo "$GROK_HEALTH"
  [ -n "$XAI_API_KEY" ] && echo "Grok Auth: XAI_API_KEY set" || echo "Grok Auth: XAI_API_KEY NOT set (calls return missing-auth)"
else
  echo "Grok: NOT CONFIGURED"
fi

# Check 5: Rules installed (count files)
ls ~/.claude/rules/delegator/*.md 2>/dev/null | wc -l

# Check 6: Codex auth status
codex login status 2>&1 | head -1 || echo "Codex: Run 'codex login'"
```

## Step 5: Report Status

Display actual values from the checks above:

```
claude-delegator Status
───────────────────────────────────────────────────
Codex CLI:       [version from check 1]
Antigravity CLI: [agy install signal from check 1]
Codex MCP:       [status + model from check 2]
Gemini MCP:      [status + model from check 3]
Gemini Bridge:   [status from check 4]
Gemini model:    [value from check 4a]
Grok MCP:        [status + model from check 4b]
Rules:           ✓ [N] files in ~/.claude/rules/delegator/
Codex Auth:      [status from check 6]
Grok Auth:       [XAI_API_KEY status from check 4b]
───────────────────────────────────────────────────
```

If any check fails, report the specific issue and how to fix it.

## Step 6: Final Instructions

```
Setup complete!

Next steps:
1. Restart Claude Code to load MCP server(s)
2. Authenticate providers as needed:
   - Codex: Run `codex login`
   - Gemini: Run `agy` once and complete sign-in (or set the model in ~/.gemini/settings.json)
   - Grok: export XAI_API_KEY=xai-... (get a key at https://console.x.ai) in your shell profile, then restart Claude Code

Five experts available:

┌──────────────────┬─────────────────────────────────────────────┐
│ Architect        │ "How should I structure this service?"      │
│                  │ "What are the tradeoffs of Redis vs X?"     │
│                  │ → System design, architecture decisions     │
├──────────────────┼─────────────────────────────────────────────┤
│ Plan Reviewer    │ "Review this migration plan"                │
│                  │ "Is this implementation plan complete?"     │
│                  │ → Plan validation before execution          │
├──────────────────┼─────────────────────────────────────────────┤
│ Scope Analyst    │ "Clarify the scope of this feature"         │
│                  │ "What am I missing in these requirements?"  │
│                  │ → Pre-planning, catches ambiguities         │
├──────────────────┼─────────────────────────────────────────────┤
│ Code Reviewer    │ "Review this PR"                            │
│                  │ "Find issues in this implementation"        │
│                  │ → Code quality, bugs, maintainability       │
├──────────────────┼─────────────────────────────────────────────┤
│ Security Analyst │ "Is this authentication flow secure?"       │
│                  │ "Harden this endpoint"                      │
│                  │ → Vulnerabilities, threat modeling          │
├──────────────────┼─────────────────────────────────────────────┤
│ Researcher       │ "How do I use this library?"                │
│                  │ "Find examples of X"                        │
│                  │ → External libraries, docs, best practices  │
└──────────────────┴─────────────────────────────────────────────┘

Every expert can advise (read-only) OR implement (write).
Expert is auto-detected based on your request.
Explicit: "Ask GPT to...", "Ask Gemini to...", or "Ask Grok to..."
```

## Step 7: Ask About Starring

Use AskUserQuestion to ask the user if they'd like to ⭐ star the claude-delegator repository on GitHub to support the project.

Options: "Yes, star the repo" / "No thanks"

**If yes**: Check if `gh` CLI is available and run:
```bash
gh api -X PUT /user/starred/antonbabenko/claude-delegator
```

If `gh` is not available or the command fails, provide the manual link:
```
https://github.com/antonbabenko/claude-delegator
```

**If no**: Thank them and complete setup without starring.
