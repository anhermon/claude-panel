// The ambient Pulse, wired: hooks that watch every tool call, spawn and turn (pass-through, never throwing, never
// waiting for the recording), the in-memory model, the throttled file of the feed (live/pulse.json), the `lane` part of
// the `panel` tool and `/panel pulse`. The Pulse is a FRAME of the board now (./board-host.ts reads `pulseBoardParts`
// and is told about every change through `setPulseListener`); there is no scene of its own. register.tsx owns the atoms
// (the engine's scan follows an atom only in the module that reads it) and the state writes, so this file never touches
// the state: it answers with data (`PulseAction`) and register.tsx applies it. `$` only ever goes to function
// declarations (the plugin checks follow it nowhere else). Module state lives in `pulse` below; a reload of the mod
// starts a new one and reads the last snapshot back from disk.
import type { EngineInterface, On } from 'claude-code'

import type { BoardLane } from '../types'
import type { PulseLoop } from './pulse-model'

import { MAIN_LOOP, addTokens, beginCall, endCall, hasLoop, laneActivity, newModel, restore, restoreLanes, setLoopMeta, setLoopProof, setLoopTitle, snapshot, spawnLoop, syncAgents, turnEnd, turnStart } from './pulse-model'
import type { AgentRow, PulseEvent, PulseModel } from './pulse-model'
import { applyLanePlan, hasLanePart } from './pulse-lanes'
import type { Lane, LanePlan } from './pulse-lanes'
import { intentOf, targetOf, zoneOf } from './pulse-redact'
import { createFlusher } from './pulse-flush'
import { resolveBriefTitle } from './agent-names'
import { readMainSessionMeta, resetMainMeta } from './agent-detail-host'
import { resolveMeta } from './agent-meta'
import { resolveProof } from './agent-proof'
import { startRunsPoll, stopRunsPoll } from './pulse-runs-host'
import type { Flusher } from './pulse-flush'
import { pulseDirOf, readSnapshot, writeSnapshot } from './pulse-io'
import { BOARD_SCENE_ID } from './board-scene'
import { sceneUrl } from './scene'
import { PLUGIN_NAME, SCENE_FULL_NAME, TOOL_FULL_NAME } from './spec'

type Dollar = EngineInterface

/** What register.tsx tells the pulse at start: where the temp folder is, and what `/panel pulse on|off` said (true: off; undefined: never said, the env default decides). */
export type PulseInit = { tmp: string; isOff: boolean | undefined }
/** What a `/panel pulse` command asks register.tsx to do besides answering. */
export type PulseAction = {
  text: string
  /** Remember for the session (true: off). */
  saveOff?: boolean
}

// The env var is spelled out where it is read: `$.env.get` takes a literal name (the engine lists what a module reads).
export const PULSE_ENV_NAME = 'PANEL_PULSE'
const OFF_WORDS = ['off', '0', 'false', 'no']
export const PULSE_ARG = 'pulse'
export const PULSE_USAGE = 'usage: /panel pulse on|off|status'
export type PulseVerb = 'on' | 'off' | 'status'
/** A fresh `$.agent.list()` is read when a loop we never saw calls a tool, and while agents run at most this often. */
const SYNC_MIN_MS = 4000
const PULSE_OFF_NOTE = 'pulse is off: /panel pulse on shows what each agent is doing'
const SELF_TOOLS: readonly string[] = [TOOL_FULL_NAME, SCENE_FULL_NAME]

type Pulse = {
  model: PulseModel
  flusher: Flusher | null
  dir: string
  isOn: boolean
  lastSyncAt: number
  isSyncing: boolean
}
let pulse: Pulse | null = null

/** Who wants to know when the model changes or is flushed (the board): set once by ./board-host.ts. */
export type PulseListener = { touch: () => void; flushNow: () => Promise<void> }
let listener: PulseListener | null = null
export function setPulseListener(next: PulseListener | null): void {
  listener = next
}

/** The feed's snapshot for the board (undefined while the feed is off) and the agent lanes (kept even while it is off). */
export function pulseBoardParts(now: number): { pulse: unknown; lanes: BoardLane[]; loops: PulseLoop[]; events: PulseEvent[] } {
  const p = pulse
  if (p === null) return { pulse: undefined, lanes: [], loops: [], events: [] }
  const snap = snapshot(p.model, now)
  return { pulse: p.isOn ? snap : undefined, lanes: snap.lanes, loops: p.isOn ? snap.loops : [], events: p.isOn ? [...p.model.ring] : [] }
}

type Begun = { t: number; ev: PulseEvent }
type Trace = { p: Pulse; loop: string; begun: Promise<Begun | undefined> }

const loopOf = (agentId: unknown): string => (typeof agentId === 'string' && agentId !== '' ? agentId : MAIN_LOOP)

