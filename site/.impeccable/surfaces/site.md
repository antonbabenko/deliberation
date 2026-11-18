---
version: 1
slug: "site"
primary_target: "site/src/pages/index.astro"
related_targets: []
---

# Website surface brief

Status: shape brief, not confirmed by the owner. No visual direction is chosen and no
direction contract is recorded; that happens in the direction step. Product truth lives in
`site/PRODUCT.md` and is not repeated here. Lines marked (assumption) are inferred answers.

## 1. Job and audience

Who arrives: a developer who ships agent-written plans and diffs, coming from the README, a
plugin listing, a post or an AI answer, with a terminal open beside the browser. They are
skeptical of multi-model tools and will not read a feature list.

What they need: to see what happens when several models argue a plan before it ships, then
one install command for their host. Readers with a specific question need the answer on one
page with a stable URL.

Visitor mode by page type:

| Page type | Mode | What that means here |
|-----------|------|----------------------|
| Home `/` | Persuade, with one Experience passage (the run replay) | Full commitment. The first viewport is a run in progress, not a header over a feature grid |
| Consensus explainer `/consensus/` | Experience, then Read | The loop is shown working (blind verdict, holdout, convergence rule), then documented |
| Quickstart, install per host | Read | One command, copy button, next step. No decoration between the reader and the command |
| Experts, providers, config, tools, commands, dashboard, sessions, troubleshooting, reference | Read | Rendered from repository files. Tables, code, anchors, "last updated" from git |
| Compare pages | Read | Dated tables; says where the other tool fits better |
| Privacy | Read | Per-provider data flow as a table; the "no telemetry" sentence first |
| FAQ, about, changelog, 404 | Read | Plain |

Where the extraordinary part lives: the home page from the first viewport through the replay,
and the top of `/consensus/`. Where restraint rules: every other page. A Read page inherits
the world through type, color and small marks only. It carries no scroll choreography and no
replay; its craft is in tables, code blocks, wayfinding and search.

## 2. Outcome and proof

Primary action: copy the install command for the visitor's host. Secondary: open
`/consensus/` or `/quickstart/`.

The first screen must leave four things with a first-time visitor:

1. What it is: an MCP server and plugin that gets a coding agent a review from other model
   vendors.
2. What it is like: a real run, with models disagreeing.
3. Why it beats self-review: the agent records a blind verdict first and cannot approve its
   own round.
4. What to do next: one install line, with a host switcher.

Not on the first screen: the expert list, a host logo wall, config keys, star counts.

Proof is the recorded run and the engine's own rule, listed under "Evidence on Hand" in
PRODUCT.md. The product-specific truth no neighbor can copy: the host's verdict is sealed
before the panel answers, one holdout keeps a run open, and a dismissal without a reason is
refused by the engine.

## 3. Signature moments

Five moments carry the home page, in scroll order. Each uses recorded data or engine code.

1. Round 1, everyone says no. The first viewport shows the four round-1 verdict lines as live
   text (REQUEST CHANGES with 7, 4, 3 and 2 critical issues) and the start of the adjudication
   table. The tagline and the install line sit with it. Source: `assets/round1.png`,
   transcribed.
2. The sealed verdict. The host's blind verdict is shown closed while the panel lanes fill in,
   then opened beside them. This is the "blind first" rule made visible. The visitor drives
   it. Source: engine order `init`, `record_blind`, `dispatch_peers`.
3. The holdout. The round history grid: one row per round, one column per voice. One reviewer
   stays on REQUEST CHANGES for rounds 2 to 4 while the others approve, and the run does not
   close until round 5. Beside it, one issue row opens into accept, dismiss or defer, with the
   real deferred issue and its reason, and the engine's refusal string for a dismissal with no
   reason. Source: `assets/round5.png`, `assets/round1.png`, `core/consensus-loop.js`.
4. Try to break consensus. A small control panel with the inputs of the convergence rule:
   reviewers that answered, all approve, any reject, accepted issues left open, host approves.
   A verdict indicator shows converged or not. "Host approves, nobody else answered" never
   converges. The widget calls the real `checkConvergence`, not a copy of the rule.
5. First verdict in seconds. The recorded `init` transcript with the measured time (18.4 s on
   a fresh machine, 9.9 s on repeat, measured 2026-11-18 on v4.5.0), followed by the host
   switcher and the install command.

Supporting, placed after the five or on `/consensus/` and `/dashboard/`:

- The limits paragraph in plain words, on the home page, before the final install block.
- A run that ended `unresolved`, with the unmet condition and the dissent listed. Only when a
  real recorded run exists.
- The dashboard timeline of a run, on `/dashboard/` and as one frame on the home page.
- The logo story in one sentence, once.

