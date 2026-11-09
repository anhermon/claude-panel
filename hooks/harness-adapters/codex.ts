// The codex adapter: a codex rollout (`~/.codex/sessions/Y/M/D/rollout-<time>-<thread id>.jsonl`, one JSON row per line:
// `{timestamp, ordinal, type, payload}`) -> the neutral entries, steps and brief of ../transcript-parse.ts. Pure, no `$`.
// What is read (verified on real rollouts, survey T71 section 2): `event_msg/item_completed` (AgentMessage, CommandExecution,
// FileChange, McpToolCall, web search, ImageView, UserMessage, Reasoning with a summary), ONE token source (`token_usage_record`, else `event_msg/token_count`),
// `turn_context` (model, effort), `event_msg/task_complete`, the time a `custom_tool_call` row starts (the items' own
// `duration` is the scheduling time, not the wall time). Never kept: encrypted reasoning, a tool's output (a digest for the evidence views,
// one line for the page), `base_instructions`, the AGENTS.md block. Every text goes through ../transcript-redact.ts.
// Safe on bad input: a cut last line, an unknown row type, a missing field or a huge row never throws and never costs much.
import { callLabel, commandText, digestOutput, errorLine, excerpt, firstLine, scrubLines, scrubText, clip, TEXT_CAPS } from '../transcript-redact'
import type { Entry, Parsed, Step, ToolEntry } from '../transcript-parse'
import type { HarnessAdapter, HarnessCall, RunState } from './types'

export const CODEX = {
  FORMAT: 'codex-rollout',
  /** A row longer than this is not parsed (counted as skipped): `base_instructions` is ~21 KB, a big command output ~70 KB. */
  MAX_ROW_CHARS: 400_000,
  /** The most rows looked at in one piece. */
  MAX_ROWS: 40_000,
  /** The final report is returned from its END only, this many characters. */
  LAST_MESSAGE_CHARS: 8_000,
  /** The brief kept for the proof parsers (its `Eval:` line may sit past the 700-character page excerpt). */
  RAW_BRIEF_CHARS: 20_000,
  /** No `task_complete` and the file written within this long: the run is still going. */
  RUNNING_WINDOW_MS: 120_000,
  /** A row's type is read from this many leading characters, so a row that is not needed is never parsed. */
  HEAD_CHARS: 200,
} as const

