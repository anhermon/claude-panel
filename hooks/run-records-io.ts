// The `$` half of the run records (./run-records.ts): `<session cwd>/.router/runs/*.json` first (written by delegation-kit, preferred),
// then the fallback fold of `~/.cache/delegation-kit/delegations.jsonl`, and for a codex run with no transcript path the rollout under
// `~/.codex/sessions/Y/M/D/` that belongs to it. Bounded (named caps on files, bytes, folders), cheap (the same signature, and no run still
// waiting for its rollout, returns the previous read untouched) and safe (nothing here throws; no record dir or ledger gives no records).
// The cache root and the codex home are found the way delegation-kit finds them (bin/cache_paths.py cache_root): env
// DELEGATION_KIT_CACHE_DIR, else the older DELEGATION_KIT_CACHE, else ~/.cache/delegation-kit; env CODEX_HOME, else ~/.codex.
// A ledger bigger than `$.fs.read` takes (4 MiB) is read through `tail -c`, a rollout head through `head -c`, like ./router-io.ts does.
import type { EngineInterface } from 'claude-code'

import { sessionMetaOf } from './harness-adapters/codex'
import { foldDelegations, isNotStarted, parseRunJson, rolloutNameMatches, threadIdOfEvents, TRANSCRIPT_CONFIDENCE, TRANSCRIPT_FORMAT } from './run-records'
import type { RunRecord, RunTranscript } from './run-records'

type Dollar = EngineInterface

export const RUN_IO = {
  RUNS_DIR: '.router/runs',
  LEDGER_FILE: 'delegations.jsonl',
  DELEGATIONS_DIR: 'delegations',
  EVENTS_FILE: 'events.jsonl',
  SESSIONS_DIR: 'sessions',
  /** Record files read at most, and records kept (newest start first). */
  MAX_RUN_FILES: 100,
  MAX_RECORDS: 60,
  /** A record file over this is not read. */
  MAX_FILE_BYTES: 256 * 1024,
  /** A ledger over this is read through `tail`, its last LEDGER_TAIL_BYTES only (`$.fs.read` itself refuses over 4 MiB). */
  MAX_LEDGER_BYTES: 3 * 1024 * 1024,
  LEDGER_TAIL_BYTES: 2 * 1024 * 1024,
  /** The start of events.jsonl holds `thread.started`; the start of a rollout holds `session_meta` (~22 KB with its instructions). */
  EVENTS_HEAD_BYTES: 4096,
  ROLLOUT_HEAD_BYTES: 128 * 1024,
  PROCESS_TIMEOUT_MS: 5000,
  /** Rollout day folders looked in: the start's UTC day and one either side (the file name is in local time). */
  DAY_SPREAD: 1,
  /** Rollouts head-read per guess, newest first. */
  MAX_GUESS_FILES: 40,
  /** A run that ended less than this ago and has no transcript yet is looked for again on the next poll. */
  PENDING_GRACE_MS: 120_000,
  POLL_MS: 3000,
} as const

const SIG_MISSING = '-'
const SIG_JOIN = '|'
const HOME_ENV_DIR = ['.cache', 'delegation-kit'] as const
const CODEX_DEFAULT_DIR = '.codex'
const ROLLOUT_NAME = /^rollout-.*\.jsonl$/
const JSON_NAME = /\.json$/
const DAY_MS = 86_400_000
const PAD = 2
const EXEC_ORIGINATOR = 'codex_exec'

/** What the last read saw (`sig`), made of it, and whether a run is still waiting for its transcript. */
export type RunRecordsRead = { sig: string; records: RunRecord[]; isPending: boolean }
export type RunReadOptions = { cwd: string; sessionId: string; cacheRoot?: string; codexHome?: string; now?: number }

const join = (...parts: string[]): string => parts.map((p, i) => (i === 0 ? p.replace(/\/+$/, '') : p.replace(/^\/+|\/+$/g, ''))).join('/')
const expandHome = (path: string, home: string): string => (path.startsWith('~/') ? join(home, path.slice(2)) : path)

