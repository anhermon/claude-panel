// A RUN RECORD says what the panel needs to show a run that has no Claude subagent transcript of its own (a codex or agy run started by
// delegation-kit): who ran it, with which model, how it ended, where its transcript is. Two sources, one type:
//  - `<session cwd>/.router/runs/<run id>.json`, written by delegation-kit (preferred), read with `parseRunJson`;
//  - the fallback, `~/.cache/delegation-kit/delegations.jsonl`: a START row (`status: "running"`) and a TERMINAL row (`endedAt`)
//    per run id, folded with `foldDelegations`.
// Pure: no `$`, no I/O (the readers are ./run-records-io.ts). Nothing here throws; a row that does not fit is left out.
// The status is one of the five words below OR whatever delegation-kit wrote (`aborted`, `deferred`, ...): never a closed list.
import { plainTitle, titleFromBrief } from './agent-names'
import { excerpt, scrubLines } from './transcript-redact'

export const RUN_RECORD = {
  VERSION: 1,
  TITLE_CHARS: 80,
  /** The longest `reason` kept. */
  REASON_CHARS: 240,
  /** The longest `promptHead` kept. */
  PROMPT_HEAD_CHARS: 1200,
  /** Checks kept per record. */
  MAX_CHECKS: 20,
  /** Shortest / longest thread id or run id taken as safe for a path. */
  ID_MIN: 6,
  ID_MAX: 80,
} as const

export const RUN_STATUS = { RUNNING: 'running', OK: 'ok', FAILED: 'failed', CANCELLED: 'cancelled', BLOCKED: 'blocked', DEFERRED: 'deferred', REFUSED: 'refused' } as const
/** Status words (delegation-kit's `dispatch_guard.STATUS_DEFERRED`, a refusal) of an attempt that never started: no process, no transcript, nothing ran. */
const NOT_STARTED_STATUSES: readonly string[] = [RUN_STATUS.DEFERRED, RUN_STATUS.REFUSED]
/** The verdict of a row that says it never started (`DEFERRED (load governor): ...`, `DELEGATE_REFUSED_OVERSIZED (...)`), for a row with no status word of its own. */
const DEFERRED_VERDICT = /^DEFERRED\b/i
const REFUSED_VERDICT = /(?:^|_)REFUSED(?:_|\b)/i
/** The reason delegation-kit gives for a load-governor deferral starts with this; the note says it plainly. */
const LOAD_GOVERNOR = 'load_governor'
export const NOT_STARTED = { PREFIX: 'Not started: ', BUSY: 'machine busy (load governor)', REFUSED: 'refused', REASON_CHARS: 60 } as const
export const TRANSCRIPT_CONFIDENCE = { EXACT: 'exact', GUESSED: 'guessed' } as const
export type TranscriptConfidence = (typeof TRANSCRIPT_CONFIDENCE)[keyof typeof TRANSCRIPT_CONFIDENCE]

export const TRANSCRIPT_FORMAT = { CODEX: 'codex-rollout', AGY: 'agy-transcript' } as const
const HARNESS = { CODEX: 'codex', AGY: 'agy' } as const
const THREAD_STARTED = 'thread.started'
const SAFE_ID = new RegExp(`^[A-Za-z0-9._-]{${RUN_RECORD.ID_MIN},${RUN_RECORD.ID_MAX}}$`)
const ROLLOUT_PREFIX = 'rollout-'
const ROLLOUT_SUFFIX = '.jsonl'
const OK_VERDICT = /_OK$/
const BLOCKED_VERDICT = /BLOCKED/i
const CANCELLED_VERDICT = /^CANCELLED$/i
const LEGACY_DONE = 'completed'
const EVENTS_FILE = 'events.jsonl'
const RESULT_FILE = 'result.md'
const PROMPT_FILE = 'prompt.md'
const DELEGATIONS_DIR = 'delegations'
const RUN_WORD = 'run'
const TICKET_ONLY = /^T\d+$/i

export type RunTokens = { fresh?: number; input?: number; cached?: number; output?: number; reasoning?: number; peakContext?: number; contextCap?: number }
export type RunCheck = { cmd: string; ok: boolean; exit?: number }
export type RunTranscript = { format?: string; path?: string; threadId?: string; eventsPath?: string; confidence?: TranscriptConfidence }
export type RunEval = { line: string; result: 'pass' | 'fail' | 'none' }
export type RunProgress = { done: number; total: number; note?: string }

