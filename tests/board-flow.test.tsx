// The board through the engine (everything beneath the mod stood in for, see boot.ts): the `frame` / `frame_remove` /
// `frames_clear` part of the panel tool, the result text, live/data.json (atomic, coalesced, only on change), the
// model kept across a reload, the hero rule and the switcher in the terminal pane, and the board without its source.
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { COOLDOWN_MS, LEAD_MS } from '../hooks/pulse-flush'
import { boot, buttons, dir, file, pane, paneRows, SCENE_TOOL, STATE_FILE, TOOL } from './boot'
import type { BootOptions, Entry } from './boot'
import { EXAMPLES, TYPES } from './board-examples'

const BOARD_DIR = '/tmp/t/claude-panel/board/sess-1'
const DATA_TEMP = `${BOARD_DIR}/live/.data.json.tmp`
const DATA_FILE = `${BOARD_DIR}/live/data.json`
const MODEL_TEMP = `${BOARD_DIR}/live/.board-model.json.tmp`
const MODEL_FILE = `${BOARD_DIR}/live/board-model.json`
const SOURCE_MARK = '/web/builtin/board'
const SOURCE_FILES = ['index.html', 'board.js', 'board.css']
const VIZ = '/private/tmp/viz'
const DISK: Record<string, Entry> = { '/tmp/viz': dir(VIZ), [`${VIZ}/index.html`]: file() }
const PRESS = { plugin: 'panel', requestId: 'panel', surface: 'terminal' } as const
const AGENT = 'ag-1'
const BURST = 30

type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

async function boardBoot($: Engine, on: On, opts: BootOptions = {}, hasSource = true) {
  const b = await boot($, on, {
    files: DISK,
    ...opts,
    setup: o => {
      opts.setup?.(o)
      o('fs.list', (_, e) => ({
        value: hasSource && e.path.endsWith(SOURCE_MARK) ? SOURCE_FILES.map(name => ({ name, kind: 'file' as const, size: 1, mtimeMs: 1, isLink: false })) : [],
      }))
    },
    texts: new Proxy({ ...opts.texts }, { get: (t, k) => (typeof k === 'string' && k.includes(`${SOURCE_MARK}/`) ? `// ${k.split('/').pop()}\n` : t[k as string]) }),
  })
  const dataWrites = () => b.writes.filter(w => w.path === DATA_TEMP)
  const data = (): Json => JSON.parse(dataWrites().at(-1)?.text ?? 'null') as Json
  const frameIds = (): string[] => (data()?.frames ?? []).map((f: Json) => f.id)
  const state = (): Json => JSON.parse(b.writes.filter(w => w.path === STATE_FILE).at(-1)?.text ?? 'null') as Json
  const settle = () => b.clock.advance(LEAD_MS + COOLDOWN_MS)
  const call = (input: object, extra: object = {}) => $.tool.call({ tool: TOOL, ...input, ...extra })
  return { ...b, dataWrites, data, frameIds, state, settle, call }
}

test('every frame type goes through the tool: the result names it, the board data holds it, the model is saved atomically', async ($, on) => {
  const b = await boardBoot($, on)
  for (const [i, type] of TYPES.entries()) {
    if (i >= 12) break // the model keeps twelve
    const r = await b.call({ frame: EXAMPLES[type] })
    expect(r.result).toBe(`frame ${EXAMPLES[type]!.id as string} · ${type} · ${i + 1} on board`)
  }
  await b.settle()
  expect(b.frameIds()).toEqual(TYPES.slice(0, 12).map(t => EXAMPLES[t]!.id))
  expect(b.data()).toMatchObject({ lanes: [], now: { title: '', status: 'working' } })
  expect(typeof b.data().updatedAt).toBe('number')
  expect(b.ran.some(argv => argv.join(' ') === `mv -f -- ${DATA_TEMP} ${DATA_FILE}`)).toBe(true)
  expect(b.ran.some(argv => argv.join(' ') === `mv -f -- ${MODEL_TEMP} ${MODEL_FILE}`)).toBe(true)
  expect(JSON.parse(b.writes.filter(w => w.path === MODEL_TEMP).at(-1)!.text).frames).toHaveLength(12)
})

