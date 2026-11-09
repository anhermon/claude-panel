// Inline scenes and the live data channel, end to end through the engine with everything beneath the mod stood in for.
import { expect, test } from 'claude-code/testing'

import { dir, file, boot, SCENE_TOOL, STATE_FILE } from './boot'
import type { Entry } from './boot'

// TMPDIR is /tmp/t/ in the pretend world; /tmp is really /private/tmp, so a scene folder lands there.
const SCENES = '/tmp/t/claude-panel/scenes/sess-1'
const REAL = '/private/tmp/t/claude-panel/scenes/sess-1'
const GAUGE = `${SCENES}/gauge`
const GAUGE_REAL = `${REAL}/gauge`
const ALT = 'A gauge that moves.'
const PAGE = '<h1 id=n>-</h1><script>panel.data(d => n.textContent = d.cpu)</script>'
const KB = 1024

const DISK: Record<string, Entry> = {
  [GAUGE]: dir(GAUGE_REAL),
  [`${GAUGE_REAL}/index.html`]: file(),
  [`${GAUGE_REAL}/main.html`]: file(),
}
// The newest state the mod mirrored (the last write to the state file; `last()` of boot is the last write of any file).
const stateOf = (writes: { path: string; text: string }[]) =>
  JSON.parse(writes.filter(w => w.path === STATE_FILE).at(-1)?.text ?? 'null')
const publish = { id: 'gauge', html: PAGE, alt: ALT, shot: false }

test('html: written as index.html under <tmp>/claude-panel/scenes/<session>/<id>, then published like a dir', async ($, on) => {
  const { writes, url, ran } = await boot($, on, { files: DISK })
  const r = await $.tool.call({ tool: SCENE_TOOL, ...publish })
  expect(r.deny).toBeUndefined()
  expect(r.result).toBe(`scene gauge rev 1 · ${url()}s/gauge/`)
  expect(writes.find(w => w.path === `${GAUGE}/index.html`)?.text).toBe(PAGE)
  expect(stateOf(writes).scenes).toEqual([
    { id: 'gauge', dir: GAUGE_REAL, entry: 'index.html', alt: ALT, span: 3, height: 420, layout: 'card', rev: 1 },
  ])
  expect(ran.filter(a => a[0] === 'rm')).toEqual([]) // nothing there to clear

  const again = await $.tool.call({ tool: SCENE_TOOL, ...publish, html: '<p>two</p>' })
  expect(again.result).toBe(`scene gauge rev 2 · ${url()}s/gauge/`)
  expect(writes.filter(w => w.path === `${GAUGE}/index.html`).map(w => w.text)).toEqual([PAGE, '<p>two</p>'])
})

test('files: every file is written, entry may be any of them', async ($, on) => {
  const { writes } = await boot($, on, { files: DISK })
  const files = { 'main.html': '<script src="app.js"></script>', 'app.js': 'go()', 'css/s.css': 'a{}' }
  const r = await $.tool.call({ tool: SCENE_TOOL, id: 'gauge', files, entry: 'main.html', alt: ALT, shot: false })
  expect(r.deny).toBeUndefined()
  for (const [path, text] of Object.entries(files)) expect(writes.find(w => w.path === `${GAUGE}/${path}`)?.text).toBe(text)
  expect(stateOf(writes).scenes[0]).toMatchObject({ dir: GAUGE_REAL, entry: 'main.html' })
})

test('a republish replaces the folder but keeps live/', async ($, on) => {
  const { ran, writes } = await boot($, on, {
    files: DISK,
    setup: on =>
      on('fs.list', (_, e) =>
        e.path === GAUGE
          ? { value: ['index.html', 'old.js', 'live', 'pages'].map(name => ({ name, kind: 'file', size: 1, mtimeMs: 1, isLink: false })) }
          : { value: [] },
      ),
  })
  await $.tool.call({ tool: SCENE_TOOL, ...publish })
  expect(ran.filter(a => a[0] === 'rm')).toEqual([['rm', '-rf', '--', `${GAUGE}/index.html`, `${GAUGE}/old.js`, `${GAUGE}/pages`]])
  expect(ran.some(a => a.includes(`${GAUGE}/live`))).toBe(false)
  expect(writes.some(w => w.path === `${GAUGE}/index.html`)).toBe(true)
})