export type RunRecord = {
  v: number
  runId: string
  harness: string
  model?: string
  effort?: string
  workdir?: string
  sessionId: string
  agentId?: string
  pid?: number
  startedAt: string
  endedAt?: string
  /** running | ok | failed | cancelled | blocked, or any other word delegation-kit wrote. */
  status: string
  verdict?: string
  /** Why it did not start or end well, in delegation-kit's words (a deferral's load figures, a refusal's rule). */
  reason?: string
  /** The start of the brief as the ledger kept it (`promptHead`), scrubbed: what the detail shows when the brief file itself may not be read. */
  promptHead?: string
  /** `false` when delegation-kit says the process never started (a deferral); absent otherwise. */
  started?: false
  ok?: boolean
  durationS?: number
  /** A plain title, never a ticket id. */
  title: string
  ticket?: string
  ticketSource?: string
  taskClass?: string
  role?: string
  transcript?: RunTranscript
  resultPath?: string
  promptPath?: string
  tokens?: RunTokens
  checks: RunCheck[]
  eval?: RunEval
  progress?: RunProgress
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v)
const text = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined)
const dropUndefined = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T

/** A human title: the description without its ticket token and routing tail; the brief's first sentence; else "Codex run". Never a ticket id. */
export function titleOf(description: unknown, harness: string, promptHead?: unknown): string {
  const clean = (s: string): string => {
    const t = excerpt(plainTitle(s), RUN_RECORD.TITLE_CHARS)
    return TICKET_ONLY.test(t) ? '' : t
  }
  const fromDescription = clean(typeof description === 'string' ? description : '')
  if (fromDescription !== '') return fromDescription
  const fromBrief = clean(titleFromBrief(typeof promptHead === 'string' ? promptHead : ''))
  if (fromBrief !== '') return fromBrief
  return `${harness === '' ? 'Agent' : harness[0]!.toUpperCase() + harness.slice(1)} ${RUN_WORD}`
}

function tokensOf(v: unknown): RunTokens | undefined {
  if (!isObj(v)) return undefined
  const t = dropUndefined({ fresh: num(v.fresh), input: num(v.input), cached: num(v.cached), output: num(v.output), reasoning: num(v.reasoning), peakContext: num(v.peakContext), contextCap: num(v.contextCap) })
  return Object.keys(t).length > 0 ? t : undefined
}

function transcriptOf(v: unknown): RunTranscript | undefined {
  if (!isObj(v)) return undefined
  const confidence = v.confidence === TRANSCRIPT_CONFIDENCE.GUESSED ? TRANSCRIPT_CONFIDENCE.GUESSED : v.confidence === TRANSCRIPT_CONFIDENCE.EXACT ? TRANSCRIPT_CONFIDENCE.EXACT : undefined
  const t = dropUndefined({ format: text(v.format), path: text(v.path), threadId: text(v.threadId), eventsPath: text(v.eventsPath), confidence })
  return Object.keys(t).length > 0 ? t : undefined
}

function checksOf(v: unknown): RunCheck[] {
  if (!Array.isArray(v)) return []
  return v.slice(0, RUN_RECORD.MAX_CHECKS).flatMap(c => (isObj(c) && typeof c.cmd === 'string' ? [dropUndefined({ cmd: excerpt(c.cmd, RUN_RECORD.TITLE_CHARS), ok: c.ok === true, exit: num(c.exit) })] : []))
}

function evalOf(v: unknown): RunEval | undefined {
  if (!isObj(v) || typeof v.line !== 'string') return undefined
  return { line: excerpt(v.line, RUN_RECORD.TITLE_CHARS * 3), result: v.result === 'pass' || v.result === 'fail' ? v.result : 'none' }
}

function progressOf(v: unknown): RunProgress | undefined {
  const done = isObj(v) ? num(v.done) : undefined
  const total = isObj(v) ? num(v.total) : undefined
  if (!isObj(v) || done === undefined || total === undefined || total === 0) return undefined
  return dropUndefined({ done: Math.min(done, total), total, note: typeof v.note === 'string' ? excerpt(v.note, RUN_RECORD.TITLE_CHARS) : undefined })
}

