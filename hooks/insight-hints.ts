// The `improve` frame: up to HINTS_MAX suggestions, each backed by a number measured on this session and the rule (a named
// setting) that fired it. A rule that is not met says nothing: there is no filler hint. The rules, in this order:
//   tests     tests and checks took `hintTestsPct` % or more of all agent time
//   reading   agents read or searched `hintReadingPct` % or more of their time before their first edit
//   shared    `hintSharedFiles` or more files were each read by `hintSharedAgents` or more agents
//   retries   commands were run again right after failing `hintRetries` times or more in all
// Pure: no `$`, no I/O.
import type { BoardFrame, HintItem } from '../types'
import { commandUses, fileUses } from './insight-repeats'
import { formatDuration, percentOf, plural } from './insight-format'
import { kindMs, pickLoops } from './insight-time'
import type { Subject } from './insight-time'
import { panelConfig } from './panel-config'
import type { PulseLoop } from './pulse-model'
import { segmentsOf } from './work-spans'

export const HINTS_FRAME_ID = 'improve'
export const HINTS_MAX = 4
const TITLE = 'What to improve'
const TEXT_CHARS = 140
const EVIDENCE_CHARS = 120
const RULE_CHARS = 120
const NAMES_LISTED = 3
const NAMES_JOIN = ', '
/** The kinds that make something: reading before the first of these is "reading before any edit". */
const MAKING_KINDS: readonly string[] = ['ui', 'logic', 'docs']
const READING_KINDS: readonly string[] = ['reading', 'research']
/** A test command run at least this many times is named in the tests hint. */
const RERUN_NAMED_MIN = 3
/** A command whose target names a test run, a type check, a lint or another check. */
const TEST_COMMAND = /test|tsc|lint|check/

const item = (text: string, evidence: string, rule: string): HintItem => ({ text: text.slice(0, TEXT_CHARS), evidence: evidence.slice(0, EVIDENCE_CHARS), rule: rule.slice(0, RULE_CHARS) })

function testsHint(subjects: readonly Subject[], loops: readonly PulseLoop[]): HintItem | undefined {
  const total = subjects.reduce((a, s) => a + s.totalMs, 0)
  const tests = kindMs(subjects, 'tests')
  const pct = percentOf(tests, total)
  if (total <= 0 || pct < panelConfig.hintTestsPct) return undefined
  const rerun = commandUses(loops).find(c => c.runs >= RERUN_NAMED_MIN && TEST_COMMAND.test(c.target))
  const again = rerun === undefined ? '' : `; "${rerun.target}" ran ${rerun.runs} times`
  return item(
    'Run affected tests while working; the full suite once at the end.',
    `Tests took ${pct}% of agent time (${formatDuration(tests)} of ${formatDuration(total)})${again}`,
    `Rule: tests and checks at ${panelConfig.hintTestsPct}% of agent time or more (setting hintTestsPct).`,
  )
}

/** Time an agent spent reading or searching before its first edit; undefined for an agent that never edited. */
function readingBeforeEdit(s: Subject): number | undefined {
  let reading = 0
  for (const seg of segmentsOf(s.spans, s.end)) {
    if (MAKING_KINDS.includes(seg.k)) return reading
    if (READING_KINDS.includes(seg.k)) reading += seg.b - seg.a
  }
  return undefined
}

function readingHint(subjects: readonly Subject[]): HintItem | undefined {
  const editors = subjects.map(s => ({ s, ms: readingBeforeEdit(s) })).filter((x): x is { s: Subject; ms: number } => x.ms !== undefined)
  const total = editors.reduce((a, x) => a + x.s.totalMs, 0)
  const reading = editors.reduce((a, x) => a + x.ms, 0)
  const pct = percentOf(reading, total)
  if (editors.length === 0 || pct < panelConfig.hintReadingPct) return undefined
  return item(
    'Name the files to change in the brief, or give a file map.',
    `Reading before the first edit took ${pct}% of agent time (${formatDuration(reading)} of ${formatDuration(total)}, ${plural(editors.length, 'agent')})`,
    `Rule: reading before the first edit at ${panelConfig.hintReadingPct}% of agent time or more (setting hintReadingPct).`,
  )
}

function sharedHint(loops: readonly PulseLoop[]): HintItem | undefined {
  const shared = fileUses(loops).filter(u => [...u.byLoop.values()].filter(x => x.reads > 0).length >= panelConfig.hintSharedAgents)
  if (shared.length < panelConfig.hintSharedFiles) return undefined
  const names = shared.slice(0, NAMES_LISTED).map(u => u.file).join(NAMES_JOIN)
  return item(
    'Put these files in the brief so each agent skips re-reading them.',
    `${plural(shared.length, 'file')} read by ${panelConfig.hintSharedAgents}+ agents each: ${names}${shared.length > NAMES_LISTED ? ', ...' : ''}`,
    `Rule: ${panelConfig.hintSharedFiles}+ files read by ${panelConfig.hintSharedAgents}+ agents each (settings hintSharedFiles, hintSharedAgents).`,
  )
}

function retriesHint(loops: readonly PulseLoop[]): HintItem | undefined {
  const commands = commandUses(loops)
  const retries = commands.reduce((a, c) => a + c.retries, 0)
  if (retries < panelConfig.hintRetries) return undefined
  const top = [...commands].sort((a, b) => b.retries - a.retries)[0]
  return item(
    'Read why a command failed before re-running it; put known fixes in the brief.',
    `Re-ran straight after failing ${retries} times; most often "${top?.target ?? ''}" (${top?.retries ?? 0})`,
    `Rule: ${panelConfig.hintRetries}+ immediate re-runs after a failure (setting hintRetries).`,
  )
}

/** The `improve` frame, or undefined when no rule fired (or there is too little time measured to judge). */
export function hintsFrame(allLoops: readonly PulseLoop[], subjects: readonly Subject[]): BoardFrame | undefined {
  const loops = pickLoops(allLoops)
  const items = [testsHint(subjects, loops), readingHint(subjects), sharedHint(loops), retriesHint(loops)]
    .filter((h): h is HintItem => h !== undefined)
    .slice(0, HINTS_MAX)
  if (subjects.length === 0 || items.length === 0) return undefined
  return { id: HINTS_FRAME_ID, type: 'hints', title: TITLE, size: 'm', items }
}
