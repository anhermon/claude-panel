// The live preview of a stage scene end to end through the engine (everything beneath the mod stood in for, see
// boot.ts): a fake web/live.mjs prints frame lines, `ui.blit` is recorded. Covers start / restart / stop, the keyed
// Image and its blits, a pane that refuses, the crash cap, the slide buttons, `goto`, `shot_at` and `/panel live`.
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { AGENT_BACK_KEY, HOST_CLOSE, HOST_OPEN, HOST_TAB, agentOpenKey, agentTabKey } from '../hooks/agent-controls'
import { AGENTS_INFO_SCENE_ID } from '../hooks/agents-info-scene'
import { LIVE_KEY } from '../hooks/layout-types'
import { hostLine } from '../hooks/live-proto'
import { COOLDOWN_MS, LEAD_MS } from '../hooks/pulse-flush'
import { CRASH_CAP, CRASH_WINDOW_MS, DENY_RETRY_MS, LIVE_FPS, LIVE_WIDTH, MOUNT_GRACE_MS, NOT_RUNNING, RESIZE_DEBOUNCE_MS, SCROLL_DEBOUNCE_MS, START_VIEWPORT, viewportFor } from '../hooks/live-proto'

import { boot, buttons, dir, file, pane, RUN, SCENE_TOOL, seen, STATE_FILE, TOOL } from './boot'
import type { BootOptions, Entry, FakeChild } from './boot'
import { pngHeader } from './png-header'

const TEST_TIMEOUT_MS = 60_000
const VIZ = '/private/tmp/viz'
const FRAMES = '/tmp/t/claude-panel/live/sess-1/frames'
const PANE_COLUMNS = 45
const PRESS = { plugin: 'panel', requestId: 'panel', surface: 'terminal' } as const
const FRAME_W = 960
const FRAME_H = 540
const SETTLE_AFTER_MOUNT_MS = MOUNT_GRACE_MS + 500
const DECK_HTML = `<main>${['Problem', 'Backoff'].map(t => `<section data-title="${t}"></section>`).join('')}</main>`

const PAGE_HTML = '<main><h1>Dashboard</h1></main>'

const DISK: Record<string, Entry> = {
  '/tmp/viz': dir(VIZ),
  [`${VIZ}/index.html`]: file(),
  [`${VIZ}/face.png`]: file(900, pngHeader(200, 100)),
}
const stage = { id: 'deck', dir: '/tmp/viz', alt: 'Two slides.', layout: 'stage', title: 'Backoff', shot: false, term: { image: `${VIZ}/face.png` } }

const frameLine = (n: number) => ({ t: 'frame', n, file: `${FRAMES}/live-${n % 3}.png`, w: FRAME_W, h: FRAME_H })

type Booted = Awaited<ReturnType<typeof boot>>

async function bootLive($: Engine, on: On, opts: BootOptions = {}): Promise<Booted> {
  return boot($, on, { files: DISK, texts: { [`${VIZ}/index.html`]: DECK_HTML }, ...opts })
}

/** Any state change redraws the mounted pane (a draw is what lets the live view start, restart or stop). */
async function redraw($: Engine, b: Booted): Promise<void> {
  await $.tool.call({ tool: TOOL, status: 'working' })
  await b.clock.settle()
}

/** Publish the stage scene, draw the pane and let the child start; returns the child. */
async function showLive($: Engine, b: Booted, scene: Record<string, unknown> = stage) {
  await $.tool.call({ tool: SCENE_TOOL, ...scene })
  const ui = await $.ui.mount({ ...pane(60, PANE_COLUMNS), surface: 'terminal' })
  await b.clock.settle()
  return { ui, child: b.children.at(-1) as FakeChild }
}

/** The first frame redraws (the keyed Image must be drawn before any blit); then the pane is mounted. */
async function mountedWithFrames($: Engine, b: Booted, child: FakeChild): Promise<void> {
  child.say({ t: 'ready' })
  child.say(frameLine(1))
  await b.clock.settle()
  await b.clock.advance(SETTLE_AFTER_MOUNT_MS)
}

/** The newest state the mod mirrored (the control files are written too, so not simply the last write). */
const stateOf = (b: Booted) => JSON.parse(b.writes.filter(w => w.path === STATE_FILE).at(-1)?.text ?? 'null')
const controlAppends = (b: Booted) =>
  b.calls.filter(c => c.argv[0] === 'sh' && c.argv.at(-1)?.includes('/live/sess-1/control-') === true)
