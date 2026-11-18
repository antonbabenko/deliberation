// Per-run pages (/sample-runs/<id>/) and host pages (/hosts/<id>/): the helpers that keep
// each run's page unique and each host's install steps written once.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Run } from '../src/lib/run-model.ts'
import { LONG_TEXT, isLong, neighbours, outcomeWord, panelNames, runMeta, runSlug } from '../src/lib/run-pages.ts'
import { INSTALL_SECTIONS, hostOf, installLink, replaceSections } from '../src/lib/host-pages.ts'
import { HOSTS } from '../src/data/site-copy.ts'

const dir = fileURLToPath(new URL('../src/data/replay/', import.meta.url))
const recorded: Run[] = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(fs.readFileSync(dir + f, 'utf8')))

test('every run page has its own path, title and description', () => {
  const slugs = recorded.map(runSlug)
  const metas = recorded.map(runMeta)
  assert.equal(new Set(slugs).size, recorded.length)
  assert.equal(new Set(metas.map((m) => m.title)).size, recorded.length)
  assert.equal(new Set(metas.map((m) => m.description)).size, recorded.length)
  for (const run of recorded) {
    assert.equal(runSlug(run), `sample-runs/${run.id}`)
    assert.match(run.id, /^[a-z0-9-]+$/)
    assert.ok(run.planUnderReview && run.planUnderReview.length > 0, `${run.id} has the prompt sent to the panel`)
  }
})

test('run titles and site copy use plain words for refusals', () => {
  for (const run of recorded) assert.doesNotMatch(run.subject.title, /fail(s|ed|ing)? (closed|open)|stops? short/i)
  const install = HOSTS.flatMap((h) => h.steps.map((s) => `${s.title} ${s.text ?? ''}`)).join(' ')
  assert.doesNotMatch(install, /fail(s|ed|ing)? (closed|open)|stops? short/i)
})

test('outcome word, panel names, long text and neighbours', () => {
  const run = recorded[0]
  assert.equal(outcomeWord({ ...run, outcome: { ...run.outcome, converged: true } }), 'converged')
  assert.equal(outcomeWord({ ...run, outcome: { ...run.outcome, converged: false } }), 'unresolved')
  const panel = (sources: string[]) => ({ ...run, panel: sources.map((source) => ({ provider: 'x', source, model: 'm' })) })
  assert.equal(panelNames(panel(['grok'])), 'grok')
  assert.equal(panelNames(panel(['grok', 'openrouter:a'])), 'grok and or:a')
  assert.equal(panelNames(panel(['grok', 'openrouter:a', 'codex'])), 'grok, or:a and codex')
  assert.equal(isLong('x'.repeat(LONG_TEXT)), false)
  assert.equal(isLong('x'.repeat(LONG_TEXT + 1)), true)
  const [a, b, c] = recorded
  assert.deepEqual(neighbours([a, b, c], b.id), { prev: a, next: c })
  assert.deepEqual(neighbours([a, b, c], a.id), { prev: undefined, next: b })
  assert.deepEqual(neighbours([a], 'missing'), {})
})

// GitHub-style heading anchors, enough for the headings in docs/hosts/.
const anchor = (t: string) => t.trim().toLowerCase().replace(/[^a-z0-9 -]/g, '').replace(/ /g, '-')

test('every host guide has a host-switcher entry and the install H2s the site replaces', () => {
  const hostsDir = fileURLToPath(new URL('../../docs/hosts/', import.meta.url))
  const guides = fs.readdirSync(hostsDir).filter((f) => f.endsWith('.md') && f !== 'README.md').map((f) => f.replace(/\.md$/, ''))
  assert.deepEqual(guides.sort(), Object.keys(INSTALL_SECTIONS).sort())
  for (const id of guides) {
    const h2s = fs.readFileSync(hostsDir + `${id}.md`, 'utf8').split('\n').filter((l) => l.startsWith('## ')).map((l) => anchor(l.slice(3)))
    for (const s of INSTALL_SECTIONS[id]) assert.ok(h2s.includes(s), `docs/hosts/${id}.md has "## " heading #${s}`)
    const host = HOSTS.find((h) => h.id === id)
    assert.ok(host, `site-copy HOSTS has ${id}`)
    assert.equal(host.guide, `hosts/${id}`)
    assert.ok(host.steps.length > 0)
  }
  assert.equal(hostOf('hosts/codex'), 'codex')
  assert.equal(hostOf('hosts'), null)
  assert.equal(hostOf('hosts/unknown'), null)
  assert.equal(hostOf('install'), null)
})

test('replaceSections swaps install H2s for one link and keeps their H3s', () => {
  const html =
    '<h1>T</h1><p>intro</p>' +
    '<h2 id="1-add">1. Add</h2><p>step one</p><h3 id="other-ways-to-install">Other ways</h3><p>extra</p>' +
    '<h2 id="2-rule">2. Rule</h2><p>step two</p>' +
    '<h2 id="provider-credentials">Provider credentials</h2><p>keys</p>'
  const out = replaceSections(html, ['1-add', '2-rule'], installLink('1-add', 'Cursor', '/install/#host-cursor'))
  assert.equal(
    out,
    '<h1>T</h1><p>intro</p>' +
      '<h2 id="1-add">Install</h2><p>The install steps for Cursor are on the <a href="/install/#host-cursor">install page</a>, with every other host. This page has the rest: what the plugin ships, provider keys, updating and notes.</p>' +
      '<h3 id="other-ways-to-install">Other ways</h3><p>extra</p>' +
      '<h2 id="provider-credentials">Provider credentials</h2><p>keys</p>',
  )
  assert.doesNotMatch(out, /step one|step two/)
  assert.throws(() => replaceSections(html, ['install'], 'x'), /no H2 with id install/)
})
