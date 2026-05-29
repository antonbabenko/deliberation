---
name: consensus
description: Arbiter-mediated consensus - GPT + Gemini + Grok (plus any configured OpenRouter delegates) review while Claude commits a blind verdict, adjudicates, and synthesizes. Converges only with cross-model agreement. Max 5 rounds.
allowed-tools: mcp__codex__codex, mcp__gemini__gemini, mcp__grok__grok, mcp__openrouter__openrouter, mcp__openrouter__openrouter-list, Read, Bash
timeout: 900000
---

# Consensus (arbiter-mediated GPT + Gemini + Grok + OpenRouter + Claude convergence loop)

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
2. Read expert prompt ONCE via this resolution sequence (fire this `Glob` in the SAME parallel message as the step 6 concurrent-prep reads - see step 6):
   1. Glob `~/.claude/plugins/cache/*/claude-delegator/*/prompts/[expert].md`. Pick the match with the highest semver version segment (the segment immediately after `claude-delegator/`, parsed as semver - not lexical string compare).
   2. If no match, look up the inlined fallback under the heading `## Inlined fallback - [Expert]` in this command file (see end of this file).
   3. If neither found, abort with: `Error: claude-delegator plugin cache missing for expert "[Expert]". Run /plugin install claude-delegator or /reload-plugins.`

   Reuse the loaded contents across all rounds.
3. **Set cwd**: use `process.cwd()` as the MCP `cwd` for every call; agy print mode needs no folder-trust pre-check (Grok and Codex have no trusted-directory concept either).
4. Initialize state:
   - `plan` = original `$ARGUMENTS`
   - `round` = 0
   - `history` = empty list of `{round, plan_diff_summary, claude_blind_verdict, gpt_verdict, gemini_verdict, grok_verdict, claude_decision, dismissals, cat_hits, parse_fallbacks, stage_2_status, stage_2_results, stage_2_shuffle}`
     - `stage_2_status` is one of `fired` | `skip_no_div` | `skip_s1_quorum` | `skip_sandbox` | `err_quorum`.
     - `stage_2_results` is `{matrix: {<reviewer-model-id>: {<answer-model-id>: {vote, category|null, reason}}}, accepted_nv_count, raw_nv_count}` when `stage_2_status == fired`; otherwise the reason string.
     - `stage_2_shuffle` is `{<reviewer-model-id>: {A: <answer-model-id>, B?: <answer-model-id>}}` (operator-visible debug mapping; absent when Stage 2 did not fire).
5. Print:
   ```
   /consensus: starting consensus loop (max 5 rounds, expert=[Expert])
   ```

