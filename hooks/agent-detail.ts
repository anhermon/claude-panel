// The detail of ONE agent for the drill-down of the Agents scene (live/detail.json), pure: no `$`, no I/O. Three parts, all from real
// data: the TRANSCRIPT (a piece of the agent's own transcript, ./transcript-parse.ts, redacted by ./transcript-redact.ts), the METRICS
// (tokens over time, how the time split by kind of work, tool mix, files touched, errors; mostly the pulse's own per-loop record
// that covers the whole run since the mod loaded, plus the transcript's token steps) and the STRUGGLES (errors, retries, the same
// file read or edited again and again, slow calls, stretches with no activity; listed only when they happened) and the PROGRESS (what it
// does now, its checklist, what is done, what it decided, what is wrong: ./agent-progress.ts and ./agent-struggles.ts). Nothing here is a
// guess: a number the data does not hold is null and the page says "not measured".
import { spoken } from './agent-evidence'
import { endOf, spansOf } from './agent-insight'
import { progressOf } from './agent-progress'
import type { AgentProgress, LaneInfo } from './agent-progress'
import { SLOW_CALL_MS, STALL_MS, struggleReportOf } from './agent-struggles'
import type { StruggleReport } from './agent-struggles'
import type { PulseEvent, PulseLoop } from './pulse-model'
import { splitKey, TALLY_VERBS } from './pulse-tally'
import { timeByKind } from './work-spans'
import { KIND_META, WORK_KINDS } from './work-kinds'
import type { Entry, Parsed, ToolEntry } from './transcript-parse'

export const DETAIL_VERSION = 1
export const DETAIL_CAPS = {
  /** Transcript entries per page (a page is also this many more when the person asks for earlier ones). */
  PAGE_ENTRIES: 40,
  /** At most this many pages (the tail read grows with them, see the host). */
  MAX_PAGES: 8,
  /** Points of the token curve. */
  SERIES_POINTS: 40,
  TOOLS: 8,
  FILES: 8,
  /** The errors listed with their message. */
  ERRORS: 5,
} as const
export { SLOW_CALL_MS, spoken, STALL_MS }
const FILE_KEY_VERBS: readonly string[] = [TALLY_VERBS.READ, TALLY_VERBS.EDIT]

/** What the detail needs to know of the agent's row (the board's, see ./agents-info-data.ts). */
export type DetailSubject = { id: string; name: string; isMain: boolean; state: string; startedAt: number; endedAt: number | null }

/** What the host read of the transcript: the parsed tail, and the facts that say how much of the file that is. */
export type TranscriptRead = {
  parsed: Parsed
  /** The first line of the file (the brief), '' when not read. */
  head: string
  /** The same brief with its line breaks (for the checklist), '' when not read. */
  headFull?: string
  /** The tail covers the whole file. */
  isWhole: boolean
  fileBytes: number
  readBytes: number
}

export type SeriesPoint = { t: number; tokens: number }
export type AgentDetail = {
  v: typeof DETAIL_VERSION
  id: string
  name: string
  isMain: boolean
  state: string
  startedAt: number
  endedAt: number | null
  updatedAt: number
  brief: string
  transcript: {
    isAvailable: boolean
    /** Why not (the file was not found, the tool could not run), '' when available. */
    reason: string
    /** Not available, but `entries` still lists the calls the pulse recorded for this agent (no text, no durations): what IS known. */
    isFromPulse: boolean
    entries: Entry[]
    /** Entries older than these are available (a bigger page) or the tail did not reach the file's start. */
    hasMore: boolean
    pages: number
    /** How much of the file was read, for the caption. */
    isWhole: boolean
    fromT: number | null
    toT: number | null
  }
  metrics: {
    elapsedMs: number
    activeMs: number
    idleMs: number
    calls: number
    /** The pulse's count of failed calls with a target, retries among them; null when the pulse has no tally. */
    errors: number | null
    retries: number | null
    tokens: { total: number | null; series: SeriesPoint[]; steps: number; coveredFromT: number | null }
    kinds: { kind: string; label: string; color: string; ms: number }[]
    tools: { tool: string; n: number }[]
    files: { name: string; reads: number; edits: number }[]
  }
  /** What went wrong, with evidence (./agent-struggles.ts). */
  struggles: StruggleReport
  /** The first tab (./agent-progress.ts). */
  progress: AgentProgress
}

