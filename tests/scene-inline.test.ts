// Inline scenes (html / files) and the live data channel: the pure rules, and prepareScene against a table of paths.
import { expect, test } from 'claude-code/testing'

import { Invalid } from '../hooks/blocks/common'
import { parseSceneInput } from '../hooks/scene'
import type { SceneAction } from '../hooks/scene'
import { inlineScenesDir, prepareScene } from '../hooks/scene-fs'
import type { PathInfo, SceneFs, SceneIo } from '../hooks/scene-fs'
import { dataText, INLINE_CAPS, LIVE_DATA_PATH, utf8Bytes } from '../hooks/scene-inline'
import { SCENE_INPUT_SCHEMA, SCENE_TOOL_DESCRIPTION } from '../hooks/spec'

const ALT = 'A gauge.'
const HTML = { id: 'gauge', html: '<h1>hi</h1>', alt: ALT }
const KB = 1024

function denial(input: unknown): string {
  try {
    parseSceneInput(input)
    return 'ok'
  } catch (err) {
    if (err instanceof Invalid) return err.message
    throw err
  }
}

const upsert = (input: unknown): Extract<SceneAction, { kind: 'upsert' }> => {
  const a = parseSceneInput(input)
  if (a.kind !== 'upsert') throw new Error(`expected an upsert, got ${a.kind}`)
  return a
}

test('html: a page or fragment becomes index.html; dir is empty until the mod has written it', () => {
  const a = upsert(HTML)
  expect(a.inline).toEqual({ files: { 'index.html': '<h1>hi</h1>' }, entry: 'index.html' })
  expect(a.scene).toMatchObject({ id: 'gauge', dir: '', entry: 'index.html', alt: ALT, layout: 'card' })
  expect(a.data).toBeUndefined()
})

test('files: relative text files, entry defaults to index.html or names one of them', () => {
  const files = { 'index.html': '<script src="app.js"></script>', 'app.js': 'x()', 'css/s.css': 'a{}', 'd.JSON': '{}' }
  expect(upsert({ id: 'g', files, alt: ALT }).inline).toEqual({ files, entry: 'index.html' })
  const two = upsert({ id: 'g', files: { 'main.html': '<p>', 'a.svg': '<svg/>' }, entry: 'main.html', alt: ALT })
  expect(two.inline?.entry).toBe('main.html')
  expect(two.scene.entry).toBe('main.html')
})

test('exactly one of dir, html, files; none or several are refused naming the fix', () => {
  expect(denial({ id: 'g', alt: ALT })).toMatch(/^scene\.dir is required: .*send html or files instead; fastest is \{id, html, alt\}/)
  expect(denial({ ...HTML, dir: '/tmp/x' })).toMatch(/^scene\.dir and scene\.html cannot be combined: send exactly one of dir, html or files/)
  expect(denial({ ...HTML, files: { 'index.html': 'x' } })).toMatch(/^scene\.html and scene\.files cannot be combined/)
  expect(denial({ id: 'g', alt: ALT, dir: '/tmp/x', files: { 'index.html': 'x' } })).toMatch(/^scene\.dir and scene\.files cannot be combined/)
  expect(denial({ ...HTML, entry: 'x.html' })).toMatch(/^scene\.entry goes with files, not html/)
  expect(denial({ ...HTML, alt: undefined })).toMatch(/^scene\.alt is required/)
})

const BAD_FILES: [string, unknown, RegExp][] = [
  ['not an object', 'index.html', /^scene\.files must be an object/],
  ['empty', {}, /^scene\.files is empty/],
  ['parent segment', { 'index.html': 'x', '../x.html': 'y' }, /^scene\.files\["\.\.\/x\.html"\] must not contain "\.\." segments/],
  ['nested parent', { 'index.html': 'x', 'a/../b.html': 'y' }, /must not contain "\.\." segments/],
  ['absolute', { '/etc/x.html': 'y', 'index.html': 'x' }, /^scene\.files\["\/etc\/x\.html"\] must not start with "\/"/],
  ['dotfile', { 'index.html': 'x', '.env.txt': 'y' }, /must not have a dotfile, "\.\/" or empty segment/],
  ['dot folder', { 'index.html': 'x', '.git/a.txt': 'y' }, /must not have a dotfile/],
  ['empty segment', { 'index.html': 'x', 'a//b.txt': 'y' }, /must not have a dotfile, "\.\/" or empty segment/],
  ['backslash', { 'index.html': 'x', 'a\\b.txt': 'y' }, /must use "\/" separators/],
  ['png', { 'index.html': 'x', 'a.png': 'y' }, /^scene\.files\["a\.png"\] has an extension that cannot be sent inline \(allowed: html, css, js, mjs, json, svg, txt\).*publish it with dir/],
  ['no extension', { 'index.html': 'x', html: 'y' }, /extension that cannot be sent inline/],
  ['not a string', { 'index.html': 'x', 'a.js': 5 }, /^scene\.files\["a\.js"\] must be a string/],
  ['entry missing', { 'a.html': 'x' }, /^scene\.entry "index\.html" is not in scene\.files \(a\.html\)/],
]

