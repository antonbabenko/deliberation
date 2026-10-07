# Config history, comparison, and dashboard improvements

Status: implemented and verified after the seven-provider review on 2026-10-07.

## Goals

Record which configuration and effective model settings each run used. Compare
whole configurations in `analyze` and dashboard Stats. Give every member of a
parallel fan-out the same opportunity to finish, within the longest member's
allowed window. Shorten provider labels and time formatting, and show separate
ask and consensus effort in the Config tab.

## Baseline before implementation

- `server/openrouter/config.js` reloads resolved config when file mtime changes.
  `server/mcp/index.js:makeRuntime` fixes built-in provider model, effort, and
  timeout at construction, while routing and OpenRouter model settings reload.
  The config file therefore is not necessarily the effective runtime config.
- `core/debug-log.js`, `core/journal.js`, and `core/sessions.js` store separate
  telemetry. Debug events and session records do not currently share a run ID.
- `core/analyze.js` reports model timing and verdict agreement as separate
  lenses. Its default current-model filter can hide models from earlier configs.
- Dashboard Stats calls `analyze` with no arguments and aggregates journal runs
  separately. Config health renders one effort column from config values.
- `core/orchestrate.js:askAll` waits for all selected providers, but adapters use
  independent ceilings. An earlier timeout already aborts/kills that request.

## 1. Capture effective config identities and activation history

Add a shared core module for a versioned, canonical, allowlisted config snapshot.
Include model IDs/aliases, enabled/routing membership, ask and consensus effort,
generation settings, timeout policy/limits, arbiter, round/quorum/budget settings,
and orientation/grounding settings that affect results. Exclude credentials,
credential values, prompts, file content, machine paths, and dashboard display or
retention settings. Sort object keys; preserve ordered model/routing lists where
order can change selection. Hash canonical contents for a stable full `configId`;
show an unambiguous short ID in the UI.

Build snapshots from settings actually active in the runtime, including startup
provider values and hot-reloaded values. Keep pending restart-required changes
distinct from active settings. Record `firstSeenAt` (first observed use, not file
creation time), plus a unique `activationId` and `activatedAt` for each transition.
A -> B -> A reuses A's config ID and adds a new activation. Distinct server
instances may concurrently use different configs; record their runtime IDs.

Pin one config context at run creation. Resolve and capture the effective panel
and per-call settings before dispatch; request/expert overrides remain visible
as call metadata rather than silently changing the baseline config's meaning.
For multi-step consensus, keep the pinned context across all steps and rounds.
Do not reread the latest config at completion and attribute it retroactively.

Persist sanitized snapshot metadata with session records and journal run starts;
attach config/activation/runtime IDs and a shared run ID to debug events. A small
append-only config history catalog provides discovery across logging modes, with
opt-in persistence respected. Keep run records self-describing so catalog
retention/failure cannot orphan them. Concurrent writers and restarts must retain
stable IDs and valid records. Telemetry failures must never fail delegation.

Legacy data remains readable under an explicit `Unknown / legacy config` group;
never infer its config from today's file. Missing/invalid config is surfaced as a
load state, not silently attributed to an unrelated valid snapshot.

Resolve every result-affecting input before cache lookup. The key includes the
versioned semantic baseline config hash, prompt, developer instructions, tool,
expert, context, pinned model, effective effort and temperature. File-bearing
requests including orientation/grounding bypass caching entirely. Reuse is
excluded from fresh agreement, success and quality denominators as well as
latency and newly spent tokens; report reuse separately. Test cross-expert misses. Record `cached`, original
run/call/config provenance, and attempt IDs. Cache hits count as reused results;
exclude their copied token usage and zero latency from fresh-provider samples
and newly spent token totals. Show reuse and retry counts separately. Test an
identical prompt before/after an alias's model or effort changes.

## 2. Compare configs in analyze

