# Using Deliberation with the Codex plugin

This page is for Claude Code users who use, or are considering, OpenAI's Codex plugin.
[openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) runs Codex reviews from
Claude Code and hands tasks to Codex. Deliberation asks several model families for a second
opinion and runs a review loop across them. The two plugins do different jobs and install side
by side.

Facts about the Codex plugin come from its README as of 2026-11-17: 35,182 GitHub stars,
Apache-2.0, latest release v1.0.6 (published 2026-07-08).

## What each one does

| | Codex plugin | Deliberation |
|-|--------------|--------------|
| Models | Codex (OpenAI) | GPT through the Codex CLI, Gemini through the Antigravity CLI, Grok, OpenRouter models, local Ollama and LM Studio models |
| Review | `/codex:review` (read-only, current changes or `--base <ref>`), `/codex:adversarial-review` (takes focus text) | `/deliberation:ask-all` (parallel answers from the panel), `/deliberation:consensus` (multi-round review until the panel agrees), eight expert personas |
| Hand off work | `/codex:rescue` lets Codex investigate and fix, `/codex:transfer` moves the session into Codex | GPT is advisory only. Only Gemini can edit files, through Deliberation's Gemini bridge (Claude Code plugin) |
| Background jobs | `--background`, `/codex:status`, `/codex:result`, `/codex:cancel` | Calls run in the foreground. `panel` plus parallel `ask-one` calls show per-provider progress |
| Review gate | Optional `Stop` hook (`/codex:setup --enable-review-gate`) that blocks Claude from stopping until a Codex review passes | None. Deliberation is advisory and never blocks |
| Hosts | Claude Code | Claude Code plugin, plus an MCP server for any MCP host and native plugins for Codex, Cursor, Kiro, Antigravity, Gemini CLI and OpenCode |

## Where the Codex plugin fits better

- You want Codex to make the change, not only comment on it. `/codex:rescue` writes code; GPT
  calls in Deliberation are read-only.
- You want to keep working in Codex afterwards. `/codex:transfer` and `codex resume` continue the
  same thread in the Codex app or TUI.
- You want to run long reviews in the background and check on them later.
- You want a hard stop: the review gate keeps Claude from finishing while Codex still finds
  issues. Watch your usage limits if you turn it on; the plugin README warns that the loop can
  run long.
- You only use OpenAI models and do not need other model families.

## What Deliberation adds

- Reviewers from other model families: Gemini, Grok, and any OpenRouter or local model. Different
  families tend to flag different problems.
- A review loop with rules against self-approval. In `/deliberation:consensus`, Claude records its
  verdict before it sees the panel. A round converges only when every responding model approves
  (at least two by default), no accepted critical issue is left, and Claude approves too. Claude
  must give a written reason for every issue it dismisses.
- Expert personas (Security Analyst, Plan Reviewer, Writing Editor and five more) that apply to
  any provider.
- Hosts other than Claude Code.

## They share one Codex login

Both plugins run your local `codex` CLI with its current login. If `codex login` works for one,
it works for the other. The Codex plugin talks to the Codex app server; Deliberation runs
`codex exec --sandbox read-only` for each GPT call.

Model settings are separate. The Codex plugin reads `~/.codex/config.toml` and a trusted
project's `.codex/config.toml`. Deliberation reads the same `~/.codex/config.toml` unless you pin
`providers.codex.model` and `providers.codex.reasoningEffort` in
`~/.config/deliberation/config.json`. The pinned values then apply to Deliberation's calls only.
Pin them when, for example, you want a cheaper model for Deliberation's quick second opinions and a stronger
one for Codex tasks.

Calls from both plugins count against the same Codex usage limits.

## Install both

```
/plugin marketplace add openai/codex-plugin-cc
/plugin install codex@openai-codex
/plugin marketplace add antonbabenko/agent-plugins
/plugin install deliberation@antonbabenko
/reload-plugins
/codex:setup
/deliberation:setup
```

Command names do not collide: one set starts with `/codex:`, the other with `/deliberation:`.
If you let `/deliberation:setup` install its short aliases (`/ask-gpt`, `/consensus` and others),
it asks before it overwrites a command with the same name.

## Workflows

### Plan with the panel, build with Codex

1. Write the plan in Claude Code.
2. Run `/deliberation:consensus` on the plan with the `plan-reviewer` or `architect` expert.
   Fix the panel issues you accept.
3. `/codex:rescue` to implement a step, or implement it in Claude Code.
4. `/codex:review` on the result.

### Two kinds of review before a merge

1. `/codex:review --base main` for a Codex review of the branch.
2. Run the command below for answers from the other model families:

   ```
   /deliberation:ask-all Review the current diff for real bugs, security issues, and missing tests.
   ```

3. Fix the issues from both reviews. Where they disagree, ask a narrower follow-up instead of picking a side.

### Break a deadlock

When Codex and Claude disagree on a design, run `/deliberation:consensus` on the question.
Gemini, Grok and any configured OpenRouter models review the same plan, and the final report
lists every dismissed issue and why.
