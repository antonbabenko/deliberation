# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Plain ES modules, CSS and inline SVG served by a zero-dependency `node:http` server. No build step, no runtime dependency, no CDN; works offline under `Content-Security-Policy: default-src 'self'`.

## Users

A developer who uses the deliberation plugin from Claude Code on their own laptop. They keep the dashboard open in a browser tab on a side monitor while a `/consensus` or `/ask-all` runs, glance at it to see which model is still thinking, which one failed, and whether the round is converging, and drill in when something stalls, dissents, or takes minutes. Later they open past runs to understand why a consensus did not converge or which model is slow.

## Product Purpose

Deliberation asks several AI models (GPT, Gemini, Grok, OpenRouter models) for independent opinions and, for `/consensus`, loops blind verdict, peer review, adjudication and revision until the models agree. The dashboard makes that process visible as it happens: every state, every request and response, timings, tokens, verdicts, and failures. It is strictly read-only. Success: the user can tell at a glance what a run is doing and why, without reading logs.

## Positioning

A live state-machine view of multi-model deliberation: parallel model branches, an arbiter loop, rounds, and verdicts, drawn the way a workflow engine console draws executions, for a local single-user tool. It shows provider health, login needs, circuit-broken peers and timeouts directly on the graph.

## Constraints

- Local only: binds 127.0.0.1, token-gated, read-only (GET/HEAD).
- PII hidden by default through server-side redaction; no reveal control in the UI.
- Content (prompts, responses) is present only when the user opted into `capture: "content"`; metadata-only runs must still read well.
- localStorage holds view preferences and a metadata-only run index; never run content.
- Follows the system light/dark preference with a manual override.

## Anti-goals

- Generic SaaS admin look (card grid, gradient KPI tiles, icon sidebar).
- Chat-transcript presentation; runs are state machines with parallel branches.
- Noisy live motion; the only continuous motion is an elapsed timer.
- Provider failures hidden behind clicks.
