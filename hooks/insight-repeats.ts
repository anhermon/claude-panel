// What the agents did over and over, from the per-loop tally the pulse keeps (hooks/pulse-tally.ts): the same file read or
// edited again and again (a file x agent matrix), the same command run again and again (tests, type checks), commands run
// again right after they failed, and several agents started on the same kind of task. Only what is measured is reported:
// a file is known by its basename (two files with one name count as one), a command by its program and verb (`npm test`; a
// script run through `node` is just `node`), and the time cost is the time the calls themselves took (not the model's time
// reading the result). Pure: no `$`, no I/O.
import type { BoardFrame, RepeatRow } from '../types'
import { plainTitle } from './agent-roles'
import { nameOf } from './board-agents'
import { formatDuration, plural } from './insight-format'
import { MAIN_NAME, pickLoops } from './insight-time'
import type { Subject } from './insight-time'
import { panelConfig } from './panel-config'
import { MAIN_LOOP } from './pulse-model'
import type { PulseLoop } from './pulse-model'
import { splitKey, TALLY_VERBS } from './pulse-tally'
import { KIND_META, kindOf } from './work-kinds'

export const REPEAT_FRAME_ID = 'repeats'
export const REPEAT_CAPS = { COLS: 5, ROWS: 5, NOTES: 4, COMMAND_NOTES: 2, COL_CHARS: 14, LABEL_CHARS: 28, NOTE_CHARS: 140, HEADLINE_CHARS: 160 } as const
const TITLE = 'Repeated work'
const FOOT = 'Numbers = times each agent read or edited the file'
const TIMES_MARK = '×'
const NOTE_JOIN = ' · '
/** The suggested action closing each note, at most 12 words. */
const ACTIONS = {
  command: 'run it once, after the change is done',
  retry: 'read the error before re-running',
  similar: 'merge them into one brief',
} as const
const UNNAMED_AGENT = 'agent'
const NAME_WORD = /^[a-z]{3,}$/i
const NAME_WORDS_LOOKED_AT = 2
/** Programs that run any script: their target says nothing about WHAT ran, so repeats of them are not reported as a command. */
const GENERIC_RUNNERS: readonly string[] = ['node', 'npx', 'python', 'python3', 'bun', 'deno', 'tsx', 'bash', 'sh', 'zsh']
const BASH = 'Bash'

export type FileUse = { file: string; reads: number; edits: number; touches: number; byLoop: Map<string, { reads: number; edits: number }> }
export type CommandUse = { target: string; runs: number; failed: number; retries: number; ms: number; loops: Set<string> }

const loopName = (loop: PulseLoop): string => (loop.id === MAIN_LOOP ? MAIN_NAME : plainTitle(nameOf(loop)))

/** Every file the loops read or edited, with the counts, most touched first. */
export function fileUses(loops: readonly PulseLoop[]): FileUse[] {
  const by = new Map<string, FileUse>()
  for (const loop of loops)
    for (const [key, e] of Object.entries(loop.tally ?? {})) {
      const { verb, target } = splitKey(key)
      if (verb !== TALLY_VERBS.READ && verb !== TALLY_VERBS.EDIT) continue
      const use = by.get(target) ?? { file: target, reads: 0, edits: 0, touches: 0, byLoop: new Map() }
      const mine = use.byLoop.get(loop.id) ?? { reads: 0, edits: 0 }
      if (verb === TALLY_VERBS.READ) { use.reads += e.n; mine.reads += e.n } else { use.edits += e.n; mine.edits += e.n }
      use.touches += e.n
      use.byLoop.set(loop.id, mine)
      by.set(target, use)
    }
  return [...by.values()].sort((a, b) => b.touches - a.touches)
}

/** Every command (program + verb) the loops ran, with the counts, most run first. */
export function commandUses(loops: readonly PulseLoop[]): CommandUse[] {
  const by = new Map<string, CommandUse>()
  for (const loop of loops)
    for (const [key, e] of Object.entries(loop.tally ?? {})) {
      const { verb, target } = splitKey(key)
      if (verb !== TALLY_VERBS.RUN) continue
      const use = by.get(target) ?? { target, runs: 0, failed: 0, retries: 0, ms: 0, loops: new Set() }
      use.runs += e.n
      use.failed += e.err
      use.retries += e.retry
      use.ms += e.ms
      use.loops.add(loop.id)
      by.set(target, use)
    }
  return [...by.values()].sort((a, b) => b.runs - a.runs)
}

/** A command a note can name: not a bare script runner, and not a program that only looks at things (that is reading, not a repeated command). */
const isNamable = (c: CommandUse): boolean => (c.target.includes(' ') || !GENERIC_RUNNERS.includes(c.target)) && kindOf({ tool: BASH, target: c.target }) !== 'reading'

/** The first plain word of an agent's name (3+ letters among its first words): the sort of task it was started on. '' for none. */
export function taskWord(name: string): string {
  const word = name.split(/\s+/).slice(0, NAME_WORDS_LOOKED_AT).find(w => NAME_WORD.test(w) && w.toLowerCase() !== UNNAMED_AGENT)
  return word === undefined ? '' : word.toLowerCase()
}

