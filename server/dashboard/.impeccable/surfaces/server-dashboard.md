---
version: 1
slug: "server-dashboard"
primary_target: "server/dashboard"
related_targets: []
---

# Dashboard surface brief

Scope: the whole local dashboard (Live, Runs, Run detail, Config, Stats). Visitor mode: Operate.
Audience and job: see PRODUCT.md. Primary scene: browser tab on a side monitor next to Claude Code, daytime office light or evening; follows system light/dark.
Seed: 5d768fe0 (kind: pick, logic analyzer). Build path: code-led (no image generation).

## Direction contract

THESIS: A run is a capture. Every model is a channel on one shared time axis, every state change is a signal edge, verdicts are decoded underneath. Refuses boxes-and-arrows workflow graphs and KPI card grids.

OWN-WORLD: Bench-instrument print. Light: off-white graticule paper with fine 10-division rules. Dark: graphite screen, same rules. Each channel is a flat 1.5px trace in its own ink; no glow, no gradients, no neon edges. Trigger markers are small filled triangles on the time ruler. The decode row uses boxed labels (APPROVE, REQ_CHANGES, REJECT). A fault is a hatched segment ending in an X; a timeout runs into a dashed ceiling line; a dropped channel greys out and its label reads DROPPED. All numerals are tabular monospace, and segment length equals real milliseconds.

STORY: At a glance the user sees which channel is high (running), which fell (settled), which faulted, and whether the decodes agree. Clicking a segment opens its request and response in the inspector. Round triggers switch the round.

FIRST VIEWPORT: Top bar: mode keys Live, Runs, Config, Stats, plus a PII/capture badge. Header strip: tool, workflow, run id, elapsed, status. Main area: the waveform capture fills the width. Channel labels (provider, model, effort) sit in the left gutter. The time ruler at the top carries one labelled trigger per state. Decode rows sit under the channels, and a protocol-style event table sits below. The inspector drawer on the right is collapsed. With no live run the capture reads ARMED - WAITING FOR TRIGGER over the last run.

SIGNATURE: A live trace grows at the right edge (the only continuous motion). Dragging places cursors A and B with a delta readout.

RAISES: Tabular numeric density throughout (from datamatics). The runs list is a capture index whose bar length is proportional to duration (from the tab-rail manual).
