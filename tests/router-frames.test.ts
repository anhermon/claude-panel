// The frames drawn from a router-kit run: tickets (many), checks (one), router-events; titles, order, caps, and the board wiring
// (auto frame, silenced by frame_remove, replaced by a posted frame with the same id). Deterministic: every clock is an argument.
import { expect, test } from 'claude-code/testing'

import { validateFrame } from '../hooks/board-frames'
import { applyFramePlan, assembleFrames, isAutoId, newBoardModel, planFrames } from '../hooks/board-model'
import type { BoardInput } from '../hooks/board-model'
import { rankedTickets, ROUTER_FRAME, routerFrames } from '../hooks/router-frames'
import { buildRun, parseEvents, parseTicket } from '../hooks/router-state'
import type { RouterRun } from '../hooks/router-state'
import { EVENT_LINES, NOW, realisticRun, TICKET_FILES } from './router-fixture'

const BASE: BoardInput = { task: null, status: 'working', ask: null, choices: [], lanes: [], loops: [], pulse: undefined, now: NOW }
const run = (files: Record<string, unknown>[], events: string[] = []): RouterRun =>
  buildRun(files.map((f, i) => parseTicket(f, `t${i}`, { evalText: '- the thing works' })), parseEvents(events.join('\n')))
const frameOf = (r: RouterRun | undefined, id: string) => routerFrames(r, NOW).find(f => f.id === id)

test('no run, or a run with no ticket, draws nothing', () => {
  expect(routerFrames(undefined, NOW)).toEqual([])
  expect(routerFrames(run([]), NOW)).toEqual([])
  expect(routerFrames(run([], EVENT_LINES), NOW)).toEqual([]) // events alone say nothing without tickets
})

test('five tickets: a tickets frame (most relevant first) and the events timeline, every frame valid as built', () => {
  const frames = routerFrames(realisticRun(), NOW)
  expect(frames.map(f => [f.id, f.type])).toEqual([['tickets', 'tickets'], ['router-events', 'timeline']])
  for (const f of frames) expect(validateFrame(f), f.id).toEqual(f)
  const tickets = frames[0]!
  if (tickets.type !== 'tickets') throw new Error('not tickets')
  expect(tickets.title).toBe('Tickets · 1 of 5 verified, 1 unverified')
  expect(tickets.summary).toEqual({ total: 5, verified: 1, unproven: 0, unverified: 1, blocked: 1, inflight: 2 })
  expect(tickets.items.map(i => [i.id, i.stage])).toEqual([['03-ui', 'fixing'], ['02-api', 'verifying'], ['04-auth', 'unverified'], ['05-deploy', 'blocked'], ['01-schema', 'done']])
  expect(tickets.items[0]).toEqual({
    id: '03-ui', title: 'Booking form UI', stage: 'fixing', agent: 'codex-worker', checks: { pass: 2, total: 4 }, round: 1, maxRounds: 2, verdict: 'FAIL',
    eval: { present: true, what: 'Empty state and error toast show up in the booking form', result: 'fail' },
    note: 'Verifier failed: Empty state shown with no bookings; Error toast on a failed request', dependsOn: ['01-schema'],
  })
  expect(tickets.items[2]).toMatchObject({ checks: { pass: 3, total: 5 }, round: 2, verdict: 'FAIL', note: 'Claimed done, but 2 checks still fail after 2 fix rounds' })
  expect(tickets.items[3]).toMatchObject({ note: 'Waiting on Booking form UI, Session auth for bookings', dependsOn: ['03-ui', '04-auth'] })
  expect(tickets.items[4]).toEqual({ id: '01-schema', title: 'Booking tables and migration', stage: 'done', agent: 'worker', checks: { pass: 4, total: 4 }, round: 0, maxRounds: 2, verdict: 'PASS',
    eval: { present: true, what: 'Migration runs and the booking tables exist', result: 'pass', evidence: '4 of 4 checks passed, migration exit 0' } })
  expect(tickets.items[1]).toMatchObject({ verdict: null, note: 'Worker reported done; the verifier is checking' })
  expect(tickets.items[1]!.checks).toBeUndefined()
})

