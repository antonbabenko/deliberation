// Content loader: renders the repo's own Markdown (mapped in pages.config.ts) into
// the `docs` collection, and exposes the raw sources as the `sources` collection
// (for llms-full.txt). Nothing is copied into site/.
//
// Each source file is rendered whole with Astro's Markdown processor, so heading
// ids match GitHub's, then sliced at H2 boundaries into pages. Rendering runs twice:
// the first pass collects headings, which tells the link rewriter which page holds
// each anchor; the second pass rewrites links with that map.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Loader, LoaderContext } from 'astro/loaders'
import { satteri } from '@astrojs/markdown-satteri'
import { pages, site, type PageDef } from '../pages.config.ts'
import {
  INTRO,
  type Heading,
  type LinkContext,
  rewriteUrl,
  routePath,
  sectionOfHeadings,
  splitByH2,
} from './links.ts'
import { decorateHtml } from './content-html.ts'
import { fetchReleasesMarkdown } from './releases.ts'

interface ChildLink {
  slug: string
  title: string
}

export interface DocData {
  slug: string
  title: string
  description: string
  source: string | null
  nav: string | null
  group: string
  order: number
  parent: ChildLink | null
  children: ChildLink[]
}

/** One concrete page: a config entry with globs and splits expanded. */
interface Unit {
  def: PageDef
  slug: string
  file: string | null
  /** H2 ids to keep (INTRO = text before the first H2); null = whole file. */
  sections: string[] | null
  title: string | null
  parentSlug: string | null
  order: number
}

type Rendered = { html: string; headings: Heading[] }
type RenderFn = (md: string, file: string) => Promise<Rendered>

function repoRootOf(ctx: LoaderContext): string {
  return fileURLToPath(new URL('../', ctx.config.root))
}

function baseOf(ctx: LoaderContext): string {
  return ctx.config.base.endsWith('/') ? ctx.config.base : `${ctx.config.base}/`
}

function expandGlob(root: string, pattern: string): string[] {
  const dir = path.posix.dirname(pattern)
  const ext = path.posix.extname(pattern)
  const files = fs
    .readdirSync(path.join(root, dir))
    .filter((f) => f.endsWith(ext))
    .sort((a, b) => (a === 'README.md' ? -1 : b === 'README.md' ? 1 : a.localeCompare(b)))
  return files.map((f) => `${dir}/${f}`)
}

/** Expand config entries into units; split pages need headings, so that comes later. */
function expandPages(root: string): Unit[] {
  const units: Unit[] = []
  pages.forEach((def, order) => {
    if (def.source?.includes('*')) {
      const files = expandGlob(root, def.source)
      const hasIndex = files.some((f) => path.posix.basename(f) === 'README.md')
      for (const file of files) {
        const name = path.posix.basename(file, '.md')
        const isIndex = name === 'README'
        units.push({
          def,
          slug: isIndex ? def.slug : `${def.slug}/${name.toLowerCase()}`,
          file,
          sections: null,
          title: null,
          parentSlug: isIndex || !hasIndex ? null : def.slug,
          order,
        })
      }
      return
    }
    units.push({
      def,
      slug: def.slug,
      file: def.source ?? null,
      sections: def.splitByH2 ? [INTRO] : (def.sections ?? null),
      title: def.title ?? null,
      parentSlug: null,
      order,
    })
  })
  return units
}

