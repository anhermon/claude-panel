// The router-kit state model: contract-shaped files, partial or garbage files, unknown statuses, and what counts as verified.
import { expect, test } from 'claude-code/testing'

import { buildRun, parseEvalItems, parseEvents, parseTicket, ROUTER_CAPS, timeOf } from '../hooks/router-state'
import type { RouterEvent } from '../hooks/router-state'
import { EVENT_LINES, NOW, realisticRun, TICKET_FILES } from './router-fixture'

/** A ticket with an eval.md by default (a `done` one without it is `unproven`: tests/router-eval.test.ts). */
const ticket = (over: Record<string, unknown>) => parseTicket({ id: 't', title: 'T', ...over }, 't', { evalText: '- the thing works' })
const event = (type: string, id = 't'): RouterEvent => ({ ts: 0, type, ticket: id, detail: '' })

test('a contract-shaped ticket.json parses to stage, agent, checks, fix round, verdict, decisions and dependencies', () => {
  const t = parseTicket(TICKET_FILES['03-ui'], '03-ui')
  expect(t).toMatchObject({ id: '03-ui', title: 'Booking form UI', stage: 'fixing', agent: 'codex-worker', result: 'FAIL', fixRound: 1, maxRounds: 2, dependsOn: ['01-schema'], lastEvidence: 'empty state missing' })
  expect(t.checks.map(c => c.pass)).toEqual([true, true, false, false])
  expect(t.checks[2]).toEqual({ item: 'Empty state shown with no bookings', pass: false, evidence: 'screenshot shows a blank list' })
  const done = parseTicket(TICKET_FILES['01-schema'], '01-schema')
  expect(done.decisions).toEqual([{ question: 'UUID or serial ids?', chosen: 'UUID', basis: 'ids cross services' }])
  expect(done.updatedAt).toBe(NOW - 30 * 60_000)
  expect(parseTicket(TICKET_FILES['04-auth'], '04-auth').fixRound).toBe(2)
})

test('status names map to stages; in_progress is building', () => {
  for (const [status, stage] of [['draft', 'draft'], ['ready', 'ready'], ['in_progress', 'building'], ['verifying', 'verifying'], ['fixing', 'fixing'], ['done', 'done'], ['unverified', 'unverified'], ['blocked', 'blocked'], ['  DONE ', 'done']])
    expect(ticket({ status }).stage).toBe(stage)
})

test('an unknown or missing status is the neutral stage, never dropped, and the raw status is kept', () => {
  expect(ticket({ status: 'cancelled' })).toMatchObject({ stage: 'draft', rawStatus: 'cancelled' })
  expect(ticket({ status: 7 })).toMatchObject({ stage: 'draft', rawStatus: '7' })
  const none = ticket({})
  expect(none.stage).toBe('draft')
  expect(none.rawStatus).toBeUndefined()
})

test('garbage never throws: every input gives a ticket with defaults', () => {
  for (const raw of [null, undefined, 'text', 42, [], [1, 2], { verdict: 'nope', fix_rounds: 'x', decisions: 3, depends_on: { a: 1 } }, { verdict: { checks: [null, 5, { pass: 'maybe' }, { item: 'ok', pass: 'PASS' }] } }]) {
    const t = parseTicket(raw, 'dir-name')
    expect(t.id.length).toBeGreaterThan(0)
    expect(t.maxRounds).toBe(ROUTER_CAPS.DEFAULT_MAX_ROUNDS)
    expect(Array.isArray(t.checks) && Array.isArray(t.dependsOn) && Array.isArray(t.decisions)).toBe(true)
  }
  expect(parseTicket(null, 'dir-name')).toMatchObject({ id: 'dir-name', title: 'dir-name', agent: 'worker', result: null, fixRound: 0 })
  const odd = parseTicket({ verdict: { checks: [null, 5, { pass: 'maybe' }, { item: 'ok', pass: 'PASS' }, 'plain text check'] } }, 'd')
  expect(odd.checks).toEqual([{ item: '5', pass: null }, { item: 'ok', pass: true }, { item: 'plain text check', pass: null }])
})

