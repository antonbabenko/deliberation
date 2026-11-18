// @ts-check
import { defineConfig } from 'astro/config'
import sitemap from '@astrojs/sitemap'
import { codeFrame } from './src/lib/code-frame.ts'

// Deployed at the root of the custom domain (GitHub Pages, custom domain set in repo settings).
// Override for another target, e.g. the Pages project URL:
//   SITE_URL=https://antonbabenko.github.io SITE_BASE=/deliberation npm run build
const site = process.env.SITE_URL || 'https://usedeliberation.com'
const base = process.env.SITE_BASE || '/'

export default defineConfig({
  site,
  base,
  output: 'static',
  trailingSlash: 'always',
  integrations: [sitemap({ filter: (page) => !page.includes('/404') && !page.includes('/runs/') })],
  markdown: {
    // Shiki with Astro's `css-variables` theme: one HTML output, and src/styles/content.css
    // maps the --astro-code-* variables to the design tokens, so code follows the light
    // and dark themes. `codeFrame` adds the language legend and the Copy key.
    syntaxHighlight: 'shiki',
    shikiConfig: { theme: 'css-variables', transformers: [codeFrame] },
    // Quotes stay as written (as on GitHub).
    smartypants: false,
  },
})