function makeRenderer(ctx: LoaderContext, link: () => LinkContext | null): Promise<{ render: RenderFn }> {
  const root = repoRootOf(ctx)
  const fileOf = (url: URL | undefined): string =>
    url ? path.relative(root, fileURLToPath(url)).split(path.sep).join('/') : 'README.md'
  const rewrite = (url: unknown, file: string): unknown => {
    const lc = link()
    return lc && typeof url === 'string' ? rewriteUrl(url, file, lc) : url
  }
  const { markdown, image } = ctx.config
  const processor = satteri({
    // Parse raw HTML (<details>, <picture>, <img>) into elements so links inside it
    // are rewritten too.
    features: { rawHtml: true },
    mdastPlugins: [
      (f) => {
        const file = fileOf(f.fileURL)
        return {
          name: 'repo-links-mdast',
          link: (node, c) => c.setProperty(node, 'url', rewrite(node.url, file) as string),
          image: (node, c) => c.setProperty(node, 'url', rewrite(node.url, file) as string),
          definition: (node, c) => c.setProperty(node, 'url', rewrite(node.url, file) as string),
        }
      },
    ],
    hastPlugins: [
      (f) => {
        const file = fileOf(f.fileURL)
        return {
          name: 'repo-links-hast',
          element: {
            filter: ['a', 'img', 'source'],
            visit(node, c) {
              for (const key of ['href', 'src']) {
                const v = node.properties?.[key]
                if (typeof v === 'string') c.setProperty(node, key, rewrite(v, file))
              }
              const srcset = node.properties?.srcSet ?? node.properties?.srcset
              if (typeof srcset === 'string') {
                const out = srcset
                  .split(',')
                  .map((part) => {
                    const [u, ...rest] = part.trim().split(/\s+/)
                    return [rewrite(u, file), ...rest].join(' ')
                  })
                  .join(', ')
                c.setProperty(node, 'srcSet', out)
              }
            },
          },
        }
      },
    ],
  })
  return processor
    .createRenderer({
      image,
      syntaxHighlight: markdown.syntaxHighlight,
      shikiConfig: markdown.shikiConfig,
      gfm: markdown.gfm,
      smartypants: markdown.smartypants,
    })
    .then((r) => ({
      render: async (md: string, file: string) => {
        const { code, metadata } = await r.render(md, { fileURL: pathToFileURL(path.join(root, file)) })
        return { html: code, headings: metadata.headings as Heading[] }
      },
    }))
}

function titleOf(headings: Heading[], depth: number, fallback: string): string {
  return headings.find((h) => h.depth === depth)?.text.trim() || fallback
}

