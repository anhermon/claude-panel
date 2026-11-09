// The agents scene's pure data: the rows (the board's rows, no more), the overall state, and the event stream
// (diffAgents turns two looks into the transitions the page animates).
import { expect, test } from 'claude-code/testing'

import { AGENTS_INFO_CAPS, agentRowsOf, assembleAgentsInfo, countsOf, dataKey, diffAgents, hasCrew, overallOf, shortNameOf, spokenDuration } from '../hooks/agents-info-data'
import type { AgentRow } from '../hooks/agents-info-data'
import { agentsInfoScene, AGENTS_INFO_SCENE_ID, hasAgentsInfo, withAgentsInfo } from '../hooks/agents-info-scene'
import { boardScene, withBoard } from '../hooks/board-scene'
import { MAIN_LOOP } from '../hooks/pulse-model'
import type { PulseLoop } from '../hooks/pulse-model'
import { applyUserScene } from '../hooks/pulse-scene'
import { emptyState } from '../hooks/state'
import { heroOf, switcherScenes } from '../hooks/hero'
import { KIND_META } from '../hooks/work-kinds'
import type { BoardInput } from '../hooks/board-model'
import { buildRun, parseEvents, parseTicket } from '../hooks/router-state'
import type { BoardLane } from '../types'

const NOW = 1_767_000_000_000
const MIN = 60_000
const loop = (id: string, over: Partial<PulseLoop> = {}): PulseLoop => ({
  id, label: id, kind: 'subagent', status: 'running', lastTool: '', lastTarget: '', calls: 1, busy: 1, counts: {}, files: [],
  startedAt: NOW - 5 * MIN, lastAt: NOW, ...over,
})
const main = loop(MAIN_LOOP, { kind: 'main', name: 'main' })
const lane = (id: string, over: Partial<BoardLane> = {}): BoardLane => ({
  id, label: id, state: 'working', pct: null, step: '', note: '', goal: '', dod: [], at: null, startedAt: NOW - MIN, updatedAt: NOW, by: id, ...over,
})
const input = (over: Partial<BoardInput> = {}): BoardInput => ({ task: null, status: 'working', ask: null, choices: [], lanes: [], loops: [main], pulse: undefined, events: [], now: NOW, ...over })
const row = (id: string, over: Partial<AgentRow> = {}): AgentRow => ({
  id, name: id, short: id, state: 'working', pct: null, startedAt: NOW - MIN, endedAt: null, tokens: null, kind: 'logic',
  kindLabel: 'Logic', kindColor: '#34d399', kindGlyph: 'λ', headline: '', files: [], loop: id, isMain: false, ...over,
})

test('a plain chat has no crew; an agent (a loop that is not main, or a posted lane) makes one', () => {
  expect(hasCrew(input())).toBe(false)
  expect(hasCrew(input({ loops: [main, loop('a')] }))).toBe(true)
  expect(hasCrew(input({ lanes: [lane('x')] }))).toBe(true)
  expect(agentRowsOf(input()).agents).toEqual([])
})

test('countsOf and the events leave the main session out: it has a row but is not a crew member', () => {
  const rows = [row('m', { isMain: true, state: 'blocked' }), row('a'), row('b', { state: 'done' })]
  expect(countsOf(rows)).toMatchObject({ total: 2, blocked: 0, working: 1, done: 1 })
  expect(diffAgents([row('m', { isMain: true, state: 'working' })], [row('m', { isMain: true, state: 'blocked' })], NOW, 1)).toEqual([])
})

