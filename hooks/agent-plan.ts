// The checklist of the Progress tab. Two sources, nothing invented: the lane the agent POSTED (its own dod, shown as posted), or the
// numbered and bulleted items of its BRIEF, each marked done only on evidence (a file the item names was written or edited; a command
// the item names ran and exited 0), "doing" only when one of the last calls touched what it names, everything else "not shown yet".
// Also reads what the brief forbids ("do not touch x.js"), so an edit to such a file can be told as a deviation. Pure and harness-neutral.
import { actOfEntry, baseNameOf, checkKindOf, commandKeyOf, commandTitleOf, failureQuote, isFailure, isToolEntry } from './agent-evidence'
import type { Entry, ToolEntry } from './transcript-parse'
import { clip } from './transcript-redact'

export const PLAN_CAPS = {
  ITEMS: 8,
  TEXT_CHARS: 150,
  /** The last calls that may make an item "doing". */
  RECENT_CALLS: 8,
  /** File tokens an item names that are checked (more than this are ignored). */
  FILE_TOKENS: 4,
  /** File tokens read from the forbidding sentences of a brief. */
  FORBIDDEN: 16,
} as const

export type LaneDod = { t: string; state: 'todo' | 'doing' | 'done' | 'failed' }
export type LaneInfo = { step: string; note: string; goal: string; dod: LaneDod[]; at: number | null }
export type PlanItem = { text: string; state: 'todo' | 'doing' | 'done' | 'failed'; evidence: string }
export type Plan = { source: 'lane' | 'brief' | 'none'; label: string; items: PlanItem[] }

export const PLAN_LABEL = { lane: "posted by the agent", brief: "from the agent's brief; marks are evidence-based", none: '' } as const