export function docsLoader(): Loader {
  return {
    name: 'repo-docs',
    async load(ctx) {
      const root = repoRootOf(ctx)
      const base = baseOf(ctx)
      let linkCtx: LinkContext | null = null
      const { render } = await makeRenderer(ctx, () => linkCtx)
      const read = (file: string): string => fs.readFileSync(path.join(root, file), 'utf8')

      // Pass 1: headings of every source file.
      let units = expandPages(root)
      const files = [...new Set(units.flatMap((u) => (u.file ? [u.file] : [])))]
      const headingsOf = new Map<string, Heading[]>()
      for (const file of files) headingsOf.set(file, (await render(read(file), file)).headings)

      // Expand splitByH2 entries into one child page per H2.
      units = units.flatMap((u) => {
        if (!u.def.splitByH2 || !u.file) return [u]
        const h2s = (headingsOf.get(u.file) ?? []).filter((h) => h.depth === 2)
        return [
          u,
          ...h2s.map((h) => ({
            ...u,
            slug: `${u.slug}/${h.slug}`,
            sections: [h.slug],
            title: h.text.trim(),
            parentSlug: u.slug,
          })),
        ]
      })
      // Final order: config order, and source order within an expanded entry.
      units = units.map((u, order) => ({ ...u, order }))

      // Which page holds each section and anchor of each file.
      const fileRoutes = new Map<string, string>()
      const anchorRoutes = new Map<string, Map<string, string>>()
      // A link to a file without an anchor goes to the first page that shows its intro.
      for (const u of units) {
        if (u.file && !fileRoutes.has(u.file) && (u.sections === null || u.sections.includes(INTRO))) {
          fileRoutes.set(u.file, routePath(base, u.slug))
        }
      }
      for (const u of units) {
        if (!u.file) continue
        const route = routePath(base, u.slug)
        if (!fileRoutes.has(u.file)) fileRoutes.set(u.file, route)
        const anchors = anchorRoutes.get(u.file) ?? new Map<string, string>()
        anchorRoutes.set(u.file, anchors)
        for (const [anchor, section] of sectionOfHeadings(headingsOf.get(u.file) ?? [])) {
          if (!anchors.has(anchor) && (u.sections === null || u.sections.includes(section))) {
            anchors.set(anchor, route)
          }
        }
      }
      linkCtx = {
        base,
        repo: site.repo,
        branch: site.branch,
        fileRoutes,
        anchorRoutes,
        kind: (rel) => {
          try {
            return fs.statSync(path.join(root, rel)).isDirectory() ? 'dir' : 'file'
          } catch {
            return null
          }
        },
      }

      // Pass 2: render with links rewritten, then slice per page.
      const renderedFiles = new Map<string, Rendered>()
      for (const file of files) renderedFiles.set(file, await render(read(file), file))

      ctx.store.clear()
      for (const u of units) {
        let html: string
        let headings: Heading[]
        if (u.def.releases && u.file) {
          const md = await fetchReleasesMarkdown(site.repo, (m) => ctx.logger.warn(m))
          const r = md ? await render(md, u.file) : (renderedFiles.get(u.file) as Rendered)
          html = r.html
          headings = r.headings
        } else if (u.file) {
          const r = renderedFiles.get(u.file) as Rendered
          if (u.sections === null) {
            html = r.html
            headings = r.headings
          } else {
            const keep = new Set(u.sections)
            const missing = u.sections.filter((s) => s !== INTRO && !r.headings.some((h) => h.depth === 2 && h.slug === s))
            if (missing.length) {
              throw new Error(`pages.config.ts: ${u.file} has no H2 with id ${missing.join(', ')} (page "${u.slug}")`)
            }
            html = splitByH2(r.html)
              .filter((s) => keep.has(s.id))
              .map((s) => s.html)
              .join('')
            const sectionOf = sectionOfHeadings(r.headings)
            headings = r.headings.filter((h) => keep.has(sectionOf.get(h.slug) ?? INTRO))
          }
        } else {
          const r = await render(u.def.placeholder ?? '', `${u.slug || 'index'}.md`)
          html = r.html
          headings = r.headings
        }

        const fileHeadings = u.file ? (headingsOf.get(u.file) ?? []) : []
        const title = u.title ?? titleOf(fileHeadings, 1, u.slug)
        const children = units
          .filter((c) => c.parentSlug === u.slug && c !== u)
          .map((c) => ({
            slug: c.slug,
            title: c.title ?? titleOf(c.file ? (headingsOf.get(c.file) ?? []) : [], 1, c.slug),
          }))
        const parentUnit = u.parentSlug === null ? undefined : units.find((p) => p.slug === u.parentSlug)
        const parent = parentUnit
          ? {
              slug: parentUnit.slug,
              title: parentUnit.title ?? titleOf(parentUnit.file ? (headingsOf.get(parentUnit.file) ?? []) : [], 1, parentUnit.slug),
            }
          : null
        const data: DocData = {
          slug: u.slug,
          title,
          description: u.def.splitByH2 && parent ? `${title} - ${parent.title}.` : u.def.description,
          source: u.file,
          nav: u.parentSlug === null && u.slug === u.def.slug ? (u.def.nav ?? null) : null,
          group: u.def.group,
          order: u.order,
          parent,
          children,
        }
        const id = u.slug || 'index'
        // After slicing: external-link marks, heading anchors, table frames, callouts.
        html = decorateHtml(html, ctx.config.site ?? 'http://localhost')
        ctx.store.set({
          id,
          data: await ctx.parseData({ id, data: data as unknown as Record<string, unknown> }),
          rendered: { html, metadata: { headings, imagePaths: [] } },
          digest: ctx.generateDigest(html),
        })
      }
    },
  }
}

/** Raw Markdown of every mapped source file, for llms-full.txt. */
export function sourcesLoader(): Loader {
  return {
    name: 'repo-sources',
    async load(ctx) {
      const root = repoRootOf(ctx)
      const base = baseOf(ctx)
      ctx.store.clear()
      const seen = new Set<string>()
      for (const u of expandPages(root)) {
        if (!u.file || seen.has(u.file)) continue
        seen.add(u.file)
        const body = fs.readFileSync(path.join(root, u.file), 'utf8')
        const data = { file: u.file, route: routePath(base, u.slug), order: seen.size }
        ctx.store.set({ id: u.file, data: await ctx.parseData({ id: u.file, data }), body })
      }
    },
  }
}