/** The known fields of a raw object, checked; undefined when the identity fields (run id, harness, session, start, status) are not text. */
export function recordOf(raw: unknown): RunRecord | undefined {
  if (!isObj(raw) || raw.v !== RUN_RECORD.VERSION) return undefined
  const runId = text(raw.runId)
  const harness = text(raw.harness)
  const sessionId = text(raw.sessionId)
  const startedAt = text(raw.startedAt)
  const status = text(raw.status)
  if (runId === undefined || !SAFE_ID.test(runId) || harness === undefined || sessionId === undefined || startedAt === undefined || status === undefined) return undefined
  return dropUndefined({
    v: RUN_RECORD.VERSION,
    runId,
    harness,
    model: text(raw.model),
    effort: text(raw.effort),
    workdir: text(raw.workdir),
    sessionId,
    agentId: text(raw.agentId),
    pid: num(raw.pid),
    startedAt,
    endedAt: text(raw.endedAt),
    status,
    verdict: text(raw.verdict),
    reason: typeof raw.reason === 'string' && raw.reason !== '' ? excerpt(raw.reason, RUN_RECORD.REASON_CHARS) : undefined,
    promptHead: typeof raw.promptHead === 'string' && raw.promptHead.trim() !== '' ? scrubLines(raw.promptHead, RUN_RECORD.PROMPT_HEAD_CHARS) : undefined,
    started: raw.started === false ? (false as const) : undefined,
    ok: typeof raw.ok === 'boolean' ? raw.ok : undefined,
    durationS: num(raw.durationS),
    title: titleOf(raw.title, harness),
    ticket: text(raw.ticket),
    ticketSource: text(raw.ticketSource),
    taskClass: text(raw.taskClass),
    role: text(raw.role),
    transcript: transcriptOf(raw.transcript),
    resultPath: text(raw.resultPath),
    promptPath: text(raw.promptPath),
    tokens: tokensOf(raw.tokens),
    checks: checksOf(raw.checks),
    eval: evalOf(raw.eval),
    progress: progressOf(raw.progress),
  })
}

/** The text of a `<run id>.json` record -> the record; undefined when it is not JSON or not a v1 record. Unknown fields are dropped. */
export function parseRunJson(json: string): RunRecord | undefined {
  try {
    return recordOf(JSON.parse(json))
  } catch {
    return undefined
  }
}

/** The status of a finished delegation row: delegation-kit's own `status` word wins (except the plain `completed`), then the verdict and checks. */
function finishedStatus(end: Obj): string {
  const own = text(end.status)
  if (own !== undefined && own !== LEGACY_DONE) return own
  const verdict = text(end.verdict) ?? ''
  if (end.started === false || DEFERRED_VERDICT.test(verdict)) return RUN_STATUS.DEFERRED
  if (REFUSED_VERDICT.test(verdict)) return RUN_STATUS.REFUSED
  if (CANCELLED_VERDICT.test(verdict)) return RUN_STATUS.CANCELLED
  if (BLOCKED_VERDICT.test(verdict)) return RUN_STATUS.BLOCKED
  const checksOk = !Array.isArray(end.checks) || end.checks.every(c => isObj(c) && c.ok !== false)
  return end.ok === true && OK_VERDICT.test(verdict) && checksOk ? RUN_STATUS.OK : RUN_STATUS.FAILED
}

const transcriptFormatOf = (harness: string): string | undefined => (harness === HARNESS.CODEX ? TRANSCRIPT_FORMAT.CODEX : harness === HARNESS.AGY ? TRANSCRIPT_FORMAT.AGY : undefined)

/** The v1 record of one run id from its start row and (when it ended) its terminal row. */
function recordFromRows(id: string, start: Obj | undefined, end: Obj | undefined, cacheRoot: string | undefined): RunRecord | undefined {
  const row: Obj = { ...(start ?? {}), ...Object.fromEntries(Object.entries(end ?? {}).filter(([, v]) => v !== null && v !== undefined)) }
  const harness = text(row.harness) ?? ''
  const folder = cacheRoot === undefined ? undefined : `${cacheRoot.replace(/\/+$/, '')}/${DELEGATIONS_DIR}/${id}`
  const tokens = isObj(row.tokens) ? row.tokens : { fresh: row.tokens, peakContext: row.peakContext, contextCap: row.contextCap }
  const status = end === undefined ? RUN_STATUS.RUNNING : finishedStatus(end)
  const format = isNotStarted({ status, started: row.started === false ? false : undefined }) ? undefined : transcriptFormatOf(harness) // nothing ran: no rollout to find
  return recordOf({
    v: RUN_RECORD.VERSION,
    runId: id,
    harness,
    model: row.model,
    effort: row.effort,
    workdir: row.workdir,
    sessionId: row.sessionId,
    pid: row.pid,
    startedAt: row.startedAt,
    endedAt: end === undefined ? undefined : row.endedAt,
    status,
    verdict: end === undefined ? undefined : row.verdict,
    reason: row.reason,
    promptHead: row.promptHead,
    started: row.started,
    ok: end === undefined ? undefined : row.ok,
    durationS: row.durationS,
    title: titleOf(row.description, harness, row.promptHead),
    ticket: row.ticket,
    ticketSource: row.ticketSource,
    taskClass: row.taskClass,
    role: row.role,
    transcript: format === undefined ? undefined : { format, ...(folder === undefined ? {} : { eventsPath: `${folder}/${EVENTS_FILE}` }) },
    resultPath: row.resultFile ?? (folder === undefined ? undefined : `${folder}/${RESULT_FILE}`),
    promptPath: row.promptFile ?? (folder === undefined ? undefined : `${folder}/${PROMPT_FILE}`),
    tokens,
    checks: row.checks,
  })
}

