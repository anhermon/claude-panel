// A "router-kit" session's `.router/` state as one model (`RouterRun`), parsed tolerantly: the files are written by other
// agents under a PROPOSED contract, so nothing here throws and nothing is dropped. A missing field gets a default, an
// unknown status becomes the neutral `draft` stage (and is named in `rawStatus`). Pure: no `$`, no I/O (./router-io.ts reads).
//
// Honesty rule: a ticket is `done` (verified) only when its status is done AND its verdict is PASS AND no later
// `worker_reported` event is missing its `verify_pass`. A claim without a verifier PASS is the `unverified` stage.
import { isPlain } from './blocks/common'
import type { Plain } from './blocks/common'

export const ROUTER_CAPS = {
  /** Fix rounds the router allows before a ticket is `unverified` or `blocked` (the contract's number). */
  DEFAULT_MAX_ROUNDS: 2,
  /** Events kept in a run: the newest. */
  EVENTS_TAIL: 12,
  /** Checks kept per ticket. */
  CHECKS_PER_TICKET: 24,
  DECISIONS_PER_TICKET: 6,
  DEPENDS_PER_TICKET: 8,
  /** Items of an eval checklist (the single-ticket `checks` frame before a verdict exists). */
  EVAL_ITEMS: 12,
  TEXT_CHARS: 200,
  ID_CHARS: 40,
  /** A timestamp written in seconds is below this; in milliseconds above. */
  SECONDS_BELOW: 1e11,
  MS_PER_SECOND: 1000,
} as const

/** `unproven`: done by status and verifier, but no eval.md proves it (or its eval has not passed): never drawn as plainly done. */
export const ROUTER_STAGES = ['ready', 'building', 'verifying', 'fixing', 'done', 'unproven', 'unverified', 'blocked', 'draft'] as const
export type RouterStage = (typeof ROUTER_STAGES)[number]
/** The neutral stage an unknown or missing status gets. */
export const NEUTRAL_STAGE: RouterStage = 'draft'
const STAGE_OF_STATUS: Record<string, RouterStage> = {
  draft: 'draft',
  ready: 'ready',
  in_progress: 'building',
  building: 'building',
  verifying: 'verifying',
  fixing: 'fixing',
  done: 'done',
  unverified: 'unverified',
  blocked: 'blocked',
}
const DEFAULT_AGENT = 'worker'
const PASS = 'PASS'
const FAIL = 'FAIL'
export const EVENT = { REPORTED: 'worker_reported', PASSED: 'verify_pass', FAILED: 'verify_fail', FIX_SENT: 'fix_sent' } as const
/** Longest `what` of an eval (plain words, one line) and longest evidence line. */
export const EVAL_CAPS = { WHAT_CHARS: 60, EVIDENCE_CHARS: 120 } as const

export type RouterVerdict = 'PASS' | 'FAIL' | null
/** The proof that a ticket is done: `present` when eval.md exists and is not empty; `what` its first criterion; `result` only `pass` for a CURRENT verifier PASS; `evidence` one line of verdict.md. */
export type RouterEvalResult = 'pass' | 'fail' | 'none'
export type RouterEval = { present: boolean; what: string; result: RouterEvalResult; evidence?: string }
/** The text of the ticket's eval.md and verdict.md, when the reader found them. */
export type TicketFiles = { evalText?: string; verdictText?: string }
export type RouterCheck = { item: string; pass: boolean | null; evidence?: string }
export type RouterDecision = { question: string; chosen: string; basis: string }
export type RouterTicket = {
  id: string
  title: string
  stage: RouterStage
  /** The status as written; set only when it is not one of the contract's. */
  rawStatus?: string
  agent: string
  result: RouterVerdict
  /** The verdict's checks, or none yet. */
  checks: RouterCheck[]
  /** Fix rounds used so far, and the most the router allows. */
  fixRound: number
  maxRounds: number
  /** Evidence of the latest failed fix round, if the verdict says nothing. */
  lastEvidence?: string
  decisions: RouterDecision[]
  dependsOn: string[]
  /** When the ticket last changed (epoch ms; 0 unknown). */
  updatedAt: number
  /** The checklist of eval.md, read only when this is the single ticket and it has no verdict yet. */
  evalItems?: string[]
  /** When the verdict was written (epoch ms; 0 unknown): a fix_sent / worker_reported after it makes a PASS stale. */
  verdictAt: number
  eval: RouterEval
}
export type RouterEvent = { ts: number; type: string; ticket: string; detail: string }
export type RouterCounts = { total: number; verified: number; unproven: number; unverified: number; blocked: number; inflight: number; queued: number }
export type RouterRun = { tickets: RouterTicket[]; events: RouterEvent[]; counts: RouterCounts }

