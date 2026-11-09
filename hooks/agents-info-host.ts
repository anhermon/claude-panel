// The `agents-info` scene, wired: its files, its live/data.json and the event stream. The rules are in ./agents-info-data.ts
// (pure); this file holds the module state (the previous snapshot, the kept events) and the `$` half. It is fed by the board's
// flusher (./board-host.ts calls `agentsInfoPush` on every flush, so it shares the board's coalescing: at most two writes a
// second, only when the content changed) and never touches the panel state: it is TOLD where the scene lives (`agentsInfoNote`,
// from every state write) and ASKS register.tsx to register the scene when the first agent shows up (`setAgentsInfoListener`).
import type { EngineInterface } from 'claude-code'

import type { PanelState } from '../types'
import { agentCommandOf, agentControlsOf, agentViewAfter, AGENT_TABS } from './agent-controls'
import type { AgentControls } from './agent-controls'
import { AGENTS_INFO_CAPS, agentRowsOf, assembleAgentsInfo, dataKey, diffAgents, hasCrew } from './agents-info-data'
import type { AgentEvent, AgentRow } from './agents-info-data'
import { startDetailLoop } from './agent-detail-host'
import type { DetailBind, DetailSource } from './agent-detail-host'
import { AGENTS_INFO_SCENE_ID } from './agents-info-scene'
import { DATA_FILE_NAME, DATA_TEMP_NAME, installScene, writeLive } from './board-io'
import type { BoardInput } from './board-model'
import { liveHost } from './live'
import { pulseBoardParts } from './pulse-host'
import { isBuiltin } from './pulse-scene'
import { PULSE_STATE_DIR } from './pulse-io'
import { PLUGIN_NAME } from './spec'

type Dollar = EngineInterface

export const AGENTS_INFO_SUBDIR = 'agents-info'
/** The scene's own files, relative to the plugin root. */
export const AGENTS_INFO_SOURCE_DIR = 'web/builtin/agents-info'
/** At the very first look, an agent that started less than this ago is new (announced); an older one was already running before the mod loaded. */
const FRESH_AGENT_MS = 10_000

type Host = {
  /** Where the scene is served from, while it is registered in the panel state. */
  dir: string | null
  /** The agents of the last push (null: no look yet, the first one announces nothing). */
  prev: AgentRow[] | null
  events: AgentEvent[]
  nextId: number
  lastKey: string
  wasCrew: boolean
  onCrew: (() => void) | null
  /** Which agent the terminal pane's buttons opened, and its tab (the pane's own memory of what it asked the tile to show). */
  view: { openId: string | null; tab: string }
  /** The ids the pane's buttons were last drawn for: a change redraws the pane. */
  buttonsKey: string
}
const NO_VIEW = { openId: null, tab: AGENT_TABS[0].name }
const host: Host = { dir: null, prev: null, events: [], nextId: 0, lastKey: '', wasCrew: false, onCrew: null, view: NO_VIEW, buttonsKey: '' }

/** register.tsx's answer to "an agent exists": register the scene (once per module instance). */
export function setAgentsInfoListener(fn: (() => void) | null): void {
  host.onCrew = fn
  host.wasCrew = false
}

/** `<tmp>/claude-panel/agents-info/<session id>`: where the scene and its live/ folder live. */
export const agentsInfoDirOf = (tmp: string, sessionId: string): string => `${tmp.replace(/\/+$/, '')}/${PULSE_STATE_DIR}/${AGENTS_INFO_SUBDIR}/${sessionId}`

/** Every state write: the scene is live exactly while the state holds it (removed by the model: the writes stop). */
export function agentsInfoNote(state: PanelState): void {
  const scene = (Array.isArray(state.scenes) ? state.scenes : []).find(s => s.id === AGENTS_INFO_SCENE_ID && isBuiltin(s))
  const dir = scene?.dir ?? null
  if (dir !== host.dir) host.lastKey = ''
  host.dir = dir
}

