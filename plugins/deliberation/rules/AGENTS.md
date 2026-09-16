# AGENTS.md

Host-neutral guidance for any AI coding agent connected to the deliberation MCP
server.

## What deliberation is

A single MCP server that exposes GPT, Gemini, Grok, Ollama, LM Studio, and
OpenRouter models as expert subagents. Every tool here is ADVISORY: this server
reads and reasons, it never edits your files.

## Tools

- `ask-all` - send one question to configured models in parallel.
- `consensus` - run the FULL multi-round convergence loop server-side with a
  provider arbiter.
- `consensus-step` - drive the loop yourself as the arbiter.
- `panel` - return provider names `ask-all` would dispatch.
- `ask-one` - query a single provider from the panel.

## Mandatory Temporal Grounding & Live RAG Verification

Whenever queries, evaluations, reviews, or plans involve current dates, modern
versions, tools, foundation models, cloud offerings, or recent releases:

1. **Current Date Lookup**: Always establish the real-world date using a tool
   call (e.g., `date -u` via `run_command` or checking system metadata).
2. **Knowledge Cutoff Delta Check**: If the current date is 3+ months after the
   model's pre-training cutoff date, static weights MUST NOT be trusted as
   authoritative for model lineups, tool versions, or feature availability.
3. **Strict Prohibition on Unverified Negative Claims**: You are strictly
   FORBIDDEN from claiming or asserting that a model, tool, API, feature, or
   version is "hallucinated", "fictional", or "non-existent" without first
   performing live verification.
4. **Mandatory Live Tool Retrieval (RAG)**:
   - **AWS & Bedrock**: Use AWS MCP tools (`call_aws`, `suggest_aws_commands`,
     `search_cdk_documentation`, `search_cloudformation_documentation`) or
     AWS CLI to verify live service availability and model IDs.
   - **Web Search & Documentation**: Use `search_web` and `read_url_content`
     to retrieve official provider documentation, release notes, or pricing
     tables.
   - **Terraform / IaC**: Use Terraform MCP tools (`search_providers`,
     `get_latest_provider_version`, `get_provider_details`).
5. **Ground Deliberation Delegates**: When dispatching questions to
   deliberation subagents (`consensus`, `ask-all`, `ask-one`), inline the
   retrieved live facts directly into the delegation prompt so file-blind or
   cutoff-bound delegates do not fall victim to knowledge cutoff errors.
