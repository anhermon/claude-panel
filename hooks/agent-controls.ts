// The terminal pane's way into the Agents tile's drill-down. The live picture takes no mouse clicks, so the pane draws Buttons under it:
// one per agent (open its detail) and, while one is open, Transcript / Metrics / Struggles / Back. A press becomes a host message to the
// tile's iframe (`open-agent {id}`, `tab {name}`, `close`), sent through live.mjs's `host` control line. Pure, no `$`: the shape of the row,
// the keys and the messages. The data (ids, labels) is whatever the mod writes for the tile; nothing here knows a name.
import type { AgentRow } from './agents-info-data'
import { fit } from './layout-text'

/** Prefix of every key of these buttons: `agent:open:<id>`, `agent:tab:<name>`, `agent:back`. */
export const AGENT_KEY_PREFIX = 'agent:'
const OPEN_PREFIX = `${AGENT_KEY_PREFIX}open:`
const TAB_PREFIX = `${AGENT_KEY_PREFIX}tab:`
export const AGENT_BACK_KEY = `${AGENT_KEY_PREFIX}back`

/** The most agent buttons drawn (the main session first); the rest are a dim "+N". */
export const AGENT_BUTTONS_MAX = 6
/** Cells of an agent button's label. */
export const AGENT_LABEL_MAX = 12
/** The messages the tile's page listens for (web/builtin/agents-info/agents-info.js names the same three). */
export const HOST_OPEN = 'open-agent'
export const HOST_TAB = 'tab'
export const HOST_CLOSE = 'close'

/** The tabs of a detail, with their label and hotkey (the detail view's own names, detail-logic.mjs TABS). */
export const AGENT_TABS = [
  { name: 'progress', label: 'Progress', hotkey: 'p' },
  { name: 'transcript', label: 'Transcript', hotkey: 't' },
  { name: 'metrics', label: 'Metrics', hotkey: 'm' },
  { name: 'struggles', label: 'Struggles', hotkey: 's' },
] as const
export const AGENT_BACK_HOTKEY = 'x'
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/

export type AgentButton = { id: string; label: string }
/** What the pane draws: the agents (capped), how many were left out, and the open one (null: the list). */
export type AgentControls = { agents: readonly AgentButton[]; more: number; openId: string | null; tab: string }
export type AgentCommand = { name: string; data: Record<string, string> }

export const agentOpenKey = (id: string): string => `${OPEN_PREFIX}${id}`
export const agentTabKey = (name: string): string => `${TAB_PREFIX}${name}`

/** The buttons for these rows: main first, then the others as given; none when no row has a usable id. `tab` is the active tab of the open agent. */
export function agentControlsOf(rows: readonly AgentRow[], openId: string | null, tab: string): AgentControls | null {
  const usable = rows.filter(r => SAFE_ID.test(r.id))
  if (usable.length === 0) return null
  const ordered = [...usable.filter(r => r.isMain), ...usable.filter(r => !r.isMain)]
  return {
    agents: ordered.slice(0, AGENT_BUTTONS_MAX).map(r => ({ id: r.id, label: fit(r.short || r.name || r.id, AGENT_LABEL_MAX) })),
    more: Math.max(0, ordered.length - AGENT_BUTTONS_MAX),
    openId: openId !== null && usable.some(r => r.id === openId) ? openId : null,
    tab,
  }
}

/** A pressed key as the message for the tile; null for a key that is not one of these (or an id that is not safe). */
export function agentCommandOf(key: string): AgentCommand | null {
  if (key === AGENT_BACK_KEY) return { name: HOST_CLOSE, data: {} }
  if (key.startsWith(OPEN_PREFIX)) {
    const id = key.slice(OPEN_PREFIX.length)
    return SAFE_ID.test(id) ? { name: HOST_OPEN, data: { id } } : null
  }
  if (!key.startsWith(TAB_PREFIX)) return null
  const name = key.slice(TAB_PREFIX.length)
  return AGENT_TABS.some(t => t.name === name) ? { name: HOST_TAB, data: { name } } : null
}

/** The state after a press: which agent is open and on which tab (Back closes; opening starts at the first tab). */
export function agentViewAfter(key: string, view: { openId: string | null; tab: string }): { openId: string | null; tab: string } {
  const cmd = agentCommandOf(key)
  if (cmd === null) return view
  if (cmd.name === HOST_CLOSE) return { openId: null, tab: AGENT_TABS[0].name }
  if (cmd.name === HOST_OPEN) return { openId: cmd.data.id ?? null, tab: AGENT_TABS[0].name }
  return view.openId === null ? view : { openId: view.openId, tab: cmd.data.name ?? view.tab }
}
