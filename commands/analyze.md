---
name: analyze
description: Analyze recent runs - per-model latency, tokens, and verdict agreement - and suggest model/reasoning/fanout tuning. Advisory, read-only.
allowed-tools: mcp__deliberation__analyze, Read
timeout: 60000
---

# Analyze (panel performance + value)

On-demand answer to "is my model panel pulling its weight?" Reads the opt-in
debug log (per-model latency, tokens, reasoning effort) and the session store
(verdict agreement), then renders a human report with tuning suggestions. It
writes nothing - every config change is yours to apply.

## Why this exists

In a parallel fan-out (`/ask-all`), wall-time is the SLOWEST model, not the
average - so one slow model that rarely says anything the others didn't sets the
clock for the whole command. This surfaces those, plus error-prone and
low-agreement models, from real measured data instead of guesswork.

## Two lenses (never joined)

The two data stores share no run id, so they are reported side by side and never
correlated by timestamp:

- **Lens A - timing/cost** (debug log): per provider+model p50/p95/max latency,
  mean tokens (HTTP providers only), error rate, reasoning effort seen.
- **Lens B - agreement** (sessions): how often a model's review verdict matched
  the run's final verdict. A model that is both slow (A) AND near-100% agreement
  (B) is the strongest cut candidate - presented as a candidate, not a fact.

## Workflow

1. **Call the tool** in ONE turn:
   ```
   mcp__deliberation__analyze({})
   ```
   Optional args: `sessions` (how many recent records to read for Lens B,
   default 50), `limitBytes` (debug-log tail size, default 1 MB).

2. **Handle "insufficient data".** If `meta.insufficientData` is true, the debug
   log is empty or off. Tell the user to enable it and re-run - do NOT invent
   numbers:
   ```
   No timing data yet. Enable it in ~/.config/deliberation/config.json:
     "debug": { "enabled": true }
   then run a few /ask-all or /consensus calls and re-run /deliberation:analyze.
   ```
   (Agreement (Lens B) additionally needs `sessions.persist: true`.)

3. **Render Lens A** - a table sorted slowest-p95 first:
   `provider | model | calls | p50 / p95 / max ms | mean tokens | errors | reasoning`.
   Add a one-line read of the slowest model and the panel's fast/slow spread.

4. **Render Lens B** (only if `agreement` is non-empty) - a table:
   `provider | model | votes | agreement % | abstained`, least-agreeing first.
   Note that abstain-only models (ask-all runs have no verdict) carry no signal.

   **When Lens B is empty, say WHY** (use the `meta` fields - do not guess):
   - `sessionsPersist` is false -> persistence is off; enable `sessions.persist: true`.
   - `sessionsPersist` true but `sessionsRead` is 0 -> the server read no records from
     `meta.sessionsDir`. Either nothing has run yet, OR the running server resolved a
     different sessions dir than where records were written (an `XDG_CACHE_HOME` /
     `DELIBERATION_SESSIONS` drift). Print `meta.sessionsDir` and point to
     `/deliberation:doctor`, which compares it to the shell-resolved path.
   - `sessionsRead` > 0 but `meta.agreementVotes` is 0 -> records exist but none carry a
     per-opinion verdict (they are old records or `ask-all` runs, which have no verdict).
     Tell the user to run a fresh `/consensus` to populate Lens B - the data is not lost,
     it just predates verdict capture / wasn't a consensus run.

5. **Render keep/cut candidates** from `outliers` + `recommendations`. For each
   recommendation print its `action` and `rationale`. Separate the two targets:
   - `target: "deliberation"` -> show the exact `config.json` edit
     (`configKey`), e.g. a copy-paste block the user can drop into
     `~/.config/deliberation/config.json`.
   - `target: "external"` -> Codex/Gemini reasoning lives OUTSIDE deliberation
     (`~/.codex/config.toml`, agy settings); surface it as advice, not an edit.

6. **Never apply anything.** Print the suggested edits; do not write the config.
   If the user then asks you to apply a specific deliberation-config change,
   that's a separate explicit step.

## Output shape

```
## Panel analysis (last <N> events, <M> sessions)

### Lens A - timing & cost
<table>
Slowest: <provider> p95 <x>ms. Fast tier: <...>.

### Lens B - verdict agreement
<table, or "no consensus runs recorded yet">

### Keep / cut candidates
- <provider>: <action> - <rationale>

### Suggested config edits (advisory - not applied)
~/.config/deliberation/config.json:
  <copy-paste block>
External (not deliberation config):
  <codex/gemini reasoning advice>
```

## Rules

- **Advisory only** - never write config; never auto-tune.
- **Honest about data** - if a lens is empty, say so; never fabricate latencies
  or agreement rates.
- **Two lenses stay separate** - do not claim a model is "slow because its
  answers were unique" or vice versa; the stores are not joined.
