// The privacy filter for TRANSCRIPT text (what an agent said and did), the layer on top of ./pulse-redact.ts. The pulse itself
// keeps no words at all; the agent detail view (./agent-detail.ts) shows excerpts of the agent's own transcript, so every text that
// reaches a page passes `scrub` here first, and every tool call is labelled from `callLabel`, which builds on the pulse's
// `targetOf` (a basename, a program, a host) and adds only a SCRUBBED, shortened first line for a shell command and a few more
// short descriptions. Never kept: a tool's output (only the first line of an ERROR, scrubbed), a file's content, a thinking block.
// This is best effort pattern matching, not a proof: a secret without a recognisable shape (a bare password in prose) is not caught.
// Pure: no `$`, no I/O.
import { realCommand, targetOf } from './pulse-redact'

export const TEXT_CAPS = {
  /** An assistant or user text excerpt. */
  SAY_CHARS: 600,
  /** The brief the agent was given (its first message). */
  BRIEF_CHARS: 700,
  /** The same brief with its line breaks kept (the progress view reads its numbered and bulleted items). */
  BRIEF_FULL_CHARS: 8000,
  /** A whole shell command, whitespace collapsed (the evidence checks compare against it; the page never gets it). */
  CMD_CHARS: 240,
  /** A file path as the call named it, home folder replaced. */
  PATH_CHARS: 200,
  /** The kept digest of a result (a few lines at its start and end), and one line of it. */
  OUT_CHARS: 1700,
  OUT_LINE_CHARS: 160,
  /** A shell command, first line only. */
  COMMAND_CHARS: 90,
  /** The first line of an error message. */
  ERROR_CHARS: 140,
  /** Any other short description (a pattern, a skill name, an agent description). */
  LABEL_CHARS: 60,
} as const

const ELLIPSIS = '…'
const REDACTED = '[redacted]'
const HOME_MARK = '~'
const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f]/g
const NEWLINE = /\r?\n/
const SPACES = /\s+/g

