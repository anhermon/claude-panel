// The board's model, pure (no `$`, no I/O): the `frame` / `frame_remove` / `frames_clear` part of the `panel` tool and the
// assembly of the board's data. The frames the model sends are UPSERT-ONLY (a frame call never replaces anything else of
// the panel, so a subagent can call it safely), keyed by id, kept in the mod's memory (at most BOARD_CAPS.FRAMES) and
// never in PanelState. AUTO frames (`now`, `ask`, `limits`, `lanes`, `bars`, `delegation`, `pipeline`, `time-by-kind`, `time-sinks`, `repeats`, `improve`, `sessions` (the other live Claude Code sessions), and with a `.router/` folder `tickets` / `checks` / `router-events`) keep the board alive with no frame at all; the model
// overrides one by sending a frame with its id and silences one with `frame_remove`. Every refusal names the field.
import type { BoardData, BoardFrame, BoardLane, PanelChoice, PanelStatus, PanelTask } from '../types'
import { Invalid, cut, isAbsent, isPlain } from './blocks/common'
import type { Plain } from './blocks/common'
import { delegationFrame, pipelineFrame } from './agent-graph'
import { agentBars, agentLanes, agentSwimlane, DOING_TITLE, DOD_FRAME_PREFIX, dodFrames, hasAgents } from './board-agents'
import { FRAME_CAPS, frameId, validateFrame } from './board-frames'
import { INSIGHT_FRAME_IDS, insightFrames } from './insight-frames'
import { nowFrame } from './now-frame'
import { limitsFrameOf } from './limits-frame'
import type { ProviderQuota } from './limits-quota'
import type { LimitsUsage } from './limits-state'
import { panelConfig } from './panel-config'
import type { PulseEvent, PulseLoop } from './pulse-model'
import { routerFrames, ROUTER_FRAME_IDS } from './router-frames'
import type { RouterRun } from './router-state'
import { sessionsFrame, SESSIONS_FRAME_ID } from './sessions-frame'
import type { SessionRow } from './sessions-state'
import { pushRecent, restoreRecent } from './variety'

export const BOARD_CAPS = {
  /** Frames the model may keep on the board at once. */
  FRAMES: 12,
} as const

export const FRAME_KEY = 'frame'
export const FRAME_REMOVE_KEY = 'frame_remove'
export const FRAMES_CLEAR_KEY = 'frames_clear'
export const FRAME_INPUT_KEYS = [FRAME_KEY, FRAME_REMOVE_KEY, FRAMES_CLEAR_KEY] as const

/** The ids of the frames the mod draws by itself. */
export const AUTO = { NOW: 'now', ASK: 'ask', LIMITS: 'limits', LANES: 'lanes', BARS: 'bars', DELEGATION: 'delegation', PIPELINE: 'pipeline', DOING: 'now-doing', TIMELINE: 'activity-timeline' } as const
export const AUTO_IDS: readonly string[] = [...Object.values(AUTO), ...INSIGHT_FRAME_IDS, ...ROUTER_FRAME_IDS, SESSIONS_FRAME_ID]
/** An auto frame: one of AUTO, or the checklist frame of a lane (`dod-<lane id>`). */
export const isAutoId = (id: string): boolean => AUTO_IDS.includes(id) || id.startsWith(DOD_FRAME_PREFIX)
const AUTO_TITLES = { now: 'Now', ask: 'Question', lanes: 'Agents' } as const
const AUTO_SIZE = { now: 'm', ask: 'm', lanes: 'l' } as const
const NAME_JOIN = ', '

export type FramePlan = { rest: Plain; upsert?: BoardFrame; remove?: string[]; isClear: boolean }
export type FramePlanResult = { isOk: true; plan: FramePlan } | { isOk: false; error: string }

/** What the model keeps on the board: its frames in order, and the auto frames it removed (until `frames_clear`). */
export type BoardModel = { frames: BoardFrame[]; removedAuto: string[]; recent: string[] }
export const newBoardModel = (): BoardModel => ({ frames: [], removedAuto: [], recent: [] })

