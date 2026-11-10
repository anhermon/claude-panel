// Privacy filter of the Pulse. The only thing the ambient pulse may remember about a tool call is its NAME and a
// short TARGET, built here and nowhere else:
//   file tools      -> the basename of file_path / path / notebook_path
//   Bash            -> the first word of the first REAL command: leading `VAR=value` and `cd <dir> &&` / `;` / `||` segments are
//                      skipped (`cd /a && node x.mjs` -> node), a path is cut to its basename; never an argument. The ONE
//                      exception: a word of the fixed list BASH_VERBS among the next few words of that command (`npm test`,
//                      `node --test x`, `claude plugin test` -> `npm test`, `node test`, `claude test`): it says what kind of run
//                      this was (tests, a build), and as the word comes from our list it can never carry anything of the user's
//                      A script of a runner (`node scripts/render-board.mjs`) whose NAME has a word of RENDER_WORDS is `node render`.
//   zone            -> (zoneOf) for a file tool only: `tests` / `ui` when a folder of its path is named like one of the fixed
//                      lists TEST_DIRS / UI_DIRS, else ''. Never a folder's own name: the class is all that is kept.
//   WebFetch        -> the hostname of the url (never the path, query or credentials)
//   WebSearch       -> the length of the query, never the query
//   everything else -> nothing
//   spawn prompt   -> its INTENT only (`intentOf`): the `Ticket:` line and the first sentence of the goal, cut short; the
//                      rest of the prompt is never kept. This is what the agent rows show instead of shell words.
// Never an output, a file's content, a full command or a url with a path. Pure: no `$`, no I/O.

import { panelConfig } from './panel-config'
import { RENDER_WORDS, ZONES } from './work-kinds'

