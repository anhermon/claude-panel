// The workflow-insight frames, from synthetic loops: the tally the pulse keeps, time by kind, the sinks, repeats, hints, the
// validators of the four frame types and the auto frames on the board. Deterministic: every clock is an argument.
import { expect, test } from 'claude-code/testing'

import { assembleFrames, newBoardModel } from '../hooks/board-model'
import type { BoardInput } from '../hooks/board-model'
import { validateFrame } from '../hooks/board-frames'
import { hintsFrame, HINTS_FRAME_ID } from '../hooks/insight-hints'
import { formatDuration, formatTokens, percentShares, plural } from '../hooks/insight-format'
import { insightFrames, INSIGHT_FRAME_IDS } from '../hooks/insight-frames'
import { repeatsFrame, similarTasks, taskWord } from '../hooks/insight-repeats'
import { kindStackFrame, sinksFrame, stretchNotes, subjectsOf } from '../hooks/insight-time'
import { applyOptions } from '../hooks/panel-config'
import { beginCall, endCall, MAIN_LOOP, newModel } from '../hooks/pulse-model'
import type { PulseLoop } from '../hooks/pulse-model'
import { restoreTally, splitKey, TALLY_CAPS, tallyKey } from '../hooks/pulse-tally'
import type { Tally } from '../hooks/pulse-tally'
import type { Span } from '../hooks/work-spans'
import type { WorkKind } from '../hooks/work-kinds'

const NOW = 1_767_000_000_000
const SEC = 1000
const BASE: BoardInput = { task: null, status: 'working', ask: null, choices: [], lanes: [], loops: [], pulse: undefined, now: NOW }

/** A finished agent that started `ran` seconds before NOW. */
const agent = (id: string, name: string, ran: number, spans: Span[] = [], over: Partial<PulseLoop> = {}): PulseLoop => ({
  id, label: name, name, kind: 'subagent', status: 'done', lastTool: '', lastTarget: '', calls: 1, busy: 0, counts: {}, files: [],
  startedAt: NOW - ran * SEC, lastAt: NOW, spans, ...over,
})
const span = (k: WorkKind, from: number, to: number): Span => ({ k, t: NOW - from * SEC, e: NOW - to * SEC, n: 3 })
const tallyOf = (entries: Record<string, [number, number?, number?, number?]>): Tally =>
  Object.fromEntries(Object.entries(entries).map(([k, [n, err = 0, retry = 0, ms = 0]]) => [k, { n, err, retry, ms }]))

/** A: 200 s, logic 70 s then tests 60 s (and 70 s of pauses). B: 100 s, reading 40 s (and 60 s of pauses). */
const A = agent('a', 'writer one', 200, [span('logic', 200, 150), span('tests', 100, 60)], { tokens: 12_000 })
const B = agent('b', 'writer two', 100, [span('reading', 100, 80)])

test('formatters: durations and tokens always carry their unit, shares add up to 100', () => {
  expect(formatDuration(42_000)).toBe('42 s')
  expect(formatDuration(200_000)).toBe('3 min 20 s')
  expect(formatDuration(180_000)).toBe('3 min')
  expect(formatDuration(7_500_000)).toBe('2 h 05 min')
  expect(formatTokens(850)).toBe('850 tokens')
  expect(formatTokens(4_250)).toBe('4.3k tokens')
  expect(formatTokens(42_400)).toBe('42k tokens')
  expect(formatTokens(1_200_000)).toBe('1.2M tokens')
  expect(plural(1, 'agent')).toBe('1 agent')
  expect(plural(3, 'agent')).toBe('3 agents')
  expect(percentShares([130, 70, 60, 40]).reduce((a, b) => a + b, 0)).toBe(100)
  expect(percentShares([0, 0])).toEqual([0, 0])
})

test('tally: calls, failures, retries and time per read / edit / run; a retry is the same call right after it failed', () => {
  expect(tallyKey('Read', 'a.ts')).toBe('read:a.ts')
  expect(tallyKey('Bash', 'npm test')).toBe('run:npm test')
  expect(tallyKey('Grep', 'x')).toBeUndefined()
  expect(tallyKey('Read', '')).toBeUndefined()
  expect(splitKey('run:npm test')).toEqual({ verb: 'run', target: 'npm test' })

  const m = newModel(NOW)
  const run = (t: number, failed: boolean) => endCall(m, t + 2 * SEC, 'a', beginCall(m, t, 'a', 'Bash', 'npm test'), failed)
  run(NOW, true)
  run(NOW + 10 * SEC, true) // a retry that failed again
  run(NOW + 20 * SEC, false) // a retry that worked
  run(NOW + 30 * SEC, false) // a plain re-run: not a retry
  expect(m.loops.get('a')?.tally?.['run:npm test']).toEqual({ n: 4, err: 2, retry: 2, ms: 8 * SEC })
  expect(m.loops.get('a')?.failedKey).toBeUndefined()
  expect(m.loops.get(MAIN_LOOP)?.tally).toBeUndefined() // nothing counted, nothing kept
})

