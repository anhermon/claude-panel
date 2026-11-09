// What went WRONG for an agent, said with evidence, for the Struggles tab: a failing loop (the same command or error again and again),
// an edit/test cycle (a file edited over and over while a check keeps failing), a slow call, an idle gap, a wrong turn (a refused call, a
// retry after an error, a rewrite, a revert). Every item carries a quote of the error, when, how many times and whether it is resolved or
// still open. Editing a file many times with NO failure is not a struggle: it is listed apart as "iterating" and never counted.
// Pure and harness-neutral: it reads the neutral entries of ./transcript-parse.ts only (via ./agent-evidence.ts), so a codex run that
// fills the same fields gets the same tab.
import { actOfEntry, baseNameOf, checkKindOf, CHECK_LABEL, commandKeyOf, commandTitleOf, failureQuote, isFailure, isToolEntry, spoken } from './agent-evidence'
import type { CheckKind } from './agent-evidence'
import type { Entry, ToolEntry } from './transcript-parse'
import { clip } from './transcript-redact'

/** A call that took at least this long is a slow call; a gap between two entries at least this long, an idle gap. */
export const SLOW_CALL_MS = 60_000
export const STALL_MS = 120_000
export const STRUGGLE_CAPS = {
  ITEMS: 12,
  CALM: 6,
  /** A file edited this many times counts as "iterating" (and is a cycle when a check fails meanwhile). */
  EDIT_LOOP_MIN: 3,
  /** Failures of one command that make a loop rather than a single failure. */
  LOOP_MIN: 2,
  /** In a cycle the file needs at least this many edits between the failures. */
  CYCLE_EDITS_MIN: 2,
  /** On a live agent, a resolved problem this recent still counts in the tab's badge. */
  RECENT_MS: 15 * 60_000,
  TITLE_CHARS: 110,
} as const

export type StruggleKind = 'failing-loop' | 'edit-test-cycle' | 'slow-call' | 'idle-gap' | 'wrong-turn'
export type StruggleItem = {
  kind: StruggleKind
  title: string
  /** One line of evidence: the error quote, or what the call was. '' when there is none. */
  evidence: string
  t: number
  lastT: number
  n: number
  outcome: 'open' | 'resolved'
  /** A next step, only when the evidence says one ('' otherwise). */
  hint: string
  /** What kind of failure, for the headline ("test failure", "failed command"); '' for slow calls and gaps. */
  noun: string
  recent: boolean
}
export type CalmItem = { title: string; n: number }
export type StruggleReport = { headline: string; badge: number; open: number; resolved: number; items: StruggleItem[]; calm: CalmItem[] }

const KIND_ORDER: Readonly<Record<StruggleKind, number>> = { 'edit-test-cycle': 0, 'failing-loop': 1, 'wrong-turn': 2, 'slow-call': 3, 'idle-gap': 4 }
/** The harness (not the program) said no: its error is wrapped in a tool_use_error and names a block. */
const REFUSED = /^<tool_use_error>[^\n]{0,40}?(?:blocked|denied|not allowed|refused|outside the allowed|permission)/i
const REFUSED_QUOTE = /blocked|denied|not allowed|refused|outside the allowed|permission/i
const isRefused = (e: ToolEntry): boolean => REFUSED.test(`${e.error ?? ''}`) || REFUSED.test(e.out ?? '') || ((e.error ?? '').startsWith('<tool_use_error>') && REFUSED_QUOTE.test((e.error ?? '').slice(0, 80)))
const REVERT = /\bgit\s+(?:checkout|restore|stash|reset)\b/
const GENERIC_NOUN = 'failed command'
const NOUN_OF_CHECK: Readonly<Record<CheckKind, string>> = { tests: 'test failure', types: 'type-check failure', render: 'render failure', lint: 'lint failure', build: 'build failure' }
const EXPECTED_GOT = /expected[:\s]+["'`]?(.+?)["'`]?,?\s+(?:but\s+)?(?:got|received|actual(?:ly)?|was)[:\s]+["'`]?(.+?)["'`]?\s*$/i
const TS_CODE = /error (TS\d+)/i
const MISSING = /no such file|enoent|does not exist|not found|cannot find/i
const STALE_EDIT = /string to replace not found|not unique|did not match|no changes to make/i

