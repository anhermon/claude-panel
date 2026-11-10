// The board frames drawn from a router-kit run (./router-state.ts), auto frames like the workflow-insight ones: `tickets`
// (many tickets), `checks` (exactly one ticket), `router-events` (a `timeline` of the latest events). Context-adaptive:
// two or more tickets give `tickets`, one gives `checks` for it, none gives nothing. Pure: no `$`, no I/O.
import type { BoardFrame, BoardTone, CheckItem, TicketItem } from '../types'
import { clipTitle, plainTitle, uniqueTitles } from './agent-names'
import { cut } from './blocks/common'
import { FRAME_CAPS } from './board-frames'
import type { RouterEvent, RouterRun, RouterStage, RouterTicket } from './router-state'

export const ROUTER_FRAME = {
  TICKETS_ID: 'tickets',
  CHECKS_ID: 'checks',
  EVENTS_ID: 'router-events',
  EVENTS_TITLE: 'Router events',
  TICKETS_SIZE: 'l',
  SMALL_RUN_TICKETS: 3,
  SMALL_RUN_SIZE: 'm',
  CHECKS_SIZE: 'm',
  EVENTS_SIZE: 'm',
  // the caps are the validator's, so a frame built here always passes it
  TICKET_ITEMS: FRAME_CAPS.TICKETS_ITEMS,
  CHECK_ITEMS: FRAME_CAPS.CHECKS_ITEMS,
  EVENT_ITEMS: FRAME_CAPS.TIMELINE_ITEMS,
  TITLE_CHARS: FRAME_CAPS.TITLE_CHARS,
  TICKET_ID_CHARS: FRAME_CAPS.TICKET_ID_CHARS,
  TICKET_TITLE_CHARS: FRAME_CAPS.TICKET_TITLE_CHARS,
  AGENT_CHARS: FRAME_CAPS.TICKET_AGENT_CHARS,
  NOTE_CHARS: FRAME_CAPS.TICKET_NOTE_CHARS,
  CHECK_CHARS: FRAME_CAPS.CHECK_ITEM_CHARS,
  EVIDENCE_CHARS: FRAME_CAPS.CHECK_EVIDENCE_CHARS,
  EVENT_TEXT_CHARS: FRAME_CAPS.TIMELINE_TEXT_CHARS,
  WHEN_CHARS: FRAME_CAPS.TIMELINE_WHEN_CHARS,
  DEPENDS_ITEMS: FRAME_CAPS.TICKET_DEPENDS,
  EVAL_WHAT_CHARS: FRAME_CAPS.TICKET_EVAL_WHAT_CHARS,
  EVAL_EVIDENCE_CHARS: FRAME_CAPS.TICKET_EVAL_EVIDENCE_CHARS,
} as const

/** Stages ordered by what the person must look at first: work in flight, then what failed or is unproven, then the queue, then done. */
const STAGE_RANK: Record<RouterStage, number> = { fixing: 0, verifying: 1, building: 2, unproven: 3, unverified: 4, blocked: 5, ready: 6, draft: 7, done: 8 }
const TITLE_PARTS_JOIN = ', '
const TITLE_SEP = ' · '
const TASK_TITLE = 'Task'
const MS_PER_MIN = 60_000
const MIN_PER_HOUR = 60
const HOURS_PER_DAY = 24
const NOT_DONE: readonly RouterStage[] = ['ready', 'draft', 'building', 'verifying', 'fixing', 'unproven', 'unverified', 'blocked']

const TONE_OF_EVENT: Record<string, BoardTone> = {
  verify_fail: 'danger',
  escalated: 'danger',
  verify_pass: 'ok',
  done: 'ok',
  fix_sent: 'warn',
}

/** A folder slug (`03-ui-form`) read as words: no leading number, dashes as spaces, first letter up. */
const SLUG_NUMBER = /^\d+[-_]?/
const SLUG_SEPARATORS = /[-_]+/g
const humanise = (slug: string): string => {
  const words = plainTitle(slug.replace(SLUG_NUMBER, '').replace(SLUG_SEPARATORS, ' '))
  return words === '' ? TASK_TITLE : words
}
/** What a person calls the ticket: its title without number or routing note, never its id or folder slug. */
export const ticketTitle = (t: RouterTicket): string => {
  const plain = plainTitle(t.title, false)
  return plain === '' || plain === t.id ? humanise(t.id) : plain
}
const titlesOf = (ids: readonly string[], all: readonly RouterTicket[]): string[] => ids.map(id => { const o = all.find(x => x.id === id); return o === undefined ? humanise(id) : ticketTitle(o) })

const failing = (t: RouterTicket): string[] => t.checks.filter(c => c.pass === false).map(c => c.item)
const idsNotDone = (t: RouterTicket, all: readonly RouterTicket[]): string[] =>
  t.dependsOn.filter(d => all.some(o => o.id === d && NOT_DONE.includes(o.stage)))

