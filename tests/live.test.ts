// The live preview, the pure parts: the child's line protocol, its argv, the control lines, the retry rule, the
// status words, `/panel live ...`, `scene {id, goto}` and the live face in the pane layout.
import { expect, test } from 'claude-code/testing'

import { LIVE_USAGE, parseLiveArgs } from '../hooks/commands'
import { layout } from '../hooks/layout'
import type { Faces, Line, LiveFace } from '../hooks/layout'
import { GLYPH, LIVE_KEY } from '../hooks/layout-types'
import {
  CRASH_CAP, CRASH_WINDOW_MS, DENY_LIMIT, DENY_RETRY_MS, hashLine, heroPath, isRunCurrent, keyLine, liveArgv, LIVE_FPS, LIVE_HEIGHT_MAX, LIVE_HEIGHT_MIN, LIVE_WIDTH, parseLiveLine,
  mergeScroll, NO_SCROLL, QUIT_LINE, retryWait, SCROLL_COUNT_MAX, SCROLL_MOVES, scrollLine, scrollMoveOf, sizeLine, stageOf, START_VIEWPORT, statusWords, takeLines, viewportFor,
} from '../hooks/live-proto'
import { applyScene, parseSceneInput } from '../hooks/scene'
import type { PanelScene, PanelState } from '../types'
import { FIXTURE } from './fixture-state'

const NOW = 1_767_000_000_000
const NO_DENIALS = { count: 0, at: 0 }
const HEALTHY = { isBroken: false, denied: NO_DENIALS, shownId: null }
const text = (l: Line): string => l.map(s => s.text).join('')
const scene = (id: string, over: Partial<PanelScene> = {}): PanelScene => ({
  id, dir: '/tmp/d', entry: 'index.html', alt: 'A scene.', span: 3, height: 420, layout: 'card', rev: 1, ...over,
})
const state = (scenes: PanelScene[]): PanelState => ({ ...FIXTURE, scenes, url: 'http://127.0.0.1:1/t/' })

test('parseLiveLine accepts ready, error and well-formed frames; anything else is nothing', () => {
  expect(parseLiveLine('{"t":"ready"}')).toEqual({ t: 'ready' })
  expect(parseLiveLine('{"t":"error","error":"no Chrome"}')).toEqual({ t: 'error', error: 'no Chrome' })
  expect(parseLiveLine('{"t":"frame","n":3,"file":"/tmp/live-0.png","w":960,"h":540}')).toEqual({ t: 'frame', file: '/tmp/live-0.png', w: 960, h: 540 })
  const refused = [
    'not json', '[]', 'null', '{"t":"frame"}', '{"t":"frame","file":"rel.png","w":1,"h":1}', '{"t":"frame","file":"/a.png","w":0,"h":5}',
    '{"t":"frame","file":"/a.png","w":1.5,"h":5}', '{"t":"frame","file":"/a.png","w":"9","h":5}', '{"t":"other"}',
  ]
  for (const line of refused) expect(parseLiveLine(line), line).toBeNull()
})

test('takeLines turns pieces of stdout into whole lines and carries the unfinished tail', () => {
  expect(takeLines('', 'a\nb\nc')).toEqual({ lines: ['a', 'b'], carry: 'c' })
  expect(takeLines('c', 'd\n\n')).toEqual({ lines: ['cd'], carry: '' })
  expect(takeLines('', '')).toEqual({ lines: [], carry: '' })
})

test('liveArgv names the script, url, folders, size and rate; --hash only when there is one', () => {
  const l = { pluginRoot: '/p', url: 'http://h/t/s/deck/', outDir: '/o/frames', control: '/o/control-1.jsonl', hash: '', size: { width: 720, height: 1000 }, state: '/o/panel.json', base: 'http://h/t', fallback: 's/deck/' }
  const argv = liveArgv(l)
  expect(argv.slice(1, 3)).toEqual(['/p/web/live.mjs', l.url])
  expect(argv.slice(3)).toEqual([
    '--out-dir', '/o/frames', '--control', '/o/control-1.jsonl',
    '--state', '/o/panel.json', '--base', 'http://h/t/', '--fallback', 's/deck/',
    '--width', '720', '--height', '1000', '--fps', String(LIVE_FPS),
  ])
  expect(liveArgv({ ...l, hash: '#/2' }).slice(-2)).toEqual(['--hash', '#/2'])
})

