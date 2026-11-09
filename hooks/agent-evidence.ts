// Shared reading of the NEUTRAL entries (./transcript-parse.ts Entry) for the Progress and Struggles views: what a call did, whether it
// failed, which check it was (types, tests, render...), what its result says, and the plain words for a time. Pure: no `$`, no I/O, and
// nothing here knows a harness: every fact comes from the optional fields of an entry, and a missing one means "not shown", never a guess.
import { actOf } from './transcript-parse'
import type { Act, Entry, ToolEntry } from './transcript-parse'
import { clip } from './transcript-redact'

const MS_PER_SECOND = 1000
const SECONDS_PER_MINUTE = 60
const MINUTES_PER_HOUR = 60

/** 42_000 -> "42 s", 200_000 -> "3 min 20 s", 7_500_000 -> "2 h 5 min": the words of the progress and struggle lines. */
export function spoken(ms: number): string {
  const total = Math.max(0, Math.floor(ms / MS_PER_SECOND))
  if (total < SECONDS_PER_MINUTE) return `${total} s`
  const minutes = Math.floor(total / SECONDS_PER_MINUTE)
  if (minutes < MINUTES_PER_HOUR) return total % SECONDS_PER_MINUTE === 0 ? `${minutes} min` : `${minutes} min ${total % SECONDS_PER_MINUTE} s`
  return `${Math.floor(minutes / MINUTES_PER_HOUR)} h ${minutes % MINUTES_PER_HOUR} min`
}

export const EVIDENCE_CAPS = {
  /** One quoted line (an error, a result). */
  QUOTE_CHARS: 140,
  /** A command named in a title. */
  COMMAND_CHARS: 60,
} as const

export const isToolEntry = (e: Entry): e is ToolEntry => e.kind === 'tool'
export const actOfEntry = (e: ToolEntry): Act => e.act ?? actOf(e.tool)
export const baseNameOf = (path: string): string => path.split('/').filter(p => p !== '').pop() ?? path

/** A call that did not succeed (an error line, or a shell exit other than 0), apart from the programs that use exit 1 for "nothing found". */
const BENIGN_NONZERO = new Set(['grep', 'egrep', 'fgrep', 'rg', 'diff', 'cmp', 'test', '['])
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
/** Programs that only look: a shell call made of nothing else is "reading", not "running". */
const READ_ONLY_PROGRAMS = new Set(['cat', 'ls', 'grep', 'egrep', 'rg', 'head', 'tail', 'sed', 'find', 'wc', 'sort', 'awk', 'stat', 'file', 'echo', 'cd', 'pwd', 'which', 'tree', 'diff', 'git', 'jq', 'column', 'uniq', 'cut'])
const READ_ONLY_GIT = /^git\s+(?:status|diff|log|show|ls-files|blame)\b/
const INLINE_SCRIPT_PROGRAMS = new Set(['python', 'python3', 'ruby', 'perl', 'sh', 'bash', 'zsh'])
const HEREDOC = /\s<<-?\s*['"]?\w+/
const TRIVIAL_PROGRAMS = new Set(['cd', 'which', 'echo', 'printf', 'export', 'set', 'cat', 'ls', 'head', 'tail', 'sed', 'awk', 'wc', 'sort', 'find', 'mkdir', 'cp', 'mv', 'rm', 'rsync', 'grep', 'rg'])

/** The shell segments of a command (split at && || ; | outside quotes), assignments and empty ones dropped. */
export function segmentsOf(cmd: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote = ''
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i] as string
    if (quote !== '') {
      if (c === quote) quote = ''
      cur += c
    } else if (c === '"' || c === "'") {
      quote = c
      cur += c
    } else if (c === ';' || c === '|' || (c === '&' && cmd[i + 1] === '&')) {
      out.push(cur)
      cur = ''
      if (c !== ';' && cmd[i + 1] === c) i++
    } else cur += c
  }
  out.push(cur)
  return out.map(x => x.trim().replace(/^[(\s]+/, '')).filter(x => x !== '' && !ASSIGNMENT.test(x))
}
const programOf = (segment: string): string => (segment.split(/\s+/)[0] ?? '').split('/').pop() ?? ''

