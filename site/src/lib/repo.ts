// Build-time access to repository files outside site/. npm scripts run with site/ as the
// working directory, so the repository root is its parent.
import fs from 'node:fs'
import path from 'node:path'

export const REPO_ROOT = path.resolve(process.cwd(), '..')

export function readRepoJson<T>(rel: string): T {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8')) as T
}

/** Value at a dotted path, or a build error naming the missing key. */
export function at(obj: unknown, dotted: string, file: string): unknown {
  let cur = obj
  for (const key of dotted.split('.')) {
    if (cur === null || typeof cur !== 'object' || !(key in cur)) throw new Error(`${file} has no key ${dotted}`)
    cur = (cur as Record<string, unknown>)[key]
  }
  return cur
}