const allControlLines = (b: Booted): { cmd: string }[] => controlAppends(b).map(c => JSON.parse(c.init?.stdin ?? 'null'))
/** The key and hash commands (the `size` lines follow the pane's shape and have a test of their own). */
const controlLines = (b: Booted): unknown[] => allControlLines(b).filter(l => l.cmd !== 'size')

test('a stage scene starts one live child with the url, the frames folder and a control file', { timeoutMs: TEST_TIMEOUT_MS }, async ($, on) => {
  const b = await bootLive($, on)
  const { ui, child } = await showLive($, b)
  expect(b.children).toHaveLength(1)
  const { argv } = child
  expect(argv[0]).toBe('node')
  expect(argv[1]).toMatch(/\/web\/live\.mjs$/)
  expect(argv[2]).toBe(`${b.url()}workspace/?hero=deck`)
  const flag = (name: string): string | undefined => argv[argv.indexOf(name) + 1]
  expect(flag('--out-dir')).toBe(FRAMES)
  // So the child can follow a server that restarted on another port, and fall back to the hero scene alone.
  expect(flag('--state')).toBe(STATE_FILE)
  expect(flag('--base')).toBe(b.url())
  expect(flag('--fallback')).toBe('s/deck/')
  expect(flag('--control')).toMatch(/^\/tmp\/t\/claude-panel\/live\/sess-1\/control-\d+\.jsonl$/)
  expect(flag('--fps')).toBe(String(LIVE_FPS))
  expect(argv).not.toContain('--hash')
  // The control file was created empty before the child started.
  expect(b.writes.some(w => w.path === flag('--control') && w.text === '')).toBe(true)
  // A second draw does not start a second child.
  await redraw($, b)
  await b.clock.settle()
  expect(b.children).toHaveLength(1)
  await ui.unmount()
})

test('no live child for a card, for no url, or for a desktop pane', { timeoutMs: TEST_TIMEOUT_MS }, async ($, on) => {
  const b = await bootLive($, on)
  await $.tool.call({ tool: SCENE_TOOL, ...stage, id: 'card', layout: 'card' })
  const ui = await $.ui.mount({ ...pane(60, PANE_COLUMNS), surface: 'terminal' })
  await b.clock.settle()
  expect(b.children).toHaveLength(0)
  await ui.unmount()
  const desktop = await $.ui.mount({ ...pane(60, PANE_COLUMNS), surface: 'desktop' })
  await $.tool.call({ tool: SCENE_TOOL, ...stage })
  await b.clock.settle()
  expect(b.children).toHaveLength(0)
  await desktop.unmount()
})

test('no url yet (the server is down): nothing starts and the static face stays', { timeoutMs: TEST_TIMEOUT_MS }, async ($, on) => {
  const b = await bootLive($, on, { isServerDown: true })
  const { ui } = await showLive($, b)
  expect(b.children).toHaveLength(0)
  expect(await ui.findAll({ type: 'Image' })).toHaveLength(1)
  expect(await buttons(ui)).toEqual([])
  await ui.unmount()
})

test('frames: the first redraws the keyed Image, later ones blit it; the redraw keeps the newest frame', { timeoutMs: TEST_TIMEOUT_MS }, async ($, on) => {
  const b = await bootLive($, on)
  const { ui, child } = await showLive($, b)
  // Before any frame: the static screenshot, no buttons.
  expect((await ui.findAll({ type: 'Image' }))[0]?.props.source).toMatchObject({ png: expect.anything() })
  expect(await buttons(ui)).toEqual([])

  await mountedWithFrames($, b, child)
  expect(b.blits).toHaveLength(0) // the frame that mounted it was drawn, not blitted
  const [image] = await ui.findAll({ type: 'Image' })
  expect(image?.key).toBe(LIVE_KEY)
  expect(image?.props.source).toMatchObject({ file: `${FRAMES}/live-1.png`, format: 'png' })
  expect(await buttons(ui)).toEqual([
    { key: 'live:prev', label: '◀' },
    { key: 'live:next', label: '▶' },
  ])

  child.say(frameLine(2))
  child.say(frameLine(3))
  await b.clock.settle()
  expect(b.blits).toHaveLength(2)
  expect(b.blits[0]).toMatchObject({ requestId: 'panel', key: LIVE_KEY, source: { file: `${FRAMES}/live-2.png`, format: 'png' } })
  const generations = b.blits.map(x => (x as { source: { generation: number } }).source.generation)
  expect(generations[1]).toBeGreaterThan(generations[0] as number)

  // A redraw (any state change) draws the newest frame, not the screenshot that came before the live view.
  await redraw($, b)
  const [again] = await ui.findAll({ type: 'Image' })
  expect(again?.props.source).toMatchObject({ file: `${FRAMES}/live-0.png`, format: 'png', generation: generations[1] })
  await ui.unmount()
})