6. **Concurrent prep + build the OpenRouter voting panel.** Run the prep ONCE in a single parallel message (concurrent prep, single dispatch): the expert-prompt `Glob` (step 2), `Read` `~/.claude/claude-delegator/config.json`, `mcp__openrouter__openrouter-list`, and the round-1 status-block sources - `Read` `~/.codex/config.toml`, `Read` `~/.gemini/settings.json`, `Bash` `echo "$GROK_DEFAULT_MODEL" "$GROK_REASONING_EFFORT"` - all in ONE message, not sequential turns. Build the panel + round-1 status block from those cached results (the `invalidModels` `AskUserQuestion` below is the one allowed serial gate):
   - From the cached `~/.claude/claude-delegator/config.json` read, take `providers.*.enabled` (a built-in
     with `enabled:false` is excluded from this run even if registered).
   - From the cached `mcp__openrouter__openrouter-list` result: if unavailable / `error` set (a hard config
     failure - bad JSON, schema, version, or maxFanout), there are no OpenRouter voices.
     Otherwise the returned `delegates` are the valid models; `invalidModels` (if non-empty)
     are entries the bridge skipped per-entry (each `{ index, alias, reason, suggestedAlias? }`).
   - **If `invalidModels` is non-empty, do NOT silently drop them.** PRINT a short report
     (one line per entry: `alias|index` + `reason` + `-> suggestedAlias` when present), then
     ask with `AskUserQuestion` (first option is the pre-selected default):
     1. **Fix & proceed (Recommended)** - apply each `suggestedAlias` by `Edit`ing
        `~/.claude/claude-delegator/config.json`; drop + note entries with no safe fix;
        re-call `openrouter-list` and use the resulting valid set.
     2. **Run valid only** - leave config untouched; use the returned `delegates` as-is, note
        the skipped entries.
     3. **Skip all OpenRouter** - no OpenRouter voices this run.
   - The voting panel = valid delegates with `consensus == true` eligible for the chosen
     expert (`experts` absent = all; `[]` = none; else must include the expert). NOT bounded
     by `maxFanout`.
   - If the OpenRouter voting panel size is > 3, PRINT before the first dispatch:
     `Warning: N OpenRouter voting models x up to 5 rounds x the inlined repo bundle = significant token cost AND a stricter convergence bar (every responding voice must APPROVE).`

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
   - **ISSUE CATEGORY TAXONOMY** (closed set, every critical issue picks exactly one):
     - `security`    - auth, secrets, injection, data exposure, privilege boundary
     - `correctness` - wrong behaviour, broken invariant, missing case, race condition
     - `scope`       - undefined boundary, missing acceptance criteria, deliverable unclear
     - `ambiguity`   - reference too vague to act on, contradictory steps, missing context
     - `performance` - latency, throughput, resource use, scaling limit
     - `ops`         - rollback, observability, deploy, migration, on-call surface
   - **OUTPUT FORMAT** (strict, so parsing is deterministic):
     ```
     **Verdict**: APPROVE | REQUEST CHANGES | REJECT
     **Critical issues** (must-fix; empty list = none):
       - `[category]` issue description
       - ...
     **Recommendations** (nice-to-have; empty list = none): [bullets]
     **One-line bottom line**: [single sentence]
     ```
     `[category]` MUST be exactly one of: `security`, `correctness`, `scope`, `ambiguity`, `performance`, `ops`. Reviewers that emit a critical issue without a category tag get that issue parsed as `ambiguity` by default, and the fallback is recorded in a NEW per-round field `history[R].parse_fallbacks` (an array of `{source, issue_excerpt, reason: "reviewer omitted category tag"}`). Do NOT write parse fallbacks into `history[R].dismissals`; that field is reserved for adjudicated dismiss/defer decisions and feeds the "Dismissed / deferred issues" section of the final report. Parse fallbacks surface separately as a one-line footnote under the Round history table.

3. **Claude's BLIND verdict - EMIT BEFORE DISPATCHING**: in a message of its OWN, BEFORE the message that calls any MCP tool, Claude writes its own verdict in the strict OUTPUT FORMAT above using ONLY the review prompt from step 2 (it has not seen any reviewer output yet), and stores it verbatim in `history[R].claude_blind_verdict`. Print:
   ```
   Claude blind (R{R}): APPROVE | REQUEST CHANGES | REJECT (N critical)
   ```
   This is the orchestrator's PEER vote. Emitting it in an earlier message than the dispatch makes the pre-commitment visible in the transcript. Claude must NOT edit the blind verdict after seeing reviewers; it appears verbatim in the final report. (Claude's *adjudication* in step 7 is a separate, arbiter-role decision, recorded distinctly.)

