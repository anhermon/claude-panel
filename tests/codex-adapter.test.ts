// The codex rollout adapter on a trimmed real-shaped rollout (tests/fixtures/codex): entries, steps, the brief, the state, the model, and
// the bad input it must survive. Pure, no `$`.
import { expect, test } from 'claude-code/testing'

import { adapterOf } from '../hooks/harness-adapters'
import { CODEX, codexAdapter, rawBriefOf, sessionMetaOf } from '../hooks/harness-adapters/codex'
import type { ToolEntry } from '../hooks/transcript-parse'
import { ROLLOUT_FINISHED, ROLLOUT_SMOKE, ROLLOUT_UNFINISHED } from './fixtures/codex/fixtures'

const NOW = Date.parse('2026-11-09T10:10:00.000Z')
const MIN_MS = 60_000
const tools = (text: string): ToolEntry[] => codexAdapter.parse(text, true).entries.filter((e): e is ToolEntry => e.kind === 'tool')
const row = (type: string, payload: unknown, at = '2026-11-09T10:06:00.000Z'): string => JSON.stringify({ timestamp: at, ordinal: 1, type, payload })
const done = (item: unknown): string => row('event_msg', { type: 'item_completed', item, started_at_ms: 1000, completed_at_ms: 3000 })

/** The cumulative `total_token_usage` of the last `token_count` row, as fresh + output (what the steps must add up to). */
function finalTotal(text: string): number {
  const counts = text.split('\n').filter(l => l.includes('"token_count"'))
  const total = JSON.parse(counts.at(-1)!).payload.info.total_token_usage as { input_tokens: number; cached_input_tokens: number; output_tokens: number }
  return total.input_tokens - total.cached_input_tokens + total.output_tokens
}

test('the finished rollout: the brief (not the AGENTS.md block), 2 says, 5 tools, 5 steps, nothing else', () => {
  const p = codexAdapter.parse(ROLLOUT_FINISHED, true)
  expect(p.brief).toContain('Ticket: T99')
  expect(p.brief).not.toContain('AGENTS.md')
  expect(p.entries.filter(e => e.kind === 'say')).toHaveLength(2)
  expect(p.entries.filter(e => e.kind === 'tool')).toHaveLength(5)
  expect(p.entries.filter(e => e.kind === 'user')).toHaveLength(0) // the brief is not repeated as a message
  expect(p.steps).toHaveLength(5) // token_usage_record AND token_count are both there: one source only
  expect(p.skipped).toBe(0)
  const times = p.entries.map(e => e.t)
  expect(times).toEqual([...times].sort((a, b) => a - b))
})

test('the steps add up to the final total_token_usage: fresh = input - cached, cacheRead = cached', () => {
  const p = codexAdapter.parse(ROLLOUT_FINISHED, true)
  expect(p.steps.reduce((sum, s) => sum + s.fresh + s.output, 0)).toBe(finalTotal(ROLLOUT_FINISHED))
  expect(p.steps[0]).toMatchObject({ id: 'resp_fixture01', fresh: 18698 - 9856, output: 93, cacheRead: 9856 })
})

test('the token_count rows alone give the same steps when there is no token_usage_record', () => {
  const onlyCounts = ROLLOUT_FINISHED.split('\n').filter(l => !l.includes('"token_usage_record"')).join('\n')
  const p = codexAdapter.parse(onlyCounts, true)
  expect(p.steps).toHaveLength(5)
  expect(p.steps.reduce((sum, s) => sum + s.fresh + s.output, 0)).toBe(finalTotal(ROLLOUT_FINISHED))
})

test('the failing command is an error entry with its exit code and first output line; the passing ones are not errors', () => {
  const [pwd, fail, write, edit, selftest] = tools(ROLLOUT_FINISHED)
  expect(pwd).toMatchObject({ tool: 'Bash', label: "pwd; rg -n 'argparse' bin/report.py", error: '' })
  expect(fail).toMatchObject({ tool: 'Bash', label: 'python3 bin/report_selftest.py --quick', ms: 3500 }) // first line of the command only
  expect(fail?.error).toBe('exit 1: Traceback (most recent call last):')
  expect(write).toMatchObject({ tool: 'Write', label: 'report_json.py', error: '' })
  expect(edit).toMatchObject({ tool: 'Edit', label: 'report.py', error: '' })
  expect(selftest).toMatchObject({ tool: 'Bash', ms: 12_250, error: '' })
})

test('calls: one per tool entry, oldest first, failed only for the failing command', () => {
  const calls = codexAdapter.calls(ROLLOUT_FINISHED)
  expect(calls.map(c => c.tool)).toEqual(['Bash', 'Bash', 'Write', 'Edit', 'Bash'])
  expect(calls.map(c => c.failed)).toEqual([false, true, false, false, false])
  expect(calls[1]?.ms).toBe(3500)
})

test('state: task_complete is done; otherwise fresh mtime is running and an old one is aborted', () => {
  expect(codexAdapter.state(ROLLOUT_FINISHED, NOW - 60 * MIN_MS, NOW)).toBe('done')
  expect(codexAdapter.state(ROLLOUT_UNFINISHED, NOW - 10_000, NOW)).toBe('running')
  expect(codexAdapter.state(ROLLOUT_UNFINISHED, NOW - CODEX.RUNNING_WINDOW_MS - 1, NOW)).toBe('aborted')
})