test('a run is kept only for the same hero on the same server address (a port change restarts it)', () => {
  const run = { id: 'board', base: 'http://127.0.0.1:1/t/', isStopping: false }
  expect(isRunCurrent(run, 'board', 'http://127.0.0.1:1/t/')).toBe(true)
  expect(isRunCurrent(run, 'board', 'http://127.0.0.1:2/t/')).toBe(false)
  expect(isRunCurrent(run, 'deck', 'http://127.0.0.1:1/t/')).toBe(false)
  expect(isRunCurrent({ ...run, isStopping: true }, 'board', 'http://127.0.0.1:1/t/')).toBe(false)
  expect(isRunCurrent(null, 'board', 'http://127.0.0.1:1/t/')).toBe(false)
})

test('the fallback page is the hero scene alone', () => {
  expect(heroPath('board')).toBe('s/board/')
  expect(heroPath('a b')).toBe('s/a%20b/')
})

test('control lines are single JSON lines with the commands live.mjs knows', () => {
  expect(JSON.parse(keyLine('prev'))).toEqual({ cmd: 'key', key: 'ArrowLeft' })
  expect(JSON.parse(keyLine('next'))).toEqual({ cmd: 'key', key: 'ArrowRight' })
  expect(JSON.parse(sizeLine({ width: 720, height: 1100 }))).toEqual({ cmd: 'size', w: 720, h: 1100 })
  expect(JSON.parse(hashLine('#/4'))).toEqual({ cmd: 'hash', hash: '#/4' })
  expect(JSON.parse(QUIT_LINE)).toEqual({ cmd: 'quit' })
  for (const line of [keyLine('next'), hashLine('#/1'), sizeLine(START_VIEWPORT), QUIT_LINE]) expect(line).not.toContain('\n')
})

test('retryWait: free to start; the crash cap waits out the window; a refusal waits, the second is final', () => {
  expect(retryWait(NOW, [], NO_DENIALS)).toBeNull()
  const crashes = Array.from({ length: CRASH_CAP }, (_, i) => NOW - 10_000 + i)
  expect(retryWait(NOW, crashes.slice(1), NO_DENIALS)).toBeNull()
  expect(retryWait(NOW, crashes, NO_DENIALS)).toBe(crashes[0]! + CRASH_WINDOW_MS - NOW)
  expect(retryWait(NOW + CRASH_WINDOW_MS, crashes, NO_DENIALS)).toBeNull() // old crashes no longer count
  expect(retryWait(NOW + 1000, [], { count: 1, at: NOW })).toBe(DENY_RETRY_MS - 1000)
  expect(retryWait(NOW + DENY_RETRY_MS, [], { count: 1, at: NOW })).toBeNull()
  expect(retryWait(NOW, [], { count: DENY_LIMIT, at: NOW })).toBe(Number.POSITIVE_INFINITY)
})

test('stageOf is the first stage scene; statusWords says where live stands in plain words', () => {
  expect(stageOf(state([scene('a'), scene('b', { layout: 'stage' }), scene('c', { layout: 'stage' })]))?.id).toBe('b')
  expect(stageOf(state([scene('a')]))).toBeUndefined()
  const staged = state([scene('deck', { layout: 'stage' })])
  expect(statusWords(staged, false, HEALTHY)).toMatch(/^live: off/)
  expect(statusWords(state([scene('a')]), true, HEALTHY)).toMatch(/waiting for a stage scene/)
  expect(statusWords(staged, true, { ...HEALTHY, isBroken: true })).toMatch(/could not start/)
  expect(statusWords(staged, true, { ...HEALTHY, denied: { count: DENY_LIMIT, at: NOW } })).toMatch(/did not take the live picture/)
  expect(statusWords(staged, true, HEALTHY)).toMatch(/not showing yet/)
  expect(statusWords(staged, true, { ...HEALTHY, shownId: 'deck' })).toBe(`live: on, showing the workspace (big tile "deck") at up to ${LIVE_FPS} fps`)
})