async function readText($: Dollar, path: string): Promise<string | undefined> {
  try {
    const text = await $.fs.read(path)
    return typeof text === 'string' ? text : undefined
  } catch {
    return undefined
  }
}

/** The first or last `bytes` of a file through `head -c` / `tail -c`; undefined when the program failed. */
async function sliceOf($: Dollar, program: 'head' | 'tail', bytes: number, path: string): Promise<string | undefined> {
  try {
    const out = await $.process.run([program, '-c', String(bytes), path], { timeoutMs: RUN_IO.PROCESS_TIMEOUT_MS })
    return out.exitCode === 0 ? out.stdout : undefined
  } catch {
    return undefined
  }
}

async function sizeSig($: Dollar, path: string): Promise<string> {
  try {
    const s = await $.fs.stat(path)
    return `${s.size}:${s.mtimeMs}`
  } catch {
    return SIG_MISSING
  }
}

/** A variable's value; undefined when unset, empty or unreadable. (`$.env.get` wants a string literal, so the call is passed in.) */
async function envText(get: () => Promise<string | undefined>): Promise<string | undefined> {
  try {
    const v = await get()
    return v === undefined || v === '' ? undefined : v
  } catch {
    return undefined
  }
}

/** delegation-kit's cache root and the codex home for this machine; an option wins, then the env, then the home folder. */
export async function resolveRoots($: Dollar, opts: Pick<RunReadOptions, 'cacheRoot' | 'codexHome'>): Promise<{ cacheRoot: string | undefined; codexHome: string | undefined }> {
  const home = await envText(() => $.env.get('HOME'))
  const cacheEnv = (await envText(() => $.env.get('DELEGATION_KIT_CACHE_DIR'))) ?? (await envText(() => $.env.get('DELEGATION_KIT_CACHE')))
  const codexEnv = await envText(() => $.env.get('CODEX_HOME'))
  const at = (explicit: string | undefined, fromEnv: string | undefined, rest: readonly string[]): string | undefined => {
    const given = explicit ?? fromEnv
    if (given !== undefined) return home === undefined ? given : expandHome(given, home)
    return home === undefined ? undefined : join(home, ...rest)
  }
  return { cacheRoot: at(opts.cacheRoot, cacheEnv, HOME_ENV_DIR), codexHome: at(opts.codexHome, codexEnv, [CODEX_DEFAULT_DIR]) }
}

type RunFile = { name: string; sig: string }

/** The record files of `<cwd>/.router/runs` (sorted, at most MAX_RUN_FILES); undefined when there is no such folder. */
async function runFiles($: Dollar, dir: string): Promise<RunFile[] | undefined> {
  try {
    const entries = await $.fs.list(dir)
    return entries
      .filter(e => e.kind === 'file' && JSON_NAME.test(e.name) && e.size <= RUN_IO.MAX_FILE_BYTES)
      .map(e => ({ name: e.name, sig: `${e.name}=${e.size}:${e.mtimeMs}` }))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, RUN_IO.MAX_RUN_FILES)
  } catch {
    return undefined
  }
}

/** The lines of the ledger (its end only when it is big; the cut first line is dropped). */
async function ledgerLines($: Dollar, path: string, size: number): Promise<string[]> {
  const isBig = size > RUN_IO.MAX_LEDGER_BYTES
  const text = isBig ? await sliceOf($, 'tail', RUN_IO.LEDGER_TAIL_BYTES, path) : await readText($, path)
  if (text === undefined) return []
  const lines = text.split('\n')
  if (isBig) lines.shift()
  return lines.filter(l => l.trim() !== '')
}

