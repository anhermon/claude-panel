// The PROGRESS of one agent for the first tab of the drill-down: what it does now, its checklist, what is done (evidence), what it
// decided (its own words), and what is wrong or needs a person. Everything is read from the neutral entries (./transcript-parse.ts),
// the lane the agent posted (dod/step/note) and the clock; a thing the data does not show is absent or says "not shown", never invented.
// Pure and harness-neutral: no `$`, no I/O, no tool names (./agent-evidence.ts maps a call to what it does).
import { actOfEntry, baseNameOf, checkKindOf, CHECK_LABEL, commandKeyOf, checkResultOf, commandTitleOf, isFailure, isReadOnlyCommand, isToolEntry, spoken } from './agent-evidence'
import type { CheckKind } from './agent-evidence'
import { forbiddenOf, matchesFile, plainOf, planOf } from './agent-plan'
import type { LaneInfo, Plan } from './agent-plan'
import { STALL_MS, SLOW_CALL_MS, struggleReportOf } from './agent-struggles'
import type { StruggleReport } from './agent-struggles'
import type { Entry, SayEntry, ToolEntry } from './transcript-parse'
import { clip } from './transcript-redact'

export const PROGRESS_CAPS = {
  NOW_CHARS: 200,
  DECISIONS: 5,
  DECISION_CHARS: 170,
  FOLDERS: 8,
  NAMES: 6,
  CHECKS: 6,
  IMAGES: 6,
  ISSUES: 10,
  MIN_WORDS: 3,
  /** A phase shorter than this joins the one before it. */
  MIN_PHASE_MS: 5000,
  /** Phases kept (the shortest join their neighbour first). */
  PHASES: 14,
} as const

export type { LaneInfo, Plan }
export type NowInfo = {
  /** The newest sentence the agent said, cleaned; '' when it said nothing yet. */
  say: string
  sayT: number | null
  /** The call in flight ("running node --test"), null when none. */
  call: { text: string; runningMs: number } | null
  /** One plain sentence on the pace: silence, a long wait, or the end; '' when the agent is simply working. */
  pace: string
  /** The lane's own words, when it posted any. */
  laneStep: string
  laneNote: string
}
export type FolderDone = { dir: string; created: number; edited: number; names: { name: string; n: number }[] }
export type CheckLine = { label: string; cmd: string; outcome: 'pass' | 'fail' | 'running'; result: string; t: number; runs: number }
export type DoneInfo = { files: number; folders: FolderDone[]; checks: CheckLine[]; images: string[]; imageCount: number }
export type Decision = { t: number; quote: string }
export type IssueLine = { kind: 'failure' | 'question' | 'deviation' | 'wait'; title: string; evidence: string; t: number; outcome: 'open' | 'resolved' }
export type IssuesInfo = { openCount: number; summary: string; list: IssueLine[] }
export type PhaseKind = 'read' | 'edit' | 'tests' | 'run' | 'delegate' | 'ask' | 'other'
/** A stretch of the run spent on one kind of work: "read files", "edit crew-view.js", "tests", over its real time. */
export type Phase = { label: string; kind: PhaseKind; a: number; b: number; ms: number; n: number; failed: boolean; isCurrent: boolean }
export type AgentProgress = { now: NowInfo; plan: Plan; phases: Phase[]; phaseNote: string; done: DoneInfo; decisions: Decision[]; issues: IssuesInfo }

