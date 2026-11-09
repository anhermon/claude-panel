// A realistic router-kit run in the files' own (contract) shape: five tickets (done+PASS, verifying, fixing round 1 of 2,
// unverified after 2 rounds, blocked) and the events that led there. Shared by router-state, router-frames and router-io tests.
import { buildRun, parseEvents, parseTicket } from '../hooks/router-state'
import type { RouterRun } from '../hooks/router-state'

export const NOW = Date.parse('2026-11-09T10:10:00Z')
const at = (minAgo: number): string => new Date(NOW - minAgo * 60_000).toISOString()
const check = (item: string, pass: boolean | null, evidence = ''): Record<string, unknown> => ({ item, pass, evidence })

export const TICKET_FILES: Record<string, Record<string, unknown>> = {
  '01-schema': {
    id: '01-schema', title: 'Booking tables and migration', status: 'done', depends_on: [], agent: 'worker', fix_rounds: [],
    verdict: { result: 'PASS', at: at(30), checks: [check('Migration runs', true, 'exit 0'), check('Tables exist', true), check('Rollback works', true), check('Seed loads', true)] },
    decisions: [{ question: 'UUID or serial ids?', chosen: 'UUID', basis: 'ids cross services' }], updated_at: at(30),
  },
  '02-api': { id: '02-api', title: 'Booking API endpoints', status: 'verifying', depends_on: ['01-schema'], agent: 'worker', fix_rounds: [], verdict: { result: null, checks: [] }, updated_at: at(2) },
  '03-ui': {
    id: '03-ui', title: 'Booking form UI', status: 'fixing', depends_on: ['01-schema'], agent: 'codex-worker', updated_at: at(4),
    fix_rounds: [{ n: 1, verdict: 'FAIL', evidence: 'empty state missing', at: at(5) }],
    verdict: {
      result: 'FAIL', at: at(5),
      checks: [check('Form validates required fields', true, 'tests/booking-form.test.tsx: 6 passed'), check('Submit posts to /api/bookings', true, 'network log shows POST 201'), check('Empty state shown with no bookings', false, 'screenshot shows a blank list'), check('Error toast on a failed request', false, 'no toast element after a 500')],
    },
  },
  '04-auth': {
    id: '04-auth', title: 'Session auth for bookings', status: 'unverified', depends_on: ['02-api'], agent: 'worker', updated_at: at(7),
    fix_rounds: [{ n: 1, verdict: 'FAIL', evidence: 'token not refreshed', at: at(15) }, { n: 2, verdict: 'FAIL', evidence: 'logout keeps the session', at: at(9) }],
    verdict: { result: 'FAIL', at: at(9), checks: [check('Login works', true), check('Token refresh', true), check('Session expires', true), check('Logout clears session', false, 'cookie still set'), check('CSRF token checked', false, 'header ignored')] },
  },
  '05-deploy': { id: '05-deploy', title: 'Deploy booking to staging', status: 'blocked', depends_on: ['03-ui', '04-auth'], agent: 'worker', updated_at: at(7), fix_rounds: [] },
}

/** eval.md / verdict.md texts: the done ticket has a proof (eval + verdict evidence), the others have an eval that was not run or failed. */
export const EVAL_FILES: Record<string, string> = {
  '01-schema': '# Eval\n\n- Migration runs and the booking tables exist\n- Rollback works\n',
  '03-ui': 'Empty state and error toast show up in the booking form\n',
}
export const VERDICT_FILES: Record<string, string> = { '01-schema': '# Verdict\n\nPASS\n\n4 of 4 checks passed, migration exit 0\n' }

const ev = (minAgo: number, type: string, ticket: string, detail: string): string => JSON.stringify({ ts: at(minAgo), type, ticket, detail })
export const EVENT_LINES: string[] = [
  ev(40, 'ticket_created', '01-schema', 'created 5 tickets'),
  ev(31, 'worker_reported', '01-schema', 'migration done'),
  ev(30, 'verify_pass', '01-schema', '4 of 4 checks'),
  ev(15, 'verify_fail', '04-auth', 'token not refreshed'),
  ev(9, 'verify_fail', '04-auth', '2 checks failed'),
  ev(7, 'escalated', '04-auth', '2 fix rounds used'),
  ev(5, 'verify_fail', '03-ui', 'empty state missing'),
  ev(4, 'fix_sent', '03-ui', 'round 1 of 2'),
  ev(2, 'worker_reported', '02-api', 'claims done'),
]

/** The run the reader would build from the files above. */
export function realisticRun(): RouterRun {
  return buildRun(
    Object.entries(TICKET_FILES).map(([dirName, raw]) => parseTicket(raw, dirName, { evalText: EVAL_FILES[dirName], verdictText: VERDICT_FILES[dirName] })),
    parseEvents(EVENT_LINES.join('\n') + '\n'),
  )
}