/** `$.agent.list()` into the model; never throws, at most one at a time. */
async function syncList($: Dollar, p: Pulse): Promise<void> {
  if (p.isSyncing) return
  p.isSyncing = true
  try {
    const rows: AgentRow[] = (await $.agent.list()).map(a => ({
      id: a.id,
      description: a.description,
      type: a.type,
      status: a.status,
      ...(a.name === undefined ? {} : { name: a.name }),
      ...(a.parentId === undefined ? {} : { parentId: a.parentId }),
      ...(a.teammateId === undefined ? {} : { teammateId: a.teammateId }),
    }))
    const t = await $.clock.now()
    p.lastSyncAt = t
    syncAgents(p.model, t, rows)
    p.flusher?.touch()
    for (const l of p.model.loops.values()) if (l.id !== MAIN_LOOP && l.status === 'done' && l.proof === undefined) void proofFromTranscript($, p, l.id, t)
    for (const l of p.model.loops.values()) if (l.id !== MAIN_LOOP && l.source !== 'external' && (l.model === undefined || l.effort === undefined)) void metaFromTranscript($, p, l.id, t)
    void mainFromTranscript($, p, t)
  } catch {
    // no list (an old engine, a test): the labels stay what the spawn said
  } finally {
    p.isSyncing = false
  }
}

/** The main session's model, git branch and AI title come from the tail of the main transcript (cached in agent-detail-host.ts; never throws). */
async function mainFromTranscript($: Dollar, p: Pulse, t: number): Promise<void> {
  try {
    const meta = await readMainSessionMeta($, t)
    if (meta !== undefined && setLoopMeta(p.model, MAIN_LOOP, meta)) p.flusher?.touch()
  } catch {
    // no main transcript read: the row stays as before
  }
}

/** The model and effort an agent was started with come from its meta file (bounded, once per agent; never throws, never awaited by the sync). */
async function metaFromTranscript($: Dollar, p: Pulse, loop: string, t: number): Promise<void> {
  try {
    const meta = await resolveMeta($, loop, t)
    if (meta !== undefined && setLoopMeta(p.model, loop, meta)) p.flusher?.touch()
  } catch {
    // no model:effort shown: the row says nothing about it
  }
}

/** A finished agent whose brief was a ticket gets its proof (eval line + reported result) from its own transcript (bounded, once per agent; never throws, never awaited by the sync). */
async function proofFromTranscript($: Dollar, p: Pulse, loop: string, t: number): Promise<void> {
  try {
    const proof = await resolveProof($, loop, t)
    if (proof !== undefined && proof !== null && setLoopProof(p.model, loop, proof)) p.flusher?.touch()
  } catch {
    // no proof shown: the row stays unflagged
  }
}

/** A loop seen without a spawn gets its title from its own transcript head (bounded, once per agent; never throws, never awaited by the tick). */
async function titleFromTranscript($: Dollar, p: Pulse, loop: string, t: number): Promise<void> {
  try {
    const title = await resolveBriefTitle($, loop, t)
    if (title !== undefined && setLoopTitle(p.model, loop, title)) p.flusher?.touch()
  } catch {
    // the placeholder stays
  }
}

/** Record that `loop` started `tool`. Synchronous up to the first await, which is the clock: nothing waits for it. */
function beginTrace($: Dollar, e: Readonly<Record<string, unknown>>, name?: string): Trace | undefined {
  const p = pulse
  if (p === null || !p.isOn) return undefined
  try {
    const tool = name ?? (typeof e.tool === 'string' ? e.tool : '')
    if (tool === '' || (name === undefined && SELF_TOOLS.includes(tool))) return undefined
    const loop = loopOf(e.agentId)
    const target = name === undefined ? targetOf(tool, e) : ''
    const zone = name === undefined ? zoneOf(tool, e) : ''
    const isNew = loop !== MAIN_LOOP && !hasLoop(p.model, loop)
    const begun = (async (): Promise<Begun | undefined> => {
      try {
        const t = await $.clock.now()
        const ev = beginCall(p.model, t, loop, tool, target, zone)
        p.flusher?.touch()
        if (isNew || (loop !== MAIN_LOOP && t - p.lastSyncAt > SYNC_MIN_MS)) void syncList($, p)
        if (p.model.loops.get(loop)?.isUntitled === true) void titleFromTranscript($, p, loop, t)
        return { t, ev }
      } catch {
        return undefined
      }
    })()
    return { p, loop, begun }
  } catch {
    return undefined
  }
}

async function finishTrace($: Dollar, trace: Trace | undefined, isFailed: boolean): Promise<void> {
  if (trace === undefined) return
  try {
    const begun = await trace.begun
    if (begun === undefined) return
    endCall(trace.p.model, await $.clock.now(), trace.loop, begun.ev, isFailed)
    trace.p.flusher?.touch()
  } catch {
    // recording is best effort
  }
}

