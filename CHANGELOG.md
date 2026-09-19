## [3.15.0](https://github.com/antonbabenko/deliberation/compare/v3.14.11...v3.15.0) (2026-09-19)


### Features

* **codex:** log in on first use via device auth; recognize CODEX_ACCESS_TOKEN and rotated ChatGPT logins ([#198](https://github.com/antonbabenko/deliberation/issues/198)) ([b914dae](https://github.com/antonbabenko/deliberation/commit/b914dae1527cdff1590405625be6955a918a5e2b))

## [3.14.11](https://github.com/antonbabenko/deliberation/compare/v3.14.10...v3.14.11) (2026-09-18)


### Bug Fixes

* **codex:** prefer the ChatGPT login and never use OPENAI_API_KEY ([#196](https://github.com/antonbabenko/deliberation/issues/196)) ([0b57922](https://github.com/antonbabenko/deliberation/commit/0b5792248c09fed0d022f112cf9ce6f44e70a3db))

## [3.14.10](https://github.com/antonbabenko/deliberation/compare/v3.14.9...v3.14.10) (2026-09-16)


### Bug Fixes

* **plugin:** declare a 30-min per-server tool-call timeout so capped hosts stop killing calls at 60s ([#194](https://github.com/antonbabenko/deliberation/issues/194)) ([9cf2d8a](https://github.com/antonbabenko/deliberation/commit/9cf2d8a0387913e60600447f7d96788519eb6272))

## [3.14.9](https://github.com/antonbabenko/deliberation/compare/v3.14.8...v3.14.9) (2026-09-14)


### Bug Fixes

* make the plugin work under a host tool-call cap (Claude Code on the web) ([#192](https://github.com/antonbabenko/deliberation/issues/192)) ([bea2af5](https://github.com/antonbabenko/deliberation/commit/bea2af5c675756344993562fa3983e75aaee109d))

## [3.14.8](https://github.com/antonbabenko/deliberation/compare/v3.14.7...v3.14.8) (2026-09-11)


### Bug Fixes

* **consensus:** raise default maxWallMs to 30 min ([#190](https://github.com/antonbabenko/deliberation/issues/190)) ([c477c04](https://github.com/antonbabenko/deliberation/commit/c477c0483cdfe42c17ef04364c591265b529c105))

