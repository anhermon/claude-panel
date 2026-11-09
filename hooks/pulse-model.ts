// The in-memory model behind the Pulse scene: per loop (`main` or an agent id) a label, a status, the last tool and
// target, per-tool counts, the recently touched file basenames, and a ring of the latest events. Pure and
// synchronous: no `$`, no I/O, time comes in as an argument. What may be stored is decided in ./pulse-redact.ts;
// this file never sees a prompt, an output or a full command. `snapshot` is the JSON the scene polls.
import { INTENT_CHARS, isFileTouch } from './pulse-redact'
import { LANE_CAPS, LANE_STATES, matchLane } from './pulse-lanes'
import type { DodItem, Lane, LaneState } from './pulse-lanes'
import { isPlain } from './blocks/common'
import { isPlaceholder, placeholderFor } from './agent-names'
import type { AgentProof } from './agent-proof'
import { isWorkKind, kindOf } from './work-kinds'
import type { WorkKind } from './work-kinds'
import { addSpan, extendSpan, restoreSpans } from './work-spans'
import type { Span } from './work-spans'
import { restoreTally, tallyBegin, tallyEnd } from './pulse-tally'
import type { Tally } from './pulse-tally'

export const MAIN_LOOP = 'main'
export const PULSE_CAPS = {
  RING_EVENTS: 200,
  OUT_EVENTS: 60,
  RECENT_FILES: 12,
  LOOPS: 24,
  TOOLS_PER_LOOP: 24,
  DISTINCT_FILES: 500,
  LABEL_CHARS: 60,
  NAME_CHARS: 40,
  WHY_CHARS: 120,
  ID_CHARS: 64,
  ID_TAIL: 4,
  PROOF_EVAL_CHARS: 200,
  PROOF_WHAT_CHARS: 60,
} as const
export const SNAPSHOT_VERSION = 1
const OTHER_TOOLS = 'other'
const SPAWN_TOOL = 'spawn'
const MAIN_LABEL = 'main'
/** The old placeholder (`agent e99c`) a stored snapshot may still carry. */
const HASH_LABEL = /^agent [0-9a-z]{2,8}$/i

export type LoopKind = 'main' | 'subagent' | 'teammate'
export type LoopStatus = 'running' | 'idle' | 'done'
export type TurnState = 'idle' | 'running'

export type PulseLoop = {
  id: string
  label: string
  name?: string
  /** The subagent type it was spawned as (`worker`, `Explore`, `router-kit:verifier`); absent when unknown. Read by hooks/agent-roles.ts. */
  type?: string
  /** What the agent was sent to do (`intentOf` of its dispatch prompt); '' when unknown. */
  intent?: string
  kind: LoopKind
  status: LoopStatus
  parent?: string
  lastTool: string
  lastTarget: string
  calls: number
  /** Tool calls started and not finished yet. */
  busy: number
  counts: Record<string, number>
  /** Recently touched file basenames, newest first. */
  files: string[]
  startedAt: number
  lastAt: number
  /** Tokens the loop's model requests used so far (`tokensOf` of each `turn.step`'s usage); absent until the first request is counted. */
  tokens?: number
  /** How its time went by kind of work, oldest first (hooks/work-spans.ts). */
  spans?: Span[]
  /** What it did over and over: calls, failures, retries and time per `read:file` / `edit:file` / `run:program verb` (hooks/pulse-tally.ts). */
  tally?: Tally
  /** The key of its last failed call until the same call succeeds (not stored: only a retry right after a failure counts). */
  failedKey?: string
  /** Set once a FINISHED ticket agent's brief and final report were read (hooks/agent-proof.ts): its eval, the gist and the reported result. Absent for an agent that is not a ticket or not read yet. */
  proof?: AgentProof
  /** The label is still an activity placeholder (`Subagent · reading`), not a title: a spawn, the engine's list or the transcript's brief replaces it. */
  isUntitled?: true
  /** A run of another harness (codex, agy) ingested from a run record (./pulse-ingest.ts), not seen through engine hooks. Absent on Claude agents. */
  harness?: string
  model?: string
  effort?: string
  runId?: string
  source?: 'external'
  /** `guessed`: its transcript was matched by folder and time, not by thread id. */
  confidence?: 'exact' | 'guessed'
  /** How a finished external run ended when `done` is not the whole story. */
  outcome?: RunOutcome
  /** The plain note of a `notstarted` run ("Not started: machine busy (load governor)"). */
  why?: string
  /** How much of the transcript an ingest already applied (calls, steps), so a second ingest adds nothing twice. */
  ingested?: { calls: number; steps: number }
}

