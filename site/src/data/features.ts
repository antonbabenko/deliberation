// The features page: every major feature and configuration option as sections of
// site-authored HTML. Defaults are read from config/config.default.json at build time, so
// a changed default changes the page and a removed key fails the build. Prose follows
// README.md, SETUP.md, PRIVACY.md and docs/tool-guide.md.
import { loadExperts } from '../lib/experts.ts'
import { REPO_ROOT, at, readRepoJson } from '../lib/repo.ts'

export interface FeatureSection {
  id: string
  title: string
  /** One line for the short list on the home page. */
  brief: string
  html: string
}

const DEFAULTS_FILE = 'config/config.default.json'
const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const c = (s: string): string => `<code>${s}</code>`

/** A table whose cells carry their column name, so it can stack on a phone. */
export const tbl = (caption: string, head: string[], rows: string[][]): string =>
  `<div class="tw"><table class="t"><caption>${caption}</caption><thead><tr>${head.map((h) => `<th scope="col">${h}</th>`).join('')}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((cell, i) => (i === 0 ? `<th scope="row" data-label="${head[0]}">${cell}</th>` : `<td data-label="${head[i]}">${cell}</td>`)).join('')}</tr>`)
    .join('')}</tbody></table></div>`

export function featureSections(): FeatureSection[] {
  const defaults = readRepoJson<Record<string, unknown>>(DEFAULTS_FILE)
  const raw = (key: string): unknown => at(defaults, key, DEFAULTS_FILE)
  /** The default of a config key, as code. */
  const d = (key: string): string => c(esc(JSON.stringify(raw(key))))
  const onOff = (key: string): string => (raw(key) ? 'on' : 'off')
  const experts = loadExperts(REPO_ROOT)
  const [exampleId, exampleRecord] = Object.entries(raw('models') as Record<string, unknown>)[0]
  const wallMin = Number(raw('consensus.maxWallMs')) / 60000

  const providers = [
    ['GPT', 'Codex CLI on your machine', c('codex login')],
    ['Gemini', `Gemini API (default), or the Antigravity CLI ${c('agy')} (opt-in)`, c('GEMINI_API_KEY')],
    ['Grok', 'xAI API', c(String(raw('providers.grok.apiKeyEnv')))],
    ['OpenRouter models', 'OpenRouter API. One key gives a built-in panel of three models from three vendors, all through one router', c(String(raw('providers.openrouter.apiKeyEnv')))],
    ['Local models', `Ollama or LM Studio on ${c('localhost')}`, 'no key by default'],
  ]

  return [
    {
      id: 'commands',
      title: 'Commands and tools',
      brief: 'Slash commands in Claude Code, MCP tools with the same names on every other host.',
      html: `
<p>In Claude Code you type slash commands. Every other host calls the MCP tool with the same name. All of them advise: the server reads and reasons, and it never edits your files.</p>
${tbl('Review commands', ['Command', 'MCP tool', 'What it does'], [
  [c('/deliberation:consensus'), `${c('consensus-step')}, ${c('consensus')}`, 'The full loop: blind verdict, panel review, adjudication and revision, round by round, until the panel agrees or the round cap is reached.'],
  [c('/deliberation:ask-all'), `${c('ask-all')}, or ${c('panel')} plus ${c('ask-one')}`, 'One question to every configured reviewer in parallel. The answers come back independently, with no cross-talk.'],
  [`${c('/deliberation:ask-gpt')}<br>${c('/deliberation:ask-gemini')}<br>${c('/deliberation:ask-grok')}<br>${c('/deliberation:ask-openrouter')}`, 'same names', 'One question to one provider for a single-shot second opinion.'],
])}
${tbl('Setup and upkeep commands', ['Command', 'What it does'], [
  [c('/deliberation:setup'), 'Configures the provider servers and the orchestration rules. One time.'],
  [c('/deliberation:help'), 'How to use Deliberation on your host, with example prompts to paste.'],
  [c('/deliberation:doctor'), 'Health check of config, provider CLIs and keys, sessions and debug flags, and path drift, with fixes. Read-only.'],
  [c('/deliberation:dashboard'), 'Starts the local read-only dashboard and prints its URL.'],
  [c('/deliberation:analyze'), 'Reads recent runs and suggests model, reasoning effort and fan-out changes. Advisory.'],
  [c('/deliberation:codex-login'), 'Logs GPT in on this machine with a ChatGPT device login: a link and a one-time code.'],
  [c('/deliberation:reload-mcp'), 'Cycles the dashboard process and audits the MCP processes after an update.'],
  [c('/deliberation:grok-files'), 'Lists, prunes or garbage-collects files uploaded to Grok.'],
  [c('/deliberation:uninstall'), 'Removes the MCP config, rules and aliases.'],
])}
<p>${c('panel')} returns the exact provider names a fan-out would call, without calling them. Providers that cannot answer right now are listed under ${c('unavailable')} with the reason and are skipped.</p>`,
    },
    {
      id: 'consensus',
      title: 'Consensus',
      brief: 'Blind verdict first, no self-approval, no silent dismissal. Round cap, quorum and arbiter are settings.',
      html: `
