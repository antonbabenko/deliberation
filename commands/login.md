---
name: login
description: Log GPT (Codex) in on this machine with a ChatGPT device login - shows a link and a one-time code. For remote or headless sessions (Claude Code on the web). No question is sent to GPT.
allowed-tools: mcp__deliberation__codex-login
timeout: 60000
---

# Login (GPT via codex)

Starts, or joins, the ChatGPT device login for GPT on this machine and shows its link
and one-time code. Nothing is asked of GPT. Use it when GPT has no login here, typically
in a Claude Code web session.

## Workflow

1. Call the tool, with no arguments:
   ```
   mcp__deliberation__codex-login({})
   ```
2. Show the result's `message` to the user **as-is**, never paraphrased and never
   truncated. By `status`:
   - `pending` - the message carries the link and the code. Tell the user to open the
     link, sign in to ChatGPT, and enter the code; GPT answers from their next GPT call.
   - `authenticated` - GPT is already logged in, or the login just landed through a host
     dialog. Nothing else to do.
   - `starting` - codex has not printed its code yet. Run `/deliberation:login` again in
     a few seconds; it joins the same login.
   - `declined` - the user refused the dialog; that login was ended.
   - `failed` / `unavailable` - show the message; it names the cause (no codex CLI, GPT
     disabled in config, a login that ended).
3. Stop. Do not run shell commands, do not read or check `~/.codex/auth.json`, and do not
   call any other deliberation tool in the same turn.

## Rules

- **The user's action, not an answer** - the link and code are for the user to act on.
  Present them plainly; do not summarize them away.
- **One login per session** - calling this again, or calling `/ask-gpt` meanwhile, joins
  the same login and shows the same code until it expires (15 minutes).
- **Never copy credentials** - the login is this machine's own. Never suggest copying
  `auth.json` from another machine: a ChatGPT refresh token works once, so a shared copy
  breaks on the first refresh.