/** `notstarted`: the attempt never ran (deferred by the load governor, refused): nothing happened, so it is neither done nor failed. */
export const RUN_OUTCOMES = ['failed', 'blocked', 'cancelled', 'aborted', 'notstarted'] as const
export type RunOutcome = (typeof RUN_OUTCOMES)[number]
const isOutcome = (v: unknown): v is RunOutcome => (RUN_OUTCOMES as readonly unknown[]).includes(v)

/** `kind`: what kind of work the call is (hooks/work-kinds.ts kindOf); absent for bookkeeping (a progress post). */
export type PulseEvent = { t: number; loop: string; tool: string; target: string; kind?: WorkKind; err?: true }

export type PulseModel = {
  startedAt: number
  turn: { state: TurnState; startedAt: number }
  loops: Map<string, PulseLoop>
  ring: PulseEvent[]
  lanes: Lane[]
  files: Set<string>
  spawned: number
  calls: number
  /** Something changed since the last snapshot. */
  isDirty: boolean
}

export function newModel(now: number): PulseModel {
  const model: PulseModel = {
    startedAt: now,
    turn: { state: 'idle', startedAt: 0 },
    loops: new Map(),
    ring: [],
    lanes: [],
    files: new Set(),
    spawned: 0,
    calls: 0,
    isDirty: true,
  }
  model.loops.set(MAIN_LOOP, blankLoop(MAIN_LOOP, MAIN_LABEL, 'main', now, 'idle'))
  return model
}

function blankLoop(id: string, label: string, kind: LoopKind, t: number, status: LoopStatus): PulseLoop {
  return { id, label, kind, status, lastTool: '', lastTarget: '', calls: 0, busy: 0, counts: {}, files: [], startedAt: t, lastAt: t }
}

const cutText = (s: string, max: number): string => s.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max)

/** A title found later (the agent's own brief) for a loop still showing a placeholder. Returns whether it applied. */
export function setLoopTitle(m: PulseModel, id: string, title: string): boolean {
  const loop = m.loops.get(id)
  const label = cutText(title, PULSE_CAPS.LABEL_CHARS)
  if (loop === undefined || loop.isUntitled !== true || label === '') return false
  loop.label = label
  delete loop.isUntitled
  m.isDirty = true
  return true
}

/** The proof read from a finished ticket agent's transcript (hooks/agent-proof.ts). Returns whether it changed the model. */
export function setLoopProof(m: PulseModel, id: string, proof: AgentProof): boolean {
  const loop = m.loops.get(id)
  if (loop === undefined || (loop.proof?.eval === proof.eval && loop.proof.what === proof.what && loop.proof.result === proof.result)) return false
  loop.proof = { eval: cutText(proof.eval, PULSE_CAPS.PROOF_EVAL_CHARS), what: cutText(proof.what, PULSE_CAPS.PROOF_WHAT_CHARS), result: proof.result }
  m.isDirty = true
  return true
}

/** The model and effort a subagent was started with (hooks/agent-meta.ts); a field already held is kept. Returns whether it changed the model. */
export function setLoopMeta(m: PulseModel, id: string, meta: { model?: string; effort?: string }): boolean {
  const loop = m.loops.get(id)
  if (loop === undefined) return false
  const model = loop.model === undefined ? meta.model : undefined
  const effort = loop.effort === undefined ? meta.effort : undefined
  if (model === undefined && effort === undefined) return false
  if (model !== undefined) loop.model = cutText(model, PULSE_CAPS.NAME_CHARS)
  if (effort !== undefined) loop.effort = cutText(effort, PULSE_CAPS.NAME_CHARS)
  m.isDirty = true
  return true
}

/** The loop for `id`, created as an untitled subagent when it is new (a call can arrive before its spawn is seen): its label is an activity placeholder, never the id. */
export function loopFor(m: PulseModel, id: string, t: number): PulseLoop {
  const held = m.loops.get(id)
  if (held !== undefined) return held
  if (m.loops.size >= PULSE_CAPS.LOOPS) evictOneFinished(m)
  const loop = blankLoop(id, placeholderFor(), 'subagent', t, 'running')
  loop.isUntitled = true
  loop.parent = MAIN_LOOP
  m.loops.set(id, loop)
  m.spawned++
  return loop
}

