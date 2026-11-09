// Tiny hand-built transcripts for the progress / struggle tests: a script of steps -> Claude JSONL -> parseTranscript, so the whole chain
// (exit codes, output digests, facts of a call) is exercised and each test names only the story it tells.
import { parseTranscript } from '../hooks/transcript-parse'
import type { Parsed } from '../hooks/transcript-parse'

export const T0 = Date.parse('2026-11-08T10:00:00.000Z')
export const SEC = 1000
const at = (sec: number): string => new Date(T0 + sec * SEC).toISOString()

/** One step: a message to say and/or one tool call at `sec`, answered `took` seconds later (never answered when `took` is undefined). */
export type Step = { sec: number; say?: string; tool?: string; input?: Record<string, unknown>; took?: number; fail?: boolean; out?: string }

export const bash = (sec: number, command: string, out: string, o: { fail?: boolean; took?: number } = {}): Step =>
  ({ sec, tool: 'Bash', input: { command }, took: o.took ?? 2, fail: o.fail === true, out: o.fail === true ? `Exit code 1\n${out}` : out })
export const edit = (sec: number, file: string, o: { fail?: boolean; out?: string } = {}): Step =>
  ({ sec, tool: 'Edit', input: { file_path: file, old_string: 'a', new_string: 'b' }, took: 1, fail: o.fail === true, out: o.out ?? 'ok' })
export const write = (sec: number, file: string): Step => ({ sec, tool: 'Write', input: { file_path: file, content: 'x' }, took: 1, out: 'ok' })
export const read = (sec: number, file: string): Step => ({ sec, tool: 'Read', input: { file_path: file }, took: 1, out: 'ok' })
export const said = (sec: number, text: string): Step => ({ sec, say: text })

/** The JSONL of a script (the first line is the brief). */
export function jsonlOf(brief: string, steps: readonly Step[]): string {
  const rows: string[] = [JSON.stringify({ type: 'user', timestamp: at(0), message: { role: 'user', content: brief } })]
  steps.forEach((s, i) => {
    const content: unknown[] = []
    if (s.say !== undefined) content.push({ type: 'text', text: s.say })
    if (s.tool !== undefined) content.push({ type: 'tool_use', id: `c${i}`, name: s.tool, input: s.input ?? {} })
    rows.push(JSON.stringify({ type: 'assistant', timestamp: at(s.sec), message: { id: `m${i}`, role: 'assistant', content } }))
    if (s.tool !== undefined && s.took !== undefined)
      rows.push(JSON.stringify({ type: 'user', timestamp: at(s.sec + s.took), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `c${i}`, is_error: s.fail === true, content: s.out ?? '' }] } }))
  })
  return rows.join('\n')
}

export const parsedOf = (brief: string, steps: readonly Step[]): Parsed => parseTranscript(jsonlOf(brief, steps), true)
export const nowAfter = (steps: readonly Step[], extraSec = 5): number => T0 + ((steps[steps.length - 1]?.sec ?? 0) + extraSec) * SEC
