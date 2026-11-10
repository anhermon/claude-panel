// The detail of one agent (live/detail.json): metrics from the pulse's own record plus the transcript's token steps, struggles only for
// what happened, paging of the transcript, and "not measured" (null) where the data holds nothing. Pure: same inputs, same detail.
import { expect, test } from 'claude-code/testing'

import { buildDetail, DETAIL_CAPS, pageOf, spoken, tokenSeries } from '../hooks/agent-detail'
import type { TranscriptRead } from '../hooks/agent-detail'
import type { PulseLoop } from '../hooks/pulse-model'
import type { Entry, Parsed, ToolEntry } from '../hooks/transcript-parse'

const NOW = 1_767_000_000_000
const MIN = 60_000
const loop = (over: Partial<PulseLoop> = {}): PulseLoop => ({
  id: 'a', label: 'a', kind: 'subagent', status: 'running', lastTool: '', lastTarget: '', calls: 12, busy: 0,
  counts: { Read: 5, Edit: 4, Bash: 3 }, files: [], startedAt: NOW - 10 * MIN, lastAt: NOW, tokens: 5000,
  spans: [{ k: 'logic', t: NOW - 10 * MIN, e: NOW - 6 * MIN, n: 4 }, { k: 'tests', t: NOW - 5 * MIN, e: NOW - 3 * MIN, n: 2 }],
  tally: {
    'read:work-kinds.ts': { n: 5, err: 0, retry: 0, ms: 100 },
    'edit:board.ts': { n: 4, err: 1, retry: 0, ms: 100 },
    'run:npm test': { n: 3, err: 2, retry: 2, ms: 900 },
    'read:once.ts': { n: 1, err: 0, retry: 0, ms: 5 },
    'run:python3': { n: 37, err: 0, retry: 0, ms: 5 },
  },
  ...over,
})
const say = (t: number, text = 'hello'): Entry => ({ t, kind: 'say', text })
const tool = (t: number, over: Partial<ToolEntry> = {}): ToolEntry => ({ t, kind: 'tool', tool: 'Read', label: 'a.ts', ms: 100, error: '', ...over })
const parsed = (entries: Entry[], steps: Parsed['steps'] = [], brief = ''): Parsed => ({ brief, entries, steps, skipped: 0 })
const read = (p: Parsed, over: Partial<TranscriptRead> = {}): TranscriptRead => ({ parsed: p, head: '', isWhole: true, fileBytes: 1000, readBytes: 1000, ...over })
const subject = { id: 'a', name: 'A', isMain: false, state: 'working', startedAt: NOW - 10 * MIN, endedAt: null }
const build = (over: Partial<Parameters<typeof buildDetail>[0]> = {}) =>
  buildDetail({ subject, loop: loop(), events: [], read: read(parsed([say(NOW - MIN)])), unavailable: 'gone', pages: 1, now: NOW, ...over })

test('metrics: run time, active vs idle from the kinds, calls, tokens, tool mix and files come from the loop record', () => {
  const m = build().metrics
  expect(m.elapsedMs).toBe(10 * MIN)
  expect(m.kinds.map(k => k.kind)).toEqual(['logic', 'tests'])
  expect(m.activeMs + m.idleMs).toBe(m.elapsedMs)
  expect(m.calls).toBe(12)
  expect(m.tokens.total).toBe(5000)
  expect(m.tools).toEqual([{ tool: 'Read', n: 5 }, { tool: 'Edit', n: 4 }, { tool: 'Bash', n: 3 }])
  expect(m.files[0]).toEqual({ name: 'work-kinds.ts', reads: 5, edits: 0 })
  expect(m.files.map(f => f.name)).toContain('board.ts')
  expect(m.errors).toBe(3)
  expect(m.retries).toBe(2)
})

test('not measured stays null: no tally -> errors and retries null; no loop and no steps -> tokens null', () => {
  const bare = build({ loop: undefined, read: null }).metrics
  expect(bare.errors).toBeNull()
  expect(bare.retries).toBeNull()
  expect(bare.tokens.total).toBeNull()
  expect(bare.kinds).toEqual([])
  expect(bare.files).toEqual([])
})

test('without a pulse record the transcript still gives the token total and the call count', () => {
  const steps = [{ t: NOW - 3 * MIN, id: 'm1', fresh: 100, output: 20, cacheRead: 9000 }, { t: NOW - MIN, id: 'm2', fresh: 50, output: 30, cacheRead: 9000 }]
  const d = build({ loop: undefined, read: read(parsed([tool(NOW - 2 * MIN)], steps)) })
  expect(d.metrics.tokens.total).toBe(200)
  expect(d.metrics.calls).toBe(1)
  expect(d.metrics.tokens.series.map(p => p.tokens)).toEqual([120, 200])
})