/** A shell call that only looks at files (cat, ls, grep, sed -n, git status...), not one that changes or runs anything. */
export function isReadOnlyCommand(e: ToolEntry): boolean {
  if (actOfEntry(e) !== 'run') return false
  const segs = segmentsOf((e.cmd ?? e.label).split(HEREDOC)[0] ?? '')
  return segs.length > 0 && segs.every(seg => {
    const prog = programOf(seg)
    if (!READ_ONLY_PROGRAMS.has(prog)) return false
    if (prog === 'git') return READ_ONLY_GIT.test(seg)
    return !(prog === 'sed' && /\s-i\b/.test(seg))
  })
}

export function isFailure(e: ToolEntry): boolean {
  if (e.error === null || e.error === '') return false
  if (actOfEntry(e) === 'run' && e.exit === 1) {
    const segs = segmentsOf(e.cmd ?? e.label)
    const last = segs[segs.length - 1]
    if (last !== undefined && BENIGN_NONZERO.has(programOf(last))) return false
  }
  return true
}

export type CheckKind = 'types' | 'tests' | 'render' | 'lint' | 'build'
export const CHECK_LABEL: Readonly<Record<CheckKind, string>> = { types: 'Type check', tests: 'Tests', render: 'Render', lint: 'Lint', build: 'Build' }
const CHECK_PATTERNS: readonly (readonly [CheckKind, RegExp])[] = [
  ['types', /(?:^|[\s/])tsc(?:\s|$)|typecheck|type-check/],
  ['render', /render[\w.-]*\.mjs|screenshot/],
  ['tests', /--test\b|\btest\b|\btests\b|jest|vitest|pytest|mocha/],
  ['lint', /\blint\b|eslint|prettier/],
  ['build', /\bbuild\b/],
]

/** Which check a shell call ran (types, tests, render, lint, build), looking only at the segments that are not plain file chatter; null for anything else. */
export function checkKindOf(e: ToolEntry): CheckKind | null {
  if (actOfEntry(e) !== 'run') return null
  for (const seg of segmentsOf((e.cmd ?? e.label).split(HEREDOC)[0] ?? '')) {
    const prog = programOf(seg)
    if (TRIVIAL_PROGRAMS.has(prog)) continue
    // An inline script (python3 - <<E ...) is not a test run just because its text says "test"; only pytest is.
    if (INLINE_SCRIPT_PROGRAMS.has(prog) && !/pytest/.test(seg)) continue
    if (prog === 'node' && /^node\s+(?:-e|-p|-\s|--eval)/.test(seg)) continue
    for (const [kind, re] of CHECK_PATTERNS) if (re.test(seg)) return kind
  }
  return null
}

/** The key two runs share when they are "the same command": the check and the first words of its segment (digits dropped), else the label. */
export function commandKeyOf(e: ToolEntry): string {
  const text = e.cmd ?? e.label
  const kind = checkKindOf(e)
  if (kind === null) return `${e.tool}:${clip(text.replace(/\d+/g, '#'), EVIDENCE_CAPS.COMMAND_CHARS)}`
  const seg = segmentsOf(text).find(s => !TRIVIAL_PROGRAMS.has(programOf(s))) ?? text
  return `${kind}:${seg.split(/\s+/).slice(0, 3).join(' ')}`
}

