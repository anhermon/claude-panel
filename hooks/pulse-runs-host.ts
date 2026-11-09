// The poll that makes codex (and later agy) runs started by delegation-kit appear as agents of the pulse. Every RUN_IO.POLL_MS (the router
// poll's cadence) it reads this session's run records (./run-records-io.ts), the transcript of each through its harness adapter
// (./harness-adapters), and hands both to the pure ./pulse-ingest.ts. A transcript is read again only when its size or mtime changed (a
// bounded read, never past what `$.fs.read` takes), and a finished run's proof (its brief's `Eval:` line + the final `Eval result:`) is
// resolved once with ./agent-proof.ts. Never throws, never blocks a turn, one tick at a time; it stops with `stopRunsPoll`.
import type { EngineInterface } from 'claude-code'

import { proofOf } from './agent-proof'
import { adapterOf } from './harness-adapters'
import type { HarnessAdapter, HarnessCall } from './harness-adapters/types'
import { setLoopProof } from './pulse-model'
import type { PulseModel } from './pulse-model'
import { ingestRun, runLoopId } from './pulse-ingest'
import { RUN_IO, readRunRecords, resolveRoots } from './run-records-io'
import type { RunRecordsRead } from './run-records-io'
import type { RunRecord } from './run-records'
import type { Step } from './transcript-parse'

type Dollar = EngineInterface

export const RUNS_HOST = {
  POLL_MS: RUN_IO.POLL_MS,
  /** A transcript over this is not read (`$.fs.read` refuses over 4 MiB); the run still shows its row, state and the record's tokens. */
  MAX_TRANSCRIPT_BYTES: 4 * 1024 * 1024 - 1,
} as const

const SIG_MISSING = '-'
const PATH_JOIN = '/'
const PARENT_DIR = '..'

/** What one transcript gave the last time it was read. */
type Seen = {
  sig: string
  mtimeMs: number
  calls: HarnessCall[]
  steps: Step[]
  /** The transcript itself shows the run ended (`task_complete`). */
  isComplete: boolean
  brief: string
  report: string
  /** The model and effort the transcript shows, for a record that names none (the ledger rows do not). */
  model: { model?: string; effort?: string }
  /** The record state the proof was last tried for: a proof is looked for once per change. */
  proofKey: string
}

/** What the poll keeps between ticks. */
type Runs = { read?: RunRecordsRead; seen: Map<string, Seen>; isBusy: boolean; poll?: { cancel: () => void }; first?: Promise<void> }
let runs: Runs | null = null

/** The model to feed (null while the pulse is off) and the call that says it changed. */
export type RunsTarget = { model: () => PulseModel | null; touch: () => void }

export const startsInside = (path: string, base: string | undefined): boolean => base !== undefined && path.startsWith(base.replace(/\/+$/, '') + PATH_JOIN) && !path.includes(PARENT_DIR)

export async function statSig($: Dollar, path: string): Promise<{ sig: string; size: number; mtimeMs: number } | undefined> {
  try {
    const s = await $.fs.stat(path)
    return { sig: `${s.size}:${s.mtimeMs}`, size: s.size, mtimeMs: s.mtimeMs }
  } catch {
    return undefined
  }
}

export async function readText($: Dollar, path: string): Promise<string | undefined> {
  try {
    const text = await $.fs.read(path)
    return typeof text === 'string' ? text : undefined
  } catch {
    return undefined
  }
}

/** The transcript of a record re-read when it changed, else the held read; undefined when it has none or cannot be read. */
async function transcriptOf($: Dollar, held: Map<string, Seen>, record: RunRecord, adapter: HarnessAdapter, codexHome: string | undefined): Promise<Seen | undefined> {
  const path = record.transcript?.path
  if (path === undefined || !startsInside(path, codexHome === undefined ? undefined : codexHome + PATH_JOIN + RUN_IO.SESSIONS_DIR)) return undefined
  const stat = await statSig($, path)
  const before = held.get(record.runId)
  if (stat === undefined) return before
  if (before?.sig === stat.sig || stat.size > RUNS_HOST.MAX_TRANSCRIPT_BYTES) return before
  const text = await readText($, path)
  if (text === undefined) return before
  const seen: Seen = {
    sig: stat.sig,
    mtimeMs: stat.mtimeMs,
    calls: adapter.calls(text),
    steps: adapter.parse(text, true).steps,
    isComplete: adapter.state(text, stat.mtimeMs, stat.mtimeMs) === 'done',
    brief: adapter.rawBrief?.(text) ?? '',
    report: adapter.lastMessage(text),
    model: adapter.model(text),
    proofKey: before?.proofKey ?? '',
  }
  held.set(record.runId, seen)
  return seen
}

