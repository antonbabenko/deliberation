// Copy the repo's images from ../assets into public/assets before dev and build, so
// Markdown image links resolve on the site. public/assets is gitignored: no
// committed copies.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const siteDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const from = path.join(siteDir, '..', 'assets')
const to = path.join(siteDir, 'public', 'assets')
const IMAGE = /\.(png|jpe?g|gif|svg|webp|avif|ico)$/i

fs.rmSync(to, { recursive: true, force: true })
fs.mkdirSync(to, { recursive: true })
let n = 0
for (const f of fs.readdirSync(from)) {
  if (!IMAGE.test(f)) continue
  fs.copyFileSync(path.join(from, f), path.join(to, f))
  n++
}
console.log(`copy-assets: ${n} images -> public/assets`)