<p>${c('/deliberation:consensus')} is the heavy command. The host agent writes the review prompt, votes, and rules on objections, so the engine holds it to three rules.</p>
<ul class="rules">
<li><b>Blind verdict first.</b> The host agent records its own verdict before the panel is revealed. The engine does not reveal the panel until it is recorded.</li>
<li><b>No self-approval.</b> A round converges only when enough reviewers answered, every reviewer that answered approves, none rejects, no accepted issue is left open, and the host approves. The host's own vote cannot close a round.</li>
<li><b>No silent dismissal.</b> Every dismissed or deferred issue carries a written reason in the final report. The engine refuses an adjudication that dismisses an issue without one.</li>
</ul>
${tbl('Consensus settings, under the consensus key', ['Key', 'Default', 'What it controls'], [
  [c('maxRounds'), d('consensus.maxRounds'), `Rounds before the run ends as ${c('unresolved')}. 1 to 50.`],
  [c('quorumFloor'), d('consensus.quorumFloor'), `Reviewers that must answer for a round to count. Below it the run ends unresolved with ${c('stopReason')} ${c('quorum-lost')}.`],
  [c('blindVote'), d('consensus.blindVote'), `Adds a blind pre-vote by the arbiter in the server-side ${c('consensus')} tool, at the cost of one extra call. The host-driven loop always starts with a blind verdict.`],
  [c('arbiter'), d('consensus.arbiter'), `Who rules on the issues: the host agent, a provider, ${c('openrouter:&lt;alias&gt;')}, or a model record by id.`],
  [c('maxWallMs'), `${d('consensus.maxWallMs')} (${wallMin} min)`, `Wall-time budget of the server-side loop. It stops before the next round with ${c('stopReason')} ${c('budget-exhausted')} and never aborts a call in flight.`],
])}
<p>A reviewer that fails two rounds running is dropped from the panel and reported once under ${c('droppedProviders')}. The confidence label follows how fast the run settled: round 1 is high, rounds 2 and 3 are medium, rounds 4 and 5 are low.</p>
<p>Two entry points share the engine. ${c('consensus-step')} lets the host agent drive the loop as arbiter, one action per call: ${c('init')}, ${c('record_blind')}, ${c('dispatch_peers')}, ${c('submit_adjudication')}, ${c('submit_revision')}. ${c('consensus')} runs the whole loop server-side with a provider as arbiter.</p>`,
    },
    {
      id: 'providers',
      title: 'Providers and models',
      brief: 'GPT, Gemini, Grok, OpenRouter and local models. Any subset works; one OpenRouter key gives a three-vendor panel.',
      html: `
<p>You need at least one provider. Any subset works. Every provider advises; only Gemini can also implement, through the Antigravity CLI in the Claude Code plugin.</p>
${tbl('Providers', ['Provider', 'How it connects', 'You need'], providers)}
<h3 id="openrouter">OpenRouter built-in panel</h3>
<p>With ${c('OPENROUTER_API_KEY')} set and no model records of your own, three built-in records join ${c('ask-all')} and ${c('consensus')}: ${c('z-ai/glm-5.3-flashx')}, ${c('openai/gpt-6.1-sol')} and ${c('google/gemini-3.8-flash')}. All three calls go through one router. Declare your own records under ${c('models')} and they replace the built-in panel.</p>
<pre><code>${esc(JSON.stringify({ models: { [exampleId]: exampleRecord } }, null, 2))}</code></pre>
<h3 id="local">Local models</h3>
<p>Ollama and LM Studio need no key by default. Each has its own block, ${c('providers.ollama')} (default ${d('providers.ollama.apiBase')}) and ${c('providers.lmstudio')} (default ${d('providers.lmstudio.apiBase')}). Declare a model with ${c('provider: "ollama"')} or ${c('provider: "lmstudio"')}.</p>
<h3 id="gemini">Gemini: API key or agy</h3>
<p>With ${c('GEMINI_API_KEY')} set, every advisory Gemini call goes to the Gemini API, model ${c('providers.gemini.apiModel')} (default ${d('providers.gemini.apiModel')}). Without a key, Gemini falls back to the Antigravity CLI ${c('agy')}. ${c('providers.gemini.transport')} (default ${d('providers.gemini.transport')}) pins the choice: ${c('auto')}, ${c('api')} or ${c('agy')}.</p>
<p class="warn">Before choosing ${c('agy')}, read the Antigravity terms, section 6. They list using third-party software to access the service as a breach that may be grounds for suspension. Deliberation drives ${c('agy')} as third-party software. An API key avoids that.</p>
${tbl('Routing and timeouts', ['Key', 'Default', 'What it controls'], [
  [c('routing.maxFanout'), d('routing.maxFanout'), `How many OpenRouter models ${c('ask-all')} calls.`],
  [c('routing.timeoutPolicy'), d('routing.timeoutPolicy'), `Parallel reviewers share the longest selected limit. ${c('"per-provider"')} keeps each limit.`],
  [c('providers.defaults.timeout'), `${d('providers.defaults.timeout')} in the default config`, 'Per-call ceiling in ms for every provider at once.'],
  [c('providers.&lt;name&gt;.timeout'), 'unset', `Overrides the default for one provider. A model record's own ${c('timeout')} still wins.`],
  [c('providers.&lt;name&gt;.enabled'), `${d('providers.grok.enabled')}; OpenRouter ${d('providers.openrouter.enabled')} until a key is set up`, `${c('false')} turns the provider off. Fan-outs skip it and direct calls return ${c('errorKind')} ${c('"disabled"')}. Read per call, no restart.`],
])}`,
    },
    {
      id: 'experts',
      title: 'Experts',
      brief: `${experts.length} personas, each a prompt file. Call one as a tool or give the whole panel that role.`,
      html: `
