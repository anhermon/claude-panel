// The two diagrams the mod draws by itself from real agent activity, as Mermaid text for the `uml` frame. Pure: no `$`, no I/O.
//   delegation  a sequenceDiagram: main -> each agent (spawn <name>), agent -> main (done / failed), in the order it happened (the last
//               DELEGATION_STEPS steps), the running agents highlighted `active`.
//   pipeline    a flowchart LR: one track per agent, a chain of its checklist (definition of done) items, or a single node when it has none;
//               every node coloured by state (class) and the same states in the highlight map (the running ones pulse).
// Every id that reaches Mermaid is rebuilt from letters and digits and every label is stripped of Mermaid's special characters, so no
// agent name or checklist text can change the diagram's structure.
import type { BoardFrame, BoardLane, UmlState } from '../types'
import { cut } from './blocks/common'
import { ROLE_SHORT, roleOf, tagOf, ticketOf } from './agent-roles'
import { nameOf } from './board-agents'
import type { PulseEvent, PulseLoop } from './pulse-model'
import { EVENT } from './router-state'
import type { RouterRun } from './router-state'

export const GRAPH_CAPS = {
  /** Messages drawn: about what a half-width tile shows below the actor boxes without cutting the last one. */
  DELEGATION_STEPS: 6,
  /** Actors beside main: a half-width tile fits main + 4 boxes at a readable size; the most recent win. */
  PARTICIPANTS: 4,
  /** A box title: up to two lines of LINE_CHARS, joined by a Mermaid line break. */
  NAME_CHARS: 44,
  LINE_CHARS: 22,
  /** The name on a spawn arrow stays on one line. */
  ARROW_CHARS: 30,
  PIPELINE_TRACKS: 4,
  DOD_ITEMS: 6,
  ITEM_CHARS: 22,
  TRACK_CHARS: 18,
  ID_CHARS: 10,
  /** The frames need at least this many agents (the main loop does not count) to say anything. */
  MIN_AGENTS: 2,
} as const

export const GRAPH_FRAME = {
  DELEGATION_ID: 'delegation',
  DELEGATION_TITLE: 'Handoffs',
  PIPELINE_ID: 'pipeline',
  PIPELINE_TITLE: 'Pipeline',
  SIZE: 'xl',
} as const

export const MAIN_ID = 'main'
export const MAIN_LABEL = 'Main session'
const LINE_BREAK = '<br/>'
/** The main session's box in a router-kit run. */
export const ROUTER_LABEL = ROLE_SHORT.router
/** What a verifier's reply to the router says, by the router event that recorded it. */
const VERDICT_WORDS: Readonly<Record<string, string>> = { [EVENT.PASSED]: 'PASS', [EVENT.FAILED]: 'FAIL' }
const ID_PREFIX = 'n'
const TRACK_PREFIX = 'l'
const EMPTY_ID = 'x'
const NOT_ID_CHAR = /[^a-z0-9]/g
/** What stays of a label: letters, digits and a few harmless marks. Quotes, brackets, `:`, `;`, `#`, `|`, `<`, `>` and newlines all become spaces. */
const NOT_LABEL_CHAR = /[^\p{L}\p{N} .,_+/-]/gu
const SPACES = /\s+/g
const INDENT = '  '
const VERB = { SPAWN: 'spawn', DONE: 'done', FAILED: 'failed' } as const
/** State colours of the class lines (the page's highlight map recolours them with its own theme tokens). */
export const STATE_STROKE: Readonly<Record<UmlState, string>> = { active: '#38bdf8', done: '#4ade80', blocked: '#f87171', todo: '#64748b' }
const STROKE_WIDTH_PX = 2

type Step = { t: number; order: number; loop: PulseLoop; kind: typeof VERB.SPAWN | typeof VERB.DONE | typeof VERB.FAILED }
export type Graph = { code: string; highlight: Record<string, UmlState>; /** Agents left out of the drawing (the oldest). */ hidden?: number }

/** A label safe to put in Mermaid text (cut to `max` characters, never empty). */
export function safeLabel(text: string, max: number, fallback = EMPTY_ID): string {
  const clean = text.replace(NOT_LABEL_CHAR, ' ').replace(SPACES, ' ').trim()
  return cut(clean, max) || fallback
}

/** Ids made from letters and digits only, each distinct: the same raw text always gives the same id (a highlight stays on its node). */
export function idMaker(prefix = ID_PREFIX): (raw: string) => string {
  const seen = new Map<string, string>()
  const taken = new Set<string>()
  return raw => {
    const known = seen.get(raw)
    if (known !== undefined) return known
    const base = `${prefix}${raw.toLowerCase().replace(NOT_ID_CHAR, '').slice(0, GRAPH_CAPS.ID_CHARS) || EMPTY_ID}`
    let id = base
    for (let n = 2; taken.has(id); n++) id = `${base}${n}`
    taken.add(id)
    seen.set(raw, id)
    return id
  }
}