test('/panel live: on, off, status (also bare), a usage line for another word, undefined for other commands', () => {
  expect(parseLiveArgs('live on')).toEqual({ verb: 'on' })
  expect(parseLiveArgs(' live   off ')).toEqual({ verb: 'off' })
  expect(parseLiveArgs('live status')).toEqual({ verb: 'status' })
  expect(parseLiveArgs('live')).toEqual({ verb: 'status' })
  expect(parseLiveArgs('live maybe')).toEqual({ usage: LIVE_USAGE })
  expect(parseLiveArgs('open deck')).toBeUndefined()
  expect(parseLiveArgs('')).toBeUndefined()
})

test('scene {id, goto}: alone it is a goto; the hash is validated like shot_at; mixed with anything else it is refused', () => {
  expect(parseSceneInput({ id: 'deck', goto: '#/2' })).toEqual({ kind: 'goto', id: 'deck', hash: '#/2' })
  const refusal = (input: unknown): string => {
    try {
      parseSceneInput(input)
    } catch (err) {
      return (err as Error).message
    }
    return 'ok'
  }
  expect(refusal({ id: 'deck', goto: 'javascript:1' })).toMatch(/^scene\.goto "javascript:1" is invalid: use a location hash such as "#\/3"/)
  expect(refusal({ id: 'deck', goto: `#${'a'.repeat(41)}` })).toMatch(/scene\.goto .* is invalid/)
  expect(refusal({ id: 'deck', goto: '#/2', alt: 'x' })).toMatch(/^scene\.goto cannot be combined with other fields/)
  expect(refusal({ goto: '#/2' })).toMatch(/scene\.id/)
  expect(refusal({ id: 'deck', dir: '/tmp/d', alt: 'x', shot_at: 'bad' })).toMatch(/^scene\.shot_at "bad" is invalid: use a location hash/)
  // A goto changes no state.
  const prev = state([scene('deck', { layout: 'stage' })])
  const out = applyScene(prev, { kind: 'goto', id: 'deck', hash: '#/2' }, NOW)
  expect(out.isOk && out.state === prev).toBe(true)
})

test('layout: a live frame replaces the face of its scene (a keyed Image) and adds the slide buttons row', () => {
  const live: LiveFace = { sceneId: 'deck', file: '/tmp/frames/live-1.png', generation: 7, width: 960, height: 540 }
  const s = state([scene('deck', { layout: 'stage', title: 'Deck' }), scene('other')])
  const withLive = layout(s, 45, new Map() as Faces, { live })
  const picture = withLive.flat().find(seg => seg.image !== undefined)?.image
  expect(picture).toMatchObject({ key: LIVE_KEY, file: live.file, generation: 7 })
  const buttons = withLive.flat().flatMap(seg => (seg.button?.key.startsWith('live:') === true ? [seg.button] : []))
  expect(buttons).toEqual([
    { key: 'live:prev', label: GLYPH.PREV },
    { key: 'live:next', label: GLYPH.NEXT },
  ])
  expect(withLive.map(text).some(row => row.includes(`[ ${GLYPH.PREV} ]  [ ${GLYPH.NEXT} ]`))).toBe(true)
  // The footer link stays with the live view in.
  expect(withLive.map(text)).toContain('↗ stage · /panel open deck')
  // A live frame of another scene, or none: no picture of it, no buttons.
  for (const extras of [{ live: { ...live, sceneId: 'gone' } }, {}]) {
    const plain = layout(s, 45, new Map() as Faces, extras)
    expect(plain.flat().some(seg => seg.button !== undefined && seg.button.key.startsWith('live:'))).toBe(false)
    expect(plain.flat().some(seg => seg.image?.key === LIVE_KEY)).toBe(false)
  }
  // The pane width rules hold with the live row in.
  for (const width of [40, 44, 48]) {
    const widest = Math.max(...layout(s, width, new Map() as Faces, { live }).map(l => Array.from(text(l)).length))
    expect(widest).toBeLessThanOrEqual(width)
  }
})