test('a pane that refuses a frame stops the child, keeps the static face; a second refusal is final', { timeoutMs: TEST_TIMEOUT_MS }, async ($, on) => {
  const b = await bootLive($, on, { blit: () => ({ deny: 'no-image-support' }) })
  const { ui, child } = await showLive($, b)
  await mountedWithFrames($, b, child)
  child.say(frameLine(2))
  await b.clock.settle()
  expect(child.isClosed).toBe(true)
  expect(await buttons(ui)).toEqual([])
  expect((await ui.findAll({ type: 'Image' }))[0]?.props.source).toMatchObject({ png: expect.anything() })

  // One more try after the retry delay (the pane may have been reopened) ...
  await b.clock.advance(DENY_RETRY_MS + 1000)
  await redraw($, b)
  await b.clock.settle()
  expect(b.children).toHaveLength(2)
  const second = b.children[1] as FakeChild
  await mountedWithFrames($, b, second)
  second.say(frameLine(2))
  await b.clock.settle()
  expect(second.isClosed).toBe(true)
  // ... and then no more, however long it waits.
  await b.clock.advance(DENY_RETRY_MS * 4)
  await redraw($, b)
  await b.clock.settle()
  expect(b.children).toHaveLength(2)
  const status = await $.command.run({ command: 'panel', args: 'live status', ...RUN })
  expect(status.text).toMatch(/did not take the live picture/)
  await ui.unmount()
})

test('a refusal right after a draw is "not mounted yet": the child keeps running', { timeoutMs: TEST_TIMEOUT_MS }, async ($, on) => {
  const b = await bootLive($, on, { blit: () => ({ deny: 'not-mounted' }) })
  const { ui, child } = await showLive($, b)
  child.say(frameLine(1))
  await b.clock.settle()
  child.say(frameLine(2)) // blit refused inside the grace period
  await b.clock.settle()
  expect(child.isClosed).toBe(false)
  await ui.unmount()
})

test('a new rev keeps the child (the page reloads the tile), a new hero restarts it, removing the last scene stops it; one child at a time', { timeoutMs: TEST_TIMEOUT_MS }, async ($, on) => {
  const b = await bootLive($, on)
  const { ui, child } = await showLive($, b)
  await mountedWithFrames($, b, child)

  await $.tool.call({ tool: SCENE_TOOL, ...stage, alt: 'Changed.' }) // rev 2: same hero, the workspace page reloads the tile itself
  await b.clock.settle()
  expect(child.isClosed).toBe(false)
  expect(b.children).toHaveLength(1)

  await $.tool.call({ tool: SCENE_TOOL, ...stage, id: 'two' }) // a new stage scene does not take the hero
  await b.clock.settle()
  expect(child.isClosed).toBe(false)
  await $.ui.press({ ...PRESS, key: 'hero:two' }) // the person picks it: the page is opened for it
  await b.clock.settle()
  expect(child.isClosed).toBe(true)
  expect(b.children).toHaveLength(2)
  expect((b.children[1] as FakeChild).argv[2]).toBe(`${b.url()}workspace/?hero=two`)
  expect(b.children.filter(c => !c.isClosed)).toHaveLength(1)

  await $.tool.call({ tool: SCENE_TOOL, remove: 'two' })
  await $.tool.call({ tool: SCENE_TOOL, remove: 'deck' })
  await b.clock.settle()
  expect(b.children.every(c => c.isClosed)).toBe(true)
  await ui.unmount()
})

test('a child that keeps dying is started at most 3 times a minute', { timeoutMs: TEST_TIMEOUT_MS }, async ($, on) => {
  const b = await bootLive($, on)
  const { ui } = await showLive($, b)
  for (let i = 0; i < CRASH_CAP; i++) {
    const child = b.children.at(-1) as FakeChild
    child.end()
    await b.clock.settle()
    await redraw($, b)
    await b.clock.settle()
  }
  expect(b.children).toHaveLength(CRASH_CAP) // the death of the third is not answered with a fourth
  await b.clock.advance(CRASH_WINDOW_MS + 1000)
  await redraw($, b)
  await b.clock.settle()
  expect(b.children).toHaveLength(CRASH_CAP + 1)
  await ui.unmount()
})

