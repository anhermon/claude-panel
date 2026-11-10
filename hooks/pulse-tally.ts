// What an agent did OVER AND OVER, kept cheaply for the whole session (the event ring holds only the last 200 events of all
// agents, too shallow to see a rerun pattern). Per loop a small tally keyed by "what" + "on what": `read:board.css`,
// `edit:board.css`, `run:npm test`. The target is the same short redacted one the events carry (a basename, a program and its
// verb): nothing new is remembered about a call. Per key: calls, calls that failed, calls that were a retry (the same call
// right after it failed) and the time the calls took. Pure: no `$`, no I/O.
import type { PulseEvent } from './pulse-model'

export type TallyEntry = { n: number; err: number; retry: number; ms: number }
export type Tally = Record<string, TallyEntry>
/** The loop's open failure: the key of its last failed call, until the same call succeeds. */
export type FailedKey = string | undefined

export const TALLY_CAPS = {
  /** Keys kept per loop; past this the least-used one is dropped. */
  KEYS: 24,
  KEY_CHARS: 60,
} as const

export const TALLY_VERBS = { READ: 'read', EDIT: 'edit', RUN: 'run' } as const
export type TallyVerb = (typeof TALLY_VERBS)[keyof typeof TALLY_VERBS]
const VERB_JOIN = ':'
const READ_TOOLS: readonly string[] = ['Read', 'NotebookRead']
const EDIT_TOOLS: readonly string[] = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']
const RUN_TOOL = 'Bash'

/** The tally key of a call (`read:board.css`), or undefined for a call there is nothing to count about (no target, another tool). */
export function tallyKey(tool: string, target: string): string | undefined {
  if (target === '') return undefined
  const verb = READ_TOOLS.includes(tool) ? TALLY_VERBS.READ : EDIT_TOOLS.includes(tool) ? TALLY_VERBS.EDIT : tool === RUN_TOOL ? TALLY_VERBS.RUN : undefined
  return verb === undefined ? undefined : `${verb}${VERB_JOIN}${target}`.slice(0, TALLY_CAPS.KEY_CHARS)
}

/** The verb and the target of a key. */
export function splitKey(key: string): { verb: string; target: string } {
  const at = key.indexOf(VERB_JOIN)
  return at < 0 ? { verb: '', target: key } : { verb: key.slice(0, at), target: key.slice(at + 1) }
}

const blank = (): TallyEntry => ({ n: 0, err: 0, retry: 0, ms: 0 })

function entryFor(tally: Tally, key: string): TallyEntry {
  const held = Object.hasOwn(tally, key) ? tally[key] : undefined
  if (held !== undefined) return held
  const keys = Object.keys(tally)
  if (keys.length >= TALLY_CAPS.KEYS) {
    const least = keys.reduce((a, b) => ((tally[b] as TallyEntry).n < (tally[a] as TallyEntry).n ? b : a))
    delete tally[least]
  }
  return (tally[key] = blank())
}

/** What the tally needs of a loop. */
export type Tallied = { tally?: Tally; failedKey?: FailedKey }

/** A call begins: counted, and counted as a retry when the same call failed right before (nothing else succeeded for it since). */
export function tallyBegin(loop: Tallied, ev: Pick<PulseEvent, 'tool' | 'target'>): void {
  const key = tallyKey(ev.tool, ev.target)
  if (key === undefined) return
  const entry = entryFor((loop.tally ??= {}), key)
  entry.n++
  if (loop.failedKey === key) entry.retry++
}

/** A call ended after `ms`: its time and failure are counted; the loop's open failure becomes this key when it failed, and is cleared when it succeeded. */
export function tallyEnd(loop: Tallied, ev: Pick<PulseEvent, 'tool' | 'target'>, ms: number, isFailed: boolean): void {
  const key = tallyKey(ev.tool, ev.target)
  if (key === undefined) return
  const entry = entryFor((loop.tally ??= {}), key)
  entry.ms += Math.max(0, ms)
  if (isFailed) entry.err++
  if (isFailed) loop.failedKey = key
  else if (loop.failedKey === key) delete loop.failedKey
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0)

/** Total failed tool calls recorded across a loop's tally. */
export const tallyErrors = (tally: Tally | undefined): number =>
  tally === undefined ? 0 : Object.values(tally).reduce((sum, e) => sum + e.err, 0)

/** A stored tally read back: only well-formed keys and numbers, capped. */
export function restoreTally(v: unknown): Tally {
  const out: Tally = {}
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return out
  for (const [key, raw] of Object.entries(v as Record<string, unknown>).slice(0, TALLY_CAPS.KEYS)) {
    if (key.length > TALLY_CAPS.KEY_CHARS || raw === null || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    if (num(r.n) > 0) out[key] = { n: num(r.n), err: num(r.err), retry: num(r.retry), ms: num(r.ms) }
  }
  return out
}