/** Groups of agents started on the same kind of task: the same first word of their name and the same main kind of work. */
export function similarTasks(subjects: readonly Subject[]): { word: string; kind: string; names: string[] }[] {
  const groups = new Map<string, { word: string; kind: string; names: string[] }>()
  for (const s of subjects) {
    if (s.loop.id === MAIN_LOOP) continue
    const word = taskWord(s.name)
    const main = [...s.byKind].filter(([k]) => k !== 'thinking').sort((a, b) => b[1] - a[1])[0]?.[0]
    if (word === '' || main === undefined) continue
    const group = groups.get(`${word}|${main}`) ?? { word, kind: KIND_META[main].label, names: [] }
    group.names.push(s.name)
    groups.set(`${word}|${main}`, group)
  }
  return [...groups.values()].filter(g => g.names.length >= panelConfig.similarMin).sort((a, b) => b.names.length - a.names.length)
}

const filesNote = (u: FileUse): string => {
  const parts = [u.reads > 0 ? plural(u.reads, 'read') : '', u.edits > 0 ? plural(u.edits, 'edit') : ''].filter(p => p !== '')
  return parts.join(' · ')
}

/** The sentences: commands run again and again, commands re-run right after failing, tasks started more than once. */
export function repeatNotes(loops: readonly PulseLoop[], subjects: readonly Subject[]): string[] {
  const commands = commandUses(loops)
  const notes: string[] = []
  for (const c of commands.filter(x => x.runs >= panelConfig.repeatMin && isNamable(x)).slice(0, REPEAT_CAPS.COMMAND_NOTES)) {
    const where = c.loops.size > 1 ? plural(c.loops.size, 'agent') : ''
    notes.push([`${c.target} ${TIMES_MARK}${c.runs}`, formatDuration(c.ms), where, ACTIONS.command].filter(p => p !== '').join(NOTE_JOIN))
  }
  const retried = commands.filter(c => c.retries >= panelConfig.retryMin).sort((a, b) => b.retries - a.retries)[0]
  if (retried !== undefined) notes.push([`${retried.target} re-run after failing ${TIMES_MARK}${retried.retries}`, ACTIONS.retry].join(NOTE_JOIN))
  const task = similarTasks(subjects)[0]
  if (task !== undefined) notes.push([`${plural(task.names.length, 'agent')} on similar "${task.word}" tasks, mostly ${task.kind.toLowerCase()}`, ACTIONS.similar].join(NOTE_JOIN))
  return notes.map(n => n.slice(0, REPEAT_CAPS.NOTE_CHARS)).slice(0, REPEAT_CAPS.NOTES)
}

/** The finding: the file touched most, and the command run most (each only when there is one). */
export function repeatsHeadline(files: readonly FileUse[], commands: readonly CommandUse[]): string {
  const file = files[0]
  const command = commands.filter(c => c.runs >= panelConfig.repeatMin && isNamable(c))[0]
  const parts = [
    file === undefined ? '' : `${file.file} was touched ${plural(file.touches, 'time')} by ${plural(file.byLoop.size, 'agent')}`,
    command === undefined ? '' : `${command.target} ran ${plural(command.runs, 'time')} (${formatDuration(command.ms)})`,
  ].filter(p => p !== '')
  return parts.join('; ')
}

/** The `repeats` frame: files touched `repeatMin`+ times in a file x agent matrix, plus the sentences; undefined when nothing repeats. */
export function repeatsFrame(loops: readonly PulseLoop[], subjects: readonly Subject[]): BoardFrame | undefined {
  const picked = pickLoops(loops)
  const files = fileUses(picked).filter(u => u.touches >= panelConfig.repeatMin).slice(0, REPEAT_CAPS.ROWS)
  const touchesBy = (id: string): number => files.reduce((a, u) => a + (u.byLoop.get(id)?.reads ?? 0) + (u.byLoop.get(id)?.edits ?? 0), 0)
  const cols = picked.filter(l => touchesBy(l.id) > 0).sort((a, b) => touchesBy(b.id) - touchesBy(a.id)).slice(0, REPEAT_CAPS.COLS)
  const rows: RepeatRow[] = files.map(u => ({
    label: u.file.slice(0, REPEAT_CAPS.LABEL_CHARS),
    cells: cols.map(l => (u.byLoop.get(l.id)?.reads ?? 0) + (u.byLoop.get(l.id)?.edits ?? 0)),
    note: filesNote(u),
  }))
  const notes = repeatNotes(picked, subjects)
  const headline = repeatsHeadline(files, commandUses(picked))
  if (rows.length === 0 && notes.length === 0) return undefined
  return {
    id: REPEAT_FRAME_ID,
    type: 'repeats',
    title: TITLE,
    size: 'l',
    ...(headline === '' ? {} : { caption: headline.slice(0, REPEAT_CAPS.HEADLINE_CHARS) }),
    ...(rows.length === 0 ? {} : { foot: FOOT }),
    cols: cols.map(l => loopName(l).slice(0, REPEAT_CAPS.COL_CHARS)),
    rows,
    ...(notes.length === 0 ? {} : { notes }),
  }
}