test('an error line before any frame (no Chrome) is not retried; /panel live on tries again', { timeoutMs: TEST_TIMEOUT_MS }, async ($, on) => {
  const b = await bootLive($, on)
  const { ui, child } = await showLive($, b)
  child.say({ t: 'error', error: 'no Chrome found' })
  child.end()
  await b.clock.settle()
  await redraw($, b)
  await b.clock.settle()
  expect(b.children).toHaveLength(1)
  expect((await $.command.run({ command: 'panel', args: 'live status', ...RUN })).text).toMatch(/could not start/)
  await $.command.run({ command: 'panel', args: 'live on', ...RUN })
  await b.clock.settle()
  expect(b.children).toHaveLength(2)
  await ui.unmount()
})

test('the slide buttons append key commands to the control file; nothing running: they do nothing', { timeoutMs: TEST_TIMEOUT_MS }, async ($, on) => {
  const b = await bootLive($, on)
  const { ui, child } = await showLive($, b)
  await mountedWithFrames($, b, child)
  await $.ui.press({ ...PRESS, key: 'live:next' })
  await $.ui.press({ ...PRESS, key: 'live:prev' })
  await b.clock.settle()
  expect(controlLines(b)).toEqual([
    { cmd: 'key', key: 'ArrowRight' },
    { cmd: 'key', key: 'ArrowLeft' },
  ])
  expect(controlAppends(b)[0]?.init?.stdin?.endsWith('\n')).toBe(true)
  expect(controlAppends(b)[0]?.argv.at(-1)).toBe(child.argv[child.argv.indexOf('--control') + 1])
  await ui.unmount()
})

test('an agent button press reaches the Agents tile as one host control line (open, tab, back)', { timeoutMs: TEST_TIMEOUT_MS }, async ($, on) => {
  const TILE_MARK = '/web/builtin/agents-info'
  const BOARD_MARK = '/web/builtin/board'
  const listing = (names: string[]) => names.map(name => ({ name, kind: 'file' as const, size: 1, mtimeMs: 1, isLink: false }))
  const b = await bootLive($, on, {
    texts: new Proxy({ [`${VIZ}/index.html`]: PAGE_HTML } as Record<string, string>, {
      get: (t, k) => (typeof k === 'string' && (k.includes(`${TILE_MARK}/`) || k.includes(`${BOARD_MARK}/`)) ? `// ${k.split('/').pop()}\n` : t[k as string]),
    }),
    setup: o =>
      o('fs.list', (_, e) =>
        e.path.endsWith(BOARD_MARK) ? { value: listing(['index.html', 'board.js']) } : e.path.endsWith(TILE_MARK) ? { value: listing(['index.html', 'agents-info.js']) } : { value: [] },
      ),
  })
  for (const id of ['w1', 'w2']) await $.tool.call({ tool: TOOL, lane: { id, label: id.toUpperCase(), state: 'working', pct: 10 } })
  await b.clock.advance(LEAD_MS + COOLDOWN_MS) // the board's look: the agents of the tile are known to the mod
  const { ui, child } = await showLive($, b)
  await mountedWithFrames($, b, child)
  const hosts = () => allControlLines(b).filter(l => l.cmd === 'host')
  await $.ui.press({ ...PRESS, key: agentOpenKey('w1') })
  await $.ui.press({ ...PRESS, key: agentTabKey('metrics') })
  await $.ui.press({ ...PRESS, key: AGENT_BACK_KEY })
  await b.clock.settle()
  expect(hosts()).toEqual([
    hostLine(AGENTS_INFO_SCENE_ID, HOST_OPEN, { id: 'w1' }),
    hostLine(AGENTS_INFO_SCENE_ID, HOST_TAB, { name: 'metrics' }),
    hostLine(AGENTS_INFO_SCENE_ID, HOST_CLOSE, {}),
  ].map(l => JSON.parse(l)))
  await ui.unmount()
})

