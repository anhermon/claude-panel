// The board's frames and lanes kept in the session state: they survive a mod reload (a new module instance reading the
// same stored value), and a missing, old or junk stored value loads as an empty board.
import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { boot, TOOL } from './boot'

const BOARD_KEY = 'board'
const BOARD_SHAPE = 'panel-board-1'
type Held = { value: unknown; version: number }
type StateEvent = { key: string; value: unknown }

/** An in-memory `$.state` that outlives the mod: what a reload keeps. `seed` is what the board key held before. */
function keepState(on: On, seed?: unknown) {
  const store = new Map<string, Held>()
  if (seed !== undefined) store.set(BOARD_KEY, { value: seed, version: 1 })
  on('state.get', (_, e) => ({ value: store.get((e as unknown as StateEvent).key) ?? { value: undefined, version: 0 } }) as never)
  on('state.set', (_, e) => {
    const { key, value } = e as unknown as StateEvent
    const version = (store.get(key)?.version ?? 0) + 1
    store.set(key, { value, version })
    return { value: { isSet: true, version } } as never
  })
  return store
}

const FRAME = { id: 'me', type: 'text', text: 'still here' }
const LANE = { id: 't36', state: 'working', pct: 40 }
const kept = (value: object) => ({ shape: BOARD_SHAPE, value })

test('frames and lanes posted are written to the kept state, capped and plain', async ($, on) => {
  const store = keepState(on)
  await boot($, on, {})
  await $.tool.call({ tool: TOOL, frame: FRAME })
  await $.tool.call({ tool: TOOL, lane: LANE })
  await $.tool.call({ tool: TOOL, frame_remove: 'now' })
  const held = store.get(BOARD_KEY)?.value as { shape: string; value: { frames: unknown[]; removedAuto: string[]; lanes: { id: string; pct: number }[] } }
  expect(held.shape).toBe(BOARD_SHAPE)
  expect(held.value.frames).toEqual([FRAME])
  expect(held.value.removedAuto).toEqual(['now'])
  expect(held.value.lanes.map(l => [l.id, l.pct])).toEqual([['t36', 40]])
})

test('a reload keeps the frames, the removed auto frames and the lanes: frame_remove still finds the frame', async ($, on) => {
  keepState(on, kept({ frames: [FRAME], removedAuto: ['ask'], lanes: [{ id: 't36', state: 'working', pct: 40 }] }))
  await boot($, on, {})
  expect((await $.tool.call({ tool: TOOL, lane_remove: 't36' })).result).not.toMatch(/no lane/)
  expect((await $.tool.call({ tool: TOOL, frame_remove: 'me' })).result).toMatch(/me/)
  expect((await $.tool.call({ tool: TOOL, frame_remove: 'me' })).result ?? '').not.toMatch(/frames: .*me/)
})

test('after a reload the first call is a frame call (no session start needed): the kept frames are still there', async ($, on) => {
  keepState(on, kept({ frames: [FRAME], removedAuto: [], lanes: [] }))
  await boot($, on, {})
  expect((await $.tool.call({ tool: TOOL, frame: { id: 'other', type: 'text', text: 'x' } })).result).toBe('frame other · text · 2 on board')
})

const EMPTY_CASES: [string, unknown][] = [
  ['nothing stored', undefined],
  ['an old shape tag', { shape: 'panel-board-0', value: { frames: [FRAME], removedAuto: [], lanes: [] } }],
  ['junk', { shape: BOARD_SHAPE, value: { frames: [{ id: 'Bad Id' }, 7], removedAuto: [3, 'not-auto'], lanes: ['x', { id: 'Bad Id' }] } }],
]
for (const [name, seed] of EMPTY_CASES)
  test(`${name} loads as an empty board`, async ($, on) => {
    keepState(on, seed)
    await boot($, on, {})
    const r = (await $.tool.call({ tool: TOOL, frame_remove: 'me' })) as { result?: string; deny?: string }
    expect(`${r.result ?? ''}${r.deny ?? ''}`).toContain('frames: none')
  })
