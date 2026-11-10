// A piece of an agent's transcript (the engine's JSONL: one JSON object per line, `assistant` and `user` lines with `message.content`
// blocks, a `timestamp` each) -> the entries the detail view shows, pure: no `$`, no I/O. The caller reads the file's END (a tail of
// at most a few MiB, see ./agent-detail-host.ts), so the first line of a tail is cut and dropped unless the piece is the whole file.
// What is kept per line, all of it through ./transcript-redact.ts: the assistant's text (an excerpt), each tool call with a short
// label and how long it took (from its `tool_use` line to the line holding its `tool_result`), the first line of an error, the
// person's / parent's messages, and per model request the four token counts (one request is split over several lines that repeat
// its `usage`, so they are counted once by `message.id`). Thinking blocks and tool outputs are never kept.
import { callLabel, commandText, digestOutput, errorLine, excerpt, exitCodeOf, scrubLines, scrubText, clip, TEXT_CAPS } from './transcript-redact'
import { tokensOf } from './pulse-model'
import type { StepUsage } from './pulse-model'

/** `think`: a reasoning summary the harness kept (codex); Claude thinking blocks are never read. */
export type SayEntry = { t: number; kind: 'say' | 'user' | 'think'; text: string }
/** What a call DOES, whatever the harness calls its tools: the progress and struggle views reason in these, never in tool names. */
export type Act = 'read' | 'search' | 'create' | 'edit' | 'run' | 'delegate' | 'ask' | 'other'
export type ToolEntry = {
  t: number
  kind: 'tool'
  tool: string
  /** A basename, a program, a host or a scrubbed first line of a command (./transcript-redact.ts callLabel). */
  label: string
  /** How long the call took, from the tool_use line to its result line; null while no result was seen. */
  ms: number | null
  /** The first line of the error (scrubbed), '' when the call did not fail, null while no result was seen. */
  error: string | null
  /** The facts the evidence views need, all optional so a harness that cannot fill one still works (they then say "not shown"). */
  /** What the call does; absent: derive it from `tool` with `actOf`. */
  act?: Act
  /** The file a read/create/edit call named, home folder replaced by "~". */
  path?: string
  /** A shell command in full (whitespace collapsed, scrubbed); `label` is its short first line. */
  cmd?: string
  /** The exit code of a shell call; null when the result names none. */
  exit?: number | null
  /** A scrubbed digest of the result (the start and the end of it); read by the views, never sent to the page. */
  out?: string
  /** A short plain line the page shows under the call (a shell call: its exit status and first output line); absent: none. Scrubbed. */
  note?: string
}
export type Entry = SayEntry | ToolEntry
export type Step = { t: number; id: string; fresh: number; output: number; cacheRead: number }

export type TurnStats = { count: number; lastMs: number; avgMs: number; maxMs: number }

export type Parsed = {
  apiErrors?: number
  failedCalls?: number
  apiError?: { t: number; lastT: number; text: string }
  turns?: TurnStats
  /** The first message the agent was given (a parent's brief); '' when the piece does not hold it. */
  brief: string
  /** The same brief with its line breaks (for the numbered and bulleted items); '' when the piece does not hold it. */
  briefFull?: string
  entries: Entry[]
  /** One per model request, oldest first. */
  steps: Step[]
  /** How many lines were not JSON (the cut first line is not counted). */
  skipped: number
  /** The last assistant message's model, the transcript's gitBranch and the ai-title row when present in the piece. */
  model?: string
  branch?: string
  title?: string
}

export const SESSION_META_CAPS = { MODEL_CHARS: 80, BRANCH_CHARS: 80, TITLE_CHARS: 80 } as const
const SYNTHETIC_MODEL = '<synthetic>'
const FIRST_USER_PLACEHOLDER = ''
const SKIP_PREFIXES = ['{"type":"api-request', '{"type":"file-history-snapshot']
const TURN_DURATION = 'turn_duration'
const READ_TOOLS = new Set(['Read', 'NotebookRead'])
const SEARCH_TOOLS = new Set(['Grep', 'Glob', 'LS', 'WebSearch', 'WebFetch', 'ToolSearch'])
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'NotebookEdit', 'apply_patch'])
const CREATE_TOOLS = new Set(['Write'])
const RUN_TOOLS = new Set(['Bash', 'shell', 'exec_command', 'local_shell'])
const DELEGATE_TOOLS = new Set(['Agent', 'Task', 'SendMessage'])
const ASK_TOOLS = new Set(['AskUserQuestion'])

