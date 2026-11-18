// Pure helpers for /sample-runs/ (the index) and /sample-runs/<id>/ (one page per run).
// No Astro imports, so `npm test` checks them against every recorded run.
import { type Run, short, subjectKind } from './run-model.ts'

/** Route slug of a run's own page. Another page links to exactly this path. */
export const runSlug = (run: Run): string => `sample-runs/${run.id}`

/** One word for how the run ended. */
export const outcomeWord = (run: Run): 'converged' | 'unresolved' => (run.outcome.converged ? 'converged' : 'unresolved')

/** Prompt text longer than this starts collapsed. */
export const LONG_TEXT = 1200

export const isLong = (text: string): boolean => text.length > LONG_TEXT

/** Panel members in reading order, e.g. "grok, or:kimi-k3-1-pro and or:glm-5-3-flashx". */
export function panelNames(run: Run): string {
  const names = run.panel.map((p) => short(p.source))
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

export interface RunMeta {
  title: string
  description: string
}

/** Page title and meta description; both differ for every run. */
export function runMeta(run: Run): RunMeta {
  return {
    title: `${run.subject.title} - sample run`,
    description: `A recorded Deliberation run. ${subjectKind(run)}: ${run.subject.title}. Reviewed by the ${run.expert} expert on ${panelNames(run)}, ${outcomeWord(run)}. The exact prompt, every answer verbatim, and each ruling with its reason.`,
  }
}

/** The runs before and after `id` in the given order, for the pager. */
export function neighbours(list: readonly Run[], id: string): { prev?: Run; next?: Run } {
  const i = list.findIndex((r) => r.id === id)
  return i === -1 ? {} : { prev: list[i - 1], next: list[i + 1] }
}
