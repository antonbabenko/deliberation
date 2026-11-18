import { test } from 'node:test'
import assert from 'node:assert/strict'
import { addHeadingAnchors, decorateHtml, frameTables, isExternal, markCallouts, markExternalLinks } from '../src/lib/content-html.ts'
import { splitByH2 } from '../src/lib/links.ts'
import { langLabel } from '../src/lib/code-frame.ts'

const SITE = 'https://usedeliberation.com'

test('only http(s) links to another origin are external', () => {
  assert.equal(isExternal('https://github.com/a/b', SITE), true)
  assert.equal(isExternal('http://example.com', SITE), true)
  for (const u of ['https://usedeliberation.com/faq/', '/install/', '#top', 'mailto:a@b.c', 'install/']) {
    assert.equal(isExternal(u, SITE), false, u)
  }
})

test('external links are marked, internal links stay byte for byte', () => {
  const internal = '<a href="/install/">Install</a> <a href="#x">x</a> <a href="https://usedeliberation.com/faq/">FAQ</a>'
  assert.equal(markExternalLinks(internal, SITE), internal)
  assert.equal(
    markExternalLinks('<p><a href="https://x.dev/a">the <code>x</code> docs</a>.</p>', SITE),
    '<p><a href="https://x.dev/a" rel="external">the <code>x</code> docs<span class="sr" data-pagefind-ignore> (external)</span></a>.</p>',
  )
})

test('image-only links and links with a rel are not marked', () => {
  const badge = '<a href="https://x.dev"><img src="https://x.dev/b.svg" alt="build"></a>'
  assert.equal(markExternalLinks(badge, SITE), badge)
  const rel = '<a href="https://x.dev" rel="nofollow">x</a>'
  assert.equal(markExternalLinks(rel, SITE), rel)
})

test('marking twice changes nothing more', () => {
  const once = markExternalLinks('<a href="https://x.dev">x</a>', SITE)
  assert.equal(markExternalLinks(once, SITE), once)
})

test('headings with an id get an anchor, and H2 slicing still finds them', () => {
  const html = addHeadingAnchors('<h1 id="t">T</h1><h2 id="a-b">A <code>b</code></h2><p>x</p><h3>no id</h3><h4 id="c">C</h4>')
  assert.match(html, /<h2 id="a-b">A <code>b<\/code> <a class="anchor" href="#a-b" aria-label="Link to this section">/)
  assert.match(html, /<h4 id="c">C <a class="anchor" href="#c" aria-label="Link to this section">/)
  assert.match(html, /<h1 id="t">T<\/h1>/)
  assert.match(html, /<h3>no id<\/h3>/)
  assert.deepEqual(splitByH2(html).map((s) => s.id), ['_intro', 'a-b'])
})

test('tables are framed with their column count', () => {
  const html = frameTables('<table><thead><tr><th>A</th><th>B</th><th>C</th></tr></thead><tbody><tr><td>1</td><td>2</td><td>3</td></tr></tbody></table>')
  assert.match(html, /^<div class="tframe" role="region" aria-label="Table" tabindex="0" style="--cols:3"><table>/)
  assert.match(html, /<\/table><\/div>$/)
})

test('GitHub alerts become labelled callouts, other quotes stay', () => {
  assert.equal(
    markCallouts('<blockquote>\n<p>[!IMPORTANT]\n<strong>Migration note:</strong> text</p>\n</blockquote>'),
    '<blockquote class="callout important"><p class="callout-t">Important</p><p><strong>Migration note:</strong> text</p>\n</blockquote>',
  )
  const plain = '<blockquote>\n<p>[!UNKNOWN] a plain quote</p>\n</blockquote>'
  assert.equal(markCallouts(plain), plain)
})

test('decorateHtml leaves code text alone', () => {
  const code = '<pre><code>&lt;a href="https://x.dev"&gt;x&lt;/a&gt; &lt;table&gt;</code></pre>'
  assert.equal(decorateHtml(code, SITE), code)
})

test('a fence without a language is labelled text', () => {
  assert.equal(langLabel('plaintext'), 'text')
  assert.equal(langLabel(''), 'text')
  assert.equal(langLabel('JSONC'), 'jsonc')
})
