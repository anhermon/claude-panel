// Where the agents' TIME went, by kind of work, from the spans the pulse keeps per loop (hooks/work-spans.ts): the `kindstack`
// frame (one stacked bar per agent) and the `sinks` frame (all agents together, ranked, plus the longest stretches in sentences).
// Pure: no `$`, no I/O, time comes in as an argument. What is NOT measurable and so never claimed: which folder or file a
// stretch was spent in (the pulse keeps a class of folder, never a name) and tokens per kind (the model reports tokens per agent,
// so the sinks split them by time share and say so).
import type { BoardFrame, InsightKind, KindStackItem, SinkItem } from '../types'
import { endOf, spansOf } from './agent-insight'
import { clipTitle, plainTitle, PLACEHOLDER_BASE, uniqueTitles } from './agent-names'
import { FRAME_CAPS } from './board-frames'
import { formatDuration, formatTokens, MS_PER_SECOND, percentOf, percentShares, plural } from './insight-format'
import { panelConfig } from './panel-config'
import { MAIN_LOOP } from './pulse-model'
import type { PulseEvent, PulseLoop } from './pulse-model'
import { KIND_META } from './work-kinds'
import type { WorkKind } from './work-kinds'
import { SPAN_CAPS, spanEnd, timeByKind } from './work-spans'
import type { Span } from './work-spans'

export const TIME_FRAME_IDS = { BY_KIND: 'time-by-kind', SINKS: 'time-sinks' } as const
export const TIME_CAPS = {
  /** Rows of the stacked bars (the busiest agents). */
  BAR_ROWS: 8,
  /** Kinds ranked in the sinks. */
  SINK_ROWS: 6,
  /** Longest single stretches named in sentences. */
  STRETCHES: 3,
  /** A stretch shorter than this is not a "long" one. */
  STRETCH_MIN_MS: 60_000,
  /** A slice shorter than this is not drawn. */
  SLICE_MIN_MS: 1000,
  LABEL_CHARS: FRAME_CAPS.INSIGHT_LABEL_CHARS,
  NOTE_CHARS: 140,
  HEADLINE_CHARS: 160,
} as const
export const MAIN_NAME = 'Main session'
const BY_KIND_TITLE = 'Time by kind of work, per agent'
const SINKS_TITLE = 'Where agent time went'

/** One agent (or the main session when there is no agent) with its time split by kind. */
export type Subject = {
  loop: PulseLoop
  name: string
  spans: Span[]
  end: number
  /** ms per kind of work, `thinking` (pauses the spans do not own) included. */
  byKind: Map<InsightKind, number>
  /** All of it in ms. */
  totalMs: number
  tokens: number | null
}

/** The agents the insight is about: every agent loop of the session, or the main session when it is alone. */
export function pickLoops(loops: readonly PulseLoop[]): PulseLoop[] {
  const agents = loops.filter(l => l.kind !== 'main' && l.id !== MAIN_LOOP)
  return agents.length > 0 ? agents : loops.filter(l => l.id === MAIN_LOOP)
}

/** Full source names, cleaned before clipping; repeats also includes loops without measurable spans. */
export function loopNames(loops: readonly PulseLoop[], max = Number.MAX_SAFE_INTEGER): Map<string, string> {
  const names = uniqueTitles(loops.map(loop => loop.id === MAIN_LOOP ? MAIN_NAME : plainTitle(loop.name ?? loop.label, false) || PLACEHOLDER_BASE), max)
  return new Map(loops.map((loop, i) => [loop.id, names[i]!]))
}

/** The time split of every picked loop that has done enough to say something (at least `insightMinMs` in all), longest first. */
export function subjectsOf(loops: readonly PulseLoop[], events: readonly PulseEvent[], now: number): Subject[] {
  const out: Subject[] = []
  const picked = pickLoops(loops)
  const names = loopNames(picked)
  for (const loop of picked) {
    const spans = spansOf(loop, events)
    if (spans.length === 0) continue
    const end = endOf(loop, now)
    const byKind = new Map<InsightKind, number>(timeByKind(spans, end, loop.startedAt, end))
    const active = [...byKind.values()].reduce((a, b) => a + b, 0)
    const pause = Math.max(0, end - loop.startedAt - active)
    if (pause >= TIME_CAPS.SLICE_MIN_MS) byKind.set('thinking', pause)
    const totalMs = active + (byKind.get('thinking') ?? 0)
    if (totalMs < panelConfig.insightMinMs) continue
    out.push({ loop, name: names.get(loop.id)!, spans, end, byKind, totalMs, tokens: (loop.tokens ?? 0) > 0 ? (loop.tokens ?? null) : null })
  }
  return out.sort((a, b) => b.totalMs - a.totalMs)
}