test('model, effort, the final report and the whole brief', () => {
  expect(codexAdapter.model(ROLLOUT_FINISHED)).toEqual({ model: 'gpt-6.1-sol', effort: 'medium' })
  expect(codexAdapter.model('')).toEqual({})
  expect(codexAdapter.lastMessage(ROLLOUT_FINISHED)).toContain('Eval result: PASS')
  expect(codexAdapter.lastMessage(ROLLOUT_UNFINISHED)).toBe('')
  expect(rawBriefOf(ROLLOUT_FINISHED)).toContain('Eval: python3 bin/report_selftest.py exits 0')
})

test('the unfinished rollout has the same shape up to where it stops', () => {
  const p = codexAdapter.parse(ROLLOUT_UNFINISHED, true)
  expect(p.steps).toHaveLength(3)
  expect(p.entries.filter(e => e.kind === 'tool')).toHaveLength(4) // two commands, the new file and the edit
})

test('a tail: its cut first line is dropped, no brief is taken, a later user message stays an entry', () => {
  const lines = ROLLOUT_FINISHED.split('\n')
  const tail = `{"timestamp":"2026-11-09T10:0${lines.slice(8).join('\n')}`
  const p = codexAdapter.parse(tail, false)
  expect(p.brief).toBe('')
  expect(p.entries.length).toBeGreaterThan(0)
  const later = `${tail}\n${done({ type: 'UserMessage', content: [{ type: 'text', text: 'Also keep it short.' }] })}`
  expect(codexAdapter.parse(later, false).entries.find(e => e.kind === 'user')).toMatchObject({ text: 'Also keep it short.' })
})

test('the other tool items: MCP, web search, image view, a failed file change; unknown items and reasoning are not entries', () => {
  const text = [
    done({ type: 'McpToolCall', server: 'context-mode', tool: 'ctx_search', status: 'completed', duration: { secs: 2, nanos: 0 }, result: { content: [] } }),
    done({ type: 'McpToolCall', server: 's', tool: 't', status: 'failed', result: { isError: true, content: [{ type: 'text', text: 'boom\nmore' }] } }),
    done({ type: 'Extension', kind: 'web.search', query: 'codex rollout format', status: 'completed' }),
    done({ type: 'Extension', kind: 'image_gen.generation', result: 'AAAA' }),
    done({ type: 'ImageView', path: 'file:///work/demo/shot.png' }),
    done({ type: 'FileChange', changes: { '/work/demo/a.ts': { type: 'update' }, '/work/demo/b.ts': { type: 'update' } }, status: 'failed', stderr: 'denied\nx' }),
    done({ type: 'Reasoning', summary_text: [] }),
    done({ type: 'SomethingNew', foo: 1 }),
  ].join('\n')
  const got = tools(text)
  expect(got.map(t => t.tool)).toEqual(['mcp__context-mode__ctx_search', 'mcp__s__t', 'WebSearch', 'Read', 'Edit'])
  expect(got[0]).toMatchObject({ ms: 2000, error: '' })
  expect(got[1]?.error).toBe('failed: boom')
  expect(got[3]?.label).toBe('shot.png')
  expect(got[4]).toMatchObject({ label: 'a.ts +1', error: 'failed: denied' })
})

test('secrets in a command, a brief and an error are scrubbed', () => {
  const text = [
    row('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Do it. password=hunter2' }] }),
    done({ type: 'CommandExecution', command: ['/bin/zsh', '-lc', 'curl -H "Authorization: Bearer abcdefghij1234567890" https://x.y'], aggregated_output: 'token=sk-abcdefghijklmnopqrstuv\n', exit_code: 2, duration: { secs: 0, nanos: 0 } }),
  ].join('\n')
  const p = codexAdapter.parse(text, true)
  expect(p.brief).not.toContain('hunter2')
  const call = p.entries[0] as ToolEntry
  expect(call.label).not.toContain('abcdefghij1234567890')
  expect(call.error).not.toContain('sk-abcdefghijklmnopqrstuv')
  expect(call.error?.startsWith('exit 2: ')).toBe(true)
})