The memory test: an hour later the visitor should describe "four models rejected the plan,
one kept saying no for three more rounds, and the tool would not let the agent wave it
through."

## 4. Scope and boundaries

In scope: the whole public site. Home and the consensus explainer are designed surfaces. All
other pages share one reading template with a small set of variants (table-heavy reference,
install page, long reference section, changelog).

Fidelity for the next step: three previewable directions for the home page first viewport
plus the replay passage, each with one Read page (an install page) in the same world, so the
choice covers both modes.

Untouched: the tagline, the logo files, product terminology, the repository documents that
pages render, the dashboard and its design system.

Anti-goals:

- A hero with a headline, two buttons and a screenshot in a browser frame.
- A feature card grid, an expert persona grid, a host logo wall, a stats strip.
- A chat-transcript rendering of a run. A run has parallel voices and rounds.
- Green-only storytelling. A page where every run converges is a false picture.
- Any wording that reads as a safety guarantee, a CI gate, or "agreement means correct".
- Autoplay loops, typing-effect terminals that replay forever, glowing gradients as proof.
- Screenshots of text where the text itself can be set.
- Invented numbers, runs, quotes or cost figures.

What would make a polished result feel wrong: if it looked like every developer-tool landing
page on a dark ground with one bright accent, or if the dissent were smaller and quieter than
the approval.

## 5. States and ranges

Run data the replay must hold:

- Voices: minimum 2 (host plus one reviewer), typical 4, maximum about 8. Six panel voices
  exist in the dashboard capture.
- Rounds: 1 to 5 by default. The recorded run has 5.
- Verdicts: APPROVE, REQUEST CHANGES, REJECT, plus a voice that errored or timed out and is
  excluded from the count.
- Issues per round: 0 to about 12. Issue text runs from 4 words to 3 lines. The sources cell
  holds 1 to 4 voices.
- Decisions: accept, dismiss, defer; the last two always carry a reason.
- End states: converged, unresolved at the round cap.

Site states:

- Replay: before interaction (already readable, never empty), stepping, end of run, reduced
  motion (the full run laid out statically), no JavaScript (the same static layout).
- Convergence widget: every combination of its inputs, including zero responders.
- Install switcher: 8 hosts; the command length runs from one short line to three lines plus
  a file-copy step. Copy feedback. A host deep link selects its tab.
- Read pages: tables up to 10 columns (config reference), code blocks with long lines, pages
  from 200 words to several thousand, headings four levels deep, anchor links to every
  heading.
- Changelog: 100 or more releases; needs grouping and a jump list.
- Search: empty, no result, many results. (assumption) Client-side search over the built
  pages.
- 404: one line, search, and install links.
- Light and dark: undecided for the designed pages; Read pages must work in both
  (assumption).

## 6. Interaction and layout

Home page sequence: first viewport (moment 1 with tagline and install) / sealed verdict /
holdout and ledger / break consensus / first verdict in seconds and install by host / limits
/ where to go next (consensus, quickstart, compare, privacy) / footer.

- The replay is one continuous object the visitor moves through, not a slide carousel. Its
  rounds stay in view as they accumulate, so round 5 is read against rounds 1 to 4.
- Each voice keeps one identity (color, position, label) across every moment and every page.
  Verdict status is carried by word and shape as well as color.
- Motion belongs to the replay and the sealed verdict only, tied to scroll position or to
  explicit steps, with keyboard control and visible focus. Nothing else on the site animates
  beyond state feedback.
- The install command is reachable within the first viewport and again after the replay; the
  chosen host persists across pages (stored locally, no network).
- Narrow screens: the round grid and the adjudication table must stay tables that read
  correctly at 360 px wide, by reflowing rows, not by shrinking type or scrolling sideways
  without a cue. The replay becomes step-driven.
- Read pages: one text column near 70 characters, a section list for long pages, breadcrumbs,
  "last updated" and version, previous and next. Tables and code may exceed the text column.
- Navigation (assumption): Quickstart, Install, Consensus, Docs, Compare, Privacy, plus the
  GitHub link. Privacy is a top-level item because reviewers look for it first.

## 7. Constraints and open decisions

Binding:

- Static output, no server. One third-party request at runtime, Plausible Analytics
  (owner decision); fonts and all other scripts are self-hosted.
- Reference pages render repository files at build; a missing source section fails the build.
- Run data is text in the page. The replay and the widget degrade to static content without
  JavaScript.
- WCAG 2.2 AA; `prefers-reduced-motion` gets a complete static reading. (assumption)
- Performance (assumption): the home page reaches a Lighthouse mobile score of 90 or more
  with the replay included; the replay ships no heavy runtime.