test('a refused inline call writes nothing and names the field', async ($, on) => {
  const { writes, ran } = await boot($, on, { files: DISK })
  const before = writes.length
  const big = 'x'.repeat(256 * KB + 1)
  const denials: [Record<string, unknown>, RegExp][] = [
    [{ ...publish, dir: '/tmp/x' }, /^scene\.dir and scene\.html cannot be combined/],
    [{ id: 'gauge', alt: ALT, shot: false }, /^scene\.dir is required: .*html or files/],
    [{ ...publish, html: big }, /^scene\.html is 262145 bytes \(256 KB\); the limit is 262144 bytes/],
    [{ id: 'gauge', alt: ALT, files: { 'index.html': 'x', '../up.html': 'y' } }, /^scene\.files\["\.\.\/up\.html"\] must not contain/],
    [{ id: 'gauge', alt: ALT, files: { 'index.html': 'x', '.hidden.txt': 'y' } }, /must not have a dotfile/],
    [{ id: 'gauge', alt: ALT, files: { 'index.html': 'x', 'a.png': 'y' } }, /cannot be sent inline/],
    [{ id: 'gauge', alt: ALT, files: { 'a.html': 'x' } }, /^scene\.entry "index\.html" is not in scene\.files/],
    [{ id: 'gauge', alt: ALT, files: { 'a.html': 'x' }, entry: 'b.html' }, /^scene\.entry "b\.html" is not in scene\.files/],
  ]
  for (const [input, pattern] of denials) {
    const r = await $.tool.call({ tool: SCENE_TOOL, ...input })
    expect(r.result).toBeUndefined()
    expect(r.deny).toMatch(pattern)
  }
  expect(writes).toHaveLength(before)
  expect(ran.filter(a => a[0] === 'rm' || a[0] === 'mv')).toEqual([])
})

const live = `${GAUGE_REAL}/live`

test('{id, data} alone: temp file then one mv; no rev, no reload, no screenshot', async ($, on) => {
  const { writes, ran } = await boot($, on, { files: DISK })
  await $.tool.call({ tool: SCENE_TOOL, ...publish })
  const rev = stateOf(writes).rev
  const mirrored = writes.length

  const r = await $.tool.call({ tool: SCENE_TOOL, id: 'gauge', data: { cpu: 87, rows: [1, 2] } })
  const text = '{"cpu":87,"rows":[1,2]}'
  expect(r.deny).toBeUndefined()
  expect(r.result).toBe(`data: written (${text.length} bytes) -> live/data.json`)
  expect(writes.slice(mirrored)).toEqual([{ path: `${live}/data.json.tmp`, text }]) // the state is not written again
  expect(ran.at(-1)).toEqual(['mv', '-f', '--', `${live}/data.json.tmp`, `${live}/data.json`])
  expect(stateOf(writes).rev).toBe(rev)
  expect(stateOf(writes).scenes[0].rev).toBe(1)
  expect(ran.some(a => a.some(x => x.includes('shot.mjs')))).toBe(false)

  await $.tool.call({ tool: SCENE_TOOL, id: 'gauge', data: 'plain' })
  expect(writes.at(-1)).toEqual({ path: `${live}/data.json.tmp`, text: '"plain"' })
})

