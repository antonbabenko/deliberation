---
name: consensus
description: Arbiter-mediated consensus - GPT + Gemini + Grok (plus any configured OpenRouter delegates) review while Claude commits a blind verdict, adjudicates, and synthesizes. Converges only with cross-model agreement. Driven by the consensus-step engine.
allowed-tools: mcp__deliberation__consensus-step
timeout: 900000
---

# Consensus (arbiter-mediated convergence loop, driven by the core engine)

This command is a THIN DRIVER over the `mcp__deliberation__consensus-step` tool. The
multi-round loop - round counting, the convergence rule, the max-rounds cap, and the
round history - lives in the core state machine (`core/consensus-loop.js`), NOT in this
prompt. The command's job is the three things only the host (Claude) can do as the
arbiter: commit a **blind verdict** before seeing the panel, **adjudicate** which
critical issues are real (with a reason for every dismissal), and **author the revised
plan** between rounds.

This is **arbiter-mediated consensus, not pure democracy**: the external models vote
independently (the server fans out to them in `dispatch_peers`), but Claude commits its
blind verdict first, cannot converge on its own vote alone (the engine requires a
responding peer to APPROVE), and must show a reason for every dismissed issue.

## Input

Plan, design, spec, or proposal to refine: $ARGUMENTS

## When to use

- Refining a plan before execution
- Stress-testing a design decision
- Reaching consensus on a tradeoff
- Any case where you want signed-off agreement, not just parallel opinions

## When NOT to use

- One-off lookup or fact check (use `/ask-gpt` or `/ask-gemini`)
- You only want parallel one-shot opinions without the convergence loop (use `/ask-all`)
- Time-sensitive work - this loop can take several minutes

## How the engine maps to this command

`consensus-step` is one action per call; it holds the `LoopState` server-side by
`sessionId` (ephemeral - lost on server restart / TTL). The status it returns tells you
the next action:

| Action | You supply | Engine returns | Next |
|--------|-----------|----------------|------|
| `init` | `prompt` (the plan), `expert`, `cwd` | `sessionId`, `status: await_blind`, `round`, `blindPrompt` | write blind, `record_blind` |
| `record_blind` | `sessionId`, `blindVerdict` (your verdict text) | `status: await_peers` | `dispatch_peers` |
| `dispatch_peers` | `sessionId` | `status: await_adjudication`, `opinions[]` (per-voice `{source, isError, verdict, criticalIssues}`) | adjudicate, `submit_adjudication` |
| `submit_adjudication` | `sessionId`, `verdict`, `decisions[]` | `converged: true` + `finalReport` + `confidence`, OR `status: await_revision` | done, OR revise |
| `submit_revision` | `sessionId`, `revisedPlan`, `diffSummary` | `status: await_blind` (next round), OR `status: unresolved` + `finalReport` (hit the cap) | next round, OR done |

The engine injects the expert persona server-side from the `expert` key (no prompt-file
read needed), authors the per-round blind/peer prompts, parses each reviewer's verdict +
categorized critical issues, counts rounds, enforces the configurable max-rounds cap
(`consensus.maxRounds`, default 5), evaluates convergence, and computes the confidence
label. Do NOT re-implement any of that here.

## Workflow

### Setup (run once)

