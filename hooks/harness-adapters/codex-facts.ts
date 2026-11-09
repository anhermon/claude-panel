// The run-level facts of a codex rollout that the detail view's Metrics tab shows next to the entries: when it started and ended (the run's
// OWN clock), the token totals split fresh / cached / output / reasoning, the peak context against the model's window, the rate limits,
// the instants of every row (for the active time) and how many reasoning steps the harness kept only encrypted. Pure, no `$`.
// A second, lighter pass than ./codex.ts: only the rows that carry these facts are parsed (a row's type is read from its first
// characters), so a tail of a few MiB costs little. Safe on bad input: a cut line, an unknown row or a missing field is skipped.
import { CODEX } from './codex'

const ROW_HEAD = /^\{\s*"timestamp"\s*:\s*"([^"]*)"\s*,\s*"ordinal"\s*:\s*\d+\s*,\s*"type"\s*:\s*"([a-z_]+)"\s*,\s*"payload"\s*:\s*\{\s*"type"\s*:\s*"([A-Za-z_]+)"/
const WANTED: ReadonlySet<string> = new Set(['task_started', 'token_count', 'task_complete'])
const REASONING_ITEM = /"type"\s*:\s*"Reasoning"/
const EMPTY_SUMMARY = /"summary_text"\s*:\s*\[\s*\]/
const ITEM_DONE_HEAD = /^\{\s*"timestamp"\s*:\s*"[^"]*"\s*,\s*"ordinal"\s*:\s*\d+\s*,\s*"type"\s*:\s*"event_msg"\s*,\s*"payload"\s*:\s*\{\s*"type"\s*:\s*"item_completed"/
const MS_PER_S = 1000
const PERCENT = 100

export type CodexTokens = { input: number; cached: number; output: number; reasoning: number }
/** One rate-limit window as the rollout reports it: how much of it is used and how long it is. */
export type RateWindow = { usedPct: number; windowMinutes: number | null; resetsAt: number | null }
export type CodexRate = { plan: string | null; primary: RateWindow | null; secondary: RateWindow | null; isReached: boolean }

export type CodexFacts = {
  /** The run's own start and end (ms): `task_started` / `task_complete`, else the first / last row; null when the piece has no row. */
  startedAt: number | null
  endedAt: number | null
  isComplete: boolean
  /** The wall time the harness reports for the task; null when it does not. */
  durationMs: number | null
  /** The cumulative totals at the last `token_count`; null when the piece has none. */
  tokens: CodexTokens | null
  /** The biggest context any request sent (its `input_tokens`, cached included) and the model's window. */
  peakContext: number | null
  contextWindow: number | null
  rate: CodexRate | null
  /** Reasoning steps whose summary the harness did not keep (encrypted). */
  reasoningHidden: number
  /** The instants (ms) of every row, oldest first: the time the rollout shows life. */
  stamps: number[]
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v)
const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)
const maybe = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null)

function tokensOf(v: unknown): CodexTokens | null {
  if (!isObj(v)) return null
  const input = count(v.input_tokens)
  const output = count(v.output_tokens)
  if (input + output === 0) return null
  return { input, cached: Math.min(count(v.cached_input_tokens), input), output, reasoning: Math.min(count(v.reasoning_output_tokens), output) }
}

function windowOf(v: unknown): RateWindow | null {
  const used = isObj(v) ? maybe(v.used_percent) : null
  return !isObj(v) || used === null ? null : { usedPct: Math.min(PERCENT, used), windowMinutes: maybe(v.window_minutes), resetsAt: maybe(v.resets_at) }
}

function rateOf(v: unknown): CodexRate | null {
  if (!isObj(v)) return null
  const primary = windowOf(v.primary)
  const secondary = windowOf(v.secondary)
  if (primary === null && secondary === null) return null
  return { plan: typeof v.plan_type === 'string' && v.plan_type !== '' ? v.plan_type : null, primary, secondary, isReached: typeof v.rate_limit_reached_type === 'string' && v.rate_limit_reached_type !== '' }
}

/** The facts of a piece of rollout. `isWhole`: the piece starts at the file's first byte (else its cut first line is dropped). Never throws. */
export function codexFactsOf(text: string, isWhole: boolean): CodexFacts {
  const facts: CodexFacts = { startedAt: null, endedAt: null, isComplete: false, durationMs: null, tokens: null, peakContext: null, contextWindow: null, rate: null, reasoningHidden: 0, stamps: [] }
  const lines = text.split('\n')
  if (!isWhole) lines.shift()
  let started: number | null = null
  let ended: number | null = null
  let seen = 0
  for (const line of lines) {
    if (line.trim() === '') continue
    if (++seen > CODEX.MAX_ROWS) break
    if (line.length > CODEX.MAX_ROW_CHARS) continue
    const head = line.slice(0, CODEX.HEAD_CHARS)
    const m = ROW_HEAD.exec(head)
    const stamp = Date.parse(m?.[1] ?? head.slice(14, 38))
    if (Number.isFinite(stamp)) facts.stamps.push(stamp)
    if (ITEM_DONE_HEAD.test(head)) {
      if (REASONING_ITEM.test(line) && EMPTY_SUMMARY.test(line)) facts.reasoningHidden++
      continue
    }
    if (m === null || m[2] !== 'event_msg' || !WANTED.has(m[3] ?? '')) continue
    let payload: unknown
    try {
      payload = (JSON.parse(line) as { payload?: unknown }).payload
    } catch {
      continue
    }
    if (!isObj(payload)) continue
    if (m[3] === 'task_started') {
      const at = count(payload.started_at)
      started = Number.isFinite(stamp) ? stamp : at > 0 ? at * MS_PER_S : null
      facts.contextWindow = maybe(payload.model_context_window) ?? facts.contextWindow
    } else if (m[3] === 'task_complete') {
      facts.isComplete = true
      const at = count(payload.completed_at)
      ended = Number.isFinite(stamp) ? stamp : at > 0 ? at * MS_PER_S : null
      facts.durationMs = maybe(payload.duration_ms)
    } else {
      const info = isObj(payload.info) ? payload.info : {}
      facts.tokens = tokensOf(info.total_token_usage) ?? facts.tokens
      const last = tokensOf(info.last_token_usage)
      if (last !== null) facts.peakContext = Math.max(facts.peakContext ?? 0, last.input)
      facts.contextWindow = maybe(info.model_context_window) ?? facts.contextWindow
      facts.rate = rateOf(payload.rate_limits) ?? facts.rate
    }
  }
  const first = facts.stamps[0]
  const last = facts.stamps.at(-1)
  facts.startedAt = started ?? (isWhole && first !== undefined ? first : null)
  facts.endedAt = ended ?? (facts.isComplete ? (last ?? null) : null)
  return facts
}

/**
 * The time a rollout shows life: the sum of the gaps between consecutive rows that are at most `idleGapMs` (a longer silence is idle,
 * not work). 0 for fewer than two rows.
 */
export function activeMsOf(stamps: readonly number[], idleGapMs: number): number {
  let total = 0
  for (let i = 1; i < stamps.length; i++) {
    const gap = (stamps[i] as number) - (stamps[i - 1] as number)
    if (gap > 0 && gap <= idleGapMs) total += gap
  }
  return total
}
