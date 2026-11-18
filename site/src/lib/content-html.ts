// Pure passes over rendered Markdown HTML, run once per page by the docs loader after
// links are rewritten: external-link marks, heading anchors, table frames and callouts.
// No Astro imports, so `npm test` runs them with plain Node.

/** True for an http(s) URL on another origin than the site. */
export function isExternal(href: string, siteOrigin: string): boolean {
  if (!/^https?:\/\//i.test(href)) return false
  try {
    return new URL(href).origin !== new URL(siteOrigin).origin
  } catch {
    return true
  }
}

/**
 * External links get rel="external" (the hook for the arrow in content.css) and a
 * visually hidden " (external)". They open in the same tab: the reader decides.
 * Links that only wrap an image (badges) are left alone, and so is a link with a rel.
 */
export function markExternalLinks(html: string, siteOrigin: string): string {
  return html.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/g, (all, attrs: string, body: string) => {
    const href = /\bhref="([^"]*)"/.exec(attrs)?.[1]
    if (!href || !isExternal(href, siteOrigin) || /\brel=/.test(attrs)) return all
    if (/^\s*<(img|picture)\b[^>]*>(\s*<\/picture>)?\s*$/.test(body) || /^\s*<picture\b/.test(body)) return all
    return `<a${attrs} rel="external">${body}<span class="sr" data-pagefind-ignore> (external)</span></a>`
  })
}

/** H2 to H4 with an id get a link to themselves after the heading text. */
export function addHeadingAnchors(html: string): string {
  return html.replace(/<h([2-4])\b([^>]*\bid="([^"]+)"[^>]*)>([\s\S]*?)<\/h\1>/g, (_all, depth: string, attrs: string, id: string, body: string) => {
    return `<h${depth}${attrs}>${body} <a class="anchor" href="#${id}" aria-label="Link to this section"></a></h${depth}>`
  })
}

/**
 * Tables sit in a frame that scrolls sideways on a narrow screen. `--cols` lets the
 * stylesheet keep a readable minimum width per column.
 */
export function frameTables(html: string): string {
  return html.replace(/<table\b[^>]*>[\s\S]*?<\/table>/g, (table) => {
    const head = /<thead\b[\s\S]*?<\/thead>/.exec(table)?.[0] ?? /<tr\b[\s\S]*?<\/tr>/.exec(table)?.[0] ?? ''
    const cols = (head.match(/<t[hd]\b/g) ?? []).length || 1
    return `<div class="tframe" role="region" aria-label="Table" tabindex="0" style="--cols:${cols}">${table}</div>`
  })
}

const CALLOUTS: Record<string, string> = {
  NOTE: 'Note',
  TIP: 'Tip',
  IMPORTANT: 'Important',
  WARNING: 'Warning',
  CAUTION: 'Caution',
}

/** GitHub alerts (`> [!NOTE]`) become a labelled callout instead of literal text. */
export function markCallouts(html: string): string {
  return html.replace(/<blockquote>\s*<p>\[!([A-Z]+)\]\s*(?:<br\s*\/?>)?\s*/g, (all, kind: string) => {
    const label = CALLOUTS[kind]
    if (!label) return all
    return `<blockquote class="callout ${kind.toLowerCase()}"><p class="callout-t">${label}</p><p>`
  })
}

export function decorateHtml(html: string, siteOrigin: string): string {
  return markCallouts(frameTables(addHeadingAnchors(markExternalLinks(html, siteOrigin))))
}
