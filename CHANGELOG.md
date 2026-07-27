## [3.13.0](https://github.com/antonbabenko/deliberation/compare/v3.12.1...v3.13.0) (2026-07-27)


### Features

* **providers:** configurable timeouts, graceful rate-limit retry, non-answer detection ([#167](https://github.com/antonbabenko/deliberation/issues/167)) ([eccd3d0](https://github.com/antonbabenko/deliberation/commit/eccd3d0ff25e96764cc04ebd0ffd92292cd0ae4e))

## [3.12.1](https://github.com/antonbabenko/deliberation/compare/v3.12.0...v3.12.1) (2026-07-27)


### Bug Fixes

* **ci:** publish to npm on Node 24 and make a failed publish retryable ([#165](https://github.com/antonbabenko/deliberation/issues/165)) ([451eea7](https://github.com/antonbabenko/deliberation/commit/451eea788f9782439fc0c3318ed820f4d4f57f9b))

## [3.12.0](https://github.com/antonbabenko/deliberation/compare/v3.11.0...v3.12.0) (2026-07-27)


### Features

* **providers:** pin Gemini and Grok models via config.json ([#162](https://github.com/antonbabenko/deliberation/issues/162)) ([aff8026](https://github.com/antonbabenko/deliberation/commit/aff80263239e64390cdb3ee4dc12d8f81fed010d))

## [3.11.0](https://github.com/antonbabenko/deliberation/compare/v3.10.1...v3.11.0) (2026-06-26)


### Features

* **consensus:** bound worst-case wall-time without truncating slow-but-good responses ([#159](https://github.com/antonbabenko/deliberation/issues/159)) ([3073a9e](https://github.com/antonbabenko/deliberation/commit/3073a9e9acbde37dad31a40d17daaf53b2742fcd))

## [3.10.1](https://github.com/antonbabenko/deliberation/compare/v3.10.0...v3.10.1) (2026-06-23)


### Performance Improvements

* **consensus:** overlap arbiter adjudication and revision on dissent rounds ([#157](https://github.com/antonbabenko/deliberation/issues/157)) ([da18ab9](https://github.com/antonbabenko/deliberation/commit/da18ab9ba4bb795b552f94767e4577bc871a51a4))

