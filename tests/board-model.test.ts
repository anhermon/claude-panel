// The board's model, pure: planning a call's frame part, upsert / remove / clear / eviction / full, the auto frames and the
// data assembled from them, and the change key the writer uses to skip a write.
import { expect, test } from 'claude-code/testing'

import {
  applyFramePlan,
  assembleBoard,
  assembleFrames,
  BOARD_CAPS,
  contentKey,
  hasFramePart,
  newBoardModel,
  planFrames,
  restoreBoardModel,
  withCount,
} from '../hooks/board-model'
import type { BoardInput, BoardModel } from '../hooks/board-model'
import type { BoardFrame, BoardLane } from '../types'
import { validateFrame } from '../hooks/board-frames'
import { agentBars, agentLanes, agentSwimlane, dodFrames, hasAgents, nameOf, QUIET_COLOR, RUNNING_COLOR } from '../hooks/board-agents'
import { applyOptions, configOf } from '../hooks/panel-config'
import type { PulseLoop } from '../hooks/pulse-model'
import { EXAMPLES, TYPES } from './board-examples'
import { varietyHint } from '../hooks/variety'

const NOW = 1_767_000_000_000
const LANE: BoardLane = { id: 't25', label: 'Pulse', state: 'working', pct: 40, step: '', note: '', goal: '', dod: [], at: null, startedAt: 0, updatedAt: 0, by: 'main' }
const BASE: BoardInput = { task: null, status: 'working', ask: null, choices: [], lanes: [], loops: [], pulse: undefined, now: NOW }
const loop = (id: string, over: Partial<PulseLoop> = {}): PulseLoop => ({
  id, label: id === 'main' ? 'Main' : `Agent ${id}`, kind: id === 'main' ? 'main' : 'subagent', status: 'running', lastTool: 'Edit', lastTarget: 'board.ts',
  calls: 3, busy: 0, counts: {}, files: [], startedAt: 10, lastAt: 20, ...over,
})
const input = (over: Partial<BoardInput>): BoardInput => ({ ...BASE, ...over })
const frame = (id: string, type = 'text'): BoardFrame => ({ ...(EXAMPLES[type] as BoardFrame), id })
const ids = (frames: readonly BoardFrame[]): string[] => frames.map(f => f.id)

function plan(raw: Record<string, unknown>) {
  const r = planFrames(raw)
  if (!r.isOk) throw new Error(r.error)
  return r.plan
}
function apply(model: BoardModel, raw: Record<string, unknown>) {
  const r = applyFramePlan(model, plan(raw))
  if (!r.isOk) throw new Error(r.error)
  return r
}
const refusal = (raw: Record<string, unknown>): string => {
  const r = planFrames(raw)
  if (r.isOk) throw new Error('accepted')
  return r.error
}

test('planFrames: splits the frame keys from the rest, validates, and names the field', () => {
  const p = plan({ task: { title: 'x' }, frame: EXAMPLES.text, frame_remove: 'old', frames_clear: true })
  expect(p.rest).toEqual({ task: { title: 'x' } })
  expect(p.upsert).toMatchObject({ id: 'why', type: 'text' })
  expect(p.remove).toEqual(['old'])
  expect(p.isClear).toBe(true)
  expect(hasFramePart(p)).toBe(true)
  expect(hasFramePart(plan({ task: { title: 'x' } }))).toBe(false)
  expect(plan({ frame_remove: ['a', 'b'] }).remove).toEqual(['a', 'b'])
  expect(refusal({ frame: { id: 'x', type: 'text', text: 'a'.repeat(91) } })).toMatch(/^panel: frame\.text is 91 characters; the limit is 90/)
  expect(refusal({ frame_remove: 'Bad Id' })).toMatch(/^panel: frame_remove "Bad Id" is invalid/)
  expect(refusal({ frame_remove: ['ok', 'Bad'] })).toMatch(/^panel: frame_remove\[1\] "Bad" is invalid/)
  expect(refusal({ frame_remove: [] })).toMatch(/non-empty array of ids/)
  expect(refusal({ frames_clear: 'yes' })).toMatch(/^panel: frames_clear must be true or false/)
  expect(plan({ frames_clear: false }).isClear).toBe(false)
})

