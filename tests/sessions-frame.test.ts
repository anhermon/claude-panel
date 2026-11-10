// The `sessions` frame: its form, that every frame built passes the validator, and the board wiring (auto frame, silenced by
// frame_remove, replaced by a posted frame with the same id). Deterministic: no clock, no disk.
import { expect, test } from 'claude-code/testing'

import { CONFIG_DEFAULTS, configOf } from '../hooks/panel-config'
import { validateFrame } from '../hooks/board-frames'
import { applyFramePlan, assembleFrames, isAutoId, newBoardModel, planFrames } from '../hooks/board-model'
import type { BoardInput } from '../hooks/board-model'
import { sessionsFrame } from '../hooks/sessions-frame'
import type { SessionRow } from '../hooks/sessions-state'

const BASE: BoardInput = { task: null, status: 'working', ask: null, choices: [], lanes: [], loops: [], pulse: undefined, now: 1 }
const ROWS: SessionRow[] = [
  { id: 'a', title: 'Fix login', state: 'busy', project: 'alpha', branch: 'feature/x', age: 'now', task: 'make the login page work' },
  { id: 'b', title: 'Docs', state: 'idle', project: 'beta', age: '5m' },
  { id: 'c', title: 'Deploy', state: 'waiting', project: 'gamma', age: '2m', task: 'ship it' },
]

test('no other session: no frame', () => {
  expect(sessionsFrame(undefined)).toBeUndefined()
  expect(sessionsFrame([])).toBeUndefined()
  expect(assembleFrames(newBoardModel(), BASE)).toEqual([])
  expect(assembleFrames(newBoardModel(), { ...BASE, sessions: [] })).toEqual([])
})

test('one statusboard card per session, in columns busy / may be waiting / idle; empty columns are left out; the frame passes the validator', () => {
  const frame = sessionsFrame(ROWS)!
  expect(validateFrame(frame)).toEqual(frame)
  expect(frame).toMatchObject({ id: 'sessions', type: 'viz', kind: 'statusboard', title: 'Other sessions' })
  const data = (frame as unknown as { data: { columns: { id: string; items: Record<string, unknown>[] }[] } }).data
  expect(data.columns.map(c => c.id)).toEqual(['busy', 'waiting', 'idle'])
  expect(data.columns[0]!.items[0]).toEqual({ title: 'Fix login', sub: 'make the login page work', tags: ['alpha', 'feature/x', 'now'] })
  expect(data.columns[2]!.items[0]).toEqual({ title: 'Docs', tags: ['beta', '5m'] })
  const onlyIdle = (sessionsFrame([ROWS[1]!])! as unknown as { data: { columns: unknown[] } }).data.columns
  expect(onlyIdle).toHaveLength(1)
})

test('on the board it is an auto frame: frame_remove silences it, a posted frame with its id replaces it, frames_clear brings it back', () => {
  const input = { ...BASE, sessions: ROWS }
  expect(isAutoId('sessions')).toBe(true)
  expect(assembleFrames(newBoardModel(), input).map(f => f.id)).toEqual(['sessions'])
  const plan = planFrames({ frame_remove: 'sessions' })
  if (!plan.isOk) throw new Error(plan.error)
  const removed = applyFramePlan(newBoardModel(), plan.plan)
  if (!removed.isOk) throw new Error(removed.error)
  expect(removed.notes).toEqual(['frame sessions removed (auto; frames_clear brings it back)'])
  expect(assembleFrames(removed.model, input)).toEqual([])
  const own = planFrames({ frame: { id: 'sessions', type: 'text', text: 'my own words' } })
  if (!own.isOk) throw new Error(own.error)
  const replaced = applyFramePlan(newBoardModel(), own.plan)
  if (!replaced.isOk) throw new Error(replaced.error)
  expect(assembleFrames(replaced.model, input).map(f => [f.id, f.type])).toEqual([['sessions', 'text']])
})

test('the setting `sessionsFrame` defaults to on, and only a boolean changes it', () => {
  expect(CONFIG_DEFAULTS.sessionsFrame).toBe(true)
  expect(configOf().sessionsFrame).toBe(true)
  expect(configOf({ sessionsFrame: false }).sessionsFrame).toBe(false)
  expect(configOf({ sessionsFrame: 'no' }).sessionsFrame).toBe(true)
})