function evictOneFinished(m: PulseModel): void {
  let oldest: PulseLoop | undefined
  for (const loop of m.loops.values())
    if (loop.status === 'done' && loop.id !== MAIN_LOOP && (oldest === undefined || loop.lastAt < oldest.lastAt)) oldest = loop
  if (oldest !== undefined) m.loops.delete(oldest.id)
}

export function hasLoop(m: PulseModel, id: string): boolean {
  return m.loops.has(id)
}

function pushEvent(m: PulseModel, ev: PulseEvent): void {
  m.ring.push(ev)
  if (m.ring.length > PULSE_CAPS.RING_EVENTS) m.ring.splice(0, m.ring.length - PULSE_CAPS.RING_EVENTS)
}

/** A tool call starts in `loop`. Returns the event so `endCall` can mark it failed. */
export function beginCall(m: PulseModel, t: number, id: string, tool: string, target: string, zone = ''): PulseEvent {
  const loop = loopFor(m, id, t)
  const ev: PulseEvent = { t, loop: id, tool, target }
  const kind = kindOf({ tool, target, zone })
  if (kind !== undefined) {
    ev.kind = kind
    if (loop.isUntitled === true) loop.label = placeholderFor(kind)
    addSpan((loop.spans ??= []), kind, t)
  }
  pushEvent(m, ev)
  tallyBegin(loop, ev)
  loop.status = 'running'
  loop.lastTool = tool
  loop.lastTarget = target
  loop.lastAt = t
  loop.calls++
  loop.busy++
  const key = Object.hasOwn(loop.counts, tool) || Object.keys(loop.counts).length < PULSE_CAPS.TOOLS_PER_LOOP ? tool : OTHER_TOOLS
  loop.counts[key] = (loop.counts[key] ?? 0) + 1
  if (target !== '' && isFileTouch(tool)) touchFile(m, loop, target)
  m.calls++
  m.isDirty = true
  return ev
}

function touchFile(m: PulseModel, loop: PulseLoop, name: string): void {
  loop.files = [name, ...loop.files.filter(f => f !== name)].slice(0, PULSE_CAPS.RECENT_FILES)
  m.files.delete(name)
  m.files.add(name)
  if (m.files.size > PULSE_CAPS.DISTINCT_FILES) m.files.delete(m.files.values().next().value as string)
}

/** The call finished (`isFailed`: it errored or was denied). */
export function endCall(m: PulseModel, t: number, id: string, ev: PulseEvent | undefined, isFailed: boolean): void {
  const loop = m.loops.get(id)
  if (loop !== undefined) {
    loop.busy = Math.max(0, loop.busy - 1)
    loop.lastAt = t
    if (ev !== undefined) tallyEnd(loop, ev, t - ev.t, isFailed)
  }
  if (ev !== undefined && isFailed) ev.err = true
  if (loop?.spans !== undefined && ev?.kind !== undefined) extendSpan(loop.spans, ev.kind, t)
  m.isDirty = true
}

/** A subagent (or teammate) started: its label is the spawn's short description, its intent the extract of its prompt (never the prompt). */
export function spawnLoop(
  m: PulseModel,
  t: number,
  spawn: { id: string; label: string; name?: string; type?: string; intent?: string; parent?: string; isTeammate?: boolean },
): void {
  const id = spawn.id.slice(0, PULSE_CAPS.ID_CHARS)
  const loop = loopFor(m, id, t)
  const label = cutText(spawn.label, PULSE_CAPS.LABEL_CHARS)
  if (label !== '') {
    loop.label = label
    delete loop.isUntitled
  }
  if (spawn.name !== undefined && spawn.name !== '') loop.name = cutText(spawn.name, PULSE_CAPS.NAME_CHARS)
  if (spawn.type !== undefined && spawn.type !== '') loop.type = cutText(spawn.type, PULSE_CAPS.NAME_CHARS)
  if (spawn.intent !== undefined && spawn.intent !== '') loop.intent = cutText(spawn.intent, INTENT_CHARS)
  if (spawn.parent !== undefined) loop.parent = spawn.parent
  if (spawn.isTeammate === true) loop.kind = 'teammate'
  loop.status = 'running'
  loop.startedAt = t
  loop.lastAt = t
  pushEvent(m, { t, loop: spawn.parent ?? MAIN_LOOP, tool: SPAWN_TOOL, target: id, kind: 'delegating' })
  m.isDirty = true
}

