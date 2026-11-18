// Shiki transformer for fenced code in rendered Markdown: wraps the highlighted <pre>
// in a frame with the language as a legend and a Copy key, and marks added and removed
// lines in `diff` blocks. Colours come from CSS variables (src/styles/content.css).
import type { ShikiConfig } from 'astro'

type Transformer = NonNullable<ShikiConfig['transformers']>[number]
type Root = Parameters<NonNullable<Transformer['root']>>[0]
type Element = Extract<Root['children'][number], { type: 'element' }>

const el = (tagName: string, properties: Element['properties'], children: Element['children']): Element => ({
  type: 'element',
  tagName,
  properties,
  children,
})

/** The legend for a fence language. A fence without one is plain text. */
export function langLabel(lang: string): string {
  const name = lang.trim().toLowerCase()
  return !name || name === 'plaintext' || name === 'plain' || name === 'txt' ? 'text' : name
}

const textOf = (node: Element['children'][number]): string =>
  node.type === 'text' ? node.value : node.type === 'element' ? node.children.map(textOf).join('') : ''

export const codeFrame: Transformer = {
  name: 'code-frame',
  line(node) {
    if (this.options.lang !== 'diff') return
    const first = textOf(node)[0]
    if (first === '+') this.addClassToHast(node, 'ins')
    if (first === '-') this.addClassToHast(node, 'del')
  },
  root(root) {
    const pre = root.children[0]
    if (pre?.type !== 'element') return
    // The Copy key is the site's `[data-copy]` key (src/scripts/site.js): it copies the
    // text of the <code> inside its parent. It is hidden when script is off.
    root.children = [
      el('div', { class: 'code' }, [
        el('span', { class: 'code-lang' }, [{ type: 'text', value: langLabel(this.options.lang) }]),
        el('button', { type: 'button', class: 'copy js-only', 'data-copy': '' }, [{ type: 'text', value: 'Copy' }]),
        pre,
      ]),
    ]
  },
}