test('tally: past the key cap the least-used key goes, junk in a stored tally is dropped', () => {
  const m = newModel(NOW)
  for (let i = 0; i < 3; i++) beginCall(m, NOW + i, 'a', 'Read', 'hot.ts')
  for (let i = 0; i < TALLY_CAPS.KEYS + 5; i++) beginCall(m, NOW + 10 + i, 'a', 'Read', `f${i}.ts`)
  const keys = Object.keys(m.loops.get('a')?.tally ?? {})
  expect(keys).toHaveLength(TALLY_CAPS.KEYS)
  expect(keys).toContain('read:hot.ts')
  const stored = { 'read:a.ts': { n: 2, err: 1, retry: 0, ms: 5 }, bad: 7, 'read:z.ts': { n: 0 }, [`read:${'x'.repeat(80)}`]: { n: 1 } }
  expect(restoreTally(stored)).toEqual({ 'read:a.ts': { n: 2, err: 1, retry: 0, ms: 5 } })
  expect(restoreTally([1, 2])).toEqual({})
  expect(restoreTally(null)).toEqual({})
})

test('time by kind: a stacked bar per agent, longest kind first, pauses as thinking, durations in words', () => {
  const subjects = subjectsOf([A, B], [], NOW)
  expect(subjects.map(s => s.name)).toEqual(['writer one', 'writer two'])
  const frame = kindStackFrame(subjects)
  expect(frame).toMatchObject({ id: 'time-by-kind', type: 'kindstack' })
  const items = (frame as { items: { label: string; total: string; tokens?: string; segs: { k: string; s: number; text: string }[] }[] }).items
  expect(items[0]).toEqual({
    label: 'writer one', total: '3 min 20 s', tokens: '12k tokens',
    segs: [{ k: 'logic', s: 70, text: '1 min 10 s' }, { k: 'thinking', s: 70, text: '1 min 10 s' }, { k: 'tests', s: 60, text: '1 min' }],
  })
  expect(items[1]).toMatchObject({ label: 'writer two', total: '1 min 40 s', segs: [{ k: 'thinking', s: 60 }, { k: 'reading', s: 40 }] })
  expect(items[1]).not.toHaveProperty('tokens') // no tokens reported, none claimed
  expect(validateFrame(frame)).toEqual(frame)
})

test('time by kind: agents win over the main session; the main session alone is shown; too little time says nothing', () => {
  const main = agent(MAIN_LOOP, 'Main', 200, [span('logic', 200, 150)], { kind: 'main' })
  expect(subjectsOf([main, A], [], NOW).map(s => s.name)).toEqual(['writer one'])
  expect(subjectsOf([main], [], NOW).map(s => s.name)).toEqual(['Main session'])
  const brief = agent('c', 'brief', 10, [span('logic', 10, 5)])
  expect(subjectsOf([brief], [], NOW)).toEqual([])
  expect(kindStackFrame([])).toBeUndefined()
  expect(sinksFrame([])).toBeUndefined()
  expect(insightFrames([brief], [], NOW)).toEqual([])
  applyOptions({ insightMinSeconds: 5 })
  expect(subjectsOf([brief], [], NOW)).toHaveLength(1)
  applyOptions({})
})

test('sinks: kinds ranked by share of all agent time (adding up to 100), tokens split by time and called estimated, long stretches in words', () => {
  const subjects = subjectsOf([A, B], [], NOW)
  const frame = sinksFrame(subjects)
  const items = (frame as { items: { k: string; pct: number; text: string }[]; notes?: string[] }).items
  expect(items.map(i => [i.k, i.pct])).toEqual([['thinking', 44], ['logic', 23], ['tests', 20], ['reading', 13]])
  expect(items.reduce((a, i) => a + i.pct, 0)).toBe(100)
  expect(items[1]?.text).toBe('1 min 10 s across 1 agent · about 4.2k tokens (estimated)')
  expect(items[3]?.text).toBe('40 s across 1 agent') // writer two reported no tokens
  const notes = stretchNotes(subjects)
  expect(notes).toHaveLength(2) // logic 70 s and tests 60 s; reading 40 s is too short to be a long stretch
  expect(notes[0]).toBe('1 min 10 s writing logic · writer one')
  expect(items[1]).toMatchObject({ time: '1 min 10 s', meta: '1 agent · ~4.2k tok' })
  expect(items[3]).toMatchObject({ time: '40 s', meta: '1 agent' })
  // the headline is the finding, not an explanation of the chart; the method is one short foot line
  expect((frame as { caption: string }).caption).toBe('Thinking took 43% of agent time; writer one spent 1 min 10 s in a row writing logic')
  expect((frame as { foot: string }).foot.length).toBeLessThanOrEqual(70)
  expect(validateFrame(frame)).toEqual(frame)
})

