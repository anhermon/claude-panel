// The `$` half of the agent drill-down: the page asks for one agent's detail by clicking its row (`panel.emit('agent', {id, pages})`,
// repeated every few seconds while the detail is open; `agent-close` ends it); the web server appends the click to the events
// file; this loop reads that file (only when its size changed), and while a request is fresh it reads the END of the agent's
// transcript, builds the detail (./agent-detail.ts, redacted) and writes it to the scene's live/detail.json. The page reads
// that file itself. Nothing is read or written for an agent nobody asked about, so live/data.json stays small. The loop dies
// by itself when this module instance is no longer the current one (`isCurrent`, a mod reload starts a new instance).
import type { EngineInterface } from 'claude-code'

import { AGENT_CLOSE_EVENT, AGENT_EVENT, AGENTS_INFO_SCENE_ID } from './agents-info-scene'
import type { AgentRow } from './agents-info-data'
import { buildDetail, DETAIL_CAPS } from './agent-detail'
import { externalDetail } from './agent-detail-external-io'
import { loadRunDetail } from './agent-detail-run'
import type { TranscriptRead } from './agent-detail'
import { writeLive } from './board-io'
import { readEvents } from './events'
import { readEventsText } from './events-io'
import type { PulseEvent, PulseLoop } from './pulse-model'
import type { BoardLane } from '../types'
import { briefFullOf, briefOf, parseTranscript } from './transcript-parse'

type Dollar = EngineInterface

export const DETAIL_FILE_NAME = 'detail.json'
/** What detail.json holds while nobody asked: a valid file (so the page's first read is not a 404) that is no agent's detail. */
export const DETAIL_STUB = '{"v":1}\n'
const DETAIL_TEMP_NAME = `.${DETAIL_FILE_NAME}.tmp`

export const DETAIL_HOST = {
  /** The events file is looked at this often while a detail is open / otherwise. */
  POLL_OPEN_MS: 1000,
  POLL_IDLE_MS: 1500,
  /** A request counts for this long; the page repeats it more often (HEARTBEAT_MS in the page). */
  WANT_TTL_MS: 45_000,
  /** An open detail is rewritten at least this often even when the transcript did not grow (the clock-like numbers move). */
  REFRESH_MS: 5000,
  /** The bytes read from the END of a transcript for page 1; page N reads N times this, up to MAX_BYTES. */
  BASE_BYTES: 524_288,
  MAX_BYTES: 4_194_304,
  RUN_TIMEOUT_MS: 10_000,
  /** A transcript file that was not found is looked for again after this long (the `find` walks every project folder). */
  LOCATE_RETRY_MS: 10_000,
} as const

/** Why there is no transcript: one sentence each, shown as is by the page. */
export const DETAIL_REASON = {
  NOT_FOUND: 'Claude Code kept no transcript file for this agent, so only what the panel recorded of it is shown.',
  UNREADABLE: 'The transcript file exists but could not be read, so only what the panel recorded of the agent is shown.',
} as const

/** The folder of Claude Code's session files: `<home>/.claude/projects`. */
const PROJECTS_DIR = '.claude/projects'
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/
const FIND_DEPTH_MAIN = '2'
const FIND_DEPTH_AGENT = '4'
const MAIN_LOOP_ID = 'main'

/** What the loop needs from the rest of the mod (agents-info-host.ts fills it). */
export type DetailSource = {
  /** The scene's folder while it is registered, else null. */
  dir: () => string | null
  rows: () => readonly AgentRow[]
  pulse: (now: number) => { loops: readonly PulseLoop[]; events: readonly PulseEvent[]; lanes?: readonly BoardLane[] }
}
export type DetailBind = { eventsFile: string; isCurrent: () => Promise<boolean> }

type Want = { id: string; pages: number; at: number }
type State = { cursor: number; size: number; want: Want | null; paths: Map<string, string>; misses: Map<string, number>; lastSig: string; isBound: boolean }
const state: State = { cursor: 0, size: -1, want: null, paths: new Map(), misses: new Map(), lastSig: '', isBound: false }

/** For tests: forget everything. */
export function resetDetail(): void {
  Object.assign(state, { cursor: 0, size: -1, want: null, paths: new Map(), misses: new Map(), lastSig: '', isBound: false })
}

const clampPages = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(DETAIL_CAPS.MAX_PAGES, Math.max(1, Math.floor(v))) : 1)

