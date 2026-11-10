// The data of the built-in `agents-info` scene (live/data.json), pure: no `$`, no I/O. It is derived from the same rows the
// board shows (agentLanes: lanes + pulse loops + insight), so it exposes nothing more than the board does (a state, a
// percentage, a work kind, a headline, file basenames, token and time numbers). On top of the snapshot it carries an EVENT
// stream: `diffAgents(prev, next)` turns two consecutive snapshots into the transitions the page animates (spawned, handed
// off, state change, kind of work change, progress step, finished). Event ids only grow, so the page can tell which are new.
import type { BoardLane, PanelStatus } from '../types'
import type { AgentProof } from './agent-proof'
import { plainTitle, PLACEHOLDER_BASE } from './agent-names'
import { roleOf, ticketBadgeOf } from './agent-roles'
import type { RoleSubject, TicketBadge } from './agent-roles'
import { agentLanes, hasAgents } from './board-agents'
import { segmentsOfLoop } from './agent-insight'
import { isNotStartedLoop } from './not-started'
import type { PulseEvent, PulseLoop } from './pulse-model'
import { tallyErrors } from './pulse-tally'
import type { RouterRun } from './router-state'
import { KIND_META } from './work-kinds'
import type { BoardInput } from './board-model'

export const AGENTS_INFO_CAPS = {
  /** At most this many agents (the lanes frame's own cap is 12). */
  AGENTS: 12,
  /** The newest events kept in the file. */
  EVENTS: 20,
  /** The whole title of a task (lanes cap a label at 60): the page wraps it, it is never cut here. */
  NAME_CHARS: 80,
  SHORT_CHARS: 14,
  HEADLINE_CHARS: 60,
  FILES: 3,
  FILE_CHARS: 28,
  /** A progress event needs at least this many percentage points of change (a finish is always one). */
  PROGRESS_STEP: 5,
  /** The same kind of event for the same agent is not repeated within this time (kind flips and progress ticks are noisy). */
  REPEAT_GAP_MS: 5_000,
  /** The newest stretches of one kind of work kept per agent (the gantt bar), and the grid a running stretch's moving end is rounded to (so the file is not rewritten every flush). */
  SEGS: 48,
  SEG_ROUND_MS: 10_000,
  /** A running agent whose last tool call has had no answer for at least this long while quiet gets the heuristic "may be waiting" hint. */
  WAITING_HINT_MS: 20_000,
  TOOL_CHARS: 40,
  BRANCH_CHARS: 60,
} as const

/** Heuristic hint that a quiet live agent's pending tool call has had no answer for >= WAITING_HINT_MS (a long tool looks the same). */
export type WaitingHint = { tool: string; target?: string }

/** One stretch of one kind of work on the clock (ms), as the swimlane frame gets them (hooks/agent-insight.ts segmentsOfLoop). */
export type AgentSeg = { k: string; a: number; b: number }
/** How the page draws a kind of work in a gantt bar: from KIND_META, the one table. */
export type KindStyle = { label: string; color: string; glyph: string }

export type AgentState = BoardLane['state']
export type Overall = PanelStatus
export type EventKind = 'spawn' | 'handoff' | 'state' | 'work' | 'progress'

