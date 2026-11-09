// What KIND of work a tool call is, from the tool name and the short redacted target only (the file's basename, the first
// word of a shell command, `zone`: a class of folder, see pulse-redact zoneOf). Never a file's content or a full command.
// Pure and table-driven: every rule is a row of a table below. KIND_META (label, one letter, glyph, color) is the one table
// the mod and the page share: web/builtin/board/kind-meta.mjs is its twin, and tests/work-kinds.test.ts fails when they differ.
import type { InsightKind } from '../types'

/** The kinds a tool call can be (a loop that makes no call is `thinking`; a finished or idle one is `done` / `waiting`). */
export const WORK_KINDS = ['ui', 'logic', 'tests', 'visual', 'docs', 'research', 'reading', 'delegating', 'working'] as const
export type WorkKind = (typeof WORK_KINDS)[number]
export const INSIGHT_KINDS: readonly InsightKind[] = [...WORK_KINDS, 'thinking', 'waiting', 'done']

export type KindMeta = { label: string; letter: string; glyph: string; color: string; headline: string }

/** Label (one word), strip letter, one glyph, fixed color, and the headline a row says while the agent does this kind of work. */
export const KIND_META: Readonly<Record<InsightKind, KindMeta>> = {
  ui: { label: 'UI', letter: 'u', glyph: '▣', color: '#f472b6', headline: 'Writing UI' },
  logic: { label: 'Logic', letter: 'l', glyph: 'λ', color: '#34d399', headline: 'Writing logic' },
  tests: { label: 'Tests', letter: 't', glyph: '✓', color: '#fbbf24', headline: 'Running tests' },
  visual: { label: 'Visual', letter: 'v', glyph: '◉', color: '#22d3ee', headline: 'Checking visually' },
  docs: { label: 'Docs', letter: 'd', glyph: '¶', color: '#fb923c', headline: 'Writing docs' },
  research: { label: 'Research', letter: 'r', glyph: '?', color: '#bef264', headline: 'Researching' },
  reading: { label: 'Reading', letter: 'x', glyph: '∷', color: '#60a5fa', headline: 'Reading code' },
  delegating: { label: 'Delegating', letter: 'g', glyph: '⇉', color: '#a78bfa', headline: 'Delegating' },
  working: { label: 'Working', letter: 'w', glyph: '•', color: '#64748b', headline: 'Working' },
  thinking: { label: 'Thinking', letter: 'k', glyph: '…', color: '#94a3b8', headline: 'Thinking' },
  waiting: { label: 'Waiting', letter: 'q', glyph: '‖', color: '#475569', headline: 'Waiting' },
  done: { label: 'Done', letter: 'z', glyph: '■', color: '#475569', headline: 'Finished' },
}
/** The strip letter of a bucket nothing happened in. */
export const STRIP_NONE = '.'
const KIND_OF_LETTER: Readonly<Record<string, InsightKind>> = Object.fromEntries(INSIGHT_KINDS.map(k => [KIND_META[k].letter, k]))
export const kindOfLetter = (letter: string): InsightKind | undefined => (Object.hasOwn(KIND_OF_LETTER, letter) ? KIND_OF_LETTER[letter] : undefined)
export const isWorkKind = (v: unknown): v is WorkKind => typeof v === 'string' && (WORK_KINDS as readonly string[]).includes(v)

/** How much one call counts toward what an agent is "mostly doing": making something says more than one more read. */
export const KIND_WEIGHT: Readonly<Record<WorkKind, number>> = { ui: 3, logic: 3, tests: 3, visual: 3, docs: 3, delegating: 3, research: 1, reading: 1, working: 1 }
/** The tie order of the dominant kind: the first of these wins. */
export const KIND_ORDER: readonly WorkKind[] = ['ui', 'logic', 'tests', 'visual', 'docs', 'delegating', 'research', 'reading', 'working']

/** The classes of folder a file can sit in (pulse-redact zoneOf says which; never the folder's own name). */
export const ZONES = { TESTS: 'tests', UI: 'ui' } as const
export type Zone = (typeof ZONES)[keyof typeof ZONES]

