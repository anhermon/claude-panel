// What an agent is REALLY doing, in plain words, computed from the pulse data the board already gets (a loop, its spans and its
// events: tool name + short redacted target, nothing else). Pure: no `$`, no I/O, time comes in as an argument. Per agent:
//   kind      what KIND of work it does now (hooks/work-kinds.ts: ui, logic, tests, visual, docs, research, reading, delegating,
//             working; thinking / waiting / done for the rest) and `headline`, the sentence of its row ("Writing UI · board.css")
//   strip     the activity over time, one letter per time bucket (a kind's letter): what it mostly did in that slice
//   mix       what share of its last minutes went to which kind
//   files     up to FILES_MAX basenames it touched, newest first
//   feed      the last few actions collapsed into phrases ("read 4 files", "edited board.js", "ran tests"), newest first
// plus the tokens its requests used (when known). The raw tool and the shell word never leave this file.
import { isNotStartedLoop } from './not-started'
import type { AgentInsight, InsightKind } from '../types'
import type { PulseEvent, PulseLoop } from './pulse-model'
import { KIND_META, KIND_ORDER, KIND_WEIGHT, STRIP_NONE, isWrite, kindOf } from './work-kinds'
import type { WorkKind } from './work-kinds'
import { addSpan, segmentsOf, SPAN_CAPS, timeByKind } from './work-spans'
import type { Span } from './work-spans'

export const INSIGHT_CAPS = {
  /** Time buckets of the activity strip. */
  STRIP_BUCKETS: 24,
  /** The strip covers the last this-long of the agent's life (all of it when it lived shorter). */
  STRIP_WINDOW_MS: 6 * 60_000,
  /** A strip never covers less than this (a young agent would otherwise get buckets of a few ms). */
  STRIP_MIN_SPAN_MS: 10_000,
  /** The mix is the share of the last this-long of the agent's time. */
  MIX_WINDOW_MS: 10 * 60_000,
  /** The kind now is the dominant kind of the last this-many calls. */
  PHASE_EVENTS: 8,
  /** A running agent with no call for this long (and none in flight) is thinking. */
  THINK_AFTER_MS: 20_000,
  /** The feed collapses the last this-many feed events ... */
  FEED_EVENTS: 8,
  /** ... into at most this many phrases. */
  FEED_PHRASES: 3,
  FILES_MAX: 3,
  FILE_CHARS: 28,
  PHRASE_CHARS: 32,
  /** The headline names at most this many files, and is at most this long. */
  HEADLINE_FILES: 2,
  HEADLINE_CHARS: 56,
} as const

const SEPARATOR = ' '
const HEADLINE_JOIN = ' · '
const NAMES_JOIN = ', '
const PERCENT = 100
const ELLIPSIS = '…'
const SPAWN_TOOL = 'spawn'

// ---- the feed's phrases (what a call is, in plain words) --------------------------------------------------------------------
const BASH = 'Bash'
/** Programs that check or build and the phrase for each (a test run is `tests` by kind; the phrase says which check). */
const BASH_CHECKERS: Readonly<Record<string, string>> = {
  tsc: 'type-checked', vitest: 'ran tests', jest: 'ran tests', pytest: 'ran tests', mocha: 'ran tests', playwright: 'ran tests', cypress: 'ran tests',
  eslint: 'linted', prettier: 'formatted', make: 'built', cargo: 'built', gradle: 'built', mvn: 'built', xcodebuild: 'built', webpack: 'built', vite: 'built', esbuild: 'built', rollup: 'built',
}
/** The verbs of a Bash target (`npm test`, see pulse-redact BASH_VERBS) and the phrase for each. */
const VERB_PHRASE: Readonly<Record<string, string>> = { test: 'ran tests', tests: 'ran tests', build: 'built', lint: 'linted', typecheck: 'type-checked', check: 'ran checks', render: 'rendered a page' }
const BASH_PHRASE: Readonly<Record<string, string>> = { git: 'used git' }
const PHRASE_SCRIPT = 'ran a script'
const PHRASE_COMMAND = 'ran a command'
const SCRIPT_RUNNERS: readonly string[] = ['node', 'npx', 'npm', 'pnpm', 'yarn', 'bun', 'tsx', 'python', 'python3', 'deno']
const PHRASE_LOOK = 'browsed files'
const PHRASE_SEARCH = 'searched the code'
const PHRASE_WEB = 'searched the web'
const PHRASE_DELEGATE = 'handed work to an agent'
const PHRASE_BROWSER = 'used the browser'
const PHRASE_SCENE = 'showed it in the panel'
const BROWSER_PREFIX = 'mcp__claude-in-chrome__'
const SCENE_PREFIX = 'mcp__panel__scene'
const LOOKERS: readonly string[] = ['cat', 'sed', 'grep', 'rg', 'head', 'tail', 'ls', 'find', 'wc', 'awk', 'jq', 'sort', 'file', 'stat', 'diff', 'tree', 'du', 'less', 'nl', 'cut', 'uniq', 'xxd', 'pwd', 'which', 'tr', 'column', 'fd']
/** A group (consecutive steps with the same key) says "<verb> <name>" for one file and "<verb> <n> files" for several. */
const GROUP_VERB: Readonly<Record<string, string>> = { read: 'read', edited: 'edited', wrote: 'wrote' }
const FILE_GROUPS: readonly string[] = Object.keys(GROUP_VERB)