Extend the core aggregator and MCP schema with `configId`, optional `activationId`,
and `groupBy: config`, retaining existing output compatibility. Return each
config's snapshot, observed usage periods, sample counts, and independent timing
and agreement lenses. Historical groups must use their recorded membership,
not today's configured-model filter; make this interaction explicit in metadata.

For each config show whole-run count, success/error/timeout outcomes, elapsed
p50/p95 where journal evidence exists, measured tokens and token-coverage count,
consensus convergence/round counts, and provider detail. Whole-run measurements
come from the journal, not the sum or maximum of unrelated debug events. Timing
and agreement stay separate unless a recorded run ID supports a real join.
Do not infer cost from token counts or treat missing CLI usage as zero.

Support all time, `1h`, `24h`, `7d`, and `14d` through the existing `since` contract.
Use one evaluation time for all sources; describe time-boundary rules explicitly.
Select whole runs by start time in `[now - window, now]`; include their attempts
and terminal outcomes in that cohort even when completion crosses a boundary.
Legacy uncorrelated events use their event timestamp and retain a separate
coverage label. Separate live/incomplete runs from terminal outcome/latency
denominators; retries have attempt counts as well as final provider outcomes.
Report truncation, retention gaps, unknown config coverage, and small samples.
Partition comparisons by tool/expert/context and effective settings where needed
so unlike workloads and overrides do not masquerade as config quality changes.
Recommendations remain advisory and config-scoped.

## 3. Dashboard Stats and config history

Thread validated time/config filters through `ui/api.js`, `/api/stats`, dashboard
wiring, analyze, and journal aggregation. Apply the same filters to every table,
summary, suggestion, and daily chart. Add selectors for All time / Last hour /
Last 24 hours / Last 7 days / Last 14 days and All configs / individual config /
Unknown legacy. Persist selections in the URL, preserve them on refresh, and
discard stale fetch responses when selections change quickly.

Label config options `Config <short ID> — first used YYYY-MM-DD HH:MM:SS <zone>`;
use a labeled first-use time because config file creation time is not known.
Show activation periods separately. Add a comparison overview and a view of the
recorded settings/differences. Run details link to the historical snapshot used
by that run; Config distinguishes current active settings from pending changes.
Existing dashboard authentication and sanitization apply to every new endpoint.

When dashboard journaling is enabled, each delegation process publishes a
sanitized runtime manifest on startup and active-config transition, plus a
lightweight heartbeat and best-effort shutdown marker in the dashboard cache.
Use atomic per-runtime files with restrictive permissions and bounded retention;
Use 30-second heartbeat intervals and a 90-second freshness TTL, at most 200
manifest records and 500 history records, each at most 64KiB.
Include runtime ID, process-start identity, active snapshot, observed pending
config ID, last-seen time, and manifest version. Never use PID alone as liveness
proof. Fresh heartbeat means recently observed; expired heartbeat means stale /
unknown, not certainly dead. Read-only dashboard ingestion validates manifests
and does not probe or start model calls.

Config lists/selects observed runtimes, computes restart-required differences
against each runtime's startup settings, and labels the dashboard's own runtime
separately. Processes with journaling disabled are not discoverable; say so rather
than claiming a complete list of active runtimes. A historical snapshot describes
a past run and never implies that its process is still active. Test an old MCP
runtime, a newer dashboard runtime after an edit, simultaneous differing
runtimes, missing/stale manifests, and a reused PID.

## 4. Shared fan-out deadline

Add a validated timeout policy `longest-peer` (default for parallel ask-all and
consensus peer dispatch) and `per-provider` (explicit opt-out). Resolve selected
providers' effective limits, including defaults, environment values and pinned
model overrides, before starting calls. Set one absolute fan-out deadline using
the maximum resolved limit, capped by shared host/consensus wall budgets for a
single-call fan-out. Progressive joins have no shared MCP request clock: their
group deadline uses only pinned provider limits and any truly shared wall budget;
the first member host ceiling NEVER shortens siblings. Each joined request
independently receives the smaller of group time and its own host time. Test
different member host ceilings, including the first member.