test('the scroll buttons and hotkeys: presses inside the debounce are ONE control line; nothing is sent before it, or when they net out', { timeoutMs: TEST_TIMEOUT_MS }, async ($, on) => {
  const b = await bootLive($, on, { texts: { [`${VIZ}/index.html`]: PAGE_HTML } }) // a page without slides: no slide buttons, the scroll buttons instead
  const { ui, child } = await showLive($, b)
  await mountedWithFrames($, b, child)
  const scrolls = () => allControlLines(b).filter(l => l.cmd === 'scroll')
  expect(scrolls()).toEqual([]) // no key pressed, no scroll line
  await $.ui.press({ ...PRESS, key: 'scroll:down' })
  await $.ui.press({ ...PRESS, key: 'scroll:down' })
  await $.ui.press({ ...PRESS, key: 'scroll:pageup' })
  expect(scrolls()).toEqual([])
  await b.clock.advance(SCROLL_DEBOUNCE_MS + 10)
  await b.clock.settle()
  expect(scrolls()).toEqual([{ cmd: 'scroll', steps: 2, pages: -1 }])
  await $.ui.press({ ...PRESS, key: 'scroll:bottom' })
  await b.clock.advance(SCROLL_DEBOUNCE_MS + 10)
  await b.clock.settle()
  expect(scrolls().at(-1)).toEqual({ cmd: 'scroll', edge: 'bottom', steps: 0, pages: 0 })
  await $.ui.press({ ...PRESS, key: 'scroll:down' })
  await $.ui.press({ ...PRESS, key: 'scroll:up' })
  await b.clock.advance(SCROLL_DEBOUNCE_MS + 10)
  await b.clock.settle()
  expect(scrolls()).toHaveLength(2) // a down and an up cancel: nothing to send
  expect(JSON.stringify(await ui.findAll({ type: 'Button' }).then(bs => bs.map(x => x.props.hotkey)))).toContain('"k"') // the buttons carry the hotkeys
  await ui.unmount()
})

test('the page size follows the picture: opens at the start size, then ONE debounced `size` line per change of the pane\'s shape', { timeoutMs: TEST_TIMEOUT_MS }, async ($, on) => {
  const b = await bootLive($, on)
  const { ui, child } = await showLive($, b)
  const flag = (c: FakeChild, name: string): number => Number(c.argv[c.argv.indexOf(name) + 1])
  expect(flag(child, '--width')).toBe(LIVE_WIDTH) // 720, kept
  expect(flag(child, '--height')).toBe(START_VIEWPORT.height) // the pane's shape is not known before the first draw
  await mountedWithFrames($, b, child)
  const sizes = () => allControlLines(b).filter(l => l.cmd === 'size')
  const [pic] = await ui.findAll({ type: 'Image' })
  const tall = viewportFor(Number(pic?.props.columns), Number(pic?.props.rows))
  expect(tall.height).not.toBe(START_VIEWPORT.height)
  expect(sizes()).toEqual([{ cmd: 'size', w: tall.width, h: tall.height }]) // the first draw told the page its shape
  await ui.unmount()

  // A shorter pane: a different shape; a second draw inside the debounce is still ONE resize.
  const small = await $.ui.mount({ ...pane(30, PANE_COLUMNS), surface: 'terminal' })
  await b.clock.settle()
  await redraw($, b)
  expect(sizes()).toHaveLength(1) // the debounce has not passed
  await b.clock.advance(RESIZE_DEBOUNCE_MS + 10)
  const [small1] = await small.findAll({ type: 'Image' })
  const next = viewportFor(Number(small1?.props.columns), Number(small1?.props.rows))
  expect(next.height).not.toBe(tall.height)
  expect(sizes().slice(1)).toEqual([{ cmd: 'size', w: next.width, h: next.height }])
  // The first frame at the new size is not a mismatched blit: it redraws, the child lives on, the keyed Image shows it.
  child.say({ t: 'frame', n: 2, file: `${FRAMES}/live-2.png`, w: next.width, h: next.height })
  await b.clock.settle()
  expect(child.isClosed).toBe(false)
  const [live] = await small.findAll({ type: 'Image' })
  expect(live?.key).toBe(LIVE_KEY)
  expect(live?.props.source).toMatchObject({ file: `${FRAMES}/live-2.png` })
  // The same shape again sends nothing.
  await redraw($, b)
  await b.clock.advance(RESIZE_DEBOUNCE_MS + 10)
  expect(sizes()).toHaveLength(2)
  // A restart (another hero) opens at the shape the pane last had.
  await $.tool.call({ tool: SCENE_TOOL, ...stage, id: 'two' })
  await b.clock.settle() // the switcher draws the new entry
  await $.ui.press({ ...PRESS, key: 'hero:two' })
  await b.clock.settle()
  expect(b.children).toHaveLength(2)
  expect(flag(b.children[1] as FakeChild, '--height')).toBe(next.height)
  await small.unmount()
})

