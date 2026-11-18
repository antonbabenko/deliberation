import type { APIRoute } from 'astro'
import { BASE, absolute } from '../lib/seo.ts'

export const GET: APIRoute = () =>
  new Response(`User-agent: *\nAllow: /\nDisallow: ${BASE}runs/\n\nSitemap: ${absolute(`${BASE}sitemap-index.xml`)}\n`, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  })