const ROW = {
  SESSION_META: 'session_meta',
  TURN_CONTEXT: 'turn_context',
  EVENT: 'event_msg',
  RESPONSE: 'response_item',
  TOKEN_RECORD: 'token_usage_record',
} as const
const EVENT = { ITEM_DONE: 'item_completed', TOKEN_COUNT: 'token_count', TASK_DONE: 'task_complete' } as const
const ITEM = {
  AGENT: 'AgentMessage',
  USER: 'UserMessage',
  COMMAND: 'CommandExecution',
  FILE: 'FileChange',
  MCP: 'McpToolCall',
  IMAGE: 'ImageView',
  EXTENSION: 'Extension',
  REASONING: 'Reasoning',
} as const
const PHASE_FINAL = 'final_answer'
const TOOL = { BASH: 'Bash', EDIT: 'Edit', WRITE: 'Write', READ: 'Read', WEB_SEARCH: 'WebSearch' } as const
const CHANGE_ADD = 'add'
const STATUS_OK = 'completed'
const FAILED_STATUSES: readonly string[] = ['failed', 'declined']
const SHELL_FLAGS: readonly string[] = ['-c', '-lc', '-ic', '-lic', '-cl']
const WEB_SEARCH_KIND = /web[._-]?search/i
const INSTRUCTIONS_BLOCK = /^\s*(?:#\s*AGENTS\.md instructions|<environment_context>|<user_instructions>|<INSTRUCTIONS>)/i
const FILE_URL = /^file:\/\//
const ROW_TYPE = /^\{\s*"timestamp"\s*:\s*"([^"]*)"\s*,\s*"ordinal"\s*:\s*\d+\s*,\s*"type"\s*:\s*"([a-z_]+)"/
/** A model's tool call row (its time starts the wall time of the shell items that follow). */
const CALL_PAYLOAD = /"payload"\s*:\s*\{\s*"type"\s*:\s*"(?:custom_tool_call|function_call)"/
const ROW_CALL_START = 'call_start'
const MARKDOWN_BOLD = /\*\*/g
const THINK_JOIN = ' / '
const OUT_LINE_CHARS = 100
/**
 * delegation-kit puts a fixed preamble before the task: a role line and a `## Tools available to you` block that ends at the first blank
 * line. The page shows the task, not the preamble (the proof parsers keep the whole text).
 */
const DELEGATION_PREAMBLE = /^[\s\S]*?\n## Tools available to you\n[\s\S]*?\n\n/
const taskOf = (brief: string): string => brief.replace(DELEGATION_PREAMBLE, '').trimStart() || brief
/** A reported duration under this is scheduling time, not the command's. */
const MIN_REPORTED_MS = 1
const NOTE_JOIN = ' · '
const MESSAGE_PAYLOAD = /"payload"\s*:\s*\{\s*"type"\s*:\s*"message"/
const NANOS_PER_MS = 1_000_000
const MS_PER_S = 1000
const MORE_FILES = ' +'
const EXIT_PREFIX = 'exit '
const FAILED_NOTE = 'failed'

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)
const obj = (v: unknown): Obj => (isObj(v) ? v : {})

/** The rows of a piece of rollout that matter, parsed; `rowType` of every other row is skipped before `JSON.parse`. */
type Row = { type: string; t: number; payload: Obj }

function* rowsOf(text: string, isWhole: boolean, skipsResponse: () => boolean, counter: { skipped: number }): Generator<Row> {
  const lines = text.split('\n')
  if (!isWhole) lines.shift() // the first line of a tail is cut
  let seen = 0
  for (const line of lines) {
    if (line.trim() === '') continue
    if (++seen > CODEX.MAX_ROWS) return
    if (line.length > CODEX.MAX_ROW_CHARS) {
      counter.skipped++
      continue
    }
    const head = line.slice(0, CODEX.HEAD_CHARS)
    const [, stamp, type] = ROW_TYPE.exec(head) ?? []
    if (type === ROW.SESSION_META) continue
    if (type === ROW.RESPONSE && CALL_PAYLOAD.test(head)) {
      yield { type: ROW_CALL_START, t: Date.parse(stamp ?? ''), payload: {} }
      continue
    }
    // a response_item is only read for the brief (a user message), and only while the brief is not found
    if (type === ROW.RESPONSE && (skipsResponse() || !MESSAGE_PAYLOAD.test(head))) continue
    let row: unknown
    try {
      row = JSON.parse(line)
    } catch {
      counter.skipped++
      continue
    }
    if (!isObj(row) || !isObj(row.payload)) continue
    const t = Date.parse(str(row.timestamp))
    yield { type: str(row.type), t: Number.isFinite(t) ? t : 0, payload: row.payload }
  }
}

/** The text parts of a message `content` list (`input_text` / `output_text` / `Text`), joined; the instruction blocks left out. */
function messageText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map(b => (isObj(b) ? str(b.text) : ''))
    .filter(s => s.trim() !== '' && !INSTRUCTIONS_BLOCK.test(s))
    .join('\n')
}

/**
 * The time a tool item took, ms. The harness's own `duration` ({secs, nanos}, or a plain number of ms) is believed when it is at least
 * MIN_REPORTED_MS; a shorter one is scheduling time (a real codex rollout says 3 microseconds for every command), so the item's wall
 * time (its start to its finish) is used instead.
 */
function msOf(duration: unknown, startedMs: number, doneMs: number): number {
  const wall = Math.max(0, doneMs - startedMs)
  const reported = isObj(duration) ? Math.round(count(duration.secs) * MS_PER_S + count(duration.nanos) / NANOS_PER_MS) : typeof duration === 'number' && Number.isFinite(duration) && duration >= 0 ? Math.round(duration) : 0
  return reported >= MIN_REPORTED_MS ? reported : wall
}

/** The command of a CommandExecution: `["/bin/zsh","-lc","<script>"]` -> the script; any other argv -> its words. */
function commandOf(command: unknown): string {
  if (typeof command === 'string') return command
  if (!Array.isArray(command)) return ''
  const words = command.filter((w): w is string => typeof w === 'string')
  const shellAt = words.findIndex(w => SHELL_FLAGS.includes(w))
  return shellAt >= 0 && shellAt < words.length - 1 ? (words.at(-1) ?? '') : words.join(' ')
}