// ---- the tables -------------------------------------------------------------------------------------------------------------
const EDIT_TOOLS: readonly string[] = ['Edit', 'MultiEdit', 'NotebookEdit', 'Write']
const READ_TOOLS: readonly string[] = ['Read', 'NotebookRead']
const SEARCH_TOOLS: readonly string[] = ['Grep', 'Glob', 'LS']
const WEB_TOOLS: readonly string[] = ['WebSearch', 'WebFetch']
const DELEGATE_TOOLS: readonly string[] = ['Agent', 'Task', 'SendMessage', 'spawn', 'delegate', 'mcp__delegation-kit__delegate']
const BASH = 'Bash'
/** Tools whose name starts with one of these drive a browser or the panel's scenes: looking at the result. */
const VISUAL_TOOL_PREFIXES: readonly string[] = ['mcp__claude-in-chrome__', 'mcp__panel__scene']
/** Bookkeeping that says nothing about the work (progress posts, tool lookups, to-do lists): no kind, no time. */
const IGNORED_TOOLS: readonly string[] = ['lane', 'ToolSearch', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet']
const IGNORED_TOOL_PREFIXES: readonly string[] = ['mcp__savvy-progress__', 'mcp__panel__panel']

const IMAGE_EXTS: readonly string[] = ['png', 'jpg', 'jpeg', 'gif', 'webp']
const DOC_EXTS: readonly string[] = ['md', 'mdx', 'rst', 'txt']
const DOC_NAMES: readonly string[] = ['skill', 'readme', 'changelog']
const UI_EXTS: readonly string[] = ['html', 'htm', 'css', 'scss', 'svg', 'tsx', 'jsx', 'vue', 'svelte']
/** Scripts that are page code when they sit in a UI folder (web/**.js). */
const SCRIPT_EXTS: readonly string[] = ['js', 'mjs', 'cjs', 'ts', 'mts']
const LOGIC_EXTS: readonly string[] = ['ts', 'mts', 'js', 'mjs', 'cjs', 'py', 'go', 'rs', 'java', 'kt', 'swift', 'rb', 'sh', 'php', 'c', 'cc', 'cpp', 'h', 'cs', 'lua', 'sql']
const TEST_NAME = /(?:\.(?:test|spec)\.[a-z0-9]+$)|(?:^test_[^.]+\.py$)|(?:_test\.(?:go|py)$)/
/** Verbs of a Bash target (pulse-redact BASH_VERBS) that mean checking something, and building / rendering. */
const TEST_VERBS: readonly string[] = ['test', 'tests', 'lint', 'typecheck', 'check']
const RENDER_VERB = 'render'
/** Programs that run tests, type-check or lint. */
const CHECK_PROGRAMS: readonly string[] = ['tsc', 'vitest', 'jest', 'pytest', 'mocha', 'playwright', 'cypress', 'eslint', 'mypy', 'ruff']
/** A word of a script or program name (split at `-`, `_`, `.`) that means producing a picture of the result. */
export const RENDER_WORDS: readonly string[] = ['render', 'screenshot', 'shot', 'screencap', 'screencapture', 'chrome', 'chromium']
/** Shell programs that only look at things. */
const LOOKER_PROGRAMS: readonly string[] = ['cat', 'sed', 'grep', 'rg', 'head', 'tail', 'ls', 'find', 'wc', 'awk', 'jq', 'sort', 'file', 'stat', 'diff', 'tree', 'du', 'less', 'nl', 'cut', 'uniq', 'xxd', 'pwd', 'which', 'tr', 'column', 'fd']

const SEPARATOR = ' '
const WORD_SPLIT = /[^a-z0-9]+/
const has = <T>(list: readonly T[], v: T): boolean => list.includes(v)
const wordsOf = (name: string): string[] => name.toLowerCase().split(WORD_SPLIT).filter(w => w !== '')
const extOf = (name: string): string => {
  const at = name.lastIndexOf('.')
  return at <= 0 ? '' : name.slice(at + 1).toLowerCase()
}

/** The kind of editing a file by its name (and the class of folder it sits in). */
export function fileKind(name: string, zone: string): WorkKind {
  const ext = extOf(name)
  const lower = name.toLowerCase()
  if (TEST_NAME.test(lower) || (zone === ZONES.TESTS && has(LOGIC_EXTS, ext))) return 'tests'
  if (has(DOC_EXTS, ext) || has(DOC_NAMES, lower.split('.')[0] ?? '')) return 'docs'
  if (has(UI_EXTS, ext) || (zone === ZONES.UI && has(SCRIPT_EXTS, ext))) return 'ui'
  if (has(LOGIC_EXTS, ext)) return 'logic'
  return 'working'
}

function bashKind(target: string): WorkKind {
  const [program = '', verb = ''] = target.split(SEPARATOR)
  if (verb === RENDER_VERB || wordsOf(program).some(w => has(RENDER_WORDS, w))) return 'visual'
  if (has(TEST_VERBS, verb) || has(CHECK_PROGRAMS, program)) return 'tests'
  if (has(LOOKER_PROGRAMS, program)) return 'reading'
  return 'working'
}

/** A tool call that is not work at all (a progress post, a tool lookup). */
export const isIgnored = (tool: string): boolean => has(IGNORED_TOOLS, tool) || IGNORED_TOOL_PREFIXES.some(p => tool.startsWith(p))

/**
 * The kind of one tool call, or undefined for bookkeeping. An unknown tool is `working` (neutral): no kind is guessed for
 * what we do not know. `target` is the redacted one (basename, program [+ verb], host); `zone` the class of folder.
 */
export function kindOf(ev: { tool: string; target: string; zone?: string }): WorkKind | undefined {
  const { tool, target } = ev
  if (isIgnored(tool)) return undefined
  if (has(DELEGATE_TOOLS, tool)) return 'delegating'
  if (has(WEB_TOOLS, tool)) return 'research'
  if (VISUAL_TOOL_PREFIXES.some(p => tool.startsWith(p))) return 'visual'
  if (has(EDIT_TOOLS, tool)) return fileKind(target, ev.zone ?? '')
  if (has(READ_TOOLS, tool)) return has(IMAGE_EXTS, extOf(target)) ? 'visual' : 'reading'
  if (has(SEARCH_TOOLS, tool)) return 'reading'
  if (tool === BASH) return bashKind(target)
  return 'working'
}

/** Did this call write something (an edit tool)? The headline says "Writing" for it and "Running" for a shell call. */
export const isWrite = (tool: string): boolean => has(EDIT_TOOLS, tool)
