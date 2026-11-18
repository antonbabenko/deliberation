// Site-authored copy. Facts come from README.md, SETUP.md, docs/hosts/ and
// docs/tool-guide.md; anything that can be read from a repository file at build time is
// read there instead (experts, config defaults, recorded runs).

// Pinned. Used verbatim on every surface; never add a second tagline.
export const TAGLINE = ['A second opinion from other models before you ship.', 'Any host, any vendor, one verdict, and the disagreement stays visible.']

export const WHAT =
  'An MCP server and agent plugin for Claude Code, Codex, Cursor, Kiro, Gemini CLI, Antigravity and OpenCode. It sends your agent\'s plan or diff to models from other vendors and brings back one verdict.'

export const LIMITS =
  'Consensus can be wrong: several models can share one blind spot. Deliberation advises and shows the dissent. It is not a CI gate or a correctness certificate, and the final call stays with a human.'

export const LOGO_STORY =
  'The mark is three reviewer lines bent into a D: two meet at the verdict dot, the third ends before it, and that gap is the dissent.'

export interface HostStep {
  title: string
  cmd?: string
  /** HTML, site-authored. */
  text?: string
}

export interface Host {
  id: string
  name: string
  /** One copyable install string, when the host has one. */
  cmd?: string
  /** HTML, site-authored. */
  note?: string
  /** Route slug of the host's own page under /hosts/, for what is not an install step. */
  guide?: string
  /** The install steps, shown once: on the install page. Host pages link there. */
  steps: HostStep[]
}

const CURSOR_INSTALL =
  'https://cursor.com/en-US/install-mcp?name=deliberation&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBhbnRvbmJhYmVua28vZGVsaWJlcmF0aW9uLW1jcCJdfQ=='

const README = 'https://github.com/antonbabenko/deliberation/blob/master/README.md'

const OPENCODE_JSON = `{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "deliberation": {
      "type": "local",
      "command": ["npx", "-y", "@antonbabenko/deliberation-mcp"],
      "enabled": true,
      "environment": {}
    }
  }
}`

const MCP_JSON = `{
  "mcpServers": {
    "deliberation": {
      "command": "npx",
      "args": ["-y", "@antonbabenko/deliberation-mcp"]
    }
  }
}`

