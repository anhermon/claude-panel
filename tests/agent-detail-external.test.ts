// The detail of a codex run: the Transcript, Progress, Struggles and Metrics tabs built from a synthetic rollout and its
// delegation-kit rows (tests/fixtures/codex), the run's own clock, the token split, the no-rollout case and the proof. Pure: no `$`.
import { expect, test } from 'claude-code/testing'

import { buildExternalDetail, EXTERNAL_REASON } from '../hooks/agent-detail-external'
import type { ExternalDetail } from '../hooks/agent-detail-external'
import { agentRowsOf } from '../hooks/agents-info-data'
import { codexAdapter } from '../hooks/harness-adapters/codex'
import { codexFactsOf, activeMsOf } from '../hooks/harness-adapters/codex-facts'
import { ingestRun, runLoopId } from '../hooks/pulse-ingest'
import { newModel } from '../hooks/pulse-model'
import { foldDelegations } from '../hooks/run-records'
import type { RunRecord } from '../hooks/run-records'
import { DELEGATIONS, DELEGATIONS_SMOKE, ROLLOUT_FINISHED, ROLLOUT_SMOKE } from './fixtures/codex/fixtures'

const SESSION = '00000000-0000-4000-8000-000000000001'
const AFTER_MS = 40_000
const SMOKE_RUN_MS = 18_304 // the record: 11:51:03.613 -> 11:51:21.917
const SMOKE_TASK_MS = 11_943
const SMOKE_ACTIVE_MS = 11_939 // the rollout's rows, 11:51:08.595 -> 11:51:20.534
const MINUTE_MS = 60_000
const EPSILON = 1e-6
const lines = (text: string): string[] => text.split('\n').filter(l => l !== '')

type Made = { detail: ExternalDetail; record: RunRecord; start: number; end: number }

/** The detail as the host builds it: the record (with its rollout path), the pulse loop ingestRun made of it, the rollout text. */
function make(delegations: string, rollout: string | null, pick = 0, over: Partial<RunRecord> = {}): Made {
  const found = foldDelegations(lines(delegations), SESSION)[pick] as RunRecord
  const record: RunRecord = { ...found, transcript: { format: 'codex-rollout', path: '/home/u/.codex/sessions/rollout.jsonl', confidence: 'exact' }, ...over }
  const start = Date.parse(record.startedAt)
  const end = Date.parse(record.endedAt ?? record.startedAt)
  const now = end + AFTER_MS
  const model = newModel(start)
  const text = rollout ?? ''
  ingestRun(model, record, codexAdapter.calls(text), codexAdapter.parse(text, true).steps, now, 'done')
  const loop = model.loops.get(runLoopId(record.runId))
  const piece = rollout === null ? null : { text: rollout, headText: '', isWhole: true, size: rollout.length, readBytes: rollout.length }
  const detail = buildExternalDetail({
    subject: { id: runLoopId(record.runId), name: record.title, isMain: false, state: 'done', startedAt: loop?.startedAt ?? start, endedAt: loop?.lastAt ?? end },
    loop,
    record,
    events: [],
    rollout: piece,
    unavailable: EXTERNAL_REASON.NO_ROLLOUT,
    pages: 1,
    now,
  })
  return { detail, record, start, end }
}

test('transcript: the brief (the task, no preamble), what it said, the command with its result note, the report last, real times', () => {
  const { detail, start, end } = make(DELEGATIONS_SMOKE, ROLLOUT_SMOKE)
  const t = detail.transcript
  expect(t).toMatchObject({ isAvailable: true, reason: '', isWhole: true })
  expect(detail.brief.startsWith('Read-only task.')).toBe(true)
  expect(t.entries.map(e => e.kind)).toEqual(['say', 'tool', 'say'])
  const call = t.entries[1]
  expect(call).toMatchObject({ kind: 'tool', tool: 'Bash', error: '', note: 'exit 0 · 1200 total (+5 lines)' })
  expect(call).not.toHaveProperty('cmd') // the evidence fields stay in the mod
  const last = t.entries.at(-1)
  expect(last?.kind === 'say' ? last.text : '').toContain('Eval result: PASS')
  const stamps = t.entries.map(e => e.t)
  expect(stamps).toEqual([...stamps].sort((a, b) => a - b))
  expect(stamps[0]).toBeGreaterThan(start)
  expect(stamps.at(-1)).toBeLessThanOrEqual(end)
})

