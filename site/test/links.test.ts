import { test } from 'node:test'
import assert from 'node:assert/strict'
import { INTRO, type LinkContext, rewriteUrl, sectionOfHeadings, splitByH2 } from '../src/lib/links.ts'

const ctx: LinkContext = {
  base: '/deliberation/',
  repo: 'antonbabenko/deliberation',
  branch: 'master',
  fileRoutes: new Map([
    ['README.md', '/deliberation/'],
    ['TECHNICAL.md', '/deliberation/reference/'],
    ['docs/hosts/README.md', '/deliberation/hosts/'],
  ]),
  anchorRoutes: new Map([
    ['README.md', new Map([['install', '/deliberation/install/']])],
    ['TECHNICAL.md', new Map([['dashboard', '/deliberation/reference/dashboard/']])],
  ]),
  kind: (rel) => (rel === 'examples' ? 'dir' : 'file'),
}

test('external, root-absolute and protocol-relative URLs stay', () => {
  for (const u of ['https://x.dev/a', 'mailto:a@b.c', '//cdn.x/y.png', '/deliberation/assets/a.png']) {
    assert.equal(rewriteUrl(u, 'README.md', ctx), u)
  }
})

test('mapped docs and their anchors become site routes', () => {
  assert.equal(rewriteUrl('TECHNICAL.md', 'README.md', ctx), '/deliberation/reference/')
  assert.equal(rewriteUrl('TECHNICAL.md#dashboard', 'README.md', ctx), '/deliberation/reference/dashboard/#dashboard')
  assert.equal(rewriteUrl('#install', 'README.md', ctx), '/deliberation/install/#install')
  assert.equal(rewriteUrl('../../README.md#install', 'docs/hosts/kiro.md', ctx), '/deliberation/install/#install')
  assert.equal(rewriteUrl('docs/hosts/', 'README.md', ctx), '/deliberation/hosts/')
})

test('an anchor the site does not render links to GitHub', () => {
  assert.equal(
    rewriteUrl('#configuration', 'README.md', ctx),
    'https://github.com/antonbabenko/deliberation/blob/master/README.md#configuration',
  )
})

test('assets images are served by the site, other files link to GitHub', () => {
  assert.equal(rewriteUrl('assets/logo.svg#gh-light-mode-only', 'README.md', ctx), '/deliberation/assets/logo.svg#gh-light-mode-only')
  assert.equal(rewriteUrl('../../assets/a.png', 'docs/hosts/kiro.md', ctx), '/deliberation/assets/a.png')
  assert.equal(rewriteUrl('LICENSE', 'README.md', ctx), 'https://github.com/antonbabenko/deliberation/blob/master/LICENSE')
  assert.equal(rewriteUrl('examples/', 'README.md', ctx), 'https://github.com/antonbabenko/deliberation/tree/master/examples')
  assert.equal(rewriteUrl('assets/consensus-flow.html', 'README.md', ctx), 'https://github.com/antonbabenko/deliberation/blob/master/assets/consensus-flow.html')
})

test('rewriting is idempotent', () => {
  const once = rewriteUrl('TECHNICAL.md#dashboard', 'README.md', ctx)
  assert.equal(rewriteUrl(once, 'README.md', ctx), once)
})

test('splitByH2 keeps the intro and cuts at every h2 id', () => {
  const html = '<h1 id="t">T</h1><p>i</p><h2 id="a">A</h2><p>a</p><h2 id="b">B</h2><p>b</p>'
  const s = splitByH2(html)
  assert.deepEqual(s.map((x) => x.id), [INTRO, 'a', 'b'])
  assert.equal(s.map((x) => x.html).join(''), html)
  assert.equal(s[1].html, '<h2 id="a">A</h2><p>a</p>')
})

test('sectionOfHeadings maps deep anchors to their H2', () => {
  const m = sectionOfHeadings([
    { depth: 1, slug: 't', text: 'T' },
    { depth: 2, slug: 'a', text: 'A' },
    { depth: 3, slug: 'a1', text: 'A1' },
  ])
  assert.equal(m.get('t'), INTRO)
  assert.equal(m.get('a1'), 'a')
})