/** The final report of a run that left none in its transcript: its `result.md`, only from delegation-kit's own folder. */
async function resultText($: Dollar, record: RunRecord, cacheRoot: string | undefined): Promise<string> {
  const path = record.resultPath
  if (path === undefined || !startsInside(path, cacheRoot === undefined ? undefined : cacheRoot + PATH_JOIN + RUN_IO.DELEGATIONS_DIR)) return ''
  const stat = await statSig($, path)
  return stat === undefined || stat.size > RUN_IO.MAX_FILE_BYTES ? '' : ((await readText($, path)) ?? '')
}

/** The proof of a finished run, once per change of its transcript or record; true when it changed the model. */
async function proveRun($: Dollar, model: PulseModel, record: RunRecord, seen: Seen | undefined, codexHome: string | undefined, cacheRoot: string | undefined): Promise<boolean> {
  const id = runLoopId(record.runId)
  const loop = model.loops.get(id)
  const key = `${seen?.sig ?? SIG_MISSING}|${record.status}|${record.endedAt ?? ''}`
  if (loop === undefined || loop.status !== 'done' || seen === undefined || seen.proofKey === key || seen.brief === '') return false
  seen.proofKey = key
  const report = seen.report !== '' ? seen.report : await resultText($, record, cacheRoot)
  const proof = proofOf(seen.brief, report)
  return proof !== undefined && setLoopProof(model, id, proof)
}

async function tick($: Dollar, r: Runs, target: RunsTarget): Promise<void> {
  if (r.isBusy) return
  r.isBusy = true
  try {
    const model = target.model()
    if (model === null) return
    const now = await $.clock.now()
    r.read = await readRunRecords($, { cwd: await $.session.cwd(), sessionId: await $.session.id(), now }, r.read)
    const roots = await resolveRoots($, {})
    let isChanged = false
    for (const record of r.read.records) {
      const adapter = adapterOf(record.transcript?.format)
      const seen = adapter === undefined ? undefined : await transcriptOf($, r.seen, record, adapter, roots.codexHome)
      const state = seen === undefined || adapter === undefined ? undefined : seen.isComplete ? 'done' : adapter.state('', seen.mtimeMs, now)
      const named: RunRecord = { ...record, ...(record.model === undefined && seen?.model.model !== undefined ? { model: seen.model.model } : {}), ...(record.effort === undefined && seen?.model.effort !== undefined ? { effort: seen.model.effort } : {}) }
      const isIngested = ingestRun(model, named, seen?.calls ?? [], seen?.steps ?? [], now, state)
      const isProved = await proveRun($, model, record, seen, roots.codexHome, roots.cacheRoot)
      isChanged = isChanged || isIngested || isProved
    }
    if (isChanged) target.touch()
  } catch {
    // no runs shown this tick; the next one tries again
  } finally {
    r.isBusy = false
  }
}

/**
 * Start (or restart) the poll for the pulse of this session. Ingesting a run again adds nothing (the loop's cursor), and `ingestRun`
 * says whether anything changed, so an unchanged run does not rewrite the snapshot every tick.
 */
export function startRunsPoll($: Dollar, target: RunsTarget): void {
  stopRunsPoll()
  const r: Runs = { seen: new Map(), isBusy: false }
  runs = r
  try {
    r.poll = $.clock.every(RUNS_HOST.POLL_MS, () => void tick($, r, target))
    r.first = tick($, r, target)
  } catch {
    // no timer (an old engine, a test): runs are not shown
  }
}

/** One tick now, waited for (the timer's own ticks are not): for a test, or a command that wants the runs current. Never throws. */
export async function pollRunsNow($: Dollar, target: RunsTarget): Promise<void> {
  if (runs === null) return
  await runs.first
  await tick($, runs, target)
}

/** The record the poll last read for a run id (the detail view's source); undefined before the first read or for an unknown run. */
export const runRecordOf = (runId: string | undefined): RunRecord | undefined => (runId === undefined ? undefined : runs?.read?.records.find(r => r.runId === runId))

export function stopRunsPoll(): void {
  runs?.poll?.cancel()
  runs = null
}
