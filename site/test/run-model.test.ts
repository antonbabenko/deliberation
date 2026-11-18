// The capture, the inspector and the sample-runs page are all derived by these helpers,
// so they are checked against every recorded run and against the ranges the data may take.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { type Run, blindState, closing, describe, dur, failNote, failed, issueOf, rulingsLost, rulingsText, said, segments, state, subjectKind, tally, token, tone, unrecorded, voices, windows } from '../src/lib/run-model.ts'
import { formatCount } from '../src/lib/github.ts'
import { parseAsks, parsePrompt } from '../src/lib/experts.ts'

const dir = fileURLToPath(new URL('../src/data/replay/', import.meta.url))
const recorded: Run[] = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(fs.readFileSync(dir + f, 'utf8')))

/** A run with the given shape, for ranges no recorded run covers yet. */
function synthetic(rounds: number, sources: string[], converged: boolean, verdict = 'REJECT'): Run {
  const peer = (source: string, i: number) => ({ source, provider: source.split(':')[0], model: `m${i}`, verdict, criticalIssues: [], summary: '', text: '', ms: 1000 * (i + 1) })
  return {
    id: 'synthetic', recordedAt: '2026-01-01T00:00:00Z', deliberationVersion: '0', runId: 'x', tool: 'consensus-step', expert: 'architect', question: 'q',
    subject: { type: 'question', title: 't' },
    panel: sources.map((source, i) => ({ provider: source.split(':')[0], source, model: `m${i}` })),
    limits: { maxRounds: 5 },
    rounds: Array.from({ length: rounds }, (_, i) => ({
      n: i + 1, hostBlindVerdict: { verdict, summary: '', criticalIssues: [], text: '' }, peers: sources.map(peer),
      roundMs: 1000 * sources.length, adjudication: [], hostVerdict: verdict, revision: null,
      convergence: { converged: converged && i === rounds - 1, reason: '' },
    })),
    outcome: { verdict, converged, rounds, finalReportHeadline: '' },
  }
}

test('every recorded run has the shape the pages read', () => {
  assert.ok(recorded.length > 0)
  for (const run of recorded) {
    assert.ok(run.rounds.length >= 1, run.id)
    for (const r of run.rounds) {
      for (const p of r.peers) assert.ok(run.panel.some((v) => v.source === p.source), `${run.id}: ${p.source} is on the panel`)
      // A recovered run from an engine without issue ids rules by description instead (README, Recovered runs).
      for (const a of r.adjudication)
        assert.ok(a.issueId === null ? (a as { description?: string }).description : issueOf(r, a.issueId), `${run.id}: ruling ${a.issueId} has its issue`)
    }
    assert.ok(describe(run).kind)
  }
})

test('voices in one run never share an ink while five inks last', () => {
  const runs = [...recorded, synthetic(1, ['grok', 'codex', 'gemini', 'openrouter:gpt-x', 'openrouter:gemini-y'], true)]
  for (const run of runs) {
    const inks = voices(run).map((v) => v.ink)
    assert.equal(inks[0], 'h')
    assert.equal(new Set(inks).size, inks.length, run.id)
  }
  assert.equal(voices(synthetic(1, ['grok', 'codex', 'gemini'], true)).map((v) => v.ink).join(), 'h,3,1,2')
})

test('round windows fill the track for 1 to 5 rounds', () => {
  for (let n = 1; n <= 5; n++) {
    const wins = windows(synthetic(n, ['grok', 'codex', 'gemini'], false))
    const last = wins[wins.length - 1]
    assert.equal(wins.length, n)
    assert.ok(Math.abs(last.left + last.width - 100) < 1e-6, `${n} rounds end at the right edge`)
    assert.ok(wins.every((w) => w.width > 5))
    assert.equal(last.final, true)
  }
})

test('a lane has two host marks or one answer per round, and a voice that sat a round out is skipped', () => {
  const run = synthetic(3, ['grok', 'openrouter:a', 'openrouter:b', 'codex', 'gemini', 'openrouter:c'], false)
  run.rounds[1].peers = run.rounds[1].peers.filter((p) => p.source !== 'codex')
  assert.equal(segments(run, 'host').length, 6)
  assert.equal(segments(run, 'grok').length, 3)
  assert.equal(segments(run, 'codex').length, 2)
})

