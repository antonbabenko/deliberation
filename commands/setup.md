---
name: setup
description: Configure deliberation with Codex (GPT), Gemini, Grok, and OpenRouter MCP servers
allowed-tools: Bash, Read, AskUserQuestion
timeout: 60000
---

# Setup

Configure GPT (via Codex), Gemini, Grok, and OpenRouter as expert subagents via MCP, install the
orchestration rules, and (optionally) the short command aliases. Grok and OpenRouter are
advisory-only.

This command runs in three phases: ONE main Bash call (checks + seed config + migrate + install rules + status), then
isolated question turns for the optional aliases and the optional GitHub star. Do not batch a Bash
call with an AskUserQuestion, and do not split the main block.

## Step 1: Run setup

> Run the block below as ONE Bash call. Do NOT split it into smaller calls, and do NOT batch it
> with any other tool call. It is idempotent - safe to re-run.
>
> **Run it with the Bash sandbox DISABLED.** The block writes `~/.claude/rules/deliberation/`
> and `~/.claude.json`, both outside a typical sandbox write allowlist. Under a sandbox those
> writes fail silently; the block verifies the result at the end and prints a `CRITICAL` block
> telling you to re-run unsandboxed if it detects a problem.

The MCP servers are registered by the plugin manifest (inline `mcpServers` in
`.claude-plugin/plugin.json`), so they load automatically when the plugin is enabled and update
with `/plugin marketplace update antonbabenko` + `/reload-plugins`.
This block is non-interactive: it seeds a default `config.json`, checks the provider CLIs, installs
the rules, and prints a status report.

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/commands/setup.sh"
```

If your host does not set `CLAUDE_PLUGIN_ROOT` (see [docs/hosts/](../docs/hosts/)),
pass the plugin directory instead: `bash <plugin-root>/scripts/commands/setup.sh`.

After it runs, report the printed status to the user.

### Optional provider tuning (no extra setup calls needed)

- **Codex model:** Codex reads its model from `~/.codex/config.toml` (`model` key), and that is the
  only place to change it. GPT has no dedicated MCP server (codex-cli ships none) - the unified
  `deliberation` server spawns `codex exec` itself, and deliberately leaves model resolution to
  that file, so there is no per-call or per-server override.
- **Grok key (env vs manifest):** the `deliberation-grok` manifest entry sets no `env`, so the
  bridge inherits `XAI_API_KEY` from Claude Code's launch environment (export it in your shell
  profile - no secret in any committed file). To pin it on the server instead, add an `"env":
  { "XAI_API_KEY": "..." }` block to that entry in the inline `mcpServers` map in
  `.claude-plugin/plugin.json` (note this writes the key in plaintext into the manifest - prefer
  the shell-env path).
- **Grok file TTL / reasoning:** uploads default to a 7-day `expires_after`; override with
  `GROK_FILE_TTL_SECONDS=<3600..2592000>`. Reasoning effort defaults to `high`; override with
  `GROK_REASONING_EFFORT=<low|medium|high|none>` (env, `--env` on the registration, or per call).
  Manage uploads with `/grok-files`. Full reference: [TECHNICAL.md](../TECHNICAL.md#grok-files-and-cleanup).

## Step 2: Optional short command names

The commands are always available namespaced (`/deliberation:ask-gpt`, `:ask-all`, `:consensus`,
...). The short aliases (`/ask-gpt` etc.) are an opt-in copy into `~/.claude/commands/`.
`analyze` is NOT among them - `/analyze` is a common name and a bare copy collides with any
other plugin that ships one.

Ask with `AskUserQuestion` (this turn has NO Bash call): "Also install short command names
(/ask-gpt etc.) into ~/.claude/commands?" Options: "Yes (recommended)" / "No, keep namespaced
only".

**If yes**, run this as ONE isolated Bash call (installs only missing aliases; collects collisions):

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/commands/setup-install-commands.sh"
```

`analyze` is deliberately NOT in that list. `/analyze` is a common name and a bare copy
collides with any other plugin that ships one; use `/deliberation:analyze`, which is always
available and never collides.

If the output contains a `LEGACY_ANALYZE:` line, an older setup installed that alias. Tell the
user the path and that deleting it removes the collision - do NOT delete it yourself, since a
file at that path may be their own.

If `COLLISIONS` is `none`, done. If it lists names, ask with `AskUserQuestion` (own turn, no Bash):
"These alias file(s) already exist:[list]. Overwrite with the bundled versions?" Options (default
first = overwrite): "Yes, overwrite (recommended)" / "No, keep existing".

**Only if "Yes, overwrite"**, run this as ONE isolated Bash call (collided names only):

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/commands/setup-overwrite-commands.sh" <collided names>
```

**If no**, skip - the namespaced commands still work.

## Step 3: Provider auth reminders

Print only the reminders relevant to what the Step-1 status showed as missing:

- Codex: `codex login` (`codex login --device-auth` on a remote or headless machine; never copy `~/.codex/auth.json` between machines), or `CODEX_ACCESS_TOKEN` for a ChatGPT Business/Enterprise workspace
- Gemini: run `agy` once and complete sign-in (or set the model in `~/.gemini/settings.json`)
- Grok: `export XAI_API_KEY=xai-...` (https://console.x.ai) in your shell profile, then restart
- OpenRouter: export the key named by `apiKeyEnv` (default `OPENROUTER_API_KEY`)

Seven experts are available, auto-detected from the request (or explicit: "Ask GPT to...", "Ask
Gemini to...", "Ask Grok to..."), each able to advise (read-only) or implement (write; Grok and
OpenRouter advisory-only): Architect, Plan Reviewer, Scope Analyst, Code Reviewer, Security
Analyst, Researcher, Debugger.

## Step 4: Ask about starring

Ask with `AskUserQuestion` (own turn): would the user like to star the deliberation repo to support
the project? Options: "Yes, star the repo" / "No thanks".

**If yes**, run as ONE isolated Bash call:

```bash
gh api -X PUT /user/starred/antonbabenko/deliberation 2>/dev/null && echo "Starred. Thank you!" || echo "Could not star via gh; star manually at https://github.com/antonbabenko/deliberation"
```

**If no**, thank them and finish.