test('repeats: a file x agent matrix from the tally, commands re-run, retries and tasks started more than once', () => {
  const a = agent('a', 'docs one', 100, [span('docs', 100, 50)], {
    tally: tallyOf({ 'read:board.css': [3], 'edit:board.css': [2], 'read:main.ts': [2], 'run:npm test': [4, 2, 2, 70 * SEC], 'run:node': [9] }),
  })
  const b = agent('b', 'docs two', 100, [span('docs', 100, 50)], { tally: tallyOf({ 'read:board.css': [2], 'run:npm test': [1] }) })
  const c = agent('c', 'docs three', 100, [span('docs', 100, 50)], { tally: tallyOf({ 'read:board.css': [1] }) })
  const loops = [a, b, c]
  const frame = repeatsFrame(loops, subjectsOf(loops, [], NOW))
  expect(frame).toMatchObject({
    id: 'repeats', type: 'repeats', cols: ['docs one', 'docs two', 'docs three'],
    rows: [{ label: 'board.css', cells: [5, 2, 1], note: '6 reads · 2 edits' }], // main.ts has 2 touches, under repeatMin 4
  })
  const notes = (frame as { notes: string[] }).notes
  expect(notes).toContain('npm test ×5 · 1 min 10 s · 2 agents · run it once, after the change is done')
  expect(notes).toContain('npm test re-run after failing ×2 · read the error before re-running')
  expect(notes.some(n => n.startsWith('3 agents on similar "docs" tasks'))).toBe(true)
  expect((frame as { caption: string }).caption).toBe('board.css was touched 8 times by 3 agents; npm test ran 5 times (1 min 10 s)')
  expect(notes.some(n => n.includes('"node"'))).toBe(false) // a bare script runner says nothing about WHAT ran
  expect(validateFrame(frame)).toEqual(frame)
  expect(repeatsFrame([agent('z', 'solo one', 100, [span('docs', 100, 50)])], [])).toBeUndefined()
  expect(taskWord('docs one')).toBe('docs')
  expect(taskWord('T50 agent')).toBe('')
  expect(similarTasks(subjectsOf([a, b], [], NOW))).toEqual([]) // two agents are under similarMin 3
})

/** An agent with `tests` seconds of testing at the start of a 200 s run. */
const testy = (id: string, tests: number, over: Partial<PulseLoop> = {}): PulseLoop => agent(id, `agent ${id}`, 200, [span('tests', 200, 200 - tests + 20)], over)

test('hints: tests share', () => {
  const heavy = hintsFrame([testy('a', 100)], subjectsOf([testy('a', 100)], [], NOW))
  expect(heavy).toMatchObject({ id: HINTS_FRAME_ID, type: 'hints' })
  const first = (heavy as { items: { text: string; evidence: string; rule: string }[] }).items[0]
  expect(first?.evidence).toBe('Tests took 50% of agent time (1 min 40 s of 3 min 20 s)')
  expect(first?.text.split(' ').length).toBeLessThanOrEqual(12) // the action is short
  expect(heavy).not.toHaveProperty('caption') // no preamble above the cards
  expect(first?.rule).toContain('hintTestsPct')
  expect(validateFrame(heavy)).toEqual(heavy)
  const light = [testy('a', 40)] // 20% < 35%
  expect(hintsFrame(light, subjectsOf(light, [], NOW))).toBeUndefined()
})

