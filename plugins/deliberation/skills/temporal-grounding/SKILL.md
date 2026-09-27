---
name: "temporal-grounding"
description: "Verify live facts and inline temporal context for time-sensitive questions."
---

# Temporal Grounding & Live Fact Retrieval

Use this skill when reviewing, planning, or delegating questions involving
current dates, modern versions, tools, foundation models, cloud offerings,
pricing, or recent releases.

## Purpose

Delegates in deliberation runs (`ask-all`, `consensus`, `ask-one`) cannot look
things up externally - Grok and OpenRouter run with no tools, and CLI models
rely on local knowledge. While deliberation automatically stamps today's UTC
date and a no-denial rule (`[unverified]`) into every delegate prompt, verifying
the actual facts is the host agent's responsibility.

This skill guides the host agent to verify live facts using available retrieval
tools before delegating, inlining them into the prompt with an as-of date and
source.

## When to Trigger

Trigger this skill whenever the task, prompt, or review involves:
- Claims about whether a tool, library, API, feature, or model exists.
- "Latest", "newest", "current", "recently released", or "up-to-date" versions.
- Pricing, quotas, rate limits, deprecations, or service roadmaps.
- Model lineups, reasoning tiers, or newly announced foundation model releases.

## Execution Workflow

### 1. Identify Time-Sensitive Claims
Determine what specific assertions, versions, or capabilities need live
verification rather than static training memory.

### 2. Retrieve Live Facts
Use whatever retrieval capabilities this host environment provides:
- **Web search & documentation**: Fetch provider release notes, changelogs,
  and official documentation via web search or URL fetch tools.
- **Domain MCP servers**: Query connected specialized MCP tools (e.g., cloud
  providers, package registries, infrastructure-as-code catalogs, or API
  inspectors) for live offerings and schemas.
- **Local CLI inspection**: Check installed tool versions via CLI commands
  when available.

### 3. Inline Facts into Delegation Prompt
Before calling deliberation tools (`ask-all`, `consensus`, `ask-one`), inline
the verified facts directly into the `prompt`:
- Explicitly state the **as-of date** (UTC) and the **source** (URL, CLI, or MCP
  result).
- Provide the exact version numbers, model IDs, or feature availability notes.
- This prevents delegates from anchoring on outdated training cutoffs or
  marking valid modern technologies as `[unverified]`.