test('metrics: the run time is the run\'s own clock (18 s), not a lane\'s; active time, calls, failed calls', () => {
  const { detail } = make(DELEGATIONS_SMOKE, ROLLOUT_SMOKE)
  expect(detail.metrics).toMatchObject({ elapsedMs: SMOKE_RUN_MS, activeMs: SMOKE_ACTIVE_MS, idleMs: SMOKE_RUN_MS - SMOKE_ACTIVE_MS, calls: 1, errors: 0 })
  expect(detail.external).toMatchObject({ runMs: SMOKE_RUN_MS, taskMs: SMOKE_TASK_MS, calls: 1, failed: 0, source: 'rollout', isPartial: false })
})

test('metrics: tokens split fresh / cached / output / reasoning with the cache share, peak context vs the window, model:effort, limits, cost', () => {
  const { external } = make(DELEGATIONS_SMOKE, ROLLOUT_SMOKE).detail
  expect(external.tokens).toMatchObject({ input: 42_088, fresh: 21_224, cached: 20_864, output: 176, reasoning: 0, total: 21_400 })
  expect(Math.abs((external.tokens?.cacheShare ?? 0) - 20_864 / 42_088)).toBeLessThan(EPSILON)
  expect(external.context).toMatchObject({ peak: 21_153, window: 475_000 })
  expect(Math.abs((external.context?.share ?? 0) - 21_153 / 475_000)).toBeLessThan(EPSILON)
  expect(external).toMatchObject({ harness: 'codex', model: 'gpt-6.1-sol', effort: 'low' })
  expect(external.rate).toMatchObject({ plan: 'plus', primary: { usedPct: 27, windowMinutes: 300 }, secondary: { usedPct: 12 }, isReached: false })
  expect(external.cost.isMeasured).toBe(false)
  expect(external.cost.reason).toContain('no price')
})

test('a rollout with a failed command, a file change and an encrypted reasoning step: failed calls, issues, phases, hidden thinking', () => {
  const { detail } = make(DELEGATIONS, ROLLOUT_FINISHED)
  expect(detail.external).toMatchObject({ failed: 1, calls: 5, reasoningHidden: 1 })
  expect(detail.external.tokens?.reasoning).toBeGreaterThan(0)
  expect(detail.metrics.errors).toBe(1)
  const tools = detail.transcript.entries.filter(e => e.kind === 'tool')
  expect(tools.map(e => e.kind === 'tool' && e.tool)).toEqual(['Bash', 'Bash', 'Write', 'Edit', 'Bash'])
  expect(tools[1]).toMatchObject({ error: 'exit 1: Error: missing empty-title support', note: 'exit 1 · Error: missing empty-title support (+2 lines)' })
  // Progress: phases from the commands (read / edit / tests), the failure as a concrete issue
  expect(detail.progress.phases.map(p => p.kind)).toEqual(['run', 'edit', 'run'])
  expect(detail.progress.phases[0]?.failed).toBe(true)
  expect(detail.progress.issues.list[0]).toMatchObject({ kind: 'failure', outcome: 'resolved' })
  // Struggles: the failed command, and that it was resolved
  expect(detail.struggles.items[0]).toMatchObject({ kind: 'wrong-turn', outcome: 'resolved' })
})

test('proof: the brief\'s Eval line and the Eval result of the final message, for a brief that is no ticket and for one that is', () => {
  expect(make(DELEGATIONS_SMOKE, ROLLOUT_SMOKE).detail.external.proof).toMatchObject({ result: 'pass', eval: expect.stringContaining('lists exactly 5 files') })
  expect(make(DELEGATIONS, ROLLOUT_FINISHED).detail.external.proof).toEqual({ eval: 'node scripts/check-notes.mjs exits 0', what: 'node scripts/check-notes.mjs exits 0', result: 'pass' })
  const failing = ROLLOUT_SMOKE.replaceAll('Eval result: PASS', 'Eval result: FAIL')
  expect(make(DELEGATIONS_SMOKE, failing).detail.external.proof?.result).toBe('fail')
  const silent = ROLLOUT_SMOKE.replaceAll('Eval result: PASS', 'done')
  expect(make(DELEGATIONS_SMOKE, silent).detail.external.proof?.result).toBe('none')
  expect(make(DELEGATIONS_SMOKE, ROLLOUT_SMOKE.replaceAll('Eval: the answer', 'Check: the answer')).detail.external.proof).toBeNull()
})