const kindsOf = (byKind: ReadonlyMap<InsightKind, number>): InsightKind[] =>
  [...byKind.keys()].filter(k => (byKind.get(k) ?? 0) >= TIME_CAPS.SLICE_MIN_MS).sort((a, b) => (byKind.get(b) ?? 0) - (byKind.get(a) ?? 0))

const pauseSeconds = SPAN_CAPS.OWN_MS / MS_PER_SECOND
/** The method behind the numbers, one muted line under the chart (never a paragraph above it). */
const FOOTS = {
  byKind: `Thinking = pauses of ${pauseSeconds} s or more between actions`,
  sinks: "Tokens are estimated from each agent's share of time",
} as const
const TOKENS_ESTIMATE_MARK = '~'
const META_JOIN = ' · '
const TOKENS_WORD = ' tokens'
const TOKENS_SHORT = ' tok'
/** A kind must lead in this many agents before the by-kind headline says so. */
const LEAD_MIN_AGENTS = 2

/** The finding of the `time-by-kind` frame: who took the longest, and the kind that led most agents. */
export function byKindHeadline(subjects: readonly Subject[]): string {
  const top = subjects[0]
  if (top === undefined) return ''
  const total = subjects.reduce((a, s) => a + s.totalMs, 0)
  const topKind = kindsOf(top.byKind)[0]
  if (subjects.length === 1) return `${top.name} spent ${formatDuration(top.totalMs)}, mostly ${topKind === undefined ? 'working' : KIND_META[topKind].label}`
  const leads = new Map<InsightKind, number>()
  for (const s of subjects) {
    const k = kindsOf(s.byKind)[0]
    if (k !== undefined) leads.set(k, (leads.get(k) ?? 0) + 1)
  }
  const lead = [...leads].sort((a, b) => b[1] - a[1])[0]
  const led = lead !== undefined && lead[1] >= LEAD_MIN_AGENTS ? `; ${KIND_META[lead[0]].label} led in ${lead[1]} of ${subjects.length} agents` : ''
  return `${top.name} took longest: ${formatDuration(top.totalMs)}, ${percentOf(top.totalMs, total)}% of agent time${led}`
}

/** The `time-by-kind` frame: one stacked bar per agent, its slices in seconds and in words; undefined while no agent has enough to show. */
export function kindStackFrame(subjects: readonly Subject[]): BoardFrame | undefined {
  const picked = subjects.slice(0, TIME_CAPS.BAR_ROWS)
  const names = uniqueTitles(picked.map(s => s.name), TIME_CAPS.LABEL_CHARS)
  const items: KindStackItem[] = picked.map((s, i) => ({
    label: names[i]!,
    total: formatDuration(s.totalMs),
    ...(s.tokens === null ? {} : { tokens: formatTokens(s.tokens) }),
    segs: kindsOf(s.byKind).map(k => ({ k, s: Math.round((s.byKind.get(k) ?? 0) / MS_PER_SECOND), text: formatDuration(s.byKind.get(k) ?? 0) })),
  }))
  return items.length === 0 ? undefined : { id: TIME_FRAME_IDS.BY_KIND, type: 'kindstack', title: BY_KIND_TITLE, size: 'l', caption: clipTitle(byKindHeadline(subjects), TIME_CAPS.HEADLINE_CHARS), foot: FOOTS.byKind, items }
}

type Sink = { kind: InsightKind; ms: number; agents: number; tokens: number }