/** What a call does, from the tool's name (the Claude names, plus the few codex ones); 'other' for anything unknown. */
export function actOf(tool: string): Act {
  if (READ_TOOLS.has(tool)) return 'read'
  if (SEARCH_TOOLS.has(tool)) return 'search'
  if (EDIT_TOOLS.has(tool)) return 'edit'
  if (CREATE_TOOLS.has(tool)) return 'create'
  if (RUN_TOOLS.has(tool)) return 'run'
  if (DELEGATE_TOOLS.has(tool)) return 'delegate'
  if (ASK_TOOLS.has(tool)) return 'ask'
  return 'other'
}

/** The facts of a call that the evidence views read: its act, the file it named, the command in full. */
function factsOf(tool: string, input: Readonly<Record<string, unknown>>): Pick<ToolEntry, 'act' | 'path' | 'cmd'> {
  const act = actOf(tool)
  const file = str(input.file_path) || str(input.notebook_path)
  return {
    act,
    ...(file === '' ? {} : { path: clip(scrubText(file), TEXT_CAPS.PATH_CHARS) }),
    ...(act === 'run' ? { cmd: commandText(str(input.command)) } : {}),
  }
}
/** A user message that is the harness talking (reminders, notifications, local command output), not a person or a parent. */
const HARNESS_TEXT = /^\s*<(?:system-reminder|task-notification|local-command|command-name|command-message|user-prompt-submit-hook)\b/i
const NO_CONTENT = '(no content)'

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

function stepOf(id: string, t: number, usage: unknown): Step | undefined {
  if (!isObj(usage)) return undefined
  const u = usage as Partial<StepUsage>
  const counts = {
    input_tokens: num(u.input_tokens),
    output_tokens: num(u.output_tokens),
    cache_creation_input_tokens: num(u.cache_creation_input_tokens),
    cache_read_input_tokens: num(u.cache_read_input_tokens),
  }
  const fresh = tokensOf(counts) - counts.output_tokens
  return fresh + counts.output_tokens > 0 ? { t, id, fresh, output: counts.output_tokens, cacheRead: counts.cache_read_input_tokens } : undefined
}

/** The text of a user message: a string, or the text blocks of a list. */
function userText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(b => (isObj(b) && b.type === 'text' ? str(b.text) : '')).filter(s => s !== '').join('\n')
}

/**
 * Entries, steps and the brief of a piece of transcript. `isWhole`: the piece starts at the file's first byte (so its first line is
 * complete). Never throws; a line that is not JSON is skipped.
 */
