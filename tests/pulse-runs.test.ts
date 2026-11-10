import { EXAMPLE_THREAD, EXAMPLE_RUN, EXAMPLE_SECOND_RUN } from './fixtures/codex/ids'
// Codex runs as pulse agents: the pure ingest (hooks/pulse-ingest.ts) and the poll (hooks/pulse-runs-host.ts) over a pretend disk made of the
// T72 fixtures. A finished run, a running one that grows, an aborted one, an unknown status, another session's record, the snapshot, the
// delegate tool, and the rows of the agents scene.
import { expect, test } from 'claude-code/testing'
import type { EngineInterface } from 'claude-code'

import { agentRowsOf } from '../hooks/agents-info-data'
import { callsOf } from '../hooks/harness-adapters/codex'
import { ingestRun, runLoopId, verdictOf } from '../hooks/pulse-ingest'
import { MAIN_LOOP, beginCall, endCall, newModel, restore, snapshot } from '../hooks/pulse-model'
import type { PulseLoop, PulseModel } from '../hooks/pulse-model'
import { pollRunsNow, startRunsPoll, stopRunsPoll } from '../hooks/pulse-runs-host'
import { parseRunJson } from '../hooks/run-records'
import type { RunRecord } from '../hooks/run-records'
import { kindOf } from '../hooks/work-kinds'
import { DELEGATIONS, EVENTS, ROLLOUT_FINISHED, ROLLOUT_UNFINISHED } from './fixtures/codex/fixtures'

const SESSION = '00000000-0000-4000-8000-000000000001'
const THREAD = EXAMPLE_THREAD
const FIRST = EXAMPLE_RUN
const SECOND = EXAMPLE_SECOND_RUN
const HOME = '/home/u'
const CWD = '/work/acme-notes'
const CACHE = `${HOME}/.cache/delegation-kit`
const DAY = `${HOME}/.codex/sessions/2026/01/01`
const ROLLOUT = `${DAY}/rollout-2026-01-01T12-05-35-${THREAD}.jsonl`
const RUNS = `${CWD}/.router/runs`
const NOW = Date.parse('2026-01-01T10:30:00.000Z')
const FIXTURE_TOKENS = 17135 // fresh (input - cached: 15742) + output (1393) over the five token records of the finished fixture rollout
const ROW_GAP_MS = 5000 // a finished agent's row is shown for a while after it ended: look just after
const ABORT_AGE_MS = 3_600_000

type Disk = Map<string, { text: string; mtimeMs: number }>
const file = (text: string, mtimeMs = NOW - 60_000) => ({ text, mtimeMs })

/** A pretend `$`: files, env, the clock and the session, enough for readRunRecords and the poll. */
function pretend(disk: Disk, sessionId = SESSION): EngineInterface {
  const hasDir = (p: string): boolean => [...disk.keys()].some(k => k.startsWith(`${p}/`))
  return {
    env: { get: async (name: string) => (name === 'HOME' ? HOME : undefined) },
    clock: { now: async () => NOW, every: () => ({ cancel: () => undefined }) },
    session: { id: async () => sessionId, cwd: async () => CWD },
    fs: {
      list: async (p: string) => {
        if (!hasDir(p)) throw new Error('ENOENT')
        const names = new Set([...disk.keys()].filter(k => k.startsWith(`${p}/`)).map(k => k.slice(p.length + 1).split('/')[0]!))
        return [...names].map(name => {
          const f = disk.get(`${p}/${name}`)
          return { name, kind: f ? 'file' : 'dir', size: f ? f.text.length : 0, mtimeMs: f?.mtimeMs ?? 0, isLink: false }
        })
      },
      stat: async (p: string) => {
        const f = disk.get(p)
        if (!f) throw new Error('ENOENT')
        return { kind: 'file', size: f.text.length, mtimeMs: f.mtimeMs, isLink: false }
      },
      read: async (p: string) => {
        const f = disk.get(p)
        if (!f) throw new Error('ENOENT')
        return f.text
      },
    },
    process: {
      run: async (argv: string[]) => {
        const [program, , bytes, path] = argv
        const f = disk.get(path ?? '')
        return f ? { exitCode: 0, stdout: program === 'head' ? f.text.slice(0, Number(bytes)) : f.text.slice(-Number(bytes)), stderr: '' } : { exitCode: 1, stdout: '', stderr: '' }
      },
    },
  } as unknown as EngineInterface
}

const ledgerDisk = (): Disk =>
  new Map([
    [`${CACHE}/delegations.jsonl`, file(DELEGATIONS)],
    [`${CACHE}/delegations/${FIRST}/events.jsonl`, file(EVENTS)],
    [ROLLOUT, file(ROLLOUT_FINISHED)],
  ])

const recordJson = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({ v: 1, runId: FIRST, harness: 'codex', sessionId: SESSION, startedAt: '2026-01-01T10:05:34.409Z', status: 'running', title: 'Add note search', workdir: CWD, transcript: { format: 'codex-rollout', path: ROLLOUT, threadId: THREAD }, ...over })