const MARKDOWN_LINK = /\[([^\]]+)\]\([^)]*\)/g
const MARKDOWN_NOISE = /\*\*|__|`|^\s*#+\s*|^\s*[-*•]\s+/g
const SENTENCE_END = /(?<=[.!?])\s+(?=[A-Z0-9"'(\[])/
const ELLIPSIS = '…'
const DECISION_REASON = /\b(?:failed|fails|doesn't|does not|won't|can't|cannot|needs?|wasteful|instead|but|not work|no longer)\b/i
const DECISION_SHORT = /\b(?:use|using|proceed with|go with|fall back|switch)\b/i
const SHORT_WORDS = 14
const DECISION =
  /\b(?:i'll use|i will use|i'll go with|going with|decided|decide to|chose|chosen|instead of|rather than|the fix is|the root cause is|switch(?:ing|ed)? to|so i'll|because|i'll (?:keep|skip|drop|avoid))\b/i
const IMAGE_FILE = /\.(?:png|jpe?g|gif|webp)$/i

/** A sentence cleaned of markdown noise. */
/** The start of the next numbered item that the excerpt cut off ("... Struggles. 2."). */
const DANGLING_NUMBER = /\s+\d{1,2}[.)]$/
export const cleanSentence = (s: string): string => plainOf(s.replace(MARKDOWN_LINK, '$1').replace(MARKDOWN_NOISE, '')).replace(DANGLING_NUMBER, '')

/** The sentences of a text, cleaned; a last one cut off by the excerpt (ending in an ellipsis) is dropped when others exist. */
export function sentencesOf(text: string): string[] {
  const all = text.split(SENTENCE_END).map(cleanSentence).filter(s => s.split(' ').length >= PROGRESS_CAPS.MIN_WORDS)
  return all.length > 1 && (all[all.length - 1] as string).endsWith(ELLIPSIS) ? all.slice(0, -1) : all
}

/** Cut at a word boundary (never inside a word or a path), with an ellipsis. */
function shorten(s: string, max: number): string {
  if (s.length <= max) return s
  const cut = s.slice(0, max)
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), 1)).trimEnd()}${ELLIPSIS}`
}

const isSay = (e: Entry): e is SayEntry => e.kind === 'say'
const callText = (e: ToolEntry): string => {
  const act = actOfEntry(e)
  const target = e.path !== undefined ? baseNameOf(e.path) : act === 'run' ? commandTitleOf(e) : e.label
  const verb = { read: 'reading', search: 'searching', create: 'writing', edit: 'editing', run: 'running', delegate: 'waiting for a sub-agent:', ask: 'asking:', other: e.tool }[act]
  return `${verb} ${target}`.trim()
}
const lastDone = (e: ToolEntry): string => callText(e).replace(/^(reading|searching|writing|editing|running)/, m => ({ reading: 'read', searching: 'searched', writing: 'wrote', editing: 'edited', running: 'ran' })[m] as string)

export function nowOf(entries: readonly Entry[], lane: LaneInfo | undefined, args: { state: string; endedAt: number | null; now: number }): NowInfo {
  const { now } = args
  const said = [...entries].reverse().find(isSay)
  const sentences = said === undefined ? [] : sentencesOf(said.text)
  const last = entries[entries.length - 1]
  const isRunning = args.state !== 'done' && args.endedAt === null
  const tail = last !== undefined && isToolEntry(last) && last.ms === null ? last : undefined
  const call = isRunning && tail !== undefined ? { text: callText(tail), runningMs: Math.max(0, now - tail.t) } : null
  let pace = ''
  if (!isRunning) pace = last === undefined ? '' : `Finished ${spoken(Math.max(0, now - (args.endedAt ?? last.t)))} ago.`
  else if (call !== null && call.runningMs >= SLOW_CALL_MS) pace = `Waiting ${spoken(call.runningMs)} on this call.`
  else if (call === null && last !== undefined && now - last.t >= STALL_MS)
    pace = `No activity for ${spoken(now - last.t)}, last: ${isToolEntry(last) ? lastDone(last) : `said "${shorten(cleanSentence(last.text), 50)}"`}.`
  return {
    say: shorten(sentences[sentences.length - 1] ?? '', PROGRESS_CAPS.NOW_CHARS),
    sayT: said?.t ?? null,
    call,
    pace,
    laneStep: lane?.step ?? '',
    laneNote: lane?.note ?? '',
  }
}

