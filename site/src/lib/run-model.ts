// Pure helpers over one recorded run (shape: src/data/replay/README.md). No Astro
// imports, so `npm test` runs them with plain Node. Everything the capture, the
// inspector and the sample-runs page show is derived here from the data.

export type Verdict = 'APPROVE' | 'REQUEST_CHANGES' | 'REJECT'

export interface Issue {
  id: string
  category: string
  text: string
}

export interface Peer {
  source: string
  provider: string
  model: string
  reasoningEffort?: string | null
  /** null when the call failed (see `isError`), or when a recovered run kept no verdict for it. */
  verdict: string | null
  criticalIssues: Issue[]
  /** null when the reply has no summary block or line, or the call failed. */
  summary: string | null
  text: string | null
  ms: number
  /** A call that errored: no verdict, no text, and it does not count toward convergence. */
  isError?: boolean
  errorKind?: string
  message?: string
}

export interface Ruling {
  /** null in recovered runs (engine 4.0.0), which carry category and description instead. */
  issueId: string | null
  category?: string
  description?: string
  source: string
  decision: 'accept' | 'dismiss' | 'defer' | string
  reason: string
}

export interface Round {
  n: number
  /** null in a recovered run whose blind verdict was not kept. */
  hostBlindVerdict: { verdict: string; summary: string; criticalIssues: Issue[]; text: string } | null
  peers: Peer[]
  roundMs: number
  slowest?: string
  adjudication: Ruling[]
  /** false in a recovered run whose rulings existed but were not kept; `adjudication` is then empty. */
  adjudicationRecovered?: boolean
  /** How many critical issues the host accepted, when only that count survives. */
  acceptedIssues?: number
  hostVerdict: string
  revision?: string | null
  revisionSummary?: string | null
  convergence: { converged: boolean; reason: string }
}

export interface Run {
  id: string
  /** "recovered": rebuilt from an older session's logs; earlier rounds may lack reviewer text. */
  provenance?: string
  recordedAt: string
  deliberationVersion: string
  /** null in a recovered run whose loop id was not kept. */
  runId: string | null
  tool: string
  expert: string
  question: string
  subject: { type: string; url?: string; related?: string; commit?: string; title: string; short?: string }
  /** The full init prompt sent to the panel in round 1 (the diff or plan v1). */
  planUnderReview?: string
  panel: { provider: string; source: string; model: string; reasoningEffort?: string | null }[]
  notOnPanel?: { provider: string; reason: string }[]
  limits: { maxRounds: number }
  rounds: Round[]
  outcome: {
    verdict: string
    converged: boolean
    rounds: number
    confidence?: string
    finalReportHeadline: string
    openDissent?: unknown[]
    nonBlockingThemes?: { theme: string; raisedBy: string[] }[]
  }
  notes?: string[]
}

/** docs/tool-guide.md: human reports render openrouter:<alias> as or:<alias>. */
export const short = (source: string): string => source.replace(/^openrouter:/, 'or:')

export const slug = (source: string): string => source.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

/** docs/tool-guide.md: durations of 1 s or more are whole seconds with minute carry. */
export function dur(ms: number): string {
  if (!Number.isFinite(ms)) return ''
  if (ms < 1000) return `${Math.round(ms)}ms`
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}

export const word = (v: string): string => v.replace(/_/g, ' ')

/** The state of a verdict that was not kept. It is not a vote and not a failure. */
export const NOT_RECORDED = 'NOT_RECORDED'

export const failed = (p: Peer): boolean => p.isError === true

/** The call returned without an error, but a recovered run kept no verdict for it. */
export const unrecorded = (p: Peer): boolean => !failed(p) && p.verdict == null

/** What a voice returned: its verdict, TIMEOUT / FAULT when the call failed, or NOT_RECORDED. */
export const state = (p: Peer): string =>
  failed(p) ? (p.errorKind === 'timeout' ? 'TIMEOUT' : 'FAULT') : (p.verdict ?? NOT_RECORDED)