test('a claimed-but-unverified ticket is never counted or titled as verified', () => {
  const claimed = { id: 'a', title: 'A', status: 'done' }
  const r = run([claimed, { id: 'b', title: 'B', status: 'done', verdict: { result: 'PASS', checks: [{ item: 'x', pass: true }] } }], [JSON.stringify({ type: 'worker_reported', ticket: 'a' })])
  const f = frameOf(r, 'tickets')
  if (f?.type !== 'tickets') throw new Error('not tickets')
  expect(f.title).toBe('Tickets · 1 of 2 verified, 1 unverified')
  expect(f.items.find(i => i.id === 'a')).toMatchObject({ stage: 'unverified', note: 'Claimed done, but no verifier PASS yet' })
})

test('the title says what the person learns and always fits the cap', () => {
  const many = (n: number, over: Record<string, unknown>) => Array.from({ length: n }, (_, i) => ({ id: `t${i}`, title: 'T', ...over }))
  const title = (r: RouterRun): string => frameOf(r, 'tickets')!.title!
  expect(title(run(many(2, { status: 'ready' })))).toBe('Tickets · 0 of 2 verified')
  expect(title(run([...many(3, { status: 'unverified' }), ...many(2, { status: 'blocked' }).map(t => ({ ...t, id: `b${t.id}` }))]))).toBe('Tickets · 0 of 5 verified, 3 unverified')
  const wide = run([...many(120, { status: 'unverified' }).map((t, i) => ({ ...t, id: `u${i}` })), ...many(100, { status: 'blocked' }).map((t, i) => ({ ...t, id: `b${i}` }))])
  expect(title(wide).length).toBeLessThanOrEqual(ROUTER_FRAME.TITLE_CHARS)
  expect(title(wide).startsWith('Tickets · 0 of 220 verified')).toBe(true)
})

test('caps: at most 12 tickets (in flight first), long fields cut, the summary still counts all', () => {
  const files = Array.from({ length: 15 }, (_, i) => ({ id: `t${String(i).padStart(2, '0')}`, title: 'x'.repeat(200), status: i < 3 ? 'in_progress' : 'done', agent: 'a'.repeat(50), depends_on: Array.from({ length: 9 }, (_, j) => `dep-${j}`) }))
  const f = frameOf(run(files), 'tickets')
  if (f?.type !== 'tickets') throw new Error('not tickets')
  expect(f.items).toHaveLength(ROUTER_FRAME.TICKET_ITEMS)
  expect(f.summary).toMatchObject({ total: 15, inflight: 3, verified: 0, unverified: 12 }) // done without a verdict is unverified
  expect(f.items.slice(0, 3).map(i => i.stage)).toEqual(['building', 'building', 'building'])
  expect(f.items[0]!.title).toHaveLength(ROUTER_FRAME.TICKET_TITLE_CHARS)
  expect(f.items[0]!.dependsOn).toHaveLength(ROUTER_FRAME.DEPENDS_ITEMS)
  expect(validateFrame(f)).toEqual(f)
})

test('done tickets: the newest first; ties by id', () => {
  const ranked = rankedTickets(run([
    { id: 'old', status: 'done', updated_at: '2026-11-09T09:00:00Z', verdict: 'PASS' },
    { id: 'new', status: 'done', updated_at: '2026-11-09T10:00:00Z', verdict: 'PASS' },
    { id: 'b', status: 'ready' },
    { id: 'a', status: 'ready' },
  ]).tickets)
  expect(ranked.map(t => t.id)).toEqual(['a', 'b', 'new', 'old'])
})

test('an unknown status is shown as draft with its raw word in the note', () => {
  const f = frameOf(run([{ id: 'a', title: 'A', status: 'cancelled' }, { id: 'b', title: 'B', status: 'ready' }]), 'tickets')
  if (f?.type !== 'tickets') throw new Error('not tickets')
  expect(f.items.find(i => i.id === 'a')).toMatchObject({ stage: 'draft', note: 'Unknown status "cancelled"' })
  expect(f.summary.total).toBe(2)
})

