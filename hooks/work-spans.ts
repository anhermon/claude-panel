// How an agent's time went, by KIND of work (hooks/work-kinds.ts): a short list of spans per loop, kept by the pulse model as
// calls begin, so the mix ("60% UI, 20% tests") and the timeline cover the whole session, not just the 200 events of the ring.
// A span is a run of calls of one kind: from the first call `t` to the last call `e`, `n` calls. A span owns the time from `t`
// to the next span's start, but never more than OWN_MS after its last call (the rest of a long gap is nobody's: a hole).
// Pure: no `$`, no I/O; time comes in as an argument.
import type { WorkKind } from './work-kinds'
import { isWorkKind } from './work-kinds'

export type Span = { k: WorkKind; t: number; e: number; n: number }
/** A stretch of one kind with its place on the clock (what the timeline draws). */
export type Segment = { k: WorkKind; a: number; b: number }

export const SPAN_CAPS = {
  /** Spans kept per loop; past this the two shortest neighbours are merged. */
  MAX: 48,
  /** After its last call a span owns this much more time (the model thinking about the next step), then a hole. */
  OWN_MS: 20_000,
  /** A span shows for at least this long (a call that has just begun owns no time yet but is on the strip). */
  MIN_MS: 1000,
} as const

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** The time a span runs to: the next span's start, or `end` for the last one, but at most OWN_MS after its last call. */
export const spanEnd = (s: Span, next: Span | undefined, end: number): number => Math.max(s.e, Math.min(next?.t ?? end, s.e + SPAN_CAPS.OWN_MS))

/** A call of `kind` begins at `t`: it joins the last span of that kind when it follows closely, else starts a new span. */
export function addSpan(spans: Span[], kind: WorkKind, t: number): void {
  const last = spans[spans.length - 1]
  if (last !== undefined && last.k === kind && t - last.e <= SPAN_CAPS.OWN_MS) {
    last.e = Math.max(last.e, t)
    last.n++
    return
  }
  spans.push({ k: kind, t, e: t, n: 1 })
  if (spans.length > SPAN_CAPS.MAX) mergeShortest(spans)
}

/** A call of `kind` ended at `t`: the span it belongs to (the last one, when it is of that kind) runs at least to there. */
export function extendSpan(spans: Span[], kind: WorkKind, t: number): void {
  const last = spans[spans.length - 1]
  if (last !== undefined && last.k === kind) last.e = Math.max(last.e, t)
}

/** Merge the neighbour pair that covers the least time into one span of the kind that had more of it. */
function mergeShortest(spans: Span[]): void {
  let at = 0
  let least = Number.POSITIVE_INFINITY
  for (let i = 0; i + 1 < spans.length; i++) {
    const a = spans[i] as Span
    const b = spans[i + 1] as Span
    const size = (spans[i + 2]?.t ?? b.e) - a.t
    if (size < least) { least = size; at = i }
  }
  const a = spans[at] as Span
  const b = spans[at + 1] as Span
  const aTime = spanEnd(a, b, b.t) - a.t
  const bTime = spanEnd(b, spans[at + 2], b.e) - b.t
  spans.splice(at, 2, { k: aTime >= bTime ? a.k : b.k, t: a.t, e: b.e, n: a.n + b.n })
}

/** The spans as stretches on the clock, oldest first, each cut to [from, to]; `end` is where the last one stops (now, or the loop's last sign of life). */
export function segmentsOf(spans: readonly Span[], end: number, from = Number.NEGATIVE_INFINITY, to = Number.POSITIVE_INFINITY): Segment[] {
  const out: Segment[] = []
  spans.forEach((s, i) => {
    const a = Math.max(s.t, from)
    const b = Math.min(Math.max(spanEnd(s, spans[i + 1], end), s.t + SPAN_CAPS.MIN_MS), to)
    if (b > a) out.push({ k: s.k, a, b })
  })
  return out
}

/** Milliseconds per kind over [from, to]. */
export function timeByKind(spans: readonly Span[], end: number, from: number, to: number): Map<WorkKind, number> {
  const time = new Map<WorkKind, number>()
  for (const seg of segmentsOf(spans, end, from, to)) time.set(seg.k, (time.get(seg.k) ?? 0) + (seg.b - seg.a))
  return time
}

/** Spans read back from stored JSON: only well-formed ones, capped. */
export function restoreSpans(v: unknown): Span[] {
  if (!Array.isArray(v)) return []
  const out: Span[] = []
  for (const raw of v.slice(-SPAN_CAPS.MAX)) {
    if (raw === null || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    if (!isWorkKind(r.k) || num(r.t) <= 0 || num(r.e) < num(r.t)) continue
    out.push({ k: r.k, t: num(r.t), e: num(r.e), n: Math.max(1, Math.round(num(r.n))) })
  }
  return out
}