test('the result line: `frame <id> · <type> · N on board`, with the other frames on the board, then the variety nudge when one form dominates', async ($, on) => {
  const b = await boardBoot($, on)
  for (const id of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) await b.call({ frame: { id, type: 'text', text: id } })
  const r = await b.call({ frame: { id: 'cpu-latency', type: 'line', series: [{ label: 'cpu', points: [1, 2, 3] }] } })
  const lines = String(r.result).split('\n')
  expect(lines[0]).toBe('frame cpu-latency · line · 8 on board')
  expect(lines[1]).toMatch(/^5 of your last 6 panel updates were "text"\. Choose a different form if the content allows: not used recently: /)
  expect(lines[1]).not.toMatch(/recently: .*\b(text|line)\b/)
})

test('the board works with zero model frames: the task, a pending question and lanes are frames by themselves; the pulse is not', async ($, on) => {
  const b = await boardBoot($, on, { pulse: true })
  await b.settle()
  expect(b.frameIds()).toEqual([])
  await b.call({ task: { title: 'Fix uploads', why: 'because' }, status: 'working', ask: 'Ship it?', choices: [{ id: 'y', label: 'Yes' }] })
  await b.call({ lane: { id: 't25', state: 'working', pct: 40 } })
  await b.settle()
  expect(b.frameIds()).toEqual(['ask', 'now', 'now-doing', 'lanes']) // the main loop's own row says what kind of work it does
  expect(b.data().now).toEqual({ title: 'Fix uploads', status: 'working' })
  expect(b.data().lanes.find((l: Json) => l.id === 't25')).toMatchObject({ pct: 40 }) // next to the main loop's own row
  expect(b.data().pulse).toBeDefined()
})

test('a frame mixes with other fields: the section is replaced and the frame added, one result line each', async ($, on) => {
  const b = await boardBoot($, on)
  const r = await b.call({ task: { title: 'Plan', why: 'w' }, frame: { id: 'why', type: 'text', text: 'Because' } })
  expect(r.result).toContain('frame why · text · 2 on board') // the task's own `now` frame and the model's
  expect(b.state().task).toMatchObject({ title: 'Plan' })
  await b.settle()
  expect(b.frameIds()).toEqual(['why', 'now'])
})

test('a worker\'s frame is upsert-only: no panel section changes, the result is the frame line alone', async ($, on) => {
  const b = await boardBoot($, on)
  await b.call({ task: { title: 'Keep me', why: 'w' } })
  const before = b.writes.filter(w => w.path === STATE_FILE).length
  const r = await b.call({ frame: { id: 'agent-note', type: 'text', text: 'from a worker' } }, { agentId: AGENT })
  expect(r.result).toBe('frame agent-note · text · 2 on board')
  expect(b.writes.filter(w => w.path === STATE_FILE).length).toBe(before)
  expect(b.state().task).toMatchObject({ title: 'Keep me' })
  await b.settle()
  expect(b.frameIds()).toContain('agent-note')
})

test('refusals name the field and change nothing: a bad frame, a bad remove, a full board', async ($, on) => {
  const b = await boardBoot($, on)
  await b.call({ frame: { id: 'one', type: 'text', text: 'x' } })
  await b.settle()
  const written = b.dataWrites().length
  const long = await b.call({ frame: { id: 'two', type: 'text', text: 'x'.repeat(91) } })
  expect(long.deny).toMatch(/^panel: frame\.text is 91 characters; the limit is 90/)
  const unknown = await b.call({ frame: { id: 'two', type: 'text', text: 'x', colour: 'red' } })
  expect(unknown.deny).toMatch(/frame\.colour is not a known field of a "text" frame/)
  const edge = await b.call({ frame: { id: 'g', type: 'diagram', nodes: [{ id: 'a', label: 'A' }], edges: [{ from: 'a', to: 'zz' }] } })
  expect(edge.deny).toMatch(/frame\.edges\[0\]\.to "zz" is not a node/)
  const mixed = await b.call({ task: { title: 'Must not land', why: 'w' }, frame: { id: 'two', type: 'nope' } })
  expect(mixed.deny).toMatch(/frame\.type "nope"/)
  expect(b.state()?.task?.title).not.toBe('Must not land')
  expect((await b.call({ frame_remove: 'Bad Id' })).deny).toMatch(/frame_remove "Bad Id" is invalid/)
  for (let i = 0; i < 11; i++) await b.call({ frame: { id: `f${i}`, type: 'text', text: 'x' } })
  const full = await b.call({ frame: { id: 'extra', type: 'text', text: 'x' } })
  expect(full.deny).toMatch(/already 12 frames \(one, f0.*f10\): remove one with frame_remove before adding "extra"/)
  await b.settle()
  expect(b.frameIds()).toHaveLength(12)
  expect(b.dataWrites().length).toBeGreaterThan(written)
})

