// llms.txt (https://llmstxt.org): H1, blockquote summary, then link sections.
import type { APIRoute } from 'astro'
import { getCollection } from 'astro:content'
import { site } from '../pages.config.ts'
import { absolute, routeOf } from '../lib/seo.ts'
import { runs } from '../lib/runs.ts'
import { outcomeWord, runSlug } from '../lib/run-pages.ts'
import { subjectKind } from '../lib/run-model.ts'

export const GET: APIRoute = async () => {
  const docs = (await getCollection('docs')).sort(
    (a, b) => a.data.order - b.data.order || a.data.slug.localeCompare(b.data.slug),
  )
  const groups = new Map<string, string[]>()
  for (const { data } of docs) {
    const lines = groups.get(data.group) ?? []
    lines.push(`- [${data.title}](${absolute(routeOf(data.slug))}): ${data.description}`)
    groups.set(data.group, lines)
  }
  const body = [
    `# ${site.name}`,
    '',
    `> ${site.summary}`,
    '',
    `Source: https://github.com/${site.repo}. Full text of every page: ${absolute(routeOf('llms-full.txt').replace(/\/$/, ''))}`,
    '',
    '## Site',
    '',
    `- [Features and configuration](${absolute(routeOf('features'))}): Every major feature and setting on one page.`,
    `- [Sample runs](${absolute(routeOf('sample-runs'))}): Recorded consensus runs, one page each.`,
    ...runs.map((r) => `  - [${r.subject.title}](${absolute(routeOf(runSlug(r)))}): ${subjectKind(r)}, ${r.expert} expert, ${outcomeWord(r)} after ${r.rounds.length} round${r.rounds.length === 1 ? '' : 's'}.`),
    '',
    ...[...groups].flatMap(([group, lines]) => [`## ${group}`, '', ...lines, '']),
  ].join('\n')
  return new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
}