test('every one of the 19 example frames applies and reports `frame <id> · <type>`', () => {
  for (const type of TYPES) {
    const r = apply(newBoardModel(), { frame: EXAMPLES[type] })
    expect(r.notes).toEqual([`frame ${EXAMPLES[type]!.id as string} · ${type}`])
    expect(r.model.frames).toHaveLength(1)
  }
})

test('upsert: a new id is appended, an old id replaces in place (keeps its place), the same frame is no change', () => {
  let m = apply(newBoardModel(), { frame: frame('a') }).model
  m = apply(m, { frame: frame('b') }).model
  m = apply(m, { frame: frame('c') }).model
  expect(ids(m.frames)).toEqual(['a', 'b', 'c'])
  const again = apply(m, { frame: { ...frame('b'), text: 'new words' } })
  expect(ids(again.model.frames)).toEqual(['a', 'b', 'c'])
  expect(again.model.frames[1]).toMatchObject({ text: 'new words' })
  expect(again.isChanged).toBe(true)
  expect(apply(again.model, { frame: { ...frame('b'), text: 'new words' } }).isChanged).toBe(false)
  expect(withCount(['frame b · text'], 3)).toEqual(['frame b · text · 3 on board'])
})

test('a frame can change type under its id (a line becomes a metric)', () => {
  const m = apply(newBoardModel(), { frame: EXAMPLES.line }).model
  const r = apply(m, { frame: { ...(EXAMPLES.metric as object), id: 'cpu-latency' } })
  expect(r.model.frames).toHaveLength(1)
  expect(r.model.frames[0]).toMatchObject({ id: 'cpu-latency', type: 'metric' })
})

test('remove: one id, a list, an unknown id says which frames exist, an auto id is remembered', () => {
  const m = apply(apply(newBoardModel(), { frame: frame('a') }).model, { frame: frame('b') }).model
  const one = apply(m, { frame_remove: 'a' })
  expect(one.notes).toEqual(['frame a removed'])
  expect(ids(one.model.frames)).toEqual(['b'])
  const both = apply(m, { frame_remove: ['a', 'b'] })
  expect(both.model.frames).toEqual([])
  expect(both.notes).toEqual(['frame a removed', 'frame b removed'])
  const missing = apply(m, { frame_remove: 'zzz' })
  expect(missing.notes).toEqual(['no frame "zzz" to remove; frames: a, b'])
  expect(missing.isChanged).toBe(false)
  expect(apply(newBoardModel(), { frame_remove: 'zzz' }).notes).toEqual(['no frame "zzz" to remove; frames: none'])
  const auto = apply(m, { frame_remove: 'bars' })
  expect(auto.notes).toEqual(['frame bars removed (auto; frames_clear brings it back)'])
  expect(auto.model.removedAuto).toEqual(['bars'])
  expect(auto.isChanged).toBe(true)
  expect(apply(auto.model, { frame_remove: 'bars' }).isChanged).toBe(false) // twice is the same
})

test('clear: empties the frames and forgets the removed auto frames; remove then add in one call', () => {
  let m = apply(apply(newBoardModel(), { frame: frame('a') }).model, { frame_remove: 'lanes' }).model
  expect(m.removedAuto).toEqual(['lanes'])
  const cleared = apply(m, { frames_clear: true })
  expect(cleared.notes).toEqual(['frames cleared (1 removed)'])
  expect(cleared.model).toMatchObject({ frames: [], removedAuto: [] })
  m = apply(m, { frames_clear: true, frame: frame('fresh') }).model // clear first, then upsert
  expect(ids(m.frames)).toEqual(['fresh'])
  expect(apply(newBoardModel(), { frames_clear: true }).notes).toEqual(['frames cleared (0 removed)'])
})