type Step = { kind: WorkKind; group: string; target: string; err: boolean; t: number }

/** A table lookup that never reaches the prototype (`constructor` is not a program we know). */
const own = (table: Readonly<Record<string, string>>, key: string): string | undefined => (Object.hasOwn(table, key) ? table[key] : undefined)
const programOf = (target: string): string => target.split(SEPARATOR)[0] ?? ''
const verbOf = (target: string): string => target.split(SEPARATOR)[1] ?? ''

/** The feed phrase group of a tool call, or '' for a call there is nothing plain to say about. */
function groupOf(tool: string, target: string): string {
  if (tool === 'Read' || tool === 'NotebookRead') return 'read'
  if (tool === 'Grep' || tool === 'Glob' || tool === 'LS') return PHRASE_SEARCH
  if (tool === 'WebSearch' || tool === 'WebFetch') return PHRASE_WEB
  if (tool === 'Write') return 'wrote'
  if (tool === 'Edit' || tool === 'MultiEdit' || tool === 'NotebookEdit') return 'edited'
  if (tool === 'Agent' || tool === 'Task' || tool === 'SendMessage' || tool === SPAWN_TOOL) return PHRASE_DELEGATE
  if (tool.startsWith(BROWSER_PREFIX)) return PHRASE_BROWSER
  if (tool.startsWith(SCENE_PREFIX)) return PHRASE_SCENE
  if (tool !== BASH) return ''
  const program = programOf(target)
  const phrase = own(VERB_PHRASE, verbOf(target)) ?? own(BASH_CHECKERS, program)
  if (phrase !== undefined) return phrase
  if (LOOKERS.includes(program)) return PHRASE_LOOK
  return own(BASH_PHRASE, program) ?? (SCRIPT_RUNNERS.includes(program) ? PHRASE_SCRIPT : PHRASE_COMMAND)
}

/** The step a tool call is (the event's own kind, else worked out from tool and target), or undefined for bookkeeping. */
export function stepOf(ev: Pick<PulseEvent, 't' | 'tool' | 'target' | 'err' | 'kind'>): Step | undefined {
  const kind = ev.kind ?? kindOf(ev)
  return kind === undefined ? undefined : { kind, group: groupOf(ev.tool, ev.target), target: ev.target, err: ev.err === true, t: ev.t }
}

/** The steps of one loop in the ring, oldest first. */
const stepsOf = (events: readonly PulseEvent[], id: string): Step[] =>
  events.filter(e => e.loop === id).map(stepOf).filter((s): s is Step => s !== undefined)

// ---- the kind now ------------------------------------------------------------------------------------------------------------
/** The kind with the highest weighted count; a tie goes to KIND_ORDER. undefined for no kinds. */
export function dominant(kinds: readonly WorkKind[]): WorkKind | undefined {
  const score = new Map<WorkKind, number>()
  for (const k of kinds) score.set(k, (score.get(k) ?? 0) + KIND_WEIGHT[k])
  let best: WorkKind | undefined
  for (const k of KIND_ORDER) if ((score.get(k) ?? 0) > (best === undefined ? 0 : (score.get(best) ?? 0))) best = k
  return best
}

/** The kinds of a loop whose events are gone (a snapshot read back): from its per-tool counts, which have no targets. */
function kindFromCounts(counts: Readonly<Record<string, number>>): WorkKind | undefined {
  const kinds: WorkKind[] = []
  for (const [tool, n] of Object.entries(counts)) {
    const kind = kindOf({ tool, target: '' })
    if (kind !== undefined) for (let i = 0; i < Math.min(n, INSIGHT_CAPS.PHASE_EVENTS); i++) kinds.push(kind)
  }
  return dominant(kinds)
}

