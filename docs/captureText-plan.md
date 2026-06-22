# Plan: opt-in prompt/response body capture (`sessions.captureText`)

Status: **planned, not implemented.** This is Part C, deferred out of the
consensus-step persistence work (PR #152, `feat/persist-consensus-step`).

Depends on PR #152 landing first: it adds the consensus-step session record this
feature would enrich, and establishes the `persistConsensusStep` / `persistRun`
shape this builds on.

## Problem

The session store (`core/sessions.js`, opt-in `sessions.persist`) records the
`question`, per-opinion `verdict` + `criticalIssues` **summaries**, and the loop
outcome - but NOT the full prompt/response BODY text exchanged with each
provider. Operators reviewing a past run (or debugging a bad verdict) sometimes
want the actual text a model saw and returned, not just the parsed summary.

The naive fix - log prompts/responses to `debug.jsonl` - is **rejected**. That
store is metrics-only by hard invariant (`ALLOWED_KEYS` whitelist in
`core/debug-log.js`); it is designed to be safe-to-share telemetry, and adding
content reclassifies it as a transcript store. Best-effort PII stripping is not a
strong enough gate to put in front of a file treated as harmless.

## Decision

Capture body text in the **session store only**, behind a new explicit opt-in,
never in `debug.jsonl`.

- New config key `sessions.captureText: boolean`, **default `false`**.
- When `true` AND `sessions.persist` is `true`, the session record additionally
  stores the per-opinion prompt + response body (and the host blind/peer prompt
  bodies for consensus runs).
- `debug.jsonl` is untouched - it stays metrics-only forever.

## Hard requirements (security)

These are non-negotiable and were locked in during the Part C deferral review:

1. **Secret-scrub stays MANDATORY and is the PRIMARY control.** `writeSession`
   already runs `scrubSecrets` on `question`/opinion text on every write; captured
   body text MUST go through the same scrub. The scrub is never gated by
   `captureText` - turning capture on does not turn scrubbing off.
2. **PII-strip is best-effort defense-in-depth ONLY**, never the gate. Document
   it as "not a guarantee." It runs AFTER secret-scrub, as a second pass, and its
   failure to catch something is expected, not a bug to rely against.
3. **`session-revisit` re-capture multiplies exposure.** A revisit re-runs the
   original question and writes a CHILD record; with `captureText` on, that child
   ALSO captures bodies, so retained body text grows per revisit. Document and
   bound this (respect the existing count + age retention; consider a separate,
   tighter cap for captured-text records).
4. **Captured text is plaintext JSON on local disk.** Document that threat model
   explicitly in the config schema and the user-facing docs - this is local
   capture, not encrypted-at-rest.

## Implementation sketch (for the eventual PR)

- `config/config.schema.json`: add `sessions.captureText` (boolean, default
  false) with a description that states the plaintext-on-disk threat model.
- `core/sessions.js`: extend the record shape with optional
  `opinions[].promptText` / `opinions[].responseText` (and consensus
  `blindPromptText` / `peerPromptText`), each `capText(scrubSecrets(...))` +
  best-effort PII strip. Bump `SCHEMA_VERSION` only if the field addition is not
  backward-compatible for readers (new optional fields read fine on old readers,
  so likely no bump).
- `server/mcp/index.js`: in `persistRun` (the single shared writer), thread the
  body text into the record ONLY when `captureText` is on. All four callers
  (`ask-all`, consensus tool, consensus-step via `persistConsensusStep`,
  session-revisit) inherit it for free since they share `persistRun`.
- The body text must travel via the `parts`/record path, NEVER via the debug
  logger. Add a test asserting `captureText:true` writes body text to the session
  record AND that `debug.jsonl` still receives zero body text (the A5 leak guard
  from PR #152 must continue to hold).

## Tests (merge gates)

- `captureText:false` (default): no body text in the record (current behavior).
- `captureText:true` + `persist:true`: body text present, secret-scrubbed.
- `captureText:true` but `persist:false`: nothing written (persist gates first).
- A leak test: with `captureText:true`, drive a run and assert no prompt/response
  body appears in `debug.jsonl`.
- `session-revisit` with `captureText:true`: child record captures, retention
  bound respected.

## Out of scope for this plan

- Encryption-at-rest for the session store (separate concern).
- Any change to `debug.jsonl` (stays metrics-only).