const withNote = (head: string, note: string): string => (note === '' ? head : `${head}: ${note}`)

/** What the page shows under a shell call: "exit 0 · first output line (+N lines)". Scrubbed. */
function outputNote(exit: number, output: unknown): string {
  const lines = str(output).split('\n').filter(l => l.trim() !== '')
  const first = excerpt(lines[0] ?? '', OUT_LINE_CHARS)
  const more = lines.length > 1 ? ` (+${lines.length - 1} lines)` : ''
  return [`${EXIT_PREFIX}${exit}`, first === '' ? '' : `${first}${more}`].filter(p => p !== '').join(NOTE_JOIN)
}

/** The summary lines of a `Reasoning` item (strings or `{text}` parts), markdown bold removed; '' when the harness kept none (encrypted). */
function summaryOf(item: Obj): string {
  const parts = Array.isArray(item.summary_text) ? item.summary_text : []
  return parts.map(p => (typeof p === 'string' ? p : str(obj(p).text))).map(p => p.replace(MARKDOWN_BOLD, '').trim()).filter(p => p !== '').join(THINK_JOIN)
}

/** A finished tool call from an `item_completed` item; undefined for the items that are not tool calls. */
function toolOf(item: Obj, t: number, startedMs: number, doneMs: number): ToolEntry | undefined {
  const kind = str(item.type)
  const status = str(item.status)
  const isBad = FAILED_STATUSES.includes(status)
  const make = (tool: string, label: string, error: string, duration?: unknown, facts: Partial<ToolEntry> = {}): ToolEntry => ({ t, kind: 'tool', tool, label, ms: msOf(duration, startedMs, doneMs), error, ...facts })
  if (kind === ITEM.COMMAND) {
    const exit = typeof item.exit_code === 'number' ? item.exit_code : 0
    const note = errorLine(item.aggregated_output)
    const error = exit !== 0 ? withNote(`${EXIT_PREFIX}${exit}`, note) : isBad ? withNote(FAILED_NOTE, note) : ''
    const command = commandOf(item.command)
    const out = digestOutput(item.aggregated_output)
    const facts: Partial<ToolEntry> = { act: 'run', cmd: commandText(command), exit, ...(out === '' ? {} : { out }), note: outputNote(exit, item.aggregated_output) }
    return make(TOOL.BASH, callLabel(TOOL.BASH, { command }), error, item.duration, facts)
  }
  if (kind === ITEM.FILE) {
    const paths = Object.keys(obj(item.changes))
    const isNew = paths.length > 0 && paths.every(p => str(obj(obj(item.changes)[p]).type) === CHANGE_ADD)
    const tool = isNew ? TOOL.WRITE : TOOL.EDIT
    const first = callLabel(tool, { file_path: paths[0] ?? '' })
    const label = paths.length > 1 ? `${first}${MORE_FILES}${paths.length - 1}` : first
    const error = status !== '' && status !== STATUS_OK ? withNote(FAILED_NOTE, errorLine(item.stderr)) : ''
    const path = paths[0] === undefined ? undefined : clip(scrubText(paths[0].replace(FILE_URL, '')), TEXT_CAPS.PATH_CHARS)
    return make(tool, label, error, undefined, { act: isNew ? 'create' : 'edit', ...(path === undefined ? {} : { path }) })
  }
  if (kind === ITEM.MCP) {
    const tool = `mcp__${str(item.server)}__${str(item.tool)}`
    const result = obj(item.result)
    return make(tool, callLabel(tool, {}), isBad || result.isError === true ? withNote(FAILED_NOTE, errorLine(result.content)) : '', item.duration, { act: 'other' })
  }
  if (kind === ITEM.IMAGE) {
    const file = str(item.path).replace(FILE_URL, '')
    return make(TOOL.READ, callLabel(TOOL.READ, { file_path: file }), '', undefined, { act: 'read', path: clip(scrubText(file), TEXT_CAPS.PATH_CHARS) })
  }
  if (kind === ITEM.EXTENSION && WEB_SEARCH_KIND.test(str(item.kind))) {
    const query = str(item.query) || str(obj(item.action).query)
    return make(TOOL.WEB_SEARCH, excerpt(query, TEXT_CAPS.LABEL_CHARS), isBad ? FAILED_NOTE : '', undefined, { act: 'search' })
  }
  return undefined
}

