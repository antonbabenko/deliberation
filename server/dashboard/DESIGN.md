---
name: Deliberation Scope
description: A local logic-analyzer capture of a multi-model run, drawn as bench-instrument print on graticule paper or a graphite screen.
colors:
  paper: "oklch(0.974 0.007 95)"
  paper-2: "oklch(0.948 0.009 95)"
  fg: "oklch(0.25 0.012 95)"
  fg-2: "oklch(0.45 0.014 95)"
  rule: "oklch(0.86 0.013 95)"
  rule-2: "oklch(0.915 0.011 95)"
  rule-strong: "oklch(0.72 0.014 95)"
  dim: "oklch(0.66 0.012 95)"
  ok: "oklch(0.52 0.12 150)"
  ok-text: "oklch(0.44 0.11 150)"
  fault: "oklch(0.55 0.19 28)"
  fault-text: "oklch(0.48 0.18 28)"
  tmo: "oklch(0.62 0.14 72)"
  tmo-text: "oklch(0.47 0.11 65)"
  ink-1: "oklch(0.49 0.15 258)"
  ink-2: "oklch(0.49 0.13 305)"
  ink-3: "oklch(0.49 0.09 200)"
  ink-4: "oklch(0.50 0.15 345)"
  ink-5: "oklch(0.47 0.10 280)"
typography:
  readout:
    fontFamily: "ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, Liberation Mono, DejaVu Sans Mono, monospace"
    fontSize: "15px"
    fontWeight: 500
    lineHeight: 1.2
  heading:
    fontFamily: "ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, Liberation Mono, DejaVu Sans Mono, monospace"
    fontSize: "13px"
    fontWeight: 650
    lineHeight: 1.3
    letterSpacing: "0.1em"
  body:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.45
  data:
    fontFamily: "ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, Liberation Mono, DejaVu Sans Mono, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.4
  label:
    fontFamily: "ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, Liberation Mono, DejaVu Sans Mono, monospace"
    fontSize: "11px"
    fontWeight: 500
    lineHeight: 1
    letterSpacing: "0.07em"
rounded:
  sm: "2px"
  md: "3px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "20px"
  xl: "32px"
components:
  mode-key:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.fg}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    height: "28px"
    padding: "0 11px"
  mode-key-current:
    backgroundColor: "{colors.fg}"
    textColor: "{colors.paper}"
  status-mark:
    textColor: "{colors.ok-text}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "1px 6px"
  decode-box:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ok-text}"
    typography: "{typography.label}"
    padding: "1px 7px"
  seq-key:
    textColor: "{colors.fg}"
    typography: "{typography.data}"
    padding: "3px 0"
  index-row:
    textColor: "{colors.fg}"
    typography: "{typography.data}"
    padding: "7px 8px"
  index-row-hover:
    backgroundColor: "{colors.paper-2}"
  kind-tag:
    textColor: "{colors.fg-2}"
    rounded: "{rounded.sm}"
    padding: "0 5px"
  input-field:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.fg}"
    typography: "{typography.data}"
    rounded: "{rounded.md}"
    height: "30px"
    padding: "0 8px"
  inspector:
    backgroundColor: "{colors.paper-2}"
    textColor: "{colors.fg}"
    width: "460px"
---

# Design System: Deliberation Scope

## Overview

**Creative North Star: "The Bench Capture"**

A run is a capture on a logic analyzer. Every model is a channel on one shared time axis, every state change is a signal edge, and verdicts are decoded underneath. The surface is bench-instrument print: off-white graticule paper in light, a graphite screen in dark, with the same fine 10-division rules in both. Nothing glows. A trace is a flat 1.5px stroke in its channel's ink, and segment length is real milliseconds.

The look is dense and quiet. Numerals are tabular monospace, legends are small tracked capitals, and the only ornaments are the ones an instrument would carry: triangle triggers on the ruler, boxed decode labels, hatching for a fault, a dashed line for a ceiling. The user reads the state of a run from shape and position first and color second.