test('hints: reading before the first edit, shared files, retries; each fires on its own and says nothing when not met', () => {
  const reader = agent('r', 'reader', 200, [span('reading', 200, 90), span('logic', 80, 70)])
  const readerFrame = hintsFrame([reader], subjectsOf([reader], [], NOW))
  expect((readerFrame as { items: { evidence: string }[] }).items[0]?.evidence).toContain('Reading before the first edit took')
  const neverEdits = agent('n', 'never edits', 200, [span('reading', 200, 90)])
  expect(hintsFrame([neverEdits], subjectsOf([neverEdits], [], NOW))).toBeUndefined()

  const reads = tallyOf({ 'read:a.ts': [1], 'read:b.ts': [1], 'read:c.ts': [1] })
  const three = ['x', 'y', 'z'].map(id => agent(id, `agent ${id}`, 100, [span('logic', 100, 60)], { tally: reads }))
  const shared = hintsFrame(three, subjectsOf(three, [], NOW)) as { items: { text: string; evidence: string; rule: string }[] }
  expect(shared.items).toHaveLength(1)
  expect(shared.items[0]?.evidence).toBe('3 files read by 3+ agents each: a.ts, b.ts, c.ts')
  expect(shared.items[0]?.rule).toContain('hintSharedFiles')
  expect(hintsFrame(three.slice(0, 2), subjectsOf(three.slice(0, 2), [], NOW))).toBeUndefined()

  const retrying = agent('t', 'retrier', 100, [span('logic', 100, 60)], { tally: tallyOf({ 'run:make build': [5, 3, 3] }) })
  const retried = hintsFrame([retrying], subjectsOf([retrying], [], NOW)) as { items: { evidence: string; rule: string }[] }
  expect(retried.items[0]?.evidence).toBe('Re-ran straight after failing 3 times; most often "make build" (3)')
  expect(retried.items[0]?.rule).toContain('hintRetries')
})

test('validators: the four frame types name the field they refuse', () => {
  const refusal = (f: Record<string, unknown>): string => {
    try { validateFrame(f); return '' } catch (e) { return (e as Error).message }
  }
  const seg = { k: 'logic', s: 5, text: '5 s' }
  const bar = { label: 'a', total: '5 s', segs: [seg] }
  expect(refusal({ id: 'x', type: 'kindstack', items: [{ ...bar, segs: [{ ...seg, k: 'dancing' }] }] })).toMatch(/^frame\.items\[0\]\.segs\[0\]\.k/)
  expect(refusal({ id: 'x', type: 'kindstack', items: [], colour: 1 })).toMatch(/^frame\.colour is not a known field of a "kindstack" frame/)
  expect(refusal({ id: 'x', type: 'kindstack', items: Array.from({ length: 9 }, () => bar) })).toMatch(/^frame\.items/)
  expect(refusal({ id: 'x', type: 'sinks', items: [{ k: 'logic', pct: 101, text: 't' }] })).toMatch(/^frame\.items\[0\]\.pct/)
  expect(refusal({ id: 'x', type: 'repeats', cols: ['a', 'b'], rows: [{ label: 'f', cells: [1] }] })).toMatch(/^frame\.rows\[0\]\.cells has 1 numbers/)
  expect(refusal({ id: 'x', type: 'repeats', cols: [], rows: [] })).toMatch(/^frame needs rows or notes/)
  expect(refusal({ id: 'x', type: 'hints', items: [{ text: 't', rule: 'r' }] })).toMatch(/^frame\.items\[0\]\.evidence/)
  expect(refusal({ id: 'x', type: 'hints', items: [{ text: 't', evidence: 'e', rule: 'r' }], caption: 'c'.repeat(161) })).toMatch(/^frame\.caption is 161 characters/)
  expect(refusal({ id: 'x', type: 'hints', items: [{ text: 't', evidence: 'e', rule: 'r' }], foot: 'f'.repeat(71) })).toMatch(/^frame\.foot is 71 characters/)
})

test('on the board: the four frames appear for agents with enough time, the model can replace or remove them by id, thin data adds none', () => {
  const loops = [testy('a', 100, { tally: tallyOf({ 'read:a.ts': [4], 'run:make build': [5, 3, 3] }) }), B]
  const frames = assembleFrames(newBoardModel(), { ...BASE, loops })
  const ids = frames.map(f => f.id)
  for (const id of INSIGHT_FRAME_IDS) expect(ids).toContain(id)
  expect(ids.indexOf('time-by-kind')).toBeLessThan(ids.indexOf('time-sinks'))
  const mine = { id: 'time-by-kind', type: 'text', text: 'mine' } as const
  const replaced = assembleFrames({ ...newBoardModel(), frames: [mine] }, { ...BASE, loops })
  expect(replaced.filter(f => f.id === 'time-by-kind')).toEqual([mine])
  const removed = assembleFrames({ ...newBoardModel(), removedAuto: ['time-by-kind', 'improve'] }, { ...BASE, loops }).map(f => f.id)
  expect(removed).not.toContain('time-by-kind')
  expect(removed).not.toContain('improve')
  expect(removed).toContain('time-sinks')
  expect(assembleFrames(newBoardModel(), BASE).map(f => f.id).filter(id => (INSIGHT_FRAME_IDS as readonly string[]).includes(id))).toEqual([])
})