test('rows come from the board rows: the main loop is the first row ("Me", isMain, no satellite), kind colors come from KIND_META, a posted pct is kept', () => {
  const loops = [main, loop('a', { name: 'T43 Fix lanes', files: ['board.css'], tokens: 4200 }), loop('b', { name: 'writer', status: 'done', lastAt: NOW - 1000 })]
  const { agents: all } = agentRowsOf(input({ loops, lanes: [lane('a', { loop: 'a', pct: 60, label: 'a' })] }))
  expect(all[0]).toMatchObject({ isMain: true, name: 'Me', loop: MAIN_LOOP })
  const agents = all.filter(r => !r.isMain)
  expect(agents.map(a => a.id)).toEqual(['a', 'b'])
  const a = agents[0]!
  expect(a).toMatchObject({ short: 'T43', pct: 60, tokens: 4200, files: ['board.css'], endedAt: null })
  expect(a.kind).not.toBeNull()
  expect(a.kindColor).toBe(KIND_META[a.kind as keyof typeof KIND_META].color)
  expect(agents[1]).toMatchObject({ state: 'done', kind: 'done' })
  expect(agents[1]!.endedAt).toBe(NOW - 1000)
  // nothing but numbers, a state, a kind, a headline and basenames: the keys are the board's own set
  expect(Object.keys(a).sort()).toEqual(['agentType', 'endedAt', 'files', 'headline', 'id', 'isMain', 'kind', 'kindColor', 'kindGlyph', 'kindLabel', 'loop', 'name', 'pct', 'role', 'segs', 'short', 'startedAt', 'state', 'ticket', 'tokens'])
  // role and ticket are null for an ordinary agent: nothing is shown that the board does not already say
  expect(a).toMatchObject({ role: null, ticket: null })
})

test('segs: the rows carry the swimlane stretches of work (ms, newest SEGS), the file names the colour of each kind once, the moving end sits on a grid', () => {
  const loops = [main, loop('a', { name: 'writer', startedAt: NOW - 20 * MIN })]
  const events = [
    { t: NOW - 19 * MIN, loop: 'a', tool: 'Read', target: 'a.ts', kind: 'reading' as const },
    { t: NOW - 10 * MIN + 1234, loop: 'a', tool: 'Edit', target: 'a.ts', kind: 'logic' as const },
  ]
  const data = assembleAgentsInfo(input({ loops, events, lanes: [lane('a', { loop: 'a' })] }), [])
  const a = data.agents.find(r => r.id === 'a')!
  expect(a.segs!.map(s => s.k)).toEqual(['reading', 'logic'])
  expect(a.segs![0]!.a).toBe(NOW - 19 * MIN)
  expect(a.segs!.length).toBeLessThanOrEqual(AGENTS_INFO_CAPS.SEGS)
  expect(a.segs!.at(-1)!.b % AGENTS_INFO_CAPS.SEG_ROUND_MS).toBe(0) // a running loop's end is rounded: the file does not change every flush
  expect(data.kinds).toEqual({ reading: expect.objectContaining({ color: KIND_META.reading.color, label: 'Reading' }), logic: expect.objectContaining({ color: KIND_META.logic.color }) })
  expect(data.agents.find(r => r.isMain)!.segs).toEqual([]) // a loop with no calls has no stretches
})

test('identity: the agent type is the engines own name (namespace kept), model and effort come from the loop, the main session and an unknown part carry none', () => {
  const loops = [
    main,
    loop('a', { name: 'writer', type: 'savvy-flow:savvy-careful', model: 'sonnet', effort: 'high' }),
    loop('b', { name: 'reader', type: 'general-purpose' }),
  ]
  const { agents } = agentRowsOf(input({ loops, lanes: [lane('a', { loop: 'a' }), lane('b', { loop: 'b' })] }))
  expect(agents.find(r => r.id === 'a')).toMatchObject({ agentType: 'savvy-flow:savvy-careful', model: 'sonnet', effort: 'high' })
  const b = agents.find(r => r.id === 'b')!
  expect(b.agentType).toBe('general-purpose')
  expect('model' in b || 'effort' in b).toBe(false) // never invented
  expect(agents.find(r => r.isMain)!.agentType).toBeNull()
})