type Usage = { input: number; cached: number; output: number }
function usageOf(v: unknown): Usage | undefined {
  if (!isObj(v)) return undefined
  const input = count(v.input_tokens)
  const output = count(v.output_tokens)
  if (input + output === 0) return undefined
  const cached = Math.min(count(v.cached_input_tokens), input)
  return { input, cached, output }
}
const stepOf = (id: string, t: number, u: Usage): Step => ({ t, id, fresh: u.input - u.cached, output: u.output, cacheRead: u.cached })

/** The facts of a whole piece, in one pass. */
type Scan = Parsed & { rawBrief: string; model: string; effort: string; lastFinal: string; completeMessage: string | undefined; completeAt: number }

function scan(text: string, isWhole: boolean): Scan {
  const out: Scan = { brief: '', entries: [], steps: [], skipped: 0, rawBrief: '', model: '', effort: '', lastFinal: '', completeMessage: undefined, completeAt: 0 }
  const counter = { skipped: 0 }
  const records: Step[] = []
  const counts: Step[] = []
  const seenResponses = new Set<string>()
  let isBriefFound = false
  let callStart = 0 // when the model's latest tool call began
  let lastDone = 0 // when the latest tool item finished (a call may run several)
  for (const row of rowsOf(text, isWhole, () => isBriefFound || !isWhole, counter)) {
    const { payload } = row
    const kind = str(payload.type)
    if (row.type === ROW_CALL_START) {
      callStart = row.t
    } else if (row.type === ROW.RESPONSE) {
      if (str(payload.role) !== 'user') continue
      const said = messageText(payload.content)
      if (said === '') continue
      isBriefFound = true
      out.rawBrief = said.slice(0, CODEX.RAW_BRIEF_CHARS)
      out.brief = excerpt(taskOf(said), TEXT_CAPS.BRIEF_CHARS)
      out.briefFull = scrubLines(taskOf(said), TEXT_CAPS.BRIEF_FULL_CHARS, TEXT_CAPS.BRIEF_FULL_CHARS)
    } else if (row.type === ROW.TURN_CONTEXT) {
      out.model = str(payload.model) || out.model
      out.effort = str(payload.effort) || str(obj(obj(payload.collaboration_mode).settings).reasoning_effort) || out.effort
    } else if (row.type === ROW.TOKEN_RECORD) {
      const u = usageOf(payload.usage)
      const id = str(payload.response_id)
      if (u === undefined || (id !== '' && seenResponses.has(id))) continue
      seenResponses.add(id)
      records.push(stepOf(id, row.t, u))
    } else if (row.type === ROW.EVENT && kind === EVENT.TOKEN_COUNT) {
      const u = usageOf(obj(payload.info).last_token_usage)
      if (u !== undefined) counts.push(stepOf(`count-${counts.length}`, row.t, u))
    } else if (row.type === ROW.EVENT && kind === EVENT.TASK_DONE) {
      out.completeMessage = str(payload.last_agent_message)
      out.completeAt = row.t
    } else if (row.type === ROW.EVENT && kind === EVENT.ITEM_DONE) {
      const item = obj(payload.item)
      const doneMs = count(payload.completed_at_ms) || row.t
      const startedMs = count(payload.started_at_ms) || doneMs
      const itemKind = str(item.type)
      if (itemKind === ITEM.AGENT) {
        const raw = messageText(item.content)
        const said = excerpt(raw, TEXT_CAPS.SAY_CHARS)
        if (str(item.phase) === PHASE_FINAL) out.lastFinal = raw
        if (said !== '') out.entries.push({ t: doneMs, kind: 'say', text: said })
      } else if (itemKind === ITEM.USER) {
        const raw = messageText(item.content)
        if (raw === '') continue
        if (!isBriefFound && isWhole) {
          isBriefFound = true
          out.rawBrief = raw.slice(0, CODEX.RAW_BRIEF_CHARS)
          out.brief = excerpt(taskOf(raw), TEXT_CAPS.BRIEF_CHARS)
          out.briefFull = scrubLines(taskOf(raw), TEXT_CAPS.BRIEF_FULL_CHARS, TEXT_CAPS.BRIEF_FULL_CHARS)
        } else if (raw.slice(0, CODEX.RAW_BRIEF_CHARS) !== out.rawBrief) out.entries.push({ t: doneMs, kind: 'user', text: excerpt(raw, TEXT_CAPS.SAY_CHARS) })
      } else if (itemKind === ITEM.REASONING) {
        const summary = summaryOf(item)
        if (summary !== '') out.entries.push({ t: doneMs, kind: 'think', text: excerpt(summary, TEXT_CAPS.SAY_CHARS) })
      } else {
        // a shell item's own stamps are one instant: its wall time runs from the call that started it (or the item before it in the same call)
        const begin = Math.max(callStart, lastDone)
        const isShell = itemKind === ITEM.COMMAND || itemKind === ITEM.MCP
        const from = isShell && begin > 0 && begin < startedMs ? begin : startedMs
        const tool = toolOf(item, from, from, doneMs)
        if (tool !== undefined) {
          out.entries.push(tool)
          lastDone = Math.max(lastDone, doneMs)
        }
      }
    }
  }
  const final = out.completeMessage ?? ''
  const finalSaid = excerpt(final, TEXT_CAPS.SAY_CHARS)
  // the report is the last entry; a rollout whose final answer was not an AgentMessage item still shows it
  if (finalSaid !== '' && !out.entries.some(e => e.kind === 'say' && e.text === finalSaid)) out.entries.push({ t: out.completeAt, kind: 'say', text: finalSaid })
  out.steps = records.length > 0 ? records : counts // ONE token source: both carry the same numbers
  out.skipped = counter.skipped
  return out
}

