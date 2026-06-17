---
name: help
description: Show how to use deliberation here - what each command does, when to reach for it, and real prompts you can paste right now. Read-only.
allowed-tools: Bash
timeout: 15000
---

# Help

Deliberation gives you a second opinion from GPT, Gemini, Grok, and OpenRouter,
without leaving your editor. You ask; they answer independently; Claude reads the
answers back to you. The experts advise by default - GPT and Gemini can also make
changes when you ask them to.

## Step 1: One quick look at your setup (ONE Bash call)

```bash
set -u
host="Claude Code"
[ -n "${CURSOR_TRACE_ID:-}${CURSOR:-}" ] && host="Cursor"
[ -n "${KIRO_VERSION:-}${KIRO:-}" ] && host="Kiro"
[ -n "${CODEX_HOME:-}" ] && [ -z "${CLAUDECODE:-}" ] && host="Codex CLI"
echo "Host: $host"
CFG="${DELIBERATION_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/deliberation/config.json}"
case "$CFG" in /*) ;; *) CFG="$HOME/.config/deliberation/config.json";; esac
[ -f "$CFG" ] && echo "Config: found" || echo "Config: missing - run /deliberation:setup first"
[ -n "${XAI_API_KEY:-}" ] && echo "Grok key: set" || echo "Grok key: unset (Grok will skip)"
[ -n "${OPENROUTER_API_KEY:-}" ] && echo "OpenRouter key: set" || echo "OpenRouter key: unset (OpenRouter will skip)"
```

If the host is not Claude Code, tell the user the commands work the same way but
the exact syntax can differ on their host, and point them at the per-host guides
in the project's `public-docs/hosts/`. Then show the rest of this guide.

## Step 2: Show the guide

Render the sections below. Keep it tight - this is a cheat sheet, not a manual.

### What each command is for

| Command | Use it when |
|---------|-------------|
| `/ask-gpt`, `/ask-gemini`, `/ask-grok`, `/ask-openrouter` | You want one model's take on something. |
| `/ask-all` | You want several models in parallel and a side-by-side read. |
| `/consensus` | The decision matters and you want the models to argue to one verdict. |
| `/deliberation:analyze` | You want to see which models are slow or rarely add anything. |
| `/deliberation:doctor` | Something looks broken - commands missing, providers failing, empty analyze. |
| `/deliberation:setup` | First install, or to repair the install. |

### Prompts you can paste right now

```text
# Quick second opinion on what you're doing
/ask-gpt Is the token-expiry check in my auth middleware off-by-one? It uses < not <=.

# Several models at once, then compare
/ask-all Review the current diff for real bugs, security issues, and missing tests.

# Make a hard call with the models cross-checking each other
/consensus Should this be a config migration or a backward-compatible fallback? Tradeoffs: <paste them>

# Hand a stubborn bug to the debugger
/ask-gemini Debug why this test fails intermittently, ranked by likelihood: <paste the error>

# Weigh an architecture choice
/ask-gpt Keep provider routing in one module or split it per provider? Weigh maintainability vs testability.

# Research without leaving your editor
/ask-grok Best way to validate Node CLI auth state without mutating the user's config?
```

### Tips

- Add an expert by name to sharpen the answer: "as the security-analyst, ..." or
  "have the code-reviewer ...". The seven experts: architect, plan-reviewer,
  scope-analyst, code-reviewer, security-analyst, researcher, debugger.
- Point at files in your prompt - the local experts (GPT, Gemini) can read them.
- Stuck? Run `/deliberation:doctor`. Curious which models earn their slot? `/deliberation:analyze`.

## Rules

- Read-only. This command only explains - it changes nothing.
- Keep it short and concrete. Lead with the paste-ready prompts; skip the theory.
- Be honest about the host: if it is not Claude Code, say the syntax may differ.