The build rejects the generic admin console: no card grid, no gradient KPI tiles, no icon sidebar, no chat-transcript layout.

**Key Characteristics:**
- Two themes from one set of tokens: graticule paper (light) and graphite (dark), following the system with a manual override.
- Flat everywhere. Depth is tonal (paper over instrument panel) and drawn with 1px rules.
- One ink per provider channel, stable per provider name, from a five-ink set.
- Status is carried by mark shape and label text as well as color: hatched-and-crossed fault, dashed timeout, grey DROPPED.
- Tabular monospace for every number; sans only for running prose.
- Radius is 2px to 3px. Nothing is pill-shaped.

**Lettering decision.** The system monospace stack is the lettering for the whole instrument and was accepted as such by the user. It is recorded here as a decision, not a defect; no webfont is loaded (the server serves under `default-src 'self'` with no CDN).

## Colors

A warm-neutral paper and rule set, one flat semantic trio, and five channel inks. All values are OKLCH and the frontmatter carries the light theme; dark values are listed below and in the sidecar.

### Primary
- **Bench Ink** (oklch(0.25 0.012 95); dark oklch(0.925 0.008 95)): the foreground. Text, the running-state mark, the current mode key fill, the selected round tab fill, focus outlines, cursor A. Doubles as the only "primary": there is no brand accent.

### Secondary (status)
- **Settled Green** (oklch(0.52 0.12 150); dark oklch(0.76 0.14 150)): succeeded, converged, done; APPROVE decode stroke.
- **Fault Red** (oklch(0.55 0.19 28); dark oklch(0.7 0.17 28)): failed and error; hatched fault segments, the X, REJECT and error decode boxes.
- **Ceiling Amber** (oklch(0.62 0.14 72); dark oklch(0.8 0.13 80)): timeout and unresolved; the dashed ceiling line, REQ_CHANGES decode boxes.
- Each status has a paired `-text` value (ok-text, fault-text, tmo-text) darker in light and lighter in dark, used for any label so text stays legible on paper. Marks use the base value.

### Tertiary (channel inks)
- **Channel Blue** ink-1 (oklch(0.49 0.15 258)): GPT / Codex channel.
- **Channel Violet** ink-2 (oklch(0.49 0.13 305)): Gemini channel.
- **Channel Teal** ink-3 (oklch(0.49 0.09 200)): Grok channel.
- **Channel Magenta** ink-4 (oklch(0.50 0.15 345)) and **Channel Indigo** ink-5 (oklch(0.47 0.10 280)): any other provider, chosen by a stable hash of its name. ink-4 is also cursor B.
- The arbiter and host lane uses Bench Ink; a dropped channel uses Dropped Grey with a dashed trace.

### Neutral
- **Graticule Paper** paper (oklch(0.974 0.007 95); dark oklch(0.205 0.006 250)): page and scope face.
- **Instrument Panel** paper-2 (oklch(0.948 0.009 95); dark oklch(0.235 0.007 250)): top bar, inspector, hover and skeleton fill.
- **Legend Grey** fg-2 (oklch(0.45 0.014 95); dark oklch(0.74 0.01 95)): secondary text, legends, tick labels, unlit marks.
- **Frame Rule** rule-strong (oklch(0.72 0.014 95)): control borders and major ticks. **Fine Rule** rule (oklch(0.86 0.013 95)): panel borders, minor ticks, lane rules. **Hairline** rule-2 (oklch(0.915 0.011 95)): graticule divisions and table row rules.
- **Dropped Grey** dim (oklch(0.66 0.012 95)): pending and abandoned marks, dropped channels. Never used for text.

### Named Rules
**The Ink Is Identity Rule.** A provider's ink names the channel and nothing else. Green, red and amber never appear as channel ink, and a channel ink never signals status.