const agentsOf = (loops: readonly PulseLoop[]): PulseLoop[] => loops.filter(l => l.kind !== 'main')
export const hasEnoughAgents = (loops: readonly PulseLoop[]): boolean => agentsOf(loops).length >= GRAPH_CAPS.MIN_AGENTS

/** A finished agent whose last tool call failed is `failed`; one that ended cleanly is `done`. */
function endKind(loop: PulseLoop, events: readonly PulseEvent[]): typeof VERB.DONE | typeof VERB.FAILED {
  const last = events.findLast(e => e.loop === loop.id)
  return last?.err === true ? VERB.FAILED : VERB.DONE
}

function stateOfLoop(loop: PulseLoop, events: readonly PulseEvent[]): UmlState {
  if (loop.status === 'running') return 'active'
  if (loop.status === 'done') return endKind(loop, events) === VERB.FAILED ? 'blocked' : 'done'
  return 'todo'
}

/** A box title on at most two lines, wrapped at a word boundary (`Board layout and<br/>spacing review`). Only Mermaid's own line break is added; the text is already safe. */
export function wrapTitle(title: string, line = GRAPH_CAPS.LINE_CHARS): string {
  if (title.length <= line) return title
  const at = title.lastIndexOf(' ', line)
  if (at < 1) return title
  return `${title.slice(0, at)}${LINE_BREAK}${cut(title.slice(at + 1), line)}`
}

/** The box label of an agent: `verifier 02` (its role and ticket number) in a router run, else its name. */
function boxLabel(loop: PulseLoop, router: RouterRun | undefined): string {
  const role = roleOf(loop, router !== undefined)
  if (role === undefined) return safeLabel(nameOf(loop), GRAPH_CAPS.NAME_CHARS)
  const ticket = ticketOf(loop, router)
  return safeLabel(ticket === undefined ? ROLE_SHORT[role] : `${ROLE_SHORT[role]} ${tagOf(ticket)}`, GRAPH_CAPS.NAME_CHARS)
}

/**
 * PASS / FAIL for each verifier that finished: its ticket's verifier loops, oldest first, are matched with the ticket's verdict
 * events counted from the END (the router keeps only the newest events, so the newest verifier always gets the newest verdict).
 */
function verdictsOf(agents: readonly PulseLoop[], router: RouterRun | undefined): Map<PulseLoop, string> {
  const out = new Map<PulseLoop, string>()
  if (router === undefined) return out
  const byTicket = new Map<string, PulseLoop[]>()
  for (const loop of agents) {
    const ticket = roleOf(loop, true) === 'verifier' ? ticketOf(loop, router) : undefined
    if (ticket !== undefined) byTicket.set(ticket, [...(byTicket.get(ticket) ?? []), loop])
  }
  for (const [ticket, verifiers] of byTicket) {
    const verdicts = router.events.filter(e => e.ticket === ticket && VERDICT_WORDS[e.type] !== undefined)
    verifiers
      .sort((a, b) => a.startedAt - b.startedAt)
      .forEach((loop, i) => {
        const word = VERDICT_WORDS[verdicts[verdicts.length - verifiers.length + i]?.type ?? '']
        if (word !== undefined) out.set(loop, word)
      })
  }
  return out
}

/** The delegation sequence: undefined below GRAPH_CAPS.MIN_AGENTS agents. With a router-kit run the boxes carry roles and verifier replies read PASS / FAIL. */
export function delegation(loops: readonly PulseLoop[], events: readonly PulseEvent[] = [], router?: RouterRun): Graph | undefined {
  const agents = agentsOf(loops)
  if (agents.length < GRAPH_CAPS.MIN_AGENTS) return undefined
  const verdicts = verdictsOf(agents, router)
  const steps: Step[] = []
  agents.forEach((loop, i) => {
    steps.push({ t: loop.startedAt, order: i * 2, loop, kind: VERB.SPAWN })
    if (loop.status === 'done') steps.push({ t: loop.lastAt, order: i * 2 + 1, loop, kind: endKind(loop, events) })
  })
  const shown = steps.sort((a, b) => a.t - b.t || a.order - b.order).slice(-GRAPH_CAPS.DELEGATION_STEPS)
  const idOf = idMaker()
  const recent = new Set<PulseLoop>()
  for (const s of [...shown].reverse()) if (recent.size < GRAPH_CAPS.PARTICIPANTS) recent.add(s.loop) // the most recent participants win
  const participants = [...new Set(shown.map(s => s.loop))].filter(loop => recent.has(loop)) // in order of first appearance
  const lines = ['sequenceDiagram', `${INDENT}participant ${MAIN_ID} as ${router === undefined ? MAIN_LABEL : ROUTER_LABEL}`]
  for (const loop of participants) lines.push(`${INDENT}participant ${idOf(loop.id)} as ${wrapTitle(boxLabel(loop, router))}`)
  for (const s of shown) {
    if (!participants.includes(s.loop)) continue
    const id = idOf(s.loop.id)
    const name = cut(boxLabel(s.loop, router), GRAPH_CAPS.ARROW_CHARS)
    if (s.kind === VERB.SPAWN) lines.push(`${INDENT}${MAIN_ID}->>${id}: ${VERB.SPAWN} ${name}`)
    else if (s.kind === VERB.DONE) lines.push(`${INDENT}${id}-->>${MAIN_ID}: ${verdicts.get(s.loop) ?? VERB.DONE}`)
    else lines.push(`${INDENT}${id}--x${MAIN_ID}: ${VERB.FAILED}`)
  }
  const highlight = Object.fromEntries(participants.map(loop => [idOf(loop.id), stateOfLoop(loop, events)]))
  const hidden = agents.length - participants.length
  return { code: lines.join('\n'), highlight, ...(hidden > 0 ? { hidden } : {}) }
}

