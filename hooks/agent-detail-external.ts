// The detail of a run of ANOTHER harness (codex), pure: no `$`, no I/O (the reader is ./agent-detail-external-io.ts). The run's rollout is
// read through its harness adapter into the same neutral entries a Claude subagent's transcript gives, so ./agent-detail.ts builds the
// Transcript, Progress and Struggles tabs unchanged; this file then puts the run's OWN numbers into the Metrics tab (its clock, the time the
// rollout shows life, failed calls) and adds `external`: the facts a Claude agent has no use for (token split with the cache share, the peak
// context against the window, rate limits, the cost, which is never invented). A number the data does not hold is null.
import { buildDetail } from './agent-detail'
import { evalLineOf, resultOfReport, whatOfEval } from './agent-proof'
import type { AgentProof } from './agent-proof'
import type { AgentDetail, DetailSubject, TranscriptRead } from './agent-detail'
import type { LaneInfo } from './agent-progress'
import { STALL_MS } from './agent-struggles'
import { adapterOf } from './harness-adapters'
import { activeMsOf, codexFactsOf } from './harness-adapters/codex-facts'
import type { CodexFacts, CodexRate, CodexTokens } from './harness-adapters/codex-facts'
import type { PulseEvent, PulseLoop } from './pulse-model'
import type { RunRecord } from './run-records'
import { clip } from './transcript-redact'
import type { Entry, ToolEntry } from './transcript-parse'

export const EXTERNAL = {
  /** The bytes read from the START of a rollout whose tail does not reach it (the brief and the first facts sit there). */
  HEAD_BYTES: 262_144,
  MS_PER_S: 1000,
  FACT_CHARS: 40,
} as const

/** Why there is no transcript: one sentence each, shown as is by the page. */
export const EXTERNAL_REASON = {
  NO_ROLLOUT: 'no rollout found for this run (codex thread unknown)',
  UNREADABLE: 'The rollout file exists but could not be read, so only what the run record holds is shown.',
  /** The cost: the rollout and delegation-kit's record hold token counts, never a price. */
  COST: 'codex rollouts and delegation-kit records carry token counts but no price',
} as const

export type ExternalTokens = { input: number; fresh: number; cached: number; output: number; reasoning: number; total: number; cacheShare: number | null }
export type ExternalFacts = {
  harness: string
  model: string | null
  effort: string | null
  recordStatus: string
  /** Where the numbers come from: the rollout, or only the run record (no rollout). */
  source: 'rollout' | 'record'
  /** The rollout was read from its tail only, so the active time covers that part. */
  isPartial: boolean
  /** The run's own clock (its record: start to end, else to now). */
  runMs: number
  /** The time the harness says the task took (`task_complete`), without the process start-up. */
  taskMs: number | null
  calls: number
  failed: number | null
  tokens: ExternalTokens | null
  context: { peak: number; window: number | null; share: number | null } | null
  rate: CodexRate | null
  cost: { isMeasured: false; reason: string }
  /** Reasoning steps the harness kept only encrypted, so they cannot be shown as "thinking". */
  reasoningHidden: number
  /** The brief's `Eval:` line and the `Eval result:` the final message states (./agent-proof.ts), for any brief that has an Eval line, ticket or not; null when it has none. */
  proof: AgentProof | null
}
export type ExternalDetail = AgentDetail & { external: ExternalFacts }

/** A piece of rollout the host read: the tail, and the head when the tail does not reach the file's start. */
export type RolloutPiece = { text: string; headText: string; isWhole: boolean; size: number; readBytes: number }

const isTool = (e: Entry): e is ToolEntry => e.kind === 'tool'
const hasError = (e: ToolEntry): boolean => e.error !== null && e.error !== ''
const share = (part: number, whole: number | null): number | null => (whole === null || whole <= 0 ? null : Math.min(1, part / whole))

/** The token split: input includes the cached part, output includes the reasoning part (codex counts them that way). */
export function tokensOf(t: CodexTokens | null): ExternalTokens | null {
  if (t === null) return null
  const fresh = Math.max(0, t.input - t.cached)
  return { input: t.input, fresh, cached: t.cached, output: t.output, reasoning: t.reasoning, total: fresh + t.output, cacheShare: share(t.cached, t.input) }
}

/** The record's own token figures, for a run whose rollout is not there. */
function recordTokensOf(record: RunRecord): CodexTokens | null {
  const t = record.tokens
  if (t === undefined) return null
  const cached = t.cached ?? 0
  const input = t.input ?? (t.fresh === undefined ? 0 : t.fresh + cached)
  const output = t.output ?? 0
  return input + output > 0 ? { input, cached, output, reasoning: t.reasoning ?? 0 } : null
}

