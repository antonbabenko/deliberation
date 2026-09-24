## [3.17.0](https://github.com/antonbabenko/deliberation/compare/v3.16.1...v3.17.0) (2026-09-24)


### Features

* stamp the current UTC date and a no-denial rule into every delegate prompt ([#205](https://github.com/antonbabenko/deliberation/issues/205)) ([7e9262a](https://github.com/antonbabenko/deliberation/commit/7e9262abfbef2cd117bbd9dc81e20098a6dc3b59)), closes [#204](https://github.com/antonbabenko/deliberation/issues/204)

## [3.16.1](https://github.com/antonbabenko/deliberation/compare/v3.16.0...v3.16.1) (2026-09-20)


### Performance Improvements

* **codex:** show the device code in ~1s instead of after a 5-minute dialog wait ([#202](https://github.com/antonbabenko/deliberation/issues/202)) ([6b90229](https://github.com/antonbabenko/deliberation/commit/6b90229ace82112a0a54700f4d273f4b7fbfe215))

## [3.16.0](https://github.com/antonbabenko/deliberation/compare/v3.15.0...v3.16.0) (2026-09-20)


### Features

* **codex:** add a codex-login tool and /deliberation:codex-login so a login never depends on a GPT call ([#200](https://github.com/antonbabenko/deliberation/issues/200)) ([1062b1f](https://github.com/antonbabenko/deliberation/commit/1062b1fe3cb38bd5fa3d950bbc0284dd7f2d774a))

## [3.15.0](https://github.com/antonbabenko/deliberation/compare/v3.14.11...v3.15.0) (2026-09-19)


### Features

* **codex:** log in on first use via device auth; recognize CODEX_ACCESS_TOKEN and rotated ChatGPT logins ([#198](https://github.com/antonbabenko/deliberation/issues/198)) ([b914dae](https://github.com/antonbabenko/deliberation/commit/b914dae1527cdff1590405625be6955a918a5e2b))

## [3.14.11](https://github.com/antonbabenko/deliberation/compare/v3.14.10...v3.14.11) (2026-09-18)


### Bug Fixes

* **codex:** prefer the ChatGPT login and never use OPENAI_API_KEY ([#196](https://github.com/antonbabenko/deliberation/issues/196)) ([0b57922](https://github.com/antonbabenko/deliberation/commit/0b5792248c09fed0d022f112cf9ce6f44e70a3db))