/** One line saying why the ticket is where it is; undefined when its stage says it all. */
function noteOf(t: RouterTicket, all: readonly RouterTicket[]): string | undefined {
  const bad = failing(t)
  const why = bad.length > 0 ? bad.join('; ') : t.lastEvidence
  const rounds = `${t.fixRound} fix round${t.fixRound === 1 ? '' : 's'}`
  if (t.rawStatus !== undefined) return `Unknown status "${t.rawStatus}"`
  switch (t.stage) {
    case 'fixing':
      return why === undefined ? 'Verifier failed it; the worker is fixing' : `Verifier failed: ${why}`
    case 'verifying':
      return 'Worker reported done; the verifier is checking'
    case 'unproven':
      return t.eval.present ? 'Done, but its eval has not passed' : 'Done, but it has no eval that proves it'
    case 'unverified':
      if (t.result === null) return 'Claimed done, but no verifier PASS yet'
      return bad.length > 0 ? `Claimed done, but ${bad.length} check${bad.length === 1 ? '' : 's'} still fail after ${rounds}` : `Claimed done, but not verified after ${rounds}`
    case 'blocked': {
      const waiting = idsNotDone(t, all)
      return waiting.length > 0 ? `Waiting on ${titlesOf(waiting, all).join(', ')}` : (why ?? 'Blocked')
    }
    default:
      return undefined
  }
}

const checksOf = (t: RouterTicket): { pass: number; total: number } | undefined =>
  t.checks.length === 0 ? undefined : { pass: t.checks.filter(c => c.pass === true).length, total: t.checks.length }

/** The proof of a ticket for its row: whether an eval exists, what it checks, whether it passed (only the current verifier PASS), one evidence line. */
function evalItemOf(t: RouterTicket): NonNullable<TicketItem['eval']> {
  return {
    present: t.eval.present,
    ...(t.eval.what === '' ? {} : { what: cut(t.eval.what, ROUTER_FRAME.EVAL_WHAT_CHARS) }),
    result: t.eval.result,
    ...(t.eval.evidence === undefined ? {} : { evidence: cut(t.eval.evidence, ROUTER_FRAME.EVAL_EVIDENCE_CHARS) }),
  }
}

function itemOf(t: RouterTicket, all: readonly RouterTicket[]): TicketItem {
  const checks = checksOf(t)
  const note = noteOf(t, all)
  return {
    id: cut(t.id, ROUTER_FRAME.TICKET_ID_CHARS),
    title: clipTitle(ticketTitle(t), ROUTER_FRAME.TICKET_TITLE_CHARS),
    stage: t.stage,
    agent: cut(plainTitle(t.agent, false), ROUTER_FRAME.AGENT_CHARS),
    ...(checks === undefined ? {} : { checks }),
    round: t.fixRound,
    maxRounds: t.maxRounds,
    verdict: t.result,
    eval: evalItemOf(t),
    ...(note === undefined ? {} : { note: cut(plainTitle(note, false), ROUTER_FRAME.NOTE_CHARS) }),
    ...(t.dependsOn.length === 0 ? {} : { dependsOn: t.dependsOn.slice(0, ROUTER_FRAME.DEPENDS_ITEMS).map(d => cut(d, ROUTER_FRAME.TICKET_ID_CHARS)) }),
  }
}

