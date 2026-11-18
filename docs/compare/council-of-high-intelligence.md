# Deliberation and Council of High Intelligence

[Council of High Intelligence](https://github.com/0xNyk/council-of-high-intelligence) runs a
structured debate among analytical personas for hard decisions. It installs into Claude Code,
Codex, Gemini CLI and OpenCode, and can spread the personas across several model providers.
Deliberation asks several model families to review a plan, a diff or a piece of writing, and
runs a review loop until the panel and the orchestrating agent all approve or a round cap is
reached. Both get
more than one perspective before you decide. They differ in what they are built to judge.

Facts about the council come from its README and the GitHub API as of 2026-11-17: 4,861 GitHub
stars, MIT, latest release v1.2.0 (published 2026-07-04), last push 2026-11-16.

## How the council works

- One command, `/council`, on every supported host. Claude Code installs it as a plugin; Codex,
  Gemini CLI and OpenCode use `./install.sh` from a clone.
- 18 personas, each a named analytical lens (for example Socrates for assumptions, Taleb for tail
  risk, Torvalds for shipping and maintainability), with paired counterweights.
- Three modes: full (independent analysis, cross-examination, final stance, synthesis), quick,
  and duo (two members argue one tension). Named triads pick three lenses for a domain such as
  `architecture`, `risk` or `shipping`.
- First positions are formed blind. Checks look for early agreement, repeated claims, missing
  dissent and unsupported confidence. If the vote stays split, the verdict returns the split.
- Claims carry evidence labels: `FACT`, `INFERENCE`, `ASSUMPTION`, `UNKNOWN`. A verdict comes with
  kill criteria and one next step, and the README suggests recording a prediction to check later.
- Seats can run on native host subagents or be routed to OpenAI (`codex`), Google (`gemini`),
  Ollama, NVIDIA NIM or Cursor. Polarity pairs (the two sides of a disagreement) go to different
  model families when possible.

## Where the council fits better

- **Decisions, not artifacts.** Pricing, strategy, build-or-buy, whether to ship today. The
  personas, evidence labels, kill criteria and outcome tracking are built for that.
- **No extra provider needed.** Seats fall back to native host subagents, so it works with only
  the host model. Deliberation needs at least one provider besides the host model: a CLI login,
  an API key, or a local Ollama or LM Studio model.
- **Structured debate.** Cross-examination between personas is part of the protocol.
  Deliberation's `ask-all` keeps answers independent and does not run a debate round on its own.
- **Providers Deliberation does not have**: NVIDIA NIM and Cursor's agent CLI.

## Where Deliberation fits better

- **Review of a concrete artifact.** Eight experts aimed at engineering work: Code Reviewer,
  Security Analyst, Debugger, Plan Reviewer, Scope Analyst, Architect, Researcher and Writing
  Editor.
- **A loop that ends in a verdict on the artifact.** `/consensus` repeats review, adjudication
  and revision until every responding model approves (at least two by default), no accepted
  critical issue is left and the orchestrating agent approves, with a round cap. The orchestrating agent
  records its verdict before it sees the panel and cannot pass a round on its own vote; every
  dismissed issue has a written reason.
- **Any MCP host.** Deliberation is an MCP server (`npx -y @antonbabenko/deliberation-mcp`), so it
  also runs in hosts the council does not install into, such as Claude Desktop, Cursor, Kiro,
  Windsurf, Zed and VS Code.
- **More providers through one config.** Grok (with an xAI key), plus OpenRouter, Ollama
  and LM Studio models declared as records in `~/.config/deliberation/config.json`. Changes to the
  records reload without a restart.
- **Measurement.** An opt-in debug log, saved runs, the `analyze` tool and a local dashboard show
  latency, tokens and how often each model agrees with the rest.

## Side by side

| | Council of High Intelligence | Deliberation |
|-|------------------------------|--------------|
| License | MIT | MIT |
| Shape | Skill and commands per host | MCP server, Claude Code plugin, native host plugins |
| Hosts | Claude Code, Codex, Gemini CLI, OpenCode | Any MCP host; native plugins for Claude Code, Codex, Cursor, Kiro, Antigravity, Gemini CLI, OpenCode |
| Personas | 18 analytical lenses | Eight engineering and writing experts |
| Runs on | Native host subagents, `codex`, `gemini`, Ollama, NVIDIA NIM, Cursor's agent CLI | `codex`, `agy` (Gemini), Grok, OpenRouter, Ollama, LM Studio |
| Independence | Blind first positions, then cross-examination | Independent answers; no debate round |
| Ending | Verdict with dissent, kill criteria, next step; split votes returned as split | Converged verdict or `unresolved` at the round cap; dismissals carry reasons |
| Best for | High-stakes decisions | Plans, diffs, security and prose review |

## Using both

They install separately and use different command names. One way to combine them: run `/council` to decide what to build, then use
Deliberation's `/consensus` on the plan and `ask-all` on the diff once you build it.
