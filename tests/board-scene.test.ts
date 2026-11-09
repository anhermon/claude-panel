// The built-in `board` scene contract, pure: it is registered first, is not counted against the scene or stage caps,
// survives the scene tool's `clear`, cannot be removed or replaced with it, and a retired pulse scene is taken out.
import { expect, test } from 'claude-code/testing'

import { BOARD_SCENE_ID, boardScene, withBoard } from '../hooks/board-scene'
import { applyUserScene, builtinScenes, BOARD_COMMAND_HINT } from '../hooks/pulse-scene'
import { applyScene, SCENE_CAPS } from '../hooks/scene'
import type { SceneAction, SceneDraft } from '../hooks/scene'
import { emptyState, isEmptyState } from '../hooks/state'
import type { PanelScene, PanelState } from '../types'

const NOW = 1_767_000_000_000
const DIR = '/tmp/t/claude-panel/board/sess-1'

const draft = (id: string, layout: 'card' | 'stage' = 'card'): SceneDraft =>
  ({ id, dir: `/tmp/${id}`, entry: 'index.html', alt: `scene ${id}`, span: 3, height: 420, layout }) as SceneDraft
const upsert = (id: string, layout: 'card' | 'stage' = 'card'): SceneAction =>
  ({ kind: 'upsert', scene: draft(id, layout), shot: { isWanted: false, at: '' } }) as SceneAction
const ids = (s: PanelState): string[] => s.scenes.map((x: PanelScene) => x.id)
const must = (r: { isOk: boolean; state?: PanelState; error?: string }): PanelState => {
  if (!r.isOk || r.state === undefined) throw new Error(r.error ?? 'refused')
  return r.state
}

test('the board scene is added once, refreshed when its folder moves, and goes FIRST', () => {
  const s0 = emptyState()
  const s1 = withBoard(s0, DIR, NOW)
  expect(s1.scenes).toHaveLength(1)
  expect(s1.scenes[0]).toMatchObject({ id: BOARD_SCENE_ID, layout: 'stage', builtin: true, pin: true, dir: DIR, entry: 'index.html', title: 'Board' })
  expect(s1.scenes[0]?.alt).toContain('The board')
  expect(withBoard(s1, DIR, NOW + 1)).toBe(s1)
  expect(withBoard(s1, '/tmp/other', NOW + 2).scenes[0]).toMatchObject({ dir: '/tmp/other', rev: 2 })
  expect(builtinScenes(s1)).toHaveLength(1)
  expect(isEmptyState(s1)).toBe(true)
  // the model's scene, then the board registered after it: the board still comes first
  const mine = must(applyScene(s0, upsert('mine', 'stage'), NOW))
  expect(ids(withBoard(mine, DIR, NOW + 3))).toEqual([BOARD_SCENE_ID, 'mine'])
  expect(boardScene(DIR, 1).rev).toBe(1)
})

test('a retired pulse scene of an older mod is taken out; a scene of the model\'s own named board is not touched', () => {
  const old: PanelState = { ...emptyState(), scenes: [{ ...draft('pulse', 'stage'), rev: 1, builtin: true }, { ...draft('mine', 'stage'), rev: 1 }] }
  expect(ids(withBoard(old, DIR, NOW))).toEqual([BOARD_SCENE_ID, 'mine'])
  const theirs = must(applyScene(emptyState(), upsert('board'), NOW))
  expect(withBoard(theirs, DIR, NOW)).toBe(theirs)
  // a model scene called pulse stays
  const mine = must(applyScene(emptyState(), upsert('pulse'), NOW))
  expect(ids(withBoard(mine, DIR, NOW))).toEqual([BOARD_SCENE_ID, 'pulse'])
})

test('built-in scenes do not count against the scene or stage caps and come first', () => {
  let s = withBoard(emptyState(), DIR, NOW)
  for (let i = 0; i < SCENE_CAPS.SCENES; i++) s = must(applyUserScene(s, upsert(`s${i}`, i < SCENE_CAPS.STAGE_SCENES ? 'stage' : 'card'), NOW + i))
  expect(s.scenes).toHaveLength(SCENE_CAPS.SCENES + 1)
  expect(ids(s)[0]).toBe(BOARD_SCENE_ID)
  expect(s.scenes.filter((x: PanelScene) => x.layout === 'stage')).toHaveLength(SCENE_CAPS.STAGE_SCENES + 1)
  const seventh = applyUserScene(s, upsert('s-extra'), NOW + 20)
  expect(seventh.isOk).toBe(false)
  expect(seventh.isOk === false && seventh.error).toMatch(/already 6 scenes \(s0, s1, s2, s3, s4, s5\)/)
  expect(applyUserScene(withBoard(emptyState(), DIR, NOW), upsert('x', 'stage'), NOW).isOk).toBe(true)
  // replacing one of the model's scenes keeps the board first
  const again = must(applyUserScene(s, upsert('s0'), NOW + 30))
  expect(ids(again)[0]).toBe(BOARD_SCENE_ID)
  expect(again.scenes.find((x: PanelScene) => x.id === 's0')?.rev).toBe(2)
})

test('clear leaves the board and says so; remove and a publish over its id are refused, pointing at frame_remove / frames_clear', () => {
  let s = withBoard(emptyState(), DIR, NOW)
  s = must(applyUserScene(s, upsert('mine'), NOW + 1))
  const cleared = applyUserScene(s, { kind: 'clear' }, NOW + 2)
  expect(ids(must(cleared))).toEqual([BOARD_SCENE_ID])
  expect(cleared.isOk && cleared.line).toMatch(/^scenes cleared \(1 removed\) \(the built-in board stays \(frame_remove/)
  const removed = applyUserScene(s, { kind: 'remove', id: BOARD_SCENE_ID }, NOW + 3)
  expect(removed.isOk).toBe(false)
  expect(removed.isOk === false && removed.error).toContain(BOARD_COMMAND_HINT)
  expect(removed.isOk === false && removed.error).toMatch(/^scene: "board" is built in/)
  const over = applyUserScene(s, upsert('board'), NOW + 4)
  expect(over.isOk).toBe(false)
  expect(over.isOk === false && over.error).toMatch(/panel \{frame:/)
  // nothing of the model's own to clear: refused, with the way out
  const onlyBoard = applyUserScene(withBoard(emptyState(), DIR, NOW), { kind: 'clear' }, NOW)
  expect(onlyBoard.isOk).toBe(false)
  expect(onlyBoard.isOk === false && onlyBoard.error).toContain('frames_clear')
  // nothing built in: exactly applyScene
  const plain = emptyState()
  expect(applyUserScene(plain, upsert('a'), NOW).isOk).toBe(true)
  expect(ids(must(applyUserScene(plain, { kind: 'clear' }, NOW)))).toEqual([])
  // data and goto are not state
  expect(must(applyUserScene(s, { kind: 'goto', id: 'mine', hash: '#/2' }, NOW))).toBe(s)
})