/** The agent list as `$.agent.list()` gives it, reduced to what the pulse keeps. */
export type AgentRow = { id: string; description: string; name?: string; type: string; status: string; parentId?: string; teammateId?: string }

const FINISHED = ['completed', 'failed', 'killed']
const statusOf = (s: string): LoopStatus => (FINISHED.includes(s) ? 'done' : s === 'idle' ? 'idle' : 'running')

/** Bring labels and statuses of the known agents in line with the engine's list. Unknown ids are added. */
export function syncAgents(m: PulseModel, t: number, rows: readonly AgentRow[]): void {
  for (const row of rows) {
    const loop = loopFor(m, row.id.slice(0, PULSE_CAPS.ID_CHARS), t)
    // an untitled loop with no description keeps its placeholder (a bare type like `general-purpose` is no title)
    const isBare = row.description === '' && (row.name === undefined || row.name === '') && loop.isUntitled === true
    const label = isBare ? '' : cutText(row.description !== '' ? row.description : (row.name ?? row.type), PULSE_CAPS.LABEL_CHARS)
    if (label !== '') {
      loop.label = label
      delete loop.isUntitled
    }
    if (row.name !== undefined && row.name !== '') loop.name = cutText(row.name, PULSE_CAPS.NAME_CHARS)
    if (row.type !== '') loop.type = cutText(row.type, PULSE_CAPS.NAME_CHARS)
    if (row.parentId !== undefined) loop.parent = row.parentId
    if (row.teammateId !== undefined) loop.kind = 'teammate'
    loop.status = statusOf(row.status)
  }
  m.isDirty = true
}

/** A model turn started in `loop` (`main` or an agent). Its text is never read. */
export function turnStart(m: PulseModel, t: number, id: string): void {
  if (id === MAIN_LOOP) m.turn = { state: 'running', startedAt: t }
  const loop = loopFor(m, id, t)
  loop.status = 'running'
  loop.lastAt = t
  m.isDirty = true
}

/** A model turn ended: the main loop goes idle; an agent is done (a teammate waits for its next message). */
export function turnEnd(m: PulseModel, t: number, id: string): void {
  if (id === MAIN_LOOP) m.turn = { state: 'idle', startedAt: m.turn.startedAt }
  const loop = loopFor(m, id, t)
  loop.status = id === MAIN_LOOP || loop.kind === 'teammate' ? 'idle' : 'done'
  loop.busy = 0
  loop.lastAt = t
  m.isDirty = true
}

/** The four counts of one model request, as `turn.step` reports them (the `ModelUsage` shape). */
export type StepUsage = { input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number }

/**
 * What one request counts as tokens: what was sent fresh (input, written to the cache) plus what was generated. The cache
 * READS are left out: each step re-reads the whole conversation from the cache, so summing them would count the same
 * context again and again and make a long agent look like it wrote a book.
 */
export const tokensOf = (u: StepUsage): number => num(u.input_tokens) + num(u.output_tokens) + num(u.cache_creation_input_tokens)

/** A model request of `id` finished: its tokens join the loop's total. A request with none counted adds nothing (and leaves the total unknown). */
export function addTokens(m: PulseModel, t: number, id: string, usage: StepUsage | null | undefined): void {
  if (usage === null || usage === undefined) return
  const n = tokensOf(usage)
  if (n <= 0) return
  const loop = loopFor(m, id, t)
  loop.tokens = (loop.tokens ?? 0) + n
  m.isDirty = true
}

/** A lane call is agent activity too: it shows as a call of the posting loop. */
export function laneActivity(m: PulseModel, t: number, id: string, laneId: string): void {
  const ev = beginCall(m, t, id, 'lane', laneId)
  endCall(m, t, id, ev, false)
}

export type Snapshot = {
  v: typeof SNAPSHOT_VERSION
  now: number
  session: { turn: TurnState; startedAt: number; turnStartedAt: number }
  totals: { calls: number; files: number; agents: number; active: number }
  loops: PulseLoop[]
  lanes: (Lane & { loop: string | null })[]
  events: PulseEvent[]
}