/** Most relevant first; within a stage the most recently changed first, then by id. */
export function rankedTickets(tickets: readonly RouterTicket[]): RouterTicket[] {
  return [...tickets].sort((a, b) => STAGE_RANK[a.stage] - STAGE_RANK[b.stage] || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
}

/** `Tickets · 3 of 5 verified, 1 unverified`: what the person learns, within the title cap (the least important part goes first). */
function ticketsTitle(run: RouterRun): string {
  const c = run.counts
  const parts = [`${c.verified} of ${c.total} verified`, c.unproven > 0 ? `${c.unproven} unproven` : '', c.unverified > 0 ? `${c.unverified} unverified` : '', c.blocked > 0 ? `${c.blocked} blocked` : ''].filter(p => p !== '')
  while (parts.length > 1 && `Tickets${TITLE_SEP}${parts.join(TITLE_PARTS_JOIN)}`.length > ROUTER_FRAME.TITLE_CHARS) parts.pop()
  return cut(`Tickets${TITLE_SEP}${parts.join(TITLE_PARTS_JOIN)}`, ROUTER_FRAME.TITLE_CHARS)
}

function ticketsFrame(run: RouterRun): BoardFrame {
  const c = run.counts
  return {
    id: ROUTER_FRAME.TICKETS_ID,
    type: 'tickets',
    title: ticketsTitle(run),
    size: run.tickets.length <= ROUTER_FRAME.SMALL_RUN_TICKETS ? ROUTER_FRAME.SMALL_RUN_SIZE : ROUTER_FRAME.TICKETS_SIZE, // a short list does not reserve a tall frame
    summary: { total: c.total, verified: c.verified, unproven: c.unproven, unverified: c.unverified, blocked: c.blocked, inflight: c.inflight },
    items: rankedTickets(run.tickets).slice(0, ROUTER_FRAME.TICKET_ITEMS).map(t => itemOf(t, run.tickets)),
  }
}

/** The single ticket's checks: its verdict's, or the eval checklist (not run yet) while there is no verdict. */
function checkItemsOf(t: RouterTicket): CheckItem[] {
  const rows: CheckItem[] =
    t.checks.length > 0
      ? t.checks.map(c => ({ item: c.item, pass: c.pass, ...(c.evidence === undefined ? {} : { evidence: c.evidence }) }))
      : (t.evalItems ?? []).map(item => ({ item, pass: null }))
  return rows.slice(0, ROUTER_FRAME.CHECK_ITEMS).map(r => ({ ...r, item: cut(r.item, ROUTER_FRAME.CHECK_CHARS), ...(r.evidence === undefined ? {} : { evidence: cut(r.evidence, ROUTER_FRAME.EVIDENCE_CHARS) }) }))
}

function checksTitle(t: RouterTicket): string {
  const total = t.checks.length
  const bad = failing(t).length
  const what =
    total === 0 ? 'not checked yet' : t.result === 'PASS' ? `all ${total} passed` : bad > 0 ? `${bad} of ${total} failed` : `${checksOf(t)?.pass ?? 0} of ${total} passed`
  return clipTitle(`Checks${TITLE_SEP}${what}${TITLE_SEP}${ticketTitle(t)}`, ROUTER_FRAME.TITLE_CHARS)
}

function checksFrame(t: RouterTicket): BoardFrame | undefined {
  const items = checkItemsOf(t)
  if (items.length === 0) return undefined
  return {
    id: ROUTER_FRAME.CHECKS_ID,
    type: 'checks',
    title: checksTitle(t),
    size: ROUTER_FRAME.CHECKS_SIZE,
    result: t.result,
    round: t.fixRound,
    maxRounds: t.maxRounds,
    items,
  }
}

/** `3 min ago`; empty when the event has no time. */
function whenOf(ts: number, now: number): string {
  if (ts <= 0) return ''
  const min = Math.max(0, Math.floor((now - ts) / MS_PER_MIN))
  if (min < 1) return 'just now'
  if (min < MIN_PER_HOUR) return `${min} min ago`
  const hours = Math.floor(min / MIN_PER_HOUR)
  return hours < HOURS_PER_DAY ? `${hours} h ago` : `${Math.floor(hours / HOURS_PER_DAY)} d ago`
}

function eventsFrame(events: readonly RouterEvent[], tickets: readonly RouterTicket[], now: number): BoardFrame | undefined {
  const shown = events.slice(-ROUTER_FRAME.EVENT_ITEMS)
  if (shown.length === 0) return undefined
  return {
    id: ROUTER_FRAME.EVENTS_ID,
    type: 'timeline',
    title: ROUTER_FRAME.EVENTS_TITLE,
    size: ROUTER_FRAME.EVENTS_SIZE,
    items: shown.map(e => {
      const named = e.ticket === '' ? undefined : tickets.find(t => t.id === e.ticket)
      const title = e.ticket === '' ? '' : named === undefined ? humanise(e.ticket) : ticketTitle(named)
      const who = title === '' ? '' : `${title}${TITLE_SEP}`
      // the title says WHICH work, so it is kept whole; the detail only when it still fits the line (the tickets frame has the why)
      const full = `${who}${e.type}${e.detail === '' ? '' : `: ${e.detail}`}`
      const text = full.length <= ROUTER_FRAME.EVENT_TEXT_CHARS ? full : `${who}${e.type}`
      const when = whenOf(e.ts, now)
      const tone = TONE_OF_EVENT[e.type]
      return { ...(when === '' ? {} : { when: cut(when, ROUTER_FRAME.WHEN_CHARS) }), text: clipTitle(plainTitle(text, false), ROUTER_FRAME.EVENT_TEXT_CHARS), ...(tone === undefined ? {} : { tone }) }
    }),
  }
}

/** The frames the run has something to say with, in board order. Nothing for a run with no ticket. */
export function routerFrames(run: RouterRun | undefined, now: number): BoardFrame[] {
  if (run === undefined || run.tickets.length === 0) return []
  const titles = uniqueTitles(run.tickets.map(ticketTitle), ROUTER_FRAME.TICKET_TITLE_CHARS)
  const tickets = run.tickets.map((t, i) => ({ ...t, title: titles[i]! }))
  const main = tickets.length === 1 ? checksFrame(tickets[0]!) : ticketsFrame({ ...run, tickets })
  return [main, eventsFrame(run.events, tickets, now)].filter((f): f is BoardFrame => f !== undefined)
}

/** The ids of the frames, for the board's list of auto frames. */
export const ROUTER_FRAME_IDS: readonly string[] = [ROUTER_FRAME.TICKETS_ID, ROUTER_FRAME.CHECKS_ID, ROUTER_FRAME.EVENTS_ID]
