# Product

<!-- impeccable:product-schema 1 -->

This record covers the public website in `site/`. It is scoped to the site the same way
`server/dashboard/PRODUCT.md` is scoped to the dashboard; there is no repo-root PRODUCT.md.
The owner was not interviewed for this record. Facts come from the repository. Every line
marked (assumption) is an inferred answer the owner can overrule.

## Platform

web

## Stack

Undecided. (assumption) A static site built from the repository's own markdown and assets,
with no server and one third-party runtime request: Plausible Analytics (owner decision). (assumption) `site/` is its own package,
outside the root package, so `npm run check` and the Node 18 runtime rule for `core/` and
`server/` stay untouched. The generator and the hosting target are owner decisions.

## Users

Primary: a developer who lets a coding agent write plans and diffs and then ships them. They
work in Claude Code most of the day. They arrive from the GitHub README, a plugin listing, a
post, or an AI answer, usually with a terminal open next to the browser. Their job: "before I
merge this agent-written plan or diff, get someone else to try to break it." Their doubts: more
latency and tokens for confident noise, one more tool to set up, and "three models nodding is
not a review."

Other readers (assumption: this ranking):

- Users of other hosts (Codex CLI, Cursor, Kiro, Gemini CLI, Antigravity, OpenCode, any MCP
  host). Job: get the same review loop in their host. Doubt: that a native plugin is a thin
  wrapper, or that the loop needs Claude Code.
- People comparing tools. Job: decide which tool to use, or whether to run two. They want a
  page that says where the other tool fits better.
- Privacy and security reviewers, and local-model users. Job: know what leaves the machine
  and to whom before an MCP server may touch a repo.
- AI answer engines and coding agents that read docs. They need short definitional sentences,
  tables, dated facts and one stable URL per question.

## Product Purpose

Deliberation is an open-source (MIT) MCP server and agent plugin for Claude Code, Codex,
Cursor, Kiro, Gemini CLI, Antigravity and OpenCode. It sends the same plan
or diff to models from other vendors and returns one verdict, with the disagreement kept in
the report. The site exists so a visitor understands what that is like before installing: a
plan gets argued by several models, the host agent commits its own verdict before it sees the
others, and a reviewer that still disagrees stays on the page.

Success for the site (assumption): a first-time visitor can say what Deliberation is, why it
beats an agent reviewing its own work, and copies an install command for their host. Readers
with a question (install, config, privacy, a comparison) find the answer on one page.

Tagline, used verbatim on every surface and never replaced by a second one:

> A second opinion from other models before you ship. Any host, any vendor, one verdict, and
> the disagreement stays visible.

## Positioning

Three rules of the `/consensus` loop that a single-vendor review cannot offer, all enforced in
`core/consensus-loop.js`:

- Blind verdict first. The host agent records its own verdict before the panel is revealed.
- No self-approval. A round converges only when enough reviewers answered (default quorum 2),
  every reviewer that answered approves, none rejects, no accepted issue is left open, and the
  host approves. The host's own vote cannot close a round.
- No silent dismissal. Every dismissed or deferred issue needs a written reason, and the
  engine refuses the adjudication without one.

Deliberation is not a blocking CI gate, not a correctness certificate, and not a chat
aggregator. Consensus can be wrong: several models can share one blind spot. Deliberation
advises and shows the dissent; the final call stays with a human.

## Operating Context

- Deliberation runs inside a coding agent. The user types a slash command or the agent calls
  an MCP tool; results come back as text in the terminal: verdict lines, an adjudication
  table, a round history grid.
- An opt-in local dashboard on `127.0.0.1` draws each run as a timeline with one lane per
  voice.
- Site pages render the repository's own files (README.md, SETUP.md, TECHNICAL.md, PRIVACY.md,
  `docs/`, `prompts/`, `config/`). The site does not keep copies that can drift.
- Install is one string per host. The first-run path on any host is
  `npx -y @antonbabenko/deliberation-mcp init`.

## Capabilities and Constraints

- Providers: GPT through the Codex CLI, Gemini, Grok, local Ollama and LM Studio models, and
  OpenRouter models. Any subset works. Every provider advises; only Gemini can also implement.
- Hosts: an agent plugin for Claude Code, Codex CLI, Cursor, Kiro, Gemini CLI, Antigravity
  and OpenCode; a standalone stdio MCP server for any other host. No host is the primary
  form.
- Eight expert personas in `prompts/`. `/ask-all` returns independent answers side by side;
  `/consensus` runs the loop above with a round cap (default 5) and reports `unresolved` when
  the cap is reached.
