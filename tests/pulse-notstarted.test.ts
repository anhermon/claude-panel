// T77: delegation-kit attempts that never started (deferred by the load governor, refused) are not "done". Ingest outcome and note, the row
// state on the board, the agents-scene row and counts, retries folded into the newest attempt, and the codex detail without a transcript.
import { expect, test } from 'claude-code/testing'

import { buildRunDetail, RUN_ABSENT, RUN_DETAIL_REASON } from '../hooks/agent-detail-run'
import { agentRowsOf, countsOf } from '../hooks/agents-info-data'
import { agentLanes } from '../hooks/board-agents'
import { collapseNotStarted, NOT_STARTED_OUTCOME } from '../hooks/not-started'
import { ingestRun, runLoopId, verdictOf } from '../hooks/pulse-ingest'
import { MAIN_LOOP, newModel } from '../hooks/pulse-model'
import type { PulseLoop, PulseModel } from '../hooks/pulse-model'
import { foldDelegations, notStartedNote, parseRunJson } from '../hooks/run-records'
import type { RunRecord } from '../hooks/run-records'

const SESSION = '00000000-0000-4000-8000-000000000001'
const NOW = Date.parse('2026-11-09T10:30:00.000Z')
const STARTED = '2026-11-09T10:29:50.000Z' // finished rows are shown for a while after they ended: stay just before NOW
const ENDED = '2026-11-09T10:29:55.000Z'
const MIN = 60_000
const GOVERNOR_REASON = 'load_governor: load average 11.2 above 8.0'
const TITLE = 'Harder autonomy traps'
const BUSY_NOTE = 'Not started: machine busy (load governor)'
const LONG_TITLE = 'Write the migration for the orders table and its three indexes'
const LONG_TITLE_CHARS = LONG_TITLE.length

const record = (runId: string, over: Record<string, unknown> = {}): RunRecord => {
  const r = parseRunJson(JSON.stringify({ v: 1, runId, harness: 'codex', sessionId: SESSION, startedAt: STARTED, status: 'running', title: TITLE, model: 'gpt-6.1-sol', effort: 'high', ...over }))
  if (r === undefined) throw new Error('bad record')
  return r
}
const deferred = (runId: string, over: Record<string, unknown> = {}) => record(runId, { status: 'deferred', started: false, endedAt: ENDED, reason: GOVERNOR_REASON, ...over })
const refused = (runId: string, over: Record<string, unknown> = {}) => record(runId, { status: 'refused', started: false, endedAt: ENDED, reason: 'prompt too large for the harness', ...over })
const okRun = (runId: string) => record(runId, { status: 'ok', endedAt: '2026-11-09T10:29:58Z' })
const failedRun = (runId: string) => record(runId, { status: 'failed', endedAt: '2026-11-09T10:29:58Z' })

function ingested(...records: RunRecord[]): PulseModel {
  const m = newModel(NOW - 30 * MIN)
  for (const r of records) ingestRun(m, r, [], [], NOW)
  return m
}
const loopOf = (m: PulseModel, runId: string): PulseLoop => {
  const l = m.loops.get(runLoopId(runId))
  if (l === undefined) throw new Error(`no loop ${runId}`)
  return l
}

test('ingest: deferred and refused are done-with-outcome notstarted and a plain note; ok stays done with no outcome; failed stays failed', () => {
  const m = ingested(deferred('r-deferred'), refused('r-refused'), okRun('r-ok-00'), failedRun('r-failed'))
  expect(loopOf(m, 'r-deferred')).toMatchObject({ status: 'done', outcome: NOT_STARTED_OUTCOME, why: BUSY_NOTE })
  expect(loopOf(m, 'r-refused')).toMatchObject({ status: 'done', outcome: NOT_STARTED_OUTCOME, why: 'Not started: refused (prompt too large for the harness)' })
  expect(loopOf(m, 'r-ok-00').outcome).toBeUndefined()
  expect(loopOf(m, 'r-ok-00').why).toBeUndefined()
  expect(loopOf(m, 'r-failed')).toMatchObject({ status: 'done', outcome: 'failed' })
  expect(loopOf(m, 'r-failed').why).toBeUndefined()
})