/** A next step, only when the quoted evidence names one. */
export function hintOf(quote: string): string {
  const ex = EXPECTED_GOT.exec(quote)
  if (ex !== null) return `The check expects "${ex[1]}" but gets "${ex[2]}"; one of the two is stale.`
  const ts = TS_CODE.exec(quote)
  if (ts !== null) return `Compiler error ${ts[1]}: fix it at the file and line it names.`
  if (STALE_EDIT.test(quote)) return 'The edit text no longer matches the file; it needs a fresh read first.'
  if (REFUSED_QUOTE.test(quote) && /blocked:|refused|outside the allowed|not allowed/i.test(quote)) return 'The harness refused this call; a different approach is needed.'
  if (MISSING.test(quote)) return 'A path or program named in the call does not exist.'
  return ''
}

/** A command in backticks; the descriptions "an inline python3 script" / "a shell command" are words, not commands. */
const commandName = (e: ToolEntry): string => {
  const title = commandTitleOf(e)
  return /^an? (?:inline|shell)\b/.test(title) ? title : `\`${title}\``
}

const describe = (e: ToolEntry): string => {
  const kind = checkKindOf(e)
  if (kind !== null) return `ran ${CHECK_LABEL[kind].toLowerCase()} (${commandTitleOf(e)})`
  return actOfEntry(e) === 'run' ? commandName(e) : `${e.tool} ${e.path !== undefined ? baseNameOf(e.path) : e.label}`.trim()
}

/** A call named for a title: a command in backticks, anything else as tool + target. */
const nameOf = (e: ToolEntry): string => (actOfEntry(e) === 'run' ? commandName(e) : describe(e))

type Group = { key: string; fails: ToolEntry[]; failAt: number[] }

/** Failures grouped by "same command"; singles that quote the same error line are then joined. */
function groupsOf(tools: readonly ToolEntry[]): Group[] {
  const by = new Map<string, Group>()
  tools.forEach((e, i) => {
    if (!isFailure(e) || isRefused(e)) return
    const g = by.get(commandKeyOf(e)) ?? { key: commandKeyOf(e), fails: [], failAt: [] }
    g.fails.push(e)
    g.failAt.push(i)
    by.set(g.key, g)
  })
  const out = [...by.values()]
  const byError = new Map<string, Group[]>()
  for (const g of out.filter(x => x.fails.length === 1)) {
    const q = failureQuote(g.fails[0] as ToolEntry).replace(/\d+/g, '#')
    if (q !== '') byError.set(q, [...(byError.get(q) ?? []), g])
  }
  for (const same of byError.values()) {
    if (same.length < STRUGGLE_CAPS.LOOP_MIN) continue
    const head = same[0] as Group
    for (const g of same.slice(1)) {
      head.fails.push(...g.fails)
      head.failAt.push(...g.failAt)
      out.splice(out.indexOf(g), 1)
    }
  }
  return out
}

const isWrite = (e: ToolEntry): boolean => (actOfEntry(e) === 'edit' || actOfEntry(e) === 'create') && !isFailure(e) && e.path !== undefined