export function parseTranscript(text: string, isWhole: boolean): Parsed {
  const lines = text.split('\n')
  if (!isWhole) lines.shift()
  const out: Parsed = { brief: FIRST_USER_PLACEHOLDER, briefFull: FIRST_USER_PLACEHOLDER, entries: [], steps: [], skipped: 0, apiErrors: 0, failedCalls: 0, turns: { count: 0, lastMs: 0, avgMs: 0, maxMs: 0 } }
  let turnTotalMs = 0
  const open = new Map<string, ToolEntry>()
  const stepAt = new Map<string, number>()
  let isFirstUser = true
  for (const line of lines) {
    if (line.trim() === '' || SKIP_PREFIXES.some(prefix => line.startsWith(prefix))) continue
    let row: unknown
    try {
      row = JSON.parse(line)
    } catch {
      out.skipped++
      continue
    }
    if (!isObj(row)) continue
    if (row.type === 'system' && row.subtype === TURN_DURATION && typeof row.durationMs === 'number' && Number.isFinite(row.durationMs) && row.durationMs >= 0) {
      const turns = out.turns!
      turns.count++
      turns.lastMs = row.durationMs
      turnTotalMs += row.durationMs
      turns.avgMs = turnTotalMs / turns.count
      turns.maxMs = Math.max(turns.maxMs, row.durationMs)
    }
    if (row.isApiErrorMessage === true) out.apiErrors!++
    if (typeof row.gitBranch === 'string') {
      const branch = clip(scrubText(row.gitBranch).trim(), SESSION_META_CAPS.BRANCH_CHARS)
      if (branch !== '') out.branch = branch
    }
    if (row.type === 'ai-title' && typeof row.aiTitle === 'string') {
      const title = excerpt(row.aiTitle, SESSION_META_CAPS.TITLE_CHARS)
      if (title !== '') out.title = title
    }
    if (row.type === 'assistant' && isObj(row.message) && typeof row.message.model === 'string') {
      const model = row.message.model.trim()
      if (model !== '' && model !== SYNTHETIC_MODEL) out.model = clip(model, SESSION_META_CAPS.MODEL_CHARS)
    }
    if (!isObj(row.message)) continue
    for (const block of Array.isArray(row.message.content) ? row.message.content : []) {
      if (isObj(block) && block.type === 'tool_result' && block.is_error === true) out.failedCalls!++
    }
    const t = Date.parse(str(row.timestamp))
    if (!Number.isFinite(t)) continue
    const { message } = row
    if (row.isApiErrorMessage === true) {
      out.apiError = { t: out.apiError?.t ?? t, lastT: t, text: errorLine(message.content) }
    }
    if (row.type === 'assistant') {
      const id = str(message.id)
      const step = stepOf(id, t, message.usage)
      if (step !== undefined) {
        const at = id === '' ? undefined : stepAt.get(id)
        if (at === undefined) {
          if (id !== '') stepAt.set(id, out.steps.length)
          out.steps.push(step)
        } else out.steps[at] = step
      }
      for (const block of Array.isArray(message.content) ? message.content : []) {
        if (!isObj(block)) continue
        if (block.type === 'text') {
          const said = excerpt(str(block.text), TEXT_CAPS.SAY_CHARS)
          if (said !== '' && said !== NO_CONTENT) out.entries.push({ t, kind: 'say', text: said })
        } else if (block.type === 'tool_use') {
          const tool = str(block.name)
          const input = isObj(block.input) ? block.input : {}
          const entry: ToolEntry = { t, kind: 'tool', tool, label: callLabel(tool, input), ms: null, error: null, ...factsOf(tool, input) }
          out.entries.push(entry)
          if (str(block.id) !== '') open.set(str(block.id), entry)
        }
      }
    } else if (row.type === 'user') {
      const content = message.content
      if (Array.isArray(content))
        for (const block of content) {
          if (!isObj(block) || block.type !== 'tool_result') continue
          const call = open.get(str(block.tool_use_id))
          if (call === undefined) continue
          open.delete(str(block.tool_use_id))
          call.ms = Math.max(0, t - call.t)
          call.error = block.is_error === true ? errorLine(block.content) || 'failed' : ''
          if (call.act === 'run') call.exit = block.is_error === true ? exitCodeOf(block.content) : 0
          if (call.act === 'run' || block.is_error === true) {
            const digest = digestOutput(block.content)
            if (digest !== '') call.out = digest
          }
        }
      const said = userText(content)
      if (said.trim() !== '' && !HARNESS_TEXT.test(said)) {
        if (isFirstUser && isWhole) {
          out.brief = excerpt(said, TEXT_CAPS.BRIEF_CHARS)
          out.briefFull = scrubLines(said, TEXT_CAPS.BRIEF_FULL_CHARS, TEXT_CAPS.BRIEF_FULL_CHARS)
        }
        else out.entries.push({ t, kind: 'user', text: excerpt(said, TEXT_CAPS.SAY_CHARS) })
        isFirstUser = false
      }
    }
  }
  return out
}

/** The first line of a transcript file (the brief the agent was given) -> its excerpt; '' when the line is no user message. */
export function briefOf(firstLineText: string): string {
  try {
    const row: unknown = JSON.parse(firstLineText)
    if (!isObj(row) || row.type !== 'user' || !isObj(row.message)) return ''
    const said = userText(row.message.content)
    return HARNESS_TEXT.test(said) ? '' : excerpt(said, TEXT_CAPS.BRIEF_CHARS)
  } catch {
    return ''
  }
}

/** The first line of a transcript file -> the brief with its line breaks kept; '' when the line is no user message. */
export function briefFullOf(firstLineText: string): string {
  try {
    const row: unknown = JSON.parse(firstLineText)
    if (!isObj(row) || row.type !== 'user' || !isObj(row.message)) return ''
    const said = userText(row.message.content)
    return HARNESS_TEXT.test(said) ? '' : scrubLines(said, TEXT_CAPS.BRIEF_FULL_CHARS, TEXT_CAPS.BRIEF_FULL_CHARS)
  } catch {
    return ''
  }
}
