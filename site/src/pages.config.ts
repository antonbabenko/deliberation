// The one place that maps site routes to the repo's own Markdown.
//
// Every page is rendered at build time from a file in the repository root (never a
// copy under site/). Change the page list here; routes, nav, sitemap, llms.txt and
// link rewriting all follow from it. When you map a new source file, add it to the
// `paths` lists in .github/workflows/site.yml too, so edits to it rebuild the site.
//
// Fields:
//   slug         route under the site base ('' is the home page). For `glob` entries
//                it is the prefix; each file adds '/<basename>' (README.md maps to
//                the prefix itself).
//   source       repo-relative Markdown file, or a glob like 'docs/hosts/*.md'.
//   sections     optional H2 anchor ids to keep, in source order. '_intro' is the
//                text before the first H2. Omit to render the whole file.
//   splitByH2    render the intro at `slug` and every H2 as its own sub-page at
//                `slug/<h2-anchor>`. For long files such as TECHNICAL.md.
//   placeholder  no source yet: render this Markdown instead.
//   releases     changelog page: GitHub Releases at build time, `source` as fallback.
//   title / description   page metadata; for glob and split pages the H1/H2 text
//                is used as the title when none is given.
//   nav          label in the header nav; omit to leave the page out of the nav.
//   group        section heading in llms.txt.

export interface PageDef {
  slug: string
  source?: string
  sections?: string[]
  splitByH2?: boolean
  placeholder?: string
  releases?: boolean
  title?: string
  description: string
  nav?: string
  group: string
}

export const site = {
  name: 'Deliberation',
  summary:
    'A second opinion for coding agents: an MCP server and agent plugin for Claude Code, Codex, Cursor, Kiro, Gemini CLI, Antigravity and OpenCode. GPT, Gemini, Grok, local and OpenRouter models review the same plan independently, and it reports one verdict with the dissent kept visible.',
  repo: 'antonbabenko/deliberation',
  branch: 'master',
  ogImage: 'og.png',
}

export const pages: PageDef[] = [
  {
    slug: '',
    source: 'README.md',
    sections: ['_intro', 'what-is-deliberation'],
    title: 'Deliberation - second opinion for coding agents',
    description: site.summary,
    nav: 'Home',
    group: 'Docs',
  },
  {
    slug: 'install',
    source: 'README.md',
    // The per-host steps are the host switcher in [...slug].astro; README "Install" repeats
    // them, so only the host-neutral part is rendered here.
    sections: ['requirements'],
    title: 'Install',
    description: 'Install Deliberation on your host: Claude Code, Codex, Cursor, Kiro, Gemini CLI, Antigravity, OpenCode or any other MCP host. Then run init once, check it with doctor, and see what each provider needs.',
    nav: 'Install',
    group: 'Docs',
  },
  {
    slug: 'quickstart',
    source: 'SETUP.md',
    sections: ['_intro', 'modes', 'quick-setup-init'],
    title: 'Quickstart',
    description: 'Run init to detect your keys and CLI logins, write the config and get a first verdict.',
    nav: 'Quickstart',
    group: 'Docs',
  },
  {
    slug: 'consensus',
    source: 'README.md',
    sections: ['how-consensus-and-ask--keep-models-honest'],
    title: 'How consensus works',
    description: 'How /consensus and the ask-* commands keep models honest. A fuller explainer is coming.',
    nav: 'Consensus',
    group: 'Docs',
  },
  {
    slug: 'experts',
    source: 'README.md',
    sections: ['commands', 'the-experts', 'how-to-use'],
    title: 'Commands and experts',
    description: 'The commands and the eight expert personas Deliberation ships with.',
    nav: 'Experts',
    group: 'Docs',
  },
  {
    slug: 'providers',
    source: 'SETUP.md',
    title: 'Providers and configuration',
    description: 'Configure GPT, Gemini, Grok, OpenRouter and local providers, sessions and the dashboard.',
    nav: 'Providers',
    group: 'Docs',
  },
  {
    slug: 'tools',
    source: 'docs/tool-guide.md',
    title: 'Tools reference',
    description: 'Every MCP tool Deliberation exposes, host-neutral.',
    nav: 'Tools',
    group: 'Docs',
  },
  {
    slug: 'reference',
    source: 'TECHNICAL.md',
    splitByH2: true,
    title: 'Technical reference',
    description: 'Deep reference: architecture, consensus flow, provider bridges, environment variables and config.',
    nav: 'Reference',
    group: 'Reference',
  },
  {
    slug: 'hosts',
    source: 'docs/hosts/*.md',
    // The install steps of each guide are swapped for a link to /install/#host-<id>
    // (src/lib/host-pages.ts), so they are written once on the site.
    description: 'Use Deliberation on this host: what it ships, provider keys, updating and notes. The install steps are on the install page.',
    group: 'Hosts',
  },
  {
    slug: 'compare',
    source: 'docs/compare/*.md',
    description: 'How Deliberation compares.',
    nav: 'Compare',
    group: 'Comparisons',
  },
  {
    slug: 'faq',
    placeholder: 'Frequently asked questions are coming. Until then, see the [README](README.md) and [SETUP.md](SETUP.md).',
    title: 'FAQ',
    description: 'Frequently asked questions about Deliberation.',
    nav: 'FAQ',
    group: 'Optional',
  },
  {
    slug: 'privacy',
    source: 'PRIVACY.md',
    title: 'Privacy policy',
    description: 'What Deliberation sends, where it goes, and what it stores on your machine.',
    group: 'Optional',
  },
  {
    slug: 'contributing',
    source: 'CONTRIBUTING.md',
    title: 'Contributing',
    description: 'How to work on Deliberation: checks, pull requests and the release process.',
    group: 'Optional',
  },
  {
    slug: 'changelog',
    source: 'CHANGELOG.md',
    releases: true,
    title: 'Changelog',
    description: 'Release notes for every Deliberation version.',
    nav: 'Changelog',
    group: 'Optional',
  },
]
