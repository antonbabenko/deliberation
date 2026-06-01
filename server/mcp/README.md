# deliberation-mcp

Get a second opinion from GPT, Gemini, Grok, and 400+ OpenRouter models - and let them
reach a cross-model **consensus** - from inside any MCP host (Claude Code, Cursor, Codex,
Kiro, VS Code, Windsurf, Zed, ...).

One model is a guess. Three that agree is a plan.

This is the standalone MCP server. For the Claude Code plugin, one-click install buttons,
and full docs, see the repo: **https://github.com/antonbabenko/deliberation**

## What it does

You stay the primary agent. When a task needs a second opinion or cross-model review, call
one of the tools below, read the result, and apply your own judgment. Seven expert personas
(architect, code reviewer, security analyst, and four more) shape the review. GPT and Gemini
can also implement changes; Grok and OpenRouter only advise.

## Install

Add the server to your MCP host (most hosts use the `mcpServers` key):

```json
{
  "mcpServers": {
    "deliberation": {
      "command": "npx",
      "args": ["-y", "@antonbabenko/deliberation-mcp"],
      "env": {
        "XAI_API_KEY": "xai-...",
        "OPENROUTER_API_KEY": "sk-or-v1-..."
      }
    }
  }
}
```

Per-host config location and key:

| Host | Config | Key |
|------|--------|-----|
| Claude Code | `claude mcp add deliberation -- npx -y @antonbabenko/deliberation-mcp` | `mcpServers` |
| Cursor | `~/.cursor/mcp.json` or project `.cursor/mcp.json` | `mcpServers` |
| Codex CLI | `~/.codex/config.toml` (e.g. `[mcp_servers.deliberation]`) | `mcp_servers` |
| Gemini CLI | `~/.gemini/settings.json` | `mcpServers` |
| VS Code | `.vscode/mcp.json` (each entry needs `"type": "stdio"`) | `servers` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | `mcpServers` |
| Zed | `settings.json` | `context_servers` |

## Provider setup

Set only the providers you use:

- **GPT** - install the Codex CLI and run `codex login` (keys are not read from `env` here).
- **Gemini** - install the Antigravity CLI (`agy`) and run it once to sign in.
- **Grok** - set `XAI_API_KEY` (https://console.x.ai).
- **OpenRouter** - set `OPENROUTER_API_KEY` and declare models in
  `~/.config/deliberation/config.json` (Windows: `%APPDATA%\deliberation\config.json`;
  override with `DELIBERATION_CONFIG`). OpenRouter is advisory-only.

A starter config writer ships as a bin:

```
npx -y --package @antonbabenko/deliberation-mcp deliberation-setup
```

It writes a starter `config.json` (never overwrites an existing one).

## Tools

- `ask-all` - one question to every configured provider in parallel; get each answer back
  independently (no cross-talk).
- `consensus` - run the full multi-round convergence loop with a provider arbiter (blind
  pass + peer review -> adjudicate -> revise) and return the converged verdict. Pass
  `synthesizeAlways: true` for a single synthesis pass instead of the loop (best for open
  questions), or `maxRounds` to cap the loop.
- `consensus-step` - drive the loop yourself as the arbiter, one action per call
  (`init` -> `record_blind` -> `dispatch_peers` -> `submit_adjudication` -> `submit_revision`).
- `ask-gpt` / `ask-gemini` / `ask-grok` / `ask-openrouter` - one question to one provider.
- Experts: `architect`, `plan-reviewer`, `scope-analyst`, `code-reviewer`,
  `security-analyst`, `researcher`, `debugger` - call directly, or pass `expert` on the
  fan-out tools to apply one persona to every delegate.
- Session tools (opt-in `sessions.persist`): `session-get`, `session-revisit`,
  `session-annotate`.

Every tool takes a `prompt` - give it full context (the goal, relevant code/paths, prior
attempts), since the experts do not share your session.

## How consensus stays honest

The orchestrator commits a blind verdict before seeing the panel, cannot reach consensus on
its own vote alone (at least one external must approve), and records a reason for every
dismissed issue. The loop stops on agreement or at `consensus.maxRounds` (default 5).

## More

Configuration reference, the Claude Code plugin, per-host guides, and architecture docs are
in the repo: **https://github.com/antonbabenko/deliberation**
(see `AGENTS.md` for the tool guide and `TECHNICAL.md` for the full config reference).

## License

MIT