/** Is the Agents tile registered now? Then it is THE place for agent rows: the board leaves its own agent frames out (./board-model.ts). */
export const agentsInfoLive = (): boolean => host.dir !== null

/** The pane's buttons for the tile (agents, and the open one's tabs): null without the tile or without agents. */
export const agentsInfoControls = (): AgentControls | null => (host.dir === null ? null : agentControlsOf(host.prev ?? [], host.view.openId, host.view.tab))

/** A press on one of those buttons (`agent:...`): remember the view, tell the tile through the live page, redraw the pane. */
export async function agentsInfoPress($: Dollar, key: string): Promise<void> {
  const cmd = agentCommandOf(key)
  if (cmd === null) return
  host.view = agentViewAfter(key, host.view)
  $.ui.invalidate('ui.render')
  await liveHost($, AGENTS_INFO_SCENE_ID, cmd.name, cmd.data)
}

/** What the drill-down loop reads from here: the tile's folder, the rows of the last look, the pulse's loops and events. */
const detailSource: DetailSource = {
  dir: () => host.dir,
  rows: () => host.prev ?? [],
  pulse: now => pulseBoardParts(now),
}

/** Start the drill-down loop (once per module instance, see ./agent-detail-host.ts); `bind` says where the page's clicks land. */
export function agentsInfoBind($: Dollar, bind: DetailBind): void {
  startDetailLoop($, detailSource, bind)
}

/** Copy the scene's files into its folder; the folder's real path, or null when the source is not built (quiet). */
export async function agentsInfoInstall($: Dollar, tmp: string): Promise<string | null> {
  const dir = agentsInfoDirOf(tmp, await $.session.id())
  if ((await installScene($, AGENTS_INFO_SOURCE_DIR, dir)) < 0) return null
  return (await $.fs.stat(dir, { resolve: true }).catch(() => undefined))?.realPath ?? dir
}

function log($: Dollar, text: string): void {
  $.ui.log(`${PLUGIN_NAME}: ${text}`, { to: 'debug' })
}

/** One look at the board's input: the transitions since the last look join the events, and the data is written when it changed. Never throws. */
export async function agentsInfoPush($: Dollar, input: BoardInput): Promise<void> {
  try {
    const isCrew = hasCrew(input)
    if (isCrew && !host.wasCrew) {
      host.wasCrew = true
      host.onCrew?.()
    }
    if (host.nextId === 0) host.nextId = input.now
    // The first look: agents that already ran for a while are the baseline (a reload announces nothing); one that just started is announced.
    const rows = isCrew ? agentRowsOf(input).agents : []
    const baseline = host.prev ?? rows.filter(a => input.now - a.startedAt >= FRESH_AGENT_MS)
    const fresh = diffAgents(baseline, rows, input.now, host.nextId, host.events)
    host.prev = rows
    const buttonsKey = rows.map(r => r.id).join(',')
    if (buttonsKey !== host.buttonsKey) {
      host.buttonsKey = buttonsKey
      $.ui.invalidate('ui.render') // the pane's agent buttons follow the rows
    }
    if (fresh.length > 0) {
      host.events = [...host.events, ...fresh].slice(-AGENTS_INFO_CAPS.EVENTS)
      host.nextId = (fresh[fresh.length - 1]?.id ?? host.nextId) + 1
    }
    if (host.dir === null) return
    const data = assembleAgentsInfo(input, host.events)
    const key = dataKey(data)
    if (key === host.lastKey) return
    await writeLive($, host.dir, DATA_FILE_NAME, DATA_TEMP_NAME, JSON.stringify(data) + '\n')
    host.lastKey = key
  } catch (err) {
    log($, `agents-info: ${String(err)}`)
  }
}

/** For tests: forget everything (a new module instance would). */
export function resetAgentsInfo(): void {
  Object.assign(host, { dir: null, prev: null, events: [], nextId: 0, lastKey: '', wasCrew: false, onCrew: null, view: NO_VIEW, buttonsKey: '' })
}
