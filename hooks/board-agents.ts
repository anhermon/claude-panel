// The board's default agent view, pure: ONE ROW PER AGENT from the pulse loops plus the lanes agents posted, a checklist
// frame for every lane that has one, and the `bars` frame of time (or tokens) per agent. The rows say what each agent is FOR:
// its name (the spawn description), its state and its intent (the ticket and goal of its dispatch prompt) or the step it
// posted, with pct when it posted one, and what it is DOING (`insight`: kind of work, headline, activity strip, mix, files, recent actions, tokens;
// ./agent-insight.ts). The headline numbers are how long it ran and how many tokens it used; the tool it is running is
// never a headline (an agent doing `sed` tells nobody anything) and tool calls are only a tiny count (`calls`). No `$`, no I/O.
import type { BoardFrame, BoardLane, SwimlaneItem } from '../types'
import { cut } from './blocks/common'
import { endOf, insightOf, segmentsOfLoop } from './agent-insight'
import { plainTitle } from './agent-names'
import { formatDuration } from './insight-format'
import { FRAME_CAPS } from './board-frames'
import { panelConfig } from './panel-config'
import { LANE_CAPS } from './pulse-lanes'
import { collapseNotStarted, isNotStartedLoop, noteOfNotStarted } from './not-started'
import type { PulseEvent, PulseLoop } from './pulse-model'

/** `bars` shows the top agents only. */
export const AGENT_BARS_TOP = 6
/** The bars frame needs at least this many loops (the main one counts) to say anything. */
export const AGENT_BARS_MIN_LOOPS = 2
/** The bars rank agents by tokens when any is known, else by how long they ran (the main loop is the session, not an agent: left out). */
export const AGENT_BARS_TIME_TITLE = 'Time per agent'
export const AGENT_BARS_TIME_UNIT = 'min'
export const AGENT_BARS_TOKENS_TITLE = 'Tokens per agent'
export const AGENT_BARS_TOKENS_UNIT = 'k tokens'
/** The `now-doing` and `activity-timeline` frames (auto): shown from this many rows / lanes (the main loop counts). */
export const DOING_MIN_ROWS = 1
export const SWIMLANE_MIN_LANES = 2
export const DOING_TITLE = 'Doing now'
export const SWIMLANE_TITLE = 'Activity'
const MS_PER_SECOND = 1000
const MS_PER_MINUTE = 60_000
/** Minutes are shown to one decimal. */
const MINUTE_DECIMALS = 10
const TOKENS_PER_K = 1000
/** A running agent's bar is drawn in the highlight color, the others in the quiet one. */
export const RUNNING_COLOR = '#38bdf8'
export const QUIET_COLOR = '#64748b'
/** The checklist frames of the lanes: `dod-<lane id>`, at most this many at once. */
export const DOD_FRAME_PREFIX = 'dod-'

const LANE_ID_PATTERN = /[^a-z0-9-]/g
const FRAME_ID_CHARS = 24

const laneIdOf = (loop: PulseLoop): string => loop.id.toLowerCase().replace(LANE_ID_PATTERN, '-').slice(0, LANE_CAPS.ID_CHARS) || 'agent'
/** A finished ingested run that failed or was blocked reads as blocked; any other end (also aborted, cancelled) as done. */
const BLOCKING_OUTCOMES: readonly unknown[] = ['failed', 'blocked']
/** A deferred or refused attempt never ran: it is waiting (to be retried), not done. */
const stateOf = (loop: PulseLoop): BoardLane['state'] =>
  loop.status === 'running' ? 'working' : loop.status === 'done' ? (isNotStartedLoop(loop) ? 'waiting' : BLOCKING_OUTCOMES.includes(loop.outcome) ? 'blocked' : 'done') : 'waiting'
/**
 * A spawn description may end with its routing, `(sonnet/high)`: noise on a row. Only a note that looks like routing goes:
 * one parenthesised group of lowercase `a/b` or `a/b/c` words with at least one known model or effort word, so
 * `Fix (read/write path)` and `Move (a/b)` keep their text. Off with the `stripRoutingSuffix` option.
 */
