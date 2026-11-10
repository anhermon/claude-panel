import { EXAMPLE_THREAD, EXAMPLE_OTHER_THREAD, EXAMPLE_RUN, EXAMPLE_SECOND_RUN } from './fixtures/codex/ids'
// The pure run records: delegation-kit's ledger folded into one record per run, the `.router/runs/*.json` record validated, the thread id
// of an events line, the rollout name match. Nothing here may throw on bad input.
import { expect, test } from 'claude-code/testing'

import { foldDelegations, parseRunJson, rolloutNameMatches, RUN_RECORD, RUN_STATUS, threadIdOfEvents, titleOf } from '../hooks/run-records'
import { DELEGATIONS, EVENTS } from './fixtures/codex/fixtures'

const SESSION = '00000000-0000-4000-8000-000000000001'
const THREAD = EXAMPLE_THREAD
const CACHE = '/home/u/.cache/delegation-kit'
const lines = (text: string): string[] => text.split('\n').filter(l => l !== '')
const start = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({ id: 'r1-codex-aaaaaa', status: 'running', pid: 1, startedAt: '2026-01-01T10:00:00.000Z', harness: 'codex', workdir: '/w', sessionId: SESSION, description: 'Do a thing', role: 'developer', ...over })
const end = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({ id: 'r1-codex-aaaaaa', startedAt: '2026-01-01T10:00:00.000Z', endedAt: '2026-01-01T10:01:00.000Z', durationS: 60, harness: 'codex', verdict: 'CODEX_OK', ok: true, sessionId: SESSION, checks: [], ...over })

test('the start and the terminal row of a run fold into one record; another session is filtered out', () => {
  const runs = foldDelegations(lines(DELEGATIONS), SESSION, CACHE)
  expect(runs.map(r => r.runId)).toEqual([EXAMPLE_RUN, EXAMPLE_SECOND_RUN])
  const [finished, running] = runs
  expect(finished).toMatchObject({
    v: RUN_RECORD.VERSION,
    harness: 'codex',
    model: 'gpt-6.1-sol',
    effort: 'medium',
    sessionId: SESSION,
    status: RUN_STATUS.OK,
    verdict: 'CODEX_OK',
    ok: true,
    durationS: 70.191,
    endedAt: '2026-01-01T10:06:44.600Z',
    ticket: 'T1',
    ticketSource: 'explicit',
    role: 'developer',
    pid: 1001,
    resultPath: '/tmp/example-session/result.md',
    promptPath: '/tmp/example-session/prompt.md',
    tokens: { fresh: 69329, peakContext: 61996, contextCap: 475000 },
    transcript: { format: 'codex-rollout', eventsPath: `${CACHE}/delegations/${EXAMPLE_RUN}/events.jsonl` },
  })
  expect(finished?.checks).toEqual([{ cmd: 'node scripts/check-notes.mjs', ok: true, exit: 0 }])
  expect(running).toMatchObject({ status: RUN_STATUS.RUNNING, harness: 'codex', title: 'Review empty-note export' })
  expect(running?.endedAt).toBeUndefined()
  expect(running?.resultPath).toBe(`${CACHE}/delegations/${EXAMPLE_SECOND_RUN}/result.md`)
  expect(foldDelegations(lines(DELEGATIONS), '00000000-0000-4000-8000-000000000006').map(r => r.harness)).toEqual(['agy'])
  expect(foldDelegations(lines(DELEGATIONS), 'nobody')).toEqual([])
})

test('the title is plain: the ticket token and the routing tail are dropped, and a ticket id is never the title', () => {
  expect(foldDelegations(lines(DELEGATIONS), SESSION)[0]?.title).toBe('Add note search')
  expect(titleOf('T63', 'codex')).toBe('Codex run')
  expect(titleOf('', 'agy', 'Ticket: T7\nRefactor the parser module and keep the tests green.')).toBe('Refactor the parser module and keep the')
  expect(titleOf(undefined, '')).toBe('Agent run')
  expect(titleOf('T71 · survey the harness (sonnet/low)', 'codex')).toBe('Survey the harness')
  const [r] = foldDelegations([start({ description: 'T12', ticket: 'T12' })], SESSION)
  expect(r?.title).toBe('Codex run')
  expect(r?.ticket).toBe('T12')
})

test('the status: ok needs ok, an _OK verdict and passing checks; blocked and cancelled by verdict; any other word passes through', () => {
  const status = (over: Record<string, unknown>): string | undefined => foldDelegations([start(), end(over)], SESSION)[0]?.status
  expect(status({})).toBe('ok')
  expect(status({ ok: false })).toBe('failed')
  expect(status({ checks: [{ cmd: 'make', ok: false, exit: 1 }] })).toBe('failed')
  expect(status({ verdict: 'CODEX_ERROR', ok: false })).toBe('failed')
  expect(status({ verdict: 'CODEX_BLOCKED', ok: false })).toBe('blocked')
  expect(status({ verdict: 'CANCELLED', ok: false, status: 'cancelled' })).toBe('cancelled')
  expect(status({ verdict: 'CANCELLED', ok: false })).toBe('cancelled')
  expect(status({ status: 'aborted', verdict: 'ABORTED', ok: false })).toBe('aborted')
  expect(status({ status: 'deferred', verdict: 'DEFERRED (load governor)' })).toBe('deferred')
  expect(status({ status: 'some-new-word-from-the-owner' })).toBe('some-new-word-from-the-owner')
  expect(status({ status: 'completed' })).toBe('ok') // the plain legacy word is not a status of its own
  expect(foldDelegations([start()], SESSION)[0]?.status).toBe('running')
})