/**
 * Split one `panel` call's input into its frame part and the rest. The frame part is validated here (nothing is applied),
 * so a call with a bad frame and a good section changes neither. `rest` has no frame key.
 */
export function planFrames(input: Plain): FramePlanResult {
  const { [FRAME_KEY]: frame, [FRAME_REMOVE_KEY]: remove, [FRAMES_CLEAR_KEY]: clear, ...rest } = input
  try {
    const plan: FramePlan = { rest, isClear: false }
    if (!isAbsent(clear)) {
      if (typeof clear !== 'boolean') throw new Invalid(`${FRAMES_CLEAR_KEY} must be true or false`)
      plan.isClear = clear
    }
    if (!isAbsent(remove)) {
      const ids = Array.isArray(remove) ? remove : [remove]
      if (ids.length === 0) throw new Invalid(`${FRAME_REMOVE_KEY} must be a frame id or a non-empty array of ids`)
      plan.remove = ids.map((id, i) => frameId(id, Array.isArray(remove) ? `${FRAME_REMOVE_KEY}[${i}]` : FRAME_REMOVE_KEY))
    }
    if (!isAbsent(frame)) plan.upsert = validateFrame(frame, FRAME_KEY)
    return { isOk: true, plan }
  } catch (err) {
    if (err instanceof Invalid) return { isOk: false, error: `panel: ${err.message}` }
    throw err
  }
}

/** Does the call carry a frame part at all? */
export const hasFramePart = (plan: FramePlan): boolean => plan.upsert !== undefined || plan.remove !== undefined || plan.isClear

const idsOf = (frames: readonly BoardFrame[]): string => frames.map(f => f.id).join(NAME_JOIN) || 'none'

export type FrameApplied =
  | { isOk: true; model: BoardModel; notes: string[]; isChanged: boolean }
  | { isOk: false; error: string }

/**
 * The model with the plan applied: clear first, then remove, then upsert. `notes` are the result lines WITHOUT the
 * `· N on board` tail (the caller knows the final count, see `withCount`). A new id on a full model is refused.
 */
export function applyFramePlan(prev: BoardModel, plan: FramePlan): FrameApplied {
  let frames = [...prev.frames]
  let removedAuto = [...prev.removedAuto]
  let recent = prev.recent
  const notes: string[] = []
  if (plan.isClear) {
    notes.push(`frames cleared (${frames.length} removed)`)
    frames = []
    removedAuto = []
  }
  for (const id of plan.remove ?? []) {
    const isThere = frames.some(f => f.id === id)
    const isAuto = isAutoId(id)
    frames = frames.filter(f => f.id !== id)
    if (isAuto && !removedAuto.includes(id)) removedAuto.push(id)
    if (isThere) notes.push(`frame ${id} removed`)
    else if (isAuto) notes.push(`frame ${id} removed (auto; frames_clear brings it back)`)
    else notes.push(`no frame "${id}" to remove; frames: ${idsOf(frames)}`)
  }
  const frame = plan.upsert
  if (frame !== undefined) {
    const at = frames.findIndex(f => f.id === frame.id)
    if (at < 0 && frames.length >= BOARD_CAPS.FRAMES)
      return {
        isOk: false,
        error:
          `panel: ${FRAME_KEY}: already ${BOARD_CAPS.FRAMES} frames (${idsOf(frames)}): remove one with ${FRAME_REMOVE_KEY} ` +
          `before adding "${frame.id}" (or reuse one of those ids to replace it)`,
      }
    frames = at < 0 ? [...frames, frame] : frames.map((f, i) => (i === at ? frame : f))
    removedAuto = removedAuto.filter(id => id !== frame.id)
    notes.push(`frame ${frame.id} · ${frame.type}`)
    // A viz frame is remembered by its kind: five different charts are five forms, not "viz" five times.
    const kind = (frame as { kind?: unknown }).kind
    recent = pushRecent(recent, frame.type === 'viz' && typeof kind === 'string' ? kind : frame.type)
  }
  // `recent` is not part of the change: re-sending the same frame is no change to the board (it is still remembered as a form)
  const isChanged = JSON.stringify([frames, removedAuto]) !== JSON.stringify([prev.frames, prev.removedAuto])
  return { isOk: true, model: { frames, removedAuto, recent }, notes, isChanged }
}

