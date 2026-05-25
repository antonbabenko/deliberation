# [1.11.0](https://github.com/antonbabenko/claude-delegator/compare/v1.10.0...v1.11.0) (2026-05-25)


### Features

* migrate Gemini bridge to Antigravity CLI (agy) + Gemini 3 ([#16](https://github.com/antonbabenko/claude-delegator/issues/16)) ([44b5cd2](https://github.com/antonbabenko/claude-delegator/commit/44b5cd26b52231c429b1d78e19cc684ccb14948e))



# [1.10.0](https://github.com/antonbabenko/claude-delegator/compare/v1.9.1...v1.10.0) (2026-05-25)


### Features

* **consensus:** arbiter-mediated bias hardening for /consensus + ask-* disclaimer ([#14](https://github.com/antonbabenko/claude-delegator/issues/14)) ([352902c](https://github.com/antonbabenko/claude-delegator/commit/352902c5806e620d4fe71c99aed705d77b5faea2))



## [1.9.1](https://github.com/antonbabenko/claude-delegator/compare/v1.9.0...v1.9.1) (2026-05-24)


### Bug Fixes

* harden release PR lookup against a closed release/next PR ([#11](https://github.com/antonbabenko/claude-delegator/issues/11)) ([e911185](https://github.com/antonbabenko/claude-delegator/commit/e911185f51ca4f32741aa02e10d8be7dbd53b47e))



# [1.9.0](https://github.com/antonbabenko/claude-delegator/compare/v1.6.0...v1.9.0) (2026-05-24)


### Features

* add automated release process and fix marketplace metadata ([#7](https://github.com/antonbabenko/claude-delegator/issues/7)) ([9bfdda2](https://github.com/antonbabenko/claude-delegator/commit/9bfdda2a1c777b6ea0f3d43ca446cc167e35ae01))
* add Grok (xAI) as a third delegation provider, with file support ([#6](https://github.com/antonbabenko/claude-delegator/issues/6)) ([0b0a5d7](https://github.com/antonbabenko/claude-delegator/commit/0b0a5d7ac439144a8f326f949d6843d2ce003e03))



# [1.6.0](https://github.com/antonbabenko/claude-delegator/compare/9533d4e43c98befba72e1171ea8cc74e4cc85852...v1.6.0) (2026-05-17)


### Bug Fixes

* add complete frontmatter to commands ([b0d86b6](https://github.com/antonbabenko/claude-delegator/commit/b0d86b62360e2798665f2b7fc5e5125bfab248c3))
* add package manager detection to configure.md ([9bb0b0f](https://github.com/antonbabenko/claude-delegator/commit/9bb0b0fbedffd21a1da114ff616d82693cb142dd))
* add rules cleanup to configure remove action ([1dd1d18](https://github.com/antonbabenko/claude-delegator/commit/1dd1d1872704a9bc46be97b293244a4237f98968))
* **bridge:** set settled flag in error handler; widen test timing bound ([6499cb6](https://github.com/antonbabenko/claude-delegator/commit/6499cb6a88c726a612a62a306382eab6b57b41d3))
* bust badge cache after repo made public ([7486d58](https://github.com/antonbabenko/claude-delegator/commit/7486d586f793e49d472934cd8e8526bd3a6bbc09))
* bust badge cache after repo made public ([214771f](https://github.com/antonbabenko/claude-delegator/commit/214771f1bbc89dcc24df727511a69788422aa944))
* correct codex auth check command ([645c202](https://github.com/antonbabenko/claude-delegator/commit/645c202b29ac5bdf930f2fd81265ab2ce57dacb3))
* correct install command (/plugin add, not marketplace) ([eec3663](https://github.com/antonbabenko/claude-delegator/commit/eec3663769127f1b0074ad2cd7b0dd937875e3a9))
* **marketplace:** bump catalogue version to 1.4.0 ([ffe77c7](https://github.com/antonbabenko/claude-delegator/commit/ffe77c726e9e2004b426f2df75859a3b750c01ca))
* remove Gemini from mcp-servers.example.json ([da942b1](https://github.com/antonbabenko/claude-delegator/commit/da942b1fea7c22ed9e7c70df5fbb6f86e99207b0))
* remove Gemini templates from delegation-format.md ([2dd0aad](https://github.com/antonbabenko/claude-delegator/commit/2dd0aad2c6597771a8837beaa9abd0fe83febe16))
* remove stale Gemini references from orchestration.md ([dbc6aa9](https://github.com/antonbabenko/claude-delegator/commit/dbc6aa94cfe93b0fd300dc1a17ebd211e8dba3d9))
* restore test scripts and vitest dependencies ([905a403](https://github.com/antonbabenko/claude-delegator/commit/905a4039b511bfee62248ecaea39011b789c86ce))
* standardize variable naming in providers.json ([ac3698f](https://github.com/antonbabenko/claude-delegator/commit/ac3698fa912f6e06f4a6f48c76c4a9a2b67e5cc7))
* update plugin.json for Codex-only setup ([137dd1e](https://github.com/antonbabenko/claude-delegator/commit/137dd1e4f714109938782fb34d246432df2004a3))
* use gpt-5.2-codex model explicitly ([6be6370](https://github.com/antonbabenko/claude-delegator/commit/6be63702c8514dd00d9c710a665a09a1e80ad780))


### Code Refactoring

* replace action-based roles with 5 domain experts ([06d7781](https://github.com/antonbabenko/claude-delegator/commit/06d77810b878e551db24244f0d999490309b3ff1))


### Features

* add Gemini support via zero-dependency MCP bridge ([#7](https://github.com/antonbabenko/claude-delegator/issues/7)) ([17600d5](https://github.com/antonbabenko/claude-delegator/commit/17600d5fbff5d1420c30604d78e3a07caab7effe))
* add include-directories parameter to gemini bridge ([653c3c3](https://github.com/antonbabenko/claude-delegator/commit/653c3c3f3e422a552af0a834bb7106ed2377cb8c))
* add marketplace.json for plugin distribution ([517ab16](https://github.com/antonbabenko/claude-delegator/commit/517ab1623999a10e66f732d55a29d7904a357548))
* add momus skill for plan validation ([dba32fa](https://github.com/antonbabenko/claude-delegator/commit/dba32fa74206b32643a293654c8d324394f3f065))
* add oracle skill for explicit invocation ([8b7f49b](https://github.com/antonbabenko/claude-delegator/commit/8b7f49b0ac1551c35fc5ad60e9695e22a19d3b4f))
* add star prompt to setup command ([b0c62ba](https://github.com/antonbabenko/claude-delegator/commit/b0c62ba4f3e13e77fc1980646d9443d1b4980634))
* add Worker role for task execution ([fb7a767](https://github.com/antonbabenko/claude-delegator/commit/fb7a767fc70b64f0333871c5db8e4a60af510b38))
* **bridge:** add skip-trust passthrough flag ([9bfa1f5](https://github.com/antonbabenko/claude-delegator/commit/9bfa1f5a808b082bfc6bbe99783e2cacb6778a78))
* **bridge:** add timeout with SIGTERM/SIGKILL escalation ([8bd8255](https://github.com/antonbabenko/claude-delegator/commit/8bd825572cf79ea4020b0ad5f739021bb1cfb6df))
* **bridge:** classify bridge-side errors with errorKind and retryable ([782ecf7](https://github.com/antonbabenko/claude-delegator/commit/782ecf792080826d152d869b3fe1bb3c6ae7f69c))
* **bridge:** read default model from GEMINI_DEFAULT_MODEL env ([8d96397](https://github.com/antonbabenko/claude-delegator/commit/8d96397b10a2e6bade2f40eeb91da38a07eb4933))
* **bridge:** recover disk-flushed Gemini answer on soft timeout ([#4](https://github.com/antonbabenko/claude-delegator/issues/4)) ([e98a5cc](https://github.com/antonbabenko/claude-delegator/commit/e98a5ccfa74aaad593cc26672f66f36d5d50882b))
* **bridge:** recover from Gemini trust check via structured signal + orchestrator retry ([#3](https://github.com/antonbabenko/claude-delegator/issues/3)) ([521cf28](https://github.com/antonbabenko/claude-delegator/commit/521cf288039e631dc235d6b95fd2f1988df1533f)), closes [#2](https://github.com/antonbabenko/claude-delegator/issues/2)
* **bridge:** replace greedy JSON regex with string-aware scanner ([5ec398c](https://github.com/antonbabenko/claude-delegator/commit/5ec398c4cfe6dc777c56f2a958484e6c9934cec8))
* bundle delegation commands; mark as maintained fork ([#5](https://github.com/antonbabenko/claude-delegator/issues/5)) ([fa5d671](https://github.com/antonbabenko/claude-delegator/commit/fa5d671c8ea0adf90b1c3482d590653e07dea756))
* enhance setup status report with diagnostic checks ([021135f](https://github.com/antonbabenko/claude-delegator/commit/021135f708f808b8a9b40d30362dfae822493de3))
* multi-turn persistence, config defaults, and gpt-5.3-codex update ([#6](https://github.com/antonbabenko/claude-delegator/issues/6)) ([f96a99f](https://github.com/antonbabenko/claude-delegator/commit/f96a99fc964ef7b74c84439e896696b8cddfa073))
* production readiness improvements ([9533d4e](https://github.com/antonbabenko/claude-delegator/commit/9533d4e43c98befba72e1171ea8cc74e4cc85852))


### BREAKING CHANGES

* Worker/Oracle/Momus replaced with domain experts

New experts (each can advise OR implement):
- Architect: system design, tradeoffs, complex debugging
- Plan Reviewer: plan validation before execution
- Scope Analyst: pre-planning, catching ambiguities
- Code Reviewer: code quality, bugs, security issues
- Security Analyst: vulnerabilities, threat modeling

Key changes:
- Sandbox (read-only/workspace-write) set per-task, not per-expert
- Stateless design documented (session IDs not exposed by Claude Code)
- Retry flow uses new calls with full error context
- Proactive/reactive delegation triggers updated

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>