/** Time, number of agents and estimated tokens per kind over all subjects, largest first. */
export function sinksOf(subjects: readonly Subject[]): Sink[] {
  const by = new Map<InsightKind, Sink>()
  for (const s of subjects)
    for (const [kind, ms] of s.byKind) {
      if (ms < TIME_CAPS.SLICE_MIN_MS) continue
      const sink = by.get(kind) ?? { kind, ms: 0, agents: 0, tokens: 0 }
      sink.ms += ms
      sink.agents++
      sink.tokens += s.tokens === null ? 0 : (s.tokens * ms) / s.totalMs
      by.set(kind, sink)
    }
  return [...by.values()].sort((a, b) => b.ms - a.ms)
}

const lowerFirst = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1)

type Stretch = { name: string; kind: WorkKind; ms: number; calls: number }

/** The longest single stretches of one kind in a row (a span: calls of one kind close together), longest first. */
export function stretchesOf(subjects: readonly Subject[]): Stretch[] {
  const all: Stretch[] = []
  for (const s of subjects)
    s.spans.forEach((span, i) => {
      const ms = spanEnd(span, s.spans[i + 1], s.end) - span.t
      if (ms >= TIME_CAPS.STRETCH_MIN_MS) all.push({ name: s.name, kind: span.k, ms, calls: span.n })
    })
  return all.sort((a, b) => b.ms - a.ms).slice(0, TIME_CAPS.STRETCHES)
}

/** One compact line per stretch: `14 min 22 s writing logic · Fix parser edge cases` (the number of actions is not worth a line). */
export const stretchNotes = (subjects: readonly Subject[]): string[] =>
  stretchesOf(subjects).map(x => clipTitle(`${formatDuration(x.ms)} ${lowerFirst(KIND_META[x.kind].headline)} · ${x.name}`, TIME_CAPS.NOTE_CHARS))

/** The finding of the `time-sinks` frame: the biggest kind's share, and the longest stretch with the agent that spent it. */
export function sinksHeadline(sinks: readonly Sink[], total: number, stretch: Stretch | undefined): string {
  const top = sinks[0]
  if (top === undefined) return ''
  const share = `${KIND_META[top.kind].label} took ${percentOf(top.ms, total)}% of agent time`
  const long = stretch === undefined ? '' : `; ${stretch.name} spent ${formatDuration(stretch.ms)} in a row ${lowerFirst(KIND_META[stretch.kind].headline)}`
  return `${share}${long}`
}

/** The `time-sinks` frame: kinds ranked by their share of all agent time, with the longest stretches under them; undefined without time. */
export function sinksFrame(subjects: readonly Subject[]): BoardFrame | undefined {
  const all = sinksOf(subjects)
  const sinks = all.slice(0, TIME_CAPS.SINK_ROWS)
  if (sinks.length === 0) return undefined
  const total = subjects.reduce((a, s) => a + s.totalMs, 0)
  // all kinds shown: the shares add up to exactly 100; some left out: each keeps its true share of ALL time
  const pcts = sinks.length === all.length ? percentShares(sinks.map(s => s.ms)) : sinks.map(s => percentOf(s.ms, total))
  const items: SinkItem[] = sinks.map((s, i) => ({
    k: s.kind,
    pct: pcts[i] ?? 0,
    text: `${formatDuration(s.ms)} across ${plural(s.agents, 'agent')}${s.tokens > 0 ? ` · about ${formatTokens(s.tokens)} (estimated)` : ''}`,
    time: formatDuration(s.ms),
    meta: [plural(s.agents, 'agent'), s.tokens > 0 ? `${TOKENS_ESTIMATE_MARK}${formatTokens(s.tokens).replace(TOKENS_WORD, TOKENS_SHORT)}` : ''].filter(m => m !== '').join(META_JOIN),
  }))
  const notes = stretchNotes(subjects)
  const caption = clipTitle(sinksHeadline(sinks, total, stretchesOf(subjects)[0]), TIME_CAPS.HEADLINE_CHARS)
  return { id: TIME_FRAME_IDS.SINKS, type: 'sinks', title: SINKS_TITLE, size: 'l', caption, foot: FOOTS.sinks, items, ...(notes.length === 0 ? {} : { notes }) }
}

/** The time of one kind over all subjects. */
export const kindMs = (subjects: readonly Subject[], kind: InsightKind): number => subjects.reduce((a, s) => a + (s.byKind.get(kind) ?? 0), 0)