4. **Parallel dispatch** - in the NEXT message, all three calls in ONE message with three tool blocks. Identical prompt body, identical expert prompt. On **round 1 only**, print the delegate status block first (see "Report as you go" for the format and sources) so the panel's exact models and reasoning efforts are visible before any dispatch; the panel is stable across rounds, so later rounds reuse the per-round status line only:
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
     roots: ["[absolute repo root]"],            // optional; for cross-repo plans pass multiple
     files: [{ path: "path/relative/to/root" }]  // attach referenced files by default
   })
   ```
   **Files:** if the plan under review references local files, pass them to
   Grok via `files:[{path}]` (or `{dir}` for whole directories) each round. Path/dir
   entries accept `mode: "auto" | "inline" | "upload"` (default `"upload"`); use
   `mode: "auto"` so text files inline as `input_text` and Grok reads them
   line-by-line instead of as searchable attachments — this is the difference
   between a citing review and a hand-wavy one. Resolution is against `roots[]`
   (first-root-wins) or `cwd` when `roots` is omitted; a path outside every root is
   refused. For cross-repo plans (auditing two services together) pass `roots:
   [repoA, repoB]`. Uploaded files are SHA-256 dedup-cached locally so the same
   bundle on rounds 2-5 uploads nothing (inline files always cost prompt tokens
   but are always fully read). GPT and Gemini read the named paths from their
   `cwd`. Full reference: `TECHNICAL.md` § "Grok files and cleanup".

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

   For EACH OpenRouter voting-panel delegate, add a parallel tool block:
   ```
   mcp__openrouter__openrouter({
     prompt: "[identical 7-section prompt for round R]",
     "developer-instructions": "[expert prompt]",
     alias: "[delegate alias]",
     sandbox: "read-only",
     cwd: "[repo root]",
     files: [ /* SAME orientation bundle passed to Grok each round */ ]
   })
   ```
   Each OpenRouter delegate is one independent external voice in the convergence count. An
   errored delegate is marked `ERRORED` and excluded from the convergence bar (same as a
   built-in), so a flaky model never blocks convergence.

5. **Stream short status as each return arrives**. Do not wait until all are back to print anything. Mark a provider that returned an MCP error or `result.isError` as ERRORED. Examples:
   ```
   GPT (R{R}): APPROVE
   Gemini (R{R}): REQUEST CHANGES (3 critical)
   Grok (R{R}): ERRORED (provider error: missing-auth)
   ```

6. **Stage 2 (blind cross-review, conditional)** - inserted between Stage 1 returns and arbiter adjudication. Stage 2 is **decision input only**: Stage 2 errors or skips never block convergence (the convergence rule in step 8 is unchanged).

   **6a. Trigger check (deterministic).** Stage 2 fires iff EITHER:
   - This is Round 1 (R == 1), OR
   - Any responding external in the current round's Stage 1 returned non-APPR (REQUEST CHANGES or REJECT), OR
   - The most recent prior Stage 2 that **fired with quorum AND completed arbiter adjudication** had >=1 ACCEPTED not-viable issue (lookback condition).

   `SKIPPED` and `ERRORED` Stage 2 rounds do NOT reset the lookback. Only quorum-successful Stage 2 rounds with completed adjudication count as the lookback anchor (prevents partial-round reads).

   If `/consensus` was invoked with `sandbox: workspace-write`, set `history[R].stage_2_status = "skip_sandbox"` and SKIP the rest of step 6 (Stage 2 is incompatible with the implementation path - anonymization leaks through patch style).

   If the trigger condition is not met, set `history[R].stage_2_status = "skip_no_div"` and SKIP the rest of step 6.

   **6b. Quorum check.** Stage 2 requires Stage 1 to have at least 2 responding externals. Count the externals whose Stage 1 verdict in step 5 was NOT `ERRORED`:
   - If count < 2: set `history[R].stage_2_status = "skip_s1_quorum"` and SKIP the rest of step 6.
   - If count == 2: 2-reviewer panel; both must respond in step 6d to count as quorum.
   - If count == 3: 3-reviewer panel; quorum requires >=2 reviewers to respond in step 6d.

   **6c. Anonymize and build the fan-out bundle.** For each Stage 1 responding external (the answer pool):
   - Strip identity tells (best-effort): remove leading "As <Provider>, ..." preambles, normalize trailing whitespace, drop self-reference phrases. Do NOT touch the body content beyond preamble normalization.
   - Each reviewer in the panel sees the OTHER (N-1) answers, with positions independently randomized per reviewer (so the same underlying answer may be `Response A` to one reviewer and `Response B` to another in the 3-reviewer case).
   - Build and record `history[R].stage_2_shuffle` = `{<reviewer-model-id>: {A: <answer-model-id>, B?: <answer-model-id>}}`. This is operator-visible debug observability; reviewers do NOT receive this mapping.
   - Reviewers receive only the original `$ARGUMENTS` (the user's request), the current plan revision (with a 1-line indicator: "Plan is round R revision"), and the anonymized peer answers. NO Stage 1 verdict metadata, NO full round history, NO dismissals from prior rounds.

   **6d. Parallel dispatch to the panel.** One MCP call per reviewer, all dispatched in a single message with N parallel tool blocks. Reuse the existing expert `developer-instructions` (the same one Stage 1 used this round; do NOT swap experts). Each reviewer call uses a tighter 5-section Stage 2 prompt body:

   ```
   TASK: Score the anonymized peer answers below as viable or not-viable on substance, relative to the user's original request. Do NOT review your own answer (it is excluded).

   INPUT:
   - ORIGINAL USER REQUEST: [verbatim $ARGUMENTS to /consensus]
   - Current plan (round R revision): [full current plan text]
   - Anonymized peer answers:
     Response A:
     [anonymized answer body]
     [Response B:
     [anonymized answer body]]
   - Scoring guidance: when judging viability, use the same closed taxonomy `/consensus` uses for issue categories: security | correctness | scope | ambiguity | performance | ops. For not-viable votes, select exactly one category.

   OUTPUT FORMAT (strict):
   Response A: viable - [one-line reason]            (if viable)
   Response A: not-viable - [category] - [one-line reason]   (if not-viable)
   [Response B: viable - [one-line reason]           (if viable)
    Response B: not-viable - [category] - [one-line reason]  (if not-viable)]
   Bottom line: [single sentence]

   CONSTRAINTS:
   - Score substance, ignore style. Anonymization is best-effort; do not try to deanonymize.
   - Category is REQUIRED for not-viable; OMITTED for viable.
   - `[category]` MUST be exactly one of: security, correctness, scope, ambiguity, performance, ops.
   ```

   Print a status line as each reviewer returns:
   ```
   Stage 2 [Provider] (R{R}): 0 NV | 1 NV | 2 NV | ERRORED
   ```
   where the NV count is the number of not-viable votes that reviewer cast.

   **6e. Reviewer quorum re-check.** Count Stage 2 reviewers that returned without error:
   - 3-reviewer panel: <2 responding -> set `history[R].stage_2_status = "err_quorum"`; no Stage 2 issues added this round.
   - 2-reviewer panel: <2 responding (i.e., either errored) -> set `history[R].stage_2_status = "err_quorum"`; no Stage 2 issues added this round.
   - If >=2 reviewers errored in this round, wait 1-2s before the next round dispatch (multi-error backoff; mirrors step 9's existing rule for Stage 1).

   If quorum passes, set `history[R].stage_2_status = "fired"`.

   **6f. Parse each reviewer's output, case-insensitive and bracket-tolerant.** For each response line:
   - Accept both `[security]` and `security` for the category. Lowercase normalize before matching against the 6-cat enum.
   - If the category is omitted on a not-viable vote OR not in the 6-cat enum, fall back to `ambiguity` and append `{source: "Stage 2: <reviewer-model-id> on <answer-position>", issue_excerpt: <one-line reason>, reason: "Stage 2: omitted/invalid category"}` to `history[R].parse_fallbacks` (same array Stage 1 already uses).

   **6g. Build candidate critical issues from not-viable votes.** For each `Response X: not-viable - [category] - [reason]` from a reviewer:
   - Resolve the answer-model-id via `history[R].stage_2_shuffle[<reviewer-model-id>][X]`.
   - Construct candidate issue: `[Stage 2: <reviewer-model-id> on <answer-model-id>] [category] [one-line reason]`.
   - Compute the weight tag: in the 3-reviewer panel, each answer is seen by exactly 2 reviewers, so weight is `(N of 2)` where N is the count of those 2 reviewers that marked the answer not-viable. In the 2-reviewer panel, each answer is seen by 1 reviewer; weight is `(1 of 1)` or `(0 of 1)`.
   - Append every constructed candidate issue to `history[R].stage_2_results.matrix` AND to the pool of issues passed to step 7 (Adjudicate) below. The category goes through cat_hits the same way Stage 1 categories do.

   Store the final structure: `history[R].stage_2_results = {matrix, accepted_nv_count: <to_be_filled_in_step_7>, raw_nv_count: <count_of_all_not_viable_votes_this_round>}`.

7. **Adjudicate (arbiter role) - reconcile issues against the blind verdict**:
   - From each RESPONDING Stage 1 reviewer, extract `Verdict`, `Critical issues`, `Recommendations`. An ERRORED provider is excluded (see Convergence check); it contributes no verdict and no Stage 1 issues.
   - In ADDITION to Stage 1 issues, include any Stage 2 candidate issues from step 6g (when Stage 2 fired with quorum). Each Stage 2 candidate issue is a normal `{source, category, description}` entry where `source` is the string `"Stage 2: <reviewer-model-id> on <answer-model-id>"` and includes its weight tag `(N of M reviewers WHO SAW THIS ANSWER marked it not-viable)` appended to the description. Stage 2 issues participate in dismiss/accept/defer the same way Stage 1 issues do.
   - For each critical issue - whether raised by a reviewer OR by Claude's own blind verdict - record a decision WITH a one-line reason: `accept` (real problem, fix), `dismiss` (false positive - reason REQUIRED), or `defer` (out of scope - reason REQUIRED). Append every `dismiss`/`defer` to `history[R].dismissals`. **This includes Claude walking back one of its own blind critical issues** - that is a `dismiss` and needs a recorded reason too.
   - **Repeated-issue default**: if two or more sources (reviewers, or a reviewer plus Claude's blind verdict) raise substantially the same critical issue, `accept` it by default; only `dismiss` with a concrete factual reason ("out of scope" alone is not enough).
   - **Category overlap signal**: after extracting categories from every responding Stage 1 reviewer, every Stage 2 candidate issue (when Stage 2 fired), plus Claude's blind verdict, build a `{category: source_count}` map counting how many DISTINCT sources raised at least one critical issue in each category. Store as `history[R].cat_hits`. Any category with `source_count >= 2` is a cross-source category hit and surfaces in the Round history table's `Cat hits` column. Cell format: comma-separated `category x<source_count>` entries, ordered by source_count descending then category name ascending; render `-` if no category reached the 2+ threshold. Example cell: `security x4, ops x2`. This is a reporting-only signal; it does not change the convergence rule.
   - Claude's adjudicated verdict is APPROVE if and only if zero accepted critical issues remain anywhere (reviewers or Claude's blind verdict).
   - After dismiss/accept/defer is complete: count how many Stage 2-source candidate issues were `accept`-ed this round and write the count back to `history[R].stage_2_results.accepted_nv_count`. The lookback condition in step 6a's trigger uses this count, NOT the raw not-viable vote count.

8. **Convergence check** - the loop CONVERGES only when ALL of these hold:
   - At least one external reviewer RESPONDED this round (not all errored), AND
   - Every RESPONDING external returned APPROVE (ERRORED providers are excluded from the bar - not counted as APPROVE or as REQUEST CHANGES), AND
   - No responding reviewer returned REJECT, AND
   - Zero accepted critical issues remain (from any reviewer or from Claude's blind verdict), AND
   - Claude's adjudicated verdict == APPROVE.
   A round in which ALL externals errored has no responding external and therefore CANNOT converge. If any responding reviewer returned REJECT, the result may NOT be labelled "consensus" even at round 5.
   "Externals" here means every responding enabled built-in (GPT/Gemini/Grok) AND every
   responding OpenRouter voting-panel delegate. Each is one voice; ERRORED voices are
   excluded from the bar.

9. **If not converged**:
   - Compile the union of `accept`-ed critical issues from all responding reviewers plus any Claude found.
   - Revise the plan to address them. Be explicit about what changed and what was deliberately not changed.
   - Record this round in `history` with: Claude blind verdict, GPT/Gemini/Grok and each OpenRouter delegate verdict (or ERRORED), Claude's per-issue decisions + reasons, the diff summary applied to the plan.
   - Print the revised plan ONLY if it has changed materially (don't spam on small wording tweaks).
   - Continue to round R+1.
   - **Backoff after multi error**: if MORE THAN ONE provider errored in round R, wait 1-2 seconds before dispatching round R+1 to let transient API hiccups clear.

10. **If round R == 5 and still not converged**:
   - Emit the final state with residual disagreements clearly labeled. Do not pretend convergence.
   - Note which side (Claude blind, GPT, Gemini, or Grok) holds out on which issues.

### Convergence confidence label

Derive a one-word confidence label from the number of rounds the loop took to converge. The label appears in the Final output's outcome line. A plan that converges in round 1 is a stronger signal than a plan that needed every round to settle.

- `high`   - converged in round 1
- `medium` - converged in round 2 or 3
- `low`    - converged in round 4 or 5
- `none`   - UNRESOLVED after 5 rounds (no convergence to grade)

This is a copy-only signal: it is computed at the end from `round`, does not affect the convergence rule itself, and never inflates an UNRESOLVED outcome into a converged one.

### Final output

```
## /consensus result