test('tokenSeries is cumulative and thinned to the cap, keeping the first and the last point', () => {
  const steps = Array.from({ length: 200 }, (_, i) => ({ t: NOW + i, id: `m${i}`, fresh: 10, output: 0, cacheRead: 0 }))
  const series = tokenSeries(steps)
  expect(series).toHaveLength(DETAIL_CAPS.SERIES_POINTS)
  expect(series[0]).toEqual({ t: NOW, tokens: 10 })
  expect(series.at(-1)).toEqual({ t: NOW + 199, tokens: 2000 })
  expect(series.every((p, i) => i === 0 || p.tokens >= (series[i - 1] as { tokens: number }).tokens)).toBe(true)
})

test('struggles and progress are part of the detail: a failing run shows one open struggle with its quote, and the progress carries the phases', () => {
  const entries: Entry[] = [
    tool(NOW - 5 * MIN, { tool: 'Bash', label: 'npm test', ms: 3000, error: 'Error: boom', act: 'run', cmd: 'npm test', exit: 1, out: 'Error: boom' }),
    tool(NOW - 4 * MIN, { tool: 'Bash', label: 'npm test', ms: 3000, error: 'Error: boom', act: 'run', cmd: 'npm test', exit: 1, out: 'Error: boom' }),
  ]
  const d = build({ read: read(parsed(entries)) })
  const loops = d.struggles.items.filter(i => i.kind === 'failing-loop')
  expect(loops).toHaveLength(1)
  expect(loops[0]?.outcome).toBe('open')
  expect(loops[0]?.evidence).toContain('boom')
  expect(d.progress.phases.length).toBeGreaterThan(0)
  expect(d.progress.issues.openCount).toBeGreaterThan(0)
})

test('paging: the newest PAGE_ENTRIES entries are page 1, every page adds as many older ones, up to MAX_PAGES', () => {
  const entries = Array.from({ length: DETAIL_CAPS.PAGE_ENTRIES * 3 + 5 }, (_, i) => say(NOW + i, `m${i}`))
  const one = pageOf(entries, 1)
  expect(one.shown).toHaveLength(DETAIL_CAPS.PAGE_ENTRIES)
  expect(one.shown.at(-1)).toEqual(entries.at(-1))
  expect(one.hasOlder).toBe(true)
  const two = pageOf(entries, 2)
  expect(two.shown).toHaveLength(DETAIL_CAPS.PAGE_ENTRIES * 2)
  expect(two.shown.at(-1)).toEqual(entries.at(-1))
  const all = pageOf(entries, DETAIL_CAPS.MAX_PAGES + 50)
  expect(all.shown).toHaveLength(entries.length)
  expect(all.hasOlder).toBe(false)
  expect(pageOf(entries, 0).shown).toHaveLength(DETAIL_CAPS.PAGE_ENTRIES)
  expect(pageOf(entries, Number.NaN).shown).toHaveLength(DETAIL_CAPS.PAGE_ENTRIES)
})

test('the transcript part: unavailable says why; a partial read says there is more even when everything read is shown', () => {
  const none = build({ read: null }).transcript
  expect(none).toMatchObject({ isAvailable: false, reason: 'gone', entries: [], fromT: null, toT: null })
  const partial = build({ read: read(parsed([say(NOW - 2 * MIN), say(NOW - MIN)]), { isWhole: false }) }).transcript
  expect(partial).toMatchObject({ isAvailable: true, reason: '', hasMore: true, isWhole: false, fromT: NOW - 2 * MIN, toT: NOW - MIN })
  expect(build().transcript.hasMore).toBe(false)
})

test('the brief: a sub-agent shows the one it was given (the parsed one, else the first line of its file); the main session shows the latest message it got', () => {
  expect(build({ read: read(parsed([], [], 'Parsed brief')) }).brief).toBe('Parsed brief')
  expect(build({ read: read(parsed([say(NOW)]), { head: 'Head brief', isWhole: false }) }).brief).toBe('Head brief')
  const main = build({ subject: { ...subject, isMain: true }, read: read(parsed([{ t: NOW - 5, kind: 'user', text: 'first' }, say(NOW - 4), { t: NOW - 3, kind: 'user', text: 'latest' }])) })
  expect(main.brief).toBe('latest')
})

test('a finished agent measures its run to its end, not to now; same inputs give the same detail', () => {
  const done = build({ subject: { ...subject, state: 'done', endedAt: NOW - 4 * MIN }, loop: loop({ status: 'done', lastAt: NOW - 4 * MIN }) })
  expect(done.metrics.elapsedMs).toBe(6 * MIN)
  expect(JSON.stringify(build())).toBe(JSON.stringify(build()))
})

