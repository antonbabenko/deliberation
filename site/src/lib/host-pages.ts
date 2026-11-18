// /hosts/<id>/ pages render docs/hosts/<id>.md, but a host's install steps are shown once,
// in the host switcher on /install/. These helpers swap the guide's install-step H2s for a
// link there, and keep their H3s ("Other ways to install") and every other section.
// Pure, so `npm test` checks them against the repo's guides.
import { splitByH2 } from './links.ts'

/** H2 anchors in docs/hosts/<id>.md that hold the install steps, in source order. */
export const INSTALL_SECTIONS: Record<string, string[]> = {
  antigravity: ['install'],
  codex: ['install'],
  cursor: ['1-add-the-mcp-server', '2-add-the-rule'],
  'gemini-cli': ['install'],
  kiro: ['install'],
  opencode: ['1-register-the-mcp-server', '2-drop-in-the-commands-and-agents'],
}

/** The host id of a route such as 'hosts/codex', or null for any other page. */
export function hostOf(slug: string): string | null {
  const id = slug.match(/^hosts\/([a-z0-9-]+)$/)?.[1]
  return id && id in INSTALL_SECTIONS ? id : null
}

/**
 * Replace the H2 sections `ids` with `replacement`, placed where the first one was. Each
 * replaced section keeps its H3 sub-sections. Throws when an id is missing, so a renamed
 * heading in a guide fails the build instead of showing the steps twice.
 */
export function replaceSections(html: string, ids: readonly string[], replacement: string): string {
  const sections = splitByH2(html)
  const missing = ids.filter((id) => !sections.some((s) => s.id === id))
  if (missing.length) throw new Error(`host page: no H2 with id ${missing.join(', ')}`)
  let placed = false
  return sections
    .map((s) => {
      if (!ids.includes(s.id)) return s.html
      const at = s.html.search(/<h3\b/)
      const kept = at === -1 ? '' : s.html.slice(at)
      const lead = placed ? '' : replacement
      placed = true
      return lead + kept
    })
    .join('')
}

/** The section that stands in for the install steps; it keeps the first step's anchor. */
export function installLink(anchor: string, hostName: string, href: string): string {
  const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
  return (
    `<h2 id="${esc(anchor)}">Install</h2>` +
    `<p>The install steps for ${esc(hostName)} are on the <a href="${esc(href)}">install page</a>, with every other host. ` +
    'This page has the rest: what the plugin ships, provider keys, updating and notes.</p>'
  )
}
