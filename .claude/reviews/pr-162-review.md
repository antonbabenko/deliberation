# PR Review: #162 — feat(providers): pin Gemini and Grok models via config.json

**Reviewed**: 2026-07-27
**Author**: antonbabenko
**Branch**: feat/provider-model-config → master
**Decision**: REQUEST CHANGES → **RESOLVED** in follow-up commit

## Resolution status

| ID | Status | Fix |
|---|---|---|
| H1 | Fixed | M1b passes a blank `GEMINI_DEFAULT_MODEL` in the child env; suite verified green under a deliberately polluted environment |
| H2 | Fixed | `agySupportsModelFlag()` probes `agy --help` once and omits the flag with a stderr warning on older binaries; `fake-agy-nomodel.sh` + M1c cover the degradation path |
| M1 | Open | Still seeded in `config.default.json` (author's explicit request); see note below |
| M2 | Fixed | Composition root now hoists `geminiCfg` / `grokCfg` once, no double `getConfig()` and no mixed `&&`/`\|\|` |
| L1 | Partly addressed | `providers.grok.reasoningEffort` is read per call (no restart); the `model` pins remain start-time |

A third issue of the same class was caught during the follow-up: reading config
inside `resolveReasoningEffort` made the pure resolver machine-dependent and broke
the pre-existing G20 test. Config injection moved to the call sites (composition
root for the core adapter, handler for the bridge), keeping the resolver pure.

> Self-review caveat: this PR was authored in the same session that reviewed it. Findings below were verified by execution, not by re-reading intent.

## Summary

The config plumbing is sound and the `resolveProviders` projection fix is well covered. Two HIGH issues block merge: a test that fails whenever `GEMINI_DEFAULT_MODEL` is set in the environment (proven by running it), and an unconditional `--model` flag that breaks every Gemini call on `agy` older than 1.0.9 with no guard or fallback.

## Findings

### CRITICAL

None. No secrets, injection surface, or auth changes. The `--model` value is passed as a distinct `spawn` argv element (no shell), and `-p <prompt>` remains the tail so the `runGemini` splice invariant holds.

### HIGH

**H1 — `test/bridge.test.js` M1b fails when `GEMINI_DEFAULT_MODEL` is set (environment-dependent test)**

`server/gemini/index.js` computes `DEFAULT_MODEL = process.env.GEMINI_DEFAULT_MODEL || "auto-gemini-3"` at module load, and M1b asserts argv contains `auto-gemini-3`. The spawned bridge inherits the parent environment, and no test clears the var. Proven:

```
$ GEMINI_DEFAULT_MODEL="gemini-3.1-pro-low" node --test test/bridge.test.js
✖ M1b: absent model falls back to the pinned default, not settings.json
  actual:   'gemini-3.1-pro-low'
  expected: 'auto-gemini-3'
```

This is not hypothetical: `GROK_DEFAULT_MODEL=grok-4.5` is already set in this development environment, so the sibling variable being set is the normal case, not the exotic one. Any contributor or CI runner exporting `GEMINI_DEFAULT_MODEL` gets a red suite from an unrelated change.

*Fix*: pass a scrubbed env to `startBridge` for M1b (delete `GEMINI_DEFAULT_MODEL` from the child env), so the test pins the built-in constant rather than whatever the machine happens to export.

**H2 — Unconditional `--model` breaks `agy` < 1.0.9 with no version guard**

`buildAgyArgs` now always pushes `--model`. `agy`'s flag parser rejects unknown flags outright:

```
$ agy models --json
Error: flags provided but not defined: -json
```

Before this PR the bridge never passed `--model` (the removed comment said so explicitly: *"model is accepted but never reaches argv"*), so older `agy` installs worked. After it, every Gemini call on an older binary fails at argv parse. `TECHNICAL.md` states the requirement as prose but nothing enforces or degrades.

I could not install an older `agy` to reproduce directly, so this is inferred from the same binary's parser behavior on an unknown flag plus the prior code comment. The severity holds regardless: the change is unguarded either way.

*Fix*: `server/gemini/index.js:811` already runs `execFileSync(AGY_BIN, ["--help"])` for the health check. Capture that output once, detect `--model`, and skip the flag (or fail with an actionable "upgrade agy" message) when absent.

### MEDIUM

**M1 — Seeding a concrete `model` into `config.default.json` disables the env var for every new install**

`commands/setup.md:88` copies `config.default.json` to the user's config path, and this PR adds `"model": "grok-4.5"` / `"model": "auto-gemini-3"` there. Since precedence is config > env, `GROK_DEFAULT_MODEL` and `GEMINI_DEFAULT_MODEL` become dead for anyone who runs setup, which undercuts the PR's stated "configurable via both env var and config.json".

The values are identical to the built-ins so behavior does not change today, but the env lever is silently gone. Consider omitting the key from the seeded default (documenting it in `SETUP.md` only), so env stays live until the user opts into a pin.

**M2 — Precedence expression in the composition root is unclear and double-reads config**

`server/mcp/index.js`:

```js
model: (getConfig().providers && getConfig().providers.gemini || {}).model,
```

Mixed `&&`/`||` without parentheses parses correctly here (`(a && b) || {}`) but reads ambiguously, and `getConfig()` is invoked twice per provider. Prefer `getConfig()?.providers?.gemini?.model` with a single call.

### LOW

**L1 — `providers.*.model` is read once at startup while the `models` map hot-reloads**

The asymmetry is documented in code, `SETUP.md`, and the PR body, so this is a note rather than a defect. Reading it inside `ask()` (as the Grok bridge's `configuredModel()` already does via the stat-gated reader) would remove the restart requirement and make the two paths consistent.

## Verified as non-issues

- `runWithFiles` delegates to `runGrok`, so the config pin applies to file-bearing Grok calls too — no bypass.
- `configuredModel()` is wrapped in try/catch and returns `undefined` on any failure, falling through to env then built-in. No new throw path.
- Blank and non-string `model` values are dropped rather than forwarded as a bogus id (`PM3`).
- `openrouter` correctly ignores `providers.model` (`PM4`); its `models` map remains the selection owner.
- No circular import: `server/grok/index.js` requires `server/openrouter/config.js`, which does not require Grok.

## Validation Results

| Check | Result |
|---|---|
| Type check | Pass (`tsc` strict `checkJs` over `core/**` + `server/mcp/**`) |
| Lint | Skipped (no lint script in `package.json`) |
| Tests | Pass — 595 pass, 0 fail |
| Build | Skipped (no build step; `dist/` is a publish-time esbuild bundle) |
| Host-artifact drift | Pass (regenerated via `scripts/sync-hosts.js`) |

Note: the suite passes on this machine because `GEMINI_DEFAULT_MODEL` happens to be unset. See H1.

## Files Reviewed

| File | Change |
|---|---|
| `config/config.schema.json` | Modified — new `geminiProvider` def; `model` on `grokProvider` |
| `config/config.default.json` | Modified — seeded `model` keys (see M1) |
| `core/providers/antigravity.js` | Modified — default back to `auto-gemini-3` |
| `core/providers/grok.js` | Modified — default `grok-4.5` |
| `server/gemini/index.js` | Modified — `--model` wiring (see H2) |
| `server/grok/index.js` | Modified — config-aware `configuredModel()` |
| `server/mcp/index.js` | Modified — composition root wiring (see M2) |
| `server/mcp/setup.js` | Modified — STARTER_CONFIG keys |
| `server/openrouter/config.js` | Modified — `resolveProviders` carries `model` |
| `test/bridge.test.js` | Modified — M1 rewritten, M1b added (see H1) |
| `test/core-grok.test.js` | Modified — fixture ids |
| `test/openrouter-config.test.js` | Modified — PM1–PM4 added |
| `SETUP.md`, `TECHNICAL.md`, `rules/model-selection.md`, `commands/ask-{all,gemini,grok}.md` | Modified — docs |
