// Agent lanes: the one-line progress a worker posts with `panel {lane: {id, state, pct, step}}`. UPSERT-ONLY (a
// lane call never replaces anything else of the panel, so a subagent can call it safely), keyed by id, kept in the
// mod's memory (at most LANE_CAPS.LANES) and written to live/pulse.json. Pure: no `$`, no I/O. Every refusal throws
// `Invalid` / returns an error that names the field.
import { Invalid, isAbsent, isPlain, str } from './blocks/common'
import type { Plain } from './blocks/common'
import { FRAME_CAPS, STEP_STATES } from './board-frames'

export const LANE_CAPS = {
  LANES: 12,
  ID_PATTERN: /^[a-z0-9-]{1,24}$/,
  /** A Claude Code session id (the uuid that names `<id>.jsonl`). */
  SESSION_PATTERN: /^[A-Za-z0-9_-]{1,64}$/,
  ID_CHARS: 24,
  LABEL_CHARS: 60,
  STEP_CHARS: 80,
  NOTE_CHARS: 120,
  /** What the agent is after, one line; the title of its checklist frame. */
  GOAL_CHARS: FRAME_CAPS.TITLE_CHARS,
  /** The checklist (definition of done): the same items as a `steps` frame. */
  DOD_ITEMS: FRAME_CAPS.STEPS_ITEMS,
  DOD_TEXT_CHARS: FRAME_CAPS.STEP_CHARS,
  PCT_MIN: 0,
  PCT_MAX: 100,
} as const

export const LANE_STATES = ['working', 'testing', 'waiting', 'blocked', 'done'] as const
export type LaneState = (typeof LANE_STATES)[number]
export const LANE_KEY = 'lane'
export const LANE_REMOVE_KEY = 'lane_remove'
export const LANE_INPUT_KEYS = [LANE_KEY, LANE_REMOVE_KEY] as const
const LANE_FIELDS = ['id', 'label', 'state', 'pct', 'step', 'note', 'goal', 'dod', 'at', 'session'] as const
const DOD_FIELDS = ['t', 'state'] as const
const DEFAULT_STATE: LaneState = 'working'
const DONE_STATE: LaneState = 'done'
const NAME_JOIN = ', '

export type Lane = {
  id: string
  label: string
  state: LaneState
  /** 0..100, or null when the worker never gave one (the rail then shows it as under way). */
  pct: number | null
  step: string
  note: string
  /** What the agent is after ('' when it never said). */
  goal: string
  /** The checklist the agent posted (definition of done); empty when none. */
  dod: DodItem[]
  /** Index into `dod` of the item being worked on, or null. */
  at: number | null
  /** The Claude Code session this lane stands for (its row opens that session's transcript); absent for any other lane. */
  session?: string
  startedAt: number
  updatedAt: number
  /** The loop (`main` or an agent id) whose call last posted it. */
  by: string
}

export type DodState = (typeof STEP_STATES)[number]
export type DodItem = { t: string; state: DodState }

/** The fields one lane call carries; an absent field keeps the lane's value. */
export type LanePatch = { id: string; label?: string; state?: LaneState; pct?: number; step?: string; note?: string; goal?: string; dod?: DodItem[]; at?: number; session?: string }
export type LanePlan = { rest: Plain; upsert?: LanePatch; remove?: string; trimmed: string[] }
export type PlanResult = { isOk: true; plan: LanePlan } | { isOk: false; error: string }
export type LaneApplied = { isOk: true; lanes: Lane[]; lines: string[] } | { isOk: false; error: string }

const at = (name: string): string => `${LANE_KEY}.${name}`

function laneId(v: unknown, name: string): string {
  if (typeof v !== 'string' || !LANE_CAPS.ID_PATTERN.test(v))
    throw new Invalid(
      `${name} ${JSON.stringify(v)} is invalid: use 1-${LANE_CAPS.ID_CHARS} characters from a-z, 0-9 and "-" (for example "t25")`,
    )
  return v
}

function sessionId(v: unknown): string {
  if (typeof v !== 'string' || !LANE_CAPS.SESSION_PATTERN.test(v))
    throw new Invalid(`${at('session')} ${JSON.stringify(v)} is invalid: use a Claude Code session id (1-64 characters from A-Z, a-z, 0-9, "_" and "-")`)
  return v
}