export type AgentRow = {
  id: string
  /** The pulse loop it is (the key of its transcript and record); a posted lane keeps its own id, so `id` is not always this. */
  loop: string
  /** The main session itself: the person's own loop, shown as "Me" (no satellite, no ticker events). */
  isMain: boolean
  name: string
  short: string
  state: AgentState
  /** Posted percentage, else null (the page sweeps an indeterminate arc). */
  pct: number | null
  startedAt: number
  /** When it stopped (a finished agent), else null while it runs. */
  endedAt: number | null
  tokens: number | null
  /** Work kind and how to draw it, from KIND_META (the one table); null when the row has no insight. */
  kind: string | null
  kindLabel: string
  kindColor: string
  kindGlyph: string
  headline: string
  files: string[]
  /** The stretches of work it did, oldest first (the gantt bar); empty for a lane no loop backs. */
  segs?: AgentSeg[]
  /** The agent type EXACTLY as the engine names it (`general-purpose`, `example-tools:worker`, `Explore`), namespace included; null when not known. */
  agentType?: string | null
  /** Its role in a router-kit run (`router`, `worker`, `verifier`, ...), else null: an ordinary agent looks as before (hooks/agent-roles.ts). */
  role?: string | null
  /** The router ticket it works on: id, stage word and checks (`verified 4/4`), else null. */
  ticket?: TicketBadge | null
  /** The proof of a finished delegated ticket (its brief's `Eval:` line and the final `Eval result:`), else null: an agent that is not a ticket, or not read yet, is never flagged (hooks/agent-proof.ts). */
  proof?: AgentProof | null
  /** Only on a run of another harness (codex, agy) ingested from a run record (hooks/pulse-ingest.ts); a Claude agent carries none of these. `calls`: its tool calls so far. */
  harness?: string
  /** The model and effort the agent was started with (`sonnet`, `high`; an inherited effort is spelled `high*`): absent when not known, never guessed. A Claude subagent's come from its meta file (hooks/agent-meta.ts); the main session's model comes from its transcript. */
  model?: string
  effort?: string
  /** For the main session ("Me"), the git branch and AI session title from its transcript when known. */
  branch?: string
  title?: string
  calls?: number
  /** Sum of failed tool calls on the loop's tally when > 0; absent when 0. */
  errors?: number
  /** Heuristic "may be waiting" hint when a live agent's last tool call has had no answer for >= 20 s while quiet; absent otherwise. */
  mayBeWaiting?: WaitingHint
  confidence?: 'exact' | 'guessed'
  /** A short remark for the row's tooltip, e.g. that its log was matched by folder and time; for a not-started attempt, why and how often it was retried. */
  note?: string
  /** The attempt never started (the load governor deferred it, it was refused): nothing ran. `state` is `waiting`; the page draws it grey and hollow, never as done. */
  notStarted?: true
}

export type AgentEvent = { id: number; t: number; agent: string; from: string; to: string; kind: EventKind; text: string }

export type AgentsInfoData = {
  overall: Overall
  /** Kind of work of the main loop (the session itself), null when unknown: the big avatar looks busy only if something works. */
  mainKind: string | null
  counts: { total: number; working: number; waiting: number; blocked: number; done: number; notStarted: number }
  agents: AgentRow[]
  /** Label, colour and glyph of every kind a seg uses. */
  kinds?: Record<string, KindStyle>
  events: AgentEvent[]
  updatedAt: number
}

/** What a diff compares: the fields whose change the person should see. */
export type Snapshot = { agents: AgentRow[] }

const WORKING_STATES: readonly AgentState[] = ['working', 'testing']
const MAIN_NAME = 'main'
/** How the main session is named on its row. */
export const MAIN_ROW_NAME = 'Me'
const FINISHED = 'done'
const FAILED_STAGES: readonly string[] = ['failed', 'fail', 'rejected', 'error']
const MS_PER_MINUTE = 60_000
const MS_PER_SECOND = 1000
const SECONDS_PER_MINUTE = 60
const ELLIPSIS = '…'
const FALLBACK_KIND = 'working'
const GUESSED_NOTE = 'log matched by folder and time'