/** The common leading folders of all paths, to strip from the labels. */
function commonDir(paths: readonly string[]): string[] {
  const dirs = paths.map(p => p.split('/').slice(0, -1))
  const first = dirs[0] ?? []
  let n = first.length
  for (const d of dirs) while (n > 0 && d.slice(0, n).join('/') !== first.slice(0, n).join('/')) n--
  return first.slice(0, n)
}

const isWrite = (e: ToolEntry): boolean => (actOfEntry(e) === 'edit' || actOfEntry(e) === 'create') && !isFailure(e) && e.path !== undefined

export function doneOf(tools: readonly ToolEntry[]): DoneInfo {
  const writes = tools.filter(isWrite)
  const paths = [...new Set(writes.map(e => e.path as string))]
  const common = commonDir(paths)
  const byDir = new Map<string, FolderDone>()
  const seen = new Set<string>()
  for (const e of writes) {
    const path = e.path as string
    const rel = path.split('/').slice(common.length, -1).join('/')
    const dir = rel === '' ? (common[common.length - 1] ?? '.') : rel
    const f = byDir.get(dir) ?? { dir, created: 0, edited: 0, names: [] }
    const isNew = actOfEntry(e) === 'create' && !seen.has(path)
    if (isNew) f.created++
    else f.edited++
    seen.add(path)
    const name = f.names.find(n => n.name === baseNameOf(path))
    if (name === undefined) f.names.push({ name: baseNameOf(path), n: 1 })
    else name.n++
    byDir.set(dir, f)
  }
  const folders = [...byDir.values()]
    .sort((a, b) => b.created + b.edited - (a.created + a.edited))
    .slice(0, PROGRESS_CAPS.FOLDERS)
    .map(f => ({ ...f, names: f.names.sort((a, b) => b.n - a.n).slice(0, PROGRESS_CAPS.NAMES) }))
  const images = [...new Set(tools.filter(e => actOfEntry(e) === 'read' && e.path !== undefined && IMAGE_FILE.test(e.path) && !isFailure(e)).map(e => baseNameOf(e.path as string)))]
  return { files: paths.length, folders, checks: checksOf(tools), images: images.slice(-PROGRESS_CAPS.IMAGES), imageCount: images.length }
}

/** The LAST result of each check command (types, tests, render...), with when and how many times it ran. */
export function checksOf(tools: readonly ToolEntry[]): CheckLine[] {
  const by = new Map<string, CheckLine>()
  for (const e of tools) {
    const kind: CheckKind | null = checkKindOf(e)
    if (kind === null) continue
    const key = commandKeyOf(e)
    const res = checkResultOf(e, kind)
    const prev = by.get(key)
    by.set(key, {
      label: CHECK_LABEL[kind],
      cmd: commandTitleOf(e),
      outcome: res === null ? 'running' : res.outcome,
      result: res?.text ?? 'running now',
      t: e.t,
      runs: (prev?.runs ?? 0) + 1,
    })
  }
  return [...by.values()].sort((a, b) => b.t - a.t).slice(0, PROGRESS_CAPS.CHECKS)
}

type Raw = { key: string; kind: PhaseKind; files: Set<string>; label: string; a: number; b: number; n: number; failed: boolean }

function rawPhaseOf(e: ToolEntry): Pick<Raw, 'key' | 'kind' | 'label'> {
  const act = actOfEntry(e)
  const check = checkKindOf(e)
  if (act === 'read' || act === 'search' || isReadOnlyCommand(e)) return { key: 'read', kind: 'read', label: 'read files' }
  if (act === 'edit' || act === 'create') return { key: 'edit', kind: 'edit', label: 'edit' }
  if (act === 'run' && check !== null) return { key: check, kind: 'tests', label: CHECK_LABEL[check].toLowerCase() }
  if (act === 'run') return { key: 'run', kind: 'run', label: 'run commands' }
  if (act === 'delegate') return { key: 'delegate', kind: 'delegate', label: 'wait for a sub-agent' }
  if (act === 'ask') return { key: 'ask', kind: 'ask', label: 'ask a question' }
  return { key: e.tool, kind: 'other', label: e.tool }
}

