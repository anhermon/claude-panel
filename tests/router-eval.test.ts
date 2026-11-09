// T68: every ticket needs an eval that proves it is done. eval present / absent, pass / fail / none (a PASS that a later fix_sent or
// worker_reported made stale is not a pass), the `unproven` stage, and the tickets frame that carries the proof to the page.
import { expect, test } from 'claude-code/testing'

import { validateFrame } from '../hooks/board-frames'
import { routerFrames } from '../hooks/router-frames'
import { buildRun, evalResultOf, evalWhatOf, evidenceOfVerdict, parseEvents, parseTicket, EVAL_CAPS } from '../hooks/router-state'
import type { RouterEvent, RouterTicket, TicketFiles } from '../hooks/router-state'

const T0 = Date.parse('2026-11-09T10:00:00Z')
const MIN = 60_000
const at = (min: number, type: string, ticket = 't'): RouterEvent => ({ ts: T0 + min * MIN, type, ticket, detail: '' })
const PASSED = { status: 'done', verdict: { result: 'PASS', at: new Date(T0).toISOString(), checks: [{ item: 'a', pass: true }] } }
/** The file is newer than the events, so it stands. */
const LATER = { updated_at: new Date(T0 + 10 * MIN).toISOString() }
const EVAL = '# Eval\n\n- Magic link signs in and expires after use\n'
const ticket = (over: Record<string, unknown>, files?: TicketFiles): RouterTicket => parseTicket({ id: 't', title: 'T', ...over }, 't', files)
const stageOf = (t: RouterTicket, events: RouterEvent[] = []) => buildRun([t], events).tickets[0]!

test('eval present only when eval.md is there and says something; what is its first criterion in plain words, cut to 60', () => {
  expect(ticket({}).eval).toEqual({ present: false, what: '', result: 'none' })
  expect(ticket({}, { evalText: '' }).eval.present).toBe(false)
  expect(ticket({}, { evalText: '\n  \n# \n' }).eval.present).toBe(false)
  expect(ticket({}, { evalText: EVAL }).eval).toMatchObject({ present: true, what: 'Magic link signs in and expires after use' })
  expect(evalWhatOf('Criteria:\n1. **Run** `npm test` and [see the log](http://x)')).toBe('Run npm test and see the log')
  expect(evalWhatOf('# Only a heading')).toBe('Only a heading')
  const long = evalWhatOf(`- ${'word '.repeat(40)}`)
  expect(long.length).toBeLessThanOrEqual(EVAL_CAPS.WHAT_CHARS)
  expect(long.endsWith('…')).toBe(true)
})

test('evidence is one line of verdict.md that says more than PASS / FAIL', () => {
  expect(evidenceOfVerdict('# Verdict\n\nPASS\n\n4 of 4 checks passed\nmore')).toBe('4 of 4 checks passed')
  expect(evidenceOfVerdict('PASS')).toBeUndefined()
  expect(evidenceOfVerdict('')).toBeUndefined()
  expect(ticket({}, { evalText: EVAL, verdictText: 'FAIL\n\nbutton missing' }).eval.evidence).toBe('button missing')
})

test('a done ticket with an eval and a current verifier PASS is done; the eval says pass', () => {
  const t = stageOf(ticket(PASSED, { evalText: EVAL }), [at(-3, 'worker_reported'), at(-2, 'verify_pass')])
  expect(t.stage).toBe('done')
  expect(t.eval).toMatchObject({ present: true, result: 'pass' })
  expect(stageOf(ticket(PASSED, { evalText: EVAL })).stage).toBe('done') // no events: the verdict stands
})

test('done by status but no eval.md is unproven (reason: no eval), never done and never counted as verified', () => {
  for (const files of [undefined, { evalText: '' }]) {
    const run = buildRun([ticket(PASSED, files)], [at(-3, 'worker_reported'), at(-2, 'verify_pass')])
    expect(run.tickets[0]).toMatchObject({ stage: 'unproven', eval: { present: false, result: 'pass' } })
    expect(run.counts).toMatchObject({ verified: 0, unproven: 1 })
  }
})

test('done but the eval has not passed is unproven (reason: eval not passed)', () => {
  // the file was written after the events (it wins over them), and the events end in a verify_fail
  const failed = ticket({ ...PASSED, updated_at: new Date(T0 + 10 * MIN).toISOString() }, { evalText: EVAL })
  const afterFail = stageOf(failed, [at(1, 'verify_pass'), at(2, 'verify_fail')])
  expect(afterFail).toMatchObject({ stage: 'unproven', eval: { present: true, result: 'fail' } })
  expect(buildRun([failed], [at(1, 'verify_pass'), at(2, 'verify_fail')]).counts).toMatchObject({ verified: 0, unproven: 1 })
})