test('files: each refusal names the field and says how to fix it', () => {
  for (const [label, files, pattern] of BAD_FILES) expect(denial({ id: 'g', alt: ALT, files }), label).toMatch(pattern)
  expect(denial({ id: 'g', alt: ALT, files: { 'a.html': 'x' }, entry: 'b.html' })).toMatch(/^scene\.entry "b\.html" is not in scene\.files/)
  expect(denial({ id: 'g', alt: ALT, files: { 'a.html': 'x' }, entry: '../a.html' })).toMatch(/^scene\.entry .* must not contain "\.\."/)
})

test('size caps: html 256 KB, 24 files, 1 MB of files, data 64 KB (counted in UTF-8 bytes)', () => {
  expect(denial({ ...HTML, html: 'x'.repeat(INLINE_CAPS.HTML_BYTES) })).toBe('ok')
  expect(denial({ ...HTML, html: 'x'.repeat(INLINE_CAPS.HTML_BYTES + 1) })).toMatch(/^scene\.html is 262145 bytes \(256 KB\); the limit is 262144 bytes \(256 KB\)/)
  expect(denial({ ...HTML, html: 'é'.repeat(INLINE_CAPS.HTML_BYTES / 2 + 1) })).toMatch(/^scene\.html is /) // 2 bytes each
  expect(denial({ ...HTML, html: '   ' })).toMatch(/^scene\.html is empty/)

  const many = (n: number): Record<string, string> => Object.fromEntries(Array.from({ length: n }, (_, i) => [i === 0 ? 'index.html' : `f${i}.txt`, 'x']))
  expect(denial({ id: 'g', alt: ALT, files: many(24) })).toBe('ok')
  expect(denial({ id: 'g', alt: ALT, files: many(25) })).toMatch(/^scene\.files has 25 files; the limit is 24/)
  const half = 'x'.repeat(512 * KB)
  expect(denial({ id: 'g', alt: ALT, files: { 'index.html': half, 'a.txt': half } })).toBe('ok')
  expect(denial({ id: 'g', alt: ALT, files: { 'index.html': half, 'a.txt': half + 'x' } })).toMatch(/^scene\.files holds 1048577 bytes \(1024 KB\); the limit is 1048576 bytes/)

  expect(dataText({ a: 'x'.repeat(INLINE_CAPS.DATA_BYTES - 8) }).length).toBe(INLINE_CAPS.DATA_BYTES)
  expect(() => dataText('x'.repeat(INLINE_CAPS.DATA_BYTES))).toThrow(/^scene\.data is 65538 bytes as JSON; the limit is 65536/)
})

test('utf8Bytes counts like UTF-8', () => {
  expect([utf8Bytes('abc'), utf8Bytes('é'), utf8Bytes('界'), utf8Bytes('😀'), utf8Bytes('')]).toEqual([3, 2, 3, 4, 0])
  expect(utf8Bytes('a é 界 😀 z')).toBe(15)
})

test('data: alone it is a data action; any JSON but null; with a publish it seeds the file', () => {
  expect(parseSceneInput({ id: 'g', data: { cpu: 3 } })).toEqual({ kind: 'data', id: 'g', text: '{"cpu":3}' })
  for (const v of [0, false, '', [], 'text']) expect(parseSceneInput({ id: 'g', data: v })).toMatchObject({ kind: 'data' })
  expect(denial({ id: 'g', data: null })).toMatch(/^scene\.data must not be null/)
  expect(denial({ data: { a: 1 } })).toMatch(/^scene\.id undefined is invalid/)
  const seeded = upsert({ ...HTML, data: { cpu: 1 } })
  expect(seeded.data).toBe('{"cpu":1}')
  expect(seeded.inline).toBeDefined()
  expect(upsert({ id: 'g', dir: '/tmp/x', alt: ALT, data: [1] }).data).toBe('[1]')
})