test('spoken: seconds, minutes with seconds, hours', () => {
  expect(spoken(42_000)).toBe('42 s')
  expect(spoken(200_000)).toBe('3 min 20 s')
  expect(spoken(180_000)).toBe('3 min')
  expect(spoken(7_500_000)).toBe('2 h 5 min')
})

test('no transcript file: the transcript part lists the calls the pulse recorded and the brief falls back to the loop intent', () => {
  const l = loop({ id: 'a', intent: 'Fix the grep', lastTool: 'Bash', lastTarget: 'grep tests', lastAt: NOW - MIN })
  const events = [
    { t: NOW - 3 * MIN, loop: 'a', tool: 'Read', target: 'x.ts' },
    { t: NOW - 2 * MIN, loop: 'other', tool: 'Edit', target: 'y.ts' },
    { t: NOW - 2 * MIN, loop: 'a', tool: 'Bash', target: 'npm test', err: true as const },
    { t: NOW - MIN, loop: 'a', tool: 'spawn', target: 'child' },
  ]
  const d = build({ loop: l, events, read: null })
  expect(d.brief).toBe('Fix the grep')
  expect(d.transcript).toMatchObject({ isAvailable: false, isFromPulse: true, reason: 'gone' })
  expect(d.transcript.entries).toEqual([
    { t: NOW - 3 * MIN, kind: 'tool', tool: 'Read', label: 'x.ts', ms: null, error: null },
    { t: NOW - 2 * MIN, kind: 'tool', tool: 'Bash', label: 'npm test', ms: null, error: 'call failed' },
  ])
  // the stand-ins carry no durations or messages: they add no struggle of their own beyond the tally's
  expect(d.struggles.items.filter(s => s.evidence.includes('call failed'))).toEqual([])
})

test('no transcript and an event ring that moved on: the loop\'s own last call is still listed; a forgotten loop lists nothing', () => {
  const l = loop({ lastTool: 'Bash', lastTarget: 'grep tests', lastAt: NOW - MIN })
  expect(build({ loop: l, events: [], read: null }).transcript.entries).toEqual([{ t: NOW - MIN, kind: 'tool', tool: 'Bash', label: 'grep tests', ms: null, error: null }])
  const none = build({ loop: undefined, read: null }).transcript
  expect(none).toMatchObject({ isFromPulse: false, entries: [] })
  expect(build({ loop: loop({ lastTool: '' }), events: [], read: null }).transcript.isFromPulse).toBe(false)
  expect(build().transcript.isFromPulse).toBe(false)
})

test('the tool outputs behind the logic stay in the mod: the transcript entries sent to the page carry no out, cmd, path or exit', () => {
  const e = tool(NOW - MIN, { tool: 'Bash', label: 'npm test', act: 'run', cmd: 'npm test', path: '/home/example/secret.ts', exit: 0, out: 'SECRET OUTPUT' })
  const d = build({ read: read(parsed([e])) })
  expect(JSON.stringify(d.transcript)).not.toContain('SECRET OUTPUT')
  expect(JSON.stringify(d.transcript)).not.toContain('secret.ts')
})


test('Claude token split, unpaired failures, API struggles and turn stats reach detail metrics', () => {
  const p: Parsed = {
    ...parsed([tool(NOW, { error: 'failed' })], [{ t: NOW, id: 'request', fresh: 100, output: 20, cacheRead: 900 }]),
    failedCalls: 4, apiErrors: 2, apiError: { t: NOW - MIN, lastT: NOW, text: 'Quota exceeded' },
    turns: { count: 2, lastMs: 3000, avgMs: 2000, maxMs: 3000 },
  }
  const d = build({ read: read(p) })
  expect(d.metrics.tokens).toMatchObject({ fresh: 100, cached: 900, output: 20 })
  expect(d.metrics.errors).toBe(6)
  expect(d.metrics.apiErrors).toBe(2)
  expect(d.metrics.turns).toEqual(p.turns)
  expect(d.struggles.items[0]).toMatchObject({ title: 'API requests failed', n: 2, evidence: 'Quota exceeded', outcome: 'open' })
  expect(d.struggles.open).toBe(d.struggles.items.filter(i => i.outcome === 'open').length)
  expect(build({ loop: undefined, read: read(p) }).metrics.errors).toBe(6)
  expect(build({ read: read({ ...p, failedCalls: 0, apiErrors: 0 }) }).metrics.errors).toBe(3)
  expect(build({ loop: undefined, read: read({ ...p, failedCalls: 0, apiErrors: 0 }) }).metrics.errors).toBe(1)
})
