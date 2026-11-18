// The expert personas, read from the repository at build time: the name and the role
// line come from prompts/<key>.md, the example requests from the README's expert table.
// Only the "when" label and the order are written here.
import fs from 'node:fs'
import path from 'node:path'

export interface Expert {
  key: string
  name: string
  /** First paragraph of the prompt file, verbatim. */
  role: string
  when: string
  asks: string[]
}

// Order: where in the work each expert is used.
const WHEN: Record<string, string> = {
  'scope-analyst': 'Before planning',
  architect: 'While designing',
  'plan-reviewer': 'Before work starts',
  researcher: 'On unfamiliar ground',
  'code-reviewer': 'On a diff',
  'security-analyst': 'On a diff',
  debugger: 'When stuck',
  'writing-editor': 'Before publishing',
}
// The arbiter prompt drives the server-side loop; it is not an expert a user picks.
const NOT_EXPERTS = new Set(['arbiter'])

/** `| **Name** | what | "a" / "b" |` rows of the README expert table, by name. */
export function parseAsks(readme: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const m of readme.matchAll(/^\|\s*\*\*([^*|]+)\*\*\s*\|[^|]*\|([^|]*)\|\s*$/gm)) {
    out.set(m[1].trim(), [...m[2].matchAll(/"([^"]+)"/g)].map((q) => q[1]))
  }
  return out
}

/** H1 text and the first paragraph under it. */
export function parsePrompt(md: string): { name: string; role: string } | null {
  const m = md.match(/^# (.+)\n+([^\n#][^\n]*)/)
  return m ? { name: m[1].trim(), role: m[2].trim() } : null
}

export function loadExperts(repoRoot: string): Expert[] {
  const dir = path.join(repoRoot, 'prompts')
  const asks = parseAsks(fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8'))
  const order = Object.keys(WHEN)
  const rank = (k: string): number => (order.includes(k) ? order.indexOf(k) : order.length)
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md') && !NOT_EXPERTS.has(f.slice(0, -3)))
    .map((f) => {
      const key = f.slice(0, -3)
      const parsed = parsePrompt(fs.readFileSync(path.join(dir, f), 'utf8'))
      if (!parsed) throw new Error(`prompts/${f}: expected "# Name" followed by a role paragraph`)
      return { key, ...parsed, when: WHEN[key] ?? '', asks: asks.get(parsed.name) ?? [] }
    })
    .sort((a, b) => rank(a.key) - rank(b.key) || a.key.localeCompare(b.key))
}