/** The rollout read like a Claude transcript: the entries, steps and brief, plus the run-level facts. null when it cannot be parsed. */
function readOf(record: RunRecord, piece: RolloutPiece): { read: TranscriptRead; facts: CodexFacts; proof: AgentProof | null } | null {
  const adapter = adapterOf(record.transcript?.format)
  if (adapter === undefined) return null
  const head = piece.isWhole ? undefined : adapter.parse(piece.headText, true)
  const facts = codexFactsOf(piece.text, piece.isWhole)
  if (!piece.isWhole) {
    const first = codexFactsOf(piece.headText, true)
    facts.startedAt = facts.startedAt ?? first.startedAt
    facts.contextWindow = facts.contextWindow ?? first.contextWindow
  }
  const read: TranscriptRead = {
    parsed: adapter.parse(piece.text, piece.isWhole),
    head: head?.brief ?? '',
    ...(head?.briefFull === undefined ? {} : { headFull: head.briefFull }),
    isWhole: piece.isWhole,
    fileBytes: piece.size,
    readBytes: piece.readBytes,
  }
  const evalLine = evalLineOf(adapter.rawBrief?.(piece.isWhole ? piece.text : piece.headText) ?? '')
  const proof: AgentProof | null = evalLine === '' ? null : { eval: evalLine, what: whatOfEval(evalLine), result: resultOfReport(adapter.lastMessage(piece.text)) }
  return { read, facts, proof }
}

/**
 * The whole detail of one delegated run. `rollout` null: there is none (never started, thread unknown, unreadable: `unavailable` says
 * which), and the record's facts are all there is. Pure: the same inputs give the same detail.
 */
export function buildExternalDetail(args: {
  subject: DetailSubject
  loop: PulseLoop | undefined
  record: RunRecord
  events: readonly PulseEvent[]
  lane?: LaneInfo
  rollout: RolloutPiece | null
  unavailable: string
  pages: number
  now: number
}): ExternalDetail {
  const { record, subject } = args
  const got = args.rollout === null ? null : readOf(record, args.rollout)
  const facts = got?.facts
  const endedAt = subject.endedAt ?? (facts?.isComplete === true ? facts.endedAt : null)
  const base = buildDetail({
    subject: { ...subject, endedAt },
    loop: args.loop,
    events: args.events,
    read: got?.read ?? null,
    unavailable: args.unavailable,
    pages: args.pages,
    now: args.now,
    ...(args.lane === undefined ? {} : { lane: args.lane }),
  })
  const entries = got?.read.parsed.entries ?? []
  const calls = entries.filter(isTool)
  const isWhole = got?.read.isWhole === true
  const failed = got === null ? null : calls.filter(hasError).length
  // The pulse spans cover only calls (a model's thinking between them is not "work"), so the rollout's own life signs give the active time.
  const lived = facts === undefined ? 0 : activeMsOf(facts.stamps, STALL_MS)
  const activeMs = got === null ? base.metrics.activeMs : Math.min(lived, base.metrics.elapsedMs)
  const tokens = tokensOf(facts?.tokens ?? recordTokensOf(record))
  const peak = facts?.peakContext ?? record.tokens?.peakContext ?? null
  const window = facts?.contextWindow ?? record.tokens?.contextCap ?? null
  const external: ExternalFacts = {
    harness: clip(record.harness, EXTERNAL.FACT_CHARS),
    model: args.loop?.model ?? record.model ?? null,
    effort: args.loop?.effort ?? record.effort ?? null,
    recordStatus: clip(record.status, EXTERNAL.FACT_CHARS),
    source: got === null ? 'record' : 'rollout',
    isPartial: got !== null && !isWhole,
    runMs: base.metrics.elapsedMs,
    taskMs: facts?.durationMs ?? (record.durationS === undefined ? null : Math.round(record.durationS * EXTERNAL.MS_PER_S)),
    calls: Math.max(base.metrics.calls, calls.length),
    failed,
    tokens,
    context: peak === null ? null : { peak, window, share: share(peak, window) },
    rate: facts?.rate ?? null,
    cost: { isMeasured: false, reason: EXTERNAL_REASON.COST },
    reasoningHidden: facts?.reasoningHidden ?? 0,
    proof: got?.proof ?? null,
  }
  return {
    ...base,
    metrics: {
      ...base.metrics,
      activeMs,
      idleMs: Math.max(0, base.metrics.elapsedMs - activeMs),
      calls: external.calls,
      errors: failed ?? base.metrics.errors,
      ...(tokens === null ? {} : { tokens: { ...base.metrics.tokens, total: tokens.total } }),
    },
    external,
  }
}