const isToolEntry = (e: Entry): e is ToolEntry => e.kind === 'tool'
/** An entry as the page gets it: the evidence fields (command, path, result digest) stay in the mod. */
const plainEntry = (e: Entry): Entry => {
  if (e.kind !== 'tool') return e
  const { act, path, cmd, exit, out, ...plain } = e
  return plain
}
const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0)

/** The cumulative tokens (fresh + generated, the cache re-reads left out like everywhere else) after each model request, thinned to SERIES_POINTS. */
export function tokenSeries(steps: Parsed['steps']): SeriesPoint[] {
  let running = 0
  const all = steps.map(s => ({ t: s.t, tokens: (running += s.fresh + s.output) }))
  if (all.length <= DETAIL_CAPS.SERIES_POINTS) return all
  const stride = (all.length - 1) / (DETAIL_CAPS.SERIES_POINTS - 1)
  return Array.from({ length: DETAIL_CAPS.SERIES_POINTS }, (_, i) => all[Math.round(i * stride)] as SeriesPoint)
}

function kindsOf(loop: PulseLoop | undefined, events: readonly PulseEvent[], now: number): AgentDetail['metrics']['kinds'] {
  if (loop === undefined) return []
  const end = endOf(loop, now)
  const time = timeByKind(spansOf(loop, events), end, loop.startedAt, end)
  return WORK_KINDS.filter(k => (time.get(k) ?? 0) > 0)
    .map(k => ({ kind: k, label: KIND_META[k].label, color: KIND_META[k].color, ms: time.get(k) ?? 0 }))
    .sort((a, b) => b.ms - a.ms)
}

function filesOf(loop: PulseLoop | undefined): AgentDetail['metrics']['files'] {
  const by = new Map<string, { name: string; reads: number; edits: number }>()
  for (const [key, entry] of Object.entries(loop?.tally ?? {})) {
    const { verb, target } = splitKey(key)
    if (!FILE_KEY_VERBS.includes(verb)) continue
    const file = by.get(target) ?? { name: target, reads: 0, edits: 0 }
    if (verb === TALLY_VERBS.READ) file.reads += entry.n
    else file.edits += entry.n
    by.set(target, file)
  }
  return [...by.values()].sort((a, b) => b.reads + b.edits - (a.reads + a.edits)).slice(0, DETAIL_CAPS.FILES)
}

/** The label of a pulse call that failed (the pulse keeps no message). */
const FAILED_CALL = 'call failed'
/** The pulse's own entry for handing work to another agent: not a tool call of the agent that is open. */
const PULSE_SPAWN_TOOL = 'spawn'

/**
 * What the pulse knows of `loop` when there is no transcript: its tool calls as transcript entries (tool + target, failed or not; the
 * pulse keeps neither durations nor words), oldest first. Empty when the pulse forgot the loop.
 */
export function pulseEntriesOf(loop: PulseLoop | undefined, events: readonly PulseEvent[]): ToolEntry[] {
  if (loop === undefined) return []
  const own = events
    .filter(e => e.loop === loop.id && e.tool !== PULSE_SPAWN_TOOL)
    .map((e): ToolEntry => ({ t: e.t, kind: 'tool', tool: e.tool, label: e.target, ms: null, error: e.err === true ? FAILED_CALL : null }))
  // The event ring is short and shared by every loop: an old call may have left it, but the loop's own record still names its last call.
  if (own.length === 0 && loop.lastTool !== '') return [{ t: loop.lastAt, kind: 'tool', tool: loop.lastTool, label: loop.lastTarget, ms: null, error: null }]
  return own
}

const clampPages = (pages: number): number => (Number.isFinite(pages) ? Math.min(Math.max(1, Math.floor(pages)), DETAIL_CAPS.MAX_PAGES) : 1)

