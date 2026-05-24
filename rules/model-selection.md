# Model Selection Guidelines

GPT (Codex), Gemini, and Grok (xAI) experts serve as specialized consultants for complex problems.

## Provider Selection

Before delegating, check which MCP tools are available in the current environment:

1. **If multiple are available**:
   - Use **Gemini** for tasks requiring large context or multimodal analysis.
   - Use **GPT (Codex)** when the user explicitly asks for "GPT" or "Codex".
   - Use **Grok (xAI)** when the user explicitly asks for "Grok". Grok is advisory-only (it cannot edit files), so never route file-editing / implementation tasks to it. It CAN read attached files (PDF/code/docs) via `files:[{path|file_id|file_url}]` on the `mcp__grok__grok` call.
   - Default to **Gemini** for general reasoning.
2. **If only one is available**: Use the available provider regardless of the task type (but Grok cannot implement file changes - only advise).
3. **If none are available**: Do not delegate; inform the user that they need to run `/claude-delegator:setup`.

## Expert Directory

| Expert | Specialty | Best For |
|--------|-----------|----------|
| **Architect** | System design | Architecture, tradeoffs, complex debugging |
| **Plan Reviewer** | Plan validation | Reviewing plans before execution |
| **Scope Analyst** | Requirements analysis | Catching ambiguities, pre-planning |
| **Code Reviewer** | Code quality | Code review, finding bugs |
| **Security Analyst** | Security | Vulnerabilities, threat modeling, hardening |

## Operating Modes

Every expert can operate in two modes:

| Mode | Sandbox | Approval | Use When |
|------|---------|----------|----------|
| **Advisory** | `read-only` | `on-request` | Analysis, recommendations, reviews |
| **Implementation** | `workspace-write` | `on-failure` | Making changes, fixing issues |

**Key principle**: The mode is determined by the task, not the expert. An Architect can implement architectural changes. A Security Analyst can fix vulnerabilities.

## Expert Details

### Architect

**Specialty**: System design, technical strategy, complex decision-making

**When to use**:
- System design decisions
- Database schema design
- API architecture
- Multi-service interactions
- After 2+ failed fix attempts
- Tradeoff analysis

**Philosophy**: Pragmatic minimalism—simplest solution that works.

**Output format**:
- Advisory: Bottom line, action plan, effort estimate
- Implementation: Summary, files modified, verification

### Plan Reviewer

**Specialty**: Plan validation, catching gaps and ambiguities

**When to use**:
- Before starting significant work
- After creating a work plan
- Before delegating to other agents

**Philosophy**: Ruthlessly critical—finds every gap before work begins.

**Output format**: APPROVE/REJECT with justification and criteria assessment

### Scope Analyst

**Specialty**: Pre-planning analysis, requirements clarification

**When to use**:
- Before planning unfamiliar work
- When requirements feel vague
- When multiple interpretations exist
- Before irreversible decisions

**Philosophy**: Surface problems before they derail work.

**Output format**: Intent classification, findings, questions, risks, recommendation

### Code Reviewer

**Specialty**: Code quality, bugs, maintainability

**When to use**:
- Before merging significant changes
- After implementing features (self-review)
- For security-sensitive changes

**Philosophy**: Review like you'll maintain it at 2 AM during an incident.

**Output format**:
- Advisory: Issues list with APPROVE/REQUEST CHANGES/REJECT
- Implementation: Issues fixed, files modified, verification

### Security Analyst

**Specialty**: Vulnerabilities, threat modeling, security hardening

**When to use**:
- Authentication/authorization changes
- Handling sensitive data
- New API endpoints
- Third-party integrations
- Periodic security audits

**Philosophy**: Attacker's mindset—find vulnerabilities before they do.

**Output format**:
- Advisory: Threat summary, vulnerabilities, risk rating
- Implementation: Vulnerabilities fixed, files modified, verification

## Codex Parameters Reference

### `mcp__codex__codex` (Start Session)