- Copy: ASCII punctuation, plain sentences, the tagline pinned, "Deliberation" capitalized in
  prose.
- Every interior page has a markdown twin and the site ships `llms.txt` for machine readers,
  so page content cannot depend on script to exist.
- Per-page social image built from the mark's three lines and the page title.

A builder must not invent:

- Which recorded run the home page replays. Until a run on the current engine is recorded on
  a public artifact, the replay uses the two existing screenshots, transcribed and labeled
  "recorded with an earlier version", and shows the current convergence rule in site copy.
- The `unresolved` run, the self-review comparison, cost figures, testimonials.
- Light or dark default, webfont choice. (Generator: Astro. Domain: usedeliberation.com. Analytics: Plausible.)

Before the site renders them, these repository texts need a fix (separate change):

- README.md says a round needs at least one external reviewer; the default quorum is 2.
- Both consensus flow diagrams show the removed "Stage 2" step; a new diagram is needed.
- New writing is needed for the home page and the FAQ.

## Risks

- The home page proof depends on run data that does not fully exist yet. The fallback (older
  screenshots, labeled) is honest but weaker.
- "Consensus" reads as "correct". The limits paragraph and the non-converged run are the
  counterweight; if they are cut for polish, the page overclaims.
- The replay can become a toy that hides the install command. The command must stay in the
  first viewport.
- A dense five-column round grid is hard at 360 px. This is the first layout to prove in each
  direction.
- Two modes on one site can split into two looks. Each direction must show a Read page.
- The dashboard already owns an instrument look. Reusing it for a Persuade page risks a
  costume of the tool; ignoring it risks two unrelated identities.
- Motion tied to scroll can fail on trackpads, keyboards and reduced-motion settings. The
  static reading is the baseline, not the fallback.

## Inputs for the direction step

- Mechanism in one sentence: the host seals its verdict, reviewers from other vendors answer
  independently, and the round stays open while any of them still disagrees.
- Scene: a senior developer at a desk, terminal beside the browser, deciding in under a minute
  whether this is worth an install. Lighting and theme are for the direction to decide from
  this scene.
- What the first surface must prove: that disagreement is the product, shown with real data.
- The rut to stay out of: the dark developer-tool landing page with a terminal mockup and one
  bright accent, and its opposite, the cream editorial page with a serif headline. The
  dashboard's logic-analyzer look counts as the audience's own instrument, so at most one
  direction may build on it.
- Fixed inputs every direction keeps: the mark and its five colors, three reviewer inks that
  name voices and never signal status, the tagline, the five signature moments, the anti-goals
  and the binding constraints above.
- Each direction shows: the home first viewport at desktop and at 360 px, the holdout grid,
  and one install page.
- Build path: not recorded. No `buildPath` is set for this project; the direction step states
  the path it takes.

## 6. Round 2 changes (owner feedback, 2026-11-18)

The owner reviewed directions A, B and C and changed the brief in four places. Where this
section and sections 1 to 5 disagree, this section wins.

- Home page order, simple first: (a) tagline and the install switcher in the first viewport,
  (b) "How it works" as a five-step flow a non-expert reads in 15 seconds, (c) the replay of a
  recorded run, (d) the eight expert profiles, (e) providers and hosts, (f) a link to the
  detailed page.
- The expert list is on the home page. This reverses the section 2 line that kept it off the
  first screen and the section 4 anti-goal against an expert grid: the variety of experts must
  be obvious at a glance. It is set as a list ordered by when each expert is used, not as
  icon cards.
- A new Read page, `/features/`, holds every major feature and configuration option:
  commands and tools, consensus settings, providers and models, experts, dashboard, sessions,
  analyze, privacy defaults, config file. Tables, anchors and a sticky in-page nav.
- Headings and body use readable faces only. No stencil, glitch or distressed display type.
- The convergence widget and the five-round holdout (section 3, moments 3 and 4) move off the
  home page. The replay now uses the two runs recorded on 2026-11-18 in `src/data/replay/`,
  which replace the transcribed screenshots.
- The owner asked whether the site should look like the dashboard. Direction D answers yes,
  E and F answer partly; each direction README lists what it took and what it left.

Round 2 directions are in `site/.impeccable/directions/{d,e,f}/`. No direction is chosen, so
no direction contract is recorded yet.

## 7. Direction chosen (owner, 2026-11-18)

Direction D, Capture, is built in `site/src/` and recorded in `site/DESIGN.md`. Owner changes
to the comp: the home capture is interactive with a run selector and an inspector; the per-run
walkthroughs moved to `/sample-runs/`; the providers and hosts section left the home page;
features are a short list on home and a full page at `/features/`; the top bar shows the
GitHub star count from build time; no host is presented as the primary form.