const LANE_STATE: Readonly<Record<BoardLane['state'], UmlState>> = { working: 'active', testing: 'active', waiting: 'todo', blocked: 'blocked', done: 'done' }
const DOD_STATE: Readonly<Record<BoardLane['dod'][number]['state'], UmlState>> = { todo: 'todo', doing: 'active', done: 'done', failed: 'blocked' }

/** The state of checklist item `i` of a lane: the item `at` points to counts as doing while it is still todo. */
const dodState = (row: BoardLane, item: BoardLane['dod'][number], i: number): UmlState => DOD_STATE[i === row.at && item.state === 'todo' ? 'doing' : item.state]

/** The pipeline: one track per agent row (the main loop's row left out). undefined below GRAPH_CAPS.MIN_AGENTS agents or with no row to draw. */
export function pipeline(rows: readonly BoardLane[], loops: readonly PulseLoop[]): Graph | undefined {
  if (!hasEnoughAgents(loops)) return undefined
  const mainIds = new Set(loops.filter(l => l.kind === 'main').map(l => l.id))
  const tracks = rows.filter(r => r.loop == null || !mainIds.has(r.loop)).slice(0, GRAPH_CAPS.PIPELINE_TRACKS)
  if (tracks.length === 0) return undefined
  const trackId = idMaker(TRACK_PREFIX)
  const lines = ['flowchart LR']
  const highlight: Record<string, UmlState> = {}
  const byState: Record<UmlState, string[]> = { active: [], done: [], blocked: [], todo: [] }
  const put = (id: string, state: UmlState): void => {
    highlight[id] = state
    byState[state].push(id)
  }
  tracks.forEach((row, t) => {
    const key = trackId(row.id)
    const label = safeLabel(row.label, GRAPH_CAPS.TRACK_CHARS)
    const items = row.dod.slice(0, GRAPH_CAPS.DOD_ITEMS)
    if (items.length === 0) {
      lines.push(`${INDENT}${key}["${label}"]`)
      put(key, LANE_STATE[row.state])
      return
    }
    const ids = items.map((_, i) => `${key}i${i}`)
    const idAt = (i: number): string => ids[i] ?? key
    lines.push(`${INDENT}subgraph s${t}["${label}"]`, `${INDENT}${INDENT}direction LR`)
    items.forEach((item, i) => {
      lines.push(`${INDENT}${INDENT}${idAt(i)}["${safeLabel(item.t, GRAPH_CAPS.ITEM_CHARS)}"]`)
      put(idAt(i), dodState(row, item, i))
    })
    if (ids.length > 1) lines.push(`${INDENT}${INDENT}${ids.join(' --> ')}`)
    lines.push(`${INDENT}end`)
  })
  for (const state of Object.keys(byState) as UmlState[]) lines.push(`${INDENT}classDef ${state} stroke:${STATE_STROKE[state]},stroke-width:${STROKE_WIDTH_PX}px`)
  for (const state of Object.keys(byState) as UmlState[]) if (byState[state].length > 0) lines.push(`${INDENT}class ${byState[state].join(',')} ${state}`)
  return { code: lines.join('\n'), highlight }
}

const frameOf = (id: string, title: string, g: Graph): BoardFrame => ({ id, type: 'uml', title, size: GRAPH_FRAME.SIZE, code: g.code, highlight: g.highlight })

export function delegationFrame(loops: readonly PulseLoop[], events: readonly PulseEvent[] = [], router?: RouterRun): BoardFrame | undefined {
  const g = delegation(loops, events, router)
  return g === undefined ? undefined : frameOf(GRAPH_FRAME.DELEGATION_ID, g.hidden === undefined ? GRAPH_FRAME.DELEGATION_TITLE : `${GRAPH_FRAME.DELEGATION_TITLE} · latest ${GRAPH_CAPS.PARTICIPANTS} of ${GRAPH_CAPS.PARTICIPANTS + g.hidden}`, g)
}

export function pipelineFrame(rows: readonly BoardLane[], loops: readonly PulseLoop[]): BoardFrame | undefined {
  const g = pipeline(rows, loops)
  return g === undefined ? undefined : frameOf(GRAPH_FRAME.PIPELINE_ID, GRAPH_FRAME.PIPELINE_TITLE, g)
}
