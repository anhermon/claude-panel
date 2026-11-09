// The proof of a delegated ticket (an agent whose brief starts with `Ticket: T<n>`): every ticket brief carries a line
// `Eval: <what to run and what pass looks like>`, and the agent's final report ends with `Eval result: PASS` or `Eval result: FAIL`.
// This reads both (the brief from the head of the agent's own transcript, the report from its tail; both bounded) and keeps only
// `{ eval, what, result }`: the scrubbed eval line, its plain-words gist and pass / fail / none. An agent that is NOT a ticket has
// no proof at all (`null`: never flagged). Honesty rule: only a final `Eval result: PASS` is a pass; a missing marker is `none`.
// Pure parsers first, then one lazy, bounded, once-per-agent lookup (`resolveProof`) next to agent-names.ts's.
import type { EngineInterface } from 'claude-code'

import { findTranscript, run } from './agent-names'
import { excerpt } from './transcript-redact'

export const PROOF_CAPS = {
  /** The scrubbed `Eval:` line. */
  EVAL_CHARS: 200,
  /** The gist shown after "Eval passed:". */
  WHAT_CHARS: 60,
  /** The first line of a transcript is read through this many bytes (a brief is long; the Eval line may sit far down). */
  HEAD_BYTES: 98_304,
  /** The last bytes of a transcript, enough for the final report. */
  TAIL_BYTES: 131_072,
  TRIES: 3,
  RETRY_MS: 4000,
} as const

export type ProofResult = 'pass' | 'fail' | 'none'
/** `eval`: the brief's Eval line ('' when it has none); `what`: its gist in plain words; `result`: the final report's marker. */
export type AgentProof = { eval: string; what: string; result: ProofResult }

const TICKET_LINE = /^\s*Ticket\s*:\s*\S/im
const EVAL_LINE = /^[ \t>*-]*\**Eval\**[ \t]*:\**[ \t]*(\S.*)$/im
const RESULT_MARKER = /\bEval result\s*:\s*\**\s*(PASS|FAIL)\b/gi
// Emphasis marks; a double star touching a slash is part of a glob path, not bold, and stays.
const MARKUP = /(\/?)(\*\*)(\/?)|__|`|~~/g
const LINK = /\[([^\]]*)\]\([^)]*\)/g
const CLAUSE_END = /[.;]\s/
const ELLIPSIS = '…'
const MAIN_ID = 'main'
const FIRST_LINE_END = '\n'

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
const textBlocks = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map(b => (isObj(b) && b.type === 'text' && typeof b.text === 'string' ? b.text : '')).filter(t => t !== '').join('\n')
      : ''

/** Does the brief start a delegated ticket (a `Ticket: T<n>` line)? */
export const isTicketBrief = (brief: string): boolean => TICKET_LINE.test(brief)

/** The `Eval:` line of a brief, scrubbed and cut; '' when there is none. */
export function evalLineOf(brief: string): string {
  const line = EVAL_LINE.exec(brief)?.[1]
  return line === undefined ? '' : excerpt(line, PROOF_CAPS.EVAL_CHARS)
}

/** The gist of an Eval line in plain words: no markup, its first clause, cut at a word boundary within WHAT_CHARS. */
export function whatOfEval(evalLine: string): string {
  const flat = evalLine.replace(LINK, '$1').replace(MARKUP, (mark, before: string | undefined, _bold: string | undefined, after: string | undefined) => (before || after ? mark : '')).replace(/\s+/g, ' ').trim()
  const clause = flat.split(CLAUSE_END)[0] ?? flat
  const text = clause.replace(/[.;:,\s]+$/, '')
  if (text.length <= PROOF_CAPS.WHAT_CHARS) return text
  const head = text.slice(0, PROOF_CAPS.WHAT_CHARS - ELLIPSIS.length)
  const at = head.lastIndexOf(' ')
  return `${(at > head.length / 2 ? head.slice(0, at) : head).replace(/[.;:,\s]+$/, '')}${ELLIPSIS}`
}

/** The result a final report states: its LAST `Eval result: PASS|FAIL`, else none. */
export function resultOfReport(report: string): ProofResult {
  const last = [...report.matchAll(RESULT_MARKER)].at(-1)?.[1]?.toUpperCase()
  return last === 'PASS' ? 'pass' : last === 'FAIL' ? 'fail' : 'none'
}

/** The proof of an agent from its brief and final report: undefined when the brief is no ticket's. */
export function proofOf(brief: string, report: string): AgentProof | undefined {
  if (!isTicketBrief(brief)) return undefined
  const evalLine = evalLineOf(brief)
  return { eval: evalLine, what: whatOfEval(evalLine), result: evalLine === '' ? 'none' : resultOfReport(report) }
}

/** The text of the first (user) message of a transcript's first line; '' when the line is no such message or was cut. */
export function briefTextOf(firstLine: string): string {
  try {
    const row: unknown = JSON.parse(firstLine)
    return isObj(row) && row.type === 'user' && isObj(row.message) ? textBlocks(row.message.content) : ''
  } catch {
    return ''
  }
}

/** The text of the last assistant message that has any, in a tail of a transcript (its cut first line never parses and is skipped). */
export function finalTextOf(tail: string): string {
  const lines = tail.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const row: unknown = JSON.parse(lines[i] ?? '')
      if (!isObj(row) || row.type !== 'assistant' || !isObj(row.message)) continue
      const text = textBlocks(row.message.content)
      if (text.trim() !== '') return text
    } catch {
      // a cut or garbage line
    }
  }
  return ''
}

// ---- the lazy transcript lookup -----------------------------------------------------------------------------------------------
type Attempt = { tries: number; at: number; isDone: boolean }
const attempts = new Map<string, Attempt>()
export const resetProof = (): void => attempts.clear()

/**
 * The proof of a FINISHED agent from its own transcript: an `AgentProof`, `null` (read, but not a ticket: never flagged) or undefined
 * (not found or unreadable yet, or tried enough times). At most PROOF_CAPS.TRIES lookups per agent, RETRY_MS apart; one `find`, one
 * bounded `head -c` and, for a ticket, one bounded `tail -c`. Never throws.
 */
export async function resolveProof($: EngineInterface, agentId: string, now: number): Promise<AgentProof | null | undefined> {
  const held = attempts.get(agentId) ?? { tries: 0, at: 0, isDone: false }
  if (held.isDone || held.tries >= PROOF_CAPS.TRIES || (held.tries > 0 && now - held.at < PROOF_CAPS.RETRY_MS) || agentId === MAIN_ID) return undefined
  attempts.set(agentId, { ...held, tries: held.tries + 1, at: now })
  try {
    const path = await findTranscript($, agentId)
    if (path === undefined) return undefined
    const head = await run($, ['head', '-c', String(PROOF_CAPS.HEAD_BYTES), path])
    const brief = head === undefined ? '' : briefTextOf(head.split(FIRST_LINE_END)[0] ?? '')
    if (brief === '') return undefined
    const isTicket = isTicketBrief(brief)
    const tail = isTicket ? await run($, ['tail', '-c', String(PROOF_CAPS.TAIL_BYTES), path]) : ''
    if (tail === undefined) return undefined
    attempts.set(agentId, { tries: held.tries + 1, at: now, isDone: true })
    return isTicket ? (proofOf(brief, finalTextOf(tail)) ?? null) : null
  } catch {
    return undefined
  }
}
