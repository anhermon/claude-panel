// The live preview of the WORKSPACE in the terminal pane: one page that tiles every main scene (web/builtin/workspace/), with
// the hero (hooks/hero.ts: the scene the person picked with the pane's switcher, else the first stage scene) as its big tile.
// While the pane is drawn and there is a hero stage scene,
// web/live.mjs (a headless Chrome screencast of the workspace page) runs as a child of this module and prints one JSON
// line per frame; each frame is handed to the terminal with `$.ui.blit`, which swaps the pane's KEYED Image in place
// (the PNG file is read by the terminal itself, no pixel crosses `$`). One process at a time: it is restarted when the
// hero's id changes (picking another hero restarts it; a scene's own rev or files reload its tile inside the page) and stopped when the scene goes, live is turned off, or the module unloads (the
// spawn loop's end kills the child). The pane tree draws the Image from `liveView()`, so a redraw keeps the newest
// frame instead of the old screenshot. A pane that refuses a frame (no image support, not mounted) stops the process.
// State is module-level and reset by `resetLive` at session start; a hot reload starts from nothing.
// Every helper that takes `$` is a function declaration: the plugin checks follow `$` past an import only into those.
import type { EngineInterface } from 'claude-code'

import type { PanelScene, PanelState } from '../types'
import { appendLine } from './events-io'
import { LIVE_KEY } from './layout-types'
import type { LiveFace, LiveStep } from './layout-types'
import {
  hashLine, heroPath, hostLine, isRunCurrent, keyLine, liveArgv, LIVE_FRAMES_DIR, LIVE_SUBDIR, mergeScroll, MOUNT_GRACE_MS, NO_SCROLL, NOT_HASH_FITS, NOT_RUNNING, parseLiveLine,
  QUIT_LINE, SCROLL_DEBOUNCE_MS, scrollLine, RESIZE_DEBOUNCE_MS, retryWait, sizeLine, stageOf, START_VIEWPORT, statusWords, STOP_WAIT_MS, takeLines, tileHash, viewportFor, workspaceUrl,
} from './live-proto'
import type { LiveMsg, Refusals, ScrollMove, ScrollPending, Viewport } from './live-proto'
import { stateFilePath } from './register-support'
import { SHOT_STATE_DIR } from './shot'
import { PANE_ID, PLUGIN_NAME } from './spec'

type Dollar = EngineInterface
type Stream = AsyncGenerator<{ stream: 'stdout' | 'stderr'; text: string }, unknown>

type Run = {
  /** The hero scene the page was opened with (its big tile); the live frame is the pane's picture for that hero. */
  id: string
  /** The server address the page was opened on; another one (the server restarted elsewhere) restarts the child. */
  base: string
  control: string
  frame: LiveFace | null
  /** The pixel size of the frame the last render drew; a blit is only sent for that size. */
  drawn: { w: number; h: number } | null
  mountedAt: number | null
  hasFrame: boolean
  /** The viewport the page was last told (at start, or by a `size` line). */
  size: Viewport
  isStopping: boolean
  stream: Stream
  done: Promise<void>
}
type Ctl = {
  run: Run | null
  crashes: number[]
  denied: Refusals
  /** live.mjs said it cannot start (no Chrome...): no retries until `/panel live on`. */
  isBroken: boolean
  /** The hash a scene's tile opens at, from `shot_at`, by scene id; used by the next start. */
  hashes: Map<string, string>
  generation: number
  /** The cell box of the pane's live picture, as the last draw reported it; the page's viewport follows it. */
  box: { columns: number; rows: number } | null
  resize: { cancel: () => void } | null
  /** Scroll presses not sent yet, and the timer that sends them (see `liveScroll`). */
  scroll: { pending: ScrollPending; timer: { cancel: () => void } | null }
  /** Two serial lanes: syncs/stops, and single-line control appends (two at once must not interleave or reorder). */
  lanes: { sync: Promise<unknown>; append: Promise<unknown> }
}
const fresh = (): Ctl => ({
  run: null, crashes: [], denied: { count: 0, at: 0 }, isBroken: false, hashes: new Map(), generation: 0, box: null, resize: null, scroll: { pending: NO_SCROLL, timer: null },
  lanes: { sync: Promise.resolve(), append: Promise.resolve() },
})
let ctl: Ctl = fresh()

