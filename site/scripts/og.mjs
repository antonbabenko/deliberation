// Render og/og.html to public/og.png (1200x630), the image every page names in og:image.
// Run from site/ after editing og/og.html, and commit the PNG:
//   node scripts/og.mjs
// Playwright is not a dependency of the site. The script runs its CLI through npx, which
// downloads it on first use; the browser comes from `npx playwright install chromium`.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const siteDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const source = path.join(siteDir, 'og', 'og.html')
const out = path.join(siteDir, 'public', 'og.png')
const SIZE = '1200,630'

fs.mkdirSync(path.dirname(out), { recursive: true })
try {
  execFileSync('npx', ['-y', 'playwright', 'screenshot', '--browser', 'chromium', '--color-scheme', 'light', '--viewport-size', SIZE, pathToFileURL(source).href, out], {
    stdio: 'inherit',
  })
} catch (error) {
  console.error(`og: could not render ${path.relative(siteDir, source)}. If the browser is missing, run: npx playwright install chromium`)
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
}
console.log(`og: ${path.relative(siteDir, source)} -> ${path.relative(siteDir, out)}`)