/** The host's blind verdict of a round, or NOT_RECORDED when it was not kept. */
export const blindState = (round: Round): string => round.hostBlindVerdict?.verdict ?? NOT_RECORDED

/** The rulings of this round existed but were not kept. An empty list then says nothing about the issues. */
export const rulingsLost = (round: Round): boolean => round.adjudicationRecovered === false

/** "3 rulings", or "rulings not recorded, 21 issues accepted" when only the count survives. */
export function rulingsText(round: Round): string {
  if (!rulingsLost(round)) return plural(round.adjudication.length, 'ruling')
  return `rulings not recorded${round.acceptedIssues == null ? '' : `, ${plural(round.acceptedIssues, 'issue')} accepted`}`
}

/** "timeout after 10m 00s": the error kind and how long the call ran before it ended. */
export const failNote = (p: Peer): string => `${p.errorKind ?? 'error'} after ${dur(p.ms)}`

/** One answer in words, for labels: "REQUEST CHANGES in 42s" or "no answer, timeout after 10m 00s". */
export const said = (p: Peer): string =>
  failed(p) ? `no answer, ${failNote(p)}` : unrecorded(p) ? `verdict not recorded, call took ${dur(p.ms)}` : `${word(state(p))} in ${dur(p.ms)}`

const TOKEN: Record<string, string> = { APPROVE: 'APPROVE', REQUEST_CHANGES: 'REQ_CHANGES', REJECT: 'REJECT', NOT_RECORDED: 'NOT_REC' }
/** The engine's short decode token, as the dashboard prints it. */
export const token = (v: string): string => TOKEN[v] ?? v

const TONE: Record<string, 'ok' | 'rej' | 'tmo' | 'err' | 'nr'> = { APPROVE: 'ok', REJECT: 'rej', TIMEOUT: 'tmo', FAULT: 'err', NOT_RECORDED: 'nr' }
/** Stroke class for a verdict, a failed call or a verdict that was not kept. Status never rides on colour alone. */
export const tone = (v: string): 'ok' | 'rc' | 'rej' | 'tmo' | 'err' | 'nr' => TONE[v] ?? 'rc'

export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

export const day = (run: Run): string => run.recordedAt.slice(0, 10)

export function firstSentence(t: string): string {
  const m = t.match(/^.*?[a-z)\]`](?<!e\.g)(?<!i\.e)\.(?=\s|$)/s)
  return m ? m[0] : t
}

export interface Voice {
  source: string
  label: string
  model: string
  ink: string
}

// One ink per channel, as the dashboard assigns them: blue for GPT, violet for Gemini,
// teal for Grok, magenta and indigo for the rest. Within one run a taken ink moves on
// to the next free one, so two voices never share a colour while five inks last.
const PREFERRED: [RegExp, number][] = [
  [/gpt|codex|openai/, 1],
  [/gemini|google/, 2],
  [/grok|xai/, 3],
]
const FALLBACK = [4, 5, 1, 2, 3]

export function voices(run: Run): Voice[] {
  const taken = new Set<number>()
  const pick = (source: string): number => {
    const want = PREFERRED.find(([re]) => re.test(source.toLowerCase()))?.[1]
    const ink = want && !taken.has(want) ? want : (FALLBACK.find((i) => !taken.has(i)) ?? want ?? 4)
    taken.add(ink)
    return ink
  }
  return [
    { source: 'host', label: 'host agent', model: 'arbiter, in session', ink: 'h' },
    ...run.panel.map((p) => ({
      source: p.source,
      label: short(p.source),
      model: [p.model, p.reasoningEffort].filter(Boolean).join(', '),
      ink: String(pick(p.source)),
    })),
  ]
}

export const peerOf = (round: Round, source: string): Peer | undefined => round.peers.find((p) => p.source === source)

export function issueOf(round: Round, id: string | null): Issue | undefined {
  if (!id) return undefined
  for (const p of round.peers) {
    const c = p.criticalIssues.find((x) => x.id === id)
    if (c) return c
  }
  return round.hostBlindVerdict?.criticalIssues.find((x) => x.id === id)
}

export const rulingOf = (round: Round, id: string): Ruling | undefined => round.adjudication.find((a) => a.issueId === id)

/** "Pull request #295", "Plan", "Question": what was reviewed, without its title. */
export function subjectKind(run: Run): string {
  const t = run.subject.type
  if (t === 'pull-request') {
    const n = run.subject.url?.match(/\/pull\/(\d+)/)?.[1]
    return n ? `Pull request #${n}` : 'Pull request'
  }
  return t.charAt(0).toUpperCase() + t.slice(1).replace(/-/g, ' ')
}