test('{id, data}: an unknown id, null, too much data and a failed mv are refused', async ($, on) => {
  const { writes, ran } = await boot($, on, {
    files: DISK,
    onRun: argv => (argv[0] === 'mv' && argv.some(a => a.includes('/boom/')) ? { exitCode: 1, stderr: 'no space' } : undefined),
  })
  const unknown = await $.tool.call({ tool: SCENE_TOOL, id: 'ghost', data: { a: 1 } })
  expect(unknown.deny).toMatch(/^scene\.id "ghost" is not a published scene \(scenes: none\): publish it first with \{id, html, alt\}/)
  await $.tool.call({ tool: SCENE_TOOL, ...publish })
  expect((await $.tool.call({ tool: SCENE_TOOL, id: 'ghost', data: 1 })).deny).toMatch(/\(scenes: gauge\)/)

  const before = writes.length
  expect((await $.tool.call({ tool: SCENE_TOOL, id: 'gauge', data: null })).deny).toMatch(/^scene\.data must not be null/)
  const tooBig = await $.tool.call({ tool: SCENE_TOOL, id: 'gauge', data: { blob: 'x'.repeat(64 * KB) } })
  expect(tooBig.deny).toMatch(/^scene\.data is 65547 bytes as JSON; the limit is 65536: send less/)
  expect(writes).toHaveLength(before)
  expect(ran.filter(a => a[0] === 'mv')).toEqual([])
})

test('a failed mv says so and leaves data.json alone', async ($, on) => {
  const { ran } = await boot($, on, {
    files: DISK,
    onRun: argv => (argv[0] === 'mv' ? { exitCode: 1, stderr: 'no space' } : undefined),
  })
  await $.tool.call({ tool: SCENE_TOOL, ...publish })
  const r = await $.tool.call({ tool: SCENE_TOOL, id: 'gauge', data: { a: 1 } })
  expect(r.deny).toMatch(/^scene: could not write live\/data\.json \(no space\)/)
  expect(ran.at(-1)?.[0]).toBe('mv')
})

test('data with a publish seeds live/data.json before the state is mirrored (so before the screenshot)', async ($, on) => {
  const { writes, ran, url } = await boot($, on, { files: DISK })
  const r = await $.tool.call({ tool: SCENE_TOOL, ...publish, data: { cpu: 5 } })
  expect(r.result).toBe(`scene gauge rev 1 · ${url()}s/gauge/`)
  const at = (path: string): number => writes.findIndex(w => w.path === path)
  expect(at(`${live}/data.json.tmp`)).toBeGreaterThan(at(`${GAUGE}/index.html`))
  expect(at(`${live}/data.json.tmp`)).toBeLessThan(writes.length - 1) // the state mirror came after
  expect(JSON.parse(writes.at(-1)?.text ?? 'null').scenes[0].id).toBe('gauge')
  expect(ran.filter(a => a[0] === 'mv')).toEqual([['mv', '-f', '--', `${live}/data.json.tmp`, `${live}/data.json`]])
})

test('a dir scene takes data too, and goto, remove and clear stay separate modes', async ($, on) => {
  const { writes } = await boot($, on, {
    files: { ...DISK, '/tmp/viz': dir('/private/tmp/viz'), '/private/tmp/viz/index.html': file() },
  })
  await $.tool.call({ tool: SCENE_TOOL, id: 'viz', dir: '/tmp/viz', alt: ALT, shot: false })
  const r = await $.tool.call({ tool: SCENE_TOOL, id: 'viz', data: { a: 1 } })
  expect(r.result).toBe('data: written (7 bytes) -> live/data.json')
  expect(writes.at(-1)?.path).toBe('/private/tmp/viz/live/data.json.tmp')

  const goto = await $.tool.call({ tool: SCENE_TOOL, id: 'viz', goto: '#/2' })
  expect(goto.deny).toBeUndefined()
  expect(goto.result).toMatch(/^live: /)
  for (const extra of [{ goto: '#/2' }, { remove: 'viz' }, { clear: true }]) {
    const mixed = await $.tool.call({ tool: SCENE_TOOL, id: 'viz', data: {}, ...extra })
    expect(mixed.deny).toMatch(/cannot be combined/)
  }
  expect(stateOf(writes).scenes).toHaveLength(1)
  const removed = await $.tool.call({ tool: SCENE_TOOL, remove: 'viz' })
  expect(removed.result).toBe('scene viz removed; scenes: none')
})