function parseDod(v: unknown, trimmed: string[]): DodItem[] {
  if (!Array.isArray(v)) throw new Invalid(`${at('dod')} must be an array of {t, state todo|doing|done|failed}`)
  if (v.length > LANE_CAPS.DOD_ITEMS) throw new Invalid(`${at('dod')} has ${v.length} items; the limit is ${LANE_CAPS.DOD_ITEMS}`)
  return v.map((raw, i) => {
    const p = `${at('dod')}[${i}]`
    if (!isPlain(raw)) throw new Invalid(`${p} must be an object {t, state}`)
    for (const key of Object.keys(raw))
      if (!(DOD_FIELDS as readonly string[]).includes(key)) throw new Invalid(`${p}.${key} is not a known field (allowed: ${DOD_FIELDS.join(NAME_JOIN)})`)
    if (!(STEP_STATES as readonly unknown[]).includes(raw.state))
      throw new Invalid(`${p}.state ${JSON.stringify(raw.state)} must be one of ${STEP_STATES.join(NAME_JOIN)}`)
    const t = str(raw.t, `${p}.t`, LANE_CAPS.DOD_TEXT_CHARS, trimmed)
    if (t === '') throw new Invalid(`${p}.t must not be empty`)
    return { t, state: raw.state as DodState }
  })
}

function parsePatch(v: unknown, trimmed: string[]): LanePatch {
  if (!isPlain(v)) throw new Invalid(`${LANE_KEY} must be an object {id, label?, state?, pct?, step?, note?}`)
  for (const key of Object.keys(v))
    if (!(LANE_FIELDS as readonly string[]).includes(key))
      throw new Invalid(`${at(key)} is not a known field (allowed: ${LANE_FIELDS.join(NAME_JOIN)})`)
  const patch: LanePatch = { id: laneId(v.id, at('id')) }
  if (!isAbsent(v.label)) patch.label = str(v.label, at('label'), LANE_CAPS.LABEL_CHARS, trimmed)
  if (!isAbsent(v.state)) {
    if (!(LANE_STATES as readonly unknown[]).includes(v.state))
      throw new Invalid(`${at('state')} ${JSON.stringify(v.state)} must be one of ${LANE_STATES.join(NAME_JOIN)}`)
    patch.state = v.state as LaneState
  }
  if (!isAbsent(v.pct)) {
    if (typeof v.pct !== 'number' || !Number.isFinite(v.pct) || v.pct < LANE_CAPS.PCT_MIN || v.pct > LANE_CAPS.PCT_MAX)
      throw new Invalid(`${at('pct')} ${JSON.stringify(v.pct)} must be a number from ${LANE_CAPS.PCT_MIN} to ${LANE_CAPS.PCT_MAX}`)
    patch.pct = Math.round(v.pct)
  }
  if (!isAbsent(v.step)) patch.step = str(v.step, at('step'), LANE_CAPS.STEP_CHARS, trimmed)
  if (!isAbsent(v.note)) patch.note = str(v.note, at('note'), LANE_CAPS.NOTE_CHARS, trimmed)
  if (!isAbsent(v.goal)) patch.goal = str(v.goal, at('goal'), LANE_CAPS.GOAL_CHARS, trimmed)
  if (!isAbsent(v.dod)) patch.dod = parseDod(v.dod, trimmed)
  if (!isAbsent(v.at)) {
    const size = patch.dod?.length
    if (typeof v.at !== 'number' || !Number.isInteger(v.at) || v.at < 0 || v.at >= LANE_CAPS.DOD_ITEMS)
      throw new Invalid(`${at('at')} ${JSON.stringify(v.at)} must be a whole number from 0 to ${LANE_CAPS.DOD_ITEMS - 1} (the index of the dod item in progress)`)
    if (size !== undefined && v.at >= size) throw new Invalid(`${at('at')} ${v.at} is past the end of ${at('dod')} (${size} items)`)
    patch.at = v.at
  }
  if (!isAbsent(v.session)) patch.session = sessionId(v.session)
  return patch
}

/**
 * Split one `panel` call's input into its lane part and the rest. The lane part is validated here (nothing is
 * applied), so a call with a bad lane and a good section changes neither. `rest` has no lane key.
 */
export function planLanes(input: Plain): PlanResult {
  const { [LANE_KEY]: lane, [LANE_REMOVE_KEY]: remove, ...rest } = input
  const trimmed: string[] = []
  try {
    const plan: LanePlan = { rest, trimmed }
    if (!isAbsent(remove)) plan.remove = laneId(remove, LANE_REMOVE_KEY)
    if (!isAbsent(lane)) plan.upsert = parsePatch(lane, trimmed)
    return { isOk: true, plan }
  } catch (err) {
    if (err instanceof Invalid) return { isOk: false, error: `panel: ${err.message}` }
    throw err
  }
}

