// The transcript JSONL -> entries: texts and tool calls with how long they took and whether they failed, the brief, one token step per
// model request, and a cut first line when only the END of the file was read. Tool outputs and thinking are never kept.
import { expect, test } from 'claude-code/testing'

import { briefOf, parseTranscript } from '../hooks/transcript-parse'
import type { ToolEntry } from '../hooks/transcript-parse'

const T0 = Date.parse('2026-11-08T10:00:00.000Z')
const at = (sec: number): string => new Date(T0 + sec * 1000).toISOString()
const line = (o: unknown): string => JSON.stringify(o)
const user = (sec: number, content: unknown) => line({ type: 'user', timestamp: at(sec), message: { role: 'user', content } })
const asst = (sec: number, id: string, content: unknown[], usage?: Record<string, number>) =>
  line({ type: 'assistant', timestamp: at(sec), message: { id, role: 'assistant', content, ...(usage ? { usage } : {}) } })
const call = (id: string, name: string, input: Record<string, unknown>) => ({ type: 'tool_use', id, name, input })

const FILE = [
  user(0, 'You are a worker on T40. password=hunter2 Do the thing.'),
  asst(5, 'm1', [{ type: 'thinking', thinking: 'secret reasoning' }, { type: 'text', text: 'Reading the model.' }, call('c1', 'Read', { file_path: '/home/example/p/board.ts' })], { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 100, cache_read_input_tokens: 5000 }),
  user(7, [{ type: 'tool_result', tool_use_id: 'c1', content: 'FILE CONTENTS SHOULD NOT SURVIVE' }]),
  asst(8, 'm2', [call('c2', 'Bash', { command: 'npm test' })], { input_tokens: 4, output_tokens: 6, cache_creation_input_tokens: 0, cache_read_input_tokens: 6000 }),
  asst(8, 'm2', [{ type: 'text', text: 'Running the tests.' }], { input_tokens: 4, output_tokens: 6, cache_creation_input_tokens: 0, cache_read_input_tokens: 6000 }),
  user(70, [{ type: 'tool_result', tool_use_id: 'c2', is_error: true, content: 'Error: 2 failed\nstack\nstack' }]),
  user(80, '<system-reminder>harness</system-reminder>'),
  user(90, 'Also keep it short.'),
  'not json at all',
].join('\n')

test('a whole file: the first user message is the brief (scrubbed), the rest are entries in order', () => {
  const p = parseTranscript(FILE, true)
  expect(p.brief).toContain('You are a worker on T40')
  expect(p.brief).not.toContain('hunter2')
  expect(p.entries.map(e => e.kind)).toEqual(['say', 'tool', 'tool', 'say', 'user'])
  expect(p.entries[0]).toMatchObject({ kind: 'say', text: 'Reading the model.' })
  expect(p.entries.at(-1)).toMatchObject({ kind: 'user', text: 'Also keep it short.' })
  expect(p.skipped).toBe(1)
})

test('a tool call gets its label, its duration (to the line with its result) and the first line of its error; outputs are dropped', () => {
  const tools = parseTranscript(FILE, true).entries.filter((e): e is ToolEntry => e.kind === 'tool')
  expect(tools[0]).toMatchObject({ tool: 'Read', label: 'board.ts', ms: 2000, error: '' })
  expect(tools[1]).toMatchObject({ tool: 'Bash', label: 'npm test', ms: 62_000, error: 'Error: 2 failed' })
  expect(JSON.stringify(parseTranscript(FILE, true))).not.toContain('SHOULD NOT SURVIVE')
  expect(JSON.stringify(parseTranscript(FILE, true))).not.toContain('secret reasoning')
})

test('a call without a result yet has ms and error null (it is still running)', () => {
  const p = parseTranscript(asst(1, 'a', [call('x', 'Edit', { file_path: '/p/a.ts' })]), true)
  expect(p.entries[0]).toMatchObject({ kind: 'tool', ms: null, error: null })
})

test('usage is counted once per model request even when its lines repeat it: fresh = input + cache creation, cache reads kept apart', () => {
  const { steps } = parseTranscript(FILE, true)
  expect(steps).toHaveLength(2)
  expect(steps[0]).toMatchObject({ id: 'm1', fresh: 110, output: 20, cacheRead: 5000 })
  expect(steps[1]).toMatchObject({ id: 'm2', fresh: 4, output: 6 })
})

test('the END of a file: its cut first line is dropped, nothing is taken as the brief, and a later user message stays an entry', () => {
  const tail = FILE.slice(FILE.indexOf('"id":"m1"') - 20)
  const p = parseTranscript(tail, false)
  expect(p.brief).toBe('')
  expect(p.skipped).toBe(1)
  expect(p.entries.some(e => e.kind === 'say' && e.text === 'Reading the model.')).toBe(false) // that line was the cut one
  expect(p.entries.some(e => e.kind === 'user')).toBe(true)
})

