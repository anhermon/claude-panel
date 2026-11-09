// The board, wired: the model's frames in memory, the files of the built-in scene, and live/data.json, which the scene
// polls with panel.data. The data is assembled (./board-model.ts) from the model's frames, the latest panel state (task,
// status, ask), the agent lanes and the Pulse feed, and written through a coalescing flusher: at most two writes a second,
// only when the content changed (the clock fields do not count), atomically. register.tsx owns the atoms and the state
// writes, so this file never touches the state: it is told the state (`boardNote`), answers with data and register.tsx
// applies it. `$` only ever goes to function declarations. Module state lives in `board` below; a reload of the mod
// starts a new one and reads the model back from its sidecar file.
import type { EngineInterface } from 'claude-code'

import type { BoardLane, PanelState } from '../types'
import { varietyHint, pushRecent, SCENE_FORM } from './variety'
import { assembleBoard, assembleFrames, applyFramePlan, contentKey, newBoardModel, restoreBoardModel, withCount } from './board-model'
import { hasFramePart } from './board-model'
import type { BoardInput, BoardModel, FramePlan } from './board-model'
import { boardDirOf, DATA_FILE_NAME, DATA_TEMP_NAME, installBoard, MODEL_FILE_NAME, MODEL_TEMP_NAME, readLive, writeLive } from './board-io'
import { createFlusher } from './pulse-flush'
import type { Flusher } from './pulse-flush'
import { applyLanes, pulseBoardParts, setPulseListener } from './pulse-host'
import { hasLanePart } from './pulse-lanes'
import type { LanePlan } from './pulse-lanes'
import { ROUTER_IO, readRouter } from './router-io'
import type { RouterRead } from './router-io'
import { newSessionsCache, readSessions } from './sessions-io'
import type { SessionsCache } from './sessions-io'
import type { SessionRow } from './sessions-state'
import { panelConfig } from './panel-config'
import { PLUGIN_NAME } from './spec'
import { watchedFolder } from './watch'
import { agentsInfoLive, agentsInfoNote, agentsInfoPush, agentsInfoSessions } from './agents-info-host'

type Dollar = EngineInterface

/** The slice of the panel state the board draws; the board never keeps the whole state. */
type Slice = Pick<PanelState, 'status' | 'task' | 'ask' | 'choices'>
const EMPTY_SLICE: Slice = { status: 'working', task: null, ask: null, choices: [] }

type Board = {
  model: BoardModel
  slice: Slice
  dir: string
  flusher: Flusher | null
  lastKey: string
  /** The router-kit state last read from `<cwd>/.router/` (./router-io.ts) and the poll that keeps it fresh. */
  router?: RouterRead
  /** The folder `router` was read from (the watched one, else the session cwd). */
  routerRoot?: string
  poll?: { cancel: () => void }
  isPolling?: boolean
  /** The other live sessions (./sessions-io.ts) as last read, what that read remembers, and a guard so two reads never overlap. */
  sessions?: SessionRow[]
  sessionsKey?: string
  sessionsCache?: SessionsCache
  isScanning?: boolean
}
let board: Board | null = null

function log($: Dollar, text: string): void {
  $.ui.log(`${PLUGIN_NAME}: ${text}`, { to: 'debug' })
}

const sliceOf = (s: PanelState): Slice => ({ status: s.status, task: s.task, ask: s.ask, choices: Array.isArray(s.choices) ? s.choices : [] })

function inputOf(b: Board, now: number): BoardInput {
  const parts = pulseBoardParts(now)
  return { ...b.slice, lanes: parts.lanes as BoardLane[], loops: parts.loops, pulse: parts.pulse, events: parts.events, hasAgentsTile: agentsInfoLive(), router: b.router?.run, sessions: b.sessions, now }
}

/** Read `.router/` again (cheap: a listing and a stat per file unless something changed); a change wakes the writer. Never throws. */
async function routerTick($: Dollar, b: Board): Promise<void> {
  if (b.isPolling === true) return
  b.isPolling = true
  try {
    const root = (await watchedFolder($)) ?? (await $.session.cwd())
    const isSwitch = b.routerRoot !== root // a new folder never reuses the old folder's read, even on an equal signature
    b.routerRoot = root
    const prev = isSwitch ? undefined : b.router
    if (isSwitch) b.router = undefined // the old folder's run goes at once, even if the new read fails
    const next = await readRouter($, root, prev)
    b.router = next
    if (isSwitch || next.run !== prev?.run) b.flusher?.touch()
  } catch (err) {
    log($, `board: could not read .router: ${String(err)}`)
  } finally {
    b.isPolling = false
  }
}

/** Read the other live sessions again (mtime-gated, tail-only; nothing at all while the setting is off); a change wakes the writer. Never throws. */
async function sessionsTick($: Dollar, b: Board): Promise<void> {
  if (b.isScanning === true) return
  b.isScanning = true
  try {
    b.sessionsCache ??= newSessionsCache()
    const rows = await readSessions($, b.sessionsCache, await $.session.id(), await $.clock.now(), panelConfig.sessionsFrame)
    const key = JSON.stringify(rows)
    if (key === (b.sessionsKey ?? '[]')) return
    b.sessionsKey = key
    b.sessions = rows
    agentsInfoSessions(rows)
    b.flusher?.touch()
  } catch (err) {
    log($, `board: could not read the other sessions: ${String(err)}`)
  } finally {
    b.isScanning = false
  }
}