test('exactly one ticket: a checks frame with its verdict checks, no tickets frame', () => {
  const frames = routerFrames(run([TICKET_FILES['03-ui']!], EVENT_LINES), NOW)
  expect(frames.map(f => f.id)).toEqual(['checks', 'router-events'])
  const c = frames[0]!
  expect(c).toEqual({
    id: 'checks', type: 'checks', title: 'Checks · 2 of 4 failed · Booking form UI', size: 'm', result: 'FAIL', round: 1, maxRounds: 2,
    items: [
      { item: 'Form validates required fields', pass: true, evidence: 'tests/booking-form.test.tsx: 6 passed' },
      { item: 'Submit posts to /api/bookings', pass: true, evidence: 'network log shows POST 201' },
      { item: 'Empty state shown with no bookings', pass: false, evidence: 'screenshot shows a blank list' },
      { item: 'Error toast on a failed request', pass: false, evidence: 'no toast element after a 500' },
    ],
  })
  expect(validateFrame(c)).toEqual(c)
})

test('one ticket with no verdict yet: its eval checklist, every item not run (pass null)', () => {
  const r = run([{ id: 'only', title: 'Only', status: 'building' }])
  r.tickets[0]!.evalItems = ['Form validates', 'Posts to API']
  const c = frameOf(r, 'checks')
  expect(c).toMatchObject({ title: 'Checks · not checked yet · Only', result: null, round: 0, maxRounds: 2, items: [{ item: 'Form validates', pass: null }, { item: 'Posts to API', pass: null }] })
  expect(validateFrame(c)).toEqual(c)
  expect(frameOf(r, 'tickets')).toBeUndefined()
  // nothing to show for the ticket (no verdict, no checklist): no checks frame rather than an empty one
  expect(routerFrames(run([{ id: 'only', status: 'building' }]), NOW)).toEqual([])
})

test('a passing single ticket reads "all N passed"', () => {
  const c = frameOf(run([TICKET_FILES['01-schema']!]), 'checks')
  expect(c).toMatchObject({ result: 'PASS' })
  expect((c as { title: string }).title).toMatch(/^Checks · all 4 passed · Booking/) // the ticket's title, cut to the frame's title cap
})

test('no ticket id or folder slug is printed: titles come from the ticket, a missing title reads as words', () => {
  const f = frameOf(run([{ id: '03-ui-form', status: 'ready' }, { id: '04-api', title: 'T04 · Booking API (sonnet/low)', status: 'ready', depends_on: ['03-ui-form'] }]), 'tickets')
  if (f?.type !== 'tickets') throw new Error('not tickets')
  expect(f.items.map(i => i.title)).toEqual(['Ui form', 'Booking API'])
  expect(JSON.stringify(f.title)).not.toMatch(/\bT\d+\b|\d\d-/)
})

test('router-events: the newest 6 in order, relative times, tone from the event type', () => {
  const f = frameOf(realisticRun(), 'router-events')
  if (f?.type !== 'timeline') throw new Error('not a timeline')
  expect(f.items).toEqual([
    { when: '15 min ago', text: 'Session auth for bookings · verify_fail', tone: 'danger' },
    { when: '9 min ago', text: 'Session auth for bookings · verify_fail', tone: 'danger' },
    { when: '7 min ago', text: 'Session auth for bookings · escalated', tone: 'danger' },
    { when: '5 min ago', text: 'Booking form UI · verify_fail', tone: 'danger' },
    { when: '4 min ago', text: 'Booking form UI · fix_sent: round 1 of 2', tone: 'warn' },
    { when: '2 min ago', text: 'Booking API endpoints · worker_reported' },
  ])
  expect(f.items).toHaveLength(ROUTER_FRAME.EVENT_ITEMS)
  expect(validateFrame(f)).toEqual(f)
})

test('events carry their tone: verify_fail and escalated danger, verify_pass and done ok, the rest none', () => {
  const lines = ['verify_fail', 'escalated', 'verify_pass', 'done', 'dispatched'].map(type => JSON.stringify({ type, ticket: 't0', ts: NOW }))
  const f = frameOf(run([{ id: 'a', status: 'ready' }, { id: 'b', status: 'ready' }], lines), 'router-events')
  if (f?.type !== 'timeline') throw new Error('not a timeline')
  expect(f.items.map(i => i.tone)).toEqual(['danger', 'danger', 'ok', 'ok', undefined])
  expect(f.items[0]).toMatchObject({ when: 'just now', text: 'T0 · verify_fail' })
})

