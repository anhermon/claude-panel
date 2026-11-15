// What the hooks saw of the session, drawn on the board with no model call (the "auto board"): the goal of the latest human
// prompt, a derived state, the plan the model keeps in TodoWrite / Task*, and the head of its last answer. Pure: no `$`, no I/O.
// `reduce` is the only writer of the facts and every word it keeps goes through the redaction helpers first.
import type { BoardFrame, FactTodo, SessionFacts } from '../types'
export type { FactTodo, SessionFacts } from '../types'
import { targetOf } from './pulse-redact'
import { clip, clipWords, scrubText } from './transcript-redact'

export const ANSWER_CHARS = 400
export const GOAL_CHARS = 90
export const TODO_CHARS = 48
export const LAST_CHARS = 40
export const PLAN_MAX = 6
export const PLAN_HIDE_MS = 60_000
export const LAST_ANSWER_ID = 'last-answer'
export const PLAN_ID = 'plan'
/** The `why` of a task the mod seeded itself (the safety net): the facts' goal replaces it, a model-posted task does not. */
export const TASK_WHY = 'Started from your request; Claude will refine it'
/** Bookkeeping tools: they keep the books and are not work. */
const PLAN_TOOLS: readonly string[] = ['TodoWrite', 'TaskCreate', 'TaskUpdate']
/** A tool whose name ends so (`mcp__subagent-progress__checklist`) keeps the model's checklist in `input.items` ({ content, status }). */
const CHECKLIST_TOOL = /__checklist$/
const CHECKLIST_FILE = /(^|[\\/])checklist\.md$/i
const FILE_EDIT_TOOLS: readonly string[] = ['Edit', 'MultiEdit']
const CHECKBOX = /^\s*[-*+]\s+\[([ xX~>])\]\s+(.+?)\s*$/
const BOOKKEEPING: readonly string[] = ['ToolSearch', 'TodoWrite', 'Skill', 'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList', 'TaskOutput', 'TaskStop']
/** The panel's own tools (`mcp__panel__panel`, `mcp__panel__scene`): drawing the board is not work on the task. */
const PANEL_TOOL_PREFIX = 'mcp__panel__'
const TLDR = /^\s*[*_#>\s-]*TL;DR\s*:?[*_\s]*:?\s*(.*)$/i
const SUMMARY = /^\s*[*_#>\s-]*Summary\s*:?[*_\s]*:?\s*(.*)$/i
/** Sentences that open an answer and say nothing; dropped from its head (a small, conservative list). */
const FILLER = /^(done|sure|all set|got it|okay|ok|great|alright|absolutely|certainly|of course|will do|finished|complete|completed|all (steps|tasks|items|todos) (are )?(finished|complete|completed|done)\b[^.!?]*|nothing (left|more) to (do|continue)[^.!?]*|everything is done)[.!]*$/i
const SENTENCE = /(?<=[.!?])\s+/
const BULLET = /^\s*(?:[-*+•]|\d+[.)])\s+(.*)$/
const BREAK = '⏎'
const BREAK_SPLIT = / ?⏎ ?/
const FENCE = /^\s*(```|~~~)/
const TASK_ID = /#(\d+)/
const VERBS: Record<string, string> = { Edit: 'edited', MultiEdit: 'edited', NotebookEdit: 'edited', Write: 'wrote', Read: 'read', Bash: 'ran', Grep: 'searched', Glob: 'searched', WebFetch: 'fetched', WebSearch: 'searched the web', Agent: 'delegated', Task: 'delegated' }
const TODO_STATES: Record<string, FactTodo['state']> = { pending: 'todo', in_progress: 'doing', completed: 'done' }

export const initialFacts = (sessionKey: string | null = null): SessionFacts => ({ sessionKey, goal: '', turn: 'idle', calls: 0, last: '', todos: [], allDoneAt: 0, answer: '' })

/** A different session id means a fresh conversation (for example after /clear). */
export const factsForSession = (facts: SessionFacts, key: string): SessionFacts => (facts.sessionKey === key ? facts : initialFacts(key))

export type FactsEvent =
  /** A human prompt (the caller applied the origin gate). `title` is its goal: the task title of a work prompt, the question itself for chat. */
  | { kind: 'prompt'; t: number; title: string; agentId?: undefined }
  /** A finished tool call. `text` is the result as the model reads it (only a task id is read from it). */
  | { kind: 'tool'; t: number; tool: string; input: Readonly<Record<string, unknown>>; isError?: boolean; text?: string; /** The text of the checklist file after an Edit (the host re-reads it); undefined when unreadable. */ file?: string; agentId?: unknown }
  | { kind: 'turn'; t: number; answer: string; reason: string; agentId?: unknown }

const textOf = (v: unknown): string => (typeof v === 'string' ? v : '')
const redact = (v: unknown, max: number): string => clip(scrubText(textOf(v)), max)
const redactWords = (v: unknown, max: number): string => clipWords(scrubText(textOf(v)), max)

/** Is this call one that changes the checklist file (a Write / Edit of a `CHECKLIST.md`)? Used by the host to know when to re-read it. */
export const isChecklistFileEdit = (tool: string, input: Readonly<Record<string, unknown>>): boolean => FILE_EDIT_TOOLS.includes(tool) && CHECKLIST_FILE.test(textOf(input.file_path))

/** The checkboxes of a markdown text as todos (`- [ ]` todo, `- [x]` done, `- [~]` / `- [>]` doing). */
export function checkboxTodos(text: string): FactTodo[] {
  const todos: FactTodo[] = []
  for (const row of text.split('\n')) {
    const m = CHECKBOX.exec(row)
    if (m === null) continue
    const t = redact(plainMarkdown(m[2] ?? ''), TODO_CHARS)
    if (t !== '') todos.push({ id: String(todos.length + 1), t, state: m[1] === ' ' ? 'todo' : m[1] === 'x' || m[1] === 'X' ? 'done' : 'doing' })
  }
  return todos
}

/** Inline markdown -> plain words: code ticks, bold / italic, links and images keep their text, headings lose their marks. */
export function plainMarkdown(line: string): string {
  return line
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`+([^`]*)`+/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[\s(])\*([^*\s][^*]*?)\*(?=$|[\s).,;:!?])/g, '$1$2')
    .replace(/(^|[\s(])_([^_\s][^_]*?)_(?=$|[\s).,;:!?])/g, '$1$2')
    .replace(/^\s{0,3}#{1,6}\s+/, '')
    .replace(/^\s*>\s?/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Text -> lines: a paragraph is one line, every bullet its own `• item` line, fences and blank lines gone. */
function answerLines(text: string): string[] {
  const out: string[] = []
  let open = false
  for (const raw of text.split('\n')) {
    if (FENCE.test(raw)) continue
    const bullet = BULLET.exec(raw)
    const line = plainMarkdown(bullet === null ? raw : (bullet[1] ?? ''))
    if (line === '') {
      open = false
      continue
    }
    if (bullet !== null) out.push(`• ${line}`)
    else if (open) out[out.length - 1] = `${out[out.length - 1] ?? ''} ${line}`
    else out.push(line)
    open = bullet === null
  }
  return out
}

/** The leading sentences that are filler, dropped; a text that is all filler is kept (something beats nothing). */
function withoutFiller(lines: string[]): string[] {
  const first = lines[0]
  if (first === undefined || first.startsWith('• ')) return lines
  const sentences = first.split(SENTENCE)
  let skip = 0
  while (skip < sentences.length && FILLER.test((sentences[skip] ?? '').trim())) skip++
  if (skip === 0) return lines
  const rest = sentences.slice(skip).join(' ')
  if (rest !== '') return [rest, ...lines.slice(1)]
  return lines.length > 1 ? lines.slice(1) : lines
}

/** At most `max` characters over whole lines: lines that do not fit drop whole; only a first line over `max` is cut at a word. */
function fitLines(lines: string[], max: number): string {
  const kept: string[] = []
  let used = 0
  for (const line of lines) {
    const cost = line.length + (kept.length > 0 ? 1 : 0)
    if (used + cost > max) {
      if (kept.length === 0) kept.push(clipWords(line, max))
      break
    }
    kept.push(line)
    used += cost
  }
  return kept.join('\n')
}

/**
 * The final message as plain, digestible text (at most ANSWER_CHARS): a leading `TL;DR:` or `Summary` line when there is one,
 * else the message with markdown removed, filler openers dropped and bullets kept as separate lines.
 */
export function answerHead(answer: string): string {
  // scrubText flattens line breaks: carry them through it as a marker (padded, so a secret never spans two lines)
  const text = scrubText(answer.slice(0, ANSWER_CHARS * 8).replace(/\n/g, ` ${BREAK} `)).split(BREAK_SPLIT).join('\n')
  const rows = text.split('\n')
  const at = rows.findIndex(l => l.trim() !== '')
  const first = at < 0 ? '' : (rows[at] ?? '')
  const tldr = TLDR.exec(first)
  if (tldr !== null && (tldr[1] ?? '').trim() !== '') return clipWords(`TL;DR: ${plainMarkdown(tldr[1] ?? '')}`, ANSWER_CHARS)
  const summary = SUMMARY.exec(first)
  if (summary !== null) {
    const block = (summary[1] ?? '').trim() !== '' ? [summary[1] ?? ''] : rows.slice(at + 1).join('\n').split(/\n\s*\n/).slice(0, 1)
    const lines = answerLines(block.join('\n'))
    if (lines.length > 0) return fitLines(lines, ANSWER_CHARS)
  }
  return fitLines(withoutFiller(answerLines(text)), ANSWER_CHARS)
}

/** `edited a.ts`, `ran npm`: a short, privacy-safe line for one work call. */
export function actionOf(tool: string, input: Readonly<Record<string, unknown>>): string {
  const target = targetOf(tool, input)
  const verb = VERBS[tool] ?? tool
  return clip(scrubText(`${verb} ${target}`), LAST_CHARS)
}

function allDoneAtOf(todos: readonly FactTodo[], was: number, t: number): number {
  return todos.length > 0 && todos.every(x => x.state === 'done') ? (was > 0 ? was : t) : 0
}

function withTodos(facts: SessionFacts, todos: FactTodo[], t: number): SessionFacts {
  return { ...facts, todos, allDoneAt: allDoneAtOf(todos, facts.allDoneAt, t) }
}

function planOf(facts: SessionFacts, e: Extract<FactsEvent, { kind: 'tool' }>): SessionFacts {
  const { input } = e
  if (CHECKLIST_TOOL.test(e.tool)) {
    if (!Array.isArray(input.items)) return facts
    const todos = input.items
      .filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
      .map((x, i): FactTodo => ({ id: String(i + 1), t: redact(x.content, TODO_CHARS), state: TODO_STATES[textOf(x.status)] ?? 'todo' }))
      .filter(x => x.t !== '')
    return withTodos(facts, todos, e.t)
  }
  if (e.tool === 'Write' || FILE_EDIT_TOOLS.includes(e.tool)) {
    const body = e.tool === 'Write' ? input.content : e.file
    if (typeof body !== 'string') return facts
    const todos = checkboxTodos(body)
    return todos.length === 0 ? facts : withTodos(facts, todos, e.t)
  }
  if (e.tool === 'TodoWrite') {
    if (!Array.isArray(input.todos)) return facts
    const todos = input.todos
      .filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
      .map((x, i): FactTodo => ({ id: String(i + 1), t: redact(x.content ?? x.subject, TODO_CHARS), state: TODO_STATES[textOf(x.status)] ?? 'todo' }))
      .filter(x => x.t !== '')
    return withTodos(facts, todos, e.t)
  }
  if (e.tool === 'TaskCreate') {
    const t = redact(input.subject ?? input.content, TODO_CHARS)
    if (t === '') return facts
    const next = Math.max(0, ...facts.todos.map(x => Number(x.id) || 0)) + 1
    const id = TASK_ID.exec(textOf(e.text))?.[1] ?? String(next)
    return withTodos(facts, [...facts.todos.filter(x => x.id !== id), { id, t, state: 'todo' }], e.t)
  }
  const id = textOf(input.taskId)
  const status = textOf(input.status)
  if (id === '' || !facts.todos.some(x => x.id === id)) return facts
  if (status === 'deleted') return withTodos(facts, facts.todos.filter(x => x.id !== id), e.t)
  const subject = redact(input.subject, TODO_CHARS)
  return withTodos(facts, facts.todos.map(x => (x.id === id ? { ...x, t: subject === '' ? x.t : subject, state: TODO_STATES[status] ?? x.state } : x)), e.t)
}

/** The facts after one event. Subagent events (an `agentId`) change nothing: the board is about the main session. */
export function reduce(facts: SessionFacts, e: FactsEvent): SessionFacts {
  if (e.agentId !== undefined) return facts
  if (e.kind === 'prompt') {
    const base: SessionFacts = { ...facts, turn: 'working', calls: 0, last: '', answer: '' }
    if (e.title.trim() === '') return base
    const finished = facts.todos.length > 0 && facts.todos.every(x => x.state === 'done') // a finished task's plan does not carry over to the next human prompt
    return { ...base, goal: redactWords(e.title, GOAL_CHARS), ...(finished ? { todos: [], allDoneAt: 0 } : {}) }
  }
  if (e.kind === 'turn') {
    if (e.reason === 'answer') return { ...facts, turn: 'done', answer: answerHead(e.answer) }
    return { ...facts, turn: 'stopped' }
  }
  if (e.isError === true) return facts
  if (PLAN_TOOLS.includes(e.tool) || CHECKLIST_TOOL.test(e.tool)) return planOf(facts, e)
  if ((e.tool === 'Write' || FILE_EDIT_TOOLS.includes(e.tool)) && CHECKLIST_FILE.test(textOf(e.input.file_path))) return { ...planOf(facts, e), calls: facts.calls + 1, last: actionOf(e.tool, e.input) }
  if (BOOKKEEPING.includes(e.tool) || e.tool.startsWith(PANEL_TOOL_PREFIX)) return facts
  return { ...facts, turn: facts.turn === 'idle' ? 'working' : facts.turn, calls: facts.calls + 1, last: actionOf(e.tool, e.input) }
}

/** `working · 3 calls · last: edited a.ts`, `waiting on you`, `done`. */
export function factsState(facts: SessionFacts, hasAsk: boolean): { sub: string; status: 'working' | 'waiting' | 'done' } {
  if (hasAsk) return { sub: 'waiting on you', status: 'waiting' }
  if (facts.turn === 'done') return { sub: '', status: 'done' } // the chip already says it
  if (facts.turn === 'stopped') return { sub: 'stopped', status: 'done' }
  const parts = ['working', ...(facts.calls > 0 ? [`${facts.calls} ${facts.calls === 1 ? 'call' : 'calls'}`] : []), ...(facts.last === '' ? [] : [`last: ${facts.last}`])]
  return { sub: parts.join(' · '), status: 'working' }
}

/** The plan as steps: at most PLAN_MAX rows, the last one `+N more` when the list is longer; '' rows never. */
function planItems(todos: readonly FactTodo[]): { t: string; state: FactTodo['state'] }[] {
  if (todos.length <= PLAN_MAX) return todos.map(({ t, state }) => ({ t, state }))
  const shown = PLAN_MAX - 1
  const open = todos.findIndex(x => x.state !== 'done')
  const start = Math.min(Math.max(0, open - 1), todos.length - shown)
  return [...todos.slice(start, start + shown).map(({ t, state }) => ({ t, state })), { t: `+${todos.length - shown} more`, state: 'todo' }]
}

/** The frames the facts draw besides `now`: `last-answer` while idle, `plan` while it has steps. Nothing is returned empty. */
export function factsFrames(facts: SessionFacts, now: number): BoardFrame[] {
  const frames: BoardFrame[] = []
  if (facts.answer !== '' && facts.turn !== 'working') frames.push({ id: LAST_ANSWER_ID, type: 'text', title: 'Last answer', size: 'm', text: facts.answer } as BoardFrame)
  const isStale = facts.allDoneAt > 0 && now - facts.allDoneAt >= PLAN_HIDE_MS
  if (facts.todos.length > 0 && !isStale) frames.push({ id: PLAN_ID, type: 'steps', title: 'Plan', size: 'm', items: planItems(facts.todos) } as BoardFrame)
  return frames
}
