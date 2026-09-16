---
name: consensus
description: Run the multi-round convergence loop (blind pass + peer fan-out -> adjudicate -> revise) with deliberation models. Converges only with cross-model agreement.
---

# Consensus (Arbiter-Mediated Convergence Loop)

Use this skill when refining a plan before execution, stress-testing an architectural decision, or reaching cross-model consensus across foundation models.

## Available Tools
- `consensus` (MCP `deliberation:consensus`): Executes the multi-round convergence loop server-side in a single call. Use `maxRounds` to override round cap (default 5). Pass `synthesizeAlways: true` for a single-pass synthesis on open-ended questions.
- `consensus-step` (MCP `deliberation:consensus-step`): Drive the loop step-by-step as the host arbiter (`init` -> `record_blind` -> `dispatch_peers` -> `submit_adjudication` -> `submit_revision`).

## Workflow
1. **Identify the Expert Persona**:
   - System design / tradeoffs: `architect`
   - Plan / execution feasibility: `plan-reviewer`
   - Code changes / diff review: `code-reviewer`
   - Security / threat modeling: `security-analyst`
   - Root-cause analysis: `debugger`
   - Requirements / ambiguities: `scope-analyst`
   - External libraries / best practices: `researcher`
2. **Execute Consensus**:
   - Provide complete context and constraints in `prompt`.
   - Set the `expert` persona.
   - For progressive host-mediated consensus, use `consensus-step` to commit a blind verdict first, then adjudicate peer concerns.
3. **Present Results**:
   - Report whether the panel converged, the confidence score, number of rounds, and list all resolved issues and any dissenting arguments.
