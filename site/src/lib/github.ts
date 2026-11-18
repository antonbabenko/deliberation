// GitHub star count, fetched once per build. The page ships the number as text; no
// visitor ever calls GitHub. Any failure (offline, rate limit, bad body) returns null and
// the top bar shows the link without a number.

const TIMEOUT_MS = 5_000

/** 987 -> "987", 1234 -> "1.2k", 12345 -> "12k", 1200000 -> "1.2M". */
export function formatCount(n: number): string {
  if (n < 1000) return String(n)
  const [div, unit] = n < 1_000_000 ? [1000, 'k'] : [1_000_000, 'M']
  const v = n / div
  return `${v < 10 ? (Math.floor(v * 10) / 10).toString().replace(/\.0$/, '') : Math.floor(v)}${unit}`
}

let cached: Promise<string | null> | undefined

export function starCount(repo: string): Promise<string | null> {
  cached ??= (async () => {
    if (process.env.SITE_OFFLINE === '1') return null
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'deliberation-site-build',
    }
    if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`
    try {
      const res = await fetch(`https://api.github.com/repos/${repo}`, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) })
      if (!res.ok) return null
      const n = ((await res.json()) as { stargazers_count?: unknown }).stargazers_count
      return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? formatCount(n) : null
    } catch {
      return null
    }
  })()
  return cached
}
