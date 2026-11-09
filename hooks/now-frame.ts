// The auto `now` frame, pure (no `$`, no I/O): the CONCRETE current activity instead of the session's task title. Headline =
// what the most recently active agent is doing ("Redesign agent avatars · Writing tests"), under it the agents' tally, how long
// that agent has been at it and the last thing that finished; the task title shrinks to a subtitle. Titles are plain (no ticket
// numbers, no routing notes: plainTitle) and a router ticket is named by its title. With no agent in sight it is the old
// frame: the task title and the status chip.
import type { BoardFrame, BoardLane, PanelStatus } from '../types'
import { cut } from './blocks/common'
import { plainTitle, ticketOf } from './agent-roles'
import { FRAME_CAPS } from './board-frames'
import { formatDuration, plural } from './insight-format'
import type { RouterRun } from './router-state'

export const NOW_ID = 'now'
export const NOW_TITLE = 'Now'
export const NOW_SIZE = 'm'
const JOIN_ACTIVITY = ' · '
const BLOCKED_PREFIX = 'Blocked: '
const LAST_PREFIX = 'Last finished: '
const FOR_WORKING = 'working for '
const FOR_BLOCKED = 'blocked for '
const ACTIVE_STATES: readonly BoardLane['state'][] = ['working', 'testing']

export type NowInput = {
  /** The agent rows (`agentRows`): the main loop's row is left out here. */
  rows: readonly BoardLane[]
  router?: RouterRun
  /** The session's task title (trimmed, never empty here). */
  task: string
  status: PanelStatus
  now: number
}

const isAgent = (r: BoardLane): boolean => r.insight?.isMain !== true
const newest = (a: BoardLane, b: BoardLane): number => b.updatedAt - a.updatedAt

/** The plain title of what an agent works on: its router ticket's title, else its goal, else its label. */
export function workTitle(row: BoardLane, router: RouterRun | undefined): string {
  const id = ticketOf({ label: row.label, name: row.label, intent: `${row.goal}\n${row.step}` }, router)
  const ticket = id === undefined ? undefined : router?.tickets.find(t => t.id === id)
  const plain = plainTitle(ticket?.title.trim() || row.goal.trim() || row.label)
  return plain.charAt(0).toUpperCase() + plain.slice(1)
}

/** "2 agents working · 1 blocked · 1 waiting" (only the parts that are not zero). */
export function whoText(rows: readonly BoardLane[]): string {
  const count = (pick: (r: BoardLane) => boolean): number => rows.filter(pick).length
  const working = count(r => ACTIVE_STATES.includes(r.state))
  const blocked = count(r => r.state === 'blocked')
  const waiting = count(r => r.state === 'waiting')
  return [working > 0 ? `${plural(working, 'agent')} working` : '', blocked > 0 ? `${blocked} blocked` : '', waiting > 0 ? `${waiting} waiting` : '']
    .filter(p => p !== '')
    .join(JOIN_ACTIVITY)
}

export function nowFrame(input: NowInput): BoardFrame {
  const base: BoardFrame = { id: NOW_ID, type: 'now', title: NOW_TITLE, size: NOW_SIZE, text: cut(input.task, FRAME_CAPS.TEXT_CHARS), status: input.status }
  const rows = input.rows.filter(isAgent)
  const active = rows.filter(r => ACTIVE_STATES.includes(r.state)).sort(newest)
  const blocked = rows.filter(r => r.state === 'blocked').sort(newest)
  const focus = active[0] ?? blocked[0]
  if (focus === undefined) return base
  const isBlocked = active.length === 0
  const activity = (focus.insight?.headline ?? '').trim() || focus.step.trim()
  const title = workTitle(focus, input.router)
  const headline = `${isBlocked ? BLOCKED_PREFIX : ''}${activity === '' ? title : `${title}${JOIN_ACTIVITY}${activity}`}`
  const last = rows.filter(r => r.state === 'done').sort(newest)[0]
  const who = whoText(rows)
  return {
    ...base,
    text: cut(headline, FRAME_CAPS.TEXT_CHARS),
    sub: cut(input.task, FRAME_CAPS.SUB_CHARS),
    ...(who === '' ? {} : { who }),
    ...(focus.startedAt > 0 ? { for: `${isBlocked ? FOR_BLOCKED : FOR_WORKING}${formatDuration(input.now - focus.startedAt)}` } : {}),
    ...(last === undefined ? {} : { last: cut(`${LAST_PREFIX}${workTitle(last, input.router)}`, FRAME_CAPS.SUB_CHARS) }),
  } as BoardFrame
}
