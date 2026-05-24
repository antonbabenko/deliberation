---
name: consensus
description: Iteratively converge GPT + Gemini + Grok + Claude on a plan/design until all four agree. Max 5 rounds. Best for plan refinement.
allowed-tools: mcp__codex__codex, mcp__gemini__gemini, mcp__grok__grok, Read, Bash
timeout: 900000
---

# Consensus (GPT + Gemini + Grok + Claude convergence loop)

Iterate up to 5 rounds. Each round refines the plan based on GPT + Gemini + Grok feedback. Stop when all four (Claude, GPT, Gemini, Grok) approve the current revision, or when 5 rounds are exhausted.

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
- Time-sensitive work — this loop can take several minutes

## Workflow

### Setup (run once)

1. Identify expert. Default is **Plan Reviewer**. Override only if `$ARGUMENTS` clearly maps to another role:
   - Architecture / design tradeoffs → Architect
   - Security / threat modeling → Security Analyst
   - Code review of a concrete diff → Code Reviewer
2. Read expert prompt ONCE via this resolution sequence:
   1. Glob `~/.claude/plugins/cache/*claude-delegator/claude-delegator/*/prompts/[expert].md`. Pick the match with the highest semver version segment (the segment immediately after `claude-delegator/`, parsed as semver - not lexical string compare).
   2. If no match, look up the inlined fallback under the heading `## Inlined fallback - [Expert]` in this command file (see end of this file).
   3. If neither found, abort with: `Error: claude-delegator plugin cache missing for expert "[Expert]". Run /plugin install claude-delegator or /reload-plugins.`

   Reuse the loaded contents across all rounds.
3. **Pre-flight cwd trust check**:
   - Always use `process.cwd()` as the MCP `cwd` argument; NEVER switch folders.
   - Detect B2 (skip-trust) support: glob `~/.claude/plugins/cache/*claude-delegator/claude-delegator/*/.claude-plugin/plugin.json`, parse the highest-semver match, treat `version >= "1.3.0"` (semver compare) as B2-supported. On parse error or no match: treat as B2 absent.
   - Try reading `~/.gemini/trustedFolders.json`. On any error (ENOENT, EACCES, SyntaxError, value not an object): treat the trusted set as EMPTY and emit a one-line warning to stderr including the specific error message (for example `trustedFolders.json unreadable: ENOENT: no such file`).
   - Build trusted-set = direct keys plus all descendants of keys whose value is `"TRUST_PARENT"`. Normalize paths first: resolve `~`, follow symlinks, strip trailing slashes (use `path.resolve` plus `fs.realpathSync` semantics).
   - If `process.cwd()` (normalized) is in trusted-set: call as today.
   - Else if B2 is supported: set `"skip-trust": true` on the call.
   - Else: abort with: `Error: cwd "${process.cwd()}" not in trustedFolders.json; trust it via `gemini` once, or upgrade claude-delegator to 1.3.0+ for skip-trust support.`
4. Initialize state:
   - `plan` = original `$ARGUMENTS`
   - `round` = 0
   - `history` = empty list of `{round, plan_diff_summary, gpt_verdict, gemini_verdict, grok_verdict, claude_decision}`
5. Print:
   ```
   /consensus: starting consensus loop (max 5 rounds, expert=[Expert])
   ```

### Round loop (rounds 1..5)

For each round R:

1. **Print round header** before dispatching, so the user knows progress:
   ```
   --- Round R/5 --- Codex + Gemini + Grok working in parallel (typical 30-60s)...
   ```

2. **Build identical review prompt** (7-section format per `~/.claude/rules/delegator/delegation-format.md`). Include:
   - **CURRENT PLAN** (full text of the latest revision)
   - **ROUND METADATA**: round R of 5; if R > 1, attach the previous round's deltas (what was changed and why)
   - **Round metadata is BOUNDED**: include the last 2 rounds verbatim; for any rounds older than that, include only a one-line summary of each (verdict + applied-change phrase). This prevents prompt-length growth across 5 rounds.
   - **TASK**: review the plan for completeness, correctness, hidden assumptions, missing edge cases, and blockers
   - **OUTPUT FORMAT** (strict, so parsing is deterministic):
     ```
     **Verdict**: APPROVE | REQUEST CHANGES | REJECT
     **Critical issues** (must-fix; empty list = none): [bullets]
     **Recommendations** (nice-to-have; empty list = none): [bullets]
     **One-line bottom line**: [single sentence]
     ```