const two = (n: number): string => String(n).padStart(PAD, '0')
/** `<sessions>/YYYY/MM/DD` for the UTC day of `ms` and the DAY_SPREAD days either side. */
function dayDirs(sessions: string, ms: number): string[] {
  const days: string[] = []
  for (let d = -RUN_IO.DAY_SPREAD; d <= RUN_IO.DAY_SPREAD; d++) {
    const day = new Date(ms + d * DAY_MS)
    days.push(join(sessions, String(day.getUTCFullYear()), two(day.getUTCMonth() + 1), two(day.getUTCDate())))
  }
  return days
}

async function listNames($: Dollar, dir: string): Promise<{ name: string; mtimeMs: number }[]> {
  try {
    return (await $.fs.list(dir)).filter(e => e.kind === 'file').map(e => ({ name: e.name, mtimeMs: e.mtimeMs }))
  } catch {
    return []
  }
}

/** The rollout of a thread: the file named `rollout-*-<thread id>.jsonl` in the days around the start. */
async function rolloutOfThread($: Dollar, sessions: string, startMs: number, threadId: string): Promise<string | undefined> {
  for (const day of dayDirs(sessions, startMs)) {
    const hit = (await listNames($, day)).find(f => rolloutNameMatches(f.name, threadId))
    if (hit !== undefined) return join(day, hit.name)
  }
  return undefined
}

/**
 * delegation-kit's own heuristic when the thread id is unknown: the newest rollout of an `exec` run in the run's workdir that started at or
 * after the run. Parallel runs in one workdir make this ambiguous, so the caller marks the answer `guessed`.
 */
async function guessRollout($: Dollar, sessions: string, startMs: number, workdir: string): Promise<{ path: string; threadId: string } | undefined> {
  let best: { path: string; threadId: string; at: number } | undefined
  for (const day of dayDirs(sessions, startMs)) {
    const files = (await listNames($, day)).filter(f => ROLLOUT_NAME.test(f.name) && f.mtimeMs >= startMs).sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, RUN_IO.MAX_GUESS_FILES)
    for (const f of files) {
      const path = join(day, f.name)
      const head = await sliceOf($, 'head', RUN_IO.ROLLOUT_HEAD_BYTES, path)
      const line = head?.includes('\n') === true ? head.slice(0, head.indexOf('\n')) : ''
      const meta = sessionMetaOf(line)
      if (meta === undefined || meta.cwd !== workdir || meta.startedAt < startMs || !line.includes(EXEC_ORIGINATOR)) continue
      if (best === undefined || meta.startedAt > best.at) best = { path, threadId: meta.id, at: meta.startedAt }
    }
  }
  return best === undefined ? undefined : { path: best.path, threadId: best.threadId }
}

/** The events file of a run, only when it sits under delegation-kit's `delegations/` folder (a record file is not trusted with other paths). */
function eventsPathOf(record: RunRecord, cacheRoot: string | undefined): string | undefined {
  const named = record.transcript?.eventsPath
  const own = cacheRoot === undefined ? undefined : join(cacheRoot, RUN_IO.DELEGATIONS_DIR, record.runId, RUN_IO.EVENTS_FILE)
  const base = cacheRoot === undefined ? undefined : join(cacheRoot, RUN_IO.DELEGATIONS_DIR) + '/'
  return named !== undefined && base !== undefined && named.startsWith(base) && !named.includes('..') ? named : own
}

