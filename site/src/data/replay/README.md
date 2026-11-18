# Replay transcripts

Each JSON file here records one real Deliberation consensus run, so the home page can replay
it round by round without parsing prose. Text the providers or the engine returned is kept
verbatim; each file's `notes` field lists what was trimmed and which fields the host wrote.

The home page prerenders one run in full, the one named by `DEFAULT_RUN` in
`src/lib/runs.ts`. Every run is also built as an HTML fragment at `/runs/<id>/`, which the
run selector fetches from the same origin when that run is picked. Each run also gets its own readable page at `/sample-runs/<id>/`,
listed on `/sample-runs/`; `subject.title` is that page's title, so keep it plain.

## Shape

```text
id                    string   file slug, e.g. "pr-298"
recordedAt            string   ISO 8601 time the engine persisted the run
deliberationVersion   string   version.json at recording time
runId                 string   first 8 characters of the loop id
tool, expert          string   "consensus-step" and the peer persona key
question              string   the one-line question asked
subject               object   { type: "pull-request", url, commit, title } for a diff,
                               { type: "plan", related, title } for a plan (related = URL
                               of the issue, pull request or source file the plan builds on), or
                               { type: "question", related, title } for a question about
                               existing code or a request (related = URL of what it asks about).
                               short (optional, host-written): a few words for the run
                               selector and menu; title is used when it is absent
planUnderReview       string   the full init prompt sent to the panel (diff or plan v1)
panel[]               object   { provider, source, model, reasoningEffort, role: "peer" }
notOnPanel[]          object   { provider, reason } for providers that sat this run out
arbiter               object   { kind: "host" } - the host model adjudicates
limits                object   { maxRounds }
steps[]               object   { action, status, round } per consensus-step call, in order
rounds[]              object   see below
outcome               object   { verdict, converged, rounds, confidence,
                                 finalReportHeadline, openDissent[], nonBlockingThemes[] }
                               openDissent[{ source, issue }] lists the voices still holding
                               out when an unresolved run hit its cap; nonBlockingThemes[]
                               is [{ theme, raisedBy[] }]
notes[]               string   provenance and trimming notes
```

Each `rounds[]` entry:

```text
n                     number   round number, from 1
hostBlindVerdict      object   { verdict, summary, criticalIssues[], text } - committed
                               before the panel was revealed
peers[]               object   { source, provider, model, reasoningEffort, verdict,
                                 criticalIssues[{ id, category, text }], summary, text, ms }
                               summary is null when the reply has no summary block or line.
                               A voice that errored also has { isError: true, errorKind,
                               message }, with verdict, summary and text null; it does not
                               count toward convergence and has no issues to rule on
roundMs, slowest      number / string   wall time of the round (its slowest voice)
adjudication[]        object   { issueId, source, decision: accept|dismiss|defer, reason }
hostVerdict           string   APPROVE | REQUEST_CHANGES | REJECT after adjudication
revision              string|null   revised plan sent to the next round, null if none; on
                                    the last round of an unresolved run it is the plan the
                                    host submitted at the cap, which no reviewer saw
revisionSummary       string|null   the one-line diffSummary sent with that revision
                                    (optional; absent when a run had no revision)
convergence           object   { converged, reason }
```

`verdict` values are the engine's tokens: `APPROVE`, `REQUEST_CHANGES`, `REJECT`. `source`
is `grok`, `codex`, `gemini`, or `openrouter:<alias>`. A peer can vote `APPROVE` and still
list critical issues; the host must rule on every one of them in `adjudication`.

## Recovered runs

A run rebuilt after the fact from an earlier session, rather than recorded for this page,
has `provenance: "recovered"` at the top level, and its `notes` name the sources (session
transcript, persisted session record, run journal) and say how `deliberationVersion` was
established. Fields that could not be recovered verbatim are null or left out, never filled in:

```text
provenance            string   "recovered"; absent on runs recorded for this page
peers[].text          null     also for a voice that answered, when only its verdict and
peers[].summary                issue lines survived (engines before run journals persisted
                               full replies for the final round only)
adjudication[]        object   engines up to 4.0.x took rulings by { source, category,
                               description } instead of an issue id, so an entry has
                               issueId null and also carries category and description as
                               the host wrote them; source is kept as written ("claude" is
                               the host, a comma list merges one issue from several voices)
runId                 null     the loop id was not kept
hostBlindVerdict      null     the host's blind verdict for that round was not kept. The
                               pages print "not recorded" and draw an empty dotted mark
peers[].verdict       null     with no isError: the call returned, but no verdict survives
                               (or the engine read none from the reply). Often only ms is
                               known. Such a voice is "not recorded": it is not a vote and
                               not a failed call, and tallies count it apart from both
adjudicationRecovered false    the host ruled on the round but its rulings were not kept,
                               so adjudication is []. Without this flag an empty list
                               means no reviewer listed a critical issue
acceptedIssues        number   with adjudicationRecovered false: how many critical issues
                               the host accepted, when only that count survives
```

A file with any of these gaps needs no special place: the pages read every JSON file in this
folder and show each gap in words. Its `notes` must still list what is missing and why.