export const subjectUrl = (run: Run): string | undefined => run.subject.url ?? run.subject.related

/**
 * How the panel voted in a round, e.g. "2 of 4 approved, 1 failed". A failed call is not a
 * vote, and neither is a verdict that was not kept: "1 of 1 approved, 3 not recorded".
 */
export function tally(round: Round): string {
  const lost = round.peers.filter(failed).length
  const gone = round.peers.filter(unrecorded).length
  const votes = round.peers.length - lost - gone
  const ok = round.peers.filter((p) => p.verdict === 'APPROVE' && !failed(p)).length
  const head = votes === 0 && gone > 0 ? 'no verdict recorded' : `${ok} of ${votes} approved${gone ? `, ${gone} not recorded` : ''}`
  return `${head}${lost ? `, ${lost} failed` : ''}`
}

export function outcomeText(run: Run): string {
  const n = plural(run.rounds.length, 'round')
  return run.outcome.converged ? `converged in ${n}` : `unresolved after ${n}`
}

/** The fields a visitor compares runs by. The run selector prints the short title, expert and outcome. */
export function describe(run: Run) {
  return {
    kind: subjectKind(run),
    short: run.subject.short ?? run.subject.title,
    expert: run.expert,
    panel: plural(run.panel.length, 'reviewer'),
    rounds: plural(run.rounds.length, 'round'),
    outcome: run.outcome.converged ? 'converged' : 'unresolved',
    first: `round 1: ${tally(run.rounds[0])}`,
  }
}

export const panelId = (run: Run, round: Round, what: string): string => `i-${run.id}-r${round.n}-${slug(what)}`

/** Inspector panel that holds the run's question and init prompt. */
export const promptId = (run: Run): string => `i-${run.id}-prompt`

// ---- capture geometry -------------------------------------------------------------
// The track is a CSS container; positions are in cqw (percent of the track) plus fixed
// pixels for the host marks, so the same numbers hold at every width the capture shows.

export const MARK_PX = 16
const GAP = 3 // percent of the track between two round windows
const NOMINAL_TRACK_PX = 700 // narrowest track the capture is shown at; labels must fit here
const CHAR_PX = 6.7
const PAD_PX = 14

export type LabelMode = 'in' | 'out' | 'time' | 'bare'

export interface Window {
  round: Round
  left: number
  width: number
  px: number
  final: boolean
}

export interface Segment {
  kind: 'blind' | 'peer' | 'ruling'
  round: Round
  verdict: string
  /** CSS for the true signal width and the left edge inside the track. */
  left: string
  width: string
  text: string
  note: string
  /** The answer in words, for the accessible name. */
  say: string
  mode: LabelMode
}

/** Round windows: half the track is shared equally, half follows recorded wall time. */
export function windows(run: Run): Window[] {
  const n = run.rounds.length
  const usable = 100 - GAP * (n - 1)
  const total = run.rounds.reduce((a, r) => a + (r.roundMs || 0), 0)
  let left = 0
  return run.rounds.map((round, i) => {
    const share = total > 0 ? (round.roundMs || 0) / total : 1 / n
    const width = usable * (0.5 / n + 0.5 * share)
    const w = { round, left, width, px: (width / 100) * NOMINAL_TRACK_PX, final: i === n - 1 }
    left += width + GAP
    return w
  })
}