test('verdict tokens, tones and subject kinds cover every value', () => {
  assert.deepEqual(['APPROVE', 'REQUEST_CHANGES', 'REJECT'].map(token), ['APPROVE', 'REQ_CHANGES', 'REJECT'])
  assert.deepEqual(['APPROVE', 'REQUEST_CHANGES', 'REJECT'].map(tone), ['ok', 'rc', 'rej'])
  assert.equal(subjectKind(synthetic(1, ['grok'], true)), 'Question')
  assert.equal(subjectKind({ ...synthetic(1, ['grok'], true), subject: { type: 'pull-request', url: 'https://github.com/o/r/pull/295', title: '' } }), 'Pull request #295')
})

test('a run that hit the round cap closes as unresolved', () => {
  const run = synthetic(5, ['grok', 'codex'], false)
  assert.equal(describe(run).outcome, 'unresolved')
  assert.equal(closing(windows(run)[4]).long, 'adjudicate, unresolved')
  assert.equal(closing(windows(run)[0]).long, 'adjudicate, next round')
})

test('durations and star counts are formatted compactly', () => {
  assert.deepEqual([450, 9446, 221161].map(dur), ['450ms', '9s', '3m 41s'])
  assert.deepEqual([0, 987, 1000, 1234, 12345, 1200000].map(formatCount), ['0', '987', '1k', '1.2k', '12k', '1.2M'])
})

test('expert name, role and example requests are parsed from the repository files', () => {
  assert.deepEqual(parsePrompt('# Architect\n\nYou are a software architect.\n\n## Context\n'), { name: 'Architect', role: 'You are a software architect.' })
  assert.equal(parsePrompt('no heading'), null)
  const asks = parseAsks('| Expert | What | Example |\n|---|---|---|\n| **Architect** | Design | "How?" / "Why?" |\n')
  assert.deepEqual(asks.get('Architect'), ['How?', 'Why?'])
})

test('a reviewer whose call failed is drawn as a timeout or a fault and is not a vote', () => {
  const run = synthetic(2, ['grok', 'codex', 'openrouter:slow'], false, 'APPROVE')
  for (const r of run.rounds) {
    Object.assign(r.peers[2], { verdict: null, summary: null, text: null, isError: true, errorKind: 'timeout', message: 'Call deadline expired', ms: 600000 })
    r.roundMs = 600000
  }
  run.rounds[1].peers[1] = { ...run.rounds[1].peers[1], verdict: null, summary: null, text: null, isError: true, errorKind: 'upstream-abort', ms: 450 }
  const [timedOut, aborted] = [run.rounds[0].peers[2], run.rounds[1].peers[1]]

  assert.deepEqual([failed(timedOut), state(timedOut), tone(state(timedOut)), token(state(timedOut))], [true, 'TIMEOUT', 'tmo', 'TIMEOUT'])
  assert.deepEqual([state(aborted), tone(state(aborted))], ['FAULT', 'err'])
  assert.equal(failNote(timedOut), 'timeout after 10m 00s')
  assert.equal(said(timedOut), 'no answer, timeout after 10m 00s')
  assert.equal(said(aborted), 'no answer, upstream-abort after 450ms')
  assert.equal(said(run.rounds[0].peers[0]), 'APPROVE in 1s')
  assert.equal(tally(run.rounds[0]), '2 of 2 approved, 1 failed')
  assert.equal(tally(run.rounds[1]), '1 of 1 approved, 2 failed')
  assert.equal(describe(run).first, 'round 1: 2 of 2 approved, 1 failed')

  const lane = segments(run, 'openrouter:slow')
  assert.equal(lane.length, 2)
  assert.deepEqual([lane[0].verdict, lane[0].note, lane[0].say], ['TIMEOUT', '10m 00s', 'no answer, timeout after 10m 00s'])
  assert.match(lane[0].text, /^TIMEOUT 10m 00s$/)
})