// ---- tolerant field readers ------------------------------------------------------------------------------------------

const clip = (s: string, max: number): string => (s.length > max ? s.slice(0, max) : s)
/** A trimmed, non-empty string (numbers are written out), else undefined. */
export function strOf(v: unknown, max: number = ROUTER_CAPS.TEXT_CHARS): string | undefined {
  const s = typeof v === 'string' ? v.trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : ''
  return s === '' ? undefined : clip(s, max)
}
const listOf = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const wholeOf = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined)

/** A timestamp as epoch ms: ISO text, ms, or seconds; 0 when unknown. */
export function timeOf(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v < ROUTER_CAPS.SECONDS_BELOW ? v * ROUTER_CAPS.MS_PER_SECOND : v
  if (typeof v === 'string') {
    const t = Date.parse(v)
    return Number.isNaN(t) ? 0 : t
  }
  return 0
}

function passOf(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v
  if (typeof v === 'string') {
    const s = v.trim().toUpperCase()
    if (s === PASS || s === 'TRUE') return true
    if (s === FAIL || s === 'FALSE') return false
  }
  return null
}

const verdictOf = (v: unknown): RouterVerdict => {
  const s = typeof v === 'string' ? v.trim().toUpperCase() : ''
  return s === PASS ? PASS : s === FAIL ? FAIL : null
}

function checksOf(v: unknown): RouterCheck[] {
  const out: RouterCheck[] = []
  for (const raw of listOf(v).slice(0, ROUTER_CAPS.CHECKS_PER_TICKET)) {
    const o: Plain = isPlain(raw) ? raw : {}
    const item = strOf(isPlain(raw) ? (o.item ?? o.check ?? o.name ?? o.text) : raw)
    if (item === undefined) continue
    const evidence = strOf(o.evidence)
    out.push({ item, pass: passOf(o.pass), ...(evidence === undefined ? {} : { evidence }) })
  }
  return out
}

const decisionsOf = (v: unknown): RouterDecision[] =>
  listOf(v)
    .slice(0, ROUTER_CAPS.DECISIONS_PER_TICKET)
    .flatMap(raw => {
      if (!isPlain(raw)) return []
      const question = strOf(raw.question)
      const chosen = strOf(raw.chosen)
      return question === undefined && chosen === undefined ? [] : [{ question: question ?? '', chosen: chosen ?? '', basis: strOf(raw.basis) ?? '' }]
    })

/** Fix rounds used: the larger of the entries written and the highest `n` among them. */
function roundsOf(v: unknown): { used: number; evidence?: string } {
  const rounds = listOf(v)
  let used = rounds.length
  let evidence: string | undefined
  for (const r of rounds) {
    if (!isPlain(r)) continue
    used = Math.max(used, wholeOf(r.n) ?? 0)
    evidence = strOf(r.evidence) ?? evidence
  }
  return { used, ...(evidence === undefined ? {} : { evidence }) }
}

// ---- eval.md / verdict.md: the proof of a ticket ------------------------------------------------------------------------

