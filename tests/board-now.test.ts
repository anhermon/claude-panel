// The auto `now` frame and the checklist frame of a lane: concrete, plain-titled, backwards compatible (no agent: the task title).
import { expect, test } from 'claude-code/testing'

import { dodFrames } from '../hooks/board-agents'
import { nowFrame, whoText } from '../hooks/now-frame'
import { buildRun, parseEvents, parseTicket } from '../hooks/router-state'
import type { BoardFrame, BoardLane } from '../types'

const NOW = 1_000_000_000
const MIN = 60_000
const lane = (over: Partial<BoardLane> = {}): BoardLane => ({
  id: 'a', label: 'T64 avatar redesign (sonnet/low)', state: 'working', pct: null, step: '', note: '', goal: '', dod: [], at: null, startedAt: NOW - 12 * MIN, updatedAt: NOW - 1000, by: 'a', ...over,
})
const insight = (headline: string, isMain = false) => ({ kind: 'tests' as const, headline, strip: '', mix: [], files: [], feed: [], tokens: null, lastCallAt: NOW, isBusy: true, isMain })
const base = { task: 'Panel v2: make progress visible', status: 'working' as const, now: NOW }

test('no agent: the old frame, the task title is the headline', () => {
  const f = nowFrame({ ...base, rows: [] })
  expect(f).toMatchObject({ type: 'now', text: 'Panel v2: make progress visible', status: 'working' })
  expect(f).not.toHaveProperty('sub')
  expect(nowFrame({ ...base, rows: [lane({ insight: insight('Reading', true) })] })).not.toHaveProperty('who')
})

test('an agent at work: plain title + activity headline, tally, elapsed, last finished; the task is the subtitle', () => {
  const rows = [
    lane({ insight: insight('Writing tests') }),
    lane({ id: 'b', label: 'Wire the hook', state: 'blocked', updatedAt: NOW - 5000 }),
    lane({ id: 'c', label: 'T61 survey the scenes', state: 'done', updatedAt: NOW - 2 * MIN }),
  ]
  const f = nowFrame({ ...base, rows }) as Record<string, unknown>
  expect(f.text).toBe('Avatar redesign · Writing tests')
  expect(f.sub).toBe('Panel v2: make progress visible')
  expect(f.who).toBe('1 agent working · 1 blocked')
  expect(f.for).toBe('working for 12 min')
  expect(f.last).toBe('Last finished: Survey the scenes')
  expect(JSON.stringify(f)).not.toMatch(/\bT\d+/)
})

test('only a blocked agent: the headline says so; a router ticket is named by its title, not its folder', () => {
  const run = buildRun([parseTicket({ id: '01-evaluator', title: 'Score the answers', status: 'in_progress' }, '01-evaluator')], parseEvents(''))
  const f = nowFrame({ ...base, router: run, rows: [lane({ label: 'worker 01-evaluator', state: 'blocked', step: 'needs a decision' })] }) as Record<string, unknown>
  expect(f.text).toBe('Blocked: Score the answers · needs a decision')
  expect(f.for).toBe('blocked for 12 min')
})

test('whoText counts only what is not zero', () => {
  expect(whoText([lane({ state: 'working' }), lane({ state: 'testing' }), lane({ state: 'waiting' })])).toBe('2 agents working · 1 waiting')
  expect(whoText([lane({ state: 'done' })])).toBe('')
})

test('checklist frame: plain title, owner and elapsed time, the open item is in progress', () => {
  const r = lane({ goal: 'T65 · Iterate on the board', dod: [{ t: 'a', state: 'done' }, { t: 'b', state: 'todo' }, { t: 'c', state: 'todo' }] })
  const frame = dodFrames([r], NOW)[0]?.frame as BoardFrame
  expect(frame).toMatchObject({ type: 'steps', title: 'Iterate on the board', owner: 'avatar redesign', since: '12 min' })
  expect((frame as { items: { state: string }[] }).items.map(i => i.state)).toEqual(['done', 'doing', 'todo'])
  const quiet = dodFrames([{ ...r, state: 'waiting' }])[0]?.frame as BoardFrame
  expect(quiet).not.toHaveProperty('since')
  expect((quiet as { items: { state: string }[] }).items.map(i => i.state)).toEqual(['done', 'todo', 'todo'])
})