**The Mark And Text Rule.** A status draws its marks with the base value and writes its labels with the `-text` value. Do not put base-value text on paper.

**The Not By Color Alone Rule.** Every status also has a shape or word: hatched segment with X (fault), dashed line to LIMIT (timeout), DROPPED (dropped), outlined-versus-filled trigger (pending versus reached).

## Typography

**Display Font:** none. The instrument has no display face; the largest lettering is the 15px readout.
**Body Font:** system sans (system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial) for running prose only.
**Label/Mono Font:** system monospace (ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, Liberation Mono, DejaVu Sans Mono) for everything else, including all numerals.

**Character:** Panel lettering. Monospace caps stepped by size and weight, tracked wide for headings and legends, set tabular so digits line up down a column. Sans appears only where a sentence has to be read.

### Hierarchy
- **Readout** (500, 15px, 1.2; 13px on narrow): header-strip values such as elapsed time, run id, tool.
- **Heading** (650, 13px, 1.3, 0.1em, uppercase): panel and section titles (h2). Sub-headings (h3) are 600, 11px, 0.08em, uppercase, Legend Grey.
- **Body** (400, 13px, 1.45, tabular numerals; prose capped near 70-75ch): hints, empty-state copy, issue lists, inspector ledes.
- **Data** (400, 12px, 1.3-1.45): index rows, table cells, payloads (12px/1.55), event table (11.5px).
- **Label** (500, 10-11px, 0.07-0.08em, uppercase): mode keys, column heads, readout legends, status marks, kind tags. 10px is the floor.
- **Scope text** (SVG, 11px monospace, 6.7px advance): channel names 12px/600, meta and ticks 11px, cursor tags 10px/700.

### Named Rules
**The Tabular Everything Rule.** Every number, duration and id is monospace with tabular figures and right-aligned in columns. Prose is the only place sans is allowed.

**The One Face Rule.** Do not add a webfont or a display face. Hierarchy comes from size, weight, tracking and case within the two system stacks.

## Layout

A single full-width column under a sticky 46px top bar. The main area pads 18px 20px, then the scope fills the width; an inspector drawer docks right at 460px (up to min(760px, 52vw) when widened) and is collapsed until a segment, trigger or event row is selected. Vertical rhythm steps 4, 8, 12, 20, 32px; captures stack with 30px between; panels with 32px.

The scope is a fixed instrument geometry, not a fluid grid: a channel-label gutter of 212px (118px under 640px width), lanes 64px tall (28px trace, 18px decode row, four 13px gutter rows), 12px inner left pad, and a time axis of 10 graticule divisions whose horizontal length is proportional to milliseconds within the selected round window. The index page is a 10-column grid whose duration bar is proportional to run length.

Under 760px the top bar wraps, the brand hides, the inspector becomes a 72vh bottom sheet, index rows collapse to status, tool, time and a duration bar, and key-value tables stack.

## Elevation & Depth

Flat by default. Depth is tonal and ruled: Graticule Paper for the scope face, Instrument Panel for the bar and inspector, a 1px Fine Rule between them. Selection is drawn as a dashed 1px outline on the hit area, and hover is a 5% Bench Ink wash. There are no shadows at rest and none on state.

### Named Rules
**The Flat Trace Rule.** Traces are flat 1.5px strokes. No glow, no gradient, no soft shadow, no blur. State change is drawn with a mark (triangle, hatch, X, dash), never a halo.

## Shapes

Small and squared: 2px on tags, marks and panels, 3px on keys and fields. Triggers are small filled triangles on the ruler (pending ones are outlined, with a notch); decode labels are 1px boxes; a fault is a 45-degree hatch ending in an X; a timeout is a dashed segment running into a dashed ceiling line. The graticule uses 10 divisions with heavier edge lines. Status squares on the link indicator are 7px.

## Components

Instrument controls: small, outlined, uppercase, and flat.