Pass remaining deadline time to every adapter and every retry; retry delays
consume the same budget. Apply consistently to server-arbiter and host-step peer
fan-outs. Single calls and sequential arbiter phases retain their own limits;
all phases still respect the overall consensus budget. A grouped panel/ask-one
fan-out needs the same pinned panel/deadline context, not independent ask-one
deadlines. Genuine upstream timeouts remain errors; do not restart an already
aborted request or automatically retry timeout failures.

For progressive fan-out, return a separate `fanoutId` from panel regardless of
logging mode; retain optional journal `runId` compatibility. Store an in-memory
context with the pinned panel/settings and a pending member map, scoped to that
server instance. Login approval happens before dispatch. Start the common
deadline once, when the first member begins its provider attempt; use the
longest limit of the pinned panel, not whichever members happened to arrive.
Each joined MCP request also obeys its own remaining host ceiling, which can
shorten its grant but never extend the group deadline.

Reject nonmembers, expired IDs, and duplicate dispatches (including concurrent
duplicates) without calling a provider twice. Calls arriving after the deadline
get an expired-group result. Missing members become not-dispatched at expiry;
they do not hold a completed fan-out open indefinitely. Unknown IDs after
restart are rejected without any provider dispatch. Close after all expected
members settle or the deadline expires. Undispatched contexts expire after a
bounded 10-minute idle period. On expiry, abort outstanding attempts and clear
state/timers; a late call cannot resurrect the group. Canceling one joined call
cancels only that member; group expiry or server shutdown cancels siblings.
Ungrouped ask-one retains single-call limits. Test partial dispatch, delayed
login/first dispatch, duplicate requests, missing/late members, logging disabled,
host ceilings per member, cancellation, shutdown and expiry cleanup.

Journal configured timeout, granted timeout, absolute deadline, and limiting
reason. For the screenshot's 5/8/10-minute limits, all three peers would receive
up to the same 10-minute deadline if outer budgets permit. This permits Gemini
and Grok to finish later; it cannot guarantee they will respond. Group cancellation, expiry and shutdown
must abort all outstanding calls and clear timers/listeners. Member cancellation
aborts only that member.

## 5. Compact labels and time display

Use one display helper for `openrouter:<alias>` -> `or:<alias>` across dashboard,
human-facing analyze reports, tool progress, and generated host render guidance.
Keep canonical provider IDs in config, persisted data and machine contracts;
never globally replace IDs in schemas or stored records.

Use whole seconds for durations >= 1 second (`2s`, `4m 02s`, `10:00` where the
existing clock style applies), retaining millisecond detail below 1 second.
Round consistently and normalize minute/hour carry. Apply to elapsed counters,
call chips, axes, cursor readouts, stats and tool summaries. Raw telemetry keeps
full millisecond precision.

## 6. Show effective ask and consensus effort

Create a shared resolver/introspection seam used by dispatch and health/config
reporting. Render separate Ask effort and Consensus effort columns for built-in
providers and OpenRouter aliases, with their effective defaults/overrides and
source. Keep membership indicators distinct. For Gemini's model-encoded effort,
show it only when resolution is supported; for CLI-owned/inherited values that
cannot be verified, label them inherited/unknown. Never claim a configured value
is an observed result. Historical runs display recorded dispatch settings and
returned effort independently when they differ.

## Clarifications from the seven-provider review

Cache keys include the prompt, developer instructions, tool/expert, context,
resolved generation settings and baseline config ID (a versioned semantic hash).
File-bearing requests bypass caching, including auto-attached grounding files.
Panel/routing changes alter the baseline config ID. No unresolved alias lookup
may happen after cache lookup. Reused opinions do not enter fresh agreement or
success quality denominators; report reuse separately.

Under `longest-peer`, configured provider limits are inputs to the maximum;
shorter limits are intentionally waived for that parallel batch. Outer host,
consensus and cancellation limits always win. `per-provider` retains individual
ceilings. Journal both configured and granted limits so the extension is visible.