/** What the new events of the page ask: the agent and how many pages of the transcript, `null` to close, undefined for nothing new. */
export function wantFrom(events: readonly { scene: string; name: string; data?: unknown }[], now: number): Want | null | undefined {
  let want: Want | null | undefined
  for (const e of events) {
    if (e.scene !== AGENTS_INFO_SCENE_ID) continue
    if (e.name === AGENT_CLOSE_EVENT) want = null
    else if (e.name === AGENT_EVENT) {
      const d = (e.data ?? {}) as { id?: unknown; pages?: unknown }
      if (typeof d.id === 'string' && SAFE_ID.test(d.id)) want = { id: d.id, pages: clampPages(d.pages), at: now }
    }
  }
  return want
}

async function run($: Dollar, argv: readonly string[]): Promise<string | undefined> {
  try {
    const out = await $.process.run(argv, { timeoutMs: DETAIL_HOST.RUN_TIMEOUT_MS })
    return out.exitCode === 0 ? out.stdout : undefined
  } catch {
    return undefined
  }
}

/** The transcript file of a loop (the session's own file for `main`, the sub-agent's file under the session folder), cached. */
async function locate($: Dollar, loopId: string, now: number, laneSession?: string): Promise<string | undefined> {
  // A lane that stands for another session is keyed by that session id, so it never collides with a loop id.
  const key = laneSession === undefined ? loopId : `session:${laneSession}`
  const held = state.paths.get(key)
  if (held !== undefined) return held
  const missedAt = state.misses.get(key)
  if (missedAt !== undefined && now - missedAt < DETAIL_HOST.LOCATE_RETRY_MS) return undefined
  const home = await $.env.get('HOME')
  const session = await $.session.id()
  if (home === undefined || !SAFE_ID.test(session) || !SAFE_ID.test(loopId)) return undefined
  if (laneSession !== undefined && !SAFE_ID.test(laneSession)) return undefined
  const projects = `${home.replace(/\/+$/, '')}/${PROJECTS_DIR}`
  const isMain = loopId === MAIN_LOOP_ID
  const argv = laneSession !== undefined
    ? ['find', projects, '-maxdepth', FIND_DEPTH_MAIN, '-type', 'f', '-name', `${laneSession}.jsonl`]
    : isMain
    ? ['find', projects, '-maxdepth', FIND_DEPTH_MAIN, '-type', 'f', '-name', `${session}.jsonl`]
    : ['find', projects, '-maxdepth', FIND_DEPTH_AGENT, '-type', 'f', '-path', `*/${session}/subagents/agent-${loopId}.jsonl`]
  const found = ((await run($, argv)) ?? '').split('\n').find(l => l !== '')
  if (found !== undefined) state.paths.set(key, found)
  else state.misses.set(key, now)
  return found
}

async function sizeOf($: Dollar, path: string): Promise<number | undefined> {
  try {
    return (await $.fs.stat(path)).size
  } catch {
    return undefined
  }
}

async function readTranscript($: Dollar, path: string, size: number, pages: number, isMain: boolean): Promise<TranscriptRead | undefined> {
  const bytes = Math.min(DETAIL_HOST.BASE_BYTES * pages, DETAIL_HOST.MAX_BYTES)
  const isWhole = size <= bytes
  const text = await run($, ['tail', '-c', String(bytes), path])
  if (text === undefined) return undefined
  const first = isWhole || isMain ? '' : ((await run($, ['head', '-n', '1', path])) ?? '')
  const head = briefOf(first)
  return { parsed: parseTranscript(text, isWhole), head, headFull: briefFullOf(first), isWhole, fileBytes: size, readBytes: Math.min(size, bytes) }
}

