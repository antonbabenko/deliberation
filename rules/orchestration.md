# Model Orchestration

You have access to GPT experts via MCP tools. Use them strategically based on these guidelines.

## Available Tools

| Tool | Provider | Use For |
|------|----------|---------|
| `mcp__deliberation__ask-gpt` | GPT | One advisory delegation (single-shot; advisory-only, no multi-turn) |
| `mcp__deliberation-gemini__gemini` | Gemini | Start a new expert session |
| `mcp__deliberation-gemini__gemini-reply` | Gemini | Continue an existing session (multi-turn) |
| `mcp__deliberation-grok__grok` | Grok (xAI) | Start a new expert session (advisory-only; reads attached files) |
| `mcp__deliberation-grok__grok-reply` | Grok (xAI) | Continue a session (in-memory; lost on MCP restart) |
| `mcp__deliberation-openrouter__openrouter` | OpenRouter | Start a new advisory session (config-driven model alias) |
| `mcp__deliberation-openrouter__openrouter-reply` | OpenRouter | Continue a session (multi-turn via threadId) |
| `mcp__deliberation-openrouter__openrouter-list` | OpenRouter | List configured aliases and their eligibility flags |

> **GPT notes:** codex-cli ships no MCP server, so GPT has no dedicated bridge. It is reached through the unified `deliberation` server, which spawns `codex exec` itself. That path is advisory-only and single-shot: no `threadId`, no `-reply` tool, no `workspace-write`. The model comes from `~/.codex/config.toml` (`model` key) and cannot be overridden per call.

> **Grok notes:** the Grok bridge talks to the xAI HTTP API, so it is advisory-only (it cannot edit files). It reads attached files via `files:[{path|file_id|file_url}]` - attach referenced local files by default and set `cwd` to the repo root so paths resolve (a path outside `cwd` is refused). It needs `XAI_API_KEY`; a missing key surfaces `errorKind: "missing-auth"`.

> **OpenRouter notes:** the OpenRouter bridge is advisory-only (it cannot edit files). Models are declared as named records in the `models` map of `~/.config/deliberation/config.json` (Windows: `%APPDATA%\deliberation\config.json`; override with `DELIBERATION_CONFIG`), each keyed by an id and naming `provider: "openrouter"` + a model slug; they hot-reload without restarting. File attachment is text-inline only (`{path}`/`{dir}`; 256 KB per file, 1 MB aggregate). `/ask-all` fan-out is capped by `routing.maxFanout` (default 3); `/consensus` is uncapped (warn if >3 models). Implementation tasks must route to Gemini.

## Available Experts

| Expert | Specialty | Prompt File |
|--------|-----------|-------------|
| **Architect** | System design, tradeoffs, complex debugging | `${CLAUDE_PLUGIN_ROOT}/prompts/architect.md` |
| **Plan Reviewer** | Plan validation before execution | `${CLAUDE_PLUGIN_ROOT}/prompts/plan-reviewer.md` |
| **Scope Analyst** | Pre-planning, catching ambiguities | `${CLAUDE_PLUGIN_ROOT}/prompts/scope-analyst.md` |
| **Code Reviewer** | Code quality, bugs, security issues | `${CLAUDE_PLUGIN_ROOT}/prompts/code-reviewer.md` |
| **Security Analyst** | Vulnerabilities, threat modeling | `${CLAUDE_PLUGIN_ROOT}/prompts/security-analyst.md` |
| **Researcher** | External library and source research | `${CLAUDE_PLUGIN_ROOT}/prompts/researcher.md` |
| **Debugger** | Root-cause analysis, ranked hypotheses | `${CLAUDE_PLUGIN_ROOT}/prompts/debugger.md` |

---

## Session Management

There are two delegation patterns. GPT supports only the first.

### Single-Shot (Default)

Use `mcp__deliberation__ask-gpt` or `mcp__deliberation-gemini__gemini` for independent tasks. Each call starts a fresh session with no memory of previous calls. Include ALL relevant context in the delegation prompt.

**Best for:** Advisory reviews, one-off analysis, independent implementation tasks.

### Multi-Turn

Gemini, Grok, and OpenRouter support multi-turn interactions. The initial call returns a `threadId` in its response. Pass this to the corresponding `-reply` tool for follow-up turns with full context preservation. GPT does NOT: it has no `threadId` and no `-reply` tool, so a GPT follow-up is a fresh call carrying the full history in its prompt.