/** The `panel` / `scene` tools answer for themselves (they never reach `next`), so their own handlers call this. */
export function pulseSelfCall($: Dollar, agentId: unknown, tool: string): void {
  void finishTrace($, beginTrace($, { agentId }, tool), false)
}

async function noteSpawn($: Dollar, e: Readonly<Record<string, unknown>>, agentId: string): Promise<void> {
  const p = pulse
  if (p === null || !p.isOn) return
  const t = await $.clock.now()
  const description = typeof e.description === 'string' ? e.description : ''
  const type = typeof e.subagentType === 'string' ? e.subagentType : ''
  spawnLoop(p.model, t, {
    id: agentId,
    label: description !== '' ? description : type,
    ...(typeof e.name === 'string' ? { name: e.name } : {}),
    type,
    intent: intentOf(e.prompt),
    parent: loopOf(e.parentAgentId),
    isTeammate: e.isTeammate === true,
  })
  p.flusher?.touch()
  void syncList($, p)
}

function log($: Dollar, text: string): void {
  $.ui.log(`${PLUGIN_NAME}: ${text}`, { to: 'debug' })
}

/** Run a recorder that must never fail the hook it rides on. */
function safely(run: () => Promise<void>): void {
  void run().catch(() => undefined)
}

export function registerPulse(on: On): void {
  // Pass-through: `next` is called at once, the recording happens beside it and after it.
  on('tool.call', async ($, e, next) => {
    const trace = beginTrace($, e as unknown as Record<string, unknown>)
    let ran: Awaited<ReturnType<typeof next>> | undefined
    try {
      ran = await next(e)
      return ran
    } finally {
      void finishTrace($, trace, ran === undefined || ran.deny !== undefined || ran.isError === true)
    }
  })
  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (started.deny === undefined && started.agentId !== undefined)
      safely(() => noteSpawn($, e as unknown as Record<string, unknown>, started.agentId as string))
    return started
  })
  // The tokens of every model request, per loop: the request's usage as the engine reports it (a number only, never a word).
  // A pass-through stream: the response is yielded untouched and the count is taken once it is whole.
  on('turn.step', async function* ($, e, next) {
    const response = yield* next(e)
    safely(async () => {
      if (pulse === null || !pulse.isOn) return
      addTokens(pulse.model, await $.clock.now(), loopOf(e.agentId), response.usage)
      pulse.flusher?.touch()
    })
    return response
  })
  on('turn.start', async ($, e, next) => {
    const started = await next(e)
    safely(async () => {
      if (pulse === null || !pulse.isOn) return
      turnStart(pulse.model, await $.clock.now(), loopOf(e.agentId))
      pulse.flusher?.touch()
    })
    return started
  })
  on('turn.complete', async ($, e, next) => {
    const ended = await next(e)
    safely(async () => {
      if (pulse === null || !pulse.isOn) return
      turnEnd(pulse.model, await $.clock.now(), loopOf(e.agentId))
      pulse.flusher?.touch()
      // The mod may reload right after the main turn (a save made during it): leave the file current.
      if (e.agentId === undefined) {
        await pulse.flusher?.flushNow()
        await listener?.flushNow()
      }
    })
    return ended
  })
}

// ---- the lane part of the `panel` tool -------------------------------------------------------------------

export type LaneOutcome = { lines: string[]; deny?: undefined } | { deny: string; lines?: undefined }

/** The lanes as they stand now (kept in the session state across a mod reload). */
export const pulseLanes = (): readonly Lane[] => pulse?.model.lanes ?? []

/** Put kept lanes back after a reload, only when this instance has none yet (a newer post wins). */
export async function pulseAdoptLanes($: Dollar, kept: unknown): Promise<void> {
  const lanes = restoreLanes(kept)
  if (lanes.length === 0) return
  const p = await ensurePulse($)
  if (p.model.lanes.length > 0) return
  p.model.lanes = lanes
  p.model.isDirty = true
  listener?.touch()
}

/** Apply a validated lane plan on behalf of loop `agentId`; the lane call also counts as that loop's activity. */
export async function applyLanes($: Dollar, plan: LanePlan, agentId: unknown): Promise<LaneOutcome> {
  if (!hasLanePart(plan)) return { lines: [] }
  const p = await ensurePulse($)
  const t = await $.clock.now()
  const by = loopOf(agentId)
  const applied = applyLanePlan(p.model.lanes, plan, t, by)
  if (!applied.isOk) return { deny: applied.error }
  p.model.lanes = applied.lanes
  if (p.isOn) {
    laneActivity(p.model, t, by, plan.upsert?.id ?? plan.remove ?? '')
    p.flusher?.touch()
  }
  listener?.touch()
  const note = p.isOn ? [] : [PULSE_OFF_NOTE]
  return { lines: [...applied.lines, ...note, ...(plan.trimmed.length > 0 ? [`trimmed: ${plan.trimmed.join('; ')}`] : [])] }
}