/**
 * What kind of work the agent does now. Done / waiting come from its status; a running agent with no call for THINK_AFTER_MS
 * and none in flight is thinking; otherwise the dominant kind of its last PHASE_EVENTS calls (its per-tool counts when the
 * events are gone); an agent that has done nothing yet is thinking.
 */
export function kindOfLoop(loop: PulseLoop, events: readonly PulseEvent[], now: number): InsightKind {
  if (loop.status === 'done') return isNotStartedLoop(loop) ? 'waiting' : 'done' // a run that never started did not finish
  if (loop.status === 'idle') return 'waiting'
  const steps = stepsOf(events, loop.id)
  const lastCallAt = steps[steps.length - 1]?.t ?? loop.lastAt
  if (loop.busy === 0 && now - lastCallAt > INSIGHT_CAPS.THINK_AFTER_MS) return 'thinking'
  return dominant(steps.slice(-INSIGHT_CAPS.PHASE_EVENTS).map(s => s.kind)) ?? kindFromCounts(loop.counts) ?? 'thinking'
}

const clip = (s: string, max: number): string => (s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}${ELLIPSIS}`)

/** What a visual check is doing, by the tool of its last call. */
function visualDetail(ev: PulseEvent | undefined): string {
  if (ev === undefined) return ''
  if (ev.tool.startsWith(BROWSER_PREFIX)) return 'in the browser'
  if (ev.tool.startsWith(SCENE_PREFIX)) return 'in the panel'
  return ev.tool === BASH ? 'rendering' : 'reading screenshot'
}

/**
 * The sentence of an agent's row: the kind's headline and what it is on ("Writing UI · board.css, lanes.js", "Running tests",
 * "Checking visually · reading screenshot"). Writing tests (an edit) and running them (a shell call) are the same kind, said differently.
 */
export function headlineOf(kind: InsightKind, events: readonly PulseEvent[], id: string): string {
  const recent = events.filter(e => e.loop === id && (e.kind ?? kindOf(e)) === kind).reverse()
  const head = kind === 'tests' && recent[0] !== undefined && isWrite(recent[0].tool) ? 'Writing tests' : KIND_META[kind].headline
  const files = [...new Set(recent.filter(e => isWrite(e.tool) && e.target !== '').map(e => e.target))].slice(0, INSIGHT_CAPS.HEADLINE_FILES)
  const detail = kind === 'visual' ? visualDetail(recent[0]) : files.join(NAMES_JOIN)
  return clip(detail === '' ? head : `${head}${HEADLINE_JOIN}${detail}`, INSIGHT_CAPS.HEADLINE_CHARS)
}

// ---- the feed -----------------------------------------------------------------------------------------------------------------
/** One group of consecutive steps as a phrase: "read 4 files", "edited board.js", "ran tests". */
function phraseOf(group: readonly Step[]): string {
  const first = group[0]
  if (first === undefined) return ''
  if (!FILE_GROUPS.includes(first.group)) return first.group
  const verb = own(GROUP_VERB, first.group) ?? first.group
  const names = [...new Set(group.map(s => s.target).filter(t => t !== ''))]
  if (names.length === 1) return clip(`${verb} ${names[0]}`, INSIGHT_CAPS.PHRASE_CHARS)
  const n = names.length === 0 ? group.length : names.length
  return `${verb} ${n} files`
}

/** The last FEED_EVENTS steps of the loop collapsed into at most FEED_PHRASES phrases, newest first. */
export function feedOf(events: readonly PulseEvent[], id: string): string[] {
  const groups: Step[][] = []
  for (const s of stepsOf(events, id).filter(x => x.group !== '').slice(-INSIGHT_CAPS.FEED_EVENTS)) {
    const tail = groups[groups.length - 1]
    if (tail !== undefined && tail[0]?.group === s.group) tail.push(s)
    else groups.push([s])
  }
  return groups.slice(-INSIGHT_CAPS.FEED_PHRASES).map(phraseOf).reverse()
}

// ---- the time: strip and mix ---------------------------------------------------------------------------------------------------
/** The loop's spans: its own, else rebuilt from the events in the ring (a loop read back from an old snapshot has none). */
export function spansOf(loop: PulseLoop, events: readonly PulseEvent[]): Span[] {
  if (loop.spans !== undefined && loop.spans.length > 0) return loop.spans
  const spans: Span[] = []
  for (const s of stepsOf(events, loop.id)) addSpan(spans, s.kind, s.t)
  return spans
}

/** Where the loop's time stops: now while it runs, else its last sign of life. */
export const endOf = (loop: PulseLoop, now: number): number => Math.max(loop.status === 'running' ? now : loop.lastAt, loop.startedAt)

/** The kind that has most of a stretch of time (a tie goes to KIND_ORDER); undefined when none has any. */
function mostTime(time: ReadonlyMap<WorkKind, number>): WorkKind | undefined {
  let best: WorkKind | undefined
  for (const k of KIND_ORDER) if ((time.get(k) ?? 0) > (best === undefined ? 0 : (time.get(best) ?? 0))) best = k
  return best
}

/** The activity strip: STRIP_BUCKETS letters over the last STRIP_WINDOW_MS of the loop (all its life when shorter), the kind with most time per bucket. */
export function stripOf(loop: PulseLoop, events: readonly PulseEvent[], now: number): string {
  const n = INSIGHT_CAPS.STRIP_BUCKETS
  const end = endOf(loop, now)
  const start = Math.max(loop.startedAt, end - INSIGHT_CAPS.STRIP_WINDOW_MS)
  const span = Math.max(end - start, INSIGHT_CAPS.STRIP_MIN_SPAN_MS)
  const spans = spansOf(loop, events)
  const to = end + SPAN_CAPS.MIN_MS // a call that has just begun shows in the last bucket
  const width = Math.max(to - start, span)
  return Array.from({ length: n }, (_, i) => {
    const kind = mostTime(timeByKind(spans, end, start + (width * i) / n, start + (width * (i + 1)) / n))
    return kind === undefined ? STRIP_NONE : KIND_META[kind].letter
  }).join('')
}

/** Percentages of a split that add up to exactly 100 (the rest of the rounding goes to the largest share). */
function percents(time: ReadonlyMap<WorkKind, number>): { kind: WorkKind; pct: number }[] {
  const total = [...time.values()].reduce((a, b) => a + b, 0)
  if (total <= 0) return []
  const rows = KIND_ORDER.filter(k => (time.get(k) ?? 0) > 0)
    .map(kind => ({ kind, pct: Math.round(((time.get(kind) ?? 0) / total) * PERCENT) }))
    .sort((a, b) => b.pct - a.pct)
  const rest = PERCENT - rows.reduce((a, r) => a + r.pct, 0)
  const top = rows[0]
  if (top !== undefined) top.pct += rest
  return rows.filter(r => r.pct > 0)
}

/** What share of the last MIX_WINDOW_MS of the loop's time went to which kind, largest first (empty while it has done nothing). */
export function mixOf(loop: PulseLoop, events: readonly PulseEvent[], now: number): { kind: WorkKind; pct: number }[] {
  const end = endOf(loop, now)
  return percents(timeByKind(spansOf(loop, events), end, end - INSIGHT_CAPS.MIX_WINDOW_MS, end))
}

/** The stretches of one kind on the clock, for the timeline (hooks/board-agents.ts). */
export const segmentsOfLoop = (loop: PulseLoop, events: readonly PulseEvent[], now: number): ReturnType<typeof segmentsOf> =>
  segmentsOf(spansOf(loop, events), endOf(loop, now))

/** Up to FILES_MAX basenames the loop touched, newest first. */
export const filesOf = (loop: PulseLoop): string[] => loop.files.slice(0, INSIGHT_CAPS.FILES_MAX).map(f => clip(f, INSIGHT_CAPS.FILE_CHARS))

/** Everything the board shows of one agent beside its name and step. `lastCallAt` and `isBusy` let the page turn a stale kind into "thinking" between writes. */
export function insightOf(loop: PulseLoop, events: readonly PulseEvent[], now: number): AgentInsight {
  const steps = stepsOf(events, loop.id)
  const kind = kindOfLoop(loop, events, now)
  return {
    kind,
    headline: headlineOf(kind, events, loop.id),
    strip: stripOf(loop, events, now),
    mix: mixOf(loop, events, now),
    files: filesOf(loop),
    feed: feedOf(events, loop.id),
    tokens: loop.tokens !== undefined && loop.tokens > 0 ? loop.tokens : null,
    lastCallAt: steps[steps.length - 1]?.t ?? loop.lastAt,
    isBusy: loop.busy > 0,
    isMain: loop.kind === 'main',
  }
}