export const resetLive = (): void => {
  ctl = fresh()
}

function log($: Dollar, text: string): void {
  $.ui.log(`${PLUGIN_NAME}: live: ${text}`, { to: 'debug' })
}

function enqueue<T>(lane: keyof Ctl['lanes'], step: () => Promise<T>): Promise<T> {
  const next = ctl.lanes[lane].then(step, step)
  ctl.lanes[lane] = next
  return next
}

/** What the pane draws: the newest frame of the running view, or null (draw the static face). */
export const liveView = (): LiveFace | null => {
  const { run } = ctl
  return run === null || run.isStopping ? null : run.frame
}

/** `shot_at`: remember where scene `id`'s tile opens; a running view moves that tile at once. */
export function liveSetHash($: Dollar, id: string, hash: string): void {
  if (hash === '') return void ctl.hashes.delete(id)
  const { run } = ctl
  const line = tileHash(id, hash)
  if (run !== null && !run.isStopping && line !== null) {
    ctl.hashes.delete(id)
    void appendControl($, run, hashLine(line))
    return
  }
  ctl.hashes.set(id, hash)
}

export function liveStatusText(state: PanelState, isEnabled: boolean): string {
  const { run, isBroken, denied } = ctl
  const isShown = run !== null && !run.isStopping && run.hasFrame
  return statusWords(state, isEnabled, { isBroken, denied, shownId: isShown ? run.id : null })
}

// ---- the child -------------------------------------------------------------------------------------------

function appendControl($: Dollar, run: Run, line: string): Promise<boolean> {
  return enqueue('append', () => appendLine($, run.control, line))
}

/** Ask the child to end, however it listens: its quit command, and closing the stream (which kills it). */
function signalStop($: Dollar, run: Run): void {
  if (run.isStopping) return
  run.isStopping = true
  ctl.resize?.cancel()
  ctl.resize = null
  ctl.scroll.timer?.cancel()
  ctl.scroll = { pending: NO_SCROLL, timer: null }
  void appendControl($, run, QUIT_LINE)
  void run.stream.return(undefined).catch(() => undefined)
  $.ui.invalidate('ui.render')
}

async function stopRun($: Dollar, run: Run): Promise<void> {
  signalStop($, run)
  const box: { timer?: { cancel: () => void } } = {}
  const late = new Promise<void>(resolve => {
    box.timer = $.clock.after(STOP_WAIT_MS, resolve)
  })
  await Promise.race([run.done, late])
  box.timer?.cancel()
}

async function onFrame($: Dollar, run: Run, msg: Extract<LiveMsg, { t: 'frame' }>): Promise<void> {
  run.hasFrame = true
  ctl.generation += 1
  const frame: LiveFace = { sceneId: run.id, file: msg.file, generation: ctl.generation, width: msg.w, height: msg.h }
  run.frame = frame
  // Not drawn yet (or drawn at another size): a redraw puts the keyed Image in the tree; blits start after it.
  if (run.mountedAt === null || run.drawn?.w !== msg.w || run.drawn?.h !== msg.h) return $.ui.invalidate('ui.render')
  const answer = await $.ui.blit({ requestId: PANE_ID, key: LIVE_KEY, source: { file: msg.file, format: 'png', generation: frame.generation } })
  if (answer.deny === undefined || run.isStopping) return
  const now = await $.clock.now()
  if (now - run.mountedAt < MOUNT_GRACE_MS) return // the draw has not landed yet: the next frame tries again
  log($, `the pane refused a frame (${answer.deny}); the static picture stays`)
  ctl.denied = { count: ctl.denied.count + 1, at: now }
  signalStop($, run)
}