/**
 * The run as labelled stretches over its real time: consecutive calls of one kind of work make one phase ("read files", "edit x.js",
 * "tests"); the time before a call (the model thinking up that call) belongs to the call's phase, the end of the last phase is the
 * last call's end (or now while it runs). Phases under MIN_PHASE_MS join the one before; above PHASES the shortest join first.
 */
export function phasesOf(tools: readonly ToolEntry[], args: { from: number; now: number; isRunning: boolean }): Phase[] {
  const raws: Raw[] = []
  let cursor = args.from
  for (const e of tools) {
    const r = rawPhaseOf(e)
    const end = Math.max(e.t + (e.ms ?? 0), cursor)
    const prev = raws[raws.length - 1]
    // A call that names no kind of work (a progress ping, a monitor) is part of whatever came before it.
    if (r.kind === 'other') {
      if (prev !== undefined) prev.b = end
      cursor = end
      continue
    }
    if (prev !== undefined && prev.key === r.key) {
      prev.b = end
      prev.n++
      prev.failed ||= isFailure(e)
      if (e.path !== undefined) prev.files.add(baseNameOf(e.path))
    } else raws.push({ ...r, files: new Set(e.path !== undefined ? [baseNameOf(e.path)] : []), a: cursor, b: end, n: 1, failed: isFailure(e) })
    cursor = end
  }
  const last = raws[raws.length - 1]
  if (last !== undefined && args.isRunning) last.b = Math.max(last.b, args.now)
  const join = (i: number): void => {
    const into = raws[i - 1] as Raw
    const gone = raws[i] as Raw
    into.b = gone.b
    into.n += gone.n
    into.failed ||= gone.failed
    gone.files.forEach(f => into.files.add(f))
    raws.splice(i, 1)
    if (raws[i] !== undefined && (raws[i] as Raw).key === into.key) join(i)
  }
  const [head, second] = raws
  if (head !== undefined && second !== undefined && head.b - head.a < PROGRESS_CAPS.MIN_PHASE_MS) {
    second.a = head.a
    second.n += head.n
    raws.shift()
  }
  for (let i = raws.length - 1; i >= 1; i--) if ((raws[i] as Raw).b - (raws[i] as Raw).a < PROGRESS_CAPS.MIN_PHASE_MS && i < raws.length) join(i)
  while (raws.length > PROGRESS_CAPS.PHASES) {
    let at = 1
    raws.forEach((r, i) => { if (i >= 1 && r.b - r.a < (raws[at] as Raw).b - (raws[at] as Raw).a) at = i })
    join(at)
  }
  return raws.map((r, i) => ({
    label: r.kind === 'edit' ? (r.files.size === 1 ? `edit ${[...r.files][0]}` : `edit ${r.files.size} files`) : r.label,
    kind: r.kind,
    a: r.a,
    b: r.b,
    ms: Math.max(0, r.b - r.a),
    n: r.n,
    failed: r.failed,
    isCurrent: args.isRunning && i === raws.length - 1,
  }))
}

/** "Sed failed on macOS; use Edit.": a short sentence that gives a reason and a way forward. */
const isShortDecision = (s: string): boolean => s.split(' ').length <= SHORT_WORDS && DECISION_SHORT.test(s) && DECISION_REASON.test(s)

/** Sentences in the agent's own words that state a choice, newest first. */
export function decisionsOf(entries: readonly Entry[]): Decision[] {
  const out: Decision[] = []
  const seen = new Set<string>()
  for (const e of [...entries].reverse()) {
    if (!isSay(e)) continue
    for (const s of [...sentencesOf(e.text)].reverse()) {
      const q = shorten(s, PROGRESS_CAPS.DECISION_CHARS)
      if (!(DECISION.test(s) || isShortDecision(s)) || s.endsWith('?') || seen.has(q)) continue
      seen.add(q)
      out.push({ t: e.t, quote: q })
      if (out.length >= PROGRESS_CAPS.DECISIONS) return out
    }
  }
  return out
}

