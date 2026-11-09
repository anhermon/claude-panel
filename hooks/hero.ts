// Which scene is the HERO picture of the visual pane. Candidates, in order: the built-in `board` (the default hero), the
// model's own stage scenes, then its scenes with a face image (term.image). The built-in `agents-info` (once the mod registered it) is one too; other built-ins never are. The
// active one is what the person picked with the switcher; publishing a scene never sets it, so the board stays the big
// tile until a pick. A pick that is gone (or none) falls back to the first candidate, the board. A scene that is not a stage
// scene has no live view. The switcher row only exists when there is a scene of the model's own to switch to. Pure, no `$`.
import type { PanelScene, PanelState } from '../types'
import { AGENTS_INFO_SCENE_ID } from './agents-info-scene'
import { BOARD_SCENE_ID } from './board-scene'
import { STAGE_LAYOUT } from './scene'

const isDrawable = (s: unknown): s is PanelScene =>
  typeof s === 'object' && s !== null && typeof (s as PanelScene).id === 'string' && (s as PanelScene).id !== ''

const isStage = (s: PanelScene): boolean => s.layout === STAGE_LAYOUT
const isBuiltin = (s: PanelScene): boolean => s.builtin === true
const hasFace = (s: PanelScene): boolean => typeof s.term?.image === 'string'

/** Every scene that can be the hero, best default first. */
export function heroCandidates(scenes: readonly PanelScene[]): PanelScene[] {
  const list = (Array.isArray(scenes) ? scenes : []).filter(isDrawable)
  const own = list.filter(s => !isBuiltin(s))
  return [
    ...list.filter(s => isBuiltin(s) && isStage(s) && s.id === BOARD_SCENE_ID),
    ...list.filter(s => isBuiltin(s) && isStage(s) && s.id === AGENTS_INFO_SCENE_ID),
    ...own.filter(isStage),
    ...own.filter(s => !isStage(s) && hasFace(s)),
  ]
}

/** The scenes the switcher lists (`[ board ] [ <id> ]`): none unless the model has a scene of its own to go to. */
export function switcherScenes(scenes: readonly PanelScene[]): PanelScene[] {
  const all = heroCandidates(scenes)
  return all.some(s => s.id !== BOARD_SCENE_ID) && all.length > 1 ? all : []
}

/** The hero: `activeId` when it is still a candidate, else the first candidate; undefined when the state has none. */
export function heroOf(state: PanelState, activeId?: string | null): PanelScene | undefined {
  const all = heroCandidates(state.scenes)
  return all.find(s => s.id === activeId) ?? all[0]
}
