# Design system: Capture

The public website is printed by the same instrument as the dashboard. This file records the
system as built in `site/src/`. The dashboard's own system is `server/dashboard/DESIGN.md`;
where the two differ, the difference is listed under "What the site changes".

## Idea

A consensus run is a capture on a logic analyzer: one lane per voice on a shared time axis, a
pulse while a voice is answering, and the decoded verdict in a box under it. The home page
shows one recorded run this way and lets the visitor open any answer. Every other part of the
site reuses instrument parts: outlined keys, ruled tables, tracked-caps legends, trigger
triangles.

## Tokens

All colours are OKLCH and live in `src/styles/site.css` under `:root`. Light is graticule
paper, dark is graphite. The theme follows the system setting; there is no toggle.

| Token | Light | Dark | Used for |
|-------|-------|------|----------|
| `--bg` | `oklch(0.974 0.007 95)` | `oklch(0.205 0.006 250)` | page, capture face, code blocks |
| `--bg2` | `oklch(0.948 0.009 95)` | `oklch(0.235 0.007 250)` | top bar, readout strip, inspector, experts band, footer |
| `--fg` | `oklch(0.25 0.012 95)` | `oklch(0.925 0.008 95)` | text, selected key fill, focus ring, host lane |
| `--fg2` | `oklch(0.45 0.014 95)` | `oklch(0.74 0.01 95)` | legends, secondary text |
| `--rule`, `--rule2`, `--rule-s` | 0.86, 0.915, 0.72 lightness | 0.36, 0.29, 0.5 | panel edges, row rules, key outlines |
| `--ok` / `--ok-t` | `oklch(0.52 0.12 150)` | `oklch(0.76 0.14 150)` | APPROVE, converged |
| `--tmo` / `--tmo-t` | `oklch(0.62 0.14 72)` | `oklch(0.8 0.13 80)` | REQUEST CHANGES, unresolved |
| `--fault` / `--fault-t` | `oklch(0.55 0.19 28)` | `oklch(0.7 0.17 28)` | REJECT |
| `--k1` to `--k5` | blue, violet, teal, magenta, indigo | lighter values | one ink per voice |

The `-t` value of a status colour is for lettering; the base value is for strokes and fills.
The mark keeps its own five colours in both themes.

## Voices and status

- Channel inks name voices and never signal status. Blue is GPT, violet is Gemini, teal is
  Grok, magenta and indigo are any other provider. Inside one run a taken ink moves to the
  next free one, so two voices do not share a colour (`voices()` in `src/lib/run-model.ts`).
  The host agent is drawn in the foreground ink.
- Status is a word plus a stroke, then a colour: solid box for APPROVE, dashed box for
  REQUEST CHANGES, hatched or heavy box for REJECT. Rulings are `accept` (solid) and
  `dismiss` or `defer` (dashed, grey).
- A recovered run can lack a verdict. A blind verdict or a reviewer verdict that was not
  kept is the words NOT RECORDED in an empty dotted grey box; a reviewer's pulse is still
  drawn, because its call time is known. It is not a vote and not a failed call, and
  tallies count it apart from both ("1 of 1 approved, 4 not recorded"). Rulings that were
  not kept are said in words, with the host's verdict and accepted count when those survive.

## Type

System stacks only; no font file is loaded.

- Monospace (`ui-monospace` and fallbacks): legends, keys, numbers, model names, commands,
  section heads in tracked capitals (15 px, 0.1em), table column heads (10.5 px, 0.08em).
- Sans (`system-ui`): sentences. Body 16 px / 1.55. Headline `clamp(28px, 3.3vw, 46px)`,
  weight 600, tracking -0.022em. Ledes `clamp(18px, 1.5vw, 21px)`.
- Tabular numerals everywhere.
- The experts section is the one place a section head is set in the sans at headline size.
  It is the section the owner asked to carry weight.

## Shape and depth

Flat. Radius is 2 px on panels and 3 px on keys. Depth is tonal (paper over panel) and drawn
with 1 px rules. The only shadow is under the inspector when it is a bottom sheet on a
narrow screen. Selection is a dashed 1 px outline; keyboard focus is a solid 2 px outline in
the foreground ink.

## Components

- Key: the outlined 28 px control (nav links, host tabs, run selector, Copy, Close, pager).
  Hover darkens the outline; the selected key is filled with the foreground ink.
- Top bar: mark, name, the released version (from the repository's `version.json`, linking
  to the changelog), keys, and the Search key. "Sample runs" and "Compare" are disclosure menus: a key with a
  caret opens a list of links, Escape closes it, the arrow keys walk it, and without script
  the key is a plain link to the index page. On a phone the list spans the bar. The GitHub
  key carries the star count, fetched once at build time and left out when that fails.
- Search: a key at the end of the top bar opens a dialog; so do `/` and Ctrl+K or Cmd+K.
  The dialog is a native `<dialog>`: focus stays inside, Escape closes it and focus returns
  to what opened it. A field, a status line, up to eight pages with their matching
  sections, and a legend of the keys. Up and Down walk the results, Enter opens the first.
  The index is Pagefind's, written to `dist/pagefind/` by `npm run build` and served by the
  site itself. Only `main` is indexed; breadcrumbs, section lists, pagers, the home
  capture, the 404 page and the `/runs/<id>/` fragments are left out. Without script the
  key is hidden.
