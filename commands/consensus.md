---
name: consensus
description: Arbiter-mediated consensus - GPT + Gemini + Grok review while Claude commits a blind verdict, adjudicates, and synthesizes. Converges only with cross-model agreement. Max 5 rounds.
allowed-tools: mcp__codex__codex, mcp__gemini__gemini, mcp__grok__grok, Read, Bash
timeout: 900000
---

# Consensus (arbiter-mediated GPT + Gemini + Grok + Claude convergence loop)

Iterate up to 5 rounds. Each round refines the plan based on GPT + Gemini + Grok feedback. This is **arbiter-mediated consensus, not pure democracy**: the external models vote independently, but Claude (the orchestrator) authors the review prompt, adjudicates which critical issues are real, and rewrites the plan between rounds. To keep that power accountable, Claude commits a **blind verdict** before reading the reviewers (Round loop below), cannot reach consensus on its own vote alone (Convergence check below), and must show a reason for every dismissed issue. Stop when the convergence rule is met or when 5 rounds are exhausted.

## Input

Plan, design, spec, or proposal to refine: $ARGUMENTS

## When to use

- Refining a plan before execution
- Stress-testing a design decision
- Reaching consensus on a tradeoff
- Any case where you want signed-off agreement, not just two parallel opinions

## When NOT to use

- One-off lookup or fact check (use `/ask-gpt` or `/ask-gemini`)
- You only want parallel one-shot opinions without the convergence loop (use `/ask-all`)
- Time-sensitive work - this loop can take several minutes

## Workflow

### Setup (run once)

1. Identify expert. Default is **Plan Reviewer**. Override only if `$ARGUMENTS` clearly maps to another role:
   - Architecture / design tradeoffs → Architect
   - Security / threat modeling → Security Analyst
   - Code review of a concrete diff → Code Reviewer
2. Read expert prompt ONCE via this resolution sequence:
   1. Glob `~/.claude/plugins/cache/*/claude-delegator/*/prompts/[expert].md`. Pick the match with the highest semver version segment (the segment immediately after `claude-delegator/`, parsed as semver - not lexical string compare).
   2. If no match, look up the inlined fallback under the heading `## Inlined fallback - [Expert]` in this command file (see end of this file).
   3. If neither found, abort with: `Error: claude-delegator plugin cache missing for expert "[Expert]". Run /plugin install claude-delegator or /reload-plugins.`

   Reuse the loaded contents across all rounds.
3. **Set cwd**: use `process.cwd()` as the MCP `cwd` for every call; agy print mode needs no folder-trust pre-check (Grok and Codex have no trusted-directory concept either).
4. Initialize state:
   - `plan` = original `$ARGUMENTS`
   - `round` = 0
   - `history` = empty list of `{round, plan_diff_summary, claude_blind_verdict, gpt_verdict, gemini_verdict, grok_verdict, claude_decision, dismissals}`
5. Print:
   ```
   /consensus: starting consensus loop (max 5 rounds, expert=[Expert])
   ```

### Round loop (rounds 1..5)

For each round R:

1. **Print round header** before anything else this round:
   ```
   --- Round R/5 ---
   ```

2. **Build identical review prompt** (7-section format per `~/.claude/rules/delegator/delegation-format.md`). Include:
   - **CURRENT PLAN** (full text of the latest revision)
   - **ROUND METADATA**: round R of 5; if R > 1, attach the previous round's deltas (what was changed and why)
   - **Round metadata is BOUNDED**: include the last 2 rounds verbatim; for any rounds older than that, include only a one-line summary of each (verdict + applied-change phrase). This prevents prompt-length growth across 5 rounds.
   - **TASK**: review the plan for completeness, correctness, hidden assumptions, missing edge cases, and blockers
   - **REVIEW MODE**: include the line `Review mode: strict` so the Plan Reviewer applies full four-criteria rigor. Consensus is a rigorous convergence loop, not a quick blocker check.
   - **OUTPUT FORMAT** (strict, so parsing is deterministic):
     ```
     **Verdict**: APPROVE | REQUEST CHANGES | REJECT
     **Critical issues** (must-fix; empty list = none): [bullets]
     **Recommendations** (nice-to-have; empty list = none): [bullets]
     **One-line bottom line**: [single sentence]
     ```