test('a verdict written as a bare string, a max_rounds field and a fix round count are all read', () => {
  expect(ticket({ verdict: 'pass' }).result).toBe('PASS')
  expect(ticket({ max_rounds: 3 }).maxRounds).toBe(3)
  expect(ticket({ fix_rounds: [{ n: 3 }] }).fixRound).toBe(3)
  expect(ticket({ fix_rounds: [{}, {}] }).fixRound).toBe(2)
})

test('timestamps: ISO text, milliseconds, seconds; anything else is 0', () => {
  expect(timeOf('2026-11-09T10:10:00Z')).toBe(NOW)
  expect(timeOf(NOW)).toBe(NOW)
  expect(timeOf(NOW / 1000)).toBe(NOW)
  expect(timeOf('yesterday')).toBe(0)
  expect(timeOf(null)).toBe(0)
})

test('events: one JSON per line, torn or garbage lines skipped, fields defaulted', () => {
  const events = parseEvents(['{"ts":"2026-11-09T10:10:00Z","type":"dispatched","ticket":"01","detail":"to worker"}', 'not json', '[1]', '{"type":"done"}', '{"ts":5}', '', '{"type":"verify_pass","ticket":"02","detail":'].join('\n'))
  expect(events).toEqual([
    { ts: NOW, type: 'dispatched', ticket: '01', detail: 'to worker' },
    { ts: 0, type: 'done', ticket: '', detail: '' },
  ])
})

test('eval.md checklists: bullets, numbers and checkboxes become items', () => {
  expect(parseEvalItems('# Eval\n\n- [ ] Form validates\n* [x] Posts to API\n1. Empty state\n2) Error toast\nplain text\n')).toEqual(['Form validates', 'Posts to API', 'Empty state', 'Error toast'])
  expect(parseEvalItems('x\n'.repeat(5))).toEqual([])
  expect(parseEvalItems('- a\n'.repeat(30))).toHaveLength(ROUTER_CAPS.EVAL_ITEMS)
})

test('the realistic run: stages, counts and the newest events', () => {
  const run = realisticRun()
  expect(run.tickets.map(t => [t.id, t.stage])).toEqual([['01-schema', 'done'], ['02-api', 'verifying'], ['03-ui', 'fixing'], ['04-auth', 'unverified'], ['05-deploy', 'blocked']])
  expect(run.counts).toEqual({ total: 5, verified: 1, unproven: 0, unverified: 1, blocked: 1, inflight: 2, queued: 0 })
  expect(run.events).toHaveLength(EVENT_LINES.length)
})

test('honesty: done without a PASS, or with a report newer than its verify_pass, is unverified, never verified', () => {
  const passed = { status: 'done', verdict: { result: 'PASS', checks: [{ item: 'a', pass: true }] } }
  expect(buildRun([ticket(passed)], [event('worker_reported'), event('verify_pass')]).counts.verified).toBe(1)
  expect(buildRun([ticket(passed)], []).counts.verified).toBe(1) // events missing: the verdict stands
  expect(buildRun([ticket(passed)], [event('worker_reported'), event('verify_pass'), event('worker_reported')]).counts).toMatchObject({ verified: 0, unverified: 1 })
  expect(buildRun([ticket({ status: 'done' })], [event('worker_reported')]).tickets[0]?.stage).toBe('unverified')
  expect(buildRun([ticket({ status: 'done', verdict: { result: 'FAIL', checks: [] } })], []).tickets[0]?.stage).toBe('unverified')
  expect(buildRun([ticket({ status: 'unverified' })], []).counts).toMatchObject({ verified: 0, unverified: 1 })
  // a claim on a ticket still in flight is not "unverified": the verifier has not had its turn
  expect(buildRun([ticket({ status: 'verifying' })], [event('worker_reported')]).counts).toMatchObject({ verified: 0, unverified: 0, inflight: 1 })
  // another ticket's pass does not verify this one
  expect(buildRun([ticket(passed)], [event('worker_reported'), event('verify_pass', 'other')]).counts.verified).toBe(0)
})

test('queued tickets are counted apart; the counts add up to the total', () => {
  const run = buildRun([ticket({ id: 'a', status: 'ready' }), ticket({ id: 'b', status: 'draft' }), ticket({ id: 'c', status: 'mystery' }), ticket({ id: 'd', status: 'blocked' })], [])
  expect(run.counts).toEqual({ total: 4, verified: 0, unproven: 0, unverified: 0, blocked: 1, inflight: 0, queued: 3 })
})