- Install switcher: radio tabs, one panel per host. Works without script; script remembers
  the choice and honours `#host-<id>`. On the home page the panels share one grid cell, so
  the block keeps the height of its tallest panel and nothing below it moves.
- Capture: readout strip, scope, inspector, footer line. The scope is HTML positioned in
  container units, so lettering keeps its size at any width. Round windows share half the
  track equally and half by recorded wall time; a peer's pulse length is its share of the
  round's wall time; host marks are fixed-width.
- Run selector: one key per recorded run, labelled by subject kind and expert, with the
  outcome as one boxed word (solid for converged, dashed for unresolved).
- "Show prompt" key: at the end of the readout strip. It opens the run's question and the full
  init prompt sent to the panel in the inspector, verbatim.
- Inspector: the dashboard drawer docked under the capture. A bar with the voice, verdict
  and round; a two-column facts grid; the issue list with the host's ruling; the verbatim
  text in a scrolling payload block. Escape or Close returns focus to the element that
  opened it.
- Narrow screens (under 1000 px): the scope is replaced by a list per round with the same
  buttons, and the inspector becomes a bottom sheet of at most 72 percent of the height.
- Trigger sequence ("How it works"): five steps under a rule, each with a green trigger
  triangle, a T-number, and the engine action as code.
- Tables: ruled rows, caps column heads, cells that stack with their column name under
  760 px.
- Talks: one row per talk from `src/data/talks.ts`: the cover slide, the facts the slides
  print, and a key to the slides.
- Open Graph image: `og/og.html` rendered to `public/og.png` (1200 x 630) by
  `node scripts/og.mjs`. The tagline, a three-lane capture and the eight experts by name. The PNG is committed; render it again after editing the HTML.
- Read pages: a section list on the left (a scrolling strip on a phone), breadcrumbs, and a
  source line. Rendered Markdown is styled by `src/styles/content.css`:
  - Text, lists, tables, code and images all run the width of the article (at most 942 px),
    so a diagram and the paragraph under it share both edges. From 980 px the text is
    17 px / 1.7 to carry the longer line; below that it is 16 px / 1.62.
  - A section (H2, or H3 on a page sliced from a longer file) opens on a rule with the green
    trigger triangle. Sub-heads are sans 18.5 px, then mono caps. Every heading with an id
    ends in a `#` link to itself.
  - "On this page" lists the top two heading levels when a page has four or more. From
    980 px it sits in the sticky left column under the section list; the column scrolls
    on its own when it is taller than the window. Below 980 px the same list is printed
    above the text as plain links. One script, `src/scripts/scrollspy.js`, underlines the
    section being read (`aria-current="location"`) here and on the features page, with no
    change of width, and keeps that entry in view in the column.
  - Code blocks: Shiki with Astro's `css-variables` theme, so one HTML output follows both
    themes. Strings are the `--ok-t` green, numbers `--tmo-t` amber, keywords `--k2`,
    commands and functions `--k1`, comments and punctuation `--fg2`. A bar above the code
    holds the language legend and the Copy key (hidden without script; the legend then spans
    the bar, so the block keeps its size).
  - Tables: framed, caps column heads on the panel tone, zebra rows, first column in medium
    weight. From 980 px the head sticks under the top bar; below that the frame scrolls
    sideways and keeps a minimum width per column.
  - Quotes are dashed panels. GitHub alerts (`> [!NOTE]`) get a caps label; Important and
    Warning use the amber dashed stroke, Caution the red one.
  - External links (http or https to another origin) carry `rel="external"`, a small
    north-east arrow drawn with a CSS mask, and the hidden text "(external)". They open in
    the same tab. Links that only wrap an image are left alone.

## Motion

One authored moment: when the capture appears, the lanes are revealed left to right once
(1.5 s, exponential ease-out, `clip-path`). After it, a ring leaves the first answer box
twice and stops; it also stops when any answer is opened. A box rises 2 px under the pointer
or the focus ring. The legend says the same in words ("Click any box or mark"), so the cue
does not depend on motion. The inspector and the menus rise 4 px in 0.2 s or less. Keys change
outline colour in 0.15 s. Nothing loops. With reduced motion, or with no script, the capture
is complete and still.

## Without script

The first run is drawn in full. The run selector and Copy keys are hidden and the capture's
buttons are disabled, so nothing looks clickable that is not. The sample-runs page holds the
same text for every run with no script at all.

## What the site changes from the dashboard

- Body text is 16 px in the sans, and the headline is 46 px. The dashboard stops at 15 px.
- No cursors, drag, filters or event table. The inspector shows less: verdict, model, time,
  issues with rulings, verbatim text.
- The inspector docks under the capture on wide screens; the dashboard's docks right.
- The theme has no manual override.

## Data

Everything about a run comes from `src/data/replay/*.json` through `src/lib/run-model.ts`.
Expert names and role lines come from `prompts/*.md`, example requests from the README
table, config defaults from `config/config.default.json`. Site-authored sentences are in
`src/data/site-copy.ts` and `src/data/features.ts`.
