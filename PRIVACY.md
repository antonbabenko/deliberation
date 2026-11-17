# Privacy policy

Last updated: 2026-11-17

deliberation is an open-source MCP server and plugin that runs on your own machine. It
asks AI providers that you configure for a second opinion. This page lists what it sends,
where it sends it, and what it keeps on your disk.

## What deliberation sends, and where

When you ask for a review, deliberation sends your prompt, any files you attach, and any
repo files added by the orientation bundle only to the providers you have enabled in your
config:

- **OpenAI**, through the `codex` CLI on your machine. Codex runs in the current working
  directory and can read files there.
- **Google**, through the Antigravity CLI (`agy`) or the Gemini API, depending on how
  you configure it. Like Codex, `agy` runs in the current working directory and can read
  files there.
- **xAI**, through the xAI API (`https://api.x.ai/v1` by default, or `XAI_API_BASE`).
- **OpenRouter**, through the OpenRouter API. OpenRouter passes each request on to the
  vendor that serves the model you picked.
- **Ollama or LM Studio**, through their local API (`http://localhost:11434/v1` and
  `http://localhost:1234/v1` by default). With the default address, the request does not
  leave your machine. If you point `apiBase` at another host, it goes there.

Orientation bundle: by default, deliberation adds repo files from the current directory to
requests for Grok and OpenRouter: one of `AGENTS.md` or `CLAUDE.md`, manifest files such as
`package.json`, and `README.md`. The default limits are 6 files and 16000 bytes. Set
`orientation.enabled` to `false` to stop this.

Each vendor's own terms and privacy policy apply to what it receives:

- OpenAI: <https://openai.com/policies/privacy-policy/>
- Google: <https://policies.google.com/privacy> and the Gemini API terms at
  <https://ai.google.dev/gemini-api/terms>
- xAI: <https://x.ai/legal/privacy-policy>
- OpenRouter: <https://openrouter.ai/privacy>, plus the policy of the vendor it routes to

The `codex` and `agy` CLIs are separate programs. deliberation does not control what
they store on your machine; see their own documentation.

## No telemetry

deliberation sends nothing to its author. There is no telemetry, analytics, crash
reporting or update check. Its only network connections go to the providers listed
above, and to the local dashboard on `127.0.0.1` when you start it. If your host starts
deliberation with `npx`, npm downloads the package from the npm registry; that is npm's
connection, not deliberation's.

## What it stores on your machine

Paths below use the Linux and macOS defaults. `<cache>` is `$XDG_CACHE_HOME/deliberation`
or `~/.cache/deliberation`; on Windows it is `%LOCALAPPDATA%\deliberation`. The config
file is `~/.config/deliberation/config.json`, or `$XDG_CONFIG_HOME/deliberation/config.json`
when `XDG_CONFIG_HOME` is set (Windows: `%APPDATA%\deliberation\config.json`).

| What | Default | Where | Turned on by |
|------|---------|-------|--------------|
| Config file | Created by setup | `~/.config/deliberation/config.json`, or `DELIBERATION_CONFIG` | `/deliberation:setup`, or you create it |
| Session store | Off | `<cache>/sessions/<id>.json`, or `DELIBERATION_SESSIONS` | `sessions.persist: true` |
| Debug log | Off | `<cache>/debug.jsonl`, `debug.path`, or `DELIBERATION_DEBUG_LOG` | `debug.enabled: true` |
| Run journal (dashboard) | Off | `<cache>/runs/<runId>.jsonl`, or `DELIBERATION_RUNS` | `dashboard.enabled: true` |
| Config history | Off | `<cache>/history/` | `sessions.persist`, `debug.enabled` or `dashboard.enabled` |
| Dashboard state | Off | `<cache>/dashboard.json` and `<cache>/dashboard-open.html` | starting the dashboard |
| Grok upload cache | On when files are uploaded to Grok | `<cache>/grok-files.json`, or `DELIBERATION_CACHE` | uploading a file to Grok; `XAI_DISABLE_FILE_CACHE` turns it off |

What each one holds:

- **Session store**: the question, the paths of attached files, each provider's verdict,
  the synthesis and the critical issues of a consensus or ask-all run. With `sessions.captureText: true` it
  also keeps each provider's full response. Before writing, deliberation removes text that looks like a secret (common API key
  formats, private keys, JWTs, `key=value` secrets). This is best effort.
  Records are kept for 30 days and at most 200 records by default (`sessions.maxAgeDays`,
  `sessions.maxRecords`).
- **Debug log**: latency, token counts, reasoning effort and verdict outcomes. It never
  holds prompt or response text.
- **Run journal**: run and call metadata, including request sizes and the absolute path
  of the project you called it from. With `dashboard.capture: "content"` it also holds
  prompt and response text, secret-scrubbed and capped at 100 KB per field. Journals
  are kept for 30 days and at most 200 runs by default (`dashboard.maxAgeDays`,
  `dashboard.maxRuns`).
- **Config history**: the provider and model settings in effect, never prompts or keys.
- **Dashboard state**: the dashboard's process id, port and access token, removed when
  the dashboard stops.
- **Grok upload cache**: for each uploaded file, a content hash, a short hash of your
  API key, the API address, the file name and the xAI file id. It holds no file content.

deliberation creates the session store, run journal, config history, dashboard state and
Grok cache files with mode `0600`.

## The local dashboard

The dashboard is off by default. When you start it, it listens on `127.0.0.1` only,
checks that the `Host` and `Origin` headers name `127.0.0.1` or `localhost`, and needs a
random token that changes on every start. It is read-only and loads nothing from other
sites.

## Files uploaded to xAI

When you attach a file to a Grok request, it is uploaded to the xAI Files API by default
(`mode: "upload"`). Files sent with `mode: "inline"` are part of the request and are not
stored as files. An uploaded file stays on xAI until it expires or you delete it. deliberation
asks xAI to expire it after 7 days by default (`GROK_FILE_TTL_SECONDS`, from 1 hour to 30
days). To delete uploads sooner, run
`/deliberation:grok-files prune --older-than 1h --yes`. This deletes files uploaded more
than 1 hour ago whose names start with `deliberation-` (the prefix deliberation gives its
uploads) from the xAI account of your current `XAI_API_KEY`. Without `--yes` it only lists
them. `/deliberation:grok-files gc` removes local cache rows for files that no longer exist
on xAI.

## How to delete local data

Stop the dashboard if it is running, then delete the cache directory:

```bash
npx -y @antonbabenko/deliberation-mcp dashboard --stop
rm -rf ~/.cache/deliberation            # or $XDG_CACHE_HOME/deliberation
```

On Windows, delete `%LOCALAPPDATA%\deliberation`. To remove your settings as well,
delete `~/.config/deliberation` (Windows: `%APPDATA%\deliberation`). If you set
`DELIBERATION_SESSIONS`, `DELIBERATION_RUNS`, `DELIBERATION_DEBUG_LOG`, `debug.path` or
`DELIBERATION_CACHE`, delete those paths too.

## Contact

Questions or concerns: open an issue at
<https://github.com/antonbabenko/deliberation/issues>.