test('frame_remove and frames_clear: results, auto frames remembered as removed, frames_clear brings them back', async ($, on) => {
  const b = await boardBoot($, on, { pulse: true })
  await b.call({ frame: { id: 'a', type: 'text', text: 'x' } })
  await b.call({ task: { title: 'T', why: 'w' } })
  expect((await b.call({ frame_remove: 'a' })).result).toBe('frame a removed · 1 on board') // the `now` frame is still there
  expect((await b.call({ frame_remove: 'a' })).result).toBe('no frame "a" to remove; frames: none · 1 on board')
  expect((await b.call({ frame_remove: 'now' })).result).toBe('frame now removed (auto; frames_clear brings it back) · 0 on board')
  await b.settle()
  expect(b.frameIds()).toEqual([])
  await b.call({ frame: { id: 'b', type: 'text', text: 'x' } })
  expect((await b.call({ frames_clear: true })).result).toBe('frames cleared (1 removed) · 1 on board')
  await b.settle()
  expect(b.frameIds()).toEqual(['now'])
  expect((await b.call({ frame_remove: ['now', 'nope'] })).result).toBe('frame now removed (auto; frames_clear brings it back) · 0 on board\nno frame "nope" to remove; frames: none · 0 on board')
})

test('data.json follows removals and a clear: a removed or cleared frame leaves the file, a repost brings only the new ones', async ($, on) => {
  const b = await boardBoot($, on)
  for (const id of ['a', 'b', 'c']) await b.call({ frame: { id, type: 'text', text: id } })
  await b.settle()
  expect(b.frameIds()).toEqual(['a', 'b', 'c'])
  await b.call({ frame_remove: 'b' })
  await b.settle()
  expect(b.frameIds()).toEqual(['a', 'c'])
  await b.call({ frames_clear: true })
  await b.settle()
  expect(b.frameIds()).toEqual([]) // the file is written even when it ends up with no frames
  await b.call({ frame: { id: 'x', type: 'text', text: 'x' } })
  await b.settle()
  expect(b.frameIds()).toEqual(['x'])
})

test('writes are coalesced and only on change: a burst is one write, the same content is none, a steady stream is two a second at most', async ($, on) => {
  const b = await boardBoot($, on)
  await b.settle()
  const start = b.dataWrites().length
  for (let i = 0; i < BURST; i++) await b.call({ frame: { id: 'm', type: 'metric', value: i, label: 'n' } })
  await b.settle()
  expect(b.dataWrites().length - start).toBe(1)
  expect(b.data().frames[0]).toMatchObject({ id: 'm', value: BURST - 1 })
  const settled = b.dataWrites().length
  await b.call({ frame: { id: 'm', type: 'metric', value: BURST - 1, label: 'n' } }) // identical
  await b.settle()
  expect(b.dataWrites().length).toBe(settled)
  for (let i = 0; i < 6; i++) {
    await b.call({ frame: { id: 'm', type: 'metric', value: 1000 + i, label: 'n' } })
    await b.clock.advance(200)
  }
  await b.settle()
  expect(b.dataWrites().length - settled).toBeLessThanOrEqual(3) // 1.2 s of calls: at most two a second
})

test('a reload of the mod keeps the model (and what the person removed); a corrupt sidecar is an empty board', async ($, on) => {
  const model = { frames: [{ id: 'kept', type: 'text', text: 'still here' }, { id: 'Bad Id', type: 'text', text: 'dropped' }], removedAuto: ['lanes'] }
  const b = await boardBoot($, on, { texts: { [MODEL_FILE]: JSON.stringify(model) } })
  await b.settle()
  expect(b.frameIds()).toEqual(['kept'])
  await b.call({ lane: { id: 't', state: 'working' } })
  await b.settle()
  expect(b.frameIds()).toEqual(['kept']) // the lanes frame stays removed
  expect((await b.call({ frames_clear: true })).result).toBe('frames cleared (1 removed) · 1 on board')
})

test('a corrupt model file is an empty board, not an error', async ($, on) => {
  const b = await boardBoot($, on, { texts: { [MODEL_FILE]: '{not json' } })
  await b.settle()
  expect(b.frameIds()).toEqual([])
  expect((await b.call({ frame: { id: 'a', type: 'text', text: 'x' } })).result).toBe('frame a · text · 1 on board')
})

