// The pure half of the live preview (hooks/live.ts is the controller): constants, the line protocol of web/live.mjs,
// its argv, the lines written to its control file, the retry rule and the words for `/panel live status`.
import type { PanelScene, PanelState } from '../types'
import type { LiveStep, ScrollAction } from './layout-types'
import { heroOf } from './hero'
import { SCENE_CAPS, STAGE_LAYOUT, withSep } from './scene'
import { NODE_BIN } from './server'

export const LIVE_SCRIPT = 'web/live.mjs'
/** The page the live view screencasts: every main scene as a tile of one grid (web/builtin/workspace/), served by web/server.mjs. */
export const WORKSPACE_PATH = 'workspace/'
export const HERO_PARAM = 'hero'
const SCENE_PATH = 's/'
export const LIVE_SUBDIR = 'live'
export const LIVE_FRAMES_DIR = 'frames'
/**
 * The live page's viewport. The width is fixed (720: a pane of 45 columns is about 450 px wide, and a frame is 25% fewer
 * pixels than at 960, which is the cost of every PNG at LIVE_FPS); the height follows the shape of the pane's picture
 * (`viewportFor`). Before the pane has said how big the picture is, the page opens at LIVE_HEIGHT_START.
 */
export const LIVE_WIDTH = 720
export const LIVE_HEIGHT_START = 960
export const LIVE_HEIGHT_MIN = 360
export const LIVE_HEIGHT_MAX = 1600
/** The shape of a terminal cell, width : height (about 1 : 2); tune here when a terminal's cells are squarer. */
export const CELL_W = 1
export const CELL_H = 2
/** A change of the picture's cell box is sent to the page after this long without another (a window drag is one resize). */
export const RESIZE_DEBOUNCE_MS = 300
export const LIVE_FPS = 8
/** A child that dies this many times within the window is not started again until the window has passed. */
export const CRASH_CAP = 3
export const CRASH_WINDOW_MS = 60_000
/** After a pane refuses a frame: one more try after this long (the pane may have been closed and reopened); a second refusal is final. */
export const DENY_RETRY_MS = 30_000
export const DENY_LIMIT = 2
/** A refusal this soon after a draw is "not mounted yet", not "cannot draw": the next frame tries again. */
export const MOUNT_GRACE_MS = 1000
export const STOP_WAIT_MS = 3000
export const NOT_RUNNING = 'live: not running'
export const NOT_HASH_FITS = 'live: that hash is too long for a tile'
const KEYS: Readonly<Record<LiveStep, string>> = { prev: 'ArrowLeft', next: 'ArrowRight' }

/** Scroll presses are merged for this long (a held key is one control line, not thirty); the line is then written once. */
export const SCROLL_DEBOUNCE_MS = 100
/** The most steps or pages one control line carries: web/scroll-math.mjs refuses more (its tests pin the two together). */
export const SCROLL_COUNT_MAX = 50

export type Viewport = { width: number; height: number }
export const START_VIEWPORT: Viewport = { width: LIVE_WIDTH, height: LIVE_HEIGHT_START }

/**
 * The page size for a picture of `columns` x `rows` cells: pixel aspect = (columns * CELL_W) / (rows * CELL_H), the width
 * fixed at LIVE_WIDTH, the height derived and clamped to [LIVE_HEIGHT_MIN, LIVE_HEIGHT_MAX] (a cell box beyond that is
 * stretched a little rather than asked of Chrome).
 */
export function viewportFor(columns: number, rows: number): Viewport {
  const aspect = (Math.max(1, columns) * CELL_W) / (Math.max(1, rows) * CELL_H)
  const height = Math.round(LIVE_WIDTH / aspect)
  return { width: LIVE_WIDTH, height: Math.min(LIVE_HEIGHT_MAX, Math.max(LIVE_HEIGHT_MIN, height)) }
}

/** The workspace page's address; `heroId` (the scene the person picked) becomes its big tile. */
export const workspaceUrl = (base: string, heroId: string): string =>
  `${withSep(base)}${WORKSPACE_PATH}${heroId === '' ? '' : `?${HERO_PARAM}=${encodeURIComponent(heroId)}`}`