/** Does the call carry a lane part at all? */
export const hasLanePart = (plan: LanePlan): boolean => plan.upsert !== undefined || plan.remove !== undefined

/** `lane t25 · working 40%` (no percentage while none was given). */
export function laneLine(lane: Lane): string {
  return `lane ${lane.id} · ${lane.state}${lane.pct === null ? '' : ` ${lane.pct}%`}`
}

const idsOf = (lanes: readonly Lane[]): string => lanes.map(l => l.id).join(NAME_JOIN)

/** The lane list with the plan applied (remove first, then upsert), or the refusal. `by` is the posting loop. */
export function applyLanePlan(prev: readonly Lane[], plan: LanePlan, now: number, by: string): LaneApplied {
  let lanes = [...prev]
  const lines: string[] = []
  if (plan.remove !== undefined) {
    const id = plan.remove
    const isThere = lanes.some(l => l.id === id)
    lanes = lanes.filter(l => l.id !== id)
    lines.push(isThere ? `lane ${id} removed` : `no lane "${id}" to remove; lanes: ${idsOf(lanes) || 'none'}`)
  }
  const patch = plan.upsert
  if (patch === undefined) return { isOk: true, lanes, lines }
  const index = lanes.findIndex(l => l.id === patch.id)
  const old = index < 0 ? undefined : lanes[index]
  if (old === undefined && lanes.length >= LANE_CAPS.LANES) {
    const finished = lanes.filter(l => l.state === DONE_STATE).sort((a, b) => a.updatedAt - b.updatedAt)[0]
    if (finished === undefined)
      return {
        isOk: false,
        error:
          `panel: ${LANE_KEY}: already ${LANE_CAPS.LANES} active lanes (${idsOf(lanes)}): finish one (state "${DONE_STATE}") ` +
          `or remove it with ${LANE_REMOVE_KEY} before adding "${patch.id}"`,
      }
    lanes = lanes.filter(l => l !== finished)
  }
  const state = patch.state ?? old?.state ?? DEFAULT_STATE
  const pct = patch.pct ?? (state === DONE_STATE && old?.state !== DONE_STATE ? LANE_CAPS.PCT_MAX : (old?.pct ?? null))
  const dod = patch.dod ?? old?.dod ?? []
  const next: Lane = {
    id: patch.id,
    label: patch.label ?? old?.label ?? patch.id,
    state,
    pct,
    step: patch.step ?? old?.step ?? '',
    note: patch.note ?? old?.note ?? '',
    goal: patch.goal ?? old?.goal ?? '',
    dod,
    at: patch.at ?? (patch.dod !== undefined ? null : (old?.at ?? null)),
    startedAt: old?.startedAt ?? now,
    updatedAt: now,
    by,
  }
  const session = patch.session ?? old?.session
  if (session !== undefined) next.session = session
  lanes = old === undefined ? [...lanes, next] : lanes.map(l => (l.id === patch.id ? next : l))
  lines.push(laneLine(next))
  return { isOk: true, lanes, lines }
}

const NON_SLUG = /[^a-z0-9]+/g
const DASH_EDGES = /^-+|-+$/g
/** `T25 Ambient pulse` -> `t25-ambient-pulse` (the lane-id spelling), at most ID_CHARS characters. */
export const slug = (s: string): string => s.toLowerCase().replace(NON_SLUG, '-').replace(DASH_EDGES, '').slice(0, LANE_CAPS.ID_CHARS)

/** What a lane may be matched against: a loop's id, optional name and label. */
export type LaneTarget = { id: string; name?: string; label: string }

/**
 * The loop a lane belongs to: by id (the loop's id, name or label spelled as the lane id, or the lane id as the
 * start of the loop's label: `t25` for "T25 Ambient pulse"), or by an equal label; else the loop that posted it
 * when that was an agent; else none (a free-standing rail near the core).
 */
export function matchLane(lane: Lane, loops: readonly LaneTarget[], mainId: string): string | null {
  const laneLabel = slug(lane.label)
  for (const loop of loops) {
    const names = [loop.id, loop.name === undefined ? '' : slug(loop.name), slug(loop.label)]
    if (names.includes(lane.id)) return loop.id
    if (laneLabel !== '' && slug(loop.label) === laneLabel) return loop.id
    if (slug(loop.label).startsWith(`${lane.id}-`)) return loop.id
  }
  return lane.by !== mainId ? lane.by : null
}