async function onLine($: Dollar, run: Run, line: string): Promise<void> {
  const msg = parseLiveLine(line)
  if (msg === null || msg.t === 'ready') return
  if (msg.t === 'frame') return onFrame($, run, msg)
  log($, `live.mjs: ${msg.error}`)
  if (!run.hasFrame) ctl.isBroken = true
}

/** Reads the child's output to its end, then clears the run (a death nobody asked for counts toward the cap). */
async function pump($: Dollar, run: Run): Promise<void> {
  let carry = ''
  try {
    for (let next = await run.stream.next(); next.done !== true; next = await run.stream.next()) {
      const { stream, text } = next.value
      if (stream === 'stderr') {
        log($, `live.mjs: ${text.trim()}`)
        continue
      }
      const out = takeLines(carry, text)
      carry = out.carry
      for (const line of out.lines) await onLine($, run, line)
    }
  } catch (err) {
    log($, `the process failed: ${String(err)}`)
  }
  if (ctl.run === run) ctl.run = null
  if (!run.isStopping) ctl.crashes.push(await $.clock.now())
  run.isStopping = true
  $.ui.invalidate('ui.render') // the static face again (or a restart, within the cap)
}

async function start($: Dollar, state: PanelState, scene: PanelScene, tmp: string): Promise<void> {
  const dir = `${tmp}/${SHOT_STATE_DIR}/${LIVE_SUBDIR}/${await $.session.id()}`
  const control = `${dir}/control-${await $.clock.now()}.jsonl`
  await $.fs.write(control, '') // a fresh, empty file per child: no old commands, and the folder exists
  // One hash opens the page: the newest scene that asked for one. The others are dropped with it.
  const [asked] = [...ctl.hashes].reverse()
  ctl.hashes.clear()
  const hash = asked === undefined ? '' : (tileHash(asked[0], asked[1]) ?? '')
  const url = workspaceUrl(state.url ?? '', scene.id)
  const size = ctl.box === null ? START_VIEWPORT : viewportFor(ctl.box.columns, ctl.box.rows)
  const base = state.url ?? ''
  const argv = liveArgv({
    pluginRoot: $.plugin.root, url, outDir: `${dir}/${LIVE_FRAMES_DIR}`, control, hash, size,
    state: await stateFilePath($), base, fallback: heroPath(scene.id),
  })
  const stream = $.process.spawn({ argv })[Symbol.asyncIterator]() as Stream
  const run: Run = {
    id: scene.id, base, control, frame: null, drawn: null, mountedAt: null, hasFrame: false, size, isStopping: false,
    stream, done: Promise.resolve(),
  }
  ctl.run = run
  run.done = pump($, run).catch(() => undefined) // (after an unload `$` refuses: nothing left to tell)
}

/** `tmp` is asked for only when a child is about to start. */
export type SyncInput = {
  state: PanelState
  isEnabled: boolean
  tmp: () => Promise<string>
  /** The scene the person picked as the hero picture; the live view follows it (default: the first hero candidate). */
  heroId?: string | null
}

async function reconcile($: Dollar, { state, isEnabled, tmp, heroId }: SyncInput): Promise<void> {
  const stage = isEnabled && state.url !== null ? stageOf(state, heroId) : undefined
  const { run } = ctl
  if (stage !== undefined && isRunCurrent(run, stage.id, state.url ?? '')) return
  if (run !== null) await stopRun($, run)
  if (stage === undefined || ctl.isBroken) return
  const wait = retryWait(await $.clock.now(), ctl.crashes, ctl.denied)
  if (wait === null) return start($, state, stage, await tmp())
  if (Number.isFinite(wait)) $.clock.after(wait, () => $.ui.invalidate('ui.render'))
}