// ---- start, scene, command ---------------------------------------------------------------------------------

/** The pulse, or an inert one (lanes only) when the session never started it. */
async function ensurePulse($: Dollar): Promise<Pulse> {
  if (pulse === null) pulse = { model: newModel(await $.clock.now()), flusher: null, dir: '', isOn: false, lastSyncAt: 0, isSyncing: false }
  return pulse
}

async function wantsOn($: Dollar, isOff: boolean | undefined): Promise<boolean> {
  if (isOff !== undefined) return !isOff
  return !OFF_WORDS.includes(((await $.env.get('PANEL_PULSE')) ?? '').trim().toLowerCase())
}

/** Make the pulse live: its files, the last snapshot, the writer. Idempotent. */
async function activate($: Dollar, p: Pulse): Promise<void> {
  if (p.flusher !== null) return
  p.isOn = true
  const previous = await readSnapshot($, p.dir)
  if (previous !== undefined && p.model.calls === 0) restore(p.model, previous)
  const inner = createFlusher({
    after: (ms, fn) => $.clock.after(ms, fn),
    onError: err => log($, `pulse: could not write the snapshot: ${String(err)}`),
    run: async () => {
      let now = await $.clock.now()
      if (hasRunningAgents(p) && now - p.lastSyncAt > SYNC_MIN_MS) {
        await syncList($, p)
        now = await $.clock.now()
      }
      await writeSnapshot($, p.dir, JSON.stringify(snapshot(p.model, now)) + '\n')
    },
  })
  // Every change of the feed is a change of the board's pulse frame too.
  p.flusher = { ...inner, touch: () => (inner.touch(), listener?.touch()) }
  p.flusher.touch()
  startRunsPoll($, { model: () => (pulse?.isOn === true ? pulse.model : null), touch: () => pulse?.flusher?.touch() })
}

/** Agents said to run get their statuses refreshed from the engine's list now and then. */
const hasRunningAgents = (p: Pulse): boolean => [...p.model.loops.values()].some(l => l.id !== MAIN_LOOP && l.status === 'running')

/** Session start (and every reload): build the model, and when the pulse is on, its files and writer. */
export async function pulseStart($: Dollar, init: PulseInit): Promise<void> {
  try {
    resetMainMeta()
    const now = await $.clock.now()
    const dir = pulseDirOf(init.tmp, await $.session.id())
    pulse = { model: newModel(now), flusher: null, dir, isOn: await wantsOn($, init.isOff), lastSyncAt: 0, isSyncing: false }
    if (pulse.isOn) await activate($, pulse)
  } catch (err) {
    log($, `pulse: did not start: ${String(err)}`)
  }
}

/** `/panel pulse [on|off|status]`: the verb, a usage line for another word; undefined when the args are not about pulse. */
export function parsePulseArgs(args: string): { verb: PulseVerb } | { usage: string } | undefined {
  const [first, word] = args.trim().split(/\s+/)
  if (first !== PULSE_ARG) return undefined
  if (word === undefined || word === 'status') return { verb: 'status' }
  return word === 'on' || word === 'off' ? { verb: word } : { usage: PULSE_USAGE }
}

export function pulseStatusText(p: Pulse | null, url: string | null): string {
  if (p === null || !p.isOn) return "pulse: off (/panel pulse on shows the agents' activity)"
  const m = p.model
  const link = url === null ? 'no browser view yet' : sceneUrl(url, BOARD_SCENE_ID)
  return `pulse: on · ${m.calls} calls · ${m.loops.size} loops · ${m.lanes.length} lanes · ${link}`
}

export async function pulseCommand(
  $: Dollar,
  parsed: { verb: PulseVerb } | { usage: string },
  init: PulseInit,
  url: string | null,
): Promise<PulseAction> {
  if ('usage' in parsed) return { text: parsed.usage }
  if (pulse === null) await pulseStart($, init)
  const p = pulse
  if (p === null) return { text: pulseStatusText(null, url) }
  if (parsed.verb === 'on') {
    await activate($, p)
    listener?.touch()
    return { text: pulseStatusText(p, url), saveOff: false }
  }
  if (parsed.verb === 'off') {
    p.isOn = false
    stopRunsPoll()
    p.flusher?.dispose()
    p.flusher = null
    listener?.touch()
    return { text: pulseStatusText(p, url), saveOff: true }
  }
  return { text: pulseStatusText(p, url) }
}