test('scene {id, goto} moves the live view and says so; without a live view it says `live: not running`', { timeoutMs: TEST_TIMEOUT_MS }, async ($, on) => {
  const b = await bootLive($, on)
  const before = await $.tool.call({ tool: SCENE_TOOL, id: 'deck', goto: '#/2' })
  expect(before.result).toBe('live: no scene "deck"')
  await $.tool.call({ tool: SCENE_TOOL, ...stage }) // the scene exists, but the pane has not been drawn: no child
  expect((await $.tool.call({ tool: SCENE_TOOL, id: 'deck', goto: '#/2' })).result).toBe(NOT_RUNNING)
  const { ui, child } = await showLive($, b)
  await mountedWithFrames($, b, child)
  const rev = stateOf(b).rev
  const moved = await $.tool.call({ tool: SCENE_TOOL, id: 'deck', goto: '#/2' })
  expect(moved.deny).toBeUndefined()
  expect(moved.result).toBe('live: moved to #/2')
  expect(controlLines(b).at(-1)).toEqual({ cmd: 'hash', hash: '#deck._2' }) // the workspace page reads a tile's hash as #<id>.<hash>
  expect(stateOf(b).rev).toBe(rev) // nothing in the state changed
  expect((await $.tool.call({ tool: SCENE_TOOL, id: 'other', goto: '#/2' })).result).toBe('live: no scene "other"')
  const long = await $.tool.call({ tool: SCENE_TOOL, id: 'deck', goto: `#${'a'.repeat(38)}` })
  expect(long.result).toMatch(/^live: that hash is too long for a tile/)
  const bad = await $.tool.call({ tool: SCENE_TOOL, id: 'deck', goto: 'javascript:alert(1)' })
  expect(bad.result).toBeUndefined()
  expect(bad.deny).toMatch(/goto/)
  const mixed = await $.tool.call({ tool: SCENE_TOOL, id: 'deck', goto: '#/2', alt: 'x' })
  expect(mixed.deny).toMatch(/cannot be combined with other fields/)
  await ui.unmount()
})

test('shot_at is where the scene\'s tile opens (--hash) or, in a running view, moves it; a later start does not reuse it', { timeoutMs: TEST_TIMEOUT_MS }, async ($, on) => {
  const b = await bootLive($, on)
  const { ui, child } = await showLive($, b, { ...stage, shot_at: '#/2' })
  const at = child.argv.indexOf('--hash')
  expect(child.argv[at + 1]).toBe('#deck._2')
  await mountedWithFrames($, b, child)
  // While it runs, shot_at moves the tile at once (no restart).
  await $.tool.call({ tool: SCENE_TOOL, ...stage, shot_at: '#/3' })
  await b.clock.settle()
  expect(controlLines(b).at(-1)).toEqual({ cmd: 'hash', hash: '#deck._3' })
  expect(b.children).toHaveLength(1)
  // The restart for the next hero does not reuse a hash that was meant for an earlier one.
  await $.tool.call({ tool: SCENE_TOOL, ...stage, id: 'two' })
  await b.clock.settle() // the switcher draws the new entry
  await $.ui.press({ ...PRESS, key: 'hero:two' })
  await b.clock.settle()
  expect(b.children).toHaveLength(2)
  expect(b.children[1]?.argv).not.toContain('--hash')
  await ui.unmount()
})

test('/panel live off stops the child and keeps it off; on starts it again; status says where it stands', { timeoutMs: TEST_TIMEOUT_MS }, async ($, on) => {
  const b = await bootLive($, on)
  const { ui, child } = await showLive($, b)
  await mountedWithFrames($, b, child)
  const run = async (args: string): Promise<string> => ($.command.run({ command: 'panel', args, ...RUN }).then(r => r.text ?? ''))
  expect(await run('live status')).toMatch(/^live: on, showing the workspace \(big tile "deck"\)/)
  expect(await run('live off')).toMatch(/^live: off/)
  await b.clock.settle()
  expect(child.isClosed).toBe(true)
  await redraw($, b)
  await b.clock.settle()
  expect(b.children).toHaveLength(1)
  expect(await buttons(ui)).toEqual([])
  expect(await run('live')).toMatch(/^live: off/)
  expect(await run('live maybe')).toBe('usage: /panel live on|off|status')
  await run('live on')
  await b.clock.settle()
  expect(b.children).toHaveLength(2)
  expect(await ui.findAll({ type: 'Image' })).toHaveLength(1) // the picture again
  await ui.unmount()
})