test('later fields win; a terminal row without a start still gives a record; the order is by start time', () => {
  const rows = [end({ id: 'b-codex-bbbbbb', startedAt: '2026-01-01T09:00:00.000Z' }), start(), end({ model: 'm1', effort: 'high', tokens: 5, peakContext: 3, contextCap: 9 }), start({ id: 'c-codex-cccccc', startedAt: '2026-01-01T11:00:00.000Z' })]
  const runs = foldDelegations(rows, SESSION)
  expect(runs.map(r => r.runId)).toEqual(['b-codex-bbbbbb', 'r1-codex-aaaaaa', 'c-codex-cccccc'])
  expect(runs[1]).toMatchObject({ model: 'm1', effort: 'high', pid: 1, tokens: { fresh: 5, peakContext: 3, contextCap: 9 } })
})

test('garbage never throws and gives no record: not JSON, no id, an unsafe id, no session, cut lines', () => {
  const rows = ['', 'not json', 'null', '[]', '42', '{"id":1}', '{"sessionId":"x"}', start({ id: '../../etc' }), start({ id: 'ab' }), start({ startedAt: undefined }), start().slice(0, 40), JSON.stringify({ id: 'x-codex-123456', sessionId: SESSION })]
  expect(() => foldDelegations(rows, SESSION)).not.toThrow()
  expect(foldDelegations(rows, SESSION)).toEqual([])
  expect(foldDelegations([], SESSION)).toEqual([])
})

test('parseRunJson: a v1 record is checked, unknown fields are dropped, the title is made plain', () => {
  const full = {
    v: 1,
    runId: EXAMPLE_RUN,
    harness: 'codex',
    model: 'gpt-6.1-sol',
    effort: 'medium',
    workdir: '/w',
    sessionId: SESSION,
    startedAt: '2026-01-01T10:05:34.409Z',
    status: 'brand-new-status',
    title: 'T63 · Harder traps (gpt-6.1-sol/medium)',
    transcript: { format: 'codex-rollout', path: '/p/rollout.jsonl', threadId: THREAD, confidence: 'guessed', surprise: 1 },
    tokens: { fresh: 1, input: 'x', surprise: 2 },
    checks: [{ cmd: 'make', ok: true, exit: 0 }, 'junk', { nope: 1 }],
    eval: { line: 'tests pass', result: 'pass' },
    progress: { done: 9, total: 6, note: 'n' },
    surprise: { deep: true },
  }
  const rec = parseRunJson(JSON.stringify(full))
  expect(rec).toMatchObject({ runId: full.runId, status: 'brand-new-status', title: 'Harder traps', eval: { line: 'tests pass', result: 'pass' }, progress: { done: 6, total: 6, note: 'n' } })
  expect(rec?.transcript).toEqual({ format: 'codex-rollout', path: '/p/rollout.jsonl', threadId: THREAD, confidence: 'guessed' })
  expect(rec?.tokens).toEqual({ fresh: 1 })
  expect(rec?.checks).toEqual([{ cmd: 'make', ok: true, exit: 0 }])
  expect(rec).not.toHaveProperty('surprise')
})

test('parseRunJson: invalid input gives undefined, never a throw', () => {
  const ok = { v: 1, runId: 'r-codex-abcdef', harness: 'codex', sessionId: SESSION, startedAt: '2026-01-01T10:00:00Z', status: 'running' }
  expect(parseRunJson(JSON.stringify(ok))).toBeDefined()
  for (const bad of ['', 'nope', '{"v":1', 'null', '[]', '7', JSON.stringify({ ...ok, v: 2 }), JSON.stringify({ ...ok, runId: undefined }), JSON.stringify({ ...ok, runId: '../x/y/z/abc' }), JSON.stringify({ ...ok, harness: 5 }), JSON.stringify({ ...ok, sessionId: '' }), JSON.stringify({ ...ok, status: null }), JSON.stringify({ ...ok, startedAt: undefined })])
    expect(parseRunJson(bad)).toBeUndefined()
  expect(parseRunJson(JSON.stringify({ ...ok, title: 'T9' }))?.title).toBe('Codex run')
})

test('threadIdOfEvents: the thread.started line only; rolloutNameMatches: the id as the whole tail of the name', () => {
  expect(threadIdOfEvents(lines(EVENTS)[0]!)).toBe(THREAD)
  for (const bad of ['', 'x', '{"type":"turn.started"}', '{"type":"thread.started"}', '{"type":"thread.started","thread_id":"a/b"}', '{"type":"thread.started","thread_id":5}']) expect(threadIdOfEvents(bad)).toBeUndefined()
  const name = `rollout-2026-01-01T12-05-35-${THREAD}.jsonl`
  expect(rolloutNameMatches(name, THREAD)).toBe(true)
  expect(rolloutNameMatches(name, EXAMPLE_OTHER_THREAD)).toBe(false)
  expect(rolloutNameMatches(`rollout-2026-01-01T12-05-35-9${THREAD}.jsonl`, THREAD)).toBe(false)
  expect(rolloutNameMatches(`other-${THREAD}.jsonl`, THREAD)).toBe(false)
  expect(rolloutNameMatches(`${name}.tmp`, THREAD)).toBe(false)
  expect(rolloutNameMatches(name, '../x')).toBe(false)
  expect(rolloutNameMatches(name, '')).toBe(false)
})