test('the board: router frames are auto frames, silenced by frame_remove, replaced by a posted frame of the same id', () => {
  const input: BoardInput = { ...BASE, router: realisticRun() }
  expect(['tickets', 'checks', 'router-events'].every(isAutoId)).toBe(true)
  expect(assembleFrames(newBoardModel(), input).map(f => f.id)).toEqual(['tickets', 'router-events'])
  expect(assembleFrames(newBoardModel(), BASE).map(f => f.id)).toEqual([])
  const plan = planFrames({ frame_remove: 'tickets' })
  if (!plan.isOk) throw new Error(plan.error)
  const silenced = applyFramePlan(newBoardModel(), plan.plan)
  if (!silenced.isOk) throw new Error(silenced.error)
  expect(assembleFrames(silenced.model, input).map(f => f.id)).toEqual(['router-events'])
  const own = planFrames({ frame: { id: 'tickets', type: 'text', text: 'mine' } })
  if (!own.isOk) throw new Error(own.error)
  const posted = applyFramePlan(newBoardModel(), own.plan)
  if (!posted.isOk) throw new Error(posted.error)
  expect(assembleFrames(posted.model, input).map(f => [f.id, f.type])).toEqual([['tickets', 'text'], ['router-events', 'timeline']])
})

test('the validator refuses a bad tickets or checks frame, naming the field', () => {
  const refusal = (v: unknown): string => {
    try {
      validateFrame(v)
    } catch (err) {
      return (err as Error).message
    }
    throw new Error('accepted')
  }
  const summary = { total: 1, verified: 0, unverified: 0, blocked: 0, inflight: 1 }
  const item = { id: 'a', title: 'A', stage: 'building' }
  expect(refusal({ id: 'x', type: 'tickets', summary, items: [{ ...item, stage: 'cancelled' }] })).toMatch(/^frame\.items\[0\]\.stage "cancelled" must be one of ready, building/)
  expect(refusal({ id: 'x', type: 'tickets', summary, items: Array.from({ length: 13 }, () => item) })).toMatch(/^frame\.items has 13 items; the limit is 12/)
  expect(refusal({ id: 'x', type: 'tickets', summary: { ...summary, total: 'a' }, items: [item] })).toMatch(/^frame\.summary\.total "a" must be a finite number/)
  expect(refusal({ id: 'x', type: 'tickets', summary, items: [{ ...item, verdict: 'MAYBE' }] })).toMatch(/^frame\.items\[0\]\.verdict "MAYBE" must be one of PASS, FAIL/)
  expect(refusal({ id: 'x', type: 'tickets', summary, items: [{ ...item, colour: 'red' }] })).toMatch(/^frame\.items\[0\]\.colour is not a known field/)
  expect(refusal({ id: 'x', type: 'tickets', summary, items: [{ ...item, note: 'n'.repeat(121) }] })).toMatch(/^frame\.items\[0\]\.note is 121 characters; the limit is 120/)
  expect(refusal({ id: 'x', type: 'checks', items: [{ item: 'a', pass: 'yes' }] })).toMatch(/^frame\.items\[0\]\.pass "yes" must be true, false or null/)
  expect(refusal({ id: 'x', type: 'checks', items: Array.from({ length: 13 }, () => ({ item: 'a', pass: true })) })).toMatch(/^frame\.items has 13 items; the limit is 12/)
  expect(refusal({ id: 'x', type: 'checks', result: 'MAYBE', items: [{ item: 'a', pass: true }] })).toMatch(/^frame\.result "MAYBE" must be one of PASS, FAIL/)
  // a model-posted checks frame may leave the optional fields out
  expect(validateFrame({ id: 'x', type: 'checks', items: [{ item: 'a', pass: true }] })).toEqual({ id: 'x', type: 'checks', result: null, round: 0, maxRounds: 2, items: [{ item: 'a', pass: true }] })
})
