// The `$` half of the detail of a delegated run (the pure half is ./agent-detail-external.ts): find the run's record (the poll of
// ./pulse-runs-host.ts keeps it), read the END of its rollout (and its start when the tail does not reach it) and build the detail. The rollout
// path comes from the record and is read only from inside the harness's own sessions folder. Never throws; undefined means "this is not a
// run the drill-down knows" and the caller falls back to the Claude subagent path.
import type { EngineInterface } from 'claude-code'

import { buildExternalDetail, EXTERNAL, EXTERNAL_REASON } from './agent-detail-external'
import type { ExternalDetail, RolloutPiece } from './agent-detail-external'
import type { DetailSubject } from './agent-detail'
import type { LaneInfo } from './agent-progress'
import type { PulseEvent, PulseLoop } from './pulse-model'
import { runRecordOf, startsInside } from './pulse-runs-host'
import { isNotStarted, TRANSCRIPT_FORMAT } from './run-records'
import { RUN_IO, resolveRoots } from './run-records-io'

type Dollar = EngineInterface

const RUN_TIMEOUT_MS = 10_000
const PATH_JOIN = '/'

async function run($: Dollar, argv: readonly string[]): Promise<string | undefined> {
  try {
    const out = await $.process.run(argv, { timeoutMs: RUN_TIMEOUT_MS })
    return out.exitCode === 0 ? out.stdout : undefined
  } catch {
    return undefined
  }
}

async function sizeOf($: Dollar, path: string): Promise<number | undefined> {
  try {
    return (await $.fs.stat(path)).size
  } catch {
    return undefined
  }
}

/** The tail (`bytes`) of the rollout at `path`, and its start when the tail is not the whole file; undefined when it cannot be read. */
async function readPiece($: Dollar, path: string, size: number, bytes: number): Promise<RolloutPiece | undefined> {
  const isWhole = size <= bytes
  const text = await run($, ['tail', '-c', String(bytes), path])
  if (text === undefined) return undefined
  const headText = isWhole ? '' : ((await run($, ['head', '-c', String(EXTERNAL.HEAD_BYTES), path])) ?? '')
  return { text, headText, isWhole, size, readBytes: Math.min(size, bytes) }
}

/**
 * The detail of the delegated run behind `loop`, or undefined when `loop` is not a codex run with a record. `sigBase` says what
 * else changed (the agent, the pages, its state, the clock bucket); with the rollout's size and the record's end it is the signature: the
 * same as `lastSig` gives `detail: null` (nothing to rewrite).
 */
export async function externalDetail(
  $: Dollar,
  a: { subject: DetailSubject; loop: PulseLoop | undefined; events: readonly PulseEvent[]; lane?: LaneInfo; pages: number; bytes: number; now: number; sigBase: string; lastSig: string },
): Promise<{ sig: string; detail: ExternalDetail | null } | undefined> {
  const record = a.loop?.source === 'external' ? runRecordOf(a.loop.runId) : undefined
  // an attempt that never started has no rollout to read; its honest state is ./agent-detail-run.ts's
  if (record === undefined || record.transcript?.format !== TRANSCRIPT_FORMAT.CODEX || isNotStarted({ status: record.status, started: record.started })) return undefined
  try {
    const { codexHome } = await resolveRoots($, {})
    const path = record.transcript.path
    const isInside = path !== undefined && startsInside(path, codexHome === undefined ? undefined : codexHome + PATH_JOIN + RUN_IO.SESSIONS_DIR)
    const size = isInside ? await sizeOf($, path) : undefined
    const sig = `${a.sigBase}|${size ?? ''}|${record.status}|${record.endedAt ?? ''}`
    if (sig === a.lastSig) return { sig, detail: null }
    const piece = isInside && size !== undefined ? await readPiece($, path, size, a.bytes) : undefined
    const unavailable = !isInside || size === undefined ? EXTERNAL_REASON.NO_ROLLOUT : EXTERNAL_REASON.UNREADABLE
    const detail = buildExternalDetail({ subject: a.subject, loop: a.loop, record, events: a.events, ...(a.lane === undefined ? {} : { lane: a.lane }), rollout: piece ?? null, unavailable, pages: a.pages, now: a.now })
    return { sig, detail }
  } catch {
    return undefined
  }
}
