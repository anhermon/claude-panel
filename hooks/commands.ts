// What `/panel`, `/panel open`, `/panel open <id>` and `/panel global` answer and open. Pure:
// the mod runs `open` / `xdg-open` for the plan's `open` url.
import type { PanelState } from '../types'
import { STAGE_LAYOUT, sceneUrl, withSep } from './scene'
import { COMMAND_GLOBAL_ARG, COMMAND_OPEN_ARG } from './spec'

export const LIVE_ARG = 'live'
export const LIVE_USAGE = 'usage: /panel live on|off|status'
export type LiveVerb = 'on' | 'off' | 'status'

/** `/panel live [on|off|status]`: the verb, or a usage line for another word; undefined when the args are not about live. */
export function parseLiveArgs(args: string): { verb: LiveVerb } | { usage: string } | undefined {
  const [first, word] = args.trim().split(/\s+/)
  if (first !== LIVE_ARG) return undefined
  if (word === undefined || word === 'status') return { verb: 'status' }
  return word === 'on' || word === 'off' ? { verb: word } : { usage: LIVE_USAGE }
}

/** The location hash the stage page reads to pick its stage scene: `#stage=<id>`. */
export const STAGE_HASH = '#stage='
export const NO_BROWSER_TEXT = 'Panel pane opened; the browser view is not running.'
export const NO_BROWSER_GLOBAL_TEXT = 'The browser view is not running yet, so the global view cannot be opened.'
/** The path of the global view (every session of this machine, read-only) below the panel's url. */
export const GLOBAL_PATH = 'global/'

export type CommandPlan = {
  /** The reply. */
  text: string
  /** A url to open in the browser, if any. */
  open?: string
}

/** The plan for `/panel <args>`; an unknown word is the same as no argument. */
export function planCommand(args: string, state: PanelState): CommandPlan {
  const [verb, id] = args.trim().split(/\s+/)
  const { url } = state
  const wantsOpen = verb === COMMAND_OPEN_ARG
  if (verb === COMMAND_GLOBAL_ARG) {
    if (url === null) return { text: NO_BROWSER_GLOBAL_TEXT }
    const target = `${withSep(url)}${GLOBAL_PATH}`
    return { text: target, open: target }
  }
  if (url === null)
    return {
      text:
        wantsOpen && id !== undefined
          ? `The browser view is not running yet, so scene "${id}" cannot be opened.`
          : NO_BROWSER_TEXT,
    }
  if (!wantsOpen) return { text: url }
  if (id === undefined) return { text: url, open: url }
  const scenes = Array.isArray(state.scenes) ? state.scenes : []
  const scene = scenes.find(s => s.id === id)
  if (scene === undefined) {
    const known = scenes.length === 0 ? 'there are no scenes yet' : `scenes: ${scenes.map(s => s.id).join(', ')}`
    return { text: `No scene "${id}" (${known}).` }
  }
  // A stage scene is shown by the stage page (it owns the viewport), not by its bare document.
  const target = scene.layout === STAGE_LAYOUT ? `${withSep(url)}${STAGE_HASH}${id}` : sceneUrl(url, id)
  return { text: target, open: target }
}
