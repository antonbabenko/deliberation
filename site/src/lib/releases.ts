// GitHub Releases as Markdown, fetched at build time. Returns null on any failure
// (offline, rate limit, bad response) so the caller falls back to CHANGELOG.md and
// the build never fails because of the network.

interface Release {
  tag_name: string
  name: string | null
  html_url: string
  published_at: string | null
  body: string | null
  draft: boolean
}

const TIMEOUT_MS = 10_000
const PER_PAGE = 100
const MAX_PAGES = 10

export async function fetchReleasesMarkdown(
  repo: string,
  warn: (msg: string) => void,
): Promise<string | null> {
  if (process.env.SITE_OFFLINE === '1') return null
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'deliberation-site-build',
  }
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  try {
    const all: Release[] = []
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=${PER_PAGE}&page=${page}`, {
        headers,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (!res.ok) {
        warn(`GitHub Releases returned HTTP ${res.status}; using CHANGELOG.md`)
        return null
      }
      const data: unknown = await res.json()
      if (!Array.isArray(data)) {
        warn('GitHub Releases response is not a list; using CHANGELOG.md')
        return null
      }
      all.push(...(data as Release[]))
      if (data.length < PER_PAGE) break
      if (page === MAX_PAGES) warn(`GitHub Releases: stopped after ${MAX_PAGES * PER_PAGE} releases; older ones are left out`)
    }
    if (all.length === 0) {
      warn('GitHub Releases list is empty; using CHANGELOG.md')
      return null
    }
    return all
      .filter((r) => !r.draft && typeof r.tag_name === 'string')
      .map((r) => {
        const date = r.published_at ? ` (${r.published_at.slice(0, 10)})` : ''
        // The body opens with its own changelog heading for the version; this one replaces it.
        const body = (r.body ?? '').trim().replace(/^#{1,3} [^\n]*\n*/, '')
        return `## [${r.name || r.tag_name}](${r.html_url})${date}\n\n${body}\n`
      })
      .join('\n')
  } catch (err) {
    warn(`GitHub Releases fetch failed (${err instanceof Error ? err.message : String(err)}); using CHANGELOG.md`)
    return null
  }
}