test('overall: blocked beats a pending question beats done beats working; counts add up', () => {
  const rows = [row('a'), row('b', { state: 'testing' }), row('c', { state: 'done' }), row('d', { state: 'waiting' })]
  expect(overallOf('working', false, rows)).toBe('working')
  expect(overallOf('working', true, rows)).toBe('waiting')
  expect(overallOf('waiting', false, rows)).toBe('waiting')
  expect(overallOf('done', false, rows)).toBe('done')
  expect(overallOf('working', true, [...rows, row('e', { state: 'blocked' })])).toBe('blocked')
  expect(overallOf('blocked', false, [])).toBe('blocked')
  expect(countsOf(rows)).toEqual({ total: 4, working: 2, waiting: 1, blocked: 0, done: 1, notStarted: 0 })
})

test('short names and spoken durations', () => {
  expect(shortNameOf('T43 Fix the lanes (sonnet/high)')).toBe('T43')
  expect(shortNameOf('Landscape research of everything')).toBe('Landscape res…')
  expect(spokenDuration(42_000)).toBe('42 s')
  expect(spokenDuration(26 * MIN)).toBe('26 min')
  expect(spokenDuration(125 * MIN)).toBe('2 h 5 min')
})

test('diffAgents: the first look announces nothing; a new agent is handed work and started; a finish says how long', () => {
  const a = row('t43', { short: 'T43' })
  expect(diffAgents(null, [a], NOW, 100)).toEqual([])
  const born = diffAgents([], [a], NOW, 100)
  expect(born.map(e => [e.id, e.kind, e.text])).toEqual([[100, 'handoff', 'main → T43'], [101, 'spawn', 'T43 started']])
  const done = diffAgents([a], [{ ...a, state: 'done', endedAt: NOW }], NOW, 102)
  expect(done).toEqual([{ id: 102, t: NOW, agent: 't43', from: 'working', to: 'done', kind: 'state', text: 'T43 done · 1 min' }])
  expect(diffAgents([a], [a], NOW, 1)).toEqual([])
})

test('diffAgents: state flips, kind changes and progress steps; quiet kinds, small steps and repeats inside the gap are not events', () => {
  const a = row('t40', { short: 'T40', pct: 10 })
  const ev = (next: Partial<AgentRow>, recent = [] as ReturnType<typeof diffAgents>) => diffAgents([a], [{ ...a, ...next }], NOW, 1, recent)
  expect(ev({ state: 'testing' })[0]).toMatchObject({ kind: 'state', from: 'working', to: 'testing', text: 'T40 testing' })
  expect(ev({ kind: 'tests' })[0]).toMatchObject({ kind: 'work', from: 'logic', to: 'tests', text: 'T40 · Tests' })
  expect(ev({ kind: 'thinking' })).toEqual([])
  expect(ev({ pct: 12 })).toEqual([])
  expect(ev({ pct: 40 })[0]).toMatchObject({ kind: 'progress', from: '10', to: '40', text: 'T40 40%' })
  const first = ev({ kind: 'tests' })
  expect(diffAgents([a], [{ ...a, kind: 'ui' }], NOW + 1000, 5, first)).toEqual([]) // the same kind of event within the gap
  expect(diffAgents([a], [{ ...a, kind: 'ui' }], NOW + AGENTS_INFO_CAPS.REPEAT_GAP_MS, 5, first)).toHaveLength(1)
})

test('ids only grow and the file keeps the newest events', () => {
  const events = Array.from({ length: 30 }, (_, i) => ({ id: 100 + i, t: NOW, agent: 'a', from: '', to: '', kind: 'state' as const, text: '' }))
  const data = assembleAgentsInfo(input({ loops: [main, loop('a')] }), events)
  expect(data.events).toHaveLength(AGENTS_INFO_CAPS.EVENTS)
  expect(data.events[0]!.id).toBe(110)
  expect(data.events.at(-1)!.id).toBe(129)
  expect(dataKey(data)).toBe(dataKey({ ...data, updatedAt: NOW + 5 }))
})