- One OpenRouter key gives three models from three vendors. All three calls go through one
  router, so the site must not claim independent infrastructure.
- The plugin and server send no telemetry, analytics, crash reporting or update check
  (PRIVACY.md). The website is separate: it loads Plausible Analytics (cookieless, owner
  decision 2026-11-18), disclosed in PRIVACY.md "This website". No other third-party script,
  font CDN or tracker.
- Terms the site uses with one meaning each: host, panel, reviewer, blind verdict, arbiter,
  adjudication, quorum, round, converged, unresolved.
- Decided: Astro static output, GitHub Pages at https://usedeliberation.com, Plausible analytics.
- Undecided: which recorded run the home page
  replays, whether expert prompts are published in full, how far back the changelog goes.

## Brand Commitments

- Name: "Deliberation" with a capital D in prose and headings. Identifiers stay lowercase.
- Logo: `assets/logo.svg`, `assets/logo-dark.svg`, `assets/logo-mark.svg`. Three reviewer lines
  curve into a "D". Two meet at a verdict dot; the third ends before it, and that gap is
  the visible dissent. The site tells that story once, in one sentence.
- Mark colors: `#15171a` ground, `#7cb4fc` blue line, `#c39dee` violet line, `#5ecbcb` teal
  line, `#e8e6e0` verdict dot.
- Voice: plain sentences, ASCII punctuation, no marketing filler, no emoji. Limits are stated
  on the home page in plain words, not in a footnote.
- The dashboard has its own recorded visual system (`server/dashboard/DESIGN.md`). It is
  evidence for the site, not a mandate.

## Evidence on Hand

- `assets/round1.png`: a real `/consensus` round 1. All four voices return REQUEST CHANGES
  (7, 4, 3 and 2 critical issues), followed by the adjudication table: issue, sources,
  decision, including one deferred issue with its reason.
- `assets/round5.png`: the same run's round history. One reviewer holds REQUEST CHANGES
  through rounds 2 to 4 while the others approve; the run converges in round 5. The image also
  prints an older convergence sentence ("at least one external responded"). The current
  default quorum is 2, so the grid is usable as data and that sentence is not.
- `assets/dashboard.png`: a converged three-round run drawn by the dashboard, six panel
  voices, 03:31.6, 36k tokens. Its prompt is a liveness check, so it shows the instrument, not
  a story.
- `assets/ask-all.png`: one `/ask-all` prompt that staged a two-round debate. It is the result
  of a prompt, not a built-in mode, and must be captioned that way.
- `assets/agents.png`, `assets/afewmomentslater.png`: illustrations the README uses. Their
  colors are not the mark's colors.
- `core/consensus-loop.js`: `checkConvergence` is a pure function; `submitAdjudication` throws
  `decision at index N (dismiss) requires a non-empty reason`. Both can be shown as they are.
- First-run timing: on a fresh machine (empty profile, one OpenRouter key),
  `npx -y @antonbabenko/deliberation-mcp init --yes` printed a first verdict in 18.4 s; a
  repeat took 9.9 s. Measured 2026-11-18 on v4.5.0.
- `docs/compare/`: four comparison pages with dated facts. `PRIVACY.md`: per-provider data
  flow.

Absent, and not to be invented:

- A recorded run on the current engine with captured text, on a public artifact. The two
  round screenshots come from an earlier engine version and must be labeled so until a new
  run replaces them.
- A recorded run that ended `unresolved`.
- A recorded pair of self-review and panel review on the same diff.
- Cost per run. Tokens and elapsed time exist; cost does not.
- Testimonials, customer names, ratings, usage counts, benchmarks against other tools.
- A correct flow diagram. `assets/consensus-flow.html` and `assets/consensus-flow-simple.html`
  show a "Stage 2" cross-review that the engine no longer runs.

## Product Principles

1. Show a real run, not a description of one. Every number, verdict and error string on the
   site comes from a recorded run or from engine code.
2. Dissent is content. The reviewer that held out, the deferred issue and the run that did not
   converge get the same care as the green result.
3. State the limits where the promise is made. Agreement is not correctness, and the site says
   so next to the claim.
4. One source. Reference pages render repository files; a fact changes in the repo and the
   site follows.
5. The site keeps the product's privacy stance: nothing loaded from a third party.

## Accessibility & Inclusion

(assumption) WCAG 2.2 AA. Status is never carried by color alone; every verdict also has a
word or a shape. Motion is driven by scroll or by the visitor, never an autoplay loop, and
every sequence has a complete static reading under `prefers-reduced-motion`. Run data is real
text in the page, not an image of text. English only at launch (assumption).