const HASH_START = '#'
const TILE_HASH_SEP = '.'
const PATH_SEP = '/'
const PATH_SEP_IN_HASH = '_'

/**
 * `scene {id, goto: "#/2/0"}` as the hash the workspace page reads (`#<id>._2_0`, see web/builtin/workspace/layout.js tileHash,
 * which the tests pin to this one); null when it does not fit a location hash (at most SHOT_AT_CHARS characters).
 */
export function tileHash(id: string, hash: string): string | null {
  if (!hash.startsWith(HASH_START)) return null
  const out = `${HASH_START}${id}${TILE_HASH_SEP}${hash.slice(1).split(PATH_SEP).join(PATH_SEP_IN_HASH)}`
  return out.length <= SCENE_CAPS.SHOT_AT_CHARS ? out : null
}

export type LiveMsg =
  | { t: 'ready' }
  | { t: 'frame'; file: string; w: number; h: number }
  | { t: 'error'; error: string }

/** The scene that is shown live: the hero picture (see hero.ts), when it is a stage scene. */
export const stageOf = (s: PanelState, activeId?: string | null): PanelScene | undefined => {
  const hero = heroOf(s, activeId)
  return hero?.layout === STAGE_LAYOUT ? hero : undefined
}

/** One line of live.mjs's stdout; null for anything that is not a well-formed message. */
export function parseLiveLine(line: string): LiveMsg | null {
  let v: unknown
  try {
    v = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof v !== 'object' || v === null) return null
  const o = v as Record<string, unknown>
  if (o.t === 'ready') return { t: 'ready' }
  if (o.t === 'error') return { t: 'error', error: String(o.error ?? '') }
  if (o.t !== 'frame' || typeof o.file !== 'string' || !o.file.startsWith('/')) return null
  const [w, h] = [o.w, o.h]
  return Number.isInteger(w) && Number.isInteger(h) && (w as number) > 0 && (h as number) > 0
    ? { t: 'frame', file: o.file, w: w as number, h: h as number }
    : null
}

/** Pieces of stdout (not lines) -> complete lines; the unfinished tail is carried. */
export function takeLines(carry: string, text: string): { lines: string[]; carry: string } {
  const parts = (carry + text).split('\n')
  return { lines: parts.slice(0, -1).filter(l => l.trim() !== ''), carry: parts[parts.length - 1] ?? '' }
}

/** `state` is the state file (it holds the server's current address), `base` the address `url` was built on, `fallback` the page to open when `url` fails. */
export type LiveLaunch = {
  pluginRoot: string; url: string; outDir: string; control: string; hash: string; size: Viewport
  state: string; base: string; fallback: string
}

/**
 * Whether the running child still shows what is wanted: the same hero on the same server address. A server that came back
 * on another port (a mod reload) leaves the child pointing at a dead address, so a new address restarts it.
 */
export const isRunCurrent = (run: { id: string; base: string; isStopping: boolean } | null, wantId: string, wantBase: string): boolean =>
  run !== null && !run.isStopping && run.id === wantId && run.base === wantBase

/** The hero scene alone, under the server's address: where live.mjs falls back to when the workspace page does not open. */
export const heroPath = (heroId: string): string => `${SCENE_PATH}${encodeURIComponent(heroId)}/`

export const liveArgv = (l: LiveLaunch): string[] => [
  NODE_BIN,
  `${l.pluginRoot}/${LIVE_SCRIPT}`,
  l.url,
  '--out-dir', l.outDir,
  '--control', l.control,
  '--state', l.state,
  '--base', withSep(l.base),
  '--fallback', l.fallback,
  '--width', String(l.size.width),
  '--height', String(l.size.height),
  '--fps', String(LIVE_FPS),
  ...(l.hash === '' ? [] : ['--hash', l.hash]),
]

