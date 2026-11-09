// The detail of a RUN of another harness (a codex run started by delegation-kit) that has no transcript to read: what is TRUE for codex,
// from the run record alone (status, times, model:effort, the description, the brief, the final report, the verdict word, tokens, and for an
// attempt that never started, why). Everything the record does not hold is said as absent, in codex terms ("no rollout found for this run"),
// never in Claude Code's. This is the no-transcript path only; the transcript path of a codex run is a separate piece of work.
// `buildRunDetail` is pure; `loadRunDetail` reads the two text files, only from delegation-kit's own folder, scrubbed and cut.
import type { EngineInterface } from 'claude-code'

import { RUN_IO, resolveRoots } from './run-records-io'
import { isNotStarted } from './run-records'
import type { RunRecord } from './run-records'
import type { PulseLoop } from './pulse-model'
import { readText, runRecordOf, startsInside, statSig } from './pulse-runs-host'
import { scrubLines, scrubText } from './transcript-redact'

type Dollar = EngineInterface

export const RUN_DETAIL_CAPS = { PROMPT_CHARS: 4000, RESULT_CHARS: 4000, LINE_CHARS: 400, REASON_CHARS: 240 } as const

/** Why the transcript tab has no entries: one sentence each, shown as is by the page. */
export const RUN_DETAIL_REASON = {
  NOT_STARTED: 'Nothing ran, so Codex wrote no rollout for this attempt.',
  NO_ROLLOUT: 'No Codex rollout was found for this run, so only what delegation-kit recorded of it is shown.',
} as const

/** The statements of what is absent, in codex terms. */
export const RUN_ABSENT = {
  ROLLOUT: 'no rollout found for this run',
  PROMPT: 'no brief text recorded for this run',
  RESULT: 'no result text recorded for this run',
  TOKENS: 'no token count recorded for this run',
  RECORD: 'delegation-kit has no record of this run (the panel only knows its row)',
  VERDICT: 'no verdict word recorded yet',
} as const

const WORDS: Readonly<Record<string, string>> = { failed: 'Failed', blocked: 'Blocked', cancelled: 'Cancelled', aborted: 'Aborted', notstarted: 'Not started' }
const WORD_RUNNING = 'Running'
const WORD_FINISHED = 'Finished'
const PROMPT_FROM = { FILE: 'file', HEAD: 'head' } as const

export type RunDetail = {
  harness: string
  /** The plain word: Running, Finished, Failed, Blocked, Cancelled, Aborted, Not started. */
  status: string
  /** delegation-kit's own status word (`deferred`, `completed`, ...), when the record has one. */
  recordStatus: string | null
  isNotStarted: boolean
  startedAt: number | null
  endedAt: number | null
  model: string | null
  effort: string | null
  title: string
  verdict: string | null
  tokens: number | null
  /** Why an attempt never started (the record's own words, scrubbed), else null. */
  reason: string | null
  /** The brief: from its file (`file`), else the start of it the ledger kept (`head`). */
  prompt: { text: string; source: 'file' | 'head' } | null
  result: string | null
  /** What the record does not hold, one statement each. */
  absent: string[]
}

export type RunDetailInput = { loop: PulseLoop; record?: RunRecord; prompt?: string; result?: string }

const msOf = (iso: string | undefined): number | null => {
  const t = iso === undefined ? NaN : Date.parse(iso)
  return Number.isFinite(t) ? t : null
}

function statusWordOf(loop: PulseLoop): string {
  if (loop.outcome !== undefined) return WORDS[loop.outcome] ?? WORD_FINISHED
  return loop.status === 'running' ? WORD_RUNNING : WORD_FINISHED
}

/** The detail of a run without a transcript, and the sentence the transcript tab says. Pure. */
export function buildRunDetail(a: RunDetailInput): { unavailable: string; run: RunDetail } {
  const { loop, record } = a
  const isNone = isNotStarted({ status: record?.status ?? '', started: record?.started }) || loop.outcome === 'notstarted'
  const promptText = a.prompt !== undefined && a.prompt !== '' ? scrubLines(a.prompt, RUN_DETAIL_CAPS.PROMPT_CHARS, RUN_DETAIL_CAPS.LINE_CHARS) : ''
  const promptSource = promptText !== '' ? PROMPT_FROM.FILE : PROMPT_FROM.HEAD
  const prompt = promptText !== '' ? promptText : (record?.promptHead ?? '')
  const result = a.result !== undefined && a.result !== '' ? scrubLines(a.result, RUN_DETAIL_CAPS.RESULT_CHARS, RUN_DETAIL_CAPS.LINE_CHARS) : ''
  const tokens = loop.tokens ?? record?.tokens?.fresh ?? null
  const reason = record?.reason === undefined ? null : scrubText(record.reason).slice(0, RUN_DETAIL_CAPS.REASON_CHARS)
  const verdict = record?.verdict === undefined ? null : scrubText(record.verdict).slice(0, RUN_DETAIL_CAPS.REASON_CHARS)
  const absent: string[] = []
  if (record === undefined) absent.push(RUN_ABSENT.RECORD)
  absent.push(RUN_ABSENT.ROLLOUT)
  if (prompt === '') absent.push(RUN_ABSENT.PROMPT)
  if (result === '') absent.push(RUN_ABSENT.RESULT)
  if (tokens === null) absent.push(RUN_ABSENT.TOKENS)
  if (verdict === null && !isNone && loop.status === 'done') absent.push(RUN_ABSENT.VERDICT)
  return {
    unavailable: isNone ? RUN_DETAIL_REASON.NOT_STARTED : RUN_DETAIL_REASON.NO_ROLLOUT,
    run: {
      harness: loop.harness ?? record?.harness ?? '',
      status: statusWordOf(loop),
      recordStatus: record?.status ?? null,
      isNotStarted: isNone,
      startedAt: msOf(record?.startedAt) ?? loop.startedAt,
      endedAt: loop.status === 'done' ? (msOf(record?.endedAt) ?? loop.lastAt) : null,
      model: loop.model ?? record?.model ?? null,
      effort: loop.effort ?? record?.effort ?? null,
      title: record?.title ?? loop.label,
      verdict,
      tokens,
      reason: isNone ? (reason ?? loop.why ?? null) : reason,
      prompt: prompt === '' ? null : { text: prompt, source: promptSource },
      result: result === '' ? null : result,
      absent,
    },
  }
}

/** A file of delegation-kit's own folder (`<cache root>/delegations/...`), at most one record file long; undefined when it is elsewhere, missing or unreadable. */
async function ownText($: Dollar, path: string | undefined, cacheRoot: string | undefined): Promise<string | undefined> {
  if (path === undefined || cacheRoot === undefined || !startsInside(path, `${cacheRoot.replace(/\/+$/, '')}/${RUN_IO.DELEGATIONS_DIR}`)) return undefined
  const stat = await statSig($, path)
  return stat === undefined || stat.size > RUN_IO.MAX_FILE_BYTES ? undefined : readText($, path)
}

/** The detail of an external loop with no transcript: its record (as the poll last read it) and the brief and result files it names. Never throws. */
export async function loadRunDetail($: Dollar, loop: PulseLoop): Promise<{ unavailable: string; run: RunDetail }> {
  const record = runRecordOf(loop.runId)
  try {
    const roots = await resolveRoots($, {})
    const prompt = await ownText($, record?.promptPath, roots.cacheRoot)
    const result = await ownText($, record?.resultPath, roots.cacheRoot)
    return buildRunDetail({ loop, record, prompt, result })
  } catch {
    return buildRunDetail({ loop, record })
  }
}