3. **Claude's BLIND verdict - EMIT BEFORE DISPATCHING**: in a message of its OWN, BEFORE the message that calls any MCP tool, Claude writes its own verdict in the strict OUTPUT FORMAT above using ONLY the review prompt from step 2 (it has not seen any reviewer output yet), and stores it verbatim in `history[R].claude_blind_verdict`. Print:
   ```
   Claude blind (R{R}): APPROVE | REQUEST CHANGES | REJECT (N critical)
   ```
   This is the orchestrator's PEER vote. Emitting it in an earlier message than the dispatch makes the pre-commitment visible in the transcript. Claude must NOT edit the blind verdict after seeing reviewers; it appears verbatim in the final report. (Claude's *adjudication* in step 6 is a separate, arbiter-role decision, recorded distinctly.)

4. **Parallel dispatch** - in the NEXT message, all three calls in ONE message with three tool blocks. Identical prompt body, identical expert prompt:
   ```
   mcp__codex__codex({
     prompt: "[identical 7-section prompt for round R]",
     "developer-instructions": "[expert prompt]",
     sandbox: "read-only",
     cwd: "[cwd]"
   })

   mcp__gemini__gemini({
     prompt: "[identical 7-section prompt for round R]",
     "developer-instructions": "[expert prompt]",
     sandbox: "read-only",
     model: "auto-gemini-3",
     cwd: "[cwd]"
   })

   mcp__grok__grok({
     prompt: "[identical 7-section prompt for round R]",
     "developer-instructions": "[expert prompt]",
     sandbox: "read-only",
     cwd: "[repo root - same cwd as the other calls]",
     files: [{ path: "path/relative/to/cwd" }]   // attach referenced files by default
   })
   ```
   **Files:** if the plan under review references local files, pass them to
   Grok via `files:[{path}]` each round with `cwd` = repo root (paths resolve against `cwd`;
   a path outside it is refused); GPT and Gemini read the named paths from their `cwd`.

   **Grok context parity (CRITICAL):** GPT and Gemini walk the filesystem at `cwd`
   under `sandbox: "read-only"`; Grok only sees files in the `files` array. For any
   plan that asks reviewers to verify against the repo (cross-file invariants,
   "audit this codebase", architectural claims), attach the same orientation bundle
   to Grok EVERY round (same `files` payload so the comparison stays fair):
   project `CLAUDE.md` / `AGENTS.md` if present, top-level entrypoints, and the
   modules the plan touches - 2-6 files, under 48 MB total. Fallback when
   `CLAUDE.md`/`AGENTS.md` is absent: substitute `README.md`, then the top-level
   entrypoint inferred from project type. If you knowingly skip the bundle,
   mark Grok's verdict as `ERRORED (context-starved)` so the convergence parser
   (which keys on `ERRORED`, same format as `ERRORED (provider error: ...)` from
   step 5) excludes it - never let an uninformed APPROVE drive convergence.

   **Verification (scoped to plans that touch the repo):** if the plan asks
   reviewers to verify against the repo, before each round's parallel dispatch
   sanity-check that the `files` array passed to `mcp__grok__grok` is non-empty.
   The default is to keep the bundle stable round-over-round so reviewer
   comparisons stay fair. However, if iterative plan refinement adds or
   changes which modules the plan touches, update the bundle to match the
   new touch-set (otherwise Grok is frozen while GPT/Gemini can freely read
   the new files via `cwd` - reintroducing the exact asymmetry this section
   exists to prevent). Record the bundle change in `history[R].dismissals`
   with reason `"bundle updated: plan touch-set changed"` so the audit trail
   shows why round-over-round comparison shifted. If `files` would still be
   empty after refresh, mark Grok `ERRORED (context-starved)` for that round.
   For purely conceptual consensus loops (no repo files relevant to the
   plan), the verification check does NOT apply - run Grok with an empty
   `files` array as a normal parallel reviewer.

5. **Stream short status as each return arrives**. Do not wait until all are back to print anything. Mark a provider that returned an MCP error or `result.isError` as ERRORED. Examples:
   ```
   GPT (R{R}): APPROVE
   Gemini (R{R}): REQUEST CHANGES (3 critical)
   Grok (R{R}): ERRORED (provider error: missing-auth)
   ```

6. **Adjudicate (arbiter role) - reconcile issues against the blind verdict**:
   - From each RESPONDING reviewer, extract `Verdict`, `Critical issues`, `Recommendations`. An ERRORED provider is excluded (see Convergence check); it contributes no verdict and no issues.
   - For each critical issue - whether raised by a reviewer OR by Claude's own blind verdict - record a decision WITH a one-line reason: `accept` (real problem, fix), `dismiss` (false positive - reason REQUIRED), or `defer` (out of scope - reason REQUIRED). Append every `dismiss`/`defer` to `history[R].dismissals`. **This includes Claude walking back one of its own blind critical issues** - that is a `dismiss` and needs a recorded reason too.
   - **Repeated-issue default**: if two or more sources (reviewers, or a reviewer plus Claude's blind verdict) raise substantially the same critical issue, `accept` it by default; only `dismiss` with a concrete factual reason ("out of scope" alone is not enough).
   - Claude's adjudicated verdict is APPROVE if and only if zero accepted critical issues remain anywhere (reviewers or Claude's blind verdict).