1. **Identify the expert key.** Default `plan-reviewer`. Override only if `$ARGUMENTS`
   clearly maps to another role:
   - Architecture / design tradeoffs -> `architect`
   - Security / threat modeling -> `security-analyst`
   - Code review of a concrete diff -> `code-reviewer`

   Pass this key verbatim as `expert`; the server injects the matching persona for the
   PEER dispatch. There is no prompt-file Glob and no inlined fallback - the running MCP
   server is the single source of truth for persona text. An unknown key does NOT error:
   the server silently runs WITHOUT a persona (generic review), so use a key from the list
   above. Also adopt the chosen expert's lens yourself when writing your blind verdict and
   adjudicating (the engine's host prompts are generic; you supply the expert framing).
2. **Set cwd**: use `process.cwd()` as the MCP `cwd` on `init` AND on `dispatch_peers`
   (that is where peers actually run; the server reads `cwd` from the `dispatch_peers`
   call, not from `init`). The other actions do not need it.
3. Print:
   ```
   /consensus: starting consensus loop (engine-driven, expert=[expert])
   ```

### Init

Call `consensus-step` with `action: "init"`:
```
mcp__deliberation__consensus-step({ action: "init", prompt: "$ARGUMENTS", expert: "[expert]", cwd: "[cwd]" })
```
It returns `sessionId`, `status: "await_blind"`, `round: 1`, and `blindPrompt`. Carry the
`sessionId` through every later call. If it returns an `error` (e.g. `session-expired` on
a later call), report it and stop - the in-memory state was lost; re-run from `init`.

### Round loop (driven by the returned status)

Repeat the following until a call returns `converged: true` or `status: "unresolved"`.
The engine owns the round number and the cap; read `round` from each response - never
assume a fixed count. **If any call returns an `error`** (e.g. `session-expired`,
`unexpected-action-for-status`, or a no-reason dismissal), report it and stop - the
in-memory `LoopState` for that `sessionId` may be gone, so recover by re-running from
`init`.

1. **Print the round header** using the returned `round`:
   ```
   --- Round R ---
   ```

2. **Commit the blind verdict BEFORE revealing the panel.** In a message of its OWN,
   BEFORE the message that calls `record_blind`, Claude writes its own verdict from the
   returned `blindPrompt` only (it has not seen any reviewer output). Use the strict
   shape so it is comparable to the panel:
   ```
   **Verdict**: APPROVE | REQUEST CHANGES | REJECT
   **Critical issues** (must-fix; empty = none):
     - `[category]` issue
   **One-line bottom line**: [single sentence]
   ```
   `[category]` is one of: `security`, `correctness`, `scope`, `ambiguity`,
   `performance`, `ops`. Print:
   ```
   Claude blind (R{R}): APPROVE | REQUEST CHANGES | REJECT (N critical)
   ```
   Emitting it in an earlier message than `record_blind` makes the pre-commitment visible
   in the transcript. Do NOT edit it after seeing the panel; it appears verbatim in the
   final report.

3. **Record it** - in the NEXT message:
   ```
   mcp__deliberation__consensus-step({ action: "record_blind", sessionId: "[sid]", blindVerdict: "[your full blind verdict text]" })
   ```

4. **Dispatch the panel** (pass `cwd` here - this is where the peers run). FIRST, on the line
   before the call, print a short expectation note so the wait never looks like a hang (the
   call returns only after ALL voices finish; no partial output mid-call):
   ```
   Round R of [maxRounds]: dispatching the panel in parallel... ETA ~30-90s (longer if Gemini runs deep).
   ```
   Then call:
   ```
   mcp__deliberation__consensus-step({ action: "dispatch_peers", sessionId: "[sid]", cwd: "[cwd]" })
   ```
   The server selects the voting panel (enabled built-ins + eligible OpenRouter delegates,
   from the live hot-reloaded config) and fans out in parallel, then parses each reply.
   It returns `opinions[]`: one
   `{ source, isError, errorKind?, verdict, criticalIssues, model, reasoningEffort, ms }`
   per voice. `source` is `codex`, `gemini`, `grok`, or `openrouter:<alias>`.
   - On **round 1 only**, print the panel block (one line per voice from `opinions[]`),
     showing the real reasoning effort - `reasoningEffort` for the HTTP voices (Grok,
     OpenRouter), or `n/a (CLI)` when it is `null` (Codex, Gemini have no such knob):
     ```
     Consensus panel (round 1, typical 30-60s/round):
       - codex                          (built-in)    reasoning: n/a (CLI)
       - gemini                         (built-in)    reasoning: n/a (CLI)
       - grok                           (built-in)    reasoning: high
       - openrouter:<alias>             (delegate)    reasoning: high
     ```
     If `opinions[]` has > 3 voices, also print:
     `Warning: N voting voices x up to maxRounds rounds = significant token cost AND a stricter convergence bar (every responding voice must APPROVE).`
   - Print a status line per voice (`isError: true` -> ERRORED, excluded from the bar):
     ```
     codex (R{R}): APPROVE
     gemini (R{R}): REQUEST CHANGES (3 critical)
     grok (R{R}): ERRORED (missing-auth)
     ```
   - After the per-voice lines, print a one-line round time footer from the voices' `ms`
     (the fan-out is parallel, so the round wall time ~ the slowest voice):
     ```
     Round time: 52s (slowest: gemini 52s)
     ```

   **Repo-wide context (file-blind voices):** Grok and OpenRouter delegates see only what
   the plan text names - they do not walk the filesystem. For a plan that asks reviewers
   to verify against the repo (cross-file invariants, "audit this codebase",
   architectural claims), embed the orientation context in the INITIAL plan text (the
   `init` `prompt`): name 2-6 high-signal files (project `CLAUDE.md` / `AGENTS.md`,
   entrypoints, the modules the plan touches) and summarize their load-bearing parts, so
   the comparison is fair. Refresh it in a `submit_revision` `revisedPlan` only if the
   plan's touch-set changes. Purely conceptual loops need no such context.

   **Server auto-attach (if configured):** when `orientation.enabled` is `true` in
   `config.json`, the server auto-attaches the orientation bundle to file-blind voices
   that carry no files of their own on `dispatch_peers` AND on the arbiter blind pass.
   Adjudication and revision passes are NOT oriented (they reason over opinion text).
   When `orientation.enabled` is `false` (the default), the manual embedding above is
   the only way to give file-blind voices repo context.

5. **Adjudicate (the arbiter role).** Build the issue pool from every RESPONDING voice's
   `criticalIssues` PLUS any critical issue from your own blind verdict. For EACH issue
   record a decision WITH a one-line reason:
   - `accept` - real problem; it will be fixed in the revision.
   - `dismiss` - false positive or already handled; reason REQUIRED (this includes walking
     back one of your OWN blind issues - that is a dismiss and needs a reason too).
   - `defer` - real but out of scope for now; reason REQUIRED.

   **No silent dismissal**: the engine THROWS if any `dismiss`/`defer` decision lacks a
   `reason`, surfacing as a structured error - so always include one.
   **Repeated-issue default**: if two or more sources raise substantially the same issue,
   `accept` it unless you have a concrete factual reason to dismiss ("out of scope" alone
   is not enough).

   Your adjudicated `verdict` is `APPROVE` only if zero accepted critical issues remain.
   Submit it:
   ```
   mcp__deliberation__consensus-step({
     action: "submit_adjudication",
     sessionId: "[sid]",
     verdict: "APPROVE" | "REQUEST_CHANGES" | "REJECT",
     decisions: [ { source, category, description, action: "accept"|"dismiss"|"defer", reason } ]
   })
   ```
   - If the response has `converged: true`, the loop is done - go to Final output (use the
     returned `finalReport` + `confidence`). The engine converges only when at least one
     responding peer APPROVED, none REJECTED, zero accepted critical issues remain, and
     your adjudicated verdict is APPROVE - so your APPROVE alone never converges.
   - Otherwise `status` is `await_revision` - continue.

6. **Revise the plan.** Address every `accept`-ed issue; be explicit about what changed
   and what you deliberately did not change. Submit:
   ```
   mcp__deliberation__consensus-step({ action: "submit_revision", sessionId: "[sid]", revisedPlan: "[full revised plan]", diffSummary: "[one line of what changed]" })
   ```
   - If the response has `status: "unresolved"`, the engine hit the max-rounds cap - the
     loop is done (UNRESOLVED). Go to Final output with the returned `finalReport`.
   - Otherwise `status` is `await_blind` for the next round - loop back to step 1 with the
     new `round`. Print revised plans only when they change materially.

### Final output

Synthesize from the engine's terminal response (`finalReport`, `confidence`, the round
count) plus the adjudication decisions you recorded across the loop. Never paste raw
reviewer text.