**Mode**: arbiter-mediated consensus (external models vote; Claude adjudicates + synthesizes)
**Outcome**: CONVERGED in N rounds (confidence: high|medium|low) | UNRESOLVED after 5 rounds (confidence: none)
**Final plan**:
[full converged plan, or last revision]

**Round history** (CB = Claude blind verdict; reviewer cols use APPR/RC/REJ or ERR; Adj = Claude adjudicated; S2 = Stage 2 status; Cat hits = categories raised by 2+ sources this round):
| Round | CB   | GPT  | Gemini | Grok | Adj  | S2                | Cat hits                | Changes applied |
| 1     | RC   | RC   | RC     | RC   | RC   | fired (2 NV)      | security x4, ops x2     | added rollback step, clarified ownership |
| 2     | RC   | RC   | APPR   | ERR  | RC   | fired (1 NV)      | correctness x2          | tightened error handling on step 3 |
| 3     | APPR | APPR | APPR   | ERR  | APPR | skip (no div)     | -                       | - (Grok unconfigured; converged on responding externals) |

S2 column cell values:
- `fired (N NV)` - Stage 2 ran with quorum, surfaced N not-viable votes (raw count across all reviewers).
- `skip (no div)` - Stage 2 skipped because Stage 1 had no non-APPR verdicts AND the lookback condition was false.
- `skip (S1 quorum)` - Stage 2 skipped because fewer than 2 Stage 1 externals responded.
- `skip (sandbox)` - Stage 2 skipped because /consensus was invoked with `sandbox: workspace-write`.
- `ERR (quorum)` - Stage 2 reviewers below quorum (<2 responses).