3. **Parallel dispatch** - all three calls in ONE message with three tool blocks. Identical prompt body, identical expert prompt:
   ```
   mcp__codex__codex({
     prompt: "[identical 7-section prompt for round R]",
     "developer-instructions": "[expert prompt]",
     sandbox: "read-only",
     cwd: "[trusted cwd]"
   })

   mcp__gemini__gemini({
     prompt: "[identical 7-section prompt for round R]",
     "developer-instructions": "[expert prompt]",
     sandbox: "read-only",
     model: "auto-gemini-3",
     cwd: "[trusted cwd]"
   })

   mcp__grok__grok({
     prompt: "[identical 7-section prompt for round R]",
     "developer-instructions": "[expert prompt]",
     sandbox: "read-only",
     files: [{ path: "<file>" }]   // OPTIONAL - only when files are attached to the round
   })
   ```
   **Files (optional):** if the plan under review references attached files, pass them to
   Grok via `files:[{path}]` each round; GPT and Gemini read the named paths from their
   trusted `cwd`.

4. **Stream short status as each return arrives**. Do not wait until all are back to print anything. Examples:
   ```
   GPT (R{R}): APPROVE
   Gemini (R{R}): REQUEST CHANGES (3 critical)
   Grok (R{R}): APPROVE
   ```

5. **Parse verdicts and form Claude's own opinion**:
   - Extract `Verdict`, `Critical issues`, `Recommendations` from each of the three reviewers.
   - For each critical issue: Claude marks it as `accept` (real problem, fix), `dismiss` (false positive - record why), or `defer` (legitimate but out of scope for this plan).
   - Claude's own `verdict` is APPROVE if and only if there are zero accepted critical issues across all three reviewers, AND Claude has no critical issues of its own.

6. **Convergence check** - STOP the loop when ALL FOUR are APPROVE:
   - GPT verdict == APPROVE AND
   - Gemini verdict == APPROVE AND
   - Grok verdict == APPROVE AND
   - Claude verdict == APPROVE (no accepted critical issues anywhere)