/** The JSON file's content: everything the scene draws. Clears the dirty flag. */
export function snapshot(m: PulseModel, now: number): Snapshot {
  const loops = [...m.loops.values()]
  loops.sort((a, b) => (a.id === MAIN_LOOP ? -1 : b.id === MAIN_LOOP ? 1 : a.startedAt - b.startedAt))
  m.isDirty = false
  return {
    v: SNAPSHOT_VERSION,
    now,
    session: { turn: m.turn.state, startedAt: m.startedAt, turnStartedAt: m.turn.startedAt },
    totals: {
      calls: m.calls,
      files: m.files.size,
      agents: m.spawned,
      active: loops.filter(l => l.status === 'running').length,
    },
    loops,
    lanes: m.lanes.map(lane => ({ ...lane, loop: matchLane(lane, loops, MAIN_LOOP) })),
    events: m.ring.slice(-PULSE_CAPS.OUT_EVENTS),
  }
}

const DOD_STATES: readonly unknown[] = ['todo', 'doing', 'done', 'failed']
/** The checklist of a stored lane: only well-formed items, capped. */
function restoreDod(v: unknown): DodItem[] {
  if (!Array.isArray(v)) return []
  const items: DodItem[] = []
  for (const raw of v.slice(0, LANE_CAPS.DOD_ITEMS))
    if (isPlain(raw) && DOD_STATES.includes(raw.state) && text(raw.t, LANE_CAPS.DOD_TEXT_CHARS) !== '')
      items.push({ t: text(raw.t, LANE_CAPS.DOD_TEXT_CHARS), state: raw.state as DodItem['state'] })
  return items
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const text = (v: unknown, max: number): string => (typeof v === 'string' ? cutText(v, max) : '')

/** Lanes read back from stored JSON (a snapshot file or the kept state); every field re-validated, junk dropped. */
export function restoreLanes(json: unknown): Lane[] {
  const out: Lane[] = []
  if (Array.isArray(json))
    for (const raw of json.slice(0, LANE_CAPS.LANES)) {
      if (!isPlain(raw) || typeof raw.id !== 'string' || !LANE_CAPS.ID_PATTERN.test(raw.id)) continue
      const state = (LANE_STATES as readonly unknown[]).includes(raw.state) ? (raw.state as LaneState) : 'working'
      out.push({
        id: raw.id,
        label: text(raw.label, LANE_CAPS.LABEL_CHARS) || raw.id,
        state,
        pct: typeof raw.pct === 'number' && Number.isFinite(raw.pct) ? Math.min(LANE_CAPS.PCT_MAX, Math.max(LANE_CAPS.PCT_MIN, Math.round(raw.pct))) : null,
        step: text(raw.step, LANE_CAPS.STEP_CHARS),
        note: text(raw.note, LANE_CAPS.NOTE_CHARS),
        goal: text(raw.goal, LANE_CAPS.GOAL_CHARS),
        dod: restoreDod(raw.dod),
        at: Number.isInteger(raw.at) && (raw.at as number) >= 0 ? (raw.at as number) : null,
        startedAt: num(raw.startedAt),
        updatedAt: num(raw.updatedAt),
        by: typeof raw.by === 'string' ? raw.by.slice(0, PULSE_CAPS.ID_CHARS) : MAIN_LOOP,
        ...(typeof raw.session === 'string' && LANE_CAPS.SESSION_PATTERN.test(raw.session) ? { session: raw.session } : {}),
      })
    }
  return out
}

/** The fields of an ingested run (harness, model, effort, run id, outcome, cursor), re-validated. */
function restoreExternal(loop: PulseLoop, raw: Record<string, unknown>): void {
  for (const key of ['harness', 'model', 'effort', 'runId'] as const) if (typeof raw[key] === 'string' && raw[key] !== '') loop[key] = text(raw[key], PULSE_CAPS.ID_CHARS)
  if (raw.source === 'external') loop.source = 'external'
  if (raw.confidence === 'exact' || raw.confidence === 'guessed') loop.confidence = raw.confidence
  if (isOutcome(raw.outcome)) loop.outcome = raw.outcome
  if (typeof raw.why === 'string' && raw.why !== '') loop.why = text(raw.why, PULSE_CAPS.WHY_CHARS)
  if (isPlain(raw.ingested)) loop.ingested = { calls: num(raw.ingested.calls), steps: num(raw.ingested.steps) }
}

/**
 * Read a previous snapshot back (a reload of the mod loses module memory; the file survives). Everything is
 * re-validated: the file is data, not code. Returns false when there is nothing usable.
 */
export function restore(m: PulseModel, json: unknown): boolean {
  if (!isPlain(json) || json.v !== SNAPSHOT_VERSION || !Array.isArray(json.loops)) return false
  const session = isPlain(json.session) ? json.session : {}
  m.startedAt = num(session.startedAt) || m.startedAt
  m.turn = { state: session.turn === 'running' ? 'running' : 'idle', startedAt: num(session.turnStartedAt) }
  for (const raw of json.loops.slice(0, PULSE_CAPS.LOOPS)) {
    if (!isPlain(raw) || typeof raw.id !== 'string' || raw.id === '') continue
    const id = raw.id.slice(0, PULSE_CAPS.ID_CHARS)
    const kind: LoopKind = id === MAIN_LOOP ? 'main' : raw.kind === 'teammate' ? 'teammate' : 'subagent'
    const loop = blankLoop(id, text(raw.label, PULSE_CAPS.LABEL_CHARS) || id, kind, num(raw.startedAt), 'idle')
    loop.status = raw.status === 'running' || raw.status === 'done' ? raw.status : 'idle'
    if (kind !== 'main' && (isPlaceholder(loop.label) || HASH_LABEL.test(loop.label) || loop.label === id)) {
      loop.label = placeholderFor() // a snapshot from before titles: `agent e99c` or the bare id
      loop.isUntitled = true
    }
    if (typeof raw.name === 'string') loop.name = text(raw.name, PULSE_CAPS.NAME_CHARS)
    if (typeof raw.type === 'string' && raw.type !== '') loop.type = text(raw.type, PULSE_CAPS.NAME_CHARS)
    if (typeof raw.parent === 'string') loop.parent = raw.parent.slice(0, PULSE_CAPS.ID_CHARS)
    loop.lastTool = text(raw.lastTool, PULSE_CAPS.NAME_CHARS)
    loop.lastTarget = text(raw.lastTarget, PULSE_CAPS.NAME_CHARS)
    loop.calls = num(raw.calls)
    loop.lastAt = num(raw.lastAt)
    if (num(raw.tokens) > 0) loop.tokens = num(raw.tokens)
    const spans = restoreSpans(raw.spans)
    if (spans.length > 0) loop.spans = spans
    const tally = restoreTally(raw.tally)
    if (Object.keys(tally).length > 0) loop.tally = tally
    if (typeof raw.intent === 'string' && raw.intent !== '') loop.intent = text(raw.intent, INTENT_CHARS)
    if (isPlain(raw.proof) && (raw.proof.result === 'pass' || raw.proof.result === 'fail' || raw.proof.result === 'none'))
      loop.proof = { eval: text(raw.proof.eval, PULSE_CAPS.PROOF_EVAL_CHARS), what: text(raw.proof.what, PULSE_CAPS.PROOF_WHAT_CHARS), result: raw.proof.result }
    restoreExternal(loop, raw)
    if (isPlain(raw.counts))
      for (const [tool, n] of Object.entries(raw.counts).slice(0, PULSE_CAPS.TOOLS_PER_LOOP + 1)) loop.counts[tool.slice(0, PULSE_CAPS.NAME_CHARS)] = num(n)
    if (Array.isArray(raw.files))
      loop.files = raw.files.filter((f): f is string => typeof f === 'string').map(f => text(f, PULSE_CAPS.NAME_CHARS)).slice(0, PULSE_CAPS.RECENT_FILES)
    for (const f of loop.files) m.files.add(f)
    m.loops.set(id, loop)
  }
  if (Array.isArray(json.events))
    for (const raw of json.events.slice(-PULSE_CAPS.OUT_EVENTS)) {
      if (!isPlain(raw) || typeof raw.loop !== 'string') continue
      const ev: PulseEvent = { t: num(raw.t), loop: raw.loop, tool: text(raw.tool, PULSE_CAPS.NAME_CHARS), target: text(raw.target, PULSE_CAPS.NAME_CHARS) }
      if (isWorkKind(raw.kind)) ev.kind = raw.kind
      if (raw.err === true) ev.err = true
      m.ring.push(ev)
    }
  m.lanes.push(...restoreLanes(json.lanes))
  if (isPlain(json.totals)) {
    m.calls = num(json.totals.calls)
    m.spawned = num(json.totals.agents)
  }
  m.isDirty = true
  return true
}
