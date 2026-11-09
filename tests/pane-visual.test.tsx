// The visual pane through the engine: the mode (terminal with a scene vs everything else), the single hero Image,
// the ask box, the scene switcher and the live view following the hero.
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { boot, buttons, dir, file, pane, paneRows, SCENE_TOOL, seen, TOOL } from './boot'
import type { BootOptions, FakeChild } from './boot'
import { pngHeader } from './png-header'

const TEST_TIMEOUT_MS = 60_000
const VIZ = '/private/tmp/viz'
const NARROW = 40
const WIDE = 45
const PRESS = { plugin: 'panel', requestId: 'panel', surface: 'terminal' } as const
const FRAMES = '/tmp/t/claude-panel/live/sess-1/frames'
const FRAME = { w: 960, h: 540 }
const DISK = {
  '/tmp/viz': dir(VIZ),
  [`${VIZ}/index.html`]: file(),
  [`${VIZ}/face.png`]: file(900, pngHeader(960, 540)),
}
const DECK_HTML = `<main>${['Problem', 'Backoff', 'Jitter', 'Numbers'].map(t => `<section data-title="${t}"></section>`).join('')}</main>`
const stage = { id: 'deck', dir: '/tmp/viz', alt: 'The deck.', layout: 'stage', title: 'Backoff', shot: false, term: { image: `${VIZ}/face.png` } }
const mission = { ...stage, id: 'mission', alt: 'Mission control.', title: 'Mission control' }
const frame = (n: number) => ({ t: 'frame', n, file: `${FRAMES}/live-${n % 3}.png`, ...FRAME })

type Booted = Awaited<ReturnType<typeof boot>>

const bootVisual = ($: Engine, on: On, opts: BootOptions = {}): Promise<Booted> =>
  boot($, on, { files: DISK, texts: { [`${VIZ}/index.html`]: DECK_HTML }, ...opts })

const publish = async ($: Engine, ...scenes: object[]): Promise<void> => {
  for (const scene of scenes) await $.tool.call({ tool: SCENE_TOOL, ...scene })
}
const mountTerminal = async ($: Engine, b: Booted, columns = WIDE) => {
  const ui = await $.ui.mount({ ...pane(60, columns), surface: 'terminal' })
  await b.clock.settle()
  return ui
}
const pictureAlts = async (ui: Awaited<ReturnType<typeof mountTerminal>>) =>
  (await ui.findAll({ type: 'Image' })).map(i => String(i.props.alt))

test('a terminal with a scene is visual: ONE picture, the switcher row and the footer, and no text sections at all', { timeoutMs: TEST_TIMEOUT_MS }, async ($, on) => {
  const b = await bootVisual($, on, { isServerDown: true })
  await $.tool.call({ tool: TOOL, task: { title: 'Fix uploads', why: 'WHY-TEXT' }, context: ['CONTEXT-FACT'] })
  await publish($, mission, stage)
  const ui = await mountTerminal($, b)
  await $.ui.press({ ...PRESS, key: 'hero:deck' }) // publishing picks nothing (the first candidate is the hero); the person picks the deck
  await b.clock.settle()
  expect(await pictureAlts(ui)).toEqual(['The deck.'])
  const rows = await paneRows(ui)
  expect(rows).toContain('[ mission ] [ ▸ deck ]')
  expect(rows.join('\n')).not.toMatch(/working|Fix uploads|WHY-TEXT|CONTEXT-FACT|▣|details|1 Problem/)
  expect(await buttons(ui)).toEqual([
    { key: 'hero:mission', label: 'mission' },
    { key: 'hero:deck', label: '▸ deck' },
  ])
  await ui.unmount()
})

test('a pending ask keeps its box and answer buttons in the visual pane', { timeoutMs: TEST_TIMEOUT_MS }, async ($, on) => {
  const b = await bootVisual($, on, { isServerDown: true })
  await publish($, stage)
  await $.tool.call({ tool: TOOL, ask: 'Which fix?', choices: [{ id: 'both', label: 'Both fixes' }, { id: 'one', label: 'Only one' }] })
  const ui = await mountTerminal($, b)
  await seen(ui, /Claude needs you/)
  await seen(ui, /Which fix\?/)
  expect((await buttons(ui)).filter(x => x.key?.startsWith('answer:'))).toEqual([
    { key: 'answer:both', label: 'Both fixes' },
    { key: 'answer:one', label: 'Only one' },
  ])
  expect(await ui.findAll({ type: 'Image' })).toHaveLength(1)
  await ui.unmount()
})