test('harness messages are not entries; briefOf reads the first line of a file and gives nothing for non-user or harness lines', () => {
  expect(parseTranscript(user(1, '<task-notification>done</task-notification>'), true).entries).toEqual([])
  expect(briefOf(user(0, [{ type: 'text', text: 'Brief text' }]))).toBe('Brief text')
  expect(briefOf(asst(0, 'a', []))).toBe('')
  expect(briefOf('{"cut')).toBe('')
  expect(briefOf(user(0, '<system-reminder>x</system-reminder>'))).toBe('')
})

test('garbage never throws: empty text, lines without timestamps or messages', () => {
  expect(parseTranscript('', true).entries).toEqual([])
  expect(parseTranscript('{}\n{"type":"user"}\n[]\n123', true).entries).toEqual([])
})

test('neutral facts for the progress logic: act, path, cmd, exit code and a short digest of a run\'s output; briefFull keeps the line breaks', () => {
  const file = [
    user(0, 'Task:\n1. Do a\n2. Do b'),
    asst(1, 'a1', [call('r', 'Edit', { file_path: '/p/hooks/a.ts', old_string: 'x', new_string: 'y' }), call('t', 'Bash', { command: 'node --test x' })]),
    user(3, [{ type: 'tool_result', tool_use_id: 'r', content: 'ok' }]),
    user(5, [{ type: 'tool_result', tool_use_id: 't', is_error: true, content: 'Exit code 2\nnot ok 1 - a\n  expected 1, got 2' }]),
  ].join('\n')
  const p = parseTranscript(file, true)
  expect(p.briefFull).toBe('Task:\n1. Do a\n2. Do b')
  const [edit, run] = p.entries as ToolEntry[]
  expect(edit).toMatchObject({ act: 'edit', path: '/p/hooks/a.ts' })
  expect(edit?.out).toBeUndefined()
  expect(run).toMatchObject({ act: 'run', cmd: 'node --test x', exit: 2 })
  expect(run?.out).toContain('expected 1, got 2')
  expect(run?.out).not.toContain('Exit code')
})


test('API errors and failed results are counted without matching calls or valid timestamps; bulk rows skip JSON parsing', () => {
  const result = { type: 'tool_result', tool_use_id: 'outside-tail', is_error: true, content: 'failed' }
  const p = parseTranscript([
    line({ isApiErrorMessage: true, type: 'assistant', timestamp: at(1), message: { content: [{ type: 'text', text: 'Overloaded' }] } }),
    user(2, [result, { ...result, tool_use_id: 'another' }, { ...result, is_error: false }]),
    line({ type: 'user', message: { content: [result] } }),
    '{"type":"api-request broken',
    '{"type":"file-history-snapshot broken',
  ].join('\n'), true)
  expect(p.apiErrors).toBe(1)
  expect(p.failedCalls).toBe(3)
  expect(p.apiError).toEqual({ t: T0 + 1000, lastT: T0 + 1000, text: 'Overloaded' })
  expect(p.skipped).toBe(0)
})

test('turn durations need no message or timestamp; invalid durations are ignored and zero is valid', () => {
  const durations = [1000, 3000, 2000, -1, 'bad', null, 0]
  const p = parseTranscript(durations.map(durationMs => line({ type: 'system', subtype: 'turn_duration', durationMs })).join('\n'), true)
  expect(p.turns).toEqual({ count: 4, lastMs: 0, avgMs: 1500, maxMs: 3000 })
  expect(parseTranscript('', true).turns).toEqual({ count: 0, lastMs: 0, avgMs: 0, maxMs: 0 })
})

test('session metadata: parseTranscript extracts the latest assistant model (ignoring <synthetic>), gitBranch and ai-title', () => {
  const file = [
    JSON.stringify({ type: 'user', gitBranch: 'feat/waiting-badge', timestamp: new Date(T0).toISOString(), message: { content: 'Start task' } }),
    JSON.stringify({ type: 'ai-title', aiTitle: 'Add search box to notes rows' }),
    JSON.stringify({ type: 'assistant', timestamp: new Date(T0 + 1000).toISOString(), message: { id: 'm1', model: 'claude-sonnet-4-6', content: [{ type: 'text', text: 'First reply' }] } }),
    JSON.stringify({ type: 'assistant', timestamp: new Date(T0 + 2000).toISOString(), message: { id: 'm2', model: '<synthetic>', content: [{ type: 'text', text: 'Synthetic' }] } }),
  ].join('\n')
  const p = parseTranscript(file, true)
  expect(p.model).toBe('claude-sonnet-4-6')
  expect(p.branch).toBe('feat/waiting-badge')
  expect(p.title).toBe('Add search box to notes rows')
})