test('the scene record: added after the board, once, refreshed when its folder moves; the model may remove it, but not the board', () => {
  const DIR = '/tmp/t/claude-panel/agents-info/s1'
  const s0 = withBoard(emptyState(), '/tmp/t/board', NOW)
  const s1 = withAgentsInfo(s0, DIR, NOW)
  expect(s1.scenes.map(s => s.id)).toEqual(['board', AGENTS_INFO_SCENE_ID])
  expect(s1.scenes[1]).toMatchObject({ layout: 'stage', builtin: true, dir: DIR })
  expect(s1.scenes[1]!.pin).toBeUndefined()
  expect(hasAgentsInfo(s1)).toBe(true)
  expect(withAgentsInfo(s1, DIR, NOW + 1)).toBe(s1)
  expect(withAgentsInfo(s1, '/tmp/other', NOW + 1).scenes[1]).toMatchObject({ dir: '/tmp/other', rev: 2 })
  expect(boardScene(DIR, 1).id).toBe('board')
  const removed = applyUserScene(s1, { kind: 'remove', id: AGENTS_INFO_SCENE_ID }, NOW)
  expect(removed.isOk && removed.state.scenes.map(s => s.id)).toEqual(['board'])
  expect(applyUserScene(s1, { kind: 'remove', id: 'board' }, NOW).isOk).toBe(false)
  expect(agentsInfoScene(DIR, 1).title).toBe('Agents')
})

test('the agents scene can be the hero, and the switcher offers it beside the board', () => {
  const s1 = withAgentsInfo(withBoard(emptyState(), '/tmp/t/board', NOW), '/tmp/t/a', NOW)
  expect(heroOf(s1)?.id).toBe('board')
  expect(heroOf(s1, AGENTS_INFO_SCENE_ID)?.id).toBe(AGENTS_INFO_SCENE_ID)
  expect(switcherScenes(s1.scenes).map(s => s.id)).toEqual(['board', AGENTS_INFO_SCENE_ID])
  expect(switcherScenes(withBoard(emptyState(), '/tmp/t/board', NOW).scenes)).toEqual([])
})

test('rows carry role and ticket in a router run: router main, worker and verifier with their ticket badge, ordinary agents none', () => {
  const t = (id: string, over: Record<string, unknown> = {}) => parseTicket({ id, status: 'in_progress', ...over }, id, { evalText: '- slugify keeps unicode letters' })
  const router = buildRun(
    [t('01-slugify', { status: 'done', verdict: { result: 'PASS', checks: [{ item: 'a', pass: true }, { item: 'b', pass: true }] } }), t('02-is-palindrome')],
    parseEvents(['worker_reported', 'verify_pass'].map(type => JSON.stringify({ type, ticket: '01-slugify' })).join('\n')),
  )
  const loops = [
    main,
    loop('w', { type: 'worker', label: 'Worker 02-is-palindrome' }),
    loop('v', { type: 'verifier', label: 'verify 01-slugify' }),
    loop('x', { type: 'Explore', label: 'Survey the docs' }),
  ]
  const byId = (r: BoardInput['router']) => Object.fromEntries(agentRowsOf(input({ loops, router: r })).agents.map(a => [a.loop, a]))
  const rows = byId(router)
  expect(rows[MAIN_LOOP]).toMatchObject({ role: 'router', ticket: null })
  expect(rows.w).toMatchObject({ role: 'worker', ticket: { id: '02-is-palindrome', stage: 'building', text: 'building' } })
  expect(rows.v).toMatchObject({ role: 'verifier', ticket: { id: '01-slugify', stage: 'verified', text: 'verified 2/2' } })
  expect(rows.x).toMatchObject({ role: null, ticket: null })
  const plain = byId(undefined)
  expect(Object.values(plain).map(a => a.role)).toEqual([null, 'worker', 'verifier', null])
  expect(Object.values(plain).every(a => a.ticket === null)).toBe(true)
})

test('role and ticket are part of the data key: a stage change is a change', () => {
  const a = row('w', { role: 'worker', ticket: { id: '01', stage: 'building', text: 'building' } })
  const b = row('w', { role: 'worker', ticket: { id: '01', stage: 'verifying', text: 'verifying' } })
  const base = assembleAgentsInfo(input({ loops: [main] }), [])
  const d = (r: AgentRow) => ({ ...base, agents: [r] })
  expect(dataKey(d(a))).not.toBe(dataKey(d(b)))
})