test('viewportFor: the width is fixed at 720, the height follows the pane (aspect = cols*1 / rows*2) and is clamped to [360, 1600]', () => {
  expect(LIVE_WIDTH).toBe(720)
  // sizes tested: a narrow tall pane, a squarer one, a wide short one, and the extremes
  expect(viewportFor(45, 50)).toEqual({ width: 720, height: 1600 }) // 45x50 cells: 45 : 100 -> 1600 (clamped from 1600)
  expect(viewportFor(45, 30)).toEqual({ width: 720, height: 960 }) // 45 : 60
  expect(viewportFor(45, 20)).toEqual({ width: 720, height: 640 })
  expect(viewportFor(100, 30)).toEqual({ width: 720, height: 432 }) // 100 : 60
  expect(viewportFor(200, 10)).toEqual({ width: 720, height: LIVE_HEIGHT_MIN }) // too wide: clamped
  expect(viewportFor(20, 100)).toEqual({ width: 720, height: LIVE_HEIGHT_MAX }) // too tall: clamped
  expect(viewportFor(0, 0).height).toBeGreaterThanOrEqual(LIVE_HEIGHT_MIN) // nonsense is safe
  for (const [c, r] of [[45, 30], [60, 40], [80, 24], [30, 60]] as const) {
    const v = viewportFor(c, r)
    if (v.height > LIVE_HEIGHT_MIN && v.height < LIVE_HEIGHT_MAX) expect(Math.abs(v.width / v.height - c / (2 * r))).toBeLessThan(0.01)
  }
})

test('scroll moves merge into one pending request: steps and pages add, an edge restarts, the count is capped, nothing nets to no line', () => {
  const press = (...actions: (keyof typeof SCROLL_MOVES)[]) => actions.reduce((p, a) => mergeScroll(p, SCROLL_MOVES[a]), NO_SCROLL)
  expect(scrollLine(press('down', 'down', 'down'))).toBe('{"cmd":"scroll","steps":3,"pages":0}')
  expect(scrollLine(press('down', 'up'))).toBeNull()
  expect(scrollLine(press('pagedown', 'down', 'pageup', 'pageup'))).toBe('{"cmd":"scroll","steps":1,"pages":-1}')
  expect(scrollLine(press('down', 'down', 'top'))).toBe('{"cmd":"scroll","edge":"top","steps":0,"pages":0}') // what came before an edge no longer matters
  expect(scrollLine(press('bottom', 'up', 'up'))).toBe('{"cmd":"scroll","edge":"bottom","steps":-2,"pages":0}') // moves after it count
  expect(JSON.parse(scrollLine(press(...Array(SCROLL_COUNT_MAX + 20).fill('down'))) ?? 'null').steps).toBe(SCROLL_COUNT_MAX)
})

test('scrollMoveOf: the engine\'s wheel tick and page key as a move of the hero tile', () => {
  expect(scrollMoveOf(1, 30)).toEqual({ steps: 1 })
  expect(scrollMoveOf(-3, 30)).toEqual({ steps: -3 })
  expect(scrollMoveOf(30, 30)).toEqual({ pages: 1 })
  expect(scrollMoveOf(-30, 30)).toEqual({ pages: -1 })
  expect(scrollMoveOf(0, 30)).toBeNull()
  expect(scrollMoveOf(Number.NaN, 30)).toBeNull()
})
