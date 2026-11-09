// The built-in `agents-info` scene record, pure (no `$`, no I/O): a stage scene (a tile of the workspace beside the board) that
// the mod registers ITSELF once an agent exists (context-driven: a plain chat never has it). Like the board it is built in
// (`builtin: true`: not counted against the scene caps, survives `{clear:true}`), but unlike the board the model may take it
// away with `scene {remove:'agents-info'}` (./pulse-scene.ts); the mod then keeps it away for the session (runtime `isCrewOff`).
import type { PanelScene, PanelState } from '../types'

export const AGENTS_INFO_SCENE_ID = 'agents-info'
export const AGENTS_INFO_TITLE = 'Agents'
export const AGENTS_INFO_ENTRY = 'index.html'
export const AGENTS_INFO_ALT =
  'The agents: a 3D avatar for the state of the whole team, one satellite per agent with its progress arc and kind of work, a ticker of live status changes, and a list with a small avatar and progress for every agent.'
const SPAN_FULL = 3
const SCENE_HEIGHT = 540

const isBuiltin = (s: PanelScene): boolean => s.builtin === true
const scenesOf = (s: PanelState): PanelScene[] => (Array.isArray(s.scenes) ? s.scenes : [])
export const hasAgentsInfo = (s: PanelState): boolean => scenesOf(s).some(x => x.id === AGENTS_INFO_SCENE_ID && isBuiltin(x))

export function agentsInfoScene(dir: string, rev: number): PanelScene {
  return {
    id: AGENTS_INFO_SCENE_ID,
    title: AGENTS_INFO_TITLE,
    dir,
    entry: AGENTS_INFO_ENTRY,
    span: SPAN_FULL,
    height: SCENE_HEIGHT,
    layout: 'stage',
    builtin: true,
    alt: AGENTS_INFO_ALT,
    rev,
  }
}

/**
 * The state with the scene added (or its folder refreshed), after the board and any other built-in and before the model's own
 * scenes. The same object when nothing changes. A scene of the model's own with this id is left alone.
 */
export function withAgentsInfo(prev: PanelState, dir: string, now: number): PanelState {
  const scenes = scenesOf(prev)
  const held = scenes.find(s => s.id === AGENTS_INFO_SCENE_ID)
  if (held !== undefined && !isBuiltin(held)) return prev
  if (held !== undefined && held.dir === dir) return prev
  const rev = (held?.rev ?? 0) + 1
  const record = { ...(held ?? {}), ...agentsInfoScene(dir, rev) }
  if (held !== undefined) return { ...prev, scenes: scenes.map(s => (s === held ? record : s)), rev: prev.rev + 1, updatedAt: now }
  const lastBuiltin = scenes.reduce((at, s, i) => (isBuiltin(s) ? i : at), -1)
  return { ...prev, scenes: [...scenes.slice(0, lastBuiltin + 1), record, ...scenes.slice(lastBuiltin + 1)], rev: prev.rev + 1, updatedAt: now }
}

/**
 * What the page says to the host (`panel.emit`): a click on an agent opens its detail (`agent {id, pages}`, repeated while it is open),
 * `agent-close` ends it. They are for the mod alone (./agent-detail-host.ts), so they are not quoted to the model like other clicks.
 */
export const AGENT_EVENT = 'agent'
export const AGENT_CLOSE_EVENT = 'agent-close'
export const isAgentsUiEvent = (e: { scene: string; name: string }): boolean =>
  e.scene === AGENTS_INFO_SCENE_ID && (e.name === AGENT_EVENT || e.name === AGENT_CLOSE_EVENT)
