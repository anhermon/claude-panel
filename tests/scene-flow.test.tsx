// The scene tool, `/panel open <id>` and the scenes' terminal faces, end to end
// through the engine with everything beneath the mod stood in for (see boot.ts).
import { expect, test } from 'claude-code/testing'

import { dir, file, boot, pane, paneRows, RUN, SCENE_TOOL, seen, TOOL } from './boot'
import type { Entry } from './boot'
import { pngHeader } from './png-header'

const TEST_TIMEOUT_MS = 60_000
const VIZ = '/private/tmp/viz'
const FACE_COLUMNS = 40
const FACE_ROWS = 10 // a 200x100 picture at 40 columns

// A scene folder under /tmp (really /private/tmp), a picture in it, and a folder outside every root.
const DISK: Record<string, Entry> = {
  '/tmp/viz': dir('/private/tmp/viz'),
  [`${VIZ}/index.html`]: file(),
  [`${VIZ}/face.png`]: file(900, pngHeader(200, 100)),
  [`${VIZ}/not-a-png.png`]: file(901, btoa('this is text, not a picture at all')),
  [`${VIZ}/unreadable.png`]: file(902),
  '/etc/x': dir(),
}

const viz = { id: 'viz', dir: '/tmp/viz', alt: 'A visual that moves.', shot: false }

test('the scene tool publishes, replaces in place, removes and clears', async ($, on) => {
  const { opened, last, url } = await boot($, on, { files: DISK })

  const first = await $.tool.call({ tool: SCENE_TOOL, ...viz })
  expect(first.deny).toBeUndefined()
  expect(first.result).toBe(`scene viz rev 1 · ${url()}s/viz/`)
  expect(last().scenes).toEqual([
    { id: 'viz', dir: VIZ, entry: 'index.html', alt: viz.alt, span: 3, height: 420, layout: 'card', rev: 1 },
  ])
  expect(opened).toEqual(['panel'])

  await $.tool.call({ tool: SCENE_TOOL, id: 'two', dir: '/tmp/viz', alt: 'Another.', title: 'Two', span: 1 })
  const again = await $.tool.call({ tool: SCENE_TOOL, ...viz, alt: 'Changed.', height: 300 })
  expect(again.result).toContain(`scene viz rev 2 · ${url()}s/viz/`)
  expect(last().scenes.map((s: { id: string }) => s.id)).toEqual(['viz', 'two'])
  expect(last().scenes[0].alt).toBe('Changed.')
  expect(last().scenes[0].height).toBe(300)
  expect(opened).toEqual(['panel'])

  const rev = last().rev
  expect((await $.tool.call({ tool: SCENE_TOOL, remove: 'two' })).result).toBe('scene two removed; scenes: viz')
  expect(last().rev).toBe(rev + 1)
  expect((await $.tool.call({ tool: SCENE_TOOL, clear: true })).result).toBe('scenes cleared (1 removed)')
  expect(last().scenes).toEqual([])
})

test('a refused scene names the field, says how to fix it and changes nothing', async ($, on) => {
  const { writes, last } = await boot($, on, { files: DISK })
  const before = writes.length
  const denials: [Record<string, unknown>, RegExp][] = [
    [{ ...viz, alt: undefined }, /^scene\.alt is required: one plain sentence/],
    [{ ...viz, id: 'Bad Id' }, /^scene\.id "Bad Id" is invalid: use 1-24 characters/],
    [{ ...viz, dir: 'relative/dir' }, /^scene\.dir "relative\/dir" must be an absolute path/],
    [{ ...viz, dir: '/etc/x' }, /^scene\.dir "\/etc\/x" is outside the allowed folders .*put the scene folder under the project/],
    [{ ...viz, dir: '/tmp/missing' }, /^scene\.dir "\/tmp\/missing" does not exist: create the folder/],
    [{ ...viz, entry: 'gone.html' }, /^scene\.entry "gone\.html" was not found as a file/],
    [{ ...viz, entry: '../index.html' }, /^scene\.entry .* must not contain "\.\." segments/],
    [{ ...viz, term: { image: '/tmp/viz/none.png' } }, /^scene\.term\.image .* was not found as a file/],
    [{ ...viz, nonsense: 1 }, /^scene\.nonsense is not a known field/],
    [{ remove: 'viz', alt: 'x' }, /^scene\.remove cannot be combined with other fields/],
  ]
  for (const [input, pattern] of denials) {
    const r = await $.tool.call({ tool: SCENE_TOOL, ...input })
    expect(r.result).toBeUndefined()
    expect(r.deny).toMatch(pattern)
  }
  expect(writes).toHaveLength(before)
  expect(last().scenes).toEqual([])
})

test('at most 6 scenes: the seventh is refused with how to make room', async ($, on) => {
  const { last } = await boot($, on, { files: DISK })
  for (let i = 0; i < 6; i++) await $.tool.call({ tool: SCENE_TOOL, ...viz, id: `s${i}` })
  expect(last().scenes).toHaveLength(6)
  const seventh = await $.tool.call({ tool: SCENE_TOOL, ...viz, id: 'one-too-many' })
  expect(seventh.deny).toMatch(/^scene: already 6 scenes \(s0, s1, s2, s3, s4, s5\): remove one with \{"remove":"<id>"\}/)
  expect(last().scenes).toHaveLength(6)
  const swapped = await $.tool.call({ tool: SCENE_TOOL, ...viz, id: 's2', alt: 'Replaced.' })
  expect(swapped.deny).toBeUndefined()
  expect(last().scenes).toHaveLength(6)
})