### Buttons
- **Shape:** 28px tall, 3px radius, 1px Frame Rule border (`.mode-key`, `.key`).
- **Default:** Graticule Paper fill, Bench Ink text, 11px/500 monospace caps, 0.07em tracking, 11px side padding.
- **Hover / Active:** border darkens to Bench Ink on hover; active presses to Hairline fill. Transitions are 150ms ease-out. Disabled is 50% opacity.
- **Current mode:** fill and border Bench Ink, text Graticule Paper (`aria-current="page"`).

### Status marks and chips
- **Status mark:** outlined 1px in the status ink, 2px radius, label in the status text ink, 10.5px/600 caps. Larger (12px) in the header strip.
- **Kind tag:** 1px outlined caps tag in the event table, Legend Grey; run and state kinds use Bench Ink.
- **Decode box:** 1px stroke in the verdict ink over a 9-12% tint of that ink on paper; error decodes use a dashed stroke; neutral decodes use Legend Grey on Instrument Panel.
- **Flag:** dashed 1px outlined caps note beside a value (9.5px); not to be extended to new uses.

### Inputs / Fields
- **Style:** 30px tall, 3px radius, 1px Frame Rule border, Graticule Paper fill, 12px monospace.
- **Focus:** 2px Bench Ink outline at 2px offset. Hover darkens the border to Legend Grey.

### Navigation
- **Top bar:** 46px sticky, Instrument Panel, 1px Fine Rule below; brand in 13px/700 caps at 0.16em, mode keys, then a status line (capture badge, link state square, theme key) pushed right.
- **Sequence keys:** trigger row of text buttons with a 10x8 triangle marker; the pressed key carries a 2px underline in Bench Ink.
- **Round tabs:** on the memory-position bar, outlined rectangles; the selected round is filled Bench Ink.

### Capture scope (signature)
An SVG face with graticule, a time ruler carrying labelled trigger triangles, one lane per channel (name, model, effort in the gutter; flat trace; decode row beneath), cursors A (dashed Bench Ink) and B (dashed ink-4) with a delta readout, a NOW line, and a small filled square growing at the right edge of a running trace. Clicking a segment opens the inspector.

### Capture index
Rows on a hairline grid: status mark, tool, workflow, run id, provider, time, counts, and a duration bar 8px tall on a Hairline track whose fill length is proportional to duration and inks by status.

### Inspector
Instrument Panel drawer with a sticky bar, a 2-column facts grid (10px caps legends over 13px monospace values), and payload blocks (Graticule Paper, 1px Fine Rule, 12px/1.55 monospace, wrapped). Diff lines tint 12-14% green or red.

## Do's and Don'ts

### Do:
- **Do** draw a run as channels on a shared time axis, with segment length equal to real milliseconds.
- **Do** ink each channel by provider and keep green, red and amber for status only.
- **Do** write status labels in the `-text` values and draw marks in the base values.
- **Do** pair every status color with a shape or a word.
- **Do** set every number in tabular monospace, right-aligned in columns.
- **Do** keep 1px rules, 2px to 3px radii, and 1.5px traces.
- **Do** keep the elapsed clock and the live edge as the only continuous motion; keep transitions at 150ms ease-out and off under reduced motion.
- **Do** keep a visible 2px Bench Ink focus outline on every control and SVG hit target.

### Don't:
- **Don't** use card grids, gradient tiles, icon sidebars or chat-transcript layouts.
- **Don't** add glow, gradients, blur or neon edges to a trace.
- **Don't** hide a provider failure behind a click; a fault, timeout or DROPPED reads on the scope.
- **Don't** add a webfont, a display face or a CDN asset.
- **Don't** use Dropped Grey for text.
- **Don't** shrink legends below 10px.

Not canonized (carried by the build, not part of the system): the soft drop shadow on the narrow-screen inspector sheet; the 9.5px flag note and 10px legends, which sit at the legibility floor; and any use of tracked-caps legends as small headings above headings (they belong over values and column heads only).