/**
 * The runs of `~/.cache/delegation-kit/delegations.jsonl` that belong to one Claude session, oldest first. A run id has a START row
 * (`status: "running"`) and, once it ended, a TERMINAL row (`endedAt`, or a `status` such as `aborted`); the later fields win. A line that
 * is not JSON, has no id or is another session's is left out. `cacheRoot` (when known) gives the default events, result and prompt paths.
 */
export function foldDelegations(lines: readonly string[], sessionId: string, cacheRoot?: string): RunRecord[] {
  const starts = new Map<string, Obj>()
  const ends = new Map<string, Obj>()
  for (const line of lines) {
    let row: unknown
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (!isObj(row) || row.sessionId !== sessionId) continue
    const id = text(row.id)
    if (id === undefined) continue
    const isStart = row.status === RUN_STATUS.RUNNING && row.endedAt === undefined
    ;(isStart ? starts : ends).set(id, { ...(isStart ? starts : ends).get(id), ...row })
  }
  const ids = new Set([...starts.keys(), ...ends.keys()])
  return [...ids]
    .flatMap(id => recordFromRows(id, starts.get(id), ends.get(id), cacheRoot) ?? [])
    .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt) || a.runId.localeCompare(b.runId))
}

/** The thread id in line 1 of a run's `events.jsonl` (`{"type":"thread.started","thread_id":"..."}`); undefined when it is not that. */
export function threadIdOfEvents(firstLine: string): string | undefined {
  try {
    const row: unknown = JSON.parse(firstLine)
    const id = isObj(row) && row.type === THREAD_STARTED ? text(row.thread_id) : undefined
    return id !== undefined && SAFE_ID.test(id) ? id : undefined
  } catch {
    return undefined
  }
}

/** Is a file name `rollout-<time>-<thread id>.jsonl` of that thread? The id must be a whole dash-separated tail, not a substring. */
export function rolloutNameMatches(fileName: string, threadId: string): boolean {
  return SAFE_ID.test(threadId) && fileName.startsWith(ROLLOUT_PREFIX) && fileName.endsWith(`-${threadId}${ROLLOUT_SUFFIX}`)
}

/** Did this attempt never start (deferred by the load governor, refused)? Nothing ran: no process, no rollout, no tokens. */
export const isNotStarted = (r: Pick<RunRecord, 'status' | 'started'>): boolean => NOT_STARTED_STATUSES.includes(r.status) || r.started === false

/**
 * The plain note of a not-started attempt: "Not started: machine busy (load governor)" for a deferral by the governor, "Not started: refused
 * (<reason, short>)" for a refusal, else the short reason (or just "Not started"). Never throws.
 */
export function notStartedNote(r: Pick<RunRecord, 'status' | 'reason' | 'verdict'>): string {
  const reason = (r.reason ?? '').replace(/\s+/g, ' ').trim()
  const short = (s: string): string => excerpt(s, NOT_STARTED.REASON_CHARS)
  if (r.status === RUN_STATUS.REFUSED) {
    const why = reason !== '' ? reason : (r.verdict ?? '').trim()
    return `${NOT_STARTED.PREFIX}${NOT_STARTED.REFUSED}${why === '' ? '' : ` (${short(why)})`}`
  }
  if (reason.startsWith(LOAD_GOVERNOR)) return `${NOT_STARTED.PREFIX}${NOT_STARTED.BUSY}`
  return reason === '' ? NOT_STARTED.PREFIX.trimEnd().replace(/:$/, '') : `${NOT_STARTED.PREFIX}${short(reason)}`
}