| Parameter | Values | Notes |
|-----------|--------|-------|
| `prompt` | string | **Required.** The delegation prompt (use 7-section format) |
| `developer-instructions` | string | Expert prompt injection (from `prompts/*.md`) |
| `sandbox` | `read-only`, `workspace-write`, `danger-full-access` | Controls file access. Default from `~/.codex/config.toml` |
| `approval-policy` | `untrusted`, `on-failure`, `on-request`, `never` | Controls shell command approval. Default from config |
| `model` | e.g. `gpt-5.3-codex` | Override the default model |
| `config` | key-value object | Override `config.toml` settings per-call |
| `cwd` | path | Working directory for the task |
| `base-instructions` | string | Override default system instructions |
| `compact-prompt` | string | Prompt used when compacting conversation |
| `profile` | string | Configuration profile from config.toml |

### `mcp__codex__codex-reply` (Continue Session)

| Parameter | Values | Notes |
|-----------|--------|-------|
| `threadId` | string | **Required.** Thread ID from previous `codex` call |
| `prompt` | string | **Required.** Follow-up instruction |

## Gemini Parameters Reference

### `mcp__gemini__gemini` (Start Session)

| Parameter | Values | Notes |
|-----------|--------|-------|
| `prompt` | string | **Required.** The delegation prompt (use 7-section format) |
| `developer-instructions` | string | Expert prompt injection (from `prompts/*.md`) |
| `sandbox` | `read-only`, `workspace-write` | Controls file access. |
| `model` | e.g. `gemini-2.5-pro`, `auto-gemini-3` | Override the default model |
| `cwd` | path | Working directory for the task |
| `include-directories` | string[] | Extra dirs to include alongside `cwd`. |
| `timeout` | number (ms) | Soft timeout. 1..600000. Default 300000. On expiry the bridge drains and recovers the disk-flushed answer. |
| `recovery-grace` | number (ms) | Extra drain budget after the soft timeout. 0..600000. Default 120000. 0 disables drain. |
| `skip-trust` | boolean | Pass `--skip-trust` to bypass the Gemini CLI trusted-directory check. Default `false`. Use to recover from `errorKind: "trust"` (see `orchestration.md` "Trust Failure Recovery"). |

### `mcp__gemini__gemini-reply` (Continue Session)

| Parameter | Values | Notes |
|-----------|--------|-------|
| `threadId` | string | **Required.** Thread ID from previous `gemini` call |
| `prompt` | string | **Required.** Follow-up instruction |
| `sandbox` | `read-only`, `workspace-write` | Controls file access. |
| `cwd` | path | Working directory for the task |
| `include-directories` | string[] | Extra dirs to include alongside `cwd`. |
| `timeout` | number (ms) | Soft timeout. 1..600000. Default 300000. On expiry the bridge drains and recovers the disk-flushed answer. |
| `recovery-grace` | number (ms) | Extra drain budget after the soft timeout. 0..600000. Default 120000. 0 disables drain. |
| `skip-trust` | boolean | Pass `--skip-trust` to bypass the Gemini CLI trusted-directory check. Default `false`. |

### Response Format (both providers)

Success:

| Field | Type | Description |
|-------|------|-------------|
| `threadId` | string | Session ID for multi-turn follow-ups |
| `content` | string | The expert's text response |
| `recovered` | boolean | Present and `true` when the answer was recovered from disk after a soft timeout (drain). Normal success - no special handling needed. |

Error (Gemini bridge only - bridge sets `isError: true` and adds these fields):

| Field | Type | Description |
|-------|------|-------------|
| `isError` | boolean | `true` on bridge-side failure. |
| `errorKind` | `timeout` \| `parse` \| `trust` \| `missing-cli` \| `upstream-abort` \| `unknown` | Machine-readable category. |
| `retryable` | boolean | `true` means the orchestrator may retry; see `orchestration.md`. |
| `hint` | `"skip-trust"` (when present) | Recovery action the orchestrator should apply on the next call. Only set today for `errorKind: "trust"`. |

## When NOT to Delegate

- Simple questions you can answer
- First attempt at any fix
- Trivial decisions
- Research tasks (use other tools)
- When user just wants quick info