<p>${experts.length} personas, each a prompt file in ${c('prompts/')}. Call one as a tool, or pass ${c('expert')} to a fan-out tool and every reviewer on the panel takes that role.</p>
${tbl('Expert personas', ['Expert', 'Tool', 'Used', 'Ask it'], experts.map((x) => [esc(x.name), c(x.key), esc(x.when), x.asks.map((a) => `"${esc(a)}"`).join('<br>')]))}
<p>Skip the experts for simple file operations, the first attempt at a fix, and questions your agent can answer directly.</p>`,
    },
    {
      id: 'dashboard',
      title: 'Dashboard',
      brief: 'An opt-in local page that draws each run as a capture, one lane per voice. Read-only, bound to 127.0.0.1.',
      html: `
<p>An opt-in local page that draws each run as a timeline with one lane per voice. It is read-only and never changes Deliberation state. Nothing is recorded until ${c('dashboard.enabled')} is ${c('true')}.</p>
${tbl('Dashboard views', ['View', 'What it shows'], [
  ['Live', 'The run in progress, one lane per voice on a shared time axis.'],
  ['Runs', 'Past runs with status, tool, tokens and duration. Open one for its rounds, per-provider latency and event table.'],
  ['Config', 'Provider health and the effective config after defaults.'],
  ['Stats', 'Latency and tokens per model, verdict agreement, runs per day.'],
  ['Analyzer', 'Models that agree more than they add, per-project failures and latency, request size against timeouts.'],
])}
${tbl('Dashboard settings, under the dashboard key', ['Key', 'Default', 'What it controls'], [
  [c('enabled'), d('dashboard.enabled'), 'Journals runs and allows the dashboard to start. Bound to 127.0.0.1 only.'],
  [c('capture'), d('dashboard.capture'), `${c('"metadata"')} journals run and verdict metadata only. ${c('"content"')} also journals prompts and responses, secret-scrubbed.`],
  [c('showPII'), d('dashboard.showPII'), 'The page redacts likely personal data in displayed content unless this is on. It does not change what is on disk.'],
  [c('port'), d('dashboard.port'), 'Local port. The printed URL carries a per-start token, the only credential.'],
  [c('maxRuns'), d('dashboard.maxRuns'), `Newest run journals kept. ${c('-1')} keeps all.`],
  [c('maxAgeDays'), d('dashboard.maxAgeDays'), `Days a run journal is kept. ${c('-1')} keeps all.`],
])}
<pre><code>npx -y @antonbabenko/deliberation-mcp dashboard
npx -y @antonbabenko/deliberation-mcp dashboard --stop</code></pre>`,
    },
    {
      id: 'sessions',
      title: 'Sessions',
      brief: 'Opt-in run history on disk: fetch a past run, run it again, annotate it.',
      html: `
