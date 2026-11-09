// Which other Claude Code sessions are running, as rows for the `sessions` frame (./sessions-frame.ts). Pure: no `$`, no I/O.
// A session is alive when its registry entry (`~/.claude/sessions/<pid>.json`) matches a process in `ps`; it reads busy, idle or
// "may be waiting" from the end of its transcript. The timing numbers every part of the frame shares live here.
import { clip, scrubText } from './transcript-redact'

/** A transcript written this recently counts as running. */
export const RUNNING_WRITE_MS = 30 * 1000
/** An unanswered tool call this quiet reads "may be waiting". */
export const WAITING_HINT_MS = 20 * 1000
/** The process table is read at most this often. */
export const PS_EVERY_MS = 4 * 1000
/** The folder of transcripts is listed at most this often. */
export const DISCOVER_EVERY_MS = 10 * 1000
/** A registry `procStart` and the `ps` start time name the same process when they differ by no more than this. */
export const PROC_START_TOLERANCE_MS = 2000

export const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** procStart is written in UTC and `ps` prints local time: the same instant under either reading, within the tolerance. */
export function sameStart(procStart: string, lstart: string, toleranceMs = PROC_START_TOLERANCE_MS): boolean {
  const reads = (t: string): number[] => [Date.parse(t), Date.parse(`${t} UTC`)].filter(Number.isFinite)
  const got = reads(lstart)
  return reads(procStart).some(want => got.some(g => Math.abs(g - want) <= toleranceMs))
}

/** Only `<pid>.json` is ever opened in the sessions folder; the `*.key` peer tokens beside it never are. */
export const REGISTRY_NAME = /^(\d+)\.json$/
/** A transcript is `<session id>.jsonl`. */
export const TRANSCRIPT_NAME = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i
export const SUBAGENT_NAME = /^agent-[A-Za-z0-9_-]+\.jsonl$/

export const SESSION_ROWS = {
  /** Rows on the frame at most. */
  MAX: 8,
  TITLE_CHARS: 70,
  TASK_CHARS: 80,
  PROJECT_CHARS: 20,
  BRANCH_CHARS: 20,
  /** What of a tool call's input is kept before the whole task line is cut to TASK_CHARS. */
  TOOL_DETAIL_CHARS: 120,
  /** What a row's name falls back to: the first characters of the session id. */
  ID_CHARS: 8,
} as const