/** Session start (and every reload): the scene's files, the model read back, the writer. Quiet when the board is not built yet. */
export async function boardStart($: Dollar, tmp: string, state: PanelState): Promise<void> {
  board?.poll?.cancel()
  board = null
  setPulseListener(null)
  try {
    const dir = boardDirOf(tmp, await $.session.id())
    if ((await installBoard($, dir)) < 0) return
    const b: Board = { model: newBoardModel(), slice: sliceOf(state), dir, flusher: null, lastKey: '' }
    b.model = restoreBoardModel(await readLive($, dir, MODEL_FILE_NAME))
    b.flusher = createFlusher({
      after: (ms, fn) => $.clock.after(ms, fn),
      onError: err => log($, `board: could not write the data: ${String(err)}`),
      run: () => flush($, b),
    })
    board = b
    await routerTick($, b)
    await sessionsTick($, b)
    b.poll = $.clock.every(ROUTER_IO.POLL_MS, () => {
      void routerTick($, b)
      void sessionsTick($, b)
    })
    setPulseListener({ touch: () => b.flusher?.touch(), flushNow: () => b.flusher?.flushNow() ?? Promise.resolve() })
    b.flusher.touch()
  } catch (err) {
    log($, `board: did not start: ${String(err)}`)
  }
}

/** Write live/data.json when what the person would see changed. */
async function flush($: Dollar, b: Board): Promise<void> {
  const input = inputOf(b, await $.clock.now())
  await agentsInfoPush($, input) // the agents scene shares this writer (./agents-info-host.ts); it never throws
  const data = assembleBoard(b.model, input)
  const key = contentKey(data)
  if (key === b.lastKey) return
  await writeLive($, b.dir, DATA_FILE_NAME, DATA_TEMP_NAME, JSON.stringify(data) + '\n')
  b.lastKey = key
}

/** The folder the built-in scene is served from (its real path), or null while the board is not installed. */
export async function boardSceneDir($: Dollar): Promise<string | null> {
  const b = board
  if (b === null || b.dir === '') return null
  return (await $.fs.stat(b.dir, { resolve: true }).catch(() => undefined))?.realPath ?? b.dir
}

/** The state changed (any write): the board's task / status / ask follow it. Cheap and synchronous. */
export function boardNote(state: PanelState): void {
  agentsInfoNote(state)
  if (board === null) return
  board.slice = sliceOf(state)
  board.flusher?.touch()
}

/** The model as it stands now, as plain data for the session state (undefined: nothing is kept in memory). */
export const boardKept = (): BoardModel | undefined => board?.model

/** Put a kept model back after a reload, only when this instance has no frames and no removals yet. */
export function boardAdopt(kept: unknown, state: PanelState): void {
  const restored = restoreBoardModel(kept)
  if (restored.frames.length === 0 && restored.removedAuto.length === 0) return
  const b = board ?? newBare(state)
  if (b.model.frames.length > 0 || b.model.removedAuto.length > 0) return
  b.model = restored
  if (board === null) board = b
  b.flusher?.touch()
}

const newBare = (state: PanelState): Board => ({ model: newBoardModel(), slice: sliceOf(state), dir: '', flusher: null, lastKey: '' })

export type FrameOutcome = { lines: string[]; deny?: undefined } | { deny: string; lines?: undefined }

/** Apply a validated frame plan: the model changes, the sidecar and the board follow. The lines end with `· N on board`. */
export async function applyFrames($: Dollar, plan: FramePlan, state: PanelState): Promise<FrameOutcome> {
  const b = board ?? newBare(state)
  b.slice = sliceOf(state)
  const applied = applyFramePlan(b.model, plan)
  if (!applied.isOk) return { deny: applied.error }
  b.model = applied.model
  if (board === null) board = b // no board scene yet: the model still lives in memory (see boardStart)
  const onBoard = assembleFrames(b.model, inputOf(b, await $.clock.now())).length
  if (applied.isChanged && b.dir !== '') {
    try {
      await writeLive($, b.dir, MODEL_FILE_NAME, MODEL_TEMP_NAME, JSON.stringify(b.model) + '\n')
    } catch (err) {
      log($, `board: could not save the frames: ${String(err)}`)
    }
  }
  b.flusher?.touch()
  const hint = varietyHint(b.model.recent)
  return { lines: [...withCount(applied.notes, onBoard), ...(hint === '' ? [] : [hint])] }
}

/** The one-line nudge when the recent forms repeat ('' otherwise): for the system prompt. */
export const boardVarietyHint = (): string => varietyHint(board?.model.recent ?? [])

/** A scene publish counts as a form too (the memory of recent forms, see ./variety.ts). */
export function boardNoteScene(state: PanelState): void {
  const b = board ?? (board = newBare(state))
  b.model = { ...b.model, recent: pushRecent(b.model.recent, SCENE_FORM) }
}

const DENY_JOIN = '\n'

/**
 * The lane part and the frame part of one `panel` call (both upsert-only, both safe for a worker), applied for loop
 * `agentId`. The result lines carry what was done and what was refused; `deny` is set only when nothing was applied.
 */
export async function applyParts($: Dollar, lanes: LanePlan, frames: FramePlan, agentId: unknown, state: PanelState): Promise<{ lines: string[]; deny?: string }> {
  const lines: string[] = []
  const denied: string[] = []
  if (hasLanePart(lanes)) {
    const lane = await applyLanes($, lanes, agentId)
    if (lane.deny === undefined) lines.push(...lane.lines)
    else denied.push(lane.deny)
  }
  if (hasFramePart(frames)) {
    const frame = await applyFrames($, frames, state)
    if (frame.deny === undefined) lines.push(...frame.lines)
    else denied.push(frame.deny)
  }
  return lines.length === 0 && denied.length > 0 ? { lines, deny: denied.join(DENY_JOIN) } : { lines: [...lines, ...denied] }
}