/** The file edited most between index `from` and `to` (inclusive), with its edit count; null when none was edited. */
function busiestFile(tools: readonly ToolEntry[], from: number, to: number): { file: string; n: number } | null {
  const n = new Map<string, number>()
  for (let i = from; i <= to && i < tools.length; i++) {
    const e = tools[i] as ToolEntry
    if (isWrite(e)) n.set(baseNameOf(e.path as string), (n.get(baseNameOf(e.path as string)) ?? 0) + 1)
  }
  const best = [...n].sort((a, b) => b[1] - a[1])[0]
  return best === undefined ? null : { file: best[0], n: best[1] }
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

function problemItems(tools: readonly ToolEntry[], cycleFiles: Set<string>): StruggleItem[] {
  const items: StruggleItem[] = []
  for (const g of groupsOf(tools)) {
    const first = g.fails[0] as ToolEntry
    const last = g.fails[g.fails.length - 1] as ToolEntry
    const lastAt = g.failAt[g.failAt.length - 1] as number
    const check = checkKindOf(first)
    const isResolved = tools.slice(lastAt + 1).some(e => commandKeyOf(e) === g.key && !isFailure(e) && e.error === '')
    const movedOn = check === null && !isResolved && tools.slice(lastAt + 1).some(e => !isFailure(e) && e.error === '')
    const outcome: StruggleItem['outcome'] = isResolved || movedOn ? 'resolved' : 'open'
    const quote = [...g.fails].reverse().map(failureQuote).find(q => q !== '') ?? ''
    const noun = check === null ? GENERIC_NOUN : NOUN_OF_CHECK[check]
    const base = { t: first.t, lastT: last.t, outcome, hint: hintOf(quote), noun, recent: false }
    const evidence = quote === '' ? `exit code ${last.exit ?? 'not 0'}` : quote
    const n = g.fails.length
    const cycle = check !== null && n >= STRUGGLE_CAPS.LOOP_MIN ? cycleOf(tools, g, isResolved) : null
    if (cycle !== null && cycle.n >= STRUGGLE_CAPS.CYCLE_EDITS_MIN) {
      cycleFiles.add(cycle.file)
      items.push({ ...base, kind: 'edit-test-cycle', n, evidence, title: clip(`${cycle.file} edited ${plural(cycle.n, 'time')} while ${nameOf(first)} failed ${plural(n, 'time')}`, STRUGGLE_CAPS.TITLE_CHARS) })
    } else if (n >= STRUGGLE_CAPS.LOOP_MIN) {
      items.push({ ...base, kind: 'failing-loop', n, evidence, title: clip(`${nameOf(first)} failed ${plural(n, 'time')}${isSameError(g.fails) ? ' with the same error' : ''}`, STRUGGLE_CAPS.TITLE_CHARS) })
    } else if (check !== null) {
      items.push({ ...base, kind: 'failing-loop', n, evidence, title: clip(`${CHECK_LABEL[check]} failed: ${nameOf(first)}`, STRUGGLE_CAPS.TITLE_CHARS) })
    } else {
      const retried = isResolved ? ' and passed when run again' : ''
      items.push({ ...base, kind: 'wrong-turn', n, evidence, title: clip(`${describe(first)} failed${retried}`, STRUGGLE_CAPS.TITLE_CHARS) })
    }
  }
  return items
}

const isSameError = (fails: readonly ToolEntry[]): boolean => new Set(fails.map(f => failureQuote(f).replace(/\d+/g, '#'))).size === 1

/** The file edited most in the stretch of a failing check: from the run before its first failure to the pass after its last (or the end). */
function cycleOf(tools: readonly ToolEntry[], g: Group, isResolved: boolean): { file: string; n: number } | null {
  const firstAt = g.failAt[0] as number
  const lastAt = g.failAt[g.failAt.length - 1] as number
  let from = 0
  for (let i = firstAt - 1; i >= 0; i--) if (commandKeyOf(tools[i] as ToolEntry) === g.key) { from = i; break }
  let to = tools.length - 1
  if (isResolved) for (let i = lastAt + 1; i < tools.length; i++) if (commandKeyOf(tools[i] as ToolEntry) === g.key) { to = i; break }
  return busiestFile(tools, from, to)
}

function refusedItems(tools: readonly ToolEntry[]): StruggleItem[] {
  const items: StruggleItem[] = []
  tools.forEach((e, i) => {
    if (!isFailure(e) || !isRefused(e)) return
    const quote = failureQuote(e)
    const later = tools.slice(i + 1).some(x => !isFailure(x) && x.error === '')
    items.push({ kind: 'wrong-turn', title: clip(`${describe(e)} was refused`, STRUGGLE_CAPS.TITLE_CHARS), evidence: quote, t: e.t, lastT: e.t, n: 1, outcome: later ? 'resolved' : 'open', hint: hintOf(quote), noun: 'refused call', recent: false })
  })
  return items
}

/** A file rewritten whole after small edits, and a command that threw work away (git checkout / restore / stash / reset). */
function rewriteItems(tools: readonly ToolEntry[]): StruggleItem[] {
  const items: StruggleItem[] = []
  const edits = new Map<string, number>()
  for (const e of tools) {
    if (!isWrite(e)) {
      if (actOfEntry(e) === 'run' && !isFailure(e) && REVERT.test(e.cmd ?? '') && edits.size > 0)
        items.push({ kind: 'wrong-turn', title: 'Threw earlier changes away', evidence: clip(commandTitleOf(e), STRUGGLE_CAPS.TITLE_CHARS), t: e.t, lastT: e.t, n: 1, outcome: 'resolved', hint: '', noun: 'wrong turn', recent: false })
      continue
    }
    const name = baseNameOf(e.path as string)
    if (actOfEntry(e) === 'create' && (edits.get(name) ?? 0) >= STRUGGLE_CAPS.CYCLE_EDITS_MIN)
      items.push({ kind: 'wrong-turn', title: `${name} rewritten whole after ${plural(edits.get(name) ?? 0, 'small edit')}`, evidence: clip(e.label, STRUGGLE_CAPS.TITLE_CHARS), t: e.t, lastT: e.t, n: 1, outcome: 'resolved', hint: '', noun: 'wrong turn', recent: false })
    edits.set(name, (edits.get(name) ?? 0) + 1)
  }
  return items
}

/** Calls that only look or write locally never take a minute: their long "duration" is a batch result that arrived late. */
const LOCAL_ACTS: readonly string[] = ['read', 'edit', 'create']

/**
 * Slow calls. Calls started while another was still running (a parallel batch) share one wait: they are ONE item, named after the
 * longest member that does real work, with the count of the others.
 */
function slowItems(tools: readonly ToolEntry[], now: number, isRunning: boolean): StruggleItem[] {
  const items: StruggleItem[] = []
  const batches: ToolEntry[][] = []
  let end = -Infinity
  tools.forEach((e, i) => {
    const ms = e.ms ?? (isRunning && i === tools.length - 1 ? now - e.t : 0)
    const batch = batches[batches.length - 1]
    if (batch !== undefined && e.t < end) {
      batch.push(e)
      end = Math.max(end, e.t + ms)
    } else {
      batches.push([e])
      end = e.t + ms
    }
  })
  for (const batch of batches) {
    const timed = batch.map(e => ({ e, ms: e.ms ?? (isRunning && e === tools[tools.length - 1] ? now - e.t : 0) }))
    const first = batch[0] as ToolEntry
    const span = Math.max(...timed.map(x => x.e.t + x.ms)) - first.t
    if (span < SLOW_CALL_MS) continue
    const real = timed.filter(x => !LOCAL_ACTS.includes(actOfEntry(x.e))).sort((a, b) => b.ms - a.ms)[0]
    if (real === undefined) continue
    const waiting = real.e.ms === null
    const checkKind = checkKindOf(real.e)
    const what = actOfEntry(real.e) === 'delegate' ? `a sub-agent (${real.e.label})` : checkKind !== null ? CHECK_LABEL[checkKind].toLowerCase() : describe(real.e)
    const more = batch.length > 1 ? ` (${plural(batch.length - 1, 'other call')} ran with it)` : ''
    items.push({ kind: 'slow-call', title: clip(`${waiting ? 'Still waiting on' : 'Waited on'} ${what}${more}: ${spoken(real.ms)}`, STRUGGLE_CAPS.TITLE_CHARS), evidence: clip(real.e.cmd ?? real.e.label, STRUGGLE_CAPS.TITLE_CHARS), t: real.e.t, lastT: real.e.t + real.ms, n: 1, outcome: waiting ? 'open' : 'resolved', hint: '', noun: '', recent: false })
  }
  return items
}

function gapItems(entries: readonly Entry[], now: number, isRunning: boolean): StruggleItem[] {
  const items: StruggleItem[] = []
  const used = (e: Entry): number => (isToolEntry(e) ? (e.ms ?? 0) : 0)
  const said = (e: Entry): string => (isToolEntry(e) ? describe(e) : `said "${clip(e.text, 50)}"`)
  for (let i = 1; i < entries.length; i++) {
    const prev = entries[i - 1] as Entry
    const gap = (entries[i] as Entry).t - prev.t - used(prev)
    if (gap >= STALL_MS) items.push({ kind: 'idle-gap', title: `No activity for ${spoken(gap)}`, evidence: `after: ${said(prev)}`, t: prev.t + used(prev), lastT: (entries[i] as Entry).t, n: 1, outcome: 'resolved', hint: '', noun: '', recent: false })
  }
  const last = entries[entries.length - 1]
  if (isRunning && last !== undefined) {
    const tail = now - last.t - used(last)
    if (tail >= STALL_MS && !(isToolEntry(last) && last.ms === null)) items.push({ kind: 'idle-gap', title: `No activity for ${spoken(tail)} so far`, evidence: `last: ${said(last)}`, t: last.t + used(last), lastT: now, n: 1, outcome: 'open', hint: '', noun: '', recent: false })
  }
  return items
}

function calmItems(tools: readonly ToolEntry[], cycleFiles: ReadonlySet<string>): CalmItem[] {
  const n = new Map<string, number>()
  for (const e of tools) if (isWrite(e)) n.set(baseNameOf(e.path as string), (n.get(baseNameOf(e.path as string)) ?? 0) + 1)
  return [...n]
    .filter(([file, count]) => count >= STRUGGLE_CAPS.EDIT_LOOP_MIN && !cycleFiles.has(file))
    .sort((a, b) => b[1] - a[1])
    .slice(0, STRUGGLE_CAPS.CALM)
    .map(([file, count]) => ({ title: `Iterating on ${file} (${plural(count, 'edit')}, no failures)`, n: count }))
}

/** "1 test failure still open, 2 resolved; 3 slow calls": the whole tab in one sentence. */
export function headlineOf(items: readonly StruggleItem[], calls: number): string {
  const problems = items.filter(i => i.noun !== '')
  const open = problems.filter(i => i.outcome === 'open').length
  const resolved = problems.length - open
  const nouns = new Set(problems.map(i => i.noun))
  const noun = nouns.size === 1 ? [...nouns][0] as string : 'failure'
  const parts: string[] = []
  if (open > 0) parts.push(`${plural(open, noun)} still open${resolved > 0 ? `, ${resolved} resolved` : ''}`)
  else if (resolved > 0) parts.push(`${plural(resolved, noun)} resolved`)
  const slow = items.filter(i => i.kind === 'slow-call').length
  const idle = items.filter(i => i.kind === 'idle-gap').length
  if (slow > 0) parts.push(plural(slow, 'slow call'))
  if (idle > 0) parts.push(plural(idle, 'idle gap'))
  return parts.length === 0 ? `No failures in ${plural(calls, 'tool call')}.` : parts.join('; ')
}

/** The Struggles report of a run: its entries (oldest first), the clock, and whether the agent is still running. */
export function struggleReportOf(entries: readonly Entry[], opts: { now: number; isRunning: boolean }): StruggleReport {
  const tools = entries.filter(isToolEntry)
  const cycleFiles = new Set<string>()
  const ref = opts.isRunning ? opts.now : (entries[entries.length - 1]?.t ?? opts.now)
  const all = [...problemItems(tools, cycleFiles), ...refusedItems(tools), ...rewriteItems(tools), ...slowItems(tools, opts.now, opts.isRunning), ...gapItems(entries, opts.now, opts.isRunning)]
    .map(i => ({ ...i, recent: opts.isRunning && ref - i.lastT <= STRUGGLE_CAPS.RECENT_MS }))
    .sort((a, b) => Number(b.outcome === 'open') - Number(a.outcome === 'open') || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || b.lastT - a.lastT)
    .slice(0, STRUGGLE_CAPS.ITEMS)
  const open = all.filter(i => i.outcome === 'open').length
  return {
    headline: headlineOf(all, tools.length),
    badge: all.filter(i => i.outcome === 'open' || i.recent).length,
    open,
    resolved: all.length - open,
    items: all,
    calm: calmItems(tools, cycleFiles),
  }
}