/** Run the poll once over a disk and give the model. */
async function polled(disk: Disk, sessionId = SESSION, model: PulseModel = newModel(NOW)): Promise<PulseModel> {
  const $ = pretend(disk, sessionId)
  const target = { model: () => model, touch: () => undefined }
  startRunsPoll($, target)
  await pollRunsNow($, target)
  stopRunsPoll()
  return model
}

const loopOf = (m: PulseModel, runId: string): PulseLoop | undefined => m.loops.get(runLoopId(runId))
const spanKinds = (l: PulseLoop | undefined): string[] => [...new Set((l?.spans ?? []).map(s => s.k))]

test('a finished run is a done codex agent with its title, model, spans by kind, tokens, calls and proof', async () => {
  const m = await polled(ledgerDisk())
  const l = loopOf(m, FIRST)
  expect(l).toMatchObject({ status: 'done', harness: 'codex', model: 'gpt-6.1-sol', effort: 'medium', source: 'external', label: 'Add note search', runId: FIRST, confidence: 'exact' })
  expect(l?.label).not.toMatch(/^T\d+$/)
  expect(l?.id).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
  expect(l?.tokens).toBe(FIXTURE_TOKENS)
  expect(l?.calls).toBe(callsOf(ROLLOUT_FINISHED).length)
  expect(l?.calls).toBeGreaterThan(0)
  expect((l?.spans ?? []).length).toBeGreaterThan(0)
  expect(spanKinds(l).length).toBeGreaterThan(1) // the shell and the edits are different kinds of work
  expect(l?.proof).toMatchObject({ result: 'pass' })
  expect(l?.proof?.eval).toContain('check-notes')
  expect(l?.outcome).toBeUndefined()
})

test('a run the ledger calls running, with no transcript yet, stays working with its record title', async () => {
  const l = loopOf(await polled(ledgerDisk()), SECOND)
  expect(l).toMatchObject({ status: 'running', harness: 'codex', label: 'Review empty-note export', calls: 0 })
})

test('polling again adds nothing twice', async () => {
  const m = newModel(NOW)
  await polled(ledgerDisk(), SESSION, m)
  const first = JSON.stringify(loopOf(m, FIRST))
  const calls = m.calls
  await polled(ledgerDisk(), SESSION, m)
  expect(JSON.stringify(loopOf(m, FIRST))).toBe(first)
  expect(m.calls).toBe(calls)
  expect(m.spawned).toBe(2)
})

test('a running run stays working and gains only the new calls on the next poll', async () => {
  const lines = ROLLOUT_FINISHED.split('\n').filter(l => l !== '')
  const half = lines.slice(0, 13).join('\n') + '\n'
  const disk: Disk = new Map([
    [`${RUNS}/${FIRST}.json`, file(recordJson(), NOW - 1000)],
    [ROLLOUT, file(half, NOW - 1000)],
  ])
  const m = await polled(disk)
  const part = loopOf(m, FIRST)
  const callsBefore = part?.calls ?? 0
  expect(part?.status).toBe('running')
  expect(callsBefore).toBeGreaterThan(0)
  expect(callsBefore).toBeLessThan(callsOf(ROLLOUT_FINISHED).length)
  disk.set(ROLLOUT, file(ROLLOUT_FINISHED, NOW - 500))
  await polled(disk, SESSION, m)
  const full = loopOf(m, FIRST)
  expect(full?.calls).toBe(callsOf(ROLLOUT_FINISHED).length) // the first calls were not counted again
  expect(full?.tokens).toBe(FIXTURE_TOKENS)
  expect(full?.status).toBe('done') // the transcript shows the end although the record still says running
})

test('a rollout that stopped without finishing, under a record that still says running, is aborted', async () => {
  const disk: Disk = new Map([
    [`${RUNS}/${FIRST}.json`, file(recordJson())],
    [ROLLOUT, file(ROLLOUT_UNFINISHED, NOW - ABORT_AGE_MS)],
  ])
  expect(loopOf(await polled(disk), FIRST)).toMatchObject({ status: 'done', outcome: 'aborted' })
  const fresh: Disk = new Map([...disk].map(([k, v]) => [k, k === ROLLOUT ? file(ROLLOUT_UNFINISHED, NOW - 1000) : v]))
  expect(loopOf(await polled(fresh), FIRST)).toMatchObject({ status: 'running' })
})