/** A command for a title: the check's own words ("node --test agents-info") cut short. */
export function commandTitleOf(e: ToolEntry): string {
  const text = (e.cmd ?? e.label).split(HEREDOC)[0]?.replace(/\s*2>&1/g, '') ?? ''
  const seg = segmentsOf(text).find(s => !TRIVIAL_PROGRAMS.has(programOf(s))) ?? text
  const inline = /^(python3?|node|ruby|perl|bash|sh|zsh)(?:\s+(?:-|-e|-c|-p))?\s*(?:["'].*)?$/.exec(seg)
  if (inline !== null && INLINE_SCRIPT_PROGRAMS.has(inline[1] as string) || /^node\s+(?:-e|-p|-)\b/.test(seg)) return `an inline ${seg.split(/\s+/)[0]} script`
  // A segment that does not start with a program (its first words were cut away upstream) is no title.
  if (/^[-"'$]/.test(seg)) return 'a shell command'
  return clip(seg.replace(/(^|\s)(?:~|\/)(?:\/?[\w.-]+)*\/(?=[\w.-])/g, '$1'), EVIDENCE_CAPS.COMMAND_CHARS)
}

const SUMMARY_LINE = /^\W*(?:ℹ\s*)?(?:tests?|suites?|pass(?:ed)?|fail(?:ed)?|cancelled|skipped|todo|duration_ms|ran)\b\W*\d*\W*$/i
const SUMMARY_COUNT_LINE = /^\W*(?:ℹ\s*)?(?:tests?|suites?|pass|fail|cancelled|skipped|todo|duration_ms)\s+[\d.]+\s*$/i
const ERROR_LINE = /expected|actual|assertionerror|error ts\d+|\berror\b|not ok|✖|✗|\bfail(?:ed|ure)?\b|cannot|not found|no such|enoent|denied|blocked|refused|outside the allowed|invalid/i
const EXIT_ONLY = /^(?:failed|exit code \d+)$/i

const STRONG_ERROR = /no matches found|command not found|expected|actual|assertionerror|error ts\d+|\w*error:|not ok|✖|✗|no such file|enoent|not found|cannot|does not exist|denied|blocked|refused|outside the allowed|invalid/i
/** The line that says WHAT went wrong, better than a test's "not ok 3 - name" header. */
const DETAIL_ERROR = /expected|actual|assertionerror|error ts\d+|\w*error:/i
const TOOL_ERROR_TAG = /<\/?tool_use_error>/g

/** The first meaningful line of what went wrong: a line that names an error (not a summary count), else the LAST line of the result (where shells and runners put it), else the error text. */
export function failureQuote(e: ToolEntry): string {
  const lines = (e.out ?? '').replace(TOOL_ERROR_TAG, '').split('\n').map(l => l.trim()).filter(l => l !== '' && !SUMMARY_COUNT_LINE.test(l) && !SUMMARY_LINE.test(l))
  const named = lines.find(l => DETAIL_ERROR.test(l)) ?? [...lines].reverse().find(l => STRONG_ERROR.test(l)) ?? lines.find(l => ERROR_LINE.test(l) && l.length < 120)
  // No line names an error: say so and give the last line, which is only where the output stopped.
  const line = named ?? (lines.length > 0 && e.exit != null && e.exit !== 0 ? `exit code ${e.exit}; output ends: ${lines[lines.length - 1]}` : (lines[lines.length - 1] ?? ''))
  const text = line !== '' ? line : EXIT_ONLY.test(e.error ?? '') ? '' : (e.error ?? '').replace(TOOL_ERROR_TAG, '')
  return clip(text.replace(/^[\s>+\-ℹ✖✗]+/u, '').trim(), EVIDENCE_CAPS.QUOTE_CHARS)
}

export type CheckResult = { outcome: 'pass' | 'fail'; text: string }
const COUNT_PASS = [/\bpass(?:ed|ing)?\s+(\d+)/i, /(\d+)\s+pass(?:ed|ing)?\b/i]
const COUNT_FAIL = [/\bfail(?:ed|ing|ures?)?\s+(\d+)/i, /(\d+)\s+fail(?:ed|ing|ures?)?\b/i]
const TS_ERROR = /error TS\d+/g
const TS_FOUND = /Found (\d+) errors?/i
const firstCount = (res: readonly RegExp[], text: string): number | null => {
  for (const re of res) {
    const m = re.exec(text)
    if (m !== null) return Number(m[1])
  }
  return null
}

/** What a finished check says, parsed from the digest of its result: "clean" / "N errors", "N pass, M fail", "finished" / "issues". Null while it has no result. */
export function checkResultOf(e: ToolEntry, kind: CheckKind): CheckResult | null {
  if (e.error === null) return null
  const out = e.out ?? ''
  const failed = e.error !== '' && (e.exit === undefined || e.exit === null || e.exit !== 0)
  if (kind === 'types') {
    const found = TS_FOUND.exec(out)
    const n = found !== null ? Number(found[1]) : (out.match(TS_ERROR) ?? []).length
    return failed ? { outcome: 'fail', text: n > 0 ? `${n} error${n === 1 ? '' : 's'}` : 'errors' } : { outcome: 'pass', text: 'clean' }
  }
  if (kind === 'tests') {
    const pass = firstCount(COUNT_PASS, out)
    const fail = firstCount(COUNT_FAIL, out)
    const parts = [pass === null ? '' : `${pass} pass`, fail === null ? '' : `${fail} fail`].filter(p => p !== '')
    const hasCounts = (pass ?? 0) + (fail ?? 0) > 0
    return { outcome: failed || (fail ?? 0) > 0 ? 'fail' : 'pass', text: hasCounts ? parts.join(', ') : failed ? 'failed' : 'passed' }
  }
  return failed ? { outcome: 'fail', text: 'issues' } : { outcome: 'pass', text: 'finished' }
}