test('the panel tool leaves the scenes alone: `clear` keeps them, `scenes` is not a field', async ($, on) => {
  const { last } = await boot($, on, { files: DISK })
  await $.tool.call({ tool: SCENE_TOOL, ...viz })
  await $.tool.call({ tool: TOOL, task: { title: 'T', why: 'W' } })
  await $.tool.call({ tool: TOOL, clear: true })
  expect(last().task).toBeNull()
  expect(last().scenes).toHaveLength(1)
  const sneaky = await $.tool.call({ tool: TOOL, scenes: [] })
  expect(sneaky.deny).toBeDefined()
  expect(last().scenes).toHaveLength(1)
})

test('/panel open <id> opens that scene; an unknown id answers plainly and opens nothing', async ($, on) => {
  const { ran, url } = await boot($, on, { files: DISK, run: { uname: 'Darwin\n' } })
  await $.tool.call({ tool: SCENE_TOOL, ...viz })

  const one = await $.command.run({ command: 'panel', args: 'open viz', ...RUN })
  expect(one.text).toBe(`${url()}s/viz/`)
  expect(ran).toContainEqual(['open', `${url()}s/viz/`])

  const whole = await $.command.run({ command: 'panel', args: 'open', ...RUN })
  expect(whole.text).toBe(url())
  expect(ran).toContainEqual(['open', url()])

  const opens = ran.filter(argv => argv[0] === 'open').length
  const none = await $.command.run({ command: 'panel', args: 'open nope', ...RUN })
  expect(none.text).toBe('No scene "nope" (scenes: viz).')
  expect(ran.filter(argv => argv[0] === 'open')).toHaveLength(opens)

  const plain = await $.command.run({ command: 'panel', args: '', ...RUN })
  expect(plain.text).toBe(url())
})

test('with the web server down, /panel open <id> says so', async ($, on) => {
  const { ran } = await boot($, on, { files: DISK, isServerDown: true })
  await $.tool.call({ tool: SCENE_TOOL, ...viz })
  const r = await $.command.run({ command: 'panel', args: 'open viz', ...RUN })
  expect(r.text).toMatch(/browser view is not running yet, so scene "viz" cannot be opened/)
  expect(ran.some(argv => argv[0] === 'open' || argv[0] === 'xdg-open')).toBe(false)
})

// --- the pane: a scene's face ------------------------------------------------------------

const faceOf = (image: string) => ({ ...viz, title: 'Shot', term: { art: ['ART LINE'], image } })

test('terminal: a readable PNG is drawn with the Image element, sized by its aspect', { timeoutMs: TEST_TIMEOUT_MS }, async ($, on) => {
  await boot($, on, { files: DISK })
  await $.tool.call({ tool: SCENE_TOOL, ...faceOf(`${VIZ}/face.png`) })
  const ui = await $.ui.mount({ ...pane(60, FACE_COLUMNS), surface: 'terminal' })
  // A scene with a face is the hero of the visual pane: the picture is the pane (no header line), its title is not drawn.
  await seen(ui, /^rev \d+/)
  expect(await ui.find({ type: 'Text', text: /^● working$/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /▣ Shot/ })).toBeUndefined()
  const pictures = await ui.findAll({ type: 'Image' })
  expect(pictures).toHaveLength(1)
  expect(pictures[0]?.props).toMatchObject({ columns: FACE_COLUMNS, rows: FACE_ROWS, alt: viz.alt })
  expect(await ui.find({ type: 'Text', text: /ART LINE/ })).toBeUndefined()
  await ui.unmount()
})

test('terminal: a PNG that cannot be read or is not a PNG falls back to the art', { timeoutMs: TEST_TIMEOUT_MS }, async ($, on) => {
  await boot($, on, { files: DISK })
  for (const bad of ['not-a-png.png', 'unreadable.png']) {
    await $.tool.call({ tool: SCENE_TOOL, ...faceOf(`${VIZ}/${bad}`) })
    const ui = await $.ui.mount({ ...pane(60, FACE_COLUMNS), surface: 'terminal' })
    await seen(ui, /^ART LINE$/)
    expect(await ui.findAll({ type: 'Image' }), bad).toHaveLength(0)
    await ui.unmount()
  }
})

test('desktop: no Image element exists, the scene keeps its art, or its alt text', { timeoutMs: TEST_TIMEOUT_MS }, async ($, on) => {
  await boot($, on, { files: DISK })
  await $.tool.call({ tool: SCENE_TOOL, ...faceOf(`${VIZ}/face.png`) })
  const withArt = await $.ui.mount({ ...pane(60, FACE_COLUMNS), surface: 'desktop' })
  await seen(withArt, /^ART LINE$/)
  expect(await withArt.findAll({ type: 'Image' })).toHaveLength(0)
  await withArt.unmount()

  await $.tool.call({ tool: SCENE_TOOL, ...viz, title: 'Shot' })
  const altOnly = await $.ui.mount({ ...pane(60, FACE_COLUMNS), surface: 'desktop' })
  await seen(altOnly, /A visual that/)
  expect((await paneRows(altOnly)).every(r => Array.from(r).length <= FACE_COLUMNS)).toBe(true)
  await altOnly.unmount()
})