const MARKUP = /(\*\*|__|`|~~)/g
const LINK = /\[([^\]]*)\]\([^)]*\)/g
const LEAD_MARK = /^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)*/
const ELLIPSIS = '…'
const BARE_VERDICT = /^(?:verdict|result|eval|evaluation|checks?)?\s*[:\-–—]?\s*(?:pass|fail)?\s*$/i
const HEADING = /^\s*#{1,6}\s/
const LEAD_IN = /:$/

/** A line as plain words: no markdown marks, links as their text, one space between words. */
const plainLine = (line: string): string => line.replace(LINK, '$1').replace(LEAD_MARK, '').replace(MARKUP, '').replace(/\s+/g, ' ').trim()
const cutAt = (s: string, max: number): string => (s.length <= max ? s : `${s.slice(0, max - ELLIPSIS.length).trimEnd()}${ELLIPSIS}`)

/** What an eval.md checks, in plain words: its first line that is not a heading or a lead-in ("Criteria:"), else its first heading. '' for an empty file. */
export function evalWhatOf(text: string): string {
  const lines = text.split('\n').filter(l => plainLine(l) !== '')
  const pick = lines.find(l => !HEADING.test(l) && !LEAD_IN.test(plainLine(l))) ?? lines.find(l => !HEADING.test(l)) ?? lines[0]
  return pick === undefined ? '' : cutAt(plainLine(pick), EVAL_CAPS.WHAT_CHARS)
}

/** One short line of a verdict.md: its first line that says more than "PASS" / "FAIL" / "Verdict". undefined when there is none. */
export function evidenceOfVerdict(text: string): string | undefined {
  for (const line of text.split('\n')) {
    const plain = plainLine(line)
    if (plain !== '' && !BARE_VERDICT.test(plain)) return cutAt(plain, EVAL_CAPS.EVIDENCE_CHARS)
  }
  return undefined
}

function evalOf(files: TicketFiles | undefined, result: RouterVerdict): RouterEval {
  const what = evalWhatOf(files?.evalText ?? '')
  const evidence = evidenceOfVerdict(files?.verdictText ?? '')
  // `result` is settled by buildRun (it needs the events); here it is only what the file's own verdict says
  return { present: what !== '', what, result: result === PASS ? 'pass' : result === FAIL ? 'fail' : 'none', ...(evidence === undefined ? {} : { evidence }) }
}

/** One ticket.json object as a ticket. `dirName` names it when the file has no id; `files` are its eval.md / verdict.md texts. Never throws. */
export function parseTicket(raw: unknown, dirName: string, files?: TicketFiles): RouterTicket {
  const o: Plain = isPlain(raw) ? raw : {}
  const status = strOf(o.status)?.toLowerCase()
  const known = status === undefined ? undefined : STAGE_OF_STATUS[status]
  const verdict = isPlain(o.verdict) ? o.verdict : {}
  const checks = checksOf(verdict.checks)
  const rounds = roundsOf(o.fix_rounds)
  const id = strOf(o.id, ROUTER_CAPS.ID_CHARS) ?? clip(dirName, ROUTER_CAPS.ID_CHARS)
  const rawStatus = known === undefined && status !== undefined ? strOf(o.status) : undefined
  return {
    id,
    title: strOf(o.title) ?? id,
    stage: known ?? NEUTRAL_STAGE,
    ...(rawStatus === undefined ? {} : { rawStatus }),
    agent: strOf(o.agent) ?? DEFAULT_AGENT,
    result: verdictOf(isPlain(o.verdict) ? verdict.result : o.verdict),
    checks,
    fixRound: rounds.used,
    maxRounds: wholeOf(o.max_rounds) ?? wholeOf(o.maxRounds) ?? ROUTER_CAPS.DEFAULT_MAX_ROUNDS,
    ...(rounds.evidence === undefined ? {} : { lastEvidence: rounds.evidence }),
    decisions: decisionsOf(o.decisions),
    dependsOn: listOf(o.depends_on ?? o.dependsOn).flatMap(d => strOf(d, ROUTER_CAPS.ID_CHARS) ?? []).slice(0, ROUTER_CAPS.DEPENDS_PER_TICKET),
    updatedAt: timeOf(o.updated_at ?? o.updatedAt),
    verdictAt: timeOf(verdict.at),
    eval: evalOf(files, verdictOf(isPlain(o.verdict) ? verdict.result : o.verdict)),
  }
}

/** The events of an events.jsonl text, in file order; a line that is not a JSON object is skipped. */
export function parseEvents(text: string): RouterEvent[] {
  const out: RouterEvent[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const o: unknown = JSON.parse(line)
      if (!isPlain(o)) continue
      const type = strOf(o.type)
      if (type === undefined) continue
      out.push({ ts: timeOf(o.ts), type, ticket: strOf(o.ticket ?? o.ticket_id, ROUTER_CAPS.ID_CHARS) ?? '', detail: strOf(o.detail) ?? '' })
    } catch {
      // a torn last line (the writer is appending) or garbage
    }
  }
  return out
}

const EVAL_LINE = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(\S.*)$/
/** The items of an eval.md checklist: bullet or numbered lines, checkbox marks removed. */
export function parseEvalItems(text: string): string[] {
  const out: string[] = []
  for (const line of text.split('\n')) {
    const item = strOf(EVAL_LINE.exec(line)?.[1])
    if (item !== undefined) out.push(item)
    if (out.length >= ROUTER_CAPS.EVAL_ITEMS) break
  }
  return out
}

// ---- the run ----------------------------------------------------------------------------------------------------------

/** Per ticket: was the latest worker report followed by a verify_pass? (event order, not clock order: the file is append-only) */
function claimsOf(events: readonly RouterEvent[]): Map<string, boolean> {
  const lastReport = new Map<string, number>()
  const lastPass = new Map<string, number>()
  events.forEach((e, i) => {
    if (e.type === EVENT.REPORTED) lastReport.set(e.ticket, i)
    else if (e.type === EVENT.PASSED) lastPass.set(e.ticket, i)
  })
  return new Map([...lastReport].map(([ticket, at]) => [ticket, (lastPass.get(ticket) ?? -1) < at]))
}

const INFLIGHT: readonly RouterStage[] = ['building', 'verifying', 'fixing']
const QUEUED: readonly RouterStage[] = ['ready', 'draft']

/** The stage after the honesty rule: `done` without a verifier PASS (or with a newer unverified report) is `unverified`. */
function honestStage(t: RouterTicket, hasOpenClaim: boolean): RouterStage {
  if (t.stage !== 'done') return t.stage
  return t.result === PASS && !hasOpenClaim ? 'done' : 'unverified'
}

/** The stage an event says (router-kit has no event for every status; a type not listed says nothing about the stage). */
const STAGE_OF_EVENT: Record<string, RouterStage> = {
  dispatched: 'building',
  worker_reported: 'verifying',
  verify_fail: 'fixing',
  fix_sent: 'fixing',
  escalated: 'blocked',
  verify_pass: 'done',
  done: 'done',
}

/** ticket.json may lag events.jsonl: when a ticket's newest stage-bearing event is newer than the file, the event wins; else the file. */
function freshTicket(t: RouterTicket, events: readonly RouterEvent[]): RouterTicket {
  const last = events.findLast(e => e.ticket === t.id && STAGE_OF_EVENT[e.type] !== undefined)
  const stage = last === undefined ? undefined : STAGE_OF_EVENT[last.type]
  if (last === undefined || stage === undefined || last.ts <= t.updatedAt) return t
  return { ...t, stage, ...(last.type === EVENT.PASSED ? { result: PASS } : {}) }
}

/** Events that make an earlier PASS stale: the worker reported again, or a fix was sent. */
const STALES_PASS: readonly string[] = [EVENT.REPORTED, EVENT.FIX_SENT]

/**
 * The eval's result: `pass` only for a CURRENT verifier PASS. With a verify_pass event, current means no stale-making event
 * (or verify_fail) after it, in file order. With only the file's verdict, current means no stale-making event newer than the
 * verdict (an unknown verdict time counts any timed one). `fail`: the verdict or the latest check failed. Else `none`.
 */
export function evalResultOf(t: RouterTicket, events: readonly RouterEvent[]): RouterEvalResult {
  const mine = events.filter(e => e.ticket === t.id)
  const last = (types: readonly string[]): number => mine.findLastIndex(e => types.includes(e.type))
  const lastPass = last([EVENT.PASSED])
  const lastFail = last([EVENT.FAILED])
  const isCurrent =
    lastPass >= 0
      ? lastPass > Math.max(last(STALES_PASS), lastFail)
      : t.result === PASS && !mine.some(e => STALES_PASS.includes(e.type) && e.ts > t.verdictAt)
  if (isCurrent) return 'pass'
  return t.result === FAIL || lastFail > lastPass ? 'fail' : 'none'
}

/** `done` is plainly done only with an eval that is present and passed; else it is `unproven`. */
const provenStage = (t: RouterTicket, stage: RouterStage): RouterStage => (stage === 'done' && !(t.eval.present && t.eval.result === 'pass') ? 'unproven' : stage)

/** The tickets (stages made honest, ordered by id), the newest events and the counts. */
export function buildRun(tickets: readonly RouterTicket[], events: readonly RouterEvent[]): RouterRun {
  const claims = claimsOf(events)
  const honest = tickets.map(raw => {
    const t = freshTicket(raw, events)
    const proved: RouterTicket = { ...t, eval: { ...t.eval, result: evalResultOf(t, events) } }
    return { ...proved, stage: provenStage(proved, honestStage(proved, claims.get(t.id) === true)) }
  })
  const count = (stages: readonly RouterStage[]): number => honest.filter(t => stages.includes(t.stage)).length
  return {
    tickets: honest,
    events: events.slice(-ROUTER_CAPS.EVENTS_TAIL),
    counts: {
      total: honest.length,
      verified: count(['done']),
      unproven: count(['unproven']),
      unverified: count(['unverified']),
      blocked: count(['blocked']),
      inflight: count(INFLIGHT),
      queued: count(QUEUED),
    },
  }
}