// Shapes of secrets. Each is a row; order matters little because each replaces its own match.
const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g
const URL_USERINFO = /(:\/\/)[^/\s:@]+:[^/\s@]+@/g
const AUTH_HEADER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi
const NAMED_SECRET = /\b([A-Za-z0-9_.-]*(?:token(?!s)|secret|passw(?:or)?d|api[_-]?key|apikey|auth(?!or)|credential|private[_-]?key)[A-Za-z0-9_.-]*)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s"',;&|)]+)/gi
const SECRET_FLAG = /(--?(?:token|password|passwd|pass|secret|api-?key|auth|key)\b)(\s+|=)(?!-)("[^"]*"|'[^']*'|\S+)/gi
const TOKEN_SHAPES =
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bxox[abprs]-[A-Za-z0-9-]{10,}|\bAKIA[0-9A-Z]{16}\b|\bAIza[0-9A-Za-z_-]{30,}|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/g
const MIN_BLOB = 40
const LONG_BLOB = new RegExp(`[A-Za-z0-9_-]{${MIN_BLOB},}`, 'g')
const HAS_DIGIT = /\d/
const HAS_LETTER = /[A-Za-z]/
const PATH_SEPARATOR = '/'
const HEADER_LINE = /\b(authorization|cookie|x-api-key|set-cookie)(\s*:\s*)[^\r\n]+/gi
const PATH_BOUNDARY = /[\s"'`<>]/
const maskBlob = (run: string, offset: number, text: string): string => {
  if (!HAS_DIGIT.test(run) || !HAS_LETTER.test(run)) return run
  const before = text.slice(0, offset).split(PATH_BOUNDARY).at(-1) ?? ''
  const after = text.slice(offset + run.length).split(PATH_BOUNDARY)[0] ?? ''
  return `${before}${run}${after}`.includes(PATH_SEPARATOR) ? run : REDACTED
}
const HOME_PATH = /(?:\/Users|\/home)\/[^/\s"'`]+/g

/** Text -> one safe line: control characters out, secrets and the home folder replaced, whitespace collapsed. Not shortened. */
export function scrubText(text: string): string {
  return text
    .replace(CONTROL_CHARS, ' ')
    .replace(PRIVATE_KEY_BLOCK, REDACTED)
    .replace(HEADER_LINE, `$1$2${REDACTED}`)
    .replace(URL_USERINFO, `$1${REDACTED}@`)
    .replace(AUTH_HEADER, `$1 ${REDACTED}`)
    .replace(NAMED_SECRET, `$1$2${REDACTED}`)
    .replace(SECRET_FLAG, `$1$2${REDACTED}`)
    .replace(TOKEN_SHAPES, REDACTED)
    .replace(LONG_BLOB, maskBlob)
    .replace(HOME_PATH, HOME_MARK)
    .replace(SPACES, ' ')
    .trim()
}

/** `max` characters with a trailing ellipsis when cut. */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1)).trimEnd()}${ELLIPSIS}`
}

/** An excerpt for the page: scrubbed, then cut. */
export const excerpt = (text: string, max: number): string => clip(scrubText(text), max)

/** Text -> scrubbed lines, line breaks kept, blank lines dropped, each line at most `lineMax` characters, the whole at most `max`. */
export function scrubLines(text: string, max: number, lineMax: number = max): string {
  const lines = text.split(NEWLINE).map(l => clip(scrubText(l), lineMax)).filter(l => l !== '')
  return clip(lines.join('\n'), max)
}

/** The first non-empty line of a text. */
export const firstLine = (text: string): string => text.split(NEWLINE).find(l => l.trim() !== '') ?? ''

const stringOf = (v: unknown): string => (typeof v === 'string' ? v : '')
const COMMAND_TOOL = 'Bash'
const AGENT_TOOLS: readonly string[] = ['Agent', 'Task']
const PATTERN_TOOLS: readonly string[] = ['Grep', 'Glob']
const SKILL_TOOL = 'Skill'

/**
 * What to show next to a tool's name: a file's basename, a program, a host (the pulse's `targetOf`), and for a few tools one more
 * short thing that is safe once scrubbed: the first line of a shell command (without its `cd dir &&` lead), the description of a
 * sub-agent, a search pattern, a skill name.
 */
export function callLabel(tool: string, input: Readonly<Record<string, unknown>>): string {
  if (tool === COMMAND_TOOL) return excerpt(firstLine(realCommand(stringOf(input.command))), TEXT_CAPS.COMMAND_CHARS)
  if (AGENT_TOOLS.includes(tool)) return excerpt(stringOf(input.description), TEXT_CAPS.LABEL_CHARS)
  if (PATTERN_TOOLS.includes(tool)) return excerpt(stringOf(input.pattern), TEXT_CAPS.LABEL_CHARS)
  if (tool === SKILL_TOOL) return excerpt(stringOf(input.skill), TEXT_CAPS.LABEL_CHARS)
  return excerpt(targetOf(tool, input), TEXT_CAPS.LABEL_CHARS)
}

/** The first line of an error result's content (a string, or a list of text blocks), scrubbed and cut; '' when it has none. */
export function errorLine(content: unknown): string {
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map(b => stringOf((b as { text?: unknown } | null)?.text)).join('\n') : ''
  return excerpt(firstLine(text), TEXT_CAPS.ERROR_CHARS)
}

const OUT_HEAD_LINES = 2
const OUT_TAIL_LINES = 8
const EXIT_LINE = /^Exit code (\d+)\s*$/
const textOfContent = (content: unknown): string =>
  typeof content === 'string' ? content : Array.isArray(content) ? content.map(b => stringOf((b as { text?: unknown } | null)?.text)).join('\n') : ''

/** The exit code a shell result names on its first line ("Exit code 1"), null when it names none. */
export function exitCodeOf(content: unknown): number | null {
  const m = EXIT_LINE.exec(firstLine(textOfContent(content)))
  return m === null ? null : Number(m[1])
}

/**
 * A result -> the few lines worth keeping, scrubbed: the first OUT_HEAD_LINES and the last OUT_TAIL_LINES non-empty lines (the summary
 * of a test run or a compiler sits at the end), without the "Exit code N" line. The tool's output is read here and thrown away; only
 * this digest stays in the mod, and the page gets facts derived from it (a result line, an error quote), never the digest itself.
 */
export function digestOutput(content: unknown): string {
  const lines = textOfContent(content).split(NEWLINE).map(l => l.trim()).filter(l => l !== '' && !EXIT_LINE.test(l))
  const kept = lines.length <= OUT_HEAD_LINES + OUT_TAIL_LINES ? lines : [...lines.slice(0, OUT_HEAD_LINES), ...lines.slice(-OUT_TAIL_LINES)]
  return scrubLines(kept.join('\n'), TEXT_CAPS.OUT_CHARS, TEXT_CAPS.OUT_LINE_CHARS)
}

/** A command, whitespace collapsed, scrubbed, cut: for comparing against, not for display. */
export const commandText = (command: string): string => excerpt(realCommand(command), TEXT_CAPS.CMD_CHARS)