/** `frame cpu-latency · line · 8 on board`: every note ends with how many frames the person sees now. */
export const withCount = (notes: readonly string[], onBoard: number): string[] => notes.map(n => `${n} · ${onBoard} on board`)

/** A stored model (the sidecar file) read back; every frame is re-validated, a bad one is dropped. Never throws. */
export function restoreBoardModel(json: unknown): BoardModel {
  const model = newBoardModel()
  if (!isPlain(json)) return model
  if (Array.isArray(json.frames))
    for (const raw of json.frames.slice(0, BOARD_CAPS.FRAMES)) {
      try {
        const frame = validateFrame(raw)
        if (!model.frames.some(f => f.id === frame.id)) model.frames.push(frame)
      } catch {
        // a frame that no longer validates is gone
      }
    }
  model.recent = restoreRecent(json.recent)
  if (Array.isArray(json.removedAuto)) model.removedAuto = json.removedAuto.filter((id): id is string => typeof id === 'string' && isAutoId(id))
  return model
}

// ---- the board's data ------------------------------------------------------------------------------------------------

/** What the assembly needs from the rest of the mod. */
export type BoardInput = {
  task: PanelTask | null
  status: PanelStatus
  ask: string | null
  choices: readonly PanelChoice[]
  lanes: readonly BoardLane[]
  /** The pulse's loops (the main one and the agents) while the feed is on; none while it is off. */
  loops: readonly PulseLoop[]
  /** The Pulse feed's snapshot while the feed is on; undefined while it is off. */
  pulse: unknown
  /** The pulse's event ring (the latest events of every loop) for the agents' insight; none while the feed is off. */
  events?: readonly PulseEvent[]
  /**
   * The Agents tile (./agents-info-host.ts) is registered: it is THE place for the state of every agent, so the board leaves out its
   * own agent rows (`lanes`, `now-doing`), the per-agent `bars` and the checklist tracks (`pipeline`). One rule, see `autoFrames`.
   */
  hasAgentsTile?: boolean
  /** The router-kit run read from `<cwd>/.router/` (./router-io.ts); undefined when the session has none: nothing is drawn. */
  router?: RouterRun
  /** Latest engine quota, context fill and optional cost; never kept with the model's frames. */
  usage?: LimitsUsage
  quota?: readonly ProviderQuota[]
  /** The other live Claude Code sessions (./sessions-io.ts), ordered and capped; undefined or empty: nothing is drawn. */
  sessions?: readonly SessionRow[]
  now: number
}

/** The rows of the lanes frame (and of `data.lanes`): one per agent plus the posted lanes; just the posted lanes when there is no agent. */
function agentRows(input: BoardInput): BoardLane[] {
  return hasAgents(input.lanes, input.loops) ? agentLanes(input.lanes, input.loops, input.task?.title ?? '', input.now, input.events) : [...input.lanes]
}