test('garbage never throws: empty, not JSON, a cut last line, unknown rows, missing fields, a huge row, odd types', () => {
  const huge = row('event_msg', { type: 'item_completed', item: { type: 'CommandExecution', command: ['x'], aggregated_output: 'y'.repeat(CODEX.MAX_ROW_CHARS) } })
  const pieces = [
    '',
    'not json at all',
    ROLLOUT_FINISHED.slice(0, -40), // the last line cut in the middle
    ROLLOUT_FINISHED.slice(0, 7_000),
    [row('brand_new_row', { type: 'x' }), '[]', 'null', '42', '{"payload":5}', row('event_msg', null), row('event_msg', { type: 'item_completed' }), row('event_msg', { type: 'item_completed', item: 7 }), row('token_usage_record', { usage: 'x' }), row('event_msg', { type: 'token_count', info: 3 })].join('\n'),
    huge,
    done({ type: 'CommandExecution', command: 12, exit_code: 'one', duration: 'long', aggregated_output: { a: 1 } }),
  ]
  for (const piece of pieces)
    for (const whole of [true, false]) {
      expect(() => codexAdapter.parse(piece, whole)).not.toThrow()
      expect(() => codexAdapter.calls(piece)).not.toThrow()
      expect(() => codexAdapter.lastMessage(piece)).not.toThrow()
      expect(() => codexAdapter.state(piece, NOW, NOW)).not.toThrow()
      expect(() => codexAdapter.model(piece)).not.toThrow()
    }
  const cut = codexAdapter.parse(ROLLOUT_FINISHED.slice(0, -40), true)
  expect(cut.skipped).toBe(1) // the cut line is counted, everything before it is kept
  expect(cut.steps).toHaveLength(5)
  expect(codexAdapter.parse(huge, true).skipped).toBe(1)
  expect(codexAdapter.parse(huge, true).entries).toEqual([])
  expect(codexAdapter.parse('', true)).toEqual({ brief: '', entries: [], steps: [], skipped: 0 })
})

test('work is bounded: more rows than MAX_ROWS are not all read', () => {
  const one = done({ type: 'ImageView', path: '/a.png' })
  const rows = Array.from({ length: CODEX.MAX_ROWS + 50 }, () => one).join('\n')
  expect(codexAdapter.parse(rows, true).entries).toHaveLength(CODEX.MAX_ROWS)
})

test('sessionMetaOf reads the first line; adapterOf knows codex only', () => {
  expect(sessionMetaOf(ROLLOUT_FINISHED.split('\n')[0]!)).toEqual({ id: '01a1bfc5-36d6-77b1-9c8a-41ccc83cfee2', startedAt: Date.parse('2026-11-09T10:05:35.369Z'), cwd: '/work/demo' })
  expect(sessionMetaOf('{"type":"user"}')).toBeUndefined()
  expect(sessionMetaOf('cut')).toBeUndefined()
  expect(adapterOf('codex-rollout')).toBe(codexAdapter)
  expect(adapterOf('agy-transcript')).toBeUndefined()
  expect(adapterOf('claude-subagent')).toBeUndefined()
  expect(adapterOf('nonsense')).toBeUndefined()
  expect(adapterOf(undefined)).toBeUndefined()
})

// ---- a real, short rollout (gpt-6.1-sol:low, one command): what the detail view needs of it ----------------------------------------
test('the real smoke rollout: the task without delegation-kit preamble, the say, the command with its wall time and result note, the report last', () => {
  const p = codexAdapter.parse(ROLLOUT_SMOKE, true)
  expect(p.brief.startsWith('Read-only task.')).toBe(true)
  expect(p.brief).not.toContain('Tools available to you')
  expect(p.briefFull).toContain('Eval: the answer lists exactly 5 files')
  expect(rawBriefOf(ROLLOUT_SMOKE)).toContain('Tools available to you') // the proof parsers get the whole text
  expect(p.entries.map(e => e.kind)).toEqual(['say', 'tool', 'say'])
  const call = p.entries[1] as ToolEntry
  // the harness says 3 microseconds (scheduling); the wall time between the call and its result is 398 ms
  expect(call).toMatchObject({ tool: 'Bash', ms: 398, error: '', act: 'run', exit: 0, note: 'exit 0 · 7798 total (+5 lines)' })
  expect(call.cmd).toContain('wc -l')
  const last = p.entries.at(-1)
  expect(last).toMatchObject({ kind: 'say' })
  expect(last?.kind === 'say' ? last.text : '').toContain('Eval result: PASS')
  expect(last?.t).toBe(Date.parse('2026-11-09T11:51:20.506Z'))
})

test('a reasoning summary is a "think" entry (markdown bold removed); one the harness kept encrypted is none', () => {
  const text = [
    done({ type: 'Reasoning', summary_text: [{ text: '**Reading the selftest** first' }, 'then the flag'] }),
    done({ type: 'Reasoning', summary_text: [] }),
  ].join('\n')
  const think = codexAdapter.parse(text, true).entries
  expect(think).toHaveLength(1)
  expect(think[0]).toMatchObject({ kind: 'think', text: 'Reading the selftest first / then the flag' })
})

test('a duration the harness reports is kept; a scheduling-time one (microseconds) gives way to the wall time', () => {
  const call = (duration: unknown): ToolEntry => {
    const text = [
      row('response_item', { type: 'custom_tool_call', name: 'exec', input: 'x' }, '2026-11-09T10:06:00.000Z'),
      row('event_msg', { type: 'item_completed', item: { type: 'CommandExecution', command: ['pwd'], exit_code: 0, aggregated_output: '', duration } }, '2026-11-09T10:06:02.000Z'),
    ].join('\n')
    return tools(text)[0] as ToolEntry
  }
  expect(call({ secs: 1, nanos: 500_000_000 }).ms).toBe(1500)
  expect(call({ secs: 0, nanos: 3000 }).ms).toBe(2000)
  expect(call(undefined).ms).toBe(2000)
})
