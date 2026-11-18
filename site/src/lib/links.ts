// Pure helpers for turning repo Markdown into site pages: link rewriting and
// H2 slicing. No Astro imports, so `npm test` runs them with plain Node.
import path from 'node:path'

export const INTRO = '_intro'

export interface LinkContext {
  /** Site base path with a trailing slash, e.g. '/deliberation/'. */
  base: string
  repo: string
  branch: string
  /** Repo-relative Markdown file -> route of its first page. */
  fileRoutes: Map<string, string>
  /** Repo-relative Markdown file -> heading anchor -> route of the page holding it. */
  anchorRoutes: Map<string, Map<string, string>>
  /** Whether a repo-relative path is a file, a directory, or missing. */
  kind: (rel: string) => 'file' | 'dir' | null
}

const EXTERNAL = /^([a-z][a-z0-9+.-]*:|\/\/)/i
const IMAGE = /\.(png|jpe?g|gif|svg|webp|avif|ico)$/i

export function routePath(base: string, slug: string): string {
  return slug ? `${base}${slug}/` : base
}

export function githubUrl(ctx: LinkContext, rel: string, hash = ''): string {
  const mode = ctx.kind(rel) === 'dir' ? 'tree' : 'blob'
  return `https://github.com/${ctx.repo}/${mode}/${ctx.branch}/${encodeURI(rel)}${hash ? `#${hash}` : ''}`
}

/**
 * Rewrite one href/src found in `fromFile` (repo-relative):
 * - external, protocol-relative and root-absolute URLs stay as they are;
 * - links to a mapped doc (and its anchors) become site routes;
 * - images under assets/ are served by the site at <base>assets/...;
 * - anything else in the repo links to GitHub.
 * Idempotent: a rewritten URL is root-absolute or external, so a second pass keeps it.
 */
export function rewriteUrl(url: string, fromFile: string, ctx: LinkContext): string {
  if (!url || EXTERNAL.test(url) || url.startsWith('/')) return url
  const at = url.indexOf('#')
  const rawPath = at === -1 ? url : url.slice(0, at)
  const hash = at === -1 ? '' : url.slice(at + 1)
  let target = fromFile
  if (rawPath) {
    let decoded = rawPath
    try {
      decoded = decodeURI(rawPath)
    } catch {
      // keep the raw path when it holds a stray '%'
    }
    target = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), decoded)).replace(/(.)\/+$/, '$1')
  }
  if (target === '..' || target.startsWith('../')) return url

  // A directory link goes to its README when the site maps that README.
  const fileRoute = ctx.fileRoutes.get(target) ?? ctx.fileRoutes.get(`${target}/README.md`)
  if (fileRoute !== undefined && !ctx.fileRoutes.has(target)) target = `${target}/README.md`
  if (fileRoute !== undefined) {
    if (!hash) return fileRoute
    const route = ctx.anchorRoutes.get(target)?.get(hash)
    // The anchor sits in a part of the file the site does not render.
    return route !== undefined ? `${route}#${hash}` : githubUrl(ctx, target, hash)
  }
  if (target.startsWith('assets/') && IMAGE.test(target)) {
    return `${ctx.base}${target}${hash ? `#${hash}` : ''}`
  }
  return githubUrl(ctx, target, hash)
}

export interface Section {
  /** H2 anchor id, or INTRO for the text before the first H2. */
  id: string
  html: string
}

/** Split rendered HTML at every <h2 id="...">. The first section is the intro. */
export function splitByH2(html: string): Section[] {
  const re = /<h2\b[^>]*\bid="([^"]*)"[^>]*>/g
  const sections: Section[] = []
  let start = 0
  let id = INTRO
  for (const m of html.matchAll(re)) {
    sections.push({ id, html: html.slice(start, m.index) })
    start = m.index
    id = m[1]
  }
  sections.push({ id, html: html.slice(start) })
  return sections
}

export interface Heading {
  depth: number
  slug: string
  text: string
}

/** Map every heading anchor to the H2 section (or INTRO) that contains it. */
export function sectionOfHeadings(headings: readonly Heading[]): Map<string, string> {
  const out = new Map<string, string>()
  let current = INTRO
  for (const h of headings) {
    if (h.depth === 2) current = h.slug
    out.set(h.slug, current)
  }
  return out
}
