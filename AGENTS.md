# AGENTS.md

Host-neutral guidance for any AI coding agent connected to the deliberation MCP
server. This file is standalone on purpose - it is not an include of CLAUDE.md,
so it stays portable across hosts (Cursor, Codex, Kiro, Windsurf, Zed, and
others). Claude Code users get the same routing from CLAUDE.md and the README;
this file is for everyone else.

## What deliberation is

A single MCP server that exposes GPT (via the Codex CLI), Gemini 3 (via the
Antigravity CLI), Grok (via the xAI API), and OpenRouter models (400+, advisory)
as expert subagents. You stay the primary agent. When a task benefits from a
second opinion or cross-model review, call one of the tools below, read the
result, and apply your own judgment. GPT and Gemini can also implement changes;
Grok and OpenRouter only advise.

## Tools

Fan-out and single-provider:

- `ask-all` - send one question to GPT, Gemini, Grok, and configured OpenRouter
  models in parallel, get every answer back independently (no cross-talk).
- `consensus` - fan out, then run one arbiter pass that cross-reviews the
  independent answers and returns a single synthesized verdict. An optional
  server-side blind pre-vote (`consensus.blindVote` in config) returns a
  `blindVerdict` alongside the `verdict`.
- `consensus-auto` - run the FULL multi-round convergence loop server-side with a
  provider arbiter (blind pass + peer fan-out -> adjudicate -> revise, up to
  `consensus.maxRounds`, default 5) and get the converged verdict in one call. Use
  this when you want the whole loop without driving it step by step. Set a concrete
  `consensus.arbiter` (a provider or `openrouter:<alias>`); `host` mode is for the
  client-driven path below.
- `consensus-step` - drive the loop yourself as the arbiter, one action per call:
  `init` (returns a `sessionId` + blind prompt) -> `record_blind` (your pre-commit
  verdict) -> `dispatch_peers` (the server fans out to the panel) ->
  `submit_adjudication` (your verdict + per-issue accept/dismiss/defer, each dismiss
  needs a reason) -> `submit_revision` (your revised plan), looping until converged
  or the round cap. State is held server-side by `sessionId` (ephemeral).
- `ask-gpt` / `ask-gemini` / `ask-grok` / `ask-openrouter` - one question to one
  provider for a single-shot second opinion.

Expert personas (pass as the tool, or via the `expert` argument on the fan-out
tools to apply one persona to every delegate):

- `architect` - system design, tradeoffs, complex decisions.
- `plan-reviewer` - check a plan is executable before work starts.
- `scope-analyst` - catch ambiguities and hidden requirements before planning.
- `code-reviewer` - bugs, security holes, maintainability on a diff or file.
- `security-analyst` - threat modeling and vulnerability assessment.
- `researcher` - external libraries, APIs, and best practices, with evidence.
- `debugger` - ranked root-cause hypotheses and the smallest safe fix.

Session tools (only useful when `sessions.persist` is enabled in config; they report
"persistence disabled" otherwise). When on, `consensus`/`ask-all`/`consensus-auto` return a `sessionId`:

- `session-get { sessionId }` - fetch a recorded run (opinions, verdict, annotations).
- `session-revisit { sessionId }` - re-run the recorded question with the current
  providers/config and save a linked child record. A `consensus-auto` record re-runs the
  full loop, not a one-shot pass.
- `session-annotate { sessionId, note }` - append a note to a run's audit trail.

Every fan-out, single-provider, and expert tool takes a `prompt`. Give it full context: the goal, the relevant code
or paths, and any prior attempts. The experts do not share your session, so a
self-contained prompt gets a better answer.

## When to delegate

- Reviewing a plan or an architecture decision before you commit to it.
- A security review of auth, untrusted input, or a new endpoint.
- A second opinion when you are unsure, or after a fix has failed twice.
- Cross-model consensus on a high-stakes or contested call.

Skip delegation for simple edits, the first attempt at a fix, and trivial
questions you can answer directly.
