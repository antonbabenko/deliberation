# `sessions.captureText` - opt-in response-body capture

Status: **implemented.** Part C, built on top of the consensus-step persistence
work (PR #152, now on `master`).

## Problem

The session store (`core/sessions.js`, opt-in `sessions.persist`) records the
`question` (the prompt/plan), per-opinion `verdict` + `criticalIssues`
**summaries**, and the loop outcome. Operators reviewing a past run sometimes
want the actual **response** text a model returned, not just the parsed verdict.

The naive fix - log prompts/responses to `debug.jsonl` - is **rejected**. That
store is metrics-only by hard invariant (`ALLOWED_KEYS` whitelist in
`core/debug-log.js`), designed to be safe-to-share telemetry. Adding content -
even PII-stripped - reclassifies it as a transcript store; best-effort PII
stripping is not a strong enough gate to put in front of a file treated as
harmless.

## What was actually there (discovery)

The plan as first sketched assumed body text was not captured at all. It already
was, asymmetrically:

- `opinion.text` (each provider's **raw response body**) was persisted
  **unconditionally** (when `sessions.persist` was on) for `ask-all` and the
  server-side `consensus` tool - scrubbed + capped in `sanitizeRecord`.
- The host-driven `consensus-step` path persisted **no** response body (its loop
  results carry only the parsed verdict, no `text`).
- The **prompt** is already stored as `question` (it must be, for
  `session-revisit` to re-run), and was never the gap.

So the real boundary (locked during the #152 review, "A8") is: the prompt
(`question`) + verdict/issue summaries are existing, always-on persistence; Part
C concerns **per-opinion response BODY text only**.

## What shipped

`sessions.captureText` (boolean, **default `false`**) is the single, uniform gate
for the per-opinion response body, applied at the one write chokepoint
(`persistRun`):

- **Default off:** `opinion.text` is dropped from every persisted record -
  `ask-all`, the `consensus` tool, `consensus-step`, and `session-revisit` alike.
  Only `question`, `verdict`, `criticalIssues`, `synthesis`/`blindVerdict`
  summaries are stored. (This **tightens** the previous `ask-all`/`consensus`
  default, which always stored response bodies - an intentional privacy
  hardening: body capture is now opt-in everywhere.)
- **On (and `persist` on):** `opinion.text` is stored, **secret-scrubbed
  (mandatory)** then **best-effort PII-stripped**, then capped.
- `consensus-step` now retains the raw peer response on its in-memory loop result
  so it can be captured too when the flag is on - body capture is consistent
  across all paths ("all places").
- `debug.jsonl` is untouched - metrics-only, never any body text, regardless of
  this flag.

## Security properties (as built)

1. **Secret-scrub is mandatory and primary.** `sanitizeRecord` runs
   `scrubSecrets` on `opinion.text` on every write; `captureText` never gates it.
   Turning capture on does not turn scrubbing off.
2. **PII-strip is best-effort defense-in-depth, never the gate.** New
   `stripPII` (`core/sessions.js`) runs AFTER `scrubSecrets`, only on captured
   `opinion.text`. Deliberately conservative (low false-positive): redacts email
   addresses and separator-bearing phone numbers only; a bare digit run (id /
   version / count) is left alone. Documented as **not a guarantee**.
3. **`session-revisit` re-capture is bounded.** A revisit writes a CHILD record
   through the same `persistRun` chokepoint, so it inherits the same gate and the
   existing count + age retention; it does not get a separate, looser path.
4. **Plaintext on local disk.** Captured text is plaintext JSON at
   `<cache>/deliberation/sessions/<id>.json` (mode 0600). The config-schema
   description states this threat model explicitly.
5. **DoS-resistant scrubbing.** `stripPII`'s regexes use bounded quantifiers
   (RFC email limits) so they stay LINEAR on long, attacker-influenced provider
   responses - an unbounded `[...]+@` would be O(n^2) (the response reaches
   `stripPII` before `capText` truncates it). Regression test: `PII3`.

## Lifecycle / pre-existing records (forward-gating)

`captureText` gates WRITES going forward. It does NOT retroactively strip records
already on disk:

- Records written while `captureText` was on (or under the prior always-on
  `ask-all`/`consensus` behavior, before this change) still contain
  `opinion.text` and remain readable via `session-get` until the count/age
  retention ages them out.
- Turning `captureText` off stops NEW capture; it is not a purge. An operator who
  needs the existing bodies gone can delete `<cache>/deliberation/sessions/` (or
  wait for retention).
- `session-annotate` re-writes an existing record through the same
  `sanitizeRecord`, preserving (and re-scrubbing) whatever text it already had -
  it never adds new capture.

This is the expected semantics of a forward-gating flag and is called out here so
operators do not assume toggling the flag scrubs history.

## Touch points

- `config/config.schema.json` - `sessions.captureText` (boolean, default false)
  with the threat-model description.
- `server/openrouter/config.js` - `resolveSessions` validates `captureText`
  (boolean, default false; non-boolean -> false + warning).
- `server/mcp/index.js` - `sessionsCfg().captureText`; `persistRun` drops
  `opinion.text` when off (single chokepoint); `dispatch_peers` retains the raw
  response on the loop result (off the wire response).
- `core/sessions.js` - `stripPII` + applied to `opinion.text` in
  `sanitizeRecord`, exported for tests.

## Tests

- `stripPII` unit: email + phone redacted, plain text / ids / versions untouched
  (PII1); a persisted opinion is secret-scrubbed THEN PII-stripped (PII2).
- `captureText` validation: default off, boolean honored, non-boolean -> warning
  (SESS8).
- Gating at the chokepoint: `consensus-step` captures on / omits off (CS14/CS15);
  `ask-all` gated identically by the same flag (CS16).

## Out of scope

- Encryption-at-rest for the session store.
- Any change to `debug.jsonl` (stays metrics-only).
- A separate per-opinion `promptText` field (the prompt is the `question`;
  per-round peer prompts are reconstructable and were not worth a redundant
  field).