const entriesInOrder = (entries: Entry[]): Entry[] => entries.map((e, i) => ({ e, i })).sort((a, b) => a.e.t - b.e.t || a.i - b.i).map(x => x.e)

export function parseCodex(text: string, isWhole: boolean): Parsed {
  const s = scan(text, isWhole)
  return { brief: s.brief, ...(s.briefFull === undefined ? {} : { briefFull: s.briefFull }), entries: entriesInOrder(s.entries), steps: s.steps, skipped: s.skipped }
}

/** The brief unshortened (up to RAW_BRIEF_CHARS, not scrubbed) for the proof parsers; '' when the piece does not hold it. */
export const rawBriefOf = (text: string): string => scan(text, true).rawBrief

export function callsOf(text: string): HarnessCall[] {
  return parseCodex(text, true).entries.flatMap(e => (e.kind === 'tool' ? [{ t: e.t, tool: e.tool, target: e.label, ms: e.ms, failed: e.error !== null && e.error !== '' }] : []))
}

// lastMessage, state and model scan the piece as is: a cut first line just fails to parse and is skipped.
/** The final report: the `task_complete` message, else the last `final_answer`; its last LAST_MESSAGE_CHARS, not scrubbed; '' when none. */
export function lastMessageOf(text: string): string {
  const s = scan(text, true)
  const message = s.completeMessage ?? s.lastFinal
  return message.length > CODEX.LAST_MESSAGE_CHARS ? message.slice(-CODEX.LAST_MESSAGE_CHARS) : message
}

/** done: `task_complete` seen; else running while the file is fresh; else aborted. */
export function stateOf(text: string, mtimeMs: number, now: number): RunState {
  if (scan(text, true).completeMessage !== undefined) return 'done'
  return now - mtimeMs <= CODEX.RUNNING_WINDOW_MS ? 'running' : 'aborted'
}

export function modelOf(text: string): { model?: string; effort?: string } {
  const s = scan(text, true)
  return { ...(s.model !== '' ? { model: s.model } : {}), ...(s.effort !== '' ? { effort: s.effort } : {}) }
}

/** `session_meta` of a rollout's first line: the thread id, the start and the cwd; undefined when the line is not one. */
export function sessionMetaOf(firstLineText: string): { id: string; startedAt: number; cwd: string } | undefined {
  try {
    const row: unknown = JSON.parse(firstLineText)
    if (!isObj(row) || row.type !== ROW.SESSION_META || !isObj(row.payload)) return undefined
    const t = Date.parse(str(row.payload.timestamp) || str(row.timestamp))
    return { id: str(row.payload.id), startedAt: Number.isFinite(t) ? t : 0, cwd: str(row.payload.cwd) }
  } catch {
    return undefined
  }
}

export const codexAdapter: HarnessAdapter = { format: CODEX.FORMAT, parse: parseCodex, calls: callsOf, lastMessage: lastMessageOf, state: stateOf, model: modelOf, rawBrief: rawBriefOf }