**Stage 2 shuffle mapping** (operator debug - per round, per reviewer; shows which `Response A`/`Response B` corresponded to which model in Stage 2):
- [R{n}] {reviewer-model-id}: A = {answer-model-id}, B = {answer-model-id}
- [R{n}] {reviewer-model-id}: A = {answer-model-id}     <- 2-responder panel
- ...

If Stage 2 did not fire in any round, render `**Stage 2 shuffle mapping**: none.`

**Parse fallbacks** (reviewers that omitted a category tag; auto-parsed as `ambiguity`):
- [R{n}] {source}: "{issue excerpt}" - reason: reviewer omitted category tag

If there were zero fallbacks across the whole loop, render `**Parse fallbacks**: none.`

**Dismissed / deferred issues** (every dismiss/defer, with reason - no silent dismissal; includes Claude walking back its own blind issues):
- [R{n}] {source} raised "{issue}" -> dismissed: {one-line reason}
- [R{n}] {source} raised "{issue}" -> deferred (out of scope): {one-line reason}

**Residual disagreements** (if any):
- GPT (held out on R5): [issue + reason Claude dismissed it]
```

## Stability rules

- **Always dispatch in parallel** - all three MCP calls in the same message. Sequential triples wall time.
- **Concurrent prep** - run the Setup prep (expert Glob + `config.json` + `openrouter-list` + the round-1 status sources `~/.codex/config.toml` / `~/.gemini/settings.json` / Grok env) in ONE parallel message before the round loop, not sequential turns. The `invalidModels` `AskUserQuestion` is the one allowed serial gate. See `rules/delegator/orchestration.md` Step 5.5.
- **Single-shot per round** - fresh thread each call. Do NOT use `*-reply` with stored threadId. Cross-round state lives in the prompt body, not in provider memory. Avoids contamination if one provider went off track.
- **`cwd` for Gemini** - use `process.cwd()` (Setup step 3). agy print mode needs no folder-trust pre-check, so there is nothing to abort on.
- **Provider failure does not kill the loop** - if a provider errors (timeout, Grok `missing-auth`, transient API error), mark it ERRORED with a note `"provider error: <truncated msg>"` and EXCLUDE it from the convergence bar for that round (it counts as neither APPROVE nor REQUEST CHANGES). The loop still converges when every responding external and Claude APPROVE and at least one external responded. If ALL externals errored in a round, there is no responding external, so that round cannot converge.
- **Pin Gemini model** - always `model: "auto-gemini-3"`. Grok uses its bridge default (`GROK_DEFAULT_MODEL` or `grok-4.3`); no in-command pin.
- **Claude cannot self-approve into consensus** - convergence requires every responding external to APPROVE and at least one external to respond; Claude's APPROVE alone never converges. Claude's blind verdict is a peer vote; its adjudication is a separate, accountable role.
- **No silent dismissal** - every `dismiss`/`defer` of a critical issue (from a reviewer OR from Claude's own blind verdict) carries a one-line reason that appears in the final report. Repeated cross-source issues are accepted by default.
- **Hard cap at 5 rounds** - even if one reviewer is being stubborn, terminate. Diverging too many rounds usually means the plan has an unresolved ambiguity, not that the reviewer is wrong.
- **Report as you go** - before the round-1 dispatch, print a per-delegate status block (one line per voting member: provider, exact model, reasoning effort), then print a status line after each round dispatch and after each return. Long silences look like a hang. Resolve each member's model + effort from its real source, never invent: Codex from `~/.codex/config.toml` (`model` / `model_reasoning_effort`, missing = `default`); Gemini model from `~/.gemini/settings.json` (`model.name`, default `auto-gemini-3`) with effort `n/a` (agy has no knob); Grok = `$GROK_DEFAULT_MODEL` else `grok-4.3` / `$GROK_REASONING_EFFORT` else `high`; OpenRouter voting delegates straight from `openrouter-list` (`model` + resolved `reasoning_effort`, `null` prints as `default`). Print `unknown` for any field whose source can't be read. Example:
  ```
  Consensus panel (round 1, typical 30-60s/round):
    - Codex (GPT)                   gpt-5.5                       reasoning: high
    - Gemini                        auto-gemini-3                 reasoning: n/a
    - Grok (xAI)                    grok-4.3                      reasoning: high
    - OpenRouter / kimi-k2-thinking moonshotai/kimi-k2-thinking   reasoning: high
  ```
- **Synthesize, never paste raw** - reviewers' raw output never appears verbatim in the final report.
- **Stage 2 is decision input only** - Stage 2 fires conditionally (step 6); its candidate issues feed step 7's existing adjudication. Stage 2 status (`fired`/`skipped`/`errored`) does NOT participate in the convergence rule. The convergence rule in step 8 reads only Stage 1 verdicts + Claude's adjudication + accepted critical issues (from any source, Stage 1 or Stage 2 alike).
- **Stage 2 anonymization is best-effort** - identity stripping removes preambles and self-references but model house styles may still leak. Reviewers are explicitly instructed to score substance and ignore style. The operator-visible shuffle mapping in the final report records ground truth for post-hoc audit.
- **Stage 2 skips on workspace-write sandbox** - when `/consensus` is invoked with `sandbox: workspace-write` (Claude making code changes via consensus), step 6 sets `stage_2_status = "skip_sandbox"` and skips the entire Stage 2 sub-loop. Anonymization leaks too much on patches. Plan reviews that merely CONTAIN embedded diff text as prose still run Stage 2.
- **Stage 2 cross-review covers the built-in externals only (v1)** - OpenRouter voting delegates count as voices in Stage 1 verdicts and in the convergence bar, but they do NOT enter the Stage 2 anonymization pool and are not dispatched as Stage 2 reviewers. When Stage 2 step 6b counts "Stage 1 responding externals" for quorum, count only the built-ins (GPT/Gemini/Grok). This is intentional for v1.

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