export const keyLine = (step: LiveStep): string => JSON.stringify({ cmd: 'key', key: KEYS[step] })
export const sizeLine = (size: Viewport): string => JSON.stringify({ cmd: 'size', w: size.width, h: size.height })
export const hashLine = (hash: string): string => JSON.stringify({ cmd: 'hash', hash })
/** A message to one scene's iframe (the host side of `panel.on(name, ...)`), delivered by the workspace page: live.mjs `host`. */
export const hostLine = (scene: string, name: string, data: unknown): string => JSON.stringify({ cmd: 'host', scene, name, data })
/** One scroll request: to an edge, or by steps (a j/k press, a wheel tick) or pages (signed, down positive). */
export type ScrollMove = { edge: 'top' | 'bottom' } | { steps: number } | { pages: number }
/** What is waiting to be sent: an edge first (when one was asked), then the net steps and pages. */
export type ScrollPending = { edge?: 'top' | 'bottom'; steps: number; pages: number }
export const NO_SCROLL: ScrollPending = { steps: 0, pages: 0 }

export const SCROLL_MOVES: Readonly<Record<ScrollAction, ScrollMove>> = {
  up: { steps: -1 }, down: { steps: 1 }, pageup: { pages: -1 }, pagedown: { pages: 1 }, top: { edge: 'top' }, bottom: { edge: 'bottom' },
}

const capCount = (n: number): number => Math.max(-SCROLL_COUNT_MAX, Math.min(SCROLL_COUNT_MAX, Math.round(n)))

/** Adds one move to what waits: an edge restarts the count (what came before it no longer matters), steps and pages add up. */
export function mergeScroll(p: ScrollPending, m: ScrollMove): ScrollPending {
  if ('edge' in m) return { edge: m.edge, steps: 0, pages: 0 }
  return {
    ...(p.edge === undefined ? {} : { edge: p.edge }),
    steps: capCount(p.steps + ('steps' in m ? m.steps : 0)),
    pages: capCount(p.pages + ('pages' in m ? m.pages : 0)),
  }
}

/**
 * The engine's own scroll (`ui.scroll`: a wheel tick is `by` of 1, a page key `bodyRows`, Home and End `contentRows`) as a move of the
 * hero tile: a whole screen or more is a page, anything less that many steps. Home and End look like a page here (a known limit).
 */
export const scrollMoveOf = (by: number, bodyRows: number): ScrollMove | null =>
  by === 0 || !Number.isFinite(by) ? null : Math.abs(by) >= Math.max(1, bodyRows) ? { pages: Math.sign(by) } : { steps: Math.round(by) }

/** The control line for what waits; null when it nets out to nothing (a down and an up). */
export const scrollLine = (p: ScrollPending): string | null =>
  p.edge === undefined && p.steps === 0 && p.pages === 0
    ? null
    : JSON.stringify({ cmd: 'scroll', ...(p.edge === undefined ? {} : { edge: p.edge }), steps: p.steps, pages: p.pages })

export const QUIT_LINE = JSON.stringify({ cmd: 'quit' })

export type Refusals = { count: number; at: number }

/** How long until the next start may be tried: null = now, Infinity = never (a refusal limit is final). */
export function retryWait(now: number, crashes: readonly number[], denied: Refusals): number | null {
  if (denied.count >= DENY_LIMIT) return Number.POSITIVE_INFINITY
  const recent = crashes.filter(t => now - t < CRASH_WINDOW_MS)
  const wait = Math.max(
    recent.length >= CRASH_CAP ? (recent[0] ?? now) + CRASH_WINDOW_MS - now : 0,
    denied.count > 0 ? denied.at + DENY_RETRY_MS - now : 0,
  )
  return wait > 0 ? wait : null
}

export type LiveHealth = { isBroken: boolean; denied: Refusals; shownId: string | null }

/** Plain words for `/panel live status`; `shownId` is the scene being shown right now, if any. */
export function statusWords(state: PanelState, isEnabled: boolean, h: LiveHealth): string {
  if (!isEnabled) return 'live: off (turn it on with /panel live on)'
  if (stageOf(state) === undefined) return 'live: on, waiting for a stage scene'
  if (h.isBroken) return 'live: on, but it could not start (is Chrome installed?)'
  if (h.denied.count >= DENY_LIMIT) return 'live: on, stopped: this terminal did not take the live picture'
  return h.shownId !== null
    ? `live: on, showing the workspace (big tile "${h.shownId}") at up to ${LIVE_FPS} fps`
    : 'live: on, not showing yet (it starts when the pane is drawn)'
}