<p>Opt-in run history on disk. With ${c('sessions.persist')} on, ${c('consensus')}, the host-driven loop and ${c('ask-all')} return a ${c('sessionId')}.</p>
${tbl('Session tools', ['Tool', 'What it does'], [
  [c('session-get'), 'Fetches a recorded run: opinions, verdict, annotations.'],
  [c('session-revisit'), 'Runs the recorded question again with the current providers and config, and saves a linked child record.'],
  [c('session-annotate'), "Appends a note to a run's audit trail."],
])}
${tbl('Session settings, under the sessions key', ['Key', 'Default', 'What it controls'], [
  [c('persist'), d('sessions.persist'), 'Writes one record per run. Off means nothing is written to disk.'],
  [c('captureText'), d('sessions.captureText'), "Also stores each provider's response body, secret-scrubbed. Off stores the question, verdicts and issue summaries only."],
  [c('maxRecords'), d('sessions.maxRecords'), `Newest records kept. ${c('-1')} keeps all.`],
  [c('maxAgeDays'), d('sessions.maxAgeDays'), `Days a record is kept. ${c('-1')} keeps all.`],
])}`,
    },
    {
      id: 'analyze',
      title: 'Analyze and doctor',
      brief: 'Tuning advice from your own runs, and a read-only health check. Neither calls a provider.',
      html: `
<p>${c('analyze')} reads the opt-in debug log and the session store and returns tuning advice. It writes nothing. Timing and agreement are reported side by side and are not joined.</p>
<ul>
<li>Timing: per-model p50, p95 and max latency over successful calls, mean tokens, error rate, reasoning effort. Needs ${c('debug.enabled')}.</li>
<li>Agreement: the verdict agreement rate per model, from the session store.</li>
<li>Advice: drop a slow or redundant model from ${c('ask-all')}, lower a model's reasoning effort, change ${c('routing.maxFanout')}.</li>
</ul>
<p>${c('doctor')} is a read-only health check. Each finding has a status (${c('ok')}, ${c('warn')}, ${c('fail')}, ${c('info')}), a message and, where one exists, a fix. It makes no provider call and starts no login. Run it first when a provider is missing from ${c('panel')}.</p>
<p>The debug log is off by default (${c('debug.enabled')}). It records one line per provider call and per consensus round, and never prompts, responses or issue descriptions.</p>`,
    },
    {
      id: 'privacy',
      title: 'Privacy defaults',
      brief: 'No telemetry, no update check. History, debug log and dashboard are off until you turn them on.',
      html: `
<p>Deliberation sends nothing to its author. There is no telemetry, analytics, crash reporting or update check. Your prompt, attached files and the orientation bundle go only to the providers you enabled.</p>
${tbl('What is on or off before you change anything', ['Setting', 'Default', 'Meaning'], [
  [c('sessions.persist'), onOff('sessions.persist'), 'No run history on disk.'],
  [c('sessions.captureText'), onOff('sessions.captureText'), 'No response bodies stored, even with history on.'],
  [c('debug.enabled'), 'off', 'No latency and token log.'],
  [c('dashboard.enabled'), onOff('dashboard.enabled'), 'No run journal, no local page.'],
  [c('dashboard.capture'), d('dashboard.capture'), 'With the dashboard on, prompts and responses are still not journaled.'],
  [c('orientation.enabled'), onOff('orientation.enabled'), `Up to ${raw('orientation.maxFiles')} repo files and ${raw('orientation.maxBytes')} bytes (one of ${c('AGENTS.md')} or ${c('CLAUDE.md')}, manifests, ${c('README.md')}) are added to requests for Grok and OpenRouter, which cannot read your files. Set it to ${c('false')} to stop this.`],
])}
<p>Each vendor's own terms apply to what it receives. The ${c('codex')} and ${c('agy')} CLIs run in the current directory and can read files there.</p>`,
    },
    {
      id: 'config',
      title: 'Config file',
      brief: 'One JSON file with a published schema. Most keys reload without a restart.',
      html: `
<p>One JSON file: ${c('~/.config/deliberation/config.json')} (Windows: ${c('%APPDATA%\\deliberation\\config.json')}). ${c('DELIBERATION_CONFIG')} overrides the path. Most keys hot-reload; timeouts and model pins are read once at server start.</p>
${tbl('Top-level sections', ['Section', 'Holds'], [
  [c('providers'), 'Connection settings per provider: enabled, key variable, endpoint, model, reasoning effort, timeout.'],
  [c('models'), 'Named model records for OpenRouter, Ollama and LM Studio, with their fan-out and consensus eligibility.'],
  [c('routing'), 'Fan-out cap and the timeout policy for parallel calls.'],
  [c('consensus'), 'Arbiter, round cap, quorum, blind vote, wall-time budget.'],
  [c('sessions'), 'Run history on disk.'],
  [c('debug'), 'Latency, token and voting log.'],
  [c('orientation'), 'The repo files sent to providers that cannot read your files.'],
  [c('dashboard'), 'The local read-only dashboard.'],
])}
<p>The quickest way to a working file is ${c('npx -y @antonbabenko/deliberation-mcp init')}: it finds your keys and CLI logins, writes the config, pings each provider and runs one short demo consensus. It never prints key values.</p>`,
    },
  ]
}
