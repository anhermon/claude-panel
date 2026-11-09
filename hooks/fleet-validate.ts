// The hub's judgement of one command file: pure, no `$`. The page's server validated it once; the hub does it again
// against the registry and the process table because a file in a shared folder is not trusted for what it claims.
import {
  COMMAND_CLOCK_SKEW_MS,
  COMMAND_MAX_AGE_MS,
  FLEET_COMMAND_ID,
  FLEET_MESSAGE_MAX_CHARS,
  FLEET_ORIGIN,
  FLEET_ORIGIN_PREFIX,
  PROC_START_TOLERANCE_MS,
  RATE_MAX_PER_TARGET,
  RATE_WINDOW_MS,
} from './fleet-contract'

export const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g
/** `ps -o lstart=`: `Thu Nov  5 07:34:30 2026`. */
const LSTART = /[A-Z][a-z]{2} [A-Z][a-z]{2}\s+\d{1,2} \d{2}:\d{2}:\d{2} \d{4}/

export type FleetCommand = {
  id: string
  sessionId: string
  pid: number
  procStart: string | null
  text: string
  ts: number
}
/** What a registry file (`~/.claude/sessions/<pid>.json`) says about the pid. */
export type RegistryRow = { pid: number; sessionId: string; procStart: string | null }
export type Judgement = { ok: true; command: FleetCommand } | { ok: false; reason: string }
export type JudgeInput = {
  /** The parsed command file. */
  command: unknown
  now: number
  selfSessionId: string
  /** hub-config.json `allowSelf`: the one way to message the session the hub itself runs in (off by default: loops). */
  allowSelf: boolean
  registry: RegistryRow | undefined
  /** `ps -p <pid> -o lstart=` for the command's pid; undefined when no such process. */
  lstart: string | undefined
  /** When the hub sent to this target before (epoch ms). */
  recentSends: readonly number[]
}

const refuse = (reason: string): Judgement => ({ ok: false, reason })

/** A registry file's text -> its row, or undefined when it is not a session entry. */
export function parseRegistry(text: string): RegistryRow | undefined {
  try {
    const o = JSON.parse(text) as Record<string, unknown>
    if (typeof o.pid !== 'number' || !Number.isInteger(o.pid) || typeof o.sessionId !== 'string' || !SESSION_ID.test(o.sessionId)) return undefined
    return { pid: o.pid, sessionId: o.sessionId.toLowerCase(), procStart: typeof o.procStart === 'string' ? o.procStart : null }
  } catch {
    return undefined
  }
}

/** The start time out of `ps -o lstart=` output, or undefined. */
export const parseLstart = (stdout: string): string | undefined => LSTART.exec(stdout)?.[0]

/** procStart is written in UTC and `ps` prints local time: the same instant under either reading, within the tolerance. */
export function sameStart(procStart: string, lstart: string, toleranceMs = PROC_START_TOLERANCE_MS): boolean {
  const reads = (t: string): number[] => [Date.parse(t), Date.parse(`${t} UTC`)].filter(Number.isFinite)
  const got = reads(lstart)
  return reads(procStart).some(want => got.some(g => Math.abs(g - want) <= toleranceMs))
}

/** Sends to this target inside the window. */
export const sendsInWindow = (recent: readonly number[], now: number): number => recent.filter(t => now - t < RATE_WINDOW_MS).length

export function judge(i: JudgeInput): Judgement {
  const c = i.command
  if (c === null || typeof c !== 'object') return refuse('the command file is not a JSON object')
  const o = c as Record<string, unknown>
  if (o.origin !== FLEET_ORIGIN) return refuse('the command does not come from the fleet page')
  if (typeof o.id !== 'string' || !FLEET_COMMAND_ID.test(o.id)) return refuse('the command id is malformed')
  if (typeof o.sessionId !== 'string' || !SESSION_ID.test(o.sessionId)) return refuse('sessionId is not a session id')
  if (typeof o.pid !== 'number' || !Number.isInteger(o.pid) || o.pid <= 0) return refuse('pid is not a process id')
  if (typeof o.ts !== 'number' || !Number.isFinite(o.ts)) return refuse('the command has no time')
  if (typeof o.text !== 'string') return refuse('text must be a string')
  const text = o.text.replace(CONTROL_CHARS, '').trim()
  if (text === '') return refuse('the message is empty')
  if (text.length > FLEET_MESSAGE_MAX_CHARS) return refuse(`the message is longer than ${FLEET_MESSAGE_MAX_CHARS} characters`)
  if (text.includes(FLEET_ORIGIN_PREFIX)) return refuse('the message already carries the fleet marker')
  if (i.now - o.ts > COMMAND_MAX_AGE_MS) return refuse('the command expired before the hub saw it')
  if (o.ts - i.now > COMMAND_CLOCK_SKEW_MS) return refuse('the command is dated in the future')
  const sessionId = o.sessionId.toLowerCase()
  const procStart = typeof o.procStart === 'string' ? o.procStart : null
  if (sessionId === i.selfSessionId.toLowerCase() && !i.allowSelf) return refuse('refused: this is the session the hub runs in (a send to itself can loop)')
  const reg = i.registry
  if (reg === undefined) return refuse('that session has no registry entry, so it cannot be verified')
  if (reg.sessionId !== sessionId) return refuse('that pid now belongs to another session')
  if (reg.procStart === null) return refuse('the registry has no start time for that session, so it cannot be verified')
  if (procStart !== null && procStart !== reg.procStart) return refuse('the session was restarted since the page last saw it')
  if (i.lstart === undefined) return refuse('that session is not running')
  if (!sameStart(reg.procStart, i.lstart)) return refuse('that pid is now another process')
  if (sendsInWindow(i.recentSends, i.now) >= RATE_MAX_PER_TARGET) return refuse(`rate limit: at most ${RATE_MAX_PER_TARGET} messages per minute to one session`)
  return { ok: true, command: { id: o.id, sessionId, pid: o.pid, procStart, text, ts: o.ts } }
}