Config IDs are full SHA-256 hashes of canonical versioned snapshots. Runtime,
activation and fan-out IDs are random UUIDs. Restarts create new runtime and
activation IDs and discard ephemeral groups; unknown/replayed group IDs fail
closed without provider dispatch. A config ID can recur across restarts.

History storage uses bounded atomic per-activation records (rather than an
unbounded shared JSONL file), in a trusted user-owned 0700 directory with 0600
files. Readers reject symlinks, oversized/malformed records, invalid IDs and
snapshot hashes; nested fields use the same allowlist as writers. Bound both
record count/bytes and in-memory fan-out count (at most 1000), with cleanup on
expiry and shutdown. No history is written when all telemetry modes are off;
runtime manifests require dashboard journaling specifically. Concurrent writers
use unique record names and atomic rename, without shared compaction races.

## Delivery and validation

1. Implement config identity and effective-settings resolution; add telemetry
   plumbing and backward-compatible record readers.
2. Implement config-aware analyze and journal aggregates, then API/UI filtering
   and historical run/config views.
3. Implement shared deadlines across all fan-out entry points and adapters.
4. Apply compact labels, time formatting, and separate effort columns.
5. Update canonical docs/schema/commands, regenerate host artifacts, and run
   focused tests plus typecheck, sync checks and the full required suite.

Tests should cover canonicalization, secret exclusion, semantic config changes,
restart-only pending changes, mid-run edits, A -> B -> A, concurrent runtimes,
legacy records, failed persistence, config/time intersections and bounded reads.
Use fake timers/providers to demonstrate a short-limit peer succeeding after
its old limit but before the common deadline, a hung peer aborting at that
deadline, retries staying inside it, and outer budgets/cancellation winning.
Cover effort precedence, canonical IDs versus display labels, and 999ms/1s/
59.9s/60s/hour boundaries. Inspect desktop/mobile Stats, historical config links,
filter refresh/races, and live timeline behavior through the T3 preview.

Consensus review should challenge snapshot truthfulness, cohort comparability,
timeout/cancellation semantics, compatibility and logging privacy before any
implementation begins.

## Consensus review history

First review: Gemini APPROVE; Codex REQUEST_CHANGES. Accepted all three Codex
issues: cache provenance, grouped fan-out lifecycle, and the dashboard's source
of active runtime settings. The additions above address each concern, with
explicit regression scenarios. Grok was unavailable (missing local credential);
four OpenRouter peers returned authentication errors and supplied no opinions.
Revised review: Codex and Gemini both APPROVE, with no critical issues. The
host-arbitrated loop converged and persisted session
`3e4ccb0f-8366-4b04-abc7-c9dbdf301aee` (loop
`24f6a71a-5a32-45d9-a52f-5d346ff049f5`). This is approval from the two responding
providers, not an endorsement from the unavailable/auth-failed providers.

The preliminary loop `7f01075b-54b1-4a41-bc48-17868baf289a` was superseded before
its next dispatch after the local review client mapped the revision to the
wrong field. The successful revised loop received the full updated plan and
the prior findings; no unchanged-plan second review was dispatched.

Seven-provider review: all seven configured providers answered successfully, including
DeepSeek, Qwen, Kimi and GLM through OpenRouter. Qwen's round-1 findings were
incorporated, along with Grok's deadline and cache clarifications. The local
client incorrectly mapped revisions during rounds 2-4, so those responses did
not review the intended revised text. Round 5 received the full correct revision
and all prior findings: Codex, Gemini, Grok and all four OpenRouter peers
unanimously APPROVE with no remaining issues. Loop
`fd682f38-a58e-4238-835c-6287bbac3205` converged; persisted session
`9f2d0298-c5a3-4527-b2ea-a62173e88e21`. The server's round-count-based confidence
field is low; this does not change the unanimous final-round votes. No configured
provider was unavailable in this review.