test('the status words: running, ok, failed, blocked, cancelled keep their meaning; any other word never throws', () => {
  const base = parseRunJson(recordJson()) as RunRecord
  const at = (status: string, endedAt?: string): RunRecord => ({ ...base, status, ...(endedAt === undefined ? {} : { endedAt }) })
  expect(verdictOf(at('running'))).toEqual({ isDone: false })
  expect(verdictOf(at('ok', '2026-01-01T10:10:00Z'))).toEqual({ isDone: true })
  expect(verdictOf(at('failed', '2026-01-01T10:10:00Z'))).toEqual({ isDone: true, outcome: 'failed' })
  expect(verdictOf(at('blocked'))).toEqual({ isDone: true, outcome: 'blocked' })
  expect(verdictOf(at('cancelled'))).toEqual({ isDone: true, outcome: 'cancelled' })
  expect(verdictOf(at('deferred'))).toEqual({ isDone: true, outcome: 'notstarted' }) // T77: never started is not done
  expect(verdictOf(at('deferred', '2026-01-01T10:10:00Z'))).toEqual({ isDone: true, outcome: 'notstarted' })
  for (const status of ['deferred', '', 'x'.repeat(500), 'FAILED']) {
    const m = newModel(NOW)
    expect(() => ingestRun(m, at(status || 'weird'), [], [], NOW)).not.toThrow()
    expect(loopOf(m, FIRST)).toBeDefined()
  }
  const m = newModel(NOW)
  ingestRun(m, at('failed', '2026-01-01T10:10:00Z'), [], [], NOW)
  expect(loopOf(m, FIRST)).toMatchObject({ status: 'done', outcome: 'failed' })
})

test("another session's record is ignored", async () => {
  const disk: Disk = new Map([[`${RUNS}/${FIRST}.json`, file(recordJson({ sessionId: 'someone-else-entirely' }))]])
  const m = await polled(disk)
  expect([...m.loops.keys()]).toEqual([MAIN_LOOP])
})

test('snapshot and restore keep the new fields and the cursor, so the next ingest adds nothing', async () => {
  const m = await polled(ledgerDisk())
  const before = loopOf(m, FIRST)
  const back = newModel(NOW)
  expect(restore(back, JSON.parse(JSON.stringify(snapshot(m, NOW))))).toBe(true)
  const after = loopOf(back, FIRST)
  expect(after).toMatchObject({ harness: 'codex', model: 'gpt-6.1-sol', effort: 'medium', runId: FIRST, source: 'external', confidence: 'exact', ingested: before?.ingested })
  await polled(ledgerDisk(), SESSION, back)
  expect(loopOf(back, FIRST)?.calls).toBe(before?.calls)
  expect(loopOf(back, FIRST)?.tokens).toBe(before?.tokens)
})

test("the main loop's delegate tool call reads as Delegating", () => {
  expect(kindOf({ tool: 'delegate', target: '' })).toBe('delegating')
  expect(kindOf({ tool: 'mcp__delegation-kit__delegate', target: '' })).toBe('delegating')
  const m = newModel(NOW)
  endCall(m, NOW + 5000, MAIN_LOOP, beginCall(m, NOW, MAIN_LOOP, 'delegate', ''), false)
  expect(m.loops.get(MAIN_LOOP)?.spans?.[0]?.k).toBe('delegating')
})

test('the rows of the agents scene: a codex run carries harness, model, effort, calls; a Claude agent none of them', async () => {
  const m = await polled(ledgerDisk())
  const claude = beginCall(m, NOW, 'ag-claude', 'Read', 'a.ts')
  endCall(m, NOW + 1000, 'ag-claude', claude, false)
  const now = (loopOf(m, FIRST)?.lastAt ?? NOW) + ROW_GAP_MS
  const rows = agentRowsOf({ lanes: [], loops: [...m.loops.values()], events: m.ring, now, task: null, router: undefined }).agents
  const codex = rows.find(r => r.loop === runLoopId(FIRST))
  expect(codex).toMatchObject({ harness: 'codex', model: 'gpt-6.1-sol', effort: 'medium', confidence: 'exact', state: 'done' })
  expect(codex?.calls).toBe(callsOf(ROLLOUT_FINISHED).length)
  expect(codex?.note).toBeUndefined()
  expect(codex?.segs?.length).toBeGreaterThan(0)
  expect(codex?.tokens).toBe(FIXTURE_TOKENS)
  const other = rows.find(r => r.loop === 'ag-claude')
  expect(other).toBeDefined()
  // (model and effort of a Claude agent now come from its meta file, another ticket: not asserted here)
  for (const key of ['harness', 'calls', 'confidence', 'note'] as const) expect(other).not.toHaveProperty(key)
})

test('a log matched only by folder and time says so in the row note; a failed run reads as blocked', () => {
  const m = newModel(NOW)
  const base = parseRunJson(recordJson({ status: 'failed', endedAt: '2026-01-01T10:10:00.000Z', transcript: { format: 'codex-rollout', path: ROLLOUT, confidence: 'guessed' } })) as RunRecord
  ingestRun(m, base, [], [], NOW)
  beginCall(m, NOW, 'ag-busy', 'Read', 'a.ts') // an agent at work: a crew of only finished agents shows no rows
  const now = (loopOf(m, FIRST)?.lastAt ?? NOW) + ROW_GAP_MS
  const rows = agentRowsOf({ lanes: [], loops: [...m.loops.values()], events: [], now, task: null, router: undefined }).agents
  expect(rows.find(r => r.harness === 'codex')).toMatchObject({ confidence: 'guessed', note: 'log matched by folder and time', state: 'blocked' })
})