const ITEM_LINE = /^\s*(?:\(?\d{1,2}[.)]|[-*•])\s+(.+)$/
const HEADER_LINE = /^\s*(?:#{1,4}\s*)?\*{0,2}([A-Z][A-Z0-9 /&-]{2,})\b/
/** Sections that are not tasks. */
const LABEL_LINE = /^\*{0,2}([A-Z][A-Z0-9 /&-]{2,}):\*{0,2}\s+\S/
const NOT_TASKS = /^(?:FILES|FIXTURES?|CONCURRENCY|HARD|RULES|CONTEXT|USER|BACKGROUND|NOTES?|CONSTRAINTS?|REPO|READ)\b/
const FILE_TOKEN_SOURCE = String.raw`[\w@./*-]*[\w*]\.(?:tsx?|jsx?|mjs|cjs|css|json|md|html|py|ya?ml|\*)(?![\w])`
const FILE_TOKEN = new RegExp(FILE_TOKEN_SOURCE, 'g')
const HAS_FILE_TOKEN = new RegExp(FILE_TOKEN_SOURCE)
const DIR_TOKEN = /\b(?:hooks|web|tests|scripts|src|skills|types|lib|app)\/[\w./*-]+/g
const BACKTICKED = /`([^`]{3,80})`/g
const KNOWN_COMMANDS: readonly RegExp[] = [/\btsc\b/, /\bnode --test\b/, /\bclaude plugin test\b/, /\bnpm (?:run )?test\b/, /\bpytest\b/]
const MARKDOWN = /\*\*|__|`|^#+\s*/g
const FORBID = /\b(?:do not|don't|dont|never|must not)\s+(?:touch|edit|modify|change|rewrite)\b([^\n]*)/gi
const POINTS_BACK = /\b(?:those|them|these)\b/i
const SENTENCE_SPLIT = /(?<=[.;])\s+|\n/

export const plainOf = (text: string): string => text.replace(MARKDOWN, '').replace(/\s+/g, ' ').trim()

type Item = { text: string; full: string }

/** The numbered / bulleted items of a brief, in order (continuation lines joined), items of sections that are not tasks left out; at most PLAN_CAPS.ITEMS. */
export function briefItemsOf(brief: string): Item[] {
  const items: Item[] = []
  let skip = false
  let open: Item | null = null
  for (const raw of brief.split('\n')) {
    const item = ITEM_LINE.exec(raw)
    if (item !== null) {
      open = skip ? null : { text: '', full: item[1] as string }
      if (open !== null) items.push(open)
      continue
    }
    if (raw.trim() === '') { open = null; continue }
    const head = HEADER_LINE.exec(raw)
    if (head !== null && !/^\s/.test(raw)) { skip = NOT_TASKS.test(head[1] as string); open = null; continue }
    if (open !== null && /^\s/.test(raw)) open.full += ` ${raw.trim()}`
  }
  if (items.length === 0) {
    // No list: the "LABEL: text" lines of the task sections (a brief written as METRICS: ... / STRUGGLES: ...).
    skip = false
    for (const raw of brief.split('\n')) {
      const head = LABEL_LINE.exec(raw)
      if (head === null) continue
      skip = NOT_TASKS.test(head[1] as string)
      if (!skip) items.push({ text: '', full: raw.trim() })
    }
  }
  return items.slice(0, PLAN_CAPS.ITEMS).map(i => ({ full: plainOf(i.full), text: clip(plainOf(i.full), PLAN_CAPS.TEXT_CHARS) }))
}

const globOf = (token: string): RegExp => new RegExp(`^${token.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`)
/** Does a file the agent touched (its path) match a token of the brief (a name, a relative path, a glob)? */
export function matchesFile(path: string, token: string): boolean {
  const t = token.replace(/^\.?\//, '')
  if (t.includes('*')) return globOf(t).test(baseNameOf(path)) || globOf(t).test(path.split('/').slice(-t.split('/').length).join('/'))
  return t.includes('/') ? path.endsWith(`/${t}`) || path === t : baseNameOf(path) === t
}

const fileTokensOf = (text: string, max: number = PLAN_CAPS.FILE_TOKENS): string[] => [...new Set(text.match(FILE_TOKEN) ?? [])].slice(0, max)
function commandTokensOf(text: string): string[] {
  const found = [...text.matchAll(BACKTICKED)].map(m => (m[1] as string).trim()).filter(c => /\s/.test(c) && !HAS_FILE_TOKEN.test(c) && KNOWN_COMMANDS.some(k => k.test(c)))
  for (const k of KNOWN_COMMANDS) {
    const m = k.exec(text)
    if (m !== null && !found.some(f => f.includes(m[0]))) found.push(m[0])
  }
  return found
}

const isWriteCall = (e: ToolEntry): boolean => (actOfEntry(e) === 'edit' || actOfEntry(e) === 'create') && !isFailure(e) && e.path !== undefined

/** Mark the items of a brief against the evidence (the tool calls so far, oldest first). */
export function markItems(items: readonly Item[], tools: readonly ToolEntry[]): PlanItem[] {
  const recent = tools.slice(-PLAN_CAPS.RECENT_CALLS)
  const out: PlanItem[] = items.map(item => {
    const files = fileTokensOf(item.full)
    const commands = commandTokensOf(item.full)
    if (files.length === 0 && commands.length === 0) {
      // A folder named without any file: only a sign of work in it (never "done").
      const dirs = (item.full.match(DIR_TOKEN) ?? []).map(d => d.replace(/[.,;:)]+$/, '').replace(/\/$/, ''))
      const inDir = recent.find(e => e.path !== undefined && dirs.some(d => e.path?.includes(`/${d}/`)))
      return { text: item.text, state: inDir === undefined ? 'todo' : 'doing', evidence: inDir === undefined ? '' : `${actOfEntry(inDir) === 'read' ? 'reading' : 'editing'} ${baseNameOf(inDir.path as string)}` }
    }
    const fileHits = files.map(f => tools.find(e => isWriteCall(e) && matchesFile(e.path as string, f)))
    const runs = commands.map(c => tools.filter(e => actOfEntry(e) === 'run' && (e.cmd ?? e.label).includes(c)))
    const passed = runs.map(r => r.filter(e => !isFailure(e) && e.error === '').pop())
    const isDone = fileHits.every(h => h !== undefined) && passed.every(p => p !== undefined)
    if (isDone) {
      const parts = [...fileHits.map((h, i) => `edited ${files[i]}`), ...passed.map((p, i) => `ran ${commandTitleOf(p as ToolEntry)}`)]
      return { text: item.text, state: 'done', evidence: parts.join(', ') }
    }
    const failedRun = runs.map(r => r[r.length - 1]).find(e => e !== undefined && isFailure(e))
    if (failedRun !== undefined && passed.every(p => p === undefined)) return { text: item.text, state: 'failed', evidence: `${commandTitleOf(failedRun)} failed: ${failureQuote(failedRun)}` }
    const touch = recent.find(e => (e.path !== undefined && files.some(f => matchesFile(e.path as string, f))) || commands.some(c => (e.cmd ?? '').includes(c)))
    return { text: item.text, state: touch === undefined ? 'todo' : 'doing', evidence: touch === undefined ? '' : `${actOfEntry(touch) === 'run' ? 'running' : actOfEntry(touch) === 'read' ? 'reading' : 'editing'} ${touch.path !== undefined ? baseNameOf(touch.path) : commandTitleOf(touch)}` }
  })
  // One item in progress at most: the first.
  let seen = false
  return out.map(i => (i.state === 'doing' ? (seen ? { ...i, state: 'todo', evidence: '' } : ((seen = true), i)) : i))
}

/** The plan: the posted lane's dod when it has one, else the brief's items marked against the evidence, else nothing. */
export function planOf(args: { lane: LaneInfo | undefined; brief: string; entries: readonly Entry[] }): Plan {
  const { lane } = args
  if (lane !== undefined && lane.dod.length > 0)
    return {
      source: 'lane',
      label: PLAN_LABEL.lane,
      items: lane.dod.slice(0, PLAN_CAPS.ITEMS).map((d, i) => ({ text: clip(plainOf(d.t), PLAN_CAPS.TEXT_CHARS), state: d.state === 'todo' && i === lane.at ? 'doing' : d.state, evidence: '' })),
    }
  const items = briefItemsOf(args.brief)
  if (items.length === 0) return { source: 'none', label: '', items: [] }
  return { source: 'brief', label: PLAN_LABEL.brief, items: markItems(items, args.entries.filter(isToolEntry)) }
}

/** The files / globs a brief says not to touch ("Do not touch avatar-*.js, mascot-grid.*"; "Do not touch those" points at the sentence before). */
export function forbiddenOf(brief: string): string[] {
  const sentences = brief.split(SENTENCE_SPLIT)
  const out = new Set<string>()
  sentences.forEach((s, i) => {
    FORBID.lastIndex = 0
    const m = FORBID.exec(s)
    if (m === null) return
    for (const t of fileTokensOf(m[1] as string, PLAN_CAPS.FORBIDDEN)) out.add(t)
    if (!POINTS_BACK.test(m[1] as string)) return
    // "... (another worker edits a.css, b.js - do NOT edit those": the files just before, in the same clause; else the sentence before.
    const lead = s.slice(0, m.index)
    const before = fileTokensOf(lead.slice(lead.lastIndexOf('(') + 1), PLAN_CAPS.FORBIDDEN)
    for (const t of before.length > 0 ? before : fileTokensOf(sentences[i - 1] ?? '', PLAN_CAPS.FORBIDDEN)) out.add(t)
  })
  return [...out]
}