test('result is pass / fail / none: a FAIL verdict is fail, nothing yet is none', () => {
  expect(stageOf(ticket({ status: 'verifying' }, { evalText: EVAL })).eval.result).toBe('none')
  expect(stageOf(ticket({ status: 'fixing', verdict: { result: 'FAIL', checks: [] } }, { evalText: EVAL })).eval.result).toBe('fail')
  expect(stageOf(ticket({ status: 'ready' }, { evalText: EVAL }), [at(1, 'verify_fail')]).eval.result).toBe('fail')
  expect(stageOf(ticket({ status: 'ready' }, { evalText: EVAL }), [at(1, 'verify_pass')]).eval.result).toBe('pass')
})

test('a pass is stale after a later fix_sent or worker_reported: not a pass, the ticket is not done', () => {
  const t = ticket(PASSED, { evalText: EVAL })
  for (const type of ['fix_sent', 'worker_reported']) {
    const events = [at(-3, 'worker_reported'), at(-2, 'verify_pass'), at(1, type)]
    expect(evalResultOf(t, parseEvents(events.map(e => JSON.stringify({ ...e, ts: new Date(e.ts).toISOString() })).join('\n')))).toBe('none')
    expect(stageOf(t, events).stage).not.toBe('done')
  }
  // a verify_pass AFTER the fix is current again
  const renewed = [at(1, 'fix_sent'), at(2, 'worker_reported'), at(3, 'verify_pass')]
  expect(stageOf(t, renewed)).toMatchObject({ stage: 'done', eval: { result: 'pass' } })
  // the file's own verdict is stale when a fix_sent is newer than its time; an older one is not
  expect(evalResultOf(t, [at(5, 'fix_sent')])).toBe('none')
  expect(evalResultOf(t, [at(-5, 'fix_sent')])).toBe('pass')
  // another ticket's events say nothing
  expect(evalResultOf(t, [at(5, 'fix_sent', 'other')])).toBe('pass')
})

test('the tickets frame carries the proof; unproven rows are ranked before done ones; the title counts them; frames stay valid', () => {
  const tickets = [
    parseTicket({ id: 'a', title: 'Login with email link', ...PASSED, ...LATER }, 'a', { evalText: EVAL, verdictText: 'PASS\n4 of 4 checks passed' }),
    parseTicket({ id: 'b', title: 'Export bookings', ...PASSED, ...LATER }, 'b'),
    parseTicket({ id: 'c', title: 'Invoice layout', ...PASSED, ...LATER }, 'c', { evalText: '- Fits one page' }),
  ]
  const events = parseEvents(['a', 'b', 'c'].map(id => JSON.stringify({ ts: T0 - MIN, type: 'verify_pass', ticket: id })).concat(JSON.stringify({ ts: T0 + MIN, type: 'verify_fail', ticket: 'c' })).join('\n'))
  const frame = routerFrames(buildRun(tickets, events), T0)[0]!
  if (frame.type !== 'tickets') throw new Error('not tickets')
  expect(validateFrame(frame)).toEqual(frame)
  expect(frame.title).toBe('Tickets · 1 of 3 verified, 2 unproven')
  expect(frame.summary).toMatchObject({ verified: 1, unproven: 2 })
  expect(frame.items.map(i => [i.title, i.stage])).toEqual([['Export bookings', 'unproven'], ['Invoice layout', 'unproven'], ['Login with email link', 'done']])
  expect(frame.items[0]).toMatchObject({ eval: { present: false, result: 'pass' }, note: 'Done, but it has no eval that proves it' })
  expect(frame.items[1]).toMatchObject({ eval: { present: true, what: 'Fits one page', result: 'fail' }, note: 'Done, but its eval has not passed' })
  expect(frame.items[2]).toMatchObject({ eval: { present: true, what: 'Magic link signs in and expires after use', result: 'pass', evidence: '4 of 4 checks passed' } })
})

test('the frame validator accepts the optional eval and unproven count, and refuses an odd eval', () => {
  const base = { id: 'tickets', type: 'tickets', summary: { total: 1, verified: 0, unverified: 0, blocked: 0, inflight: 0 }, items: [{ id: 'a', title: 'A', stage: 'unproven' }] }
  expect(() => validateFrame(base)).not.toThrow()
  const withEval = { ...base, summary: { ...base.summary, unproven: 1 }, items: [{ ...base.items[0], eval: { present: false, result: 'none' } }] }
  expect(validateFrame(withEval)).toMatchObject(withEval)
  expect(() => validateFrame({ ...base, items: [{ ...base.items[0], eval: { present: true, result: 'maybe' } }] })).toThrow()
  expect(() => validateFrame({ ...base, items: [{ ...base.items[0], eval: { result: 'pass' } }] })).toThrow()
})
