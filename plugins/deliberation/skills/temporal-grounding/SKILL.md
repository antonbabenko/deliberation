---
name: temporal-grounding
description: Mandatory verification skill for all scenarios whenever most-recent, up-to-date information is requested, including versions of tools, cloud services, and foundation models. Performs date check and live MCP/web search RAG to bridge knowledge cutoffs.
---

# Mandatory Temporal Grounding & Live RAG Verification

## Purpose
Enforce temporal grounding and eliminate false claims, hallucination false-positives, and outdated assumptions caused by static model training cutoffs.

## Mandatory Trigger Scenarios
This skill is **MANDATORY** in all scenarios where:
1. The user, prompt, or task asks for "most recent", "latest", "up to date", "current", "newest", "recently released", "state-of-the-art", "roadmap", or pricing/quotas.
2. Specific versions of tools, libraries, APIs, services, or foundation models are being evaluated or discussed (e.g., AWS Bedrock models, Claude 3.7 / 3.5, Amazon Nova, OpenAI models, Terraform providers, GitLab CI features).
3. The validity, existence, or availability of any tool, model, or cloud service offering is challenged or questioned.

## Required Execution Protocol

### Step 1: Real-World Date Lookup
- Run `date -u` via `run_command` or inspect the system timestamp metadata. Never assume the current year or month based on pre-training bias.

### Step 2: Knowledge Cutoff Delta Assessment
- If the current date is **3+ months after the model's pre-training cutoff**:
  - The model's internal memory regarding tool versions, model lineups, and service features MUST be treated as incomplete or outdated.
  - **STRICT PROHIBITION**: NEVER claim a model, API, tool, or version is "hallucinated", "fictional", or "non-existent" based solely on static knowledge.

### Step 3: Mandatory Live Tool Retrieval (RAG)
Before forming assertions or synthesizing reports, execute live tool queries:
1. **AWS & Cloud Services**:
   - Use AWS MCP tools (`call_aws`, `suggest_aws_commands`, `search_cdk_documentation`, `search_cloudformation_documentation`) or AWS CLI to verify actual live API offerings, model IDs, and features.
2. **Web Search & Documentation**:
   - Use `search_web` and `read_url_content` to fetch official provider documentation, release notes, and pricing matrices.
3. **Terraform & Infrastructure as Code**:
   - Use Terraform MCP tools (`search_providers`, `get_latest_provider_version`, `get_provider_details`).

### Step 4: Ground Deliberation Subagents
- When delegating to external deliberation models (`ask-all`, `consensus`, `ask-one`):
  - In-line the verified real-world facts, dates, and live documentation excerpts directly into the delegation `prompt`.
  - Do not rely on external models to know current dates or unreleased versions, as they may also be cutoff-bound or file-blind.