const textPx = (s: string): number => s.length * CHAR_PX + PAD_PX
const r2 = (n: number): string => n.toFixed(2)

/** Segments of one lane: two host marks per round, or one answer per round for a peer. */
export function segments(run: Run, source: string, wins: Window[] = windows(run)): Segment[] {
  const out: Segment[] = []
  for (const w of wins) {
    const r = w.round
    if (source === 'host') {
      const bv = blindState(r)
      const blind = `${token(bv)} blind`
      const ruling = `${token(r.hostVerdict)} ruling`
      const room = w.px - 2 * MARK_PX - 16
      const mode: LabelMode = room >= textPx(blind) + textPx(ruling) ? 'out' : room >= textPx('blind') + textPx('ruling') ? 'time' : 'bare'
      out.push({ kind: 'blind', round: r, verdict: bv, left: `${r2(w.left)}cqw`, width: `${MARK_PX}px`, text: blind, note: 'blind', say: `blind: ${bv === NOT_RECORDED ? 'not recorded' : word(bv)}`, mode })
      out.push({ kind: 'ruling', round: r, verdict: r.hostVerdict, left: `calc(${r2(w.left + w.width)}cqw - ${MARK_PX}px)`, width: `${MARK_PX}px`, text: ruling, note: 'ruling', say: `ruling: ${word(r.hostVerdict)}`, mode })
      continue
    }
    const p = peerOf(r, source)
    if (!p) continue
    const f = r.roundMs > 0 ? Math.min(1, Math.max(0, p.ms / r.roundMs)) : 1
    const zone = w.px - 2 * MARK_PX
    const segPx = Math.max(6, zone * f)
    const note = dur(p.ms)
    const text = `${token(state(p))} ${note}`
    const mode: LabelMode =
      segPx >= textPx(text) ? 'in' : segPx + 6 + textPx(text) <= zone ? 'out' : segPx + 6 + textPx(note) <= zone ? 'time' : 'bare'
    out.push({
      kind: 'peer',
      round: r,
      verdict: state(p),
      left: `calc(${r2(w.left)}cqw + ${MARK_PX}px)`,
      width: `max(6px, calc((${r2(w.width)}cqw - ${2 * MARK_PX}px) * ${f.toFixed(4)}))`,
      text,
      note,
      say: said(p),
      mode,
    })
  }
  return out
}

/** Label of the trigger that closes a round window, sized to the window. */
export function closing(w: Window): { text: string; long: string } {
  const r = w.round
  const state = r.convergence.converged ? 'converged' : r.revision ? 'revise' : w.final ? 'unresolved' : 'next round'
  const long = `adjudicate, ${state}`
  return { long, text: w.px >= 300 ? long : w.px >= 150 ? state : '' }
}

/** The issue a ruling decided: by id, or by the description a recovered run keeps instead. */
export function rulingIssue(round: Round, a: Ruling): { category: string; text: string } | undefined {
  return issueOf(round, a.issueId) ?? (a.description ? { category: a.category ?? '', text: a.description } : undefined)
}

/** Who raised a ruled issue. Recovered runs may name several voices, comma-joined, or a bare alias such as glm. */
export function raisedBy(vs: Voice[], source: string): { label: string; ink: string } {
  const host = vs.find((v) => v.source === 'host')
  const one = (s: string): Voice | undefined =>
    s === 'host' || s === 'claude'
      ? host
      : vs.find((v) => v.source === s || v.source.endsWith(`:${s}`) || (v.source.split(':').pop() ?? '').startsWith(`${s}-`))
  const parts = source.split(',').map((s) => s.trim()).filter(Boolean)
  const found = parts.map(one)
  return {
    label: parts.map((s, i) => found[i]?.label ?? s).join(', '),
    ink: parts.length === 1 && found[0] ? found[0].ink : 'h',
  }
}