async function refresh($: Dollar, source: DetailSource, want: Want, now: number): Promise<void> {
  const dir = source.dir()
  const row = source.rows().find(r => r.id === want.id)
  if (dir === null || row === undefined) return
  const { loops, events, lanes } = source.pulse(now)
  const lane = lanes?.find(l => l.id === row.id)
  const loop = loops.find(l => l.id === row.loop)
  const laneInfo = lane === undefined ? undefined : { step: lane.step, note: lane.note, goal: lane.goal, dod: lane.dod, at: lane.at }
  // A codex run with a record: its rollout is read through the harness adapter (./agent-detail-external.ts); a run that is not one of those continues below.
  const ext = await externalDetail($, {
    subject: { id: row.id, name: row.name, isMain: row.isMain, state: row.state, startedAt: row.startedAt, endedAt: row.endedAt },
    loop, events, lane: laneInfo, pages: want.pages, bytes: Math.min(DETAIL_HOST.BASE_BYTES * want.pages, DETAIL_HOST.MAX_BYTES), now,
    sigBase: `${want.id}|${want.pages}|${row.state}|${Math.floor(now / DETAIL_HOST.REFRESH_MS)}`, lastSig: state.lastSig,
  })
  if (ext !== undefined) {
    if (ext.detail === null) return
    state.lastSig = ext.sig
    // With no rollout the record's own facts (./agent-detail-run.ts) go with it; the sentence on the Transcript tab stays the rollout's.
    const own = ext.detail.external.source === 'record' && loop !== undefined ? await loadRunDetail($, loop) : undefined
    await writeLive($, dir, DETAIL_FILE_NAME, DETAIL_TEMP_NAME, JSON.stringify(own === undefined ? ext.detail : { ...ext.detail, run: own.run }) + '\n')
    return
  }
  const path = await locate($, row.loop, now, lane?.session)
  const size = path === undefined ? undefined : await sizeOf($, path)
  const sig = `${want.id}|${want.pages}|${size ?? ''}|${row.state}|${Math.floor(now / DETAIL_HOST.REFRESH_MS)}`
  if (sig === state.lastSig) return
  const read = path === undefined || size === undefined ? undefined : await readTranscript($, path, size, want.pages, row.isMain || lane?.session !== undefined)
  // A run of another harness (codex) with no transcript read: say what is true for it, from its record, not Claude Code's words.
  const own = read === undefined && loop?.source === 'external' ? await loadRunDetail($, loop) : undefined
  const detail = buildDetail({
    subject: { id: row.id, name: row.name, isMain: row.isMain, state: row.state, startedAt: row.startedAt, endedAt: row.endedAt },
    loop,
    lane: laneInfo,
    events,
    read: read ?? null,
    unavailable: own?.unavailable ?? (path === undefined ? DETAIL_REASON.NOT_FOUND : DETAIL_REASON.UNREADABLE),
    pages: want.pages,
    now,
  })
  state.lastSig = sig
  // Written even when nothing but the clock changed: `updatedAt` is how the page knows the host is still answering.
  await writeLive($, dir, DETAIL_FILE_NAME, DETAIL_TEMP_NAME, JSON.stringify(own === undefined ? detail : { ...detail, run: own.run }) + '\n')
}

/** One look: new requests in the events file, then (while one is fresh) the detail. Never throws. */
export async function detailTick($: Dollar, source: DetailSource, bind: DetailBind): Promise<void> {
  try {
    const now = await $.clock.now()
    const size = await sizeOf($, bind.eventsFile)
    if (size !== undefined && size !== state.size) {
      state.size = size
      const found = readEvents(await readEventsText($, bind.eventsFile), state.cursor)
      state.cursor = found.last
      const asked = wantFrom(found.events, now)
      if (asked !== undefined) state.want = asked
    }
    if (state.want !== null && now - state.want.at > DETAIL_HOST.WANT_TTL_MS) state.want = null
    if (state.want !== null) await refresh($, source, state.want, now)
  } catch {
    // the drill-down is best effort: the list still works
  }
}

/** Start the loop (once per module instance): it ends when `bind.isCurrent()` says another instance took over. */
export function startDetailLoop($: Dollar, source: DetailSource, bind: DetailBind): void {
  if (state.isBound) return
  state.isBound = true
  const writeStub = async (): Promise<void> => {
    const dir = source.dir()
    if (dir !== null) await writeLive($, dir, DETAIL_FILE_NAME, DETAIL_TEMP_NAME, DETAIL_STUB).catch(() => undefined)
  }
  const step = async (): Promise<void> => {
    if (!(await bind.isCurrent().catch(() => false))) return
    await detailTick($, source, bind)
    $.clock.after(state.want === null ? DETAIL_HOST.POLL_IDLE_MS : DETAIL_HOST.POLL_OPEN_MS, () => void step())
  }
  void (async () => {
    // Requests already in the file are old: only clicks from now on count.
    const text = await readEventsText($, bind.eventsFile)
    state.cursor = readEvents(text, 0).last
    state.size = (await sizeOf($, bind.eventsFile)) ?? -1
    await writeStub()
    await step()
  })()
}