test('no rollout: the sentence says so, and the record\'s facts are all that is shown (tokens from the record, no failed-call count)', () => {
  const { detail } = make(DELEGATIONS_SMOKE, null)
  expect(detail.transcript).toMatchObject({ isAvailable: false, reason: 'no rollout found for this run (codex thread unknown)' })
  expect(detail.external).toMatchObject({ source: 'record', failed: null, harness: 'codex', model: 'gpt-6.1-sol', effort: 'low', proof: null })
  expect(detail.metrics.elapsedMs).toBe(SMOKE_RUN_MS) // the run time does not need the rollout
  expect(detail.external.taskMs).toBe(SMOKE_RUN_MS) // the record's durationS
  expect(detail.external.context).toMatchObject({ peak: 21_153, window: 475_000 }) // the record's own peak and cap
})

test('a tail of a long rollout: the brief comes from the start, the facts from both, and it says it is partial', () => {
  const all = lines(ROLLOUT_SMOKE)
  const cut = all.length - 8
  const headText = `${all.slice(0, cut).join('\n')}\n`
  const tail = `${all[cut]?.slice(5)}\n${all.slice(cut + 1).join('\n')}` // starts in the middle of a row
  const piece = { text: tail, headText, isWhole: false, size: ROLLOUT_SMOKE.length, readBytes: tail.length }
  const { record } = make(DELEGATIONS_SMOKE, ROLLOUT_SMOKE)
  const detail = buildExternalDetail({ subject: { id: 'x', name: record.title, isMain: false, state: 'done', startedAt: Date.parse(record.startedAt), endedAt: Date.parse(record.endedAt ?? '') }, loop: undefined, record, events: [], rollout: piece, unavailable: '', pages: 1, now: Date.parse(record.endedAt ?? '') })
  expect(detail.brief.startsWith('Read-only task.')).toBe(true)
  expect(detail.transcript.isWhole).toBe(false)
  expect(detail.external).toMatchObject({ isPartial: true })
  expect(detail.external.tokens?.total).toBe(21_400)
  expect(detail.external.context?.window).toBe(475_000)
})

test('run time regression: a lane somebody posted for the run (6 min earlier) does not change the run\'s own start and end', () => {
  const { record, start, end } = make(DELEGATIONS_SMOKE, ROLLOUT_SMOKE)
  const model = newModel(start)
  ingestRun(model, record, codexAdapter.calls(ROLLOUT_SMOKE), codexAdapter.parse(ROLLOUT_SMOKE, true).steps, end + AFTER_MS, 'done')
  const loop = model.loops.get(runLoopId(record.runId))
  const posted = { id: 'codex-smoke', label: 'Codex smoke test', state: 'done' as const, pct: null, step: '', note: '', goal: '', dod: [], at: null, startedAt: end - 6 * MINUTE_MS - 13_000, updatedAt: end + AFTER_MS, by: 'main', loop: loop?.id }
  const rows = agentRowsOf({ lanes: [posted], loops: [...model.loops.values()], events: [], now: end + AFTER_MS, task: null, router: undefined }).agents
  const row = rows.find(r => r.loop === loop?.id)
  expect(row?.startedAt).toBe(start)
  expect((row?.endedAt ?? 0) - (row?.startedAt ?? 0)).toBe(SMOKE_RUN_MS)
})

test('facts: a cut line, an unknown row or a missing field is skipped; the active time counts only gaps up to the stall limit', () => {
  const facts = codexFactsOf(`${ROLLOUT_SMOKE}\n{"timestamp":"x`, true)
  expect(facts).toMatchObject({ isComplete: true, durationMs: SMOKE_TASK_MS, contextWindow: 475_000 })
  expect(codexFactsOf('', true)).toMatchObject({ startedAt: null, endedAt: null, tokens: null, stamps: [] })
  expect(codexFactsOf('not json\n[]\nnull', false).stamps).toEqual([])
  expect(activeMsOf([0, 1000, 1500, 500_000, 500_900], 120_000)).toBe(2400) // the long silence is idle
  expect(activeMsOf([5], 120_000)).toBe(0)
})