```
## /consensus result

**Mode**: arbiter-mediated consensus (external voices vote; Claude adjudicates + synthesizes; engine-driven loop)
**Outcome**: CONVERGED in N rounds (confidence: high|medium|low) | UNRESOLVED after N rounds (confidence: none)
**Time**: ~Ns total across N rounds (sum of each round's slowest-voice `ms`; provider time only, excludes your adjudication/revision turns)
**Final plan**:
[the engine's finalReport plan, or last revision]

**Round history** (CB = Claude blind; voice cols use APPR/RC/REJ or ERR; Adj = Claude adjudicated):
| Round | CB   | codex | gemini | grok | <delegates> | Adj  | Changes applied |
| 1     | RC   | RC    | RC     | RC   | RC          | RC   | added rollback step, clarified ownership |
| 2     | APPR | APPR  | APPR   | ERR  | APPR        | APPR | - (converged on responding voices) |

**Dismissed / deferred issues** (every dismiss/defer, with reason - no silent dismissal; includes Claude walking back its own blind issues):
- [R{n}] {source} raised "{issue}" -> dismissed: {one-line reason}
- [R{n}] {source} raised "{issue}" -> deferred (out of scope): {one-line reason}

**Residual disagreements** (if any, on an UNRESOLVED outcome):
- {source} (held out on the final round): {issue + why it stayed open}
```

