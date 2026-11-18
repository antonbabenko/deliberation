// URL and structured-data helpers shared by the layout, pages and endpoints.
import { site } from '../pages.config.ts'

/** Base path with a trailing slash, e.g. '/' or '/deliberation/'. */
export const BASE = import.meta.env.BASE_URL.endsWith('/') ? import.meta.env.BASE_URL : `${import.meta.env.BASE_URL}/`

export function routeOf(slug: string): string {
  return slug ? `${BASE}${slug}/` : BASE
}

/** Absolute URL for a site path such as '/deliberation/install/'. */
export function absolute(pathname: string): string {
  return new URL(pathname, import.meta.env.SITE).href
}

export const OG_IMAGE = absolute(`${BASE}${site.ogImage}`)

export function softwareApplication(): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: site.name,
    description: site.summary,
    url: absolute(BASE),
    applicationCategory: 'DeveloperApplication',
    operatingSystem: 'macOS, Linux, Windows',
    license: `https://github.com/${site.repo}/blob/${site.branch}/LICENSE`,
    codeRepository: `https://github.com/${site.repo}`,
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
  }
}

export interface Crumb {
  name: string
  slug: string
}

export function breadcrumbList(crumbs: Crumb[]): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: crumbs.map((c, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: c.name,
      item: absolute(routeOf(c.slug)),
    })),
  }
}