test('the events tail keeps the newest, in order', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ ts: i, type: 'dispatched', ticket: 't', detail: String(i) }))
  const run = buildRun([], many)
  expect(run.events).toHaveLength(ROUTER_CAPS.EVENTS_TAIL)
  expect(run.events.map(e => e.detail)).toEqual(Array.from({ length: ROUTER_CAPS.EVENTS_TAIL }, (_, i) => String(30 - ROUTER_CAPS.EVENTS_TAIL + i)))
})

const T0 = 1_800_000_000_000 // epoch ms: a smaller number would be read as seconds

test('ticket.json lagging events.jsonl: a newer stage event wins, an older or unknown one changes nothing', () => {
  const at = (type: string, ts: number): RouterEvent => ({ ts, type, ticket: 't', detail: '' })
  const lagging = ticket({ status: 'ready', updated_at: T0 })
  const stageOf = (events: RouterEvent[]) => buildRun([lagging], events).tickets[0]?.stage
  expect(stageOf([at('dispatched', (T0 + 1000))])).toBe('building')
  expect(stageOf([at('dispatched', (T0 + 1000)), at('verify_fail', (T0 + 2000))])).toBe('fixing')
  expect(stageOf([at('verify_pass', (T0 + 2000))])).toBe('done') // a verifier PASS event is the verdict even before ticket.json says so
  expect(stageOf([at('dispatched', (T0 - 1000))])).toBe('ready') // older than the file: the file stands
  expect(stageOf([at('watchdog_nudge', (T0 + 2000))])).toBe('ready') // an event type the panel does not know says nothing about the stage
  expect(buildRun([lagging], [at('worker_reported', (T0 + 2000))]).counts.unverified).toBe(0) // a claim is verifying, not done
})

// A real router-kit v1 run (Haiku toy, fix round 1): the grader went green, the verifier flagged an untracked file, the router escalated.
const REAL_FIX_TICKET = { id: '01-double', title: 'Add double(x) to mathutil with unit test', status: 'unverified', depends_on: [], agent: 'worker', worker_id: 'a010fa040ba0c8100', fix_rounds: [{ n: 1, verdict: 'FAIL', evidence: 'test_grader.GraderTest.test_factor_constant AttributeError: mathutil has no DOUBLE_FACTOR', at: '2026-11-09T09:38:48Z' }], verdict: { result: 'FAIL', checks: [{ item: 'Project tests pass', pass: true, evidence: '4 tests OK' }, { item: 'Check 7: only intended files changed', pass: false, evidence: 'untracked test_grader.py' }], at: '2026-11-09T09:39:29Z' }, decisions: [], updated_at: '2026-11-09T09:39:29Z' }
const REAL_FIX_EVENTS = [
  ['09:37:43', 'ticket_created'], ['09:37:46', 'dispatched'], ['09:38:09', 'worker_reported'], ['09:38:27', 'verify_pass'], ['09:38:27', 'done'],
  ['09:38:48', 'fix_sent'], ['09:39:03', 'worker_reported'], ['09:39:29', 'verify_fail'], ['09:39:29', 'escalated'],
]
  .map(([at, type]) => JSON.stringify({ ts: `2026-11-09T${at}Z`, type, ticket: '01-double', detail: type }))
  .join('\n')

test('a real fix-round run: one fix round of two, the failing check kept, and unverified (not done) after a verified-then-reopened ticket', () => {
  const t = parseTicket(REAL_FIX_TICKET, '01-double')
  expect(t).toMatchObject({ stage: 'unverified', result: 'FAIL', fixRound: 1, maxRounds: 2, agent: 'worker' })
  expect(t.checks.map(c => c.pass)).toEqual([true, false])
  const run = buildRun([t], parseEvents(REAL_FIX_EVENTS))
  expect(run.tickets[0]?.stage).toBe('unverified') // `done`/verify_pass came first, then a fix and a failed re-verify: the file's stage stands
  expect(run.counts).toMatchObject({ verified: 0, unverified: 1 })
})