test('a ledger row says it never started by started:false, a DEFERRED or REFUSED verdict or a status word, with or without an end time', () => {
  const row = (id: string, over: Record<string, unknown>) => JSON.stringify({ id, sessionId: SESSION, harness: 'codex', description: TITLE, ...over })
  const lines = [
    row('l-flag-00', { status: 'running', startedAt: STARTED }),
    row('l-flag-00', { endedAt: ENDED, started: false, verdict: 'whatever' }),
    row('l-defer-0', { endedAt: ENDED, startedAt: STARTED, verdict: 'DEFERRED (load governor): load 11' }),
    row('l-refus-0', { endedAt: ENDED, startedAt: STARTED, verdict: 'DELEGATE_REFUSED_OVERSIZED (too big)' }),
    row('l-fine-00', { endedAt: ENDED, startedAt: STARTED, status: 'ok', ok: true, verdict: 'PASS' }),
  ]
  const by = new Map(foldDelegations(lines, SESSION).map(r => [r.runId, r]))
  for (const id of ['l-flag-00', 'l-defer-0', 'l-refus-0']) expect(verdictOf(by.get(id) as RunRecord)).toEqual({ isDone: true, outcome: NOT_STARTED_OUTCOME })
  expect(by.get('l-flag-00')?.transcript).toBeUndefined() // nothing ran: no rollout to look for
  expect(verdictOf(by.get('l-fine-00') as RunRecord)).toEqual({ isDone: true })
  expect(verdictOf(deferred('r-noend0', { endedAt: undefined }))).toEqual({ isDone: true, outcome: NOT_STARTED_OUTCOME })
  expect(verdictOf(refused('r-noend1', { endedAt: undefined }))).toEqual({ isDone: true, outcome: NOT_STARTED_OUTCOME })
})

test('ingest is idempotent for a not-started attempt: the second look changes nothing', () => {
  const m = ingested(deferred('r-twice0'))
  const before = JSON.stringify(loopOf(m, 'r-twice0'))
  expect(ingestRun(m, deferred('r-twice0'), [], [], NOW)).toBe(false)
  expect(JSON.stringify(loopOf(m, 'r-twice0'))).toBe(before)
})

test('the note: the governor reads as machine busy, a refusal keeps its short reason, an unknown reason is shown short, none is just "Not started"', () => {
  expect(notStartedNote(deferred('r-note-0'))).toBe(BUSY_NOTE)
  expect(notStartedNote(refused('r-note-1'))).toBe('Not started: refused (prompt too large for the harness)')
  expect(notStartedNote(refused('r-note-2', { reason: undefined, verdict: 'DELEGATE_REFUSED_OVERSIZED' }))).toBe('Not started: refused (DELEGATE_REFUSED_OVERSIZED)')
  expect(notStartedNote(refused('r-note-3', { reason: undefined }))).toBe('Not started: refused')
  expect(notStartedNote(deferred('r-note-4', { reason: undefined }))).toBe('Not started')
  expect(notStartedNote(refused('r-note-5', { reason: 'x'.repeat(500) })).length).toBeLessThan(120)
})

test('board: a not-started row is waiting (not done, not blocked), with the reason in its step and note; ok is done, failed is blocked', () => {
  const m = ingested(deferred('r-board-0'), record('r-board-1', { status: 'ok', title: 'Finished job', endedAt: '2026-11-09T10:29:58Z' }), record('r-board-2', { status: 'failed', title: 'Broken job', endedAt: '2026-11-09T10:29:58Z' }))
  const rows = agentLanes([], [...m.loops.values()], '', NOW)
  const by = (runId: string) => rows.find(r => r.loop === runLoopId(runId))
  expect(by('r-board-0')).toMatchObject({ state: 'waiting', step: BUSY_NOTE, note: BUSY_NOTE })
  expect(by('r-board-1')?.state).toBe('done')
  expect(by('r-board-2')?.state).toBe('blocked')
})

test('retries: earlier not-started attempts with the same description fold into the newest, which counts them; other descriptions and finished runs stay', () => {
  const m = ingested(
    deferred('r-retry-0', { startedAt: '2026-11-09T10:29:10Z' }),
    deferred('r-retry-1', { startedAt: '2026-11-09T10:29:20Z' }),
    refused('r-retry-2', { startedAt: '2026-11-09T10:29:30Z' }),
    deferred('r-other-0', { title: 'Another job', startedAt: '2026-11-09T10:29:25Z' }),
    record('r-fine-00', { status: 'ok', title: 'Unrelated job', endedAt: '2026-11-09T10:29:58Z' }),
  )
  const loops = [...m.loops.values()]
  const { loops: kept, retries } = collapseNotStarted(loops)
  expect(kept.map(l => l.runId)).toEqual(expect.arrayContaining(['r-retry-2', 'r-other-0', 'r-fine-00']))
  expect(kept.map(l => l.runId)).not.toContain('r-retry-0')
  expect(kept.map(l => l.runId)).not.toContain('r-retry-1')
  expect(retries.get(runLoopId('r-retry-2'))).toBe(2)
  expect(retries.has(runLoopId('r-other-0'))).toBe(false)
  const rows = agentLanes([], loops, '', NOW)
  expect(rows.find(r => r.loop === runLoopId('r-retry-2'))?.note).toContain('retried 2 times')
  expect(rows.filter(r => r.label === TITLE)).toHaveLength(1)
  expect(collapseNotStarted([loopOf(m, 'r-other-0')]).retries.size).toBe(0) // a single attempt is not a retry
})