**A `threadId` does not carry permissions.** The Gemini bridge evaluates `sandbox` on EVERY call (`readOnly = args.sandbox !== "workspace-write"`), so a `gemini-reply` that omits it runs read-only no matter what the first turn was - the follow-up silently advises instead of editing. Resend `sandbox: "workspace-write"` and `cwd` on every reply that continues implementation work.

```typescript
// Turn 1: Start session (Gemini example)
const result = mcp__deliberation-gemini__gemini({
  prompt: "Implement input validation for the user endpoint",
  "developer-instructions": "[expert prompt]",
  sandbox: "workspace-write",
  cwd: "/path/to/project"
})
// result includes threadId: "019c58e5-..."

// Turn 2: Follow up with context preserved
mcp__deliberation-gemini__gemini-reply({
  threadId: "019c58e5-...",
  prompt: "Now add tests for the validation you just implemented",
  sandbox: "workspace-write", // NOT inherited from turn 1 - resend it or this turn is read-only
  cwd: "/path/to/project"
})
```

**Best for:** Chained implementation steps, iterative refinement, retry after failure.

| Pattern | Tool | Context | Use When |
|---------|------|---------|----------|
| Single-shot | `ask-gpt` / `gemini` / `grok` / `openrouter` | Fresh each call | Advisory, one-off tasks |
| Multi-turn | `*-reply` (not GPT) | Preserved via threadId | Chained steps, retries |

---

## PROACTIVE Delegation (Check on EVERY message)

Before handling any request, check if an expert would help:

| Signal | Expert |
|--------|--------|
| Architecture/design decision | Architect |
| 2+ failed fix attempts on same issue | Architect (fresh perspective) |
| "Review this plan", "validate approach" | Plan Reviewer |
| Vague/ambiguous requirements | Scope Analyst |
| "Review this code", "find issues" | Code Reviewer |
| Security concerns, "is this secure" | Security Analyst |
| "How do I use [library]", "best practice for", "find examples of" | Researcher (prefer GPT/Gemini) |
| "debug this", "why does this crash/fail", "track down the bug" | Debugger (prefer GPT/Gemini) |

**If a signal matches → delegate to the appropriate expert.**

---

## REACTIVE Delegation (Explicit User Request)

When user explicitly requests GPT/Codex, Gemini, Grok, or OpenRouter:

| User Says | Action |
|-----------|--------|
| "ask GPT", "consult GPT", "ask codex" | Identify task type → route to appropriate expert |
| "ask Gemini", "consult Gemini", "ask gemini" | Identify task type → route to appropriate expert |
| "ask Grok", "consult Grok", "ask grox" | Identify task type → route to appropriate expert |
| "ask OpenRouter", "use [alias]", "ask [alias]" | Advisory only - identify expert, call `mcp__deliberation-openrouter__openrouter` with the named alias |
| "ask GPT to review the architecture" | Delegate to Architect |
| "have Gemini review this code" | Delegate to Code Reviewer |
| "GPT security review" | Delegate to Security Analyst |

**Always honor explicit requests.**

---

## Delegation Flow (Step-by-Step)

When delegation is triggered:

### Step 1: Identify Expert
Match the task to the appropriate expert based on triggers.

### Step 2: Read Expert Prompt
**CRITICAL**: Read the expert's prompt file to get their system instructions:

```
Read ${CLAUDE_PLUGIN_ROOT}/prompts/[expert].md
```

For example, for Architect: `Read ${CLAUDE_PLUGIN_ROOT}/prompts/architect.md`

### Step 3: Determine Mode
| Task Type | Mode | Sandbox |
|-----------|------|---------|
| Analysis, review, recommendations | Advisory | `read-only` |
| Make changes, fix issues, implement | Implementation | `workspace-write` |

### Step 4: Notify User

Status line is owned by each command file (see ask-gpt.md, ask-gemini.md, ask-grok.md, ask-all.md, consensus.md). Commands print exactly one line immediately before the MCP tool dispatch:

- single-provider: `Codex working (typical 30-60s)...` or `Gemini working (typical 30-60s)...`
- parallel: a per-delegate status block (one line per dispatched delegate: provider, exact model, reasoning effort) instead of a single line - see `ask-all.md` / `consensus.md`.

This rule file no longer defines the wording. The command files are the source of truth.