test('elsewhere the text layout stays: a desktop surface, and a terminal state without a scene', { timeoutMs: TEST_TIMEOUT_MS }, async ($, on) => {
  const b = await bootVisual($, on, { isServerDown: true })
  await $.tool.call({ tool: TOOL, task: { title: 'Fix uploads', why: 'WHY-TEXT' }, context: ['CONTEXT-FACT'] })
  const bare = await mountTerminal($, b)
  expect((await paneRows(bare)).join('\n')).toMatch(/WHY-TEXT[\s\S]*CONTEXT-FACT/)
  expect(await buttons(bare)).toEqual([])
  await bare.unmount()
  await publish($, stage)
  const desktop = await $.ui.mount({ ...pane(60, WIDE), surface: 'desktop' })
  expect(await desktop.findAll({ type: 'Image' })).toHaveLength(0)
  expect((await paneRows(desktop)).join('\n')).toMatch(/▣ Backoff[\s\S]*WHY-TEXT|WHY-TEXT[\s\S]*▣ Backoff/)
  await desktop.unmount()
})

test('width 40: no row is wider than the pane, the picture included', { timeoutMs: TEST_TIMEOUT_MS }, async ($, on) => {
  const b = await bootVisual($, on, { isServerDown: true })
  await $.tool.call({ tool: TOOL, task: { title: 'A very long task title that cannot possibly fit', why: 'w' }, ask: 'Which?', choices: [{ id: 'a', label: 'A long answer label here' }] })
  await publish($, stage, mission, { ...stage, id: 'a-third-scene-with-a-long-id' })
  const ui = await mountTerminal($, b, NARROW)
  const rows = await paneRows(ui)
  expect(rows.every(r => Array.from(r).length <= NARROW)).toBe(true)
  const [image] = await ui.findAll({ type: 'Image' })
  expect(Number(image?.props.columns)).toBeLessThanOrEqual(NARROW)
  expect(await ui.findAll({ type: 'Image' })).toHaveLength(1)
  await ui.unmount()
})

test('the switcher picks the hero: another picture, and the live view stops the old child and starts the new one', { timeoutMs: TEST_TIMEOUT_MS }, async ($, on) => {
  const b = await bootVisual($, on)
  await publish($, mission, stage)
  const ui = await mountTerminal($, b)
  await $.ui.press({ ...PRESS, key: 'hero:deck' }) // the person picks the deck (publishing does not)
  await b.clock.settle()
  expect(b.children.filter(c => !c.isClosed)).toHaveLength(1)
  const first = b.children.at(-1) as FakeChild
  expect(first.argv[2]).toBe(`${b.url()}workspace/?hero=deck`)
  first.say({ t: 'ready' })
  first.say(frame(1))
  await b.clock.settle()
  expect((await buttons(ui)).map(x => x.key)).toContain('live:next')

  await $.ui.press({ ...PRESS, key: 'hero:mission' })
  await b.clock.settle()
  expect(first.isClosed).toBe(true)
  expect(b.children).toHaveLength(3) // the board-less default (mission), then deck, then mission again
  const second = b.children[2] as FakeChild
  expect(second.argv[2]).toBe(`${b.url()}workspace/?hero=mission`)
  expect(await pictureAlts(ui)).toEqual(['Mission control.'])
  expect((await buttons(ui)).filter(x => x.key?.startsWith('hero:')).map(x => x.label)).toEqual(['▸ mission', 'deck'])
  // The old scene's frame is not drawn under the new hero; the new child's first frame is.
  expect((await ui.findAll({ type: 'Image' }))[0]?.key).toBeUndefined()
  second.say(frame(2))
  await b.clock.settle()
  const [live] = await ui.findAll({ type: 'Image' })
  expect(live?.key).toBe('live')
  expect(live?.props.source).toMatchObject({ file: `${FRAMES}/live-2.png` })

  // Back again: one child at a time, and a switch is not a crash (no cap is used up).
  await $.ui.press({ ...PRESS, key: 'hero:deck' })
  await b.clock.settle()
  await $.ui.press({ ...PRESS, key: 'hero:mission' })
  await b.clock.settle()
  await $.ui.press({ ...PRESS, key: 'hero:deck' })
  await b.clock.settle()
  expect(b.children).toHaveLength(6)
  expect(b.children.filter(c => !c.isClosed)).toHaveLength(1)
  expect(b.children.at(-1)?.argv[2]).toBe(`${b.url()}workspace/?hero=deck`)
  await ui.unmount()
})

test('a hero without a live view (a card with a face) stops the child and shows its picture', { timeoutMs: TEST_TIMEOUT_MS }, async ($, on) => {
  const b = await bootVisual($, on)
  await publish($, stage, { ...stage, id: 'shot', layout: 'card', alt: 'A still.' })
  const ui = await mountTerminal($, b)
  expect(b.children).toHaveLength(1)
  await $.ui.press({ ...PRESS, key: 'hero:shot' })
  await b.clock.settle()
  expect(b.children[0]?.isClosed).toBe(true)
  expect(b.children).toHaveLength(1)
  expect(await pictureAlts(ui)).toEqual(['A still.'])
  expect((await buttons(ui)).map(x => x.key)).not.toContain('live:next')
  await ui.unmount()
})