function autoFrames(input: BoardInput): { ask: BoardFrame[]; rest: { id: string; frame: BoardFrame }[] } {
  const rest: { id: string; frame: BoardFrame }[] = []
  const ask: BoardFrame[] = []
  if (input.task !== null && input.task.title.trim() !== '')
    rest.push({ id: AUTO.NOW, frame: nowFrame({ rows: agentRows(input), router: input.router, task: input.task.title.trim(), status: input.status, now: input.now }) })
  if (input.ask !== null && input.ask.trim() !== '')
    ask.push({
      id: AUTO.ASK,
      type: 'ask',
      title: AUTO_TITLES.ask,
      size: AUTO_SIZE.ask,
      q: cut(input.ask.trim(), FRAME_CAPS.ASK_Q_CHARS),
      options: input.choices.slice(0, FRAME_CAPS.ASK_OPTIONS).map(c => cut(c.label, FRAME_CAPS.ASK_OPTION_CHARS)),
    })
  // A router-kit run (`.router/`): its tickets (or the checks of its one ticket) and latest events sit right under the task.
  for (const frame of routerFrames(input.router, input.now)) rest.push({ id: frame.id, frame })
  const limits = limitsFrameOf(input.usage, input.now, panelConfig.limitsShowPct, input.quota)
  if (limits !== undefined) rest.push({ id: AUTO.LIMITS, frame: { id: AUTO.LIMITS, ...limits } })
  const isTile = input.hasAgentsTile === true // the tile shows every agent row and its drill-down: no second copy here
  if (hasAgents(input.lanes, input.loops)) {
    // what each agent is doing right now sits above the agents frame, which has the detail
    if (!isTile && agentRows(input).some(r => r.insight !== undefined)) rest.push({ id: AUTO.DOING, frame: { id: AUTO.DOING, type: 'doing', title: DOING_TITLE, size: 's' } })
    if (!isTile) rest.push({ id: AUTO.LANES, frame: { id: AUTO.LANES, type: 'lanes', title: AUTO_TITLES.lanes, size: AUTO_SIZE.lanes } })
    rest.push(...dodFrames(agentRows(input), input.now))
  }
  // The `pulse` frame (orbit, sparks) is decoration: only a frame the model sends puts it on the board.
  const bars = isTile ? undefined : agentBars(input.loops, input.now)
  if (bars !== undefined) rest.push({ id: AUTO.BARS, frame: bars })
  const timeline = isTile ? undefined : agentSwimlane(input.loops, input.events ?? [], input.now) // the tile's gantt IS this timeline
  if (timeline !== undefined) rest.push({ id: AUTO.TIMELINE, frame: timeline })
  // Where the time went, what repeated and what to improve: each frame is left out while its data is thin (hooks/insight-frames.ts).
  for (const frame of insightFrames(input.loops, input.events ?? [], input.now)) rest.push({ id: frame.id, frame })
  // The two live diagrams (who handed work to whom, each agent's checklist as a track) come last: below the agents frame, from two agents.
  const delegation = delegationFrame(input.loops, input.events, input.router)
  if (delegation !== undefined) rest.push({ id: AUTO.DELEGATION, frame: delegation })
  const pipeline = isTile ? undefined : pipelineFrame(agentRows(input), input.loops)
  if (pipeline !== undefined) rest.push({ id: AUTO.PIPELINE, frame: pipeline })
  const sessions = sessionsFrame(input.sessions) // the other sessions on this machine, last: context, not this run's work
  if (sessions !== undefined) rest.push({ id: SESSIONS_FRAME_ID, frame: sessions })
  return { ask, rest }
}

/**
 * The final frames: a pending question first, then the model's frames in their order, then the other auto frames. An auto
 * frame is left out when the model has a frame with its id or removed it. Works with no model frame at all.
 */
export function assembleFrames(model: BoardModel, input: BoardInput): BoardFrame[] {
  const taken = new Set(model.frames.map(f => f.id))
  const silenced = new Set(model.removedAuto)
  const wanted = (id: string): boolean => !taken.has(id) && !silenced.has(id)
  const auto = autoFrames(input)
  return [...auto.ask.filter(f => wanted(f.id)), ...model.frames, ...auto.rest.filter(a => wanted(a.id)).map(a => a.frame)]
}

/** The whole `live/data.json` of the board. */
export function assembleBoard(model: BoardModel, input: BoardInput): BoardData {
  return {
    frames: assembleFrames(model, input),
    ...(input.pulse === undefined ? {} : { pulse: input.pulse }),
    lanes: agentRows(input),
    now: { title: input.task?.title ?? '', status: input.status },
    updatedAt: input.now,
  }
}

/** The same data with the clock-like fields zeroed: two boards with an equal key look the same to the person. */
export function contentKey(data: BoardData): string {
  const pulse = isPlain(data.pulse) ? { ...data.pulse, now: 0 } : data.pulse
  return JSON.stringify({ ...data, pulse, updatedAt: 0 })
}