### Step 5: Build Delegation Prompt
Use the 7-section format from `rules/delegation-format.md`.

**IMPORTANT:** For single-shot calls, include FULL context. For multi-turn, use the appropriate `*-reply` tool with the `threadId` from the initial call:
- What the user asked for
- Relevant code/files
- Any previous attempts and their results (for retries)

### Step 5.5: Concurrent prep, single dispatch

Emit independent prep reads CONCURRENTLY, then dispatch in ONE message. Expert
identification (Step 1) is *reasoning* on the request - it is not a tool read and happens
BEFORE the prep message. Then fire every independent prep read (the expert-prompt Glob,
plus any `~/.config/deliberation/config.json` / `~/.codex/config.toml` /
`~/.gemini/settings.json` / Grok env / `openrouter-list` reads a command needs) in ONE
message as parallel tool blocks. Build the prompt, status line/block, and delegate set
from those results, then dispatch all providers in ONE parallel message.

Two reads stay serial: (a) a read whose INPUT depends on another read's OUTPUT (a genuine
data dependency - e.g. `/ask-openrouter` must call `openrouter-list` before it can strip a
model alias from `$ARGUMENTS`, and the stripped question determines the expert, which
determines the Glob target); and (b) an interactive `AskUserQuestion` gate, which cannot
run concurrently with reads. Everything else is concurrent.

### Step 6: Call the Expert
```typescript
// Using GPT (advisory-only, single-shot - no sandbox parameter)
mcp__deliberation__ask-gpt({
  prompt: "[your 7-section delegation prompt with FULL context]",
  developerInstructions: "[contents of the expert's prompt file]",
  cwd: "[current working directory]"
})

// OR Using Gemini
mcp__deliberation-gemini__gemini({
  prompt: "[your 7-section delegation prompt with FULL context]",
  "developer-instructions": "[contents of the expert's prompt file]",
  sandbox: "[read-only or workspace-write based on mode]",
  cwd: "[current working directory]"
})

// OR Using OpenRouter (advisory-only; alias from config)
mcp__deliberation-openrouter__openrouter({
  prompt: "[your 7-section delegation prompt with FULL context]",
  "developer-instructions": "[contents of the expert's prompt file]",
  alias: "[model alias from ~/.config/deliberation/config.json]",
  cwd: "[current working directory]"
})
```

> GPT, Grok, and OpenRouter are advisory-only. Never set sandbox to `workspace-write` for them (`ask-gpt` and `openrouter` take no sandbox parameter at all). For implementation tasks, use Gemini.

### Step 7: Handle Response
1. **Synthesize** - Never show raw output directly
2. **Extract insights** - Key recommendations, issues, changes
3. **Apply judgment** - Experts can be wrong; evaluate critically
4. **Verify implementation** - For implementation mode, confirm changes work

---

## Retry Flow (Implementation Mode)

When implementation fails verification, use multi-turn to retry with preserved context:

```
Attempt 1 (initial call) → Verify → [Fail]
     ↓
Attempt 2 (*-reply with threadId + error details) → Verify → [Fail]
     ↓
Attempt 3 (*-reply with threadId + full error history) → Verify → [Fail]
     ↓
Escalate to user
```

### Retry with Multi-Turn

```typescript
// Attempt 1 (Gemini - GPT has no multi-turn; use the single-shot fallback below for it)
const result = mcp__deliberation-gemini__gemini({ ... })

// Attempt 2 (context preserved - expert remembers attempt 1)
mcp__deliberation-gemini__gemini-reply({
  threadId: result.threadId,
  prompt: `The previous implementation failed verification.
Error: [exact error message]
Fix the issue and verify the change works.`,
  sandbox: "workspace-write", // resend: the reply does not inherit turn 1's sandbox
  cwd: "/path/to/project"
})
```

### Retry with Single-Shot (Fallback)

If multi-turn is unavailable - always the case for GPT - use a new delegation call with full context:

```markdown
TASK: [Original task]

PREVIOUS ATTEMPT:
- What was done: [summary of changes made]
- Error encountered: [exact error message]
- Files modified: [list]

REQUIREMENTS:
- Fix the error from the previous attempt
- [Original requirements]
```

### Timeout Recovery (Gemini only)