const clip = (s: string, max: number): string => (s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1)).trimEnd()}${ELLIPSIS}`)
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()

/** The task title for the ticker, cleaned before clipping. */
export function shortNameOf(label: string): string {
  const name = plainTitle(label, false) || PLACEHOLDER_BASE
  return clip(name, AGENTS_INFO_CAPS.SHORT_CHARS)
}

/** How long, in the words of the ticker: "42 s", "26 min", "2 h 5 min". */
export function spokenDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / MS_PER_SECOND))
  if (seconds < SECONDS_PER_MINUTE) return `${seconds} s`
  const minutes = Math.floor(ms / MS_PER_MINUTE)
  return minutes < SECONDS_PER_MINUTE ? `${minutes} min` : `${Math.floor(minutes / SECONDS_PER_MINUTE)} h ${minutes % SECONDS_PER_MINUTE} min`
}

/** The role and ticket of a row: from the pulse loop it is (its type, description, intent) and the router run, if any. */
function roleInfoOf(lane: BoardLane, loops: readonly PulseLoop[], router: RouterRun | undefined): Pick<AgentRow, 'role' | 'ticket' | 'proof'> {
  const isMain = lane.insight?.isMain === true
  const loop = loops.find(l => l.id === (lane.loop ?? lane.id)) ?? (isMain ? loops.find(l => l.kind === 'main') : undefined)
  const subject: RoleSubject = loop ?? { label: lane.label }
  const role = roleOf(isMain ? { kind: 'main' } : subject, router !== undefined)
  return { role: role ?? null, ticket: isMain ? null : (ticketBadgeOf(subject, router) ?? null), proof: isMain ? null : (loop?.proof ?? null) }
}

/** What an agent is: its type verbatim and the model and effort it runs on, from the pulse loop (the main session gets model/effort/branch/title from its transcript, while agentType stays null). */
export function identityOf(lane: BoardLane, loops: readonly PulseLoop[]): Pick<AgentRow, 'agentType' | 'model' | 'effort' | 'branch' | 'title'> {
  const isMain = lane.insight?.isMain === true
  const loop = loops.find(l => l.id === (lane.loop ?? lane.id)) ?? (isMain ? loops.find(l => l.kind === 'main') : undefined)
  return {
    agentType: isMain ? null : (loop?.type ?? null),
    ...(loop?.model === undefined ? {} : { model: loop.model }),
    ...(loop?.effort === undefined ? {} : { effort: loop.effort }),
    ...(isMain && loop?.branch !== undefined ? { branch: clip(oneLine(loop.branch), AGENTS_INFO_CAPS.BRANCH_CHARS) } : {}),
    ...(isMain && loop?.title !== undefined ? { title: clip(plainTitle(loop.title, false), AGENTS_INFO_CAPS.NAME_CHARS) } : {}),
  }
}

/** Heuristic "may be waiting" hint: a live agent with an unanswered tool call (`busy > 0`) that has been quiet for >= 20 s. Never set for done, failed, or not-started agents. */
function waitingOf(loop: PulseLoop | undefined, isDone: boolean, ticket: TicketBadge | null | undefined, now: number): Pick<AgentRow, 'mayBeWaiting'> {
  if (loop === undefined || isDone || loop.status === 'done' || loop.outcome !== undefined) return {}
  if (FAILED_STAGES.includes((ticket?.stage ?? '').toLowerCase())) return {}
  if (loop.busy <= 0 || loop.lastTool === '' || now - loop.lastAt < AGENTS_INFO_CAPS.WAITING_HINT_MS) return {}
  const tool = clip(oneLine(loop.lastTool), AGENTS_INFO_CAPS.TOOL_CHARS)
  if (tool === '') return {}
  const target = clip(oneLine(loop.lastTarget), AGENTS_INFO_CAPS.HEADLINE_CHARS)
  return { mayBeWaiting: target === '' ? { tool } : { tool, target } }
}

/** The lane's stretches of work (the swimlane frame's data, in ms): the newest SEGS; a running loop's moving end is rounded so the file only changes now and then. Empty when no loop backs the lane. */
function segsOfLane(lane: BoardLane, loops: readonly PulseLoop[], events: readonly PulseEvent[], now: number): AgentSeg[] {
  const isMain = lane.insight?.isMain === true
  const loop = loops.find(l => l.id === (lane.loop ?? lane.id)) ?? (isMain ? loops.find(l => l.kind === 'main') : undefined)
  if (loop === undefined) return []
  const round = (ms: number): number => Math.round(ms / AGENTS_INFO_CAPS.SEG_ROUND_MS) * AGENTS_INFO_CAPS.SEG_ROUND_MS
  const segs = segmentsOfLoop(loop, events, now).slice(-AGENTS_INFO_CAPS.SEGS)
  return segs.map((s, i) => ({ k: s.k, a: s.a, b: loop.status === 'running' && i === segs.length - 1 ? Math.max(s.a, round(s.b)) : s.b }))
}

/** What a run of another harness adds to its row: harness, model, effort, tool calls and, for a guessed log match, the note. Nothing for a Claude agent. */
function externalOf(lane: BoardLane, loops: readonly PulseLoop[]): Pick<AgentRow, 'harness' | 'model' | 'effort' | 'calls' | 'confidence' | 'note' | 'notStarted'> {
  const loop = loops.find(l => l.id === (lane.loop ?? lane.id))
  if (loop?.source !== 'external') return {}
  return {
    ...(isNotStartedLoop(loop) ? { notStarted: true as const, note: lane.note } : {}),
    ...(loop.harness === undefined ? {} : { harness: loop.harness }),
    ...(loop.model === undefined ? {} : { model: loop.model }),
    ...(loop.effort === undefined ? {} : { effort: loop.effort }),
    calls: loop.calls,
    ...(loop.confidence === undefined ? {} : { confidence: loop.confidence }),
    ...(loop.confidence === 'guessed' && !isNotStartedLoop(loop) ? { note: GUESSED_NOTE } : {}),
  }
}

function rowOf(lane: BoardLane, now: number, loops: readonly PulseLoop[], router: RouterRun | undefined, events: readonly PulseEvent[] = []): AgentRow {
  const insight = lane.insight
  const meta = KIND_META[insight?.kind ?? FALLBACK_KIND]
  const isMain = insight?.isMain === true
  const loop = loops.find(l => l.id === (lane.loop ?? lane.id)) ?? (isMain ? loops.find(l => l.kind === 'main') : undefined)
  const isNotStarted = loop !== undefined && isNotStartedLoop(loop)
  const isDone = lane.state === FINISHED || isNotStarted // a not-started attempt has stopped (its bar must not run to now), though it is not "done"
  // A delegated run has its OWN clock (the record's start and end); a lane somebody posted for it only says when that post was first and last made.
  const isRun = loop?.source === 'external'
  const startedAt = isRun ? loop.startedAt : lane.startedAt
  const roleInfo = roleInfoOf(lane, loops, router)
  const errors = tallyErrors(loop?.tally)
  return {
    id: lane.id,
    loop: lane.loop ?? lane.id,
    isMain,
    name: isMain ? MAIN_ROW_NAME : clip(plainTitle(lane.label, false), AGENTS_INFO_CAPS.NAME_CHARS),
    short: isMain ? MAIN_ROW_NAME : shortNameOf(lane.label),
    state: lane.state,
    pct: lane.pct,
    startedAt,
    endedAt: isDone ? Math.max(startedAt, isRun ? loop.lastAt : lane.updatedAt) : null,
    tokens: insight?.tokens ?? null,
    kind: insight?.kind ?? null,
    kindLabel: meta.label,
    kindColor: meta.color,
    kindGlyph: meta.glyph,
    headline: clip(oneLine(isNotStarted ? lane.step : (insight?.headline ?? lane.step)), isNotStarted ? AGENTS_INFO_CAPS.NAME_CHARS : AGENTS_INFO_CAPS.HEADLINE_CHARS),
    files: (insight?.files ?? []).slice(0, AGENTS_INFO_CAPS.FILES).map(f => clip(f, AGENTS_INFO_CAPS.FILE_CHARS)),
    segs: segsOfLane(lane, loops, events, now),
    ...identityOf(lane, loops),
    ...roleInfo,
    ...externalOf(lane, loops),
    ...waitingOf(loop, isDone, roleInfo.ticket, now),
    ...(errors > 0 ? { errors } : {}),
  }
}

/** The agents of the board's rows, the main session first as "Me" (`isMain`: it has a row but no satellite). Empty when nothing is an agent. */
export function agentRowsOf(input: Pick<BoardInput, 'lanes' | 'loops' | 'events' | 'now' | 'task' | 'router'>): { agents: AgentRow[]; mainKind: string | null } {
  if (!hasAgents(input.lanes, input.loops)) return { agents: [], mainKind: null }
  const rows = agentLanes(input.lanes, input.loops, input.task?.title ?? '', input.now, input.events)
  const main = rows.find(r => r.insight?.isMain === true)
  const agents = [...rows.filter(r => r.insight?.isMain === true), ...rows.filter(r => r.insight?.isMain !== true)].slice(0, AGENTS_INFO_CAPS.AGENTS).map(r => rowOf(r, input.now, input.loops, input.router, input.events))
  return { agents, mainKind: main?.insight?.kind ?? null }
}

/** Is there anything to show as a crew: an agent (not the session itself) running or that has run, or a lane an agent posted? */
export const hasCrew = (input: Pick<BoardInput, 'lanes' | 'loops'>): boolean => input.lanes.length > 0 || input.loops.some(l => l.kind !== 'main')

/** The state of the whole team: blocked beats waiting-for-the-person beats done beats working. */
export function overallOf(status: PanelStatus, hasAsk: boolean, agents: readonly AgentRow[]): Overall {
  if (status === 'blocked' || agents.some(a => a.state === 'blocked')) return 'blocked'
  if (hasAsk || status === 'waiting') return 'waiting'
  if (status === 'done') return 'done'
  return 'working'
}

export function countsOf(all: readonly AgentRow[]): AgentsInfoData['counts'] {
  const agents = all.filter(a => !a.isMain)
  const n = (f: (a: AgentRow) => boolean): number => agents.filter(f).length
  return {
    total: agents.length,
    working: n(a => WORKING_STATES.includes(a.state)),
    waiting: n(a => a.state === 'waiting' && a.notStarted !== true),
    blocked: n(a => a.state === 'blocked'),
    done: n(a => a.state === FINISHED),
    notStarted: n(a => a.notStarted === true),
  }
}

// ---- the event stream ------------------------------------------------------------------------------------------------------------

/** What a state change is called in the ticker. */
const STATE_WORDS: Readonly<Record<AgentState, string>> = { working: 'working', testing: 'testing', waiting: 'waiting', blocked: 'blocked', done: 'done' }
/** Kinds that say nothing when they flip (the agent just paused or is between calls). */
const QUIET_KINDS: readonly string[] = ['thinking', 'waiting', 'done']

const labelOfKind = (kind: string): string => (Object.hasOwn(KIND_META, kind) ? KIND_META[kind as keyof typeof KIND_META].label : kind)

/**
 * The transitions between two snapshots, oldest first. `prev` null is the first look (nothing is announced: whatever runs
 * already ran). `recent` (the events already kept) throttles a repeat of the same kind for the same agent. Ids start at `nextId`.
 */
export function diffAgents(prev: readonly AgentRow[] | null, next: readonly AgentRow[], now: number, nextId: number, recent: readonly AgentEvent[] = []): AgentEvent[] {
  if (prev === null) return []
  const out: AgentEvent[] = []
  const before = new Map(prev.map(a => [a.id, a]))
  let id = nextId
  const add = (agent: AgentRow, kind: EventKind, from: string, to: string, text: string, isForced = false): void => {
    const last = [...recent, ...out].reverse().find(e => e.agent === agent.id && e.kind === kind)
    if (!isForced && last !== undefined && now - last.t < AGENTS_INFO_CAPS.REPEAT_GAP_MS) return
    out.push({ id: id++, t: now, agent: agent.id, from, to, kind, text })
  }
  for (const a of next) {
    if (a.isMain || a.notStarted === true) continue // the session's own row says nothing in the ticker (the big avatar's mood is its voice); an attempt that never started did not start
    const short = shortNameOf(a.name)
    const old = before.get(a.id)
    if (old === undefined) {
      add(a, 'handoff', MAIN_NAME, a.id, `${MAIN_NAME} → ${short}`, true)
      add(a, 'spawn', '', a.state, `${short} started`, true)
      continue
    }
    if (old.state !== a.state) {
      const spent = a.state === FINISHED ? ` · ${spokenDuration((a.endedAt ?? now) - a.startedAt)}` : ''
      add(a, 'state', old.state, a.state, `${short} ${STATE_WORDS[a.state]}${spent}`, true)
    }
    if (old.kind !== a.kind && a.kind !== null && old.kind !== null && !QUIET_KINDS.includes(a.kind) && a.state !== FINISHED)
      add(a, 'work', old.kind, a.kind, `${short} · ${labelOfKind(a.kind)}`)
    const step = a.pct === null ? 0 : Math.abs(a.pct - (old.pct ?? 0))
    if (a.pct !== null && a.pct !== old.pct && (step >= AGENTS_INFO_CAPS.PROGRESS_STEP || a.pct >= 100)) add(a, 'progress', String(old.pct ?? ''), String(a.pct), `${short} ${a.pct}%`)
  }
  return out
}

/** Label, colour and glyph (KIND_META) of every kind the agents' segs use. */
function kindStylesOf(agents: readonly AgentRow[]): Record<string, KindStyle> {
  const out: Record<string, KindStyle> = {}
  for (const s of agents.flatMap(a => a.segs ?? [])) {
    const meta = Object.hasOwn(KIND_META, s.k) ? KIND_META[s.k as keyof typeof KIND_META] : undefined
    if (meta !== undefined) out[s.k] = { label: meta.label, color: meta.color, glyph: meta.glyph }
  }
  return out
}

/** The whole `live/data.json`: the snapshot and the newest events (the old ones kept, the new ones appended). */
export function assembleAgentsInfo(input: BoardInput, events: readonly AgentEvent[]): AgentsInfoData {
  const { agents, mainKind } = agentRowsOf(input)
  return {
    overall: overallOf(input.status, input.ask !== null && input.ask.trim() !== '', agents.filter(a => !a.isMain)),
    mainKind,
    counts: countsOf(agents),
    agents,
    kinds: kindStylesOf(agents),
    events: events.slice(-AGENTS_INFO_CAPS.EVENTS),
    updatedAt: input.now,
  }
}

/** The data with the clock zeroed and the fields that tick on their own left out of the comparison: equal keys look the same to the person. */
export const dataKey = (d: AgentsInfoData): string => JSON.stringify({ ...d, updatedAt: 0 })