test('the twelve-frame limit: a new id is refused naming the ids, an existing id still replaces; remove makes room', () => {
  let m = newBoardModel()
  for (let i = 0; i < BOARD_CAPS.FRAMES; i++) m = apply(m, { frame: frame(`f${i}`) }).model
  expect(m.frames).toHaveLength(12)
  const full = applyFramePlan(m, plan({ frame: frame('extra') }))
  expect(full.isOk).toBe(false)
  expect(full.isOk === false && full.error).toMatch(/^panel: frame: already 12 frames \(f0, f1, f2,.*f11\): remove one with frame_remove before adding "extra" \(or reuse one of those ids/)
  expect(apply(m, { frame: { ...frame('f3'), text: 'changed' } }).model.frames).toHaveLength(12)
  const room = apply(m, { frame_remove: 'f0', frame: frame('extra') }) // remove first, then add
  expect(ids(room.model.frames).at(-1)).toBe('extra')
  expect(room.model.frames).toHaveLength(12)
  const cleared = apply(m, { frames_clear: true, frame: frame('extra') })
  expect(cleared.model.frames).toHaveLength(1)
})

test('a frame sent with an auto id takes over that auto frame; removing it falls back to the auto one only after frames_clear', () => {
  const lanes = input({ lanes: [LANE] })
  let m = newBoardModel()
  expect(ids(assembleFrames(m, lanes))).toEqual(['lanes'])
  m = apply(m, { frame: { id: 'lanes', type: 'text', text: 'mine' } }).model
  expect(assembleFrames(m, lanes)).toEqual([{ id: 'lanes', type: 'text', text: 'mine' }])
  m = apply(m, { frame_remove: 'lanes' }).model // the model's own one is gone, and it is remembered as removed
  expect(assembleFrames(m, lanes)).toEqual([])
  m = apply(m, { frames_clear: true }).model
  expect(ids(assembleFrames(m, lanes))).toEqual(['lanes'])
})

test('auto frames: now from the task, ask first, lanes when there is one; the pulse frame is never automatic', () => {
  expect(assembleFrames(newBoardModel(), BASE)).toEqual([]) // zero frames is a valid board
  const all = assembleFrames(
    apply(newBoardModel(), { frame: frame('mine') }).model,
    input({ task: { title: 'Fix the retry storm', why: '' }, status: 'blocked', ask: 'Ship it?', choices: [{ id: 'y', label: 'Yes' }, { id: 'n', label: 'No' }] as never, lanes: [LANE], pulse: { now: 5 } }),
  )
  expect(ids(all)).toEqual(['ask', 'mine', 'now', 'lanes']) // the question first, the model's frames, then the rest
  expect(all[0]).toMatchObject({ type: 'ask', q: 'Ship it?', options: ['Yes', 'No'] })
  expect(all.find(f => f.id === 'now')).toMatchObject({ type: 'now', sub: 'Fix the retry storm', status: 'blocked' }) // an agent row is at work: its title leads, the task is the subtitle
  expect(assembleFrames(newBoardModel(), input({ task: { title: 'Fix the retry storm', why: '' }, status: 'blocked' })).find(f => f.id === 'now')).toMatchObject({ type: 'now', text: 'Fix the retry storm', status: 'blocked' })
  expect(ids(assembleFrames(newBoardModel(), input({ pulse: {} })))).toEqual([]) // the feed alone adds no frame
  expect(ids(assembleFrames(newBoardModel(), input({ task: { title: '   ', why: '' }, ask: '  ' })))).toEqual([]) // blank is nothing
  expect(ids(assembleFrames(newBoardModel(), input({ lanes: [] })))).toEqual([])
})

test('auto frames are skipped when the model has the id or removed it; a long task or question is cut to the caps', () => {
  const busy = input({ task: { title: 'T', why: '' }, ask: 'Q?', lanes: [LANE], pulse: { now: 1 } })
  const m = apply(apply(newBoardModel(), { frame: { id: 'now', type: 'now', text: 'my own line' } }).model, { frame_remove: ['ask'] }).model
  const frames = assembleFrames(m, busy)
  expect(ids(frames)).toEqual(['now', 'lanes'])
  expect(frames[0]).toMatchObject({ text: 'my own line' })
  const long = assembleFrames(newBoardModel(), input({ task: { title: 'x'.repeat(200), why: '' }, ask: 'q'.repeat(300), choices: ['a', 'b', 'c', 'd', 'e', 'f'].map(label => ({ id: label, label })) as never }))
  expect((long.find(f => f.id === 'now') as { text: string }).text.length).toBeLessThanOrEqual(90)
  expect((long.find(f => f.id === 'ask') as { q: string; options: string[] }).q.length).toBeLessThanOrEqual(120)
  expect((long.find(f => f.id === 'ask') as { options: string[] }).options).toHaveLength(4)
})

test('assembleBoard: frames, lanes, now, updatedAt, and pulse only while the feed is on', () => {
  const off = assembleBoard(newBoardModel(), input({ task: { title: 'Task', why: '' }, status: 'waiting', lanes: [LANE] }))
  expect(off).toMatchObject({ frames: [{ id: 'now', type: 'now', title: 'Now', size: 'm', status: 'waiting', sub: 'Task' }, { id: 'lanes', type: 'lanes', title: 'Agents', size: 'l' }], lanes: [LANE], now: { title: 'Task', status: 'waiting' }, updatedAt: NOW })
  expect(assembleBoard(newBoardModel(), input({ task: { title: 'Task', why: '' }, status: 'waiting' })).frames).toEqual([{ id: 'now', type: 'now', title: 'Now', size: 'm', text: 'Task', status: 'waiting' }])
  expect(off).not.toHaveProperty('pulse')
  const on = assembleBoard(newBoardModel(), input({ pulse: { loops: [] } }))
  expect(on.pulse).toEqual({ loops: [] })
  expect(on.now).toEqual({ title: '', status: 'working' })
  expect(assembleBoard(newBoardModel(), BASE).frames).toEqual([])
})

test('contentKey ignores updatedAt and the pulse clock, and sees every real change', () => {
  const a = assembleBoard(newBoardModel(), input({ pulse: { now: 1, calls: 3 } }))
  expect(contentKey({ ...a, updatedAt: NOW + 5000, pulse: { now: 99, calls: 3 } })).toBe(contentKey(a))
  expect(contentKey({ ...a, pulse: { now: 1, calls: 4 } })).not.toBe(contentKey(a))
  expect(contentKey(assembleBoard(apply(newBoardModel(), { frame: frame('z') }).model, input({ pulse: { now: 1, calls: 3 } })))).not.toBe(contentKey(a))
  expect(contentKey(assembleBoard(newBoardModel(), input({ status: 'done' })))).not.toBe(contentKey(assembleBoard(newBoardModel(), BASE)))
})

test('restoreBoardModel: frames come back validated and capped, a bad frame or junk is dropped, never throws', () => {
  const good = apply(apply(newBoardModel(), { frame: frame('a') }).model, { frame_remove: 'bars' }).model
  expect(restoreBoardModel(JSON.parse(JSON.stringify(good)))).toEqual(good)
  expect(restoreBoardModel({ frames: [frame('a'), { id: 'Bad', type: 'text', text: 'x' }, 'junk', null, frame('a')], removedAuto: ['lanes', 'nope', 7], recent: ['text', 4] })).toEqual({ frames: [frame('a')], removedAuto: ['lanes'], recent: ['text'] })
  expect(restoreBoardModel({ frames: Array.from({ length: 20 }, (_, i) => frame(`f${i}`)) }).frames).toHaveLength(12)
  for (const junk of [null, undefined, 5, 'x', [], {}]) expect(restoreBoardModel(junk)).toEqual(newBoardModel())
})

test('agents by default: one lanes row per loop (name, state, intent), a posted lane keeps its pct and step; never a shell word', () => {
  const main = loop('main', { lastTool: 'Read', lastTarget: 'a.ts', calls: 9 })
  const sub = loop('ag-1', { label: 'Survey the repo', lastTool: 'Bash', lastTarget: 'sed', intent: 'T30 · Map the live view.', status: 'running', calls: 4 })
  expect(hasAgents([], [main])).toBe(false) // the main loop alone is the `now` frame's job
  expect(hasAgents([], [main, loop('ag-1', { status: 'done' })])).toBe(false)
  expect(hasAgents([], [main, sub])).toBe(true)
  expect(hasAgents([LANE], [])).toBe(true)
  const rows = agentLanes([], [main, sub, loop('ag-2', { status: 'idle', lastTool: '', lastTarget: '' })], 'Fix uploads')
  expect(rows.map(r => [r.id, r.label, r.state, r.step, r.pct, r.calls])).toEqual([
    ['main', 'Main', 'working', 'Fix uploads', null, 9],
    ['ag-1', 'Survey the repo', 'working', 'Map the live view', null, 4],
    ['ag-2', 'Agent ag-2', 'waiting', '', null, 3],
  ])
  expect(JSON.stringify(rows)).not.toMatch(/Bash|sed|Read|a\.ts/) // the tool in use is never shown
  const posted: BoardLane = { id: 't25', label: 'Survey', state: 'testing', pct: 40, step: 'reading', note: '', goal: '', dod: [], at: null, startedAt: 1, updatedAt: 2, by: 'ag-1', loop: 'ag-1' }
  const merged = agentLanes([posted, { ...posted, id: 'orphan', loop: null }], [main, sub])
  expect(merged.map(r => r.id)).toEqual(['main', 't25', 'orphan'])
  expect(merged[1]).toMatchObject({ label: 'Survey', pct: 40, step: 'reading', note: 'Map the live view', state: 'testing', calls: 4 }) // its own step wins, the intent follows
  const bare = agentLanes([{ ...posted, label: 't25', step: '' }], [sub])
  expect(bare[0]).toMatchObject({ label: 'Survey the repo', step: 'Map the live view', note: '', pct: 40 }) // named only by its id: the agent's name; no step: its intent
  const frames = assembleBoard(newBoardModel(), input({ loops: [main, sub] }))
  expect(ids(frames.frames)).toEqual(['now-doing', 'lanes', 'bars'])
  expect(frames.lanes).toHaveLength(2)
  expect(assembleBoard(newBoardModel(), input({ loops: [main] })).lanes).toEqual([])
})

test('a lane with a checklist also gets a `steps` frame titled with its goal; the item at `at` shows as doing; the model can remove it', () => {
  const lane: BoardLane = { ...LANE, id: 't30', label: 'Board', goal: 'Board in the mod', dod: [{ t: 'frames', state: 'done' }, { t: 'tests', state: 'todo' }, { t: 'render', state: 'todo' }], at: 1, loop: null }
  const data = assembleBoard(newBoardModel(), input({ lanes: [lane] }))
  expect(ids(data.frames)).toEqual(['lanes', 'dod-t30'])
  expect(data.frames[1]).toEqual({ id: 'dod-t30', type: 'steps', title: 'Board in the mod', size: 'm', owner: 'Board', items: [{ t: 'frames', state: 'done' }, { t: 'tests', state: 'doing' }, { t: 'render', state: 'todo' }] })
  expect(() => validateFrame(data.frames[1])).not.toThrow()
  expect(data.lanes[0]).toMatchObject({ goal: 'Board in the mod', at: 1 })
  expect(dodFrames([{ ...lane, goal: '' }])[0]?.frame).toMatchObject({ title: 'Board' }) // no goal: the label
  const silenced = apply(newBoardModel(), { frame_remove: 'dod-t30' })
  expect(silenced.notes).toEqual(['frame dod-t30 removed (auto; frames_clear brings it back)'])
  expect(ids(assembleFrames(silenced.model, input({ lanes: [lane] })))).toEqual(['lanes'])
  expect(restoreBoardModel(JSON.parse(JSON.stringify(silenced.model))).removedAuto).toEqual(['dod-t30'])
  expect(dodFrames(Array.from({ length: 6 }, (_, i) => ({ ...lane, id: `l${i}` })))).toHaveLength(3) // a few at most
  expect(dodFrames([{ ...lane, id: 'a'.repeat(24) }])[0]?.id).toMatch(/^dod-a+$/) // the frame id stays within 24 chars
})

test('the bars frame: time per agent (tokens once any are known), the main loop left out, top 6, running highlighted, only from two loops; the model can replace or remove it', () => {
  expect(agentBars([loop('main')], NOW)).toBeUndefined()
  const MIN = 60_000
  const many = ['main', ...Array.from({ length: 8 }, (_, i) => `ag-${i}`)].map((id, i) =>
    loop(id, { startedAt: NOW - 10 * MIN, lastAt: NOW - 10 * MIN + i * MIN, status: i === 8 ? 'running' : 'done' }),
  )
  const bars = agentBars(many, NOW) as Extract<BoardFrame, { type: 'bars' }>
  expect(bars).toMatchObject({ id: 'bars', type: 'bars', title: 'Time per agent', size: 's', unit: 'min' })
  expect(bars.items).toHaveLength(6)
  expect(bars.items.map(i => i.value)).toEqual([10, 7, 6, 5, 4, 3]) // ag-7 is running (10 min up to now), the others lasted lastAt - startedAt; main is not an agent
  expect(bars.items[0]!.color).toBe(RUNNING_COLOR)
  expect(bars.items[1]!.color).toBe(QUIET_COLOR)
  expect(() => validateFrame(bars)).not.toThrow()
  const withTokens = [loop('main', { tokens: 9_000_000 }), loop('ag-1', { tokens: 42_400 }), loop('ag-2', { tokens: 100_000 }), loop('ag-3')]
  expect(agentBars(withTokens, NOW)).toMatchObject({ title: 'Tokens per agent', unit: 'k tokens', items: [{ value: 100 }, { value: 42 }] }) // ag-3 has no tokens known: no bar, not a zero one
  expect((agentBars(withTokens, NOW) as Extract<BoardFrame, { type: 'bars' }>).items).toHaveLength(2)
  expect(() => validateFrame(agentBars(withTokens, NOW) as BoardFrame)).not.toThrow()
  const loops = [loop('main'), loop('ag-1')]
  expect(ids(assembleFrames(newBoardModel(), input({ loops })))).toContain('bars')
  expect(ids(assembleFrames(apply(newBoardModel(), { frame_remove: 'bars' }).model, input({ loops })))).not.toContain('bars')
  expect(assembleFrames(apply(newBoardModel(), { frame: { id: 'bars', type: 'text', text: 'mine' } }).model, input({ loops })).filter(f => f.id === 'bars')).toHaveLength(1)
})

test('agent rows carry the insight computed from the ring: kind, headline, strip, mix, files, feed, tokens', () => {
  const sub = loop('ag-1', { files: ['board.js'], tokens: 42_000, lastAt: NOW - 1000, startedAt: NOW - 60_000 })
  const events = [{ t: NOW - 2000, loop: 'ag-1', tool: 'Edit', target: 'board.js' }]
  const rows = assembleBoard(newBoardModel(), input({ loops: [loop('main'), sub], events })).lanes
  expect(rows[1]!.insight).toMatchObject({ kind: 'logic', headline: 'Writing logic · board.js', files: ['board.js'], feed: ['edited board.js'], tokens: 42_000, isMain: false })
  expect(rows[0]!.insight).toMatchObject({ isMain: true, tokens: null })
  expect(JSON.stringify(rows)).not.toMatch(/"Edit"/) // the tool name stays out of the rows
})

test('the pulse frame is opt-in: only a frame the model sends puts it on the board', () => {
  const m = apply(newBoardModel(), { frame: { id: 'activity', type: 'pulse' } }).model
  expect(ids(assembleFrames(m, input({ pulse: { now: 1 } })))).toEqual(['activity'])
})

test('the delegation and pipeline auto frames: from two agents, after the agents frame and the bars; the model can replace or remove them', () => {
  const one = assembleFrames(newBoardModel(), input({ loops: [loop('main'), loop('a')] }))
  expect(ids(one)).not.toContain('delegation')
  const loops = [loop('main'), loop('a'), loop('b')]
  const frames = assembleFrames(newBoardModel(), input({ loops }))
  const ownIds = (fs: readonly BoardFrame[]) => ids(fs).filter(id => ['lanes', 'bars', 'delegation', 'pipeline'].includes(id)) // other auto frames may sit among them
  expect(ownIds(frames)).toEqual(['lanes', 'bars', 'delegation', 'pipeline'])
  expect(frames.find(f => f.id === 'delegation')).toMatchObject({ type: 'uml', title: 'Handoffs' })
  const mine = apply(newBoardModel(), { frame: { id: 'pipeline', type: 'text', text: 'mine' } }).model
  expect(assembleFrames(mine, input({ loops })).find(f => f.id === 'pipeline')).toMatchObject({ type: 'text' })
  const removed = apply(newBoardModel(), { frame_remove: 'delegation' })
  expect(removed.notes).toEqual(['frame delegation removed (auto; frames_clear brings it back)'])
  expect(ownIds(assembleFrames(removed.model, input({ loops })))).toEqual(['lanes', 'bars', 'pipeline'])
})

test('applyFramePlan remembers the form of each upsert, and the hint appears on a streak', () => {
  let model = newBoardModel()
  for (const id of ['a', 'b', 'c']) {
    const applied = apply(model, { frame: frame(id, 'text') })
    expect(applied.isOk).toBe(true)
    if (applied.isOk) model = applied.model
  }
  expect(model.recent).toEqual(['text', 'text', 'text'])
  expect(varietyHint(model.recent)).toMatch(/all "text"/)
})

test('nameOf strips only a routing note, and not when the option is off', () => {
  const l = (name: string) => loop('ag-1', { name })
  expect(nameOf(l('Fix uploads (sonnet/high)'))).toBe('Fix uploads')
  expect(nameOf(l('Survey (agy/gemini-3/low)'))).toBe('Survey')
  expect(nameOf(l('Fix (read/write path)'))).toBe('Fix (read/write path)')
  expect(nameOf(l('Move (read/write)'))).toBe('Move (read/write)')
  applyOptions({ stripRoutingSuffix: false })
  expect(nameOf(l('Fix uploads (sonnet/high)'))).toBe('Fix uploads (sonnet/high)')
  applyOptions({})
  expect(nameOf(l('Fix uploads (sonnet/high)'))).toBe('Fix uploads')
})

test('options: done-row minutes and checklist frame count, defaults when unset or odd', () => {
  expect(configOf()).toMatchObject({ doneRowMs: 600_000, dodFramesMax: 3, stripRoutingSuffix: true })
  expect(configOf({ doneRowMinutes: 1, dodFramesMax: 1 })).toMatchObject({ doneRowMs: 60_000, dodFramesMax: 1 })
  expect(configOf({ doneRowMinutes: -5, dodFramesMax: 'x' })).toMatchObject({ doneRowMs: 600_000, dodFramesMax: 3 })
  applyOptions({ dodFramesMax: 1 })
  const lane: BoardLane = { ...LANE, dod: [{ t: 'a', state: 'todo' }] }
  expect(dodFrames([lane, { ...lane, id: 'l2' }])).toHaveLength(1)
  applyOptions({})
})

test('ONE agents component: while the Agents tile exists the board omits its agent rows (lanes), now-doing, bars and pipeline; checklists and user frames stay; without the tile all of them are back', () => {
  const loops = [loop('main'), loop('a'), loop('b')]
  const lane: BoardLane = { ...LANE, id: 't30', goal: 'Board', dod: [{ t: 'x', state: 'todo' }], at: 0, loop: 'a' }
  const withoutTile = assembleFrames(newBoardModel(), input({ loops, lanes: [lane] }))
  for (const id of ['now-doing', 'lanes', 'bars']) expect(ids(withoutTile)).toContain(id)
  const withTile = assembleFrames(newBoardModel(), input({ loops, lanes: [lane], hasAgentsTile: true }))
  for (const id of ['now-doing', 'lanes', 'bars', 'pipeline']) expect(ids(withTile)).not.toContain(id)
  expect(ids(withTile)).toContain('dod-t30')
  const user = apply(newBoardModel(), { frame: { id: 'mine', type: 'text', text: 'hi' } })
  expect(ids(assembleFrames(user.model, input({ loops, hasAgentsTile: true })))).toContain('mine')
  expect(assembleBoard(newBoardModel(), input({ loops, hasAgentsTile: true })).lanes).toHaveLength(3) // the data of the rows stays (the tile reads it)
  expect(ids(assembleFrames(newBoardModel(), input({ loops, hasAgentsTile: false })))).toEqual(ids(assembleFrames(newBoardModel(), input({ loops })))) // the flag off is the same as no flag
})

test('now-doing: only when an agent row says what it does, above the agents frame; the model can remove it', () => {
  expect(ids(assembleFrames(newBoardModel(), input({ lanes: [LANE] })))).toEqual(['lanes']) // a hand-posted lane has no insight: nothing to say
  const loops = [loop('main'), loop('a')]
  const frames = assembleFrames(newBoardModel(), input({ loops }))
  expect(ids(frames).slice(0, 2)).toEqual(['now-doing', 'lanes'])
  expect(frames[0]).toEqual({ id: 'now-doing', type: 'doing', title: 'Doing now', size: 's' })
  expect(() => validateFrame(frames[0])).not.toThrow()
  const removed = apply(newBoardModel(), { frame_remove: 'now-doing' })
  expect(removed.notes).toEqual(['frame now-doing removed (auto; frames_clear brings it back)'])
  expect(ids(assembleFrames(removed.model, input({ loops })))).not.toContain('now-doing')
})

test('activity-timeline: a swimlane of every loop by kind, in seconds from the first start, only once an agent has done something', () => {
  const T0 = NOW - 600_000
  const main = loop('main', { startedAt: T0, lastAt: NOW })
  const sub = loop('a', { startedAt: T0 + 60_000, lastAt: NOW - 1000 })
  const events = [
    { t: T0 + 10_000, loop: 'main', tool: 'Edit', target: 'work-kinds.ts', kind: 'logic' },
    { t: T0 + 70_000, loop: 'a', tool: 'Bash', target: 'tsc', kind: 'tests' },
    { t: T0 + 80_000, loop: 'a', tool: 'Edit', target: 'board.css', kind: 'ui' },
  ] as never
  expect(agentSwimlane([main], events, NOW)).toBeUndefined() // the main loop alone is not an activity timeline
  expect(agentSwimlane([main, loop('quiet')], events, NOW)).toBeUndefined() // an agent with no call yet adds nothing
  const frame = agentSwimlane([main, sub], events, NOW) as Extract<BoardFrame, { type: 'swimlane' }>
  expect(frame).toMatchObject({ id: 'activity-timeline', type: 'swimlane', title: 'Activity' })
  expect(frame.items.map(i => [i.label, i.from, i.state])).toEqual([['Main', 0, 'working'], ['Agent a', 60, 'working']])
  expect(frame.items[1]!.segs.map(s => s.k)).toEqual(['tests', 'ui'])
  expect(frame.items[0]!.segs[0]).toMatchObject({ k: 'logic', a: 10 })
  expect(() => validateFrame(frame)).not.toThrow()
  expect(JSON.stringify(frame)).not.toMatch(/Edit|Bash|work-kinds|board\.css/) // kinds and times only: no tool, no file
  const data = assembleBoard(newBoardModel(), input({ loops: [main, sub], events }))
  expect(ids(data.frames)).toContain('activity-timeline')
  expect(ids(data.frames).indexOf('activity-timeline')).toBeGreaterThan(ids(data.frames).indexOf('lanes'))
})