The Gemini bridge has a **soft** timeout. On expiry it keeps agy alive past the soft
timeout, keeps buffering the streamed stdout, and returns `recovered: true` only if
agy completes cleanly within the grace budget (stdout-drain). A still-running process
at grace expiry is a timeout. Two outcomes:

- Success with `recovered: true` -> this is a **normal success**. Use `content`
  and `threadId` as usual. No retry, no special handling. (The `recovered` flag
  is informational only.)
- `errorKind: "timeout"` -> the drain did not complete within the grace budget. Still
  `retryable`. Retry as a fresh call; consider a larger `timeout` /
  `recovery-grace` for known-deep prompts.

Do not treat `recovered: true` as an error or re-issue the call.

---

## Example: Architecture Question

User: "What are the tradeoffs of Redis vs in-memory caching?"

**Step 1**: Signal matches "Architecture decision" → Architect

**Step 2**: Read `${CLAUDE_PLUGIN_ROOT}/prompts/architect.md`

**Step 3**: Advisory mode (question, not implementation) → `read-only`

**Step 4**: Print status line: `Gemini working (typical 30-60s)...` (or `Codex working (typical 30-60s)...` for GPT)

**Step 5-6**:
```typescript
mcp__deliberation__ask-gpt({
  prompt: `TASK: Analyze tradeoffs between Redis and in-memory caching for [context].
EXPECTED OUTCOME: Clear recommendation with rationale.
CONTEXT: [user's situation, full details]
...`,
  developerInstructions: "[contents of architect.md]"
})
```

**Step 7**: Synthesize response, add your assessment.

---

## Example: Retry After Failed Implementation

First attempt failed with "TypeError: Cannot read property 'x' of undefined"

**Attempt 1 (initial call):**
```typescript
const result = mcp__deliberation-gemini__gemini({
  prompt: `TASK: Add input validation to the user registration endpoint.

CONTEXT:
- Express 4.x application
- Body parser middleware exists in app.ts
- [relevant code snippets]

REQUIREMENTS:
- Add validation middleware to routes/auth.ts
- Ensure validation runs after body parser
- Report all files modified`,
  "developer-instructions": "[contents of code-reviewer.md]",
  sandbox: "workspace-write",
  cwd: "/path/to/project"
})
```

**Attempt 2 (retry via multi-turn):**
```typescript
mcp__deliberation-gemini__gemini-reply({
  threadId: result.threadId,
  prompt: `The previous implementation failed verification.
Error: TypeError: Cannot read property 'x' of undefined at line 45
The middleware was added but req.body was undefined.
Fix the issue - ensure validation runs after body parser.`,
  sandbox: "workspace-write", // resend: the reply does not inherit turn 1's sandbox
  cwd: "/path/to/project"
})
```

---

## Codex Configuration Defaults

`~/.codex/config.toml` is where GPT's **model** comes from - deliberation reads it from nowhere else and exposes no per-call override:

```toml
# ~/.codex/config.toml
model = "gpt-5.5"
```

The **sandbox is not yours to set here.** Every delegation runs `codex exec --sandbox read-only`, passed as argv on each call, so a `sandbox_mode = "workspace-write"` in this file cannot widen a deliberation run. That is deliberate: a writable global default must never turn an advisory second opinion into a write.

### Project Trust Levels

Codex also supports per-project trust configuration, which still applies to the `codex exec`
runs deliberation spawns:

```toml
[projects."/path/to/your/project"]
trust_level = "trusted"
```

Trusted projects skip Codex's own trust prompt. They do NOT widen the sandbox: the
`--sandbox read-only` argv above still bounds every deliberation run.

---

## Cost Awareness

- **Don't spam** - One well-structured delegation beats multiple vague ones
- **Include full context** - Saves retry costs from missing information
- **Reserve for high-value tasks** - Architecture, security, complex analysis

---

## Anti-Patterns

| Don't Do This | Do This Instead |
|---------------|-----------------|
| Delegate trivial questions | Answer directly |
| Show raw expert output | Synthesize and interpret |
| Delegate without reading prompt file | ALWAYS read and inject expert prompt |
| Skip status line before MCP dispatch | ALWAYS print status line (see command files for wording) |
| Retry without including error context | Include FULL history of what was tried |
| Assume expert remembers across sessions | Use the appropriate `*-reply` tool for multi-turn; include full context for single-shot |
| Serialize independent prep reads (Glob / config / list across separate turns) | Fire them in one parallel prep message, then dispatch (see Step 5.5) |