/** The tail of `entries` that is `pages` pages long, and whether there are older ones in what was read. */
export function pageOf(entries: readonly Entry[], pages: number): { shown: Entry[]; hasOlder: boolean } {
  const size = clampPages(pages) * DETAIL_CAPS.PAGE_ENTRIES
  return { shown: entries.slice(-size), hasOlder: entries.length > size }
}

/**
 * The whole detail of one agent. `loop` is the pulse's record of it (undefined when the pulse forgot it), `read` what the host got from its
 * transcript (null: none; `unavailable` says why). Pure: the same inputs give the same detail.
 */
export function buildDetail(args: {
  subject: DetailSubject
  loop: PulseLoop | undefined
  events: readonly PulseEvent[]
  read: TranscriptRead | null
  unavailable: string
  pages: number
  now: number
  /** The lane the agent posted (dod / step / note), when it posted one. */
  lane?: LaneInfo
}): AgentDetail {
  const { subject, loop, events, read, now } = args
  const pulseEntries = read === null ? pulseEntriesOf(loop, events) : []
  const entries: Entry[] = read?.parsed.entries ?? pulseEntries
  const { shown, hasOlder } = pageOf(entries, args.pages)
  const end = subject.endedAt ?? now
  const kinds = kindsOf(loop, events, now)
  const activeMs = sum(kinds.map(k => k.ms))
  const elapsedMs = Math.max(0, end - subject.startedAt)
  const steps = read?.parsed.steps ?? []
  const lastUser = [...entries].reverse().find(e => e.kind === 'user')
  const brief = subject.isMain ? (lastUser?.kind === 'user' ? lastUser.text : '') : (read?.parsed.brief ?? '') || (read?.head ?? '') || (read === null ? (loop?.intent ?? '') : '')
  const tally = Object.values(loop?.tally ?? {})
  const briefFull = subject.isMain ? brief : (read?.parsed.briefFull ?? '') || (read?.headFull ?? '') || brief
  const isRunning = subject.endedAt === null && subject.state !== 'done'
  return {
    v: DETAIL_VERSION,
    id: subject.id,
    name: subject.name,
    isMain: subject.isMain,
    state: subject.state,
    startedAt: subject.startedAt,
    endedAt: subject.endedAt,
    updatedAt: now,
    brief,
    transcript: {
      isAvailable: read !== null,
      reason: read === null ? args.unavailable : '',
      isFromPulse: pulseEntries.length > 0,
      entries: shown.map(plainEntry),
      hasMore: hasOlder || (read !== null && !read.isWhole),
      pages: clampPages(args.pages),
      isWhole: read?.isWhole ?? false,
      fromT: shown[0]?.t ?? null,
      toT: shown[shown.length - 1]?.t ?? null,
    },
    metrics: {
      elapsedMs,
      activeMs: Math.min(activeMs, elapsedMs),
      idleMs: Math.max(0, elapsedMs - activeMs),
      calls: loop?.calls ?? entries.filter(isToolEntry).length,
      errors: loop?.tally === undefined ? null : sum(tally.map(e => e.err)),
      retries: loop?.tally === undefined ? null : sum(tally.map(e => e.retry)),
      tokens: {
        total: loop?.tokens ?? (steps.length > 0 ? sum(steps.map(s => s.fresh + s.output)) : null),
        series: tokenSeries(steps),
        steps: steps.length,
        coveredFromT: steps[0]?.t ?? null,
      },
      kinds,
      tools: Object.entries(loop?.counts ?? {}).map(([tool, n]) => ({ tool, n })).sort((a, b) => b.n - a.n).slice(0, DETAIL_CAPS.TOOLS),
      files: filesOf(loop),
    },
    // Struggles and progress read the transcript's own entries only: the pulse's stand-ins carry no durations or messages, and its tally says the rest.
    struggles: struggleReportOf(read?.parsed.entries ?? [], { now, isRunning }),
    progress: progressOf({ entries: read?.parsed.entries ?? [], brief: briefFull, lane: args.lane, state: subject.state, endedAt: subject.endedAt, now }),
  }
}