function issuesOf(entries: readonly Entry[], brief: string, report: StruggleReport): IssuesInfo {
  const waits = report.items.filter(i => (i.kind === 'slow-call' || i.kind === 'idle-gap') && i.outcome === 'resolved').length
  const list: IssueLine[] = report.items.filter(i => !((i.kind === 'slow-call' || i.kind === 'idle-gap') && i.outcome === 'resolved')).map(i => ({
    kind: i.kind === 'slow-call' || i.kind === 'idle-gap' ? 'wait' : 'failure',
    title: i.title,
    evidence: i.evidence,
    t: i.t,
    outcome: i.outcome,
  }))
  // Deviations: an edit to a file the brief says not to touch.
  const forbidden = forbiddenOf(brief)
  const seen = new Set<string>()
  for (const e of entries.filter(isToolEntry))
    if (isWrite(e) && !seen.has(e.path as string) && forbidden.some(f => matchesFile(e.path as string, f))) {
      seen.add(e.path as string)
      list.push({ kind: 'deviation', title: `Edited ${baseNameOf(e.path as string)}, which its brief says not to touch`, evidence: `${e.tool} ${e.label}`, t: e.t, outcome: 'open' })
    }
  // A question waiting: the newest thing the agent did is to say one, or to ask.
  const last = entries[entries.length - 1]
  const question = last === undefined ? undefined : isSay(last) ? sentencesOf(last.text).filter(s => s.endsWith('?')).pop() : isToolEntry(last) && actOfEntry(last) === 'ask' ? last.label : undefined
  if (last !== undefined && question !== undefined && question !== '') list.push({ kind: 'question', title: 'Waiting for an answer', evidence: shorten(question, PROGRESS_CAPS.DECISION_CHARS), t: last.t, outcome: 'open' })
  list.sort((a, b) => Number(b.outcome === 'open') - Number(a.outcome === 'open') || b.t - a.t)
  const open = list.filter(i => i.outcome === 'open').length
  const resolved = list.length - open
  const failures = `${open === 0 ? 'Nothing open' : `${open} open`}${resolved > 0 ? `, ${resolved} resolved` : ''}`
  const waited = waits > 0 ? `${waits} long wait${waits === 1 ? '' : 's'} (see Struggles)` : ''
  const summary = list.length === 0 ? `No failures so far${waited === '' ? '' : `; ${waited}`}.` : `${[failures, waited].filter(x => x !== '').join('; ')}.`
  return { openCount: open, summary, list: list.slice(0, PROGRESS_CAPS.ISSUES) }
}

/** The whole Progress of an agent. `brief` is its first message with line breaks. */
export function progressOf(args: { entries: readonly Entry[]; brief: string; lane: LaneInfo | undefined; state: string; endedAt: number | null; now: number }): AgentProgress {
  const { entries, now } = args
  const tools = entries.filter(isToolEntry)
  const isRunning = args.state !== 'done' && args.endedAt === null
  const report = struggleReportOf(entries, { now, isRunning })
  const phases = phasesOf(tools, { from: tools[0]?.t ?? now, now, isRunning })
  return {
    now: nowOf(entries, args.lane, args),
    plan: planOf({ lane: args.lane, brief: args.brief, entries }),
    phases: phases.length > 0 ? phases : [],
    phaseNote: phases.length > 0 ? '' : tools.length === 0 ? 'No tool calls read from the transcript yet, so no phases can be shown.' : 'Phases could not be derived.',
    done: doneOf(tools),
    decisions: decisionsOf(entries),
    issues: issuesOf(entries, args.brief, report),
  }
}