test('retries: one earlier attempt reads "retried 1 time"; a later finished run of the same description keeps the earlier attempts folded', () => {
  const m = ingested(deferred('r-once-00', { startedAt: '2026-11-09T10:29:10Z' }), deferred('r-once-01', { startedAt: '2026-11-09T10:29:20Z' }))
  const rows = agentLanes([], [...m.loops.values()], '', NOW)
  expect(rows.find(r => r.loop === runLoopId('r-once-01'))?.note).toBe(`${BUSY_NOTE} · retried 1 time`)
  const later = ingested(deferred('r-once-02', { startedAt: '2026-11-09T10:29:10Z' }), okRun('r-once-03'))
  const kept = collapseNotStarted([...later.loops.values()]).loops.map(l => l.runId).filter(Boolean)
  expect(kept).toEqual(['r-once-03'])
})

test('the agents-scene row: a not-started run carries notStarted and the note, an end time, and is counted apart from done and waiting', () => {
  // a crew needs an agent that is not over: a running one (the board shows a finished crew as plain done rows only while one works)
  const m = ingested(record('r-scene-2', { title: 'Still going' }), deferred('r-scene-0'), record('r-scene-1', { status: 'ok', title: 'Finished job', endedAt: '2026-11-09T10:29:58Z' }))
  const main = m.loops.get(MAIN_LOOP)
  const input = { lanes: [], loops: main ? [main, ...[...m.loops.values()].filter(l => l.id !== MAIN_LOOP)] : [...m.loops.values()], events: [], now: NOW, task: null }
  const { agents } = agentRowsOf(input)
  const ns = agents.find(a => a.loop === runLoopId('r-scene-0'))
  const fine = agents.find(a => a.loop === runLoopId('r-scene-1'))
  expect(ns).toMatchObject({ state: 'waiting', notStarted: true, note: BUSY_NOTE })
  expect(ns?.endedAt).not.toBeNull()
  expect(fine?.notStarted).toBeUndefined()
  expect(countsOf(agents)).toMatchObject({ notStarted: 1, done: 1, waiting: 0 })
})

test('the full description of a codex run reaches the row, not a 28-character cut', () => {
  const m = ingested(deferred('r-long-00', { title: LONG_TITLE }))
  const row = agentLanes([], [...m.loops.values()], '', NOW).find(r => r.loop === runLoopId('r-long-00'))
  expect(row?.label.length).toBeGreaterThan(28)
  expect(row?.label.length).toBeLessThanOrEqual(LONG_TITLE_CHARS)
})

test('detail without a transcript, not started: states why in codex terms, with the brief head, and never names Claude Code', () => {
  const m = ingested(deferred('r-detail-0', { promptHead: 'Write the migration.\nKeep it small.' }))
  const rec = deferred('r-detail-0', { promptHead: 'Write the migration.\nKeep it small.' })
  const { unavailable, run } = buildRunDetail({ loop: loopOf(m, 'r-detail-0'), record: rec })
  expect(unavailable).toBe(RUN_DETAIL_REASON.NOT_STARTED)
  expect(run).toMatchObject({ harness: 'codex', status: 'Not started', recordStatus: 'deferred', isNotStarted: true, model: 'gpt-6.1-sol', effort: 'high', title: TITLE })
  expect(run.reason).toContain('load_governor')
  expect(run.prompt).toEqual({ text: 'Write the migration.\nKeep it small.', source: 'head' })
  expect(run.result).toBeNull()
  expect(run.absent).toEqual(expect.arrayContaining([RUN_ABSENT.ROLLOUT, RUN_ABSENT.RESULT, RUN_ABSENT.TOKENS]))
  expect(run.absent).not.toContain(RUN_ABSENT.VERDICT) // an attempt that never ran has no verdict to miss
  expect(JSON.stringify({ unavailable, run })).not.toMatch(/Claude Code/i)
})

test('detail without a transcript, finished: the brief and result from their files, the verdict word and tokens; missing ones are listed as absent', () => {
  const rec = record('r-detail-1', { status: 'ok', endedAt: '2026-11-09T10:10:00Z', verdict: 'PASS', tokens: { fresh: 4200 } })
  const m = ingested(rec)
  const full = buildRunDetail({ loop: loopOf(m, 'r-detail-1'), record: rec, prompt: 'The brief\nsecond line', result: 'Done: added the flag' })
  expect(full.unavailable).toBe(RUN_DETAIL_REASON.NO_ROLLOUT)
  expect(full.run).toMatchObject({ status: 'Finished', isNotStarted: false, verdict: 'PASS', tokens: 4200, prompt: { text: 'The brief\nsecond line', source: 'file' }, result: 'Done: added the flag' })
  expect(full.run.absent).toEqual([RUN_ABSENT.ROLLOUT])
  const bare = buildRunDetail({ loop: loopOf(m, 'r-detail-1') })
  expect(bare.run.absent).toEqual(expect.arrayContaining([RUN_ABSENT.RECORD, RUN_ABSENT.ROLLOUT, RUN_ABSENT.PROMPT, RUN_ABSENT.RESULT]))
})