export const ROUTING_SUFFIX = /\s*\(\s*[a-z0-9._-]+(?:\/[a-z0-9._-]+){1,2}\s*\)\s*$/
const ROUTING_WORDS = /^(?:sonnet|haiku|opus|fable|gpt|codex|gemini|agy|claude|low|medium|high|xhigh|max)/
const isRouting = (note: string): boolean => note.split('/').some(w => ROUTING_WORDS.test(w.replace(/^\(\s*/, '').trim()))
export function stripRouting(name: string): string {
  if (!panelConfig.stripRoutingSuffix) return name
  const note = ROUTING_SUFFIX.exec(name)?.[0]
  return note !== undefined && isRouting(note.replace(/[()\s]/g, '')) ? name.slice(0, name.length - note.length) : name
}
function cleanName(name: string): string {
  const suffix = ROUTING_SUFFIX.exec(name)?.[0] ?? ''
  const body = suffix === '' ? name : name.slice(0, name.length - suffix.length)
  return plainTitle(body, false) + stripRouting(suffix)
}

export const nameOf = (loop: PulseLoop): string => cut(cleanName(loop.name ?? loop.label), LANE_CAPS.LABEL_CHARS)

/** Is there anything to show as agents: a posted lane, or an agent (not the main loop) at work? */
export const hasAgents = (lanes: readonly BoardLane[], loops: readonly PulseLoop[]): boolean =>
  lanes.length > 0 || loops.some(l => l.kind !== 'main' && l.status === 'running')

/**
 * The rows of the `lanes` frame: every loop once (the main loop first), a posted lane of that loop keeping its own label,
 * pct, state, goal and checklist; its step is the one it posted, else the loop's intent (the posted step wins, the intent
 * moves to the note). A loop with no lane is a row named after its spawn description whose step is its intent (the main
 * loop's is `mainText`, the task). Lanes that belong to no loop follow. At most LANE_CAPS.LANES rows.
 */
export function agentLanes(
  lanes: readonly BoardLane[],
  loops: readonly PulseLoop[],
  mainText = '',
  nowMs: number = Date.now(),
  events: readonly PulseEvent[] = [],
): BoardLane[] {
  const rows: BoardLane[] = []
  const used = new Set<BoardLane>()
  const { loops: shown, retries } = collapseNotStarted(loops)
  for (const loop of shown) {
    if (loop.status === 'done' && loop.kind !== 'main' && nowMs - loop.lastAt > panelConfig.doneRowMs) continue
    const posted = lanes.find(l => l.loop === loop.id && !used.has(l))
    const intent = loop.kind === 'main' ? cut(mainText, LANE_CAPS.STEP_CHARS) : cut(loop.intent ?? '', LANE_CAPS.STEP_CHARS)
    if (posted !== undefined) {
      used.add(posted)
      rows.push({
        ...posted,
        label: posted.label === posted.id ? nameOf(loop) : cleanName(posted.label),
        step: posted.step !== '' ? posted.step : intent,
        note: posted.note !== '' ? posted.note : posted.step !== '' ? cut(intent, LANE_CAPS.NOTE_CHARS) : '',
        calls: loop.calls,
        insight: insightOf(loop, events, nowMs),
      })
    } else {
      const notStarted = isNotStartedLoop(loop) ? noteOfNotStarted(loop, retries.get(loop.id) ?? 0) : ''
      rows.push({
        id: laneIdOf(loop),
        label: nameOf(loop),
        state: stateOf(loop),
        pct: null,
        step: notStarted !== '' ? loop.why ?? intent : intent,
        note: notStarted,
        goal: '',
        dod: [],
        at: null,
        startedAt: loop.startedAt,
        updatedAt: loop.lastAt,
        by: loop.id,
        loop: loop.id,
        calls: loop.calls,
        insight: insightOf(loop, events, nowMs),
      })
    }
  }
  for (const lane of lanes) if (!used.has(lane)) rows.push(lane)
  return rows.slice(0, LANE_CAPS.LANES).map(row => ({
    ...row, label: cleanName(row.label), goal: plainTitle(row.goal, false),
    step: plainTitle(row.step, false), note: plainTitle(row.note, false),
    dod: row.dod.map(item => ({ ...item, t: plainTitle(item.t, false) })),
  }))
}

/** The checklist of every lane that has one as a `steps` frame titled with the goal (else the lane's label); the item `at` points to shows as doing. */
export function dodFrames(rows: readonly BoardLane[], nowMs = 0): { id: string; frame: BoardFrame }[] {
  return rows
    .filter(r => r.dod.length > 0)
    .slice(0, panelConfig.dodFramesMax)
    .map(r => {
      const id = `${DOD_FRAME_PREFIX}${r.id}`.slice(0, FRAME_ID_CHARS).replace(/-+$/, '')
      const items = r.dod.map((d, i) => ({ t: plainTitle(d.t, false), state: i === r.at && d.state === 'todo' ? ('doing' as const) : d.state }))
      // a lane at work always has an item in progress: with none marked, the first open one is it
      const open = items.findIndex(i => i.state === 'todo')
      if ((r.state === 'working' || r.state === 'testing') && open >= 0 && !items.some(i => i.state === 'doing')) items[open] = { t: items[open]?.t ?? '', state: 'doing' }
      const title = plainTitle(r.goal !== '' ? r.goal : r.label)
      const agent = r.goal !== '' ? plainTitle(r.label, false) : '' // who, when the frame is titled with the goal and not with the agent's own name
      const owner = agent.toLowerCase() === title.toLowerCase() ? '' : agent
      const since = nowMs > 0 && r.startedAt > 0 ? formatDuration(nowMs - r.startedAt) : ''
      return {
        id,
        frame: {
          id, type: 'steps', title: cut(plainTitle(r.goal !== '' ? r.goal : r.label), FRAME_CAPS.TITLE_CHARS), size: 'm', items,
          ...(owner === '' ? {} : { owner: cut(owner, FRAME_CAPS.TITLE_CHARS) }),
          ...(since === '' ? {} : { since }),
        },
      }
    })
}

/** How long a loop ran: from its start to its last sign of life, or to now while it is running. */
export const durationOf = (loop: PulseLoop, nowMs: number): number => Math.max(0, (loop.status === 'running' ? nowMs : loop.lastAt) - loop.startedAt)

/** The `bars` frame of tokens per agent (when any agent's tokens are known) or time per agent: the top agents, running ones highlighted; undefined below two loops. */
export function agentBars(loops: readonly PulseLoop[], nowMs: number = Date.now()): BoardFrame | undefined {
  if (loops.length < AGENT_BARS_MIN_LOOPS) return undefined
  const agents = loops.filter(l => l.kind !== 'main')
  const byTokens = agents.some(l => (l.tokens ?? 0) > 0)
  const value = (l: PulseLoop): number =>
    byTokens ? Math.round((l.tokens ?? 0) / TOKENS_PER_K) : Math.round((durationOf(l, nowMs) / MS_PER_MINUTE) * MINUTE_DECIMALS) / MINUTE_DECIMALS
  const top = agents
    .map(l => ({ l, v: value(l) }))
    .filter(({ v }) => !byTokens || v > 0) // an agent whose tokens are not known has no bar
    .sort((a, b) => b.v - a.v)
    .slice(0, AGENT_BARS_TOP)
  if (top.length === 0) return undefined
  return {
    id: 'bars',
    type: 'bars',
    title: byTokens ? AGENT_BARS_TOKENS_TITLE : AGENT_BARS_TIME_TITLE,
    size: 's',
    items: top.map(({ l, v }) => ({ label: cut(nameOf(l), FRAME_CAPS.BAR_LABEL_CHARS), value: v, color: l.status === 'running' ? RUNNING_COLOR : QUIET_COLOR })),
    unit: byTokens ? AGENT_BARS_TOKENS_UNIT : AGENT_BARS_TIME_UNIT,
  }
}

const laneState = (loop: PulseLoop): SwimlaneItem['state'] => (loop.status === 'running' ? 'working' : loop.status === 'done' && !isNotStartedLoop(loop) ? 'done' : 'waiting')

/**
 * The `swimlane` frame: one lane per loop (the main one first, then the running agents, then the others by start), its run
 * cut into stretches of one kind of work, in seconds from the first start. Undefined until an agent besides the main loop has done something.
 */
export function agentSwimlane(loops: readonly PulseLoop[], events: readonly PulseEvent[], nowMs: number = Date.now()): BoardFrame | undefined {
  const shown = loops
    .filter(l => l.kind === 'main' || l.status !== 'done' || nowMs - l.lastAt <= panelConfig.doneRowMs)
    .map(l => ({ l, segs: segmentsOfLoop(l, events, nowMs) }))
    .filter(({ segs }) => segs.length > 0)
  if (shown.filter(({ l }) => l.kind !== 'main').length === 0) return undefined
  const rank = (l: PulseLoop): number => (l.kind === 'main' ? 0 : l.status === 'running' ? 1 : 2)
  const picked = shown.sort((a, b) => rank(a.l) - rank(b.l) || a.l.startedAt - b.l.startedAt).slice(0, FRAME_CAPS.SWIMLANE_ITEMS)
  if (picked.length < SWIMLANE_MIN_LANES) return undefined
  const t0 = Math.min(...picked.map(({ l, segs }) => Math.min(l.startedAt, (segs[0] as { a: number }).a)))
  const sec = (ms: number): number => Math.max(0, Math.round((ms - t0) / MS_PER_SECOND))
  return {
    id: 'activity-timeline',
    type: 'swimlane',
    title: SWIMLANE_TITLE,
    size: 'm',
    items: picked.map(({ l, segs }) => ({
      label: cut(nameOf(l), FRAME_CAPS.SWIMLANE_LABEL_CHARS),
      state: laneState(l),
      from: sec(l.startedAt),
      to: sec(Math.max(endOf(l, nowMs), (segs[segs.length - 1] as { b: number }).b)),
      segs: segs.slice(-FRAME_CAPS.SWIMLANE_SEGS).map(s => ({ k: s.k, a: sec(s.a), b: sec(s.b) })),
    })),
  }
}
