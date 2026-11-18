// llms-full.txt: the raw Markdown of every mapped source file, one after another.
import type { APIRoute } from 'astro'
import { getCollection } from 'astro:content'
import { site } from '../pages.config.ts'
import { absolute } from '../lib/seo.ts'

export const GET: APIRoute = async () => {
  const sources = (await getCollection('sources')).sort((a, b) => a.data.order - b.data.order)
  const parts = sources.map(
    (s) =>
      `<!-- source: https://github.com/${site.repo}/blob/${site.branch}/${s.data.file} | page: ${absolute(s.data.route)} -->\n\n${(s.body ?? '').trim()}\n`,
  )
  return new Response([`# ${site.name}`, '', `> ${site.summary}`, '', ...parts].join('\n'), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  })
}
