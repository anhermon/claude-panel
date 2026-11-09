// The built-in scene contract. A scene the mod itself publishes (`builtin: true`: the `board`, see ./board-scene.ts) is not
// counted against the scene or stage caps, cannot be replaced or removed by the `scene` tool (`{clear:true}` leaves it),
// and sits BEFORE the model's own scenes. Pure: no `$`, no I/O. `applyScene` itself (./scene.ts) is untouched: it is handed
// the model's scenes only and the built-ins are put back in front of its answer. (The file keeps its old name: the ambient
// Pulse was the first built-in scene; it is a frame of the board now.)
import type { PanelScene, PanelState } from '../types'
import { AGENTS_INFO_SCENE_ID } from './agents-info-scene'
import { applyScene } from './scene'
import type { SceneAction, SceneOutcome } from './scene'

/** Where the person goes to change what the board shows (the scene tool cannot). */
export const BOARD_COMMAND_HINT = 'frame_remove / frames_clear in the panel tool'
export const BUILTIN_STAYS_NOTE = `the built-in board stays (${BOARD_COMMAND_HINT} change its frames)`

export const isBuiltin = (s: PanelScene): boolean => s.builtin === true
const scenesOf = (s: PanelState): PanelScene[] => (Array.isArray(s.scenes) ? s.scenes : [])
export const builtinScenes = (s: PanelState): PanelScene[] => scenesOf(s).filter(isBuiltin)

/** `{ clear:true }` with nothing of the model's own, `{ remove:'board' }` or a publish over a built-in id: refused with the way out. */
function refusal(action: SceneAction, builtinIds: ReadonlySet<string>, ownCount: number): string | undefined {
  if (action.kind === 'remove' && builtinIds.has(action.id) && action.id !== AGENTS_INFO_SCENE_ID)
    return `scene: "${action.id}" is built in and cannot be removed with the scene tool: take a frame off it with ${BOARD_COMMAND_HINT}`
  if (action.kind === 'upsert' && builtinIds.has(action.scene.id))
    return `scene: "${action.scene.id}" is built in and cannot be replaced: pick another id (to put something on the board send panel {frame:{id,type,...}})`
  if (action.kind === 'clear' && ownCount === 0) return `scene: no scene of yours to clear; ${BUILTIN_STAYS_NOTE}`
  return undefined
}

/**
 * `applyScene` for the model's `scene` tool: built-in scenes are invisible to its caps and its list messages,
 * survive `clear` (which says so), and cannot be removed or replaced. The built-ins stay first, in their order.
 */
export function applyUserScene(prev: PanelState, action: SceneAction, now: number): SceneOutcome {
  const kept = builtinScenes(prev)
  if (kept.length === 0) return applyScene(prev, action, now)
  // The agents scene is the one built-in the model may take away (it was not asked for: the mod put it there once an agent existed).
  if (action.kind === 'remove' && action.id === AGENTS_INFO_SCENE_ID && kept.some(s => s.id === action.id))
    return { isOk: true, line: `scene ${action.id} removed`, state: { ...prev, scenes: scenesOf(prev).filter(s => s.id !== action.id), rev: prev.rev + 1, updatedAt: now } } as SceneOutcome
  const own = scenesOf(prev).filter(s => !isBuiltin(s))
  const error = refusal(action, new Set(kept.map(s => s.id)), own.length)
  if (error !== undefined) return { isOk: false, error }
  const outcome = applyScene({ ...prev, scenes: own }, action, now)
  if (!outcome.isOk) return outcome
  const state = outcome.state
  // `applyScene` answers the very `prev` it was given when nothing changed: give back the caller's own state then.
  if (state.scenes === own) return { ...outcome, state: prev }
  const line = action.kind === 'clear' ? `${outcome.line} (${BUILTIN_STAYS_NOTE})` : outcome.line
  return { ...outcome, line, state: { ...state, scenes: [...kept, ...scenesOf(state)] } }
}