7. **Convergence check** - the loop CONVERGES only when ALL of these hold:
   - At least one external reviewer RESPONDED this round (not all errored), AND
   - Every RESPONDING external returned APPROVE (ERRORED providers are excluded from the bar - not counted as APPROVE or as REQUEST CHANGES), AND
   - No responding reviewer returned REJECT, AND
   - Zero accepted critical issues remain (from any reviewer or from Claude's blind verdict), AND
   - Claude's adjudicated verdict == APPROVE.
   A round in which ALL externals errored has no responding external and therefore CANNOT converge. If any responding reviewer returned REJECT, the result may NOT be labelled "consensus" even at round 5.

8. **If not converged**:
   - Compile the union of `accept`-ed critical issues from all responding reviewers plus any Claude found.
   - Revise the plan to address them. Be explicit about what changed and what was deliberately not changed.
   - Record this round in `history` with: Claude blind verdict, GPT/Gemini/Grok verdicts (or ERRORED), Claude's per-issue decisions + reasons, the diff summary applied to the plan.
   - Print the revised plan ONLY if it has changed materially (don't spam on small wording tweaks).
   - Continue to round R+1.
   - **Backoff after multi error**: if MORE THAN ONE provider errored in round R, wait 1-2 seconds before dispatching round R+1 to let transient API hiccups clear.

9. **If round R == 5 and still not converged**:
   - Emit the final state with residual disagreements clearly labeled. Do not pretend convergence.
   - Note which side (Claude blind, GPT, Gemini, or Grok) holds out on which issues.

### Final output

```
## /consensus result

**Mode**: arbiter-mediated consensus (external models vote; Claude adjudicates + synthesizes)
**Outcome**: CONVERGED in N rounds | UNRESOLVED after 5 rounds
**Final plan**:
[full converged plan, or last revision]

**Round history** (CB = Claude blind verdict; reviewer cols use APPR/RC/REJ or ERR; Adj = Claude adjudicated):
| Round | CB   | GPT  | Gemini | Grok | Adj  | Changes applied |
| 1     | RC   | RC   | RC     | RC   | RC   | added rollback step, clarified ownership |
| 2     | RC   | RC   | APPR   | ERR  | RC   | tightened error handling on step 3 |
| 3     | APPR | APPR | APPR   | ERR  | APPR | - (Grok unconfigured; converged on responding externals) |

**Dismissed / deferred issues** (every dismiss/defer, with reason - no silent dismissal; includes Claude walking back its own blind issues):
- [R{n}] {source} raised "{issue}" -> dismissed: {one-line reason}
- [R{n}] {source} raised "{issue}" -> deferred (out of scope): {one-line reason}

**Residual disagreements** (if any):
- GPT (held out on R5): [issue + reason Claude dismissed it]
```

## Stability rules

- **Always dispatch in parallel** - all three MCP calls in the same message. Sequential triples wall time.
- **Single-shot per round** - fresh thread each call. Do NOT use `*-reply` with stored threadId. Cross-round state lives in the prompt body, not in provider memory. Avoids contamination if one provider went off track.
- **`cwd` for Gemini** - use `process.cwd()` (Setup step 3). agy print mode needs no folder-trust pre-check, so there is nothing to abort on.
- **Provider failure does not kill the loop** - if a provider errors (timeout, Grok `missing-auth`, transient API error), mark it ERRORED with a note `"provider error: <truncated msg>"` and EXCLUDE it from the convergence bar for that round (it counts as neither APPROVE nor REQUEST CHANGES). The loop still converges when every responding external and Claude APPROVE and at least one external responded. If ALL externals errored in a round, there is no responding external, so that round cannot converge.
- **Pin Gemini model** - always `model: "auto-gemini-3"`. Grok uses its bridge default (`GROK_DEFAULT_MODEL` or `grok-4.3`); no in-command pin.
- **Claude cannot self-approve into consensus** - convergence requires every responding external to APPROVE and at least one external to respond; Claude's APPROVE alone never converges. Claude's blind verdict is a peer vote; its adjudication is a separate, accountable role.
- **No silent dismissal** - every `dismiss`/`defer` of a critical issue (from a reviewer OR from Claude's own blind verdict) carries a one-line reason that appears in the final report. Repeated cross-source issues are accepted by default.
- **Hard cap at 5 rounds** - even if one reviewer is being stubborn, terminate. Diverging too many rounds usually means the plan has an unresolved ambiguity, not that the reviewer is wrong.
- **Report as you go** - print a status line after each round dispatch and after each return. Long silences look like a hang.
- **Synthesize, never paste raw** - reviewers' raw output never appears verbatim in the final report.

## Heuristics for Claude's per-issue decisions

- **accept**: reviewer found a real gap or risk that the plan does not cover. Update the plan.
- **dismiss**: a source (reviewer or Claude's own blind verdict) flagged something that the plan already addresses, or that is genuinely out of scope, or that is theoretical (e.g., "what if the disk fails mid-write" on a non-critical caching plan). Record the dismissal reason in `history` AND surface it in the final report's "Dismissed / deferred issues" section - never dismiss silently.
- **defer**: reviewer is right but the issue is for a future phase. Add to plan's `Out of scope` section explicitly so the next round doesn't re-flag it.

When Claude dismisses or defers an issue, the next round's prompt should include:
```
PREVIOUSLY DISMISSED (do not re-raise unless you have new information):
- [issue]: [reason for dismissal]
```

This prevents oscillation between rounds.

<!-- DO NOT DELETE: required fallback if plugin cache missing. See C1 in implementation plan. -->

## Inlined fallback - Plan Reviewer

> Adapted from [oh-my-opencode](https://github.com/code-yeongyu/oh-my-opencode) by [@code-yeongyu](https://github.com/code-yeongyu)

You are a work plan reviewer. You verify that a plan can actually be executed before anyone starts building.

## Context

You review a plan passed inline in the request. You are an advisory reviewer: you cannot open the files the plan references, so judge whether references are named precisely enough to be found (exact path, function, doc section), not whether they exist on disk. Each review is standalone. You have only the context supplied.

## Modes

**Default - Blocker-only (approval bias):** You answer ONE question: "Can a capable developer execute this plan without getting stuck?" Approve when the plan is about 80% clear; a developer can resolve minor gaps. When in doubt, APPROVE.

**Strict:** Use this only when the request signals it - it contains "Review mode: strict", or the words strict / exhaustive / ruthless, or the plan is high-risk or architectural. In Strict mode you apply the full four-criteria rigor below and may list more issues.

## Default mode

**Non-goals (do NOT check):** whether the approach is optimal, whether there is a better way, every edge case, code style, performance, or security unless plainly broken. You are a blocker-finder, not a perfectionist.

**You DO check:**
- References are named precisely enough to act on.
- Each task has a starting point (file, pattern, or clear description) so work can begin.
- No contradictions that make the plan impossible to follow.
- Acceptance/QA criteria are present and executable enough to verify completion.

**Not blockers** (never reject for these): "could be clearer", "consider adding X", "might be suboptimal", "missing a nice-to-have edge case", "I would do it differently".

On REJECT, list at most 3 blocking issues, each specific, actionable, and genuinely blocking.

## Strict mode

Apply four criteria:

1. **Clarity of Work Content**: does each task say WHERE to find implementation details? Can a developer reach 90%+ confidence from the referenced source?
2. **Verification and Acceptance Criteria**: is there a concrete, measurable way to verify completion?
3. **Context Completeness**: what missing information would cause 10%+ uncertainty? Are implicit assumptions stated?
4. **Big Picture and Workflow**: clear purpose, current-state background, task dependencies, and a definition of done.

In Strict mode, list the top 3-5 improvements on REJECT.

## Response Format

**[APPROVE / REJECT]**

**Justification**: concise explanation of the verdict.

**Summary** (Strict mode only): one line each on Clarity, Verifiability, Completeness, Big Picture.

**Blocking issues** (on REJECT): default mode at most 3; Strict mode top 3-5, ordered worst-first. Each: specific location + what needs to change.

`<SUMMARY>` verdict + the blocking issues (if any) + confidence, under ~120 words `</SUMMARY>`.

## Modes of Operation

**Advisory Mode** (default): Review and return the verdict above.

**Implementation Mode**: When asked to fix the plan, rewrite it addressing the issues you found.

## When to Invoke Plan Reviewer

- Before starting significant implementation work
- After creating a work plan
- When a plan needs validation for completeness
- Before delegating work to other agents

## When NOT to Invoke Plan Reviewer

- Simple, single-task requests
- When the user explicitly wants to skip review
- For trivial plans that do not need formal review