export const TARGET_CHARS = 40
/** The intent of an agent: `<ticket> · <first sentence of the goal>`, at most this long. */
export const INTENT_CHARS = 140
const TICKET_CHARS = 40
const GOAL_SENTENCE_CHARS = 100
const INTENT_JOIN = ' · '
// The labels of the ticket and goal lines come from the options (`ticketLabels`, `goalLabels`; defaults Ticket / Goal, Objective).
const lineRegexes = new Map<string, RegExp>()
function labelLine(labels: readonly string[], build: (alternation: string) => string): RegExp {
  const source = build(labels.join('|'))
  let re = lineRegexes.get(source)
  if (re === undefined) lineRegexes.set(source, (re = new RegExp(source, 'i')))
  return re
}
const ticketLine = (): RegExp => labelLine(panelConfig.ticketLabels, a => `^\\W*(?:${a})\\W*[:\\-\u2013]\\s*(.*)$`)
const goalLine = (): RegExp => labelLine(panelConfig.goalLabels, a => `^(?:${a})\\W*(?:[:\\-–]\\s*(.*))?$`)
// PROBLEM / TASK / ...: a label at the start of a line (any case) or an UPPERCASE one inside a line, text after `:` or the next line.
const LABEL_START = /^(?:problem|task|build|mission|what|objective)\b[^:]{0,40}(?::\s*(.*))?$/i
const LABEL_INLINE = /\b(?:PROBLEM|TASK|BUILD|MISSION|WHAT|OBJECTIVE)\b[^:\n]{0,40}:\s*(\S.*)$/
// A sentence that is context, not a goal: has a path (`a/b`, `~/x`, `KEY=/x`) or a URL, or opens with `You work/are`.
const PATHISH = /[\w.*~-]\/[\w.*~-]|(?:^|\s)~?\/\w|\w=\/|:\/\//
const CONTEXT_OPENER = /^you\s+(?:work|are)\b/i
const PATH_TOKEN = /(?:^|\s)(?:\w+=)?~?\/\S*/g
const LABELLED_LINE = /^\W*[A-Za-z][A-Za-z ]{0,20}\s*:\s*$/
const HEADING = /^\s*#/
const MARKUP_LEAD = /^[\s#>*_`-]+/
const FIRST_SENTENCE = /^(.+?[.!?])(?:\s|$)/
export const FILE_EXTRA_TOOLS = ['Grep', 'Glob', 'LS'] as const
/** Tools that read or change one file: their target also feeds the recently touched files of a loop. */
export const FILE_TOUCH_TOOLS: readonly string[] = ['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'NotebookRead']
const FILE_TOOLS: ReadonlySet<string> = new Set([...FILE_TOUCH_TOOLS, ...FILE_EXTRA_TOOLS])
const FILE_KEYS = ['file_path', 'notebook_path', 'path'] as const
const BASH_TOOL = 'Bash'
const WEB_FETCH_TOOL = 'WebFetch'
const WEB_SEARCH_TOOL = 'WebSearch'
const PATH_SEPARATORS = /[\\/]+/
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
const PROGRAM_NAME = /^[A-Za-z0-9._+@-]{1,32}$/
// `cd <dir>` followed by a command separator: workers write `cd /path && real-command`.
const LEADING_CD = /^cd(?:\s+[^;&|]*)?\s*(?:&&|;|\|\|)\s*/
const LEADING_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/
/** `cd a && cd b && x`: how many leading segments are skipped at most. */
const MAX_SKIPPED_SEGMENTS = 8
const QUOTES_AND_OPENERS = /^["'`({]+/
const SEARCH_UNIT = 'chars'
/** The only words after the program that may join a Bash target: the kind of run (see the table at the top). */
export const BASH_VERBS: readonly string[] = ['test', 'tests', 'build', 'lint', 'typecheck', 'check']
/** The verb of a script that makes a picture of the result (see RENDER_WORDS in ./work-kinds.ts). */
const RENDER_VERB = 'render'
/** Programs that run a script file: the script's own name may say it renders. */
const SCRIPT_RUNNERS: readonly string[] = ['node', 'bun', 'deno', 'python', 'python3', 'tsx', 'npx']
const NAME_WORD_SPLIT = /[^a-z0-9]+/
/** Folder names that put a file in the `tests` / `ui` class (see ZONES in ./work-kinds.ts). */
const TEST_DIRS: readonly string[] = ['tests', 'test', '__tests__', 'spec', 'specs', 'e2e', 'evals']
const UI_DIRS: readonly string[] = ['web', 'public', 'static', 'components', 'ui', 'styles', 'css', 'frontend', 'client', 'pages']
/** How many words after the program are looked at for a verb. */
const VERB_SCAN_WORDS = 4
const COMMAND_END = /[;&|\n]/
const FLAG_DASHES = /^-+/
const TARGET_JOIN = ' '

const clean = (s: string): string => s.replace(CONTROL_CHARS, '').trim().slice(0, TARGET_CHARS)

/** `/home/example/secret/key.pem` -> `key.pem`; a trailing slash is ignored; anything that is not a string -> ''. */
export function baseName(path: unknown): string {
  if (typeof path !== 'string') return ''
  const parts = path.split(PATH_SEPARATORS).filter(p => p !== '')
  return clean(parts[parts.length - 1] ?? '')
}

/** Drop leading `VAR=x ` assignments and `cd <dir> &&` segments; a lone `cd /a` stays. */
export function realCommand(command: string): string {
  let rest = command.trim()
  for (let i = 0; i < MAX_SKIPPED_SEGMENTS; i++) {
    const next = rest.replace(LEADING_ASSIGNMENT, '').replace(LEADING_CD, '')
    if (next === rest || next === '') break
    rest = next
  }
  return rest
}

/** `cd /a && FOO=secret /usr/bin/git push --force` -> `git`. A word that is not a plain program name -> ''. */
export function firstWord(command: unknown): string {
  if (typeof command !== 'string') return ''
  const words = realCommand(command).split(/\s+/)
  const word = words.find(w => w !== '' && !ASSIGNMENT.test(w))
  if (word === undefined) return ''
  const name = baseName(word.replace(QUOTES_AND_OPENERS, ''))
  return PROGRAM_NAME.test(name) ? name : ''
}

const lineText = (s: string): string => s.replace(CONTROL_CHARS, ' ').replace(MARKUP_LEAD, '').trim()
const tidy = (s: string, max: number): string => s.replace(CONTROL_CHARS, '').trim().slice(0, max)
const firstSentence = (s: string): string => FIRST_SENTENCE.exec(s)?.[1] ?? s

const SENTENCES = /[^.!?]+(?:[.!?]+(?=\s|$)|$)/g
const stripPaths = (s: string): string => s.replace(PATH_TOKEN, ' ').replace(/\s+/g, ' ').trim()
const isContext = (s: string): boolean => PATHISH.test(s) || CONTEXT_OPENER.test(s.trim())

/** The value of a labelled line: text after the colon, else the next line; undefined when the line is no such label. */
function labelled(re: RegExp, line: string, next: string | undefined): string | undefined {
  const m = re.exec(line)
  if (m === null) return undefined
  return m[1] !== undefined && m[1] !== '' ? m[1] : (next ?? '')
}

/** The goal sentence, chosen in order: Goal/Objective line, a PROBLEM/TASK/... label, first sentence with no path; else ''. */
function pickGoal(rest: string[]): string {
  for (const [i, line] of rest.entries()) {
    const v = labelled(goalLine(), line, rest[i + 1])
    if (v !== undefined) return v
  }
  for (const [i, line] of rest.entries()) {
    const v = labelled(LABEL_START, line, rest[i + 1]) ?? LABEL_INLINE.exec(line)?.[1]
    if (v !== undefined && v !== '') return v
  }
  for (const line of rest) {
    if (LABELLED_LINE.test(line)) continue
    const hit = (line.match(SENTENCES) ?? []).find(x => x.trim() !== '' && !isContext(x))
    if (hit !== undefined) return hit
  }
  return ''
}

/**
 * What a dispatch prompt is for: its `Ticket:` line and the goal sentence (see `pickGoal`), `T30 · Board in the mod`.
 * Paths and `KEY=/path` are stripped; '' for the goal when the prompt has none (the row then shows the ticket only).
 */
export function intentOf(prompt: unknown): string {
  if (typeof prompt !== 'string') return ''
  const lines = prompt.split('\n').map(raw => ({ text: lineText(raw), isHeading: HEADING.test(raw) })).filter(l => l.text !== '')
  const ticket = lines.map(l => ticketLine().exec(l.text)?.[1]).find(v => v !== undefined) ?? ''
  // A heading is skipped as a goal unless it is `## Goal` itself, whose sentence is the next line.
  const rest = lines.filter(l => !ticketLine().test(l.text) && (!l.isHeading || goalLine().test(l.text) || LABEL_START.test(l.text))).map(l => l.text)
  const goal = stripPaths(firstSentence(pickGoal(rest)))
  const head = [tidy(ticket.replace(MARKUP_LEAD, ''), TICKET_CHARS), tidy(goal, GOAL_SENTENCE_CHARS)].filter(x => x !== '')
  return head.join(INTENT_JOIN).slice(0, INTENT_CHARS)
}

// The mod's module runs without a DOM or Node: no `URL` class to lean on. scheme://[userinfo@]host[:port][/?#...]
const URL_HOST = /^[a-z][a-z0-9+.-]*:\/\/(?:[^/?#@]*@)?(\[[0-9a-f:.]+\]|[^/?#:@\s]+)/i

/** `https://user:pw@docs.example.com:8080/a/b?q=1` -> `docs.example.com`. An unparsable url -> ''. */
export function hostName(url: unknown): string {
  if (typeof url !== 'string') return ''
  const host = URL_HOST.exec(url.trim())?.[1]
  return host === undefined ? '' : clean(host.toLowerCase())
}

/** `npm run test` -> `npm test`: the program plus the first BASH_VERBS word of its command (never any other word); just the program when none. */
export function bashTarget(command: unknown): string {
  const program = firstWord(command)
  if (program === '' || typeof command !== 'string') return program
  const words = (realCommand(command).split(COMMAND_END)[0] ?? '').trim().split(/\s+/).slice(1, 1 + VERB_SCAN_WORDS)
  const verb = words.map(w => w.replace(FLAG_DASHES, '').toLowerCase()).find(w => BASH_VERBS.includes(w)) ?? renderVerb(program, words)
  return verb === undefined ? program : `${program}${TARGET_JOIN}${verb}`
}

/** `render` when a runner's script (its first word that is not a flag) is named like a render / screenshot script; else undefined. */
function renderVerb(program: string, words: readonly string[]): string | undefined {
  if (!SCRIPT_RUNNERS.includes(program)) return undefined
  const script = baseName(words.find(w => w !== '' && !w.startsWith('-')) ?? '').toLowerCase()
  return script.split(NAME_WORD_SPLIT).some(w => RENDER_WORDS.includes(w)) ? RENDER_VERB : undefined
}

/** The class of folder a file tool's path is in: `tests` before `ui`, '' for neither (and for any tool that is not a file tool). Never a folder name. */
export function zoneOf(tool: string, input: Readonly<Record<string, unknown>>): string {
  if (!FILE_TOOLS.has(tool)) return ''
  const path = FILE_KEYS.map(k => input[k]).find((v): v is string => typeof v === 'string' && v !== '')
  if (path === undefined) return ''
  const dirs = path.split(PATH_SEPARATORS).slice(0, -1).map(d => d.toLowerCase())
  if (dirs.some(d => TEST_DIRS.includes(d))) return ZONES.TESTS
  return dirs.some(d => UI_DIRS.includes(d)) ? ZONES.UI : ''
}

/** The short, privacy-safe target of one tool call (see the table at the top); '' when the tool has none. */
export function targetOf(tool: string, input: Readonly<Record<string, unknown>>): string {
  if (tool === BASH_TOOL) return bashTarget(input.command)
  if (tool === WEB_FETCH_TOOL) return hostName(input.url)
  if (tool === WEB_SEARCH_TOOL) return typeof input.query === 'string' ? `${input.query.length} ${SEARCH_UNIT}` : ''
  if (!FILE_TOOLS.has(tool)) return ''
  for (const key of FILE_KEYS) {
    const name = baseName(input[key])
    if (name !== '') return name
  }
  return ''
}

/** Does this call touch a file (so its target is listed among the loop's recent files)? */
export const isFileTouch = (tool: string): boolean => FILE_TOUCH_TOOLS.includes(tool)