test('every recorded answer has a state and a label, with or without a verdict, summary or text', () => {
  for (const run of recorded) {
    for (const v of voices(run)) for (const s of segments(run, v.source)) assert.ok(s.verdict && s.say && tone(s.verdict), `${run.id}: ${v.source}`)
    for (const r of run.rounds) {
      assert.match(tally(r), /^(\d+ of \d+ approved|no verdict recorded)/)
      for (const p of r.peers) {
        assert.equal(failed(p) || unrecorded(p), p.verdict === null, `${run.id}: ${p.source} round ${r.n}`)
        if (failed(p)) assert.ok(p.errorKind, `${run.id}: ${p.source} round ${r.n} names its error`)
      }
      // An empty ruling list must say which of the two things it means.
      if (rulingsLost(r)) assert.equal(r.adjudication.length, 0, `${run.id}: round ${r.n}`)
      if (r.adjudication.length === 0 && r.peers.some((p) => p.criticalIssues.length > 0)) assert.ok(rulingsLost(r), `${run.id}: round ${r.n} has issues but no rulings`)
    }
  }
})

test('a blind verdict that was not kept is drawn as not recorded, never as a verdict', () => {
  const run = synthetic(2, ['grok', 'codex'], false, 'APPROVE')
  run.rounds[0].hostBlindVerdict = null
  const [blind, ruling, blind2] = segments(run, 'host')

  assert.equal(blindState(run.rounds[0]), 'NOT_RECORDED')
  assert.deepEqual([blind.kind, blind.verdict, tone(blind.verdict), blind.say], ['blind', 'NOT_RECORDED', 'nr', 'blind: not recorded'])
  assert.equal(blind.text, 'NOT_REC blind')
  assert.deepEqual([ruling.verdict, blind2.verdict], ['APPROVE', 'APPROVE'])
  assert.equal(segments(run, 'host').length, 4)
  assert.equal(issueOf(run.rounds[0], 'missing'), undefined)
})

test('rulings that were not kept are not read as a round with nothing to rule on', () => {
  const run = synthetic(2, ['grok', 'codex'], false, 'REQUEST_CHANGES')
  Object.assign(run.rounds[0], { adjudicationRecovered: false, acceptedIssues: 21 })
  run.rounds[1].adjudicationRecovered = false

  assert.deepEqual(run.rounds.map(rulingsLost), [true, true])
  assert.equal(rulingsText(run.rounds[0]), 'rulings not recorded, 21 issues accepted')
  assert.equal(rulingsText(run.rounds[1]), 'rulings not recorded')
  const kept = synthetic(1, ['grok'], true).rounds[0]
  assert.deepEqual([rulingsLost(kept), rulingsText(kept)], [false, '0 rulings'])
  assert.equal(rulingsText({ ...run.rounds[0], acceptedIssues: 1 }), 'rulings not recorded, 1 issue accepted')
})

test('a reviewer whose verdict was not kept is not a vote and not a failure, and keeps its time', () => {
  const run = synthetic(2, ['grok', 'codex', 'gemini'], false, 'APPROVE')
  for (const p of run.rounds[0].peers) Object.assign(p, { verdict: null, summary: null, text: null })
  Object.assign(run.rounds[1].peers[2], { verdict: null, summary: null, text: null, ms: 24060 })
  Object.assign(run.rounds[1].peers[1], { verdict: null, isError: true, errorKind: 'timeout', ms: 600000 })
  const gone = run.rounds[1].peers[2]

  assert.deepEqual([failed(gone), unrecorded(gone), state(gone), tone(state(gone)), token(state(gone))], [false, true, 'NOT_RECORDED', 'nr', 'NOT_REC'])
  assert.equal(said(gone), 'verdict not recorded, call took 24s')
  assert.deepEqual([unrecorded(run.rounds[1].peers[1]), state(run.rounds[1].peers[1])], [false, 'TIMEOUT'])
  assert.equal(tally(run.rounds[0]), 'no verdict recorded')
  assert.equal(tally(run.rounds[1]), '1 of 1 approved, 1 not recorded, 1 failed')
  assert.equal(describe(run).first, 'round 1: no verdict recorded')

  const lane = segments(run, 'gemini')
  assert.deepEqual([lane[1].verdict, lane[1].note, lane[1].say], ['NOT_RECORDED', '24s', 'verdict not recorded, call took 24s'])
  assert.match(lane[1].text, /^NOT_REC 24s$/)
})

test('the home page still opens on the same run', () => {
  const src = fs.readFileSync(fileURLToPath(new URL('../src/lib/runs.ts', import.meta.url)), 'utf8')
  assert.match(src, /DEFAULT_RUN = 'config-fail-closed'/)
  assert.ok(recorded.some((r) => r.id === 'config-fail-closed'))
})