## Stability rules

- **The engine owns the loop** - round counting, the convergence rule, the max-rounds cap
  (`consensus.maxRounds`, default 5, configurable), the bounded round history, and the
  confidence label all live in `core/consensus-loop.js`. This command never re-implements
  them; it reads `round`/`status`/`converged`/`finalReport` from each response.
- **One action per call, state by `sessionId`** - carry the `sessionId` from `init`
  through every later call. The store is in-memory and ephemeral: a `session-expired`
  error means restart from `init`.
- **Blind pre-commitment is visible** - emit the blind verdict in a message BEFORE the
  `record_blind` call. The engine gates the panel reveal on `record_blind`, so peers
  cannot be dispatched until the blind verdict is in.
- **Claude cannot self-approve into consensus** - the engine requires a responding peer to
  APPROVE (and none to REJECT, and zero accepted critical issues) on top of your APPROVE.
- **No silent dismissal** - every `dismiss`/`defer` decision carries a `reason` or the
  engine rejects the adjudication. Repeated cross-source issues are accepted by default.
- **Persona is server-side** - pass the `expert` KEY; the server injects the persona.
  There is no prompt-file Glob and no inlined fallback in this command.
- **`cwd`** - pass `process.cwd()` on `init` AND on `dispatch_peers`; the server reads it
  from the `dispatch_peers` call (where the peers run) to resolve each provider's working
  directory. init's `cwd` is not carried forward to the fan-out.
- **Synthesize, never paste raw** - reviewer output never appears verbatim in the report.
- **Report as you go** - print the round header, the blind line, the panel block (round 1),
  and a per-voice status line each round. Long silences look like a hang.

## Heuristics for Claude's per-issue decisions

- **accept**: a real gap or risk the plan does not cover. Fix it in the revision.
- **dismiss**: already addressed, genuinely out of scope, or theoretical (e.g. "what if
  the disk fails mid-write" on a non-critical caching plan). Reason REQUIRED; it appears
  in the final report.
- **defer**: right, but for a future phase. Put it in the revised plan's `Out of scope`
  section so the next round does not re-flag it.

## Note: Stage 2 blind cross-review

Earlier revisions of this command ran a "Stage 2" anonymized peer cross-review as a
host-side step. It is intentionally NOT part of this engine-driven driver: the core loop
(`consensus-step`) has no Stage 2 model, and keeping it here would re-introduce the prose
reimplementation this rewrite removes. If anonymized cross-review proves valuable, it
should return as an engine feature (a `consensus-step` action), not as command prose.
