// The terminal pane's agent buttons: the row model, keys <-> host messages, the view a press leads to, the drawn row, and the page's listeners.
import { expect, test } from 'claude-code/testing'

import {
  AGENT_BACK_KEY, AGENT_BUTTONS_MAX, AGENT_LABEL_MAX, AGENT_TABS, agentCommandOf, agentControlsOf, agentOpenKey, agentTabKey, agentViewAfter, HOST_CLOSE, HOST_OPEN, HOST_TAB,
} from '../hooks/agent-controls'
import type { AgentRow } from '../hooks/agents-info-data'
import { hostLine } from '../hooks/live-proto'
import { paneContent } from '../hooks/layout-visual'
import type { Line } from '../hooks/layout'
import { AGENTS_INFO_SCENE_ID, agentsInfoScene } from '../hooks/agents-info-scene'
import { BOARD_SCENE_ID } from '../hooks/board-scene'
import { LIVE_KEY } from '../hooks/layout-types'
import { FIXTURE } from './fixture-state'

const row = (id: string, over: Partial<AgentRow> = {}): AgentRow => ({
  id, loop: id, isMain: false, name: `Agent ${id}`, short: id.toUpperCase(), state: 'working', pct: null, startedAt: 1, endedAt: null, tokens: null,
  kind: null, kindLabel: '', kindColor: '#000000', kindGlyph: '', headline: '', files: [], ...over,
})
const FIRST_TAB = AGENT_TABS[0].name

test('agentControlsOf: main first, capped, the rest counted, an open id that is gone is closed, no rows no buttons', () => {
  const rows = [row('a'), row('b'), row('main', { isMain: true, short: 'Me' }), ...['c', 'd', 'e', 'f', 'g'].map(id => row(id))]
  const c = agentControlsOf(rows, 'zzz', FIRST_TAB)
  expect(c?.agents[0]).toEqual({ id: 'main', label: 'Me' })
  expect(c?.agents).toHaveLength(AGENT_BUTTONS_MAX)
  expect(c?.more).toBe(rows.length - AGENT_BUTTONS_MAX)
  expect(c?.openId).toBeNull()
  expect(agentControlsOf(rows, 'b', 'metrics')).toMatchObject({ openId: 'b', tab: 'metrics' })
  const long = agentControlsOf([row('x', { short: 'T44 with a very long label' })], null, FIRST_TAB)?.agents[0]?.label ?? ''
  expect([...long].length).toBeLessThanOrEqual(AGENT_LABEL_MAX)
  expect(agentControlsOf([], null, FIRST_TAB)).toBeNull()
  expect(agentControlsOf([row('bad id!')], null, FIRST_TAB)).toBeNull()
})

test('keys become host messages; anything else (a stranger id, an unknown tab) is nothing', () => {
  expect(agentCommandOf(agentOpenKey('t44'))).toEqual({ name: HOST_OPEN, data: { id: 't44' } })
  expect(agentCommandOf(agentTabKey('metrics'))).toEqual({ name: HOST_TAB, data: { name: 'metrics' } })
  expect(agentCommandOf(AGENT_BACK_KEY)).toEqual({ name: HOST_CLOSE, data: {} })
  expect(agentCommandOf(agentOpenKey('a/../b'))).toBeNull()
  expect(agentCommandOf(agentTabKey('nope'))).toBeNull()
  expect(agentCommandOf('answer:x')).toBeNull()
})

test('agentViewAfter: open starts at the first tab, a tab sticks, Back closes, a tab press with nothing open changes nothing', () => {
  const none = { openId: null, tab: FIRST_TAB }
  const open = agentViewAfter(agentOpenKey('a'), none)
  expect(open).toEqual({ openId: 'a', tab: FIRST_TAB })
  const tab = agentViewAfter(agentTabKey('metrics'), open)
  expect(tab).toEqual({ openId: 'a', tab: 'metrics' })
  expect(agentViewAfter(agentOpenKey('b'), tab)).toEqual({ openId: 'b', tab: FIRST_TAB })
  expect(agentViewAfter(AGENT_BACK_KEY, tab)).toEqual(none)
  expect(agentViewAfter(agentTabKey('metrics'), none)).toEqual(none)
})

test('hostLine is one line of the control protocol', () => {
  const line = hostLine(AGENTS_INFO_SCENE_ID, HOST_OPEN, { id: 'a' })
  expect(line).not.toContain('\n')
  expect(JSON.parse(line)).toEqual({ cmd: 'host', scene: AGENTS_INFO_SCENE_ID, name: HOST_OPEN, data: { id: 'a' } })
})

const buttonKeys = (lines: Line[]): string[] => lines.flatMap(l => l.flatMap(s => (s.button === undefined ? [] : [s.button.key])))
const stage = { ...agentsInfoScene('/tmp/agents', 1) }
const board = { id: BOARD_SCENE_ID, dir: '/tmp/board', alt: 'Board', rev: 1, layout: 'stage' as const, builtin: true }
const LIVE = { sceneId: BOARD_SCENE_ID, file: '/tmp/live.png', generation: 1, width: 720, height: 960 }
const ctx = (agents: ReturnType<typeof agentControlsOf>) => ({
  canDraw: true, faces: new Map(), heroId: null,
  extras: { live: LIVE, ...(agents === null ? {} : { agents }) },
})
const paneState = { ...FIXTURE, scenes: [board, stage] }

test('the pane draws one button per agent under the live picture, and the detail buttons only while one is open', () => {
  const rows = [row('main', { isMain: true, short: 'Me' }), row('t44', { short: 'T44 with a very long label' })]
  const list = paneContent(paneState, 80, 40, ctx(agentControlsOf(rows, null, FIRST_TAB)))
  const keys = buttonKeys(list)
  expect(keys).toContain(agentOpenKey('main'))
  expect(keys).toContain(agentOpenKey('t44'))
  expect(keys.filter(k => k.startsWith('agent:tab:') || k === AGENT_BACK_KEY)).toEqual([])
  // a marked (open) label is 2 cells longer: `▸ `
  const labels = list.flatMap(l => l.flatMap(s => (s.button?.key.startsWith('agent:open:') === true ? [s.button.label] : [])))
  for (const l of labels) expect([...l].length).toBeLessThanOrEqual(AGENT_LABEL_MAX + 2)

  const open = buttonKeys(paneContent(paneState, 80, 40, ctx(agentControlsOf(rows, 't44', 'metrics'))))
  expect(open).toEqual(expect.arrayContaining([...AGENT_TABS.map(t => agentTabKey(t.name)), AGENT_BACK_KEY]))
})

test('no agents or no live picture: no agent buttons; the live picture keeps its key', () => {
  expect(buttonKeys(paneContent(paneState, 80, 40, ctx(null))).filter(k => k.startsWith('agent:'))).toEqual([])
  const still = paneContent(paneState, 80, 40, { canDraw: true, faces: new Map(), heroId: null, extras: { agents: agentControlsOf([row('a')], null, FIRST_TAB)! } })
  expect(buttonKeys(still).filter(k => k.startsWith('agent:'))).toEqual([])
  expect(LIVE_KEY).toBe('live')
})