test('the scene files are copied, the board is the first scene, and live/ is not part of the copy', async ($, on) => {
  const b = await boardBoot($, on)
  const copied = b.writes.filter(w => w.path.startsWith(`${BOARD_DIR}/`) && !w.path.includes('/live/')).map(w => w.path.replace(`${BOARD_DIR}/`, ''))
  expect(copied.sort()).toEqual(['board.css', 'board.js', 'index.html'])
  expect(b.state().scenes[0]).toMatchObject({ id: 'board', builtin: true, pin: true, layout: 'stage', dir: BOARD_DIR })
})

test('a second start with the same files copies nothing', async ($, on) => {
  const b = await boardBoot($, on, { texts: Object.fromEntries(SOURCE_FILES.map(n => [`${BOARD_DIR}/${n}`, `// ${n}\n`])) })
  expect(b.writes.filter(w => w.path.startsWith(`${BOARD_DIR}/`) && !w.path.includes('/live/'))).toEqual([])
})

test('without web/builtin/board nothing is registered or written, and a frame call still answers (the model lives in memory)', async ($, on) => {
  const b = await boardBoot($, on, {}, false)
  expect(b.writes.some(w => w.path.startsWith(BOARD_DIR))).toBe(false)
  expect(b.last().scenes ?? []).toEqual([])
  const r = await b.call({ frame: { id: 'a', type: 'text', text: 'x' } })
  expect(r.result).toBe('frame a · text · 1 on board')
  expect(b.writes.some(w => w.path.startsWith(BOARD_DIR))).toBe(false)
})

test('the hero is the board; a stage scene of the model\'s gets a switcher entry but does not take over, a pick does, and removing it hands the pane back', async ($, on) => {
  const b = await boardBoot($, on)
  const ui = await $.ui.mount({ ...pane(60, 45), surface: 'terminal' })
  await b.clock.settle()
  const keys = async () => (await buttons(ui)).map(x => x.key).filter(k => k?.startsWith('hero:'))
  expect(await keys()).toEqual([]) // the board alone: no switcher
  await $.tool.call({ tool: SCENE_TOOL, id: 'viz', dir: '/tmp/viz', alt: 'A visual.', layout: 'stage', shot: false })
  await b.clock.settle()
  expect(await keys()).toEqual(['hero:board', 'hero:viz'])
  expect((await buttons(ui)).find(x => x.key === 'hero:viz')?.label).toBe('viz') // publishing does not make it the hero
  expect((await buttons(ui)).find(x => x.key === 'hero:board')?.label).toBe('▸ board')
  expect((await paneRows(ui)).join('\n')).toMatch(/\[ ▸ board \] \[ viz \]/)
  await $.ui.press({ ...PRESS, key: 'hero:viz' }) // the person picks it
  await b.clock.settle()
  expect((await buttons(ui)).find(x => x.key === 'hero:viz')?.label).toBe('▸ viz')
  await $.ui.press({ ...PRESS, key: 'hero:board' })
  await b.clock.settle()
  expect((await buttons(ui)).find(x => x.key === 'hero:board')?.label).toBe('▸ board')
  await $.tool.call({ tool: SCENE_TOOL, remove: 'viz' })
  await b.clock.settle()
  expect(await keys()).toEqual([])
  await ui.unmount()
})

test('publishing a second stage scene keeps the hero where it was', async ($, on) => {
  const b = await boardBoot($, on)
  const ui = await $.ui.mount({ ...pane(60, 45), surface: 'terminal' })
  for (const id of ['viz', 'viz2']) await $.tool.call({ tool: SCENE_TOOL, id, dir: '/tmp/viz', alt: 'A visual.', layout: 'stage', shot: false })
  await b.clock.settle()
  const labels = async () => (await buttons(ui)).filter(x => x.key?.startsWith('hero:')).map(x => x.label)
  expect(await labels()).toEqual(['▸ board', 'viz', 'viz2'])
  await ui.unmount()
})

test('a card scene never takes the hero from the board and gets no switcher entry beside it', async ($, on) => {
  const b = await boardBoot($, on)
  const ui = await $.ui.mount({ ...pane(60, 45), surface: 'terminal' })
  await $.tool.call({ tool: SCENE_TOOL, id: 'note', dir: '/tmp/viz', alt: 'A card.', shot: false })
  await b.clock.settle()
  const rows = (await paneRows(ui)).join('\n')
  expect(rows).not.toMatch(/\[ ▸ board \]/)
  await ui.unmount()
})