// Facts per host come from README.md "Install" and docs/hosts/<id>.md.
export const HOSTS: Host[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    cmd: '/plugin marketplace add antonbabenko/agent-plugins\n/plugin install deliberation@antonbabenko\n/deliberation:setup',
    steps: [
      { title: 'Add the marketplace', cmd: '/plugin marketplace add antonbabenko/agent-plugins' },
      { title: 'Install the plugin', cmd: '/plugin install deliberation@antonbabenko', text: 'The plugin manifest registers the MCP servers, so they load on start and stay current across updates.' },
      { title: 'Run setup', cmd: '/deliberation:setup', text: 'A one-time step. It runs <code>init</code> (below) and finds the providers you already have.' },
      { title: 'Update later', cmd: '/plugin marketplace update antonbabenko\n/deliberation:reload-mcp\n/reload-plugins', text: 'Pulls the new version, recycles the dashboard and reconnects the MCP servers. Restarting Claude Code works too.' },
    ],
  },
  {
    id: 'codex',
    name: 'Codex CLI',
    cmd: 'codex plugin marketplace add antonbabenko/deliberation',
    note: 'Then install Deliberation from <code>/plugins</code>.',
    guide: 'hosts/codex',
    steps: [
      { title: 'Add the marketplace', cmd: 'codex plugin marketplace add antonbabenko/deliberation' },
      { title: 'Install the plugin', text: 'Open <code>/plugins</code> inside Codex and install <b>Deliberation</b>. The plugin starts the server with <code>npx -y @antonbabenko/deliberation-mcp</code>.' },
    ],
  },
  {
    id: 'cursor',
    name: 'Cursor',
    note: `Use the <a href="${CURSOR_INSTALL}">Install in Cursor</a> link, then copy <code>.cursor/rules/deliberation.mdc</code> into your project.`,
    guide: 'hosts/cursor',
    steps: [
      { title: 'Add the MCP server', text: `Use the <a href="${CURSOR_INSTALL}">Install in Cursor</a> link. It cannot carry provider keys, so set them in your environment.` },
      { title: 'Add the rule', text: 'Copy <code>.cursor/rules/deliberation.mdc</code> from the repository into your project\'s <code>.cursor/rules/</code>. The rule tells Cursor when to call the experts.' },
    ],
  },
  {
    id: 'kiro',
    name: 'Kiro',
    cmd: 'https://github.com/antonbabenko/deliberation',
    note: 'Choose "Add power from GitHub" and paste the repository URL.',
    guide: 'hosts/kiro',
    steps: [
      { title: 'Choose "Add power from GitHub" and paste the repository URL', cmd: 'https://github.com/antonbabenko/deliberation', text: 'Kiro reads <code>plugin.json</code>, registers the MCP server from <code>mcp.json</code> and loads the steering files.' },
    ],
  },
  {
    id: 'gemini-cli',
    name: 'Gemini CLI',
    cmd: 'gemini extensions install https://github.com/antonbabenko/deliberation',
    guide: 'hosts/gemini-cli',
    steps: [
      { title: 'Install the extension', cmd: 'gemini extensions install https://github.com/antonbabenko/deliberation', text: 'Add <code>--ref v&lt;version&gt;</code> to pin a release, then restart Gemini CLI. The extension needs <code>node</code> on <code>PATH</code>.' },
      { title: 'Check the server', cmd: 'gemini extensions list\ngemini mcp list', text: 'The <code>deliberation</code> server should show <code>Connected</code>. Gemini CLI starts stdio MCP servers only in trusted folders.' },
    ],
  },
  {
    id: 'antigravity',
    name: 'Antigravity',
    note: 'Copy <code>.agents/skills/</code> and <code>.agents/mcp.json</code> from the repository into your project\'s <code>.agents/</code> folder.',
    guide: 'hosts/antigravity',
    steps: [
      {
        title: 'Copy the skills and the MCP config into your project',
        cmd: 'git clone --depth 1 https://github.com/antonbabenko/deliberation /tmp/deliberation\nmkdir -p .agents && cp -R /tmp/deliberation/.agents/skills /tmp/deliberation/.agents/mcp.json .agents/',
        text: 'Run it in your project root. It puts <code>.agents/skills/</code> and <code>.agents/mcp.json</code> into your project\'s <code>.agents/</code>.',
      },
    ],
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    note: 'Add the server to <code>opencode.json</code>, then copy <code>.opencode/commands/</code> and <code>.opencode/agents/</code> into your project.',
    guide: 'hosts/opencode',
    steps: [
      { title: 'Register the MCP server in opencode.json', cmd: OPENCODE_JSON, text: 'The file sits at the project root, not inside <code>.opencode/</code>. Provider keys come from the environment OpenCode starts the server in.' },
      { title: 'Copy the commands and agents', text: 'Copy <code>.opencode/commands/</code> and <code>.opencode/agents/</code> from the repository into your project. The file name becomes the command or agent name.' },
    ],
  },
  {
    id: 'any',
    name: 'Any MCP host',
    cmd: 'npx -y @antonbabenko/deliberation-mcp init',
    note: 'Finds your keys and CLI logins, writes the config, runs a demo consensus and prints the install line for your host.',
    steps: [
      {
        title: 'Add the server to your host\'s MCP config',
        cmd: MCP_JSON,
        text: `Most hosts use the <code>mcpServers</code> key. VS Code uses <code>servers</code> and needs <code>"type": "stdio"</code>, Zed uses <code>context_servers</code>, and Codex CLI reads TOML. The README lists <a href="${README}#alternative-use-deliberation-mcp-server-standalone-works-with-any-agents">the config file of each host</a> and how to <a href="${README}#run-in-docker">run the server in Docker</a>.`,
      },
    ],
  },
]

export const STEPS = [
  { name: 'You ask', act: '/deliberation:consensus', text: 'Give your agent a plan or a diff and ask for a review before it ships.' },
  { name: 'Your agent seals its own verdict', act: 'record_blind', text: 'Before it sees any reviewer, the host agent records its own verdict. The engine does not reveal the panel until that verdict is recorded.' },
  { name: 'Other models review the same plan', act: 'dispatch_peers', text: 'The plan goes to every reviewer in parallel. Each one answers independently with a verdict and a list of critical issues.' },
  { name: 'Disagreements are argued round by round', act: 'submit_adjudication', text: 'Your agent rules on every issue: accept, dismiss or defer. A dismissal needs a written reason. Accepted issues become a revised plan and a new round.' },
  { name: 'One verdict, with the dissent kept', act: 'converged', text: 'The run closes only when enough reviewers answered and every one of them approves. Dismissed and deferred issues stay in the report with their reasons.' },
]
