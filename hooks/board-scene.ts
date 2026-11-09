// The built-in `board` scene record, pure (no `$`, no I/O). The board is the panel's one stage scene of its own: it is
// registered FIRST in the scene list (`builtin: true`, `pin: true`), is the terminal's default hero, and never gets a chip
// in the browser's rail by itself. The `scene` tool cannot remove or replace it (./pulse-scene.ts). The old separate
// `pulse` scene is gone (the Pulse is a frame of the board now): `withBoard` also takes a leftover one out of the state.
import type { PanelScene, PanelState } from '../types'
import { isBuiltin } from './pulse-scene'

export const BOARD_SCENE_ID = 'board'
export const BOARD_TITLE = 'Board'
export const BOARD_ENTRY = 'index.html'
export const BOARD_ALT =
  "The board: frames of what Claude is doing and showing right now (the task, a pending question, agent lanes, the live activity, and charts, diagrams, steps or an avatar chosen to suit what is being said)."
const SPAN_FULL = 3
const BOARD_HEIGHT = 540
/** The scene that used to be registered for the Pulse; a state kept across a reload may still hold it. */
const RETIRED_PULSE_ID = 'pulse'

const scenesOf = (s: PanelState): PanelScene[] => (Array.isArray(s.scenes) ? s.scenes : [])
export const isBoardScene = (s: PanelScene): boolean => s.id === BOARD_SCENE_ID && isBuiltin(s)

/** The board record for the state: the folder is where the mod copied the scene's files. */
export function boardScene(dir: string, rev: number): PanelScene {
  return {
    id: BOARD_SCENE_ID,
    title: BOARD_TITLE,
    dir,
    entry: BOARD_ENTRY,
    span: SPAN_FULL,
    height: BOARD_HEIGHT,
    pin: true,
    layout: 'stage',
    builtin: true,
    alt: BOARD_ALT,
    rev,
  }
}

/**
 * The state with the board first in the scene list (added, or its folder refreshed) and a retired pulse scene gone.
 * The same object when nothing changes. A scene of the model's own called "board" cannot exist (the id is reserved
 * from the first publish on), but if one does it is left alone.
 */
export function withBoard(prev: PanelState, dir: string, now: number): PanelState {
  const scenes = scenesOf(prev)
  const held = scenes.find(s => s.id === BOARD_SCENE_ID)
  if (held !== undefined && !isBuiltin(held)) return prev
  const isFirst = scenes[0]?.id === BOARD_SCENE_ID
  const hasRetired = scenes.some(s => s.id === RETIRED_PULSE_ID && isBuiltin(s))
  if (held !== undefined && held.dir === dir && isFirst && !hasRetired) return prev
  const rev = held !== undefined && held.dir === dir ? held.rev : (held?.rev ?? 0) + 1
  const rest = scenes.filter(s => s.id !== BOARD_SCENE_ID && !(s.id === RETIRED_PULSE_ID && isBuiltin(s)))
  return { ...prev, scenes: [{ ...(held ?? {}), ...boardScene(dir, rev) }, ...rest], rev: prev.rev + 1, updatedAt: now }
}