const PS_LINE = /^\s*(\d+)\s+(\d+)\s+([A-Z][a-z]{2} [A-Z][a-z]{2}\s+\d{1,2} \d{2}:\d{2}:\d{2} \d{4})\s+(.*)$/
const CLAUDE_CMD = /(?:^|\/)claude(?:\s+(.*))?$/
const WRAPPERS = ['disclaimer']
const SUBCOMMANDS = ['plugin', 'mcp', 'config', 'doctor', 'update', 'install', 'migrate-installer', 'setup-token', 'auth', 'agents', 'eval', 'test']
const SESSION_ID_ARG = /(?:^|\s)--(?:resume|session-id|continue-session|r)[ =]([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i
const MS_PER_MIN = 60_000
const MIN_PER_HOUR = 60
const HOURS_PER_DAY = 24

/** What a registry file (`~/.claude/sessions/<pid>.json`) says. */
export type SessionEntry = {
  pid: number
  sessionId: string
  cwd: string | null
  name: string | null
  status: 'busy' | 'idle' | null
  startedAt: number | null
  procStart: string | null
}
export type Proc = { pid: number; ppid: number; lstart: string; sessionId: string | null; isClaude: boolean }
/** A live session: from the registry, or (no registry file, `claude --resume <id>`) from `ps` alone. */
export type LiveSession = { sessionId: string; pid: number; cwd: string | null; name: string | null; status: 'busy' | 'idle' | null; startedAt: number | null }
/** What the tail of a transcript says (./sessions-io.ts reads it, `readTail` folds it). */
export type TailRead = {
  title: string | null
  slug: string | null
  cwd: string | null
  branch: string | null
  prompt: string | null
  /** Tool calls with no answer in the tail. */
  pending: number
  /** The newest tool call with no answer, as `<Tool>: <what>`; null when every call was answered. */
  doing: string | null
  /** The first sentence of the newest assistant text of the current turn (no newer prompt), markdown stripped; null when there is none. */
  said: string | null
}
export const EMPTY_TAIL: TailRead = { title: null, slug: null, cwd: null, branch: null, prompt: null, pending: 0, doing: null, said: null }
export type SessionState = 'busy' | 'waiting' | 'idle'
/** One row of the frame, ready to draw (ages are coarse, so a quiet board does not change every poll). */
export type SessionRow = { id: string; title: string; state: SessionState; project: string; branch?: string; age?: string; task?: string }
/** Everything known about one live session before it becomes a row. */
export type SessionFacts = { live: LiveSession; slug: string | null; tail: TailRead; mainMs: number | null; lastWriteMs: number | null }

/** The tool input fields that say what a call does, best first. */
const TOOL_DETAIL_KEYS = ['description', 'command', 'file_path', 'path', 'pattern', 'url', 'query'] as const
const MCP_PREFIX = /^mcp__.+?__/
const SENTENCE = /^(.+?[.!?])(?=\s|$)/
const ARROW = /\s*['"`]*\s*(?:->|=>|→)\s*['"`]*\s*/g
const BRANCH_NOISE = 'HEAD'

const str = (v: unknown, max: number): string | null => (typeof v === 'string' ? v.slice(0, max) : null)

/** One registry file's text -> an entry, or undefined when it is not a session entry. */
export function parseEntry(text: string): SessionEntry | undefined {
  try {
    const o = JSON.parse(text) as Record<string, unknown>
    if (o === null || typeof o !== 'object' || typeof o.pid !== 'number' || !Number.isInteger(o.pid) || typeof o.sessionId !== 'string' || !SESSION_ID.test(o.sessionId)) return undefined
    return {
      pid: o.pid,
      sessionId: o.sessionId.toLowerCase(),
      cwd: str(o.cwd, 400),
      name: str(o.name, 80),
      status: o.status === 'busy' || o.status === 'idle' ? o.status : null,
      startedAt: typeof o.startedAt === 'number' && Number.isFinite(o.startedAt) ? o.startedAt : null,
      procStart: str(o.procStart, 40),
    }
  } catch {
    return undefined
  }
}

/** `ps -axo pid=,ppid=,lstart=,command=` output -> pid -> process. Arguments are read for a session id and never kept. */
export function parsePs(text: string): Map<number, Proc> {
  const procs = new Map<number, Proc>()
  for (const line of text.split('\n')) {
    const m = PS_LINE.exec(line)
    if (m === null) continue
    const [, pid, ppid, lstart, command] = m as unknown as [string, string, string, string, string]
    const first = command.split(/\s+/, 1)[0] ?? ''
    const isWrapper = WRAPPERS.includes(first.split('/').pop() ?? '')
    const c = isWrapper ? null : CLAUDE_CMD.exec(command)
    const args = c?.[1] ?? ''
    const isClaude = c !== null && !SUBCOMMANDS.includes(args.split(/\s+/, 1)[0] ?? '')
    procs.set(Number(pid), { pid: Number(pid), ppid: Number(ppid), lstart, sessionId: isClaude ? (SESSION_ID_ARG.exec(args)?.[1]?.toLowerCase() ?? null) : null, isClaude })
  }
  return procs
}

/** Is this registry entry's process still the one that registered? (a recycled pid must not resurrect a dead session) */
export function isAlive(entry: SessionEntry, procs: ReadonlyMap<number, Proc>, toleranceMs = PROC_START_TOLERANCE_MS): boolean {
  const proc = procs.get(entry.pid)
  if (proc === undefined) return false
  return entry.procStart === null ? proc.isClaude : sameStart(entry.procStart, proc.lstart, toleranceMs)
}

/** Registry entries + the process table -> the live sessions by id (the latest start wins a duplicate id). */
export function liveSessions(entries: readonly SessionEntry[], procs: ReadonlyMap<number, Proc>): Map<string, LiveSession> {
  const live = new Map<string, LiveSession>()
  const started = new Map<string, number>()
  for (const e of entries) {
    if (!isAlive(e, procs)) continue
    if ((started.get(e.sessionId) ?? -1) > (e.startedAt ?? 0)) continue
    started.set(e.sessionId, e.startedAt ?? 0)
    live.set(e.sessionId, { sessionId: e.sessionId, pid: e.pid, cwd: e.cwd, name: e.name, status: e.status, startedAt: e.startedAt })
  }
  // A process runs one session at a time: when the registry says which one it runs now, the id still on its command line is the one it started as.
  const claimed = new Set([...live.values()].map(l => l.pid))
  for (const p of procs.values()) {
    if (p.sessionId === null || live.has(p.sessionId) || claimed.has(p.pid)) continue
    live.set(p.sessionId, { sessionId: p.sessionId, pid: p.pid, cwd: null, name: null, status: null, startedAt: null })
  }
  return live
}

/** A user row's text when it is a person's prompt; undefined for tool results, meta rows, command tags and interrupts. */
export function promptOf(row: Record<string, unknown>): string | undefined {
  if (row.isMeta === true || row.isSidechain === true) return undefined
  const content = (row.message as { content?: unknown } | undefined)?.content
  if (Array.isArray(content) && content.some(b => (b as { type?: unknown } | null)?.type === 'tool_result')) return undefined
  const text = (typeof content === 'string' ? content : Array.isArray(content) ? content.map(b => ((b as { type?: unknown; text?: unknown } | null)?.type === 'text' ? String((b as { text: unknown }).text) : '')).join(' ') : '').trim()
  return text === '' || text.startsWith('<') || text.startsWith('[Request interrupted') ? undefined : text
}

const squash = (t: string): string => t.replace(/\s+/g, ' ').trim()

/** `<Tool>: <description | command | file | pattern>` for one tool_use block (the mcp prefix dropped). */
export function toolLabel(name: unknown, input: unknown): string {
  const tool = typeof name === 'string' ? name.replace(MCP_PREFIX, '') : ''
  const o = input !== null && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const key = TOOL_DETAIL_KEYS.find(k => typeof o[k] === 'string' && squash(o[k] as string) !== '')
  const detail = key === undefined ? '' : squash(o[key] as string).slice(0, SESSION_ROWS.TOOL_DETAIL_CHARS)
  return detail === '' ? tool : `${tool}: ${detail}`
}

/** The first sentence of an assistant text with the markdown marks taken out; '' when there is no text. */
export function firstSentence(text: string): string {
  const plain = squash(text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s*(?:#{1,6}|>|[-*+])\s+/gm, '')
    .replace(/[*`]|~~/g, ''))
  return SENTENCE.exec(plain)?.[1] ?? plain
}

/** A prompt as a task line: quote marks around it or before an arrow, and the arrows, are noise from pasted text. */
export const cleanPrompt = (text: string): string => squash(text.replace(ARROW, ' ')).replace(/^['"`]+/, '').replace(/['"`]+$/, '').trim()

/** The tail of a transcript (JSONL text; its first line may be cut) folded into what the frame needs. Never throws. */
export function readTail(text: string): TailRead {
  const t: { -readonly [K in keyof TailRead]: TailRead[K] } = { ...EMPTY_TAIL }
  const pending = new Map<string, string>()
  for (const line of text.split('\n')) {
    if (line === '') continue
    let row: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(line)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue
      row = parsed as Record<string, unknown>
    } catch {
      continue // the cut first line, or a half-written last one
    }
    t.cwd = str(row.cwd, 400) ?? t.cwd
    t.branch = str(row.gitBranch, 80) ?? t.branch
    t.slug = str(row.slug, 80) ?? t.slug
    if (row.type === 'ai-title') t.title = str(row.aiTitle, 200) ?? t.title
    else if (row.type === 'last-prompt' && typeof row.lastPrompt === 'string') t.prompt = row.lastPrompt.trim().startsWith('<') ? t.prompt : row.lastPrompt
    else if (row.type === 'assistant' || row.type === 'user') {
      const content = (row.message as { content?: unknown } | undefined)?.content
      const isSide = row.isSidechain === true
      for (const b of Array.isArray(content) ? (content as Record<string, unknown>[]) : []) {
        if (b === null || typeof b !== 'object') continue
        if (b.type === 'tool_use' && typeof b.id === 'string') pending.set(b.id, toolLabel(b.name, b.input))
        else if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') pending.delete(b.tool_use_id)
        else if (b.type === 'text' && row.type === 'assistant' && !isSide && typeof b.text === 'string') t.said = firstSentence(b.text) || t.said
      }
      if (row.type === 'user') {
        const prompt = promptOf(row)
        if (prompt !== undefined) {
          t.prompt = prompt
          t.said = null // what the assistant said before this prompt is about the previous turn
        }
      }
    }
  }
  t.pending = pending.size
  t.doing = [...pending.values()].pop() ?? null
  return t
}

/** A cheap age: `now`, `5m`, `3h`, `2d`; minutes at the finest, so a quiet board stays quiet. */
export function ageText(ms: number): string {
  const min = Math.floor(ms / MS_PER_MIN)
  if (min < 1) return 'now'
  if (min < MIN_PER_HOUR) return `${min}m`
  const hours = Math.floor(min / MIN_PER_HOUR)
  return hours < HOURS_PER_DAY ? `${hours}h` : `${Math.floor(hours / HOURS_PER_DAY)}d`
}

/** busy / idle / may be waiting, from the transcript tail and the write age. */
export function stateOf(f: Pick<SessionFacts, 'live' | 'tail' | 'mainMs' | 'lastWriteMs'>, now: number): SessionState {
  const quietMs = f.mainMs === null ? null : now - f.mainMs
  if (f.tail.pending > 0 && quietMs !== null && quietMs >= WAITING_HINT_MS) return 'waiting'
  const ageMs = f.lastWriteMs === null ? null : Math.max(0, now - f.lastWriteMs)
  return (ageMs !== null && ageMs < RUNNING_WRITE_MS) || f.live.status === 'busy' ? 'busy' : 'idle'
}

/** The last folder of the working directory, else the last word of the transcript folder's name. */
const projectOf = (cwd: string | null, slug: string | null): string => {
  if (cwd !== null) return cwd.replace(/\/+$/, '').split('/').pop() || cwd
  return (slug ?? '').split('-').filter(Boolean).pop() ?? ''
}

/** Waiting first (it needs the user), then busy, then the quiet ones; inside each, the most recent write first. */
const RANK: Record<SessionState, number> = { waiting: 0, busy: 1, idle: 2 }
const rank = (s: SessionState): number => RANK[s]

/** The row of one session: every text scrubbed (secrets, home folder) and cut. */
export function sessionRow(f: SessionFacts, now: number): SessionRow {
  const cwd = f.tail.cwd ?? f.live.cwd
  const title = scrubText(f.tail.title ?? f.live.name ?? f.tail.slug ?? '')
  const branch = f.tail.branch === null || f.tail.branch === BRANCH_NOISE ? '' : scrubText(f.tail.branch) // "HEAD" is what a detached or worktree checkout records
  const task = scrubText(f.tail.doing ?? f.tail.said ?? (f.tail.prompt === null ? '' : cleanPrompt(f.tail.prompt)))
  return {
    id: f.live.sessionId,
    title: clip(title === '' ? f.live.sessionId.slice(0, SESSION_ROWS.ID_CHARS) : title, SESSION_ROWS.TITLE_CHARS),
    state: stateOf(f, now),
    project: clip(scrubText(projectOf(cwd, f.slug)), SESSION_ROWS.PROJECT_CHARS),
    ...(branch === '' ? {} : { branch: clip(branch, SESSION_ROWS.BRANCH_CHARS) }),
    ...(f.lastWriteMs === null ? {} : { age: ageText(Math.max(0, now - f.lastWriteMs)) }),
    ...(task === '' ? {} : { task: clip(task, SESSION_ROWS.TASK_CHARS) }),
  }
}

/** The rows to draw: one per other session, ordered (busy, then most recent), at most SESSION_ROWS.MAX. */
export function sessionRows(facts: readonly SessionFacts[], selfId: string, now: number): SessionRow[] {
  const self = selfId.toLowerCase()
  return facts
    .filter(f => f.live.sessionId !== self)
    .map(f => ({ f, row: sessionRow(f, now) }))
    .sort((a, b) => rank(a.row.state) - rank(b.row.state) || (b.f.lastWriteMs ?? 0) - (a.f.lastWriteMs ?? 0))
    .slice(0, SESSION_ROWS.MAX)
    .map(x => x.row)
}

/** Which live sessions deserve a tail read at all: the same order as the rows, judged before any tail is read (busy by registry or recent write). */
export function candidates(live: ReadonlyMap<string, LiveSession>, mtimes: ReadonlyMap<string, number>, selfId: string, now: number): LiveSession[] {
  const self = selfId.toLowerCase()
  const recent = (l: LiveSession): number => mtimes.get(l.sessionId) ?? 0
  const isBusy = (l: LiveSession): boolean => l.status === 'busy' || now - recent(l) < RUNNING_WRITE_MS
  return [...live.values()]
    .filter(l => l.sessionId !== self)
    .sort((a, b) => Number(isBusy(b)) - Number(isBusy(a)) || recent(b) - recent(a))
    .slice(0, SESSION_ROWS.MAX)
}