/** The record with its transcript found: its path (exact by thread id, or `guessed`), thread id and format. Unchanged when nothing is found. */
async function withTranscript($: Dollar, record: RunRecord, roots: { cacheRoot?: string; codexHome?: string }, known: RunTranscript | undefined): Promise<RunRecord> {
  if (record.harness !== 'codex' || isNotStarted(record)) return record // a deferred or refused attempt ran nothing: no rollout is its own
  const base: RunTranscript = { format: TRANSCRIPT_FORMAT.CODEX, ...known, ...record.transcript } // what an earlier read found stays
  if (base.path !== undefined) return { ...record, transcript: { ...base, confidence: base.confidence ?? TRANSCRIPT_CONFIDENCE.EXACT } }
  if (roots.codexHome === undefined) return record
  const sessions = join(roots.codexHome, RUN_IO.SESSIONS_DIR)
  const startMs = Date.parse(record.startedAt)
  if (!Number.isFinite(startMs)) return record
  let threadId = base.threadId
  const eventsPath = eventsPathOf(record, roots.cacheRoot)
  if (threadId === undefined && eventsPath !== undefined) {
    const head = await sliceOf($, 'head', RUN_IO.EVENTS_HEAD_BYTES, eventsPath)
    threadId = threadIdOfEvents((head ?? '').split('\n')[0] ?? '')
  }
  if (threadId !== undefined) {
    const path = await rolloutOfThread($, sessions, startMs, threadId)
    const transcript: RunTranscript = { ...base, threadId, ...(eventsPath === undefined ? {} : { eventsPath }), ...(path === undefined ? {} : { path, confidence: TRANSCRIPT_CONFIDENCE.EXACT }) }
    return { ...record, transcript }
  }
  const guess = record.workdir === undefined ? undefined : await guessRollout($, sessions, startMs, record.workdir)
  if (guess === undefined) return { ...record, transcript: { ...base, ...(eventsPath === undefined ? {} : { eventsPath }) } }
  return { ...record, transcript: { ...base, ...guess, ...(eventsPath === undefined ? {} : { eventsPath }), confidence: TRANSCRIPT_CONFIDENCE.GUESSED } }
}

const isWaiting = (r: RunRecord, now: number): boolean => {
  if (r.harness !== 'codex' || r.transcript?.path !== undefined || isNotStarted(r)) return false
  const ended = r.endedAt === undefined ? NaN : Date.parse(r.endedAt)
  return !Number.isFinite(ended) || now - ended < RUN_IO.PENDING_GRACE_MS
}

/**
 * The runs of this Claude session: `.router/runs/*.json` records, then the delegation-kit ledger for the runs without a record, each codex
 * run with its rollout found. With the previous read it returns `prev` untouched while the files did not change and no run is still
 * waiting for its transcript. Never throws; no record folder and no ledger give an empty list.
 */
export async function readRunRecords($: Dollar, opts: RunReadOptions, prev?: RunRecordsRead): Promise<RunRecordsRead> {
  const now = opts.now ?? Date.now()
  const dir = join(opts.cwd, RUN_IO.RUNS_DIR)
  const files = (await runFiles($, dir)) ?? []
  const roots = await resolveRoots($, opts)
  const ledgerPath = roots.cacheRoot === undefined ? undefined : join(roots.cacheRoot, RUN_IO.LEDGER_FILE)
  const ledgerSig = ledgerPath === undefined ? SIG_MISSING : await sizeSig($, ledgerPath)
  const sig = [opts.sessionId, ledgerSig, ...files.map(f => f.sig)].join(SIG_JOIN)
  if (prev !== undefined && prev.sig === sig && !prev.isPending) return prev
  const found = new Map<string, RunRecord>()
  for (const f of files) {
    const text = await readText($, join(dir, f.name))
    const record = text === undefined ? undefined : parseRunJson(text)
    if (record !== undefined && record.sessionId === opts.sessionId) found.set(record.runId, record)
  }
  const size = Number(ledgerSig.split(':')[0])
  if (ledgerPath !== undefined && Number.isFinite(size) && size > 0) {
    const lines = await ledgerLines($, ledgerPath, size)
    for (const r of foldDelegations(lines, opts.sessionId, roots.cacheRoot)) if (!found.has(r.runId)) found.set(r.runId, r)
  }
  const newest = [...found.values()].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt)).slice(0, RUN_IO.MAX_RECORDS).reverse()
  const known = new Map((prev?.records ?? []).map(r => [r.runId, r.transcript]))
  const records: RunRecord[] = []
  for (const r of newest) records.push(await withTranscript($, r, roots, known.get(r.runId)))
  return { sig, records, isPending: records.some(r => isWaiting(r, now)) }
}
