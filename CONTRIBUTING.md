# Contributing to deliberation

Contributions welcome. This document covers how to contribute effectively.

---

## Quick Start

```bash
# Clone the repo
git clone https://github.com/antonbabenko/deliberation
cd deliberation

# Run `claude` and install plugin in Claude Code
claude
/deliberation:setup

# Or test your changes locally without reinstalling
claude --plugin-dir /path/to/deliberation
```

---

## What to Contribute

| Area | Examples |
|------|----------|
| **New Providers** | Ollama, Mistral, local model integrations |
| **Role Prompts** | New roles for `prompts/`, improved existing prompts |
| **Rules** | Better delegation triggers, model selection logic |
| **Bug Fixes** | Command issues, error messages |
| **Documentation** | README improvements, examples, troubleshooting |

---

## Project Structure

```
deliberation/
├── .claude-plugin/         # Plugin manifest
│   └── plugin.json
├── commands/               # Slash commands (/setup, /uninstall)
├── rules/                  # Orchestration logic (installed to ~/.claude/rules/)
├── prompts/                # Role prompts (oracle, momus)
├── config/                 # Provider registry
├── CLAUDE.md               # Development guidance for Claude Code
└── README.md               # User-facing docs
```

---

## Pull Request Process

### Before Submitting

1. **Test your changes** - Run `/deliberation:setup` and verify
2. **Update docs** - If you change behavior, update relevant docs
3. **Keep commits atomic** - One logical change per commit

### PR Guidelines

| Do | Don't |
|----|-------|
| Focus on one change | Bundle unrelated changes |
| Write clear commit messages | Leave vague descriptions |
| Test with actual MCP calls | Assume it works |
| Update CLAUDE.md if needed | Ignore developer docs |

### Commit Message Format

```
type: short description

Longer explanation if needed.
```

Types: `feat`, `fix`, `docs`, `refactor`, `chore`

Examples:
- `feat: add Ollama provider support`
- `fix: handle Codex timeout correctly`
- `docs: add troubleshooting for auth issues`

---

## Release Process

Releases are automated from [Conventional Commits](https://www.conventionalcommits.org/).
You never bump versions by hand.

1. Merge a PR to `master`.
2. The release workflow reads the commits since the last release and computes the next
   version (`feat:` -> minor, `fix:` -> patch, `feat!:` / `BREAKING CHANGE:` -> major).
3. It opens a `chore(release): vX.Y.Z` PR that updates `version.json`, `CHANGELOG.md`, and
   the synced manifests, then auto-merges it once the `validate` check passes.
4. On merge, a second workflow tags `vX.Y.Z` and publishes the GitHub Release.
5. The `antonbabenko/agent-plugins` marketplace then re-pins `deliberation` to the new
   release (immediately if its dispatch token is set, otherwise within a day via cron).

`version.json` is the single source of truth. `.claude-plugin/plugin.json`,
`.claude-plugin/marketplace.json`, and `package.json` are kept in sync by CI
(`.github/release/pre-commit.js`). Do not edit those version fields by hand - the `validate`
check fails if they drift.

---

## Adding a New Provider

1. **Check native MCP support** - If the CLI has `mcp-server` like Codex, no wrapper needed

2. **Create MCP wrapper** (if needed):
   ```
   servers/your-provider-mcp/
   ├── src/
   │   └── index.ts
   ├── package.json
   └── tsconfig.json
   ```

3. **Add to providers.json**:
   ```json
   {
     "your-provider": {
       "cli": "your-cli",
       "mcp": { ... },
       "roles": ["oracle"],
       "strengths": ["what it's good at"]
     }
   }
   ```

4. **Add role prompts** (optional):
   ```
   prompts/your-role.md
   ```

5. **Update setup command** - Add checks for the new CLI

6. **Document in README** - Add to provider tables

---

## Code Style

### Markdown (Rules/Prompts)

- Use tables for structured data
- Keep prompts concise and actionable
- Test with actual Claude Code usage

### TypeScript (if adding MCP servers)

- No `any` without explicit justification
- No `@ts-ignore` or `@ts-expect-error`
- Use explicit return types on exported functions

---

## Testing

### Manual Testing

After changes, verify with actual MCP calls:

1. Install the plugin in Claude Code
2. Run `/deliberation:setup`
3. Verify MCP tools are available (`mcp__deliberation-codex__codex`)
4. Test MCP tool calls via oracle delegation
5. Verify responses are properly synthesized
6. Test error cases (timeout, missing CLI)

---

## Questions?

Open an issue for:
- Feature requests
- Bug reports
- Documentation gaps
- Architecture discussions
