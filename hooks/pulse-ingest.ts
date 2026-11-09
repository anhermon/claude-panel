// A RUN of another harness (a codex run started by delegation-kit) into the pulse model, so it shows as an agent like any other:
// a row, spans by kind of work, tokens, calls, a state. Pure: no `$`, no I/O; the poll that reads the records and their transcripts is
// ./pulse-runs-host.ts. Codex fires no engine hooks and has no wrapper subagent, so the model learns of it only from here.
// IDEMPOTENT: the loop keeps a cursor (`ingested`: calls and steps already applied), so ingesting the same record and transcript again
// adds nothing, and a longer transcript adds only its new calls. A transcript is append-only, so an index is a stable cursor.
import type { HarnessCall, RunState } from './harness-adapters/types'
import { MAIN_LOOP, PULSE_CAPS, addTokens, beginCall, endCall, hasLoop, spawnLoop, turnEnd } from './pulse-model'
import type { PulseLoop, PulseModel, RunOutcome } from './pulse-model'
import { targetOf } from './pulse-redact'
import { RUN_STATUS, isNotStarted, notStartedNote } from './run-records'
import type { RunRecord } from './run-records'
import type { Step } from './transcript-parse'

const LOOP_PREFIX = 'run-'
/** A loop id is `[A-Za-z0-9_-]` (agent-detail-host SAFE_ID): the dots a run id may hold become dashes. */
const UNSAFE_ID_CHAR = /[^A-Za-z0-9_-]/g
const BASH = 'Bash'

/** The pulse loop id of a run. */
export const runLoopId = (runId: string): string => `${LOOP_PREFIX}${runId.replace(UNSAFE_ID_CHAR, '-')}`.slice(0, PULSE_CAPS.ID_CHARS)

/** What the record (and, for a run the record still calls running, the transcript) says: still going, or finished and how. */
export type RunVerdict = { isDone: boolean; outcome?: RunOutcome }

const NOT_STARTED_OUTCOME: RunOutcome = 'notstarted'
const OUTCOME_OF_STATUS: Readonly<Record<string, RunOutcome>> = { [RUN_STATUS.FAILED]: 'failed', [RUN_STATUS.BLOCKED]: 'blocked', [RUN_STATUS.CANCELLED]: 'cancelled' }

/**
 * `running` keeps the loop working, unless the transcript alone shows it ended or died; `ok` is done; failed, blocked and cancelled keep
 * their word; a deferred or refused attempt never ran (`notstarted`, finished at once: nothing to wait for); ANY other status word (delegation-kit may add some) is working while the record has no `endedAt`, else done.
 */
export function verdictOf(record: RunRecord, adapterState?: RunState): RunVerdict {
  const status = record.status
  if (status === RUN_STATUS.RUNNING) {
    if (adapterState === 'aborted') return { isDone: true, outcome: 'aborted' }
    return { isDone: adapterState === 'done' }
  }
  if (status === RUN_STATUS.OK) return { isDone: true }
  if (isNotStarted(record)) return { isDone: true, outcome: NOT_STARTED_OUTCOME }
  const outcome = OUTCOME_OF_STATUS[status]
  if (outcome !== undefined) return { isDone: true, outcome }
  return { isDone: record.endedAt !== undefined }
}

const msOf = (iso: string | undefined): number | undefined => {
  const t = iso === undefined ? NaN : Date.parse(iso)
  return Number.isFinite(t) ? t : undefined
}

function stamp(loop: PulseLoop, record: RunRecord): void {
  loop.harness = record.harness.slice(0, PULSE_CAPS.NAME_CHARS)
  loop.runId = record.runId.slice(0, PULSE_CAPS.ID_CHARS)
  loop.source = 'external'
  if (record.model !== undefined) loop.model = record.model.slice(0, PULSE_CAPS.NAME_CHARS)
  if (record.effort !== undefined) loop.effort = record.effort.slice(0, PULSE_CAPS.NAME_CHARS)
  if (record.transcript?.confidence !== undefined) loop.confidence = record.transcript.confidence
  else if (record.transcript?.path === undefined) delete loop.confidence
  loop.ingested ??= { calls: 0, steps: 0 }
}

/**
 * Bring the loop of `record` up to date. `calls` and `steps` are ALL the finished tool calls and token requests the transcript has so far
 * (oldest first); only those past the cursor are applied. `adapterState` is what the transcript alone shows (done / running / aborted),
 * used while the record still says running. A record with no transcript yet still gets its row, state and (record) tokens.
 */
export function ingestRun(m: PulseModel, record: RunRecord, calls: readonly HarnessCall[], steps: readonly Step[], now: number, adapterState?: RunState): boolean {
  const id = runLoopId(record.runId)
  const startedAt = msOf(record.startedAt) ?? now
  const isNew = !hasLoop(m, id)
  if (isNew) {
    const parent = record.agentId !== undefined && hasLoop(m, record.agentId) ? record.agentId : MAIN_LOOP
    spawnLoop(m, startedAt, { id, label: record.title, parent })
  }
  const loop = m.loops.get(id)
  if (loop === undefined) return false
  const before = fingerprint(loop)
  stamp(loop, record)
  const cursor = loop.ingested ?? { calls: 0, steps: 0 }
  let t = loop.lastAt
  for (const c of calls.slice(cursor.calls)) {
    const at = Math.max(t, c.t - (c.ms ?? 0))
    const target = c.tool === BASH ? targetOf(BASH, { command: c.target }) : c.target
    const ev = beginCall(m, at, id, c.tool, target)
    t = Math.max(at, c.t)
    endCall(m, t, id, ev, c.failed)
  }
  if (steps.length > cursor.steps) {
    if (cursor.steps === 0) delete loop.tokens // an earlier fallback from the record's own total gives way to the exact sum
    for (const s of steps.slice(cursor.steps))
      addTokens(m, s.t, id, { input_tokens: s.fresh, output_tokens: s.output, cache_creation_input_tokens: 0, cache_read_input_tokens: s.cacheRead })
  } else if (steps.length === 0 && cursor.steps === 0 && (record.tokens?.fresh ?? 0) > 0) loop.tokens = record.tokens?.fresh
  loop.ingested = { calls: Math.max(cursor.calls, calls.length), steps: Math.max(cursor.steps, steps.length) }
  const verdict = verdictOf(record, adapterState)
  if (verdict.isDone) {
    const endedAt = Math.max(t, msOf(record.endedAt) ?? t)
    if (loop.status !== 'done' || loop.lastAt !== endedAt) turnEnd(m, endedAt, id)
    if (verdict.outcome !== undefined) loop.outcome = verdict.outcome
    else delete loop.outcome
    if (verdict.outcome === NOT_STARTED_OUTCOME) loop.why = notStartedNote(record).slice(0, PULSE_CAPS.WHY_CHARS)
    else delete loop.why
  } else {
    loop.status = 'running'
    delete loop.outcome
    delete loop.why
    loop.busy = 0
  }
  const isChanged = isNew || before !== fingerprint(loop)
  if (isChanged) m.isDirty = true
  return isChanged
}

/** Everything an ingest can change on a loop, as one string. */
const fingerprint = (l: PulseLoop): string => [l.status, l.outcome, l.why, l.lastAt, l.calls, l.tokens, l.model, l.effort, l.confidence, l.ingested?.calls, l.ingested?.steps].join('|')