7. **If not converged**:
   - Compile the union of `accept`-ed critical issues from all three reviewers plus any Claude found.
   - Revise the plan to address them. Be explicit about what changed and what was deliberately not changed.
   - Record this round in `history` with: GPT verdict, Gemini verdict, Grok verdict, Claude's per-issue decisions, the diff summary applied to the plan.
   - Print the revised plan ONLY if it has changed materially (don't spam on small wording tweaks).
   - Continue to round R+1.
   - **Backoff after multi error**: if MORE THAN ONE provider returned a provider-error in round R (not a regular REQUEST CHANGES verdict, but an MCP error or `result.isError`), wait 1-2 seconds before dispatching round R+1 to let transient API hiccups clear.

8. **If round R == 5 and still not converged**:
   - Emit the final state with residual disagreements clearly labeled. Do not pretend convergence.
   - Note which side (GPT, Gemini, Grok, or Claude) holds out on which issues.

### Final output

```
## /consensus result

**Outcome**: CONVERGED in N rounds | UNRESOLVED after 5 rounds
**Final plan**:
[full converged plan, or last revision]

**Round history**:
| Round | GPT | Gemini | Grok | Claude | Changes applied |
| 1     | RC  | RC     | RC   | RC     | added rollback step, clarified ownership |
| 2     | RC  | APPR   | APPR | APPR   | tightened error handling on step 3 |
| 3     | APPR | APPR  | APPR | APPR   | - (no change; consensus reached) |

**Residual disagreements** (if any):
- GPT (held out on R5): [issue + reason Claude dismissed it]
```

## Stability rules

- **Always dispatch in parallel** - all three MCP calls in the same message. Sequential triples wall time.
- **Single-shot per round** - fresh thread each call. Do NOT use `*-reply` with stored threadId. Cross-round state lives in the prompt body, not in provider memory. Avoids contamination if one provider went off track.
- **Trusted `cwd` for Gemini** - run the Pre-flight cwd trust check from Setup step 3. NEVER switch folders; use skip-trust when supported, abort otherwise.
- **Provider failure does not kill the loop** - if a provider errors (timeout, trust failure, Grok `missing-auth`, transient API error), treat its verdict as `REQUEST CHANGES` with a note `"provider error: <truncated msg>"`. Continue the round. The loop can still converge if the surviving reviewers agree with Claude.
- **Pin Gemini model** - always `model: "auto-gemini-3"`. Grok uses its bridge default (`GROK_DEFAULT_MODEL` or `grok-4.3`); no in-command pin.
- **Hard cap at 5 rounds** - even if one reviewer is being stubborn, terminate. Diverging too many rounds usually means the plan has an unresolved ambiguity, not that the reviewer is wrong.
- **Report as you go** - print a status line after each round dispatch and after each return. Long silences look like a hang.
- **Synthesize, never paste raw** - reviewers' raw output never appears verbatim in the final report.

## Heuristics for Claude's per-issue decisions

- **accept**: reviewer found a real gap or risk that the plan does not cover. Update the plan.
- **dismiss**: reviewer flagged something that the plan already addresses, or that is genuinely out of scope, or that is theoretical (e.g., "what if the disk fails mid-write" on a non-critical caching plan). Record the dismissal reason in `history` so the next round's prompt explains why it was not changed.
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

You are a work plan review expert. Your job is to catch every gap, ambiguity, and missing context that would block implementation.

## Context

You review work plans with a ruthlessly critical eye. You're not here to be polite-you're here to prevent wasted effort by identifying problems before work begins.

## Core Review Principle

**REJECT if**: When you simulate actually doing the work, you cannot obtain clear information needed for implementation, AND the plan does not specify reference materials to consult.

**APPROVE if**: You can obtain the necessary information either:
1. Directly from the plan itself, OR
2. By following references provided in the plan (files, docs, patterns)

**The Test**: "Can I implement this by starting from what's written in the plan and following the trail of information it provides?"

## Four Evaluation Criteria

### 1. Clarity of Work Content

- Does each task specify WHERE to find implementation details?
- Can a developer reach 90%+ confidence by reading the referenced source?

**PASS**: "Follow authentication flow in `docs/auth-spec.md` section 3.2"
**FAIL**: "Add authentication" (no reference source)

### 2. Verification & Acceptance Criteria

- Is there a concrete way to verify completion?
- Are acceptance criteria measurable/observable?

**PASS**: "Verify: Run `npm test` - all tests pass"
**FAIL**: "Make sure it works properly"

### 3. Context Completeness

- What information is missing that would cause 10%+ uncertainty?
- Are implicit assumptions stated explicitly?

**PASS**: Developer can proceed with <10% guesswork
**FAIL**: Developer must make assumptions about business requirements

### 4. Big Picture & Workflow

- Clear Purpose Statement: Why is this work being done?
- Background Context: What's the current state?
- Task Flow & Dependencies: How do tasks connect?
- Success Vision: What does "done" look like?

## Common Failure Patterns

**Reference Materials**:
- FAIL: "implement X" but doesn't point to existing code, docs, or patterns
- FAIL: "follow the pattern" but doesn't specify which file

**Business Requirements**:
- FAIL: "add feature X" but doesn't explain what it should do
- FAIL: "handle errors" but doesn't specify which errors

**Architectural Decisions**:
- FAIL: "add to state" but doesn't specify which state system
- FAIL: "call the API" but doesn't specify which endpoint

## Response Format

**[APPROVE / REJECT]**

**Justification**: [Concise explanation]

**Summary**:
- Clarity: [Brief assessment]
- Verifiability: [Brief assessment]
- Completeness: [Brief assessment]
- Big Picture: [Brief assessment]

[If REJECT, provide top 3-5 critical improvements needed]

## Modes of Operation

**Advisory Mode** (default): Review and critique. Provide APPROVE/REJECT verdict with justification.

**Implementation Mode**: When asked to fix the plan, rewrite it addressing the identified gaps.

## When to Invoke Plan Reviewer

- Before starting significant implementation work
- After creating a work plan
- When plan needs validation for completeness
- Before delegating work to other agents

## When NOT to Invoke Plan Reviewer

- Simple, single-task requests
- When user explicitly wants to skip review
- For trivial plans that don't need formal review