/** Bring the child in line with the state (start, restart, stop). Calls queue up; never throws. */
export function liveSync($: Dollar, input: SyncInput): Promise<void> {
  return enqueue('sync', () => reconcile($, input).catch(err => log($, `could not sync: ${String(err)}`)))
}

/** Stop the child now (live turned off). */
export function liveStop($: Dollar): Promise<void> {
  return enqueue('sync', async () => {
    if (ctl.run !== null) await stopRun($, ctl.run)
  })
}

/** `/panel live on`: forget refusals, failures and crashes; the next draw starts it. */
export function liveEnable($: Dollar): void {
  ctl.denied = { count: 0, at: 0 }
  ctl.isBroken = false
  ctl.crashes = []
  $.ui.invalidate('ui.render')
}

/**
 * The pane drew its live picture over `box` (cells): the page's viewport follows that shape. The first call before the
 * child exists only records the box (the start uses it); a change later is sent as one `size` line, 300 ms after the last.
 */
export function liveResize($: Dollar, box: { columns: number; rows: number } | null): void {
  if (box === null) return
  ctl.box = box
  const { run } = ctl
  if (run === null || run.isStopping) return
  ctl.resize?.cancel()
  ctl.resize = null
  const want = viewportFor(box.columns, box.rows)
  if (want.width === run.size.width && want.height === run.size.height) return
  ctl.resize = $.clock.after(RESIZE_DEBOUNCE_MS, () => {
    ctl.resize = null
    if (ctl.run !== run || run.isStopping) return
    run.size = want
    void appendControl($, run, sizeLine(want))
  })
}

/** The pane has just drawn `drawn` (the frame its tree held): blits may follow for that size. */
export async function liveRendered($: Dollar, drawn: LiveFace | null): Promise<void> {
  const { run } = ctl
  if (run === null || drawn === null || drawn.sceneId !== run.id) return
  run.drawn = { w: drawn.width, h: drawn.height }
  run.mountedAt = await $.clock.now()
}

/** A message for scene `scene`'s page (`panel.on(name)` there), through the live page. False when nothing is running. */
export async function liveHost($: Dollar, scene: string, name: string, data: unknown): Promise<boolean> {
  const { run } = ctl
  return run === null || run.isStopping ? false : appendControl($, run, hostLine(scene, name, data))
}

/** A press on the pane's slide buttons. False when nothing is running. */
export async function liveStep($: Dollar, step: LiveStep): Promise<boolean> {
  const { run } = ctl
  return run === null || run.isStopping ? false : appendControl($, run, keyLine(step))
}

/**
 * A scroll key, button or wheel tick on the pane: the hero tile of the live page scrolls. Presses are merged and written as ONE
 * control line SCROLL_DEBOUNCE_MS after the last (a held key does not flood the file). False when nothing is running.
 */
export function liveScroll($: Dollar, move: ScrollMove): boolean {
  const { run } = ctl
  if (run === null || run.isStopping) return false
  ctl.scroll.timer?.cancel()
  ctl.scroll.pending = mergeScroll(ctl.scroll.pending, move)
  ctl.scroll.timer = $.clock.after(SCROLL_DEBOUNCE_MS, () => {
    const line = scrollLine(ctl.scroll.pending)
    ctl.scroll = { pending: NO_SCROLL, timer: null }
    if (line !== null && ctl.run === run && !run.isStopping) void appendControl($, run, line)
  })
  return true
}

/** `scene {id, goto}`: move that scene's tile; the line for the tool result. */
export async function liveGoto($: Dollar, id: string, hash: string): Promise<string> {
  const { run } = ctl
  const line = tileHash(id, hash)
  if (run === null || run.isStopping) return NOT_RUNNING
  if (line === null) return `${NOT_HASH_FITS} (${hash})`
  return (await appendControl($, run, hashLine(line))) ? `live: moved to ${hash}` : NOT_RUNNING
}