test('data, goto, remove and clear are separate modes', () => {
  expect(denial({ id: 'g', data: {}, goto: '#/2' })).toMatch(/^scene\.goto cannot be combined with other fields/)
  expect(denial({ id: 'g', data: {}, remove: 'g' })).toMatch(/^scene\.remove cannot be combined with other fields/)
  expect(denial({ remove: 'g', data: {} })).toMatch(/^scene\.remove cannot be combined/)
  expect(denial({ clear: true, data: {} })).toMatch(/^scene\.clear cannot be combined/)
  expect(parseSceneInput({ id: 'g', goto: '#/2' })).toEqual({ kind: 'goto', id: 'g', hash: '#/2' })
})

test('the schema offers html, files and data, and the first sentence names the fastest path', () => {
  const props = SCENE_INPUT_SCHEMA.properties
  expect(Object.keys(props)).toEqual(expect.arrayContaining(['html', 'files', 'data', 'dir', 'entry']))
  expect(SCENE_TOOL_DESCRIPTION.startsWith('Fastest way to show something: {id, html, alt} (a complete page or a fragment)')).toBe(true)
  expect(SCENE_TOOL_DESCRIPTION).toContain(LIVE_DATA_PATH)
})

// --- prepareScene writes inline content before it checks the folder ----------------------

const TMP = '/tmp/t'
const SESSION = 'sess-1'
const SCENES = inlineScenesDir(TMP, SESSION)
const REAL = '/private/tmp/t/claude-panel/scenes/sess-1/gauge'
const env = { cwd: '/work/proj', scenesDir: SCENES }
const dirInfo = (realPath: string): PathInfo => ({ kind: 'dir', size: 0, realPath })
const fileInfo = (realPath: string): PathInfo => ({ kind: 'file', size: 5, realPath })
const DISK: Record<string, PathInfo> = {
  '/work/proj': dirInfo('/work/proj'),
  '/tmp': dirInfo('/private/tmp'),
  '/private/tmp': dirInfo('/private/tmp'),
  [`${SCENES}/gauge`]: dirInfo(REAL),
  [`${REAL}/index.html`]: fileInfo(`${REAL}/index.html`),
  [`${REAL}/main.html`]: fileInfo(`${REAL}/main.html`),
}
const fs: SceneFs = { stat: async p => DISK[p] }

function recorder(): { io: SceneIo; log: string[] } {
  const log: string[] = []
  return {
    log,
    io: {
      putFiles: async (dir, files) => void log.push(`files ${dir} ${Object.keys(files).join(',')}`),
      putData: async (dir, text) => void log.push(`data ${dir} ${text}`),
    },
  }
}

test('inlineScenesDir is <tmp>/claude-panel/scenes/<session>', () => {
  expect(inlineScenesDir('/var/T/', 'abc')).toBe('/var/T/claude-panel/scenes/abc')
})

test('prepareScene: writes the files under the scenes dir, then resolves dir to the real path, then seeds the data', async () => {
  const { io, log } = recorder()
  const a = await prepareScene({ ...HTML, data: { n: 1 } }, env, fs, io)
  expect(a.kind === 'upsert' && a.scene.dir).toBe(REAL)
  expect(log).toEqual([`files ${SCENES}/gauge index.html`, `data ${REAL} {"n":1}`])

  const b = await prepareScene({ id: 'gauge', alt: ALT, files: { 'main.html': 'x', 'a.js': 'y' }, entry: 'main.html' }, env, fs, io)
  expect(b.kind === 'upsert' && b.scene.entry).toBe('main.html')
  expect(log[2]).toBe(`files ${SCENES}/gauge main.html,a.js`)
})

test('prepareScene: nothing is written for a refused call, and inline needs the mod\'s io', async () => {
  const { io, log } = recorder()
  await expect(prepareScene({ ...HTML, alt: undefined }, env, fs, io)).rejects.toThrow(/scene\.alt is required/)
  await expect(prepareScene({ id: 'g', alt: ALT, files: { 'a.png': 'x' } }, env, fs, io)).rejects.toThrow(/cannot be sent inline/)
  expect(log).toEqual([])
  await expect(prepareScene(HTML, { cwd: '/work/proj' }, fs, io)).rejects.toThrow(/not available here: write a folder/)
  await expect(prepareScene(HTML, env, fs)).rejects.toThrow(/not available here/)
  // a data-only call has nothing to check on disk
  expect(await prepareScene({ id: 'gauge', data: { a: 1 } }, env, { stat: async () => { throw new Error('no stat') } }, io)).toEqual({
    kind: 'data',
    id: 'gauge',
    text: '{"a":1}',
  })
})
