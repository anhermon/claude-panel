import { expect, test } from 'claude-code/testing'

import { Invalid } from '../hooks/blocks/common'
import {
  applyScene,
  isInside,
  parseSceneInput,
  SCENE_CAPS,
  sceneResultLine,
  sceneUrl,
} from '../hooks/scene'
import type { SceneAction } from '../hooks/scene'
import { allowedRoots, prepareScene } from '../hooks/scene-fs'
import type { PathInfo, SceneFs } from '../hooks/scene-fs'
import { applyInput, emptyState } from '../hooks/state'
import type { PanelScene, PanelState } from '../types'

import { FIXTURE } from './fixture-state'

const NOW = 1_767_000_000_000
const URL_BASE = 'http://127.0.0.1:4717/0123456789abcdef0123456789abcdef/'
const MIB = 1024 * 1024

const GOOD = { id: 'cpu', dir: '/tmp/cpu', alt: 'A CPU chart.' }

function denial(input: unknown): string {
  try {
    parseSceneInput(input)
    return 'ok'
  } catch (err) {
    if (err instanceof Invalid) return err.message
    throw err
  }
}

function upsert(input: unknown): Extract<SceneAction, { kind: 'upsert' }> {
  const a = parseSceneInput(input)
  if (a.kind !== 'upsert') throw new Error(`expected an upsert, got ${a.kind}`)
  return a
}

function apply(prev: PanelState, input: unknown): PanelState {
  const r = applyScene(prev, parseSceneInput(input), NOW)
  if (!r.isOk) throw new Error(`expected ok, got: ${r.error}`)
  return r.state
}

const ids = (s: PanelState): string[] => s.scenes.map(x => x.id)
const withUrl = (s: PanelState): PanelState => ({ ...s, url: URL_BASE })

test('a valid scene takes its defaults: entry index.html, span 3, height 420', () => {
  expect(upsert(GOOD).scene).toEqual({
    id: 'cpu',
    dir: '/tmp/cpu',
    entry: 'index.html',
    span: 3,
    height: 420,
    layout: 'card',
    alt: 'A CPU chart.',
  })
})

test('a fully specified scene is kept as given (title and alt trimmed)', () => {
  const art = ['+--+', '|  |', '+--+']
  const { scene } = upsert({
    id: 'a-1',
    dir: '/var/folders/x/y',
    entry: 'pages/main.html',
    title: '  Latency  ',
    alt: '  Latency over time.  ',
    span: 1,
    height: 1200,
    pin: true,
    term: { art, image: '/tmp/a.PNG' },
  })
  expect(scene).toEqual({
    id: 'a-1',
    dir: '/var/folders/x/y',
    entry: 'pages/main.html',
    title: 'Latency',
    alt: 'Latency over time.',
    span: 1,
    height: 1200,
    pin: true,
    layout: 'card',
    term: { art, image: '/tmp/a.PNG' },
  })
})

test('the limits themselves are accepted', () => {
  const edge = {
    ...GOOD,
    id: 'a'.repeat(SCENE_CAPS.ID_CHARS),
    title: 't'.repeat(SCENE_CAPS.TITLE_CHARS),
    alt: 'x'.repeat(SCENE_CAPS.ALT_CHARS),
    height: SCENE_CAPS.HEIGHT_MIN,
    term: { art: Array.from({ length: SCENE_CAPS.ART_LINES }, () => '#'.repeat(SCENE_CAPS.ART_COLS)) },
  }
  expect(denial(edge)).toBe('ok')
  expect(denial({ ...edge, height: SCENE_CAPS.HEIGHT_MAX })).toBe('ok')
})

const REJECTED: [string, Record<string, unknown>, RegExp][] = [
  ['id: missing', { id: undefined }, /scene\.id undefined is invalid/],
  ['id: capital letter', { id: 'Cpu' }, /scene\.id "Cpu" is invalid: use 1-24 characters from a-z, 0-9 and "-"/],
  ['id: underscore', { id: 'a_b' }, /scene\.id "a_b" is invalid/],
  ['id: too long', { id: 'a'.repeat(25) }, /scene\.id .* is invalid/],
  ['id: empty', { id: '' }, /scene\.id "" is invalid/],
  ['dir: missing', { dir: undefined }, /scene\.dir is required: the absolute path/],
  ['dir: relative', { dir: 'scenes/cpu' }, /scene\.dir "scenes\/cpu" must be an absolute path, but it is relative/],
  ['dir: dot-dot', { dir: '/tmp/../etc' }, /scene\.dir "\/tmp\/\.\.\/etc" must not contain "\.\." segments/],
  ['dir: not a string', { dir: 5 }, /scene\.dir is required/],
  ['entry: absolute', { entry: '/etc/passwd' }, /scene\.entry "\/etc\/passwd" must not start with "\/"/],
  ['entry: dot-dot', { entry: '../x.html' }, /scene\.entry "\.\.\/x\.html" must not contain "\.\." segments/],
  ['entry: dotfile', { entry: '.git/config' }, /scene\.entry ".git\/config" must not have a dotfile/],
  ['entry: dotfile page', { entry: 'pages/.secret.html' }, /scene\.entry .* must not have a dotfile/],
  ['entry: empty segment', { entry: 'a//b.html' }, /scene\.entry "a\/\/b\.html" must not have a dotfile, "\.\/" or empty segment/],
  ['entry: backslash', { entry: 'a\\b.html' }, /scene\.entry .* must use "\/" separators/],
  ['entry: empty', { entry: '' }, /scene\.entry "" must be a non-empty string/],
  ['entry: not a string', { entry: 3 }, /scene\.entry 3 must be a non-empty string/],
  ['alt: missing', { alt: undefined }, /scene\.alt is required: one plain sentence/],
  ['alt: blank', { alt: '   ' }, /scene\.alt is required/],
  ['alt: too long', { alt: 'x'.repeat(301) }, /scene\.alt is 301 characters; the limit is 300: shorten it/],
  ['title: too long', { title: 't'.repeat(61) }, /scene\.title is 61 characters; the limit is 60: shorten it/],
  ['title: not a string', { title: 4 }, /scene\.title must be a string/],
  ['height: too small', { height: 119 }, /scene\.height 119 must be a whole number of pixels from 120 to 1200/],
  ['height: too big', { height: 1201 }, /scene\.height 1201 must be a whole number/],
  ['height: fraction', { height: 300.5 }, /scene\.height 300\.5 must be a whole number/],
  ['height: a string', { height: '400' }, /scene\.height "400" must be a whole number/],
  ['span: 4', { span: 4 }, /scene\.span 4 must be one of 1, 2, 3/],
  ['span: 0', { span: 0 }, /scene\.span 0 must be one of 1, 2, 3/],
  ['span: a string', { span: '2' }, /scene\.span "2" must be one of 1, 2, 3/],
  ['pin: not a boolean', { pin: 'yes' }, /scene\.pin must be true or false/],
  ['unknown field', { color: 'red' }, /scene\.color is not a known field \(to publish: id, dir, entry/],
  ['term: not an object', { term: 'art' }, /scene\.term must be an object \{art\?, image\?\}/],
  ['term: unknown key', { term: { text: 'x' } }, /scene\.term\.text is not a known field \(allowed: art, image\)/],
  ['art: not an array', { term: { art: 'x' } }, /scene\.term\.art must be an array of strings/],
  ['art: 25 lines', { term: { art: Array.from({ length: 25 }, () => 'x') } }, /scene\.term\.art has 25 lines; the limit is 24: draw it smaller/],
  ['art: 101 columns', { term: { art: ['#'.repeat(101)] } }, /scene\.term\.art\[0\] is 101 columns wide; the limit is 100: draw it narrower/],
  ['art: wide glyphs count 2 cells', { term: { art: ['x', '界'.repeat(51)] } }, /scene\.term\.art\[1\] is 102 columns wide/],
  ['art: not a string', { term: { art: ['ok', 3] } }, /scene\.term\.art\[1\] must be a string/],
  ['art: a line break', { term: { art: ['a\nb'] } }, /scene\.term\.art\[0\] must be a single line/],
  ['image: not png', { term: { image: '/tmp/a.jpg' } }, /scene\.term\.image "\/tmp\/a\.jpg" must be a \.png file/],
  ['image: relative', { term: { image: 'a.png' } }, /scene\.term\.image "a\.png" must be an absolute path/],
  ['image: dot-dot', { term: { image: '/tmp/../a.png' } }, /scene\.term\.image .* must not contain "\.\." segments/],
]

test('each rejection names the field and says how to fix it', () => {
  for (const [label, patch, pattern] of REJECTED) {
    const input = { ...GOOD, ...patch }
    expect(denial(input), label).toMatch(pattern)
  }
})

test('remove and clear: alone, valid ids only; a stray clear:false or remove:null changes nothing', () => {
  expect(parseSceneInput({ remove: 'cpu' })).toEqual({ kind: 'remove', id: 'cpu' })
  expect(parseSceneInput({ clear: true })).toEqual({ kind: 'clear' })
  expect(denial({ remove: 'cpu', alt: 'x' })).toMatch(/scene\.remove cannot be combined with other fields: send it alone/)
  expect(denial({ clear: true, id: 'cpu' })).toMatch(/scene\.clear cannot be combined with other fields/)
  expect(denial({ remove: 'No Way' })).toMatch(/scene\.remove "No Way" is invalid/)
  expect(denial({ clear: 'yes' })).toMatch(/scene\.clear must be true/)
  expect(denial('cpu')).toBe('input must be an object')
  expect(denial(null)).toBe('input must be an object')
  expect(upsert({ ...GOOD, clear: false, remove: null }).scene.id).toBe('cpu')
})

test('an upsert appends a new scene at rev 1 and bumps the state rev', () => {
  const a = apply(withUrl(emptyState()), GOOD)
  expect(a.scenes).toHaveLength(1)
  expect(a.scenes[0]?.rev).toBe(1)
  expect(a.rev).toBe(1)
  expect(a.updatedAt).toBe(NOW)
  const b = apply(a, { ...GOOD, id: 'mem' })
  expect(ids(b)).toEqual(['cpu', 'mem'])
  expect(b.rev).toBe(2)
})

test('the same id replaces in place: position kept, scene rev bumped', () => {
  let s = withUrl(emptyState())
  for (const id of ['a', 'b', 'c']) s = apply(s, { ...GOOD, id })
  s = apply(s, { ...GOOD, id: 'b', alt: 'B, changed.' })
  expect(ids(s)).toEqual(['a', 'b', 'c'])
  expect(s.scenes.map(x => x.rev)).toEqual([1, 2, 1])
  expect(s.scenes[1]?.alt).toBe('B, changed.')
  s = apply(s, { ...GOOD, id: 'b' })
  expect(s.scenes[1]?.rev).toBe(3)
})

test('the result line is `scene <id> rev N · <url>s/<id>/`, and shorter before the server is up', () => {
  const r = applyScene(withUrl(emptyState()), parseSceneInput(GOOD), NOW)
  if (!r.isOk) throw new Error(r.error)
  expect(r.line).toBe(`scene cpu rev 1 · ${URL_BASE}s/cpu/`)
  const early = applyScene(emptyState(), parseSceneInput(GOOD), NOW)
  expect(early.isOk && early.line).toBe('scene cpu rev 1')
  expect(sceneUrl('http://h:1/t', 'x')).toBe('http://h:1/t/s/x/')
  const scene: PanelScene = { ...(upsert(GOOD).scene), rev: 4 }
  expect(sceneResultLine(scene, URL_BASE)).toBe(`scene cpu rev 4 · ${URL_BASE}s/cpu/`)
})

test('remove deletes one scene; an unknown id is reported and changes nothing', () => {
  let s = withUrl(emptyState())
  for (const id of ['a', 'b']) s = apply(s, { ...GOOD, id })
  const gone = applyScene(s, parseSceneInput({ remove: 'a' }), NOW)
  expect(gone.isOk && ids(gone.state)).toEqual(['b'])
  expect(gone.isOk && gone.state.rev).toBe(s.rev + 1)
  expect(gone.isOk && gone.line).toBe('scene a removed; scenes: b')
  const none = applyScene(s, parseSceneInput({ remove: 'zzz' }), NOW)
  expect(none.isOk && none.state).toBe(s)
  expect(none.isOk && none.line).toBe('no scene "zzz" to remove; scenes: a, b')
})

test('clear deletes every scene and leaves the rest of the state', () => {
  let s = withUrl(emptyState())
  for (const id of ['a', 'b']) s = apply(s, { ...GOOD, id })
  const r = applyScene({ ...s, task: { title: 'T', why: 'W' } }, parseSceneInput({ clear: true }), NOW)
  expect(r.isOk && r.state.scenes).toEqual([])
  expect(r.isOk && r.state.task).toEqual({ title: 'T', why: 'W' })
  expect(r.isOk && r.line).toBe('scenes cleared (2 removed)')
})

test('at most 6 scenes: a seventh is denied with how to make room; a replace still works', () => {
  let s = withUrl(emptyState())
  for (let i = 0; i < SCENE_CAPS.SCENES; i++) s = apply(s, { ...GOOD, id: `s${i}` })
  const seventh = applyScene(s, parseSceneInput({ ...GOOD, id: 'seven' }), NOW)
  expect(seventh.isOk).toBe(false)
  const error = seventh.isOk ? '' : seventh.error
  expect(error).toMatch(/already 6 scenes \(s0, s1, s2, s3, s4, s5\)/)
  expect(error).toMatch(/remove one with \{"remove":"<id>"\}/)
  expect(apply(s, { ...GOOD, id: 's3', alt: 'again' }).scenes).toHaveLength(6)
})

test('the panel tool: `clear` keeps the scenes, and `scenes` is not one of its fields', () => {
  const s = apply(withUrl(emptyState()), GOOD)
  const cleared = applyInput({ ...s, task: { title: 'T', why: 'W' } }, { clear: true }, NOW)
  expect(cleared.isOk && ids(cleared.state)).toEqual(['cpu'])
  expect(cleared.isOk && cleared.state.task).toBeNull()
  const smuggled = applyInput(emptyState(), { scenes: [] }, NOW)
  expect(smuggled.isOk).toBe(false)
  expect(smuggled.isOk ? '' : smuggled.error).toMatch(/scenes/)
})

test('isInside compares with a trailing separator, and `/` is never a root', () => {
  expect(isInside('/tmp/a', '/tmp')).toBe(true)
  expect(isInside('/tmp/', '/tmp/')).toBe(false)
  expect(isInside('/tmp', '/tmp')).toBe(false)
  expect(isInside('/tmpx/a', '/tmp')).toBe(false)
  expect(isInside('/etc/a', '/')).toBe(false)
})

test('the fixture scenes are valid publishes (their dirs made absolute)', () => {
  expect(FIXTURE.scenes.length).toBeGreaterThanOrEqual(2)
  for (const s of FIXTURE.scenes) {
    const { rev: _rev, ...rest } = s
    const { scene } = upsert({ ...rest, dir: `/tmp/${s.dir}` })
    expect(scene.id).toBe(s.id)
  }
})

// --- the file-system checks, against a table of paths ------------------------------------

const CWD = '/work/proj'
const HOME = '/Users/a'
const dir = (realPath?: string): PathInfo => ({ kind: 'dir', size: 0, ...(realPath === undefined ? {} : { realPath }) })
const file = (size = 10, realPath?: string): PathInfo => ({ kind: 'file', size, ...(realPath === undefined ? {} : { realPath }) })

function fakeFs(table: Record<string, PathInfo>): SceneFs & { seen: string[] } {
  const seen: string[] = []
  return {
    seen,
    stat: async path => {
      seen.push(path)
      return table[path]
    },
  }
}

const DISK: Record<string, PathInfo> = {
  [CWD]: dir(CWD),
  '/tmp': dir('/private/tmp'),
  '/private/tmp': dir('/private/tmp'),
  [`${HOME}/.claude`]: dir(`${HOME}/.claude`),
  '/work/proj/chart': dir('/work/proj/chart'),
  '/work/proj/chart/index.html': file(5, '/work/proj/chart/index.html'),
  '/tmp/viz': dir('/private/tmp/viz'),
  '/private/tmp/viz/index.html': file(5, '/private/tmp/viz/index.html'),
  '/private/tmp/viz/pages/main.html': file(5, '/private/tmp/viz/pages/main.html'),
  '/private/tmp/viz/pages': dir('/private/tmp/viz/pages'),
  '/private/tmp/viz/face.png': file(1000, '/private/tmp/viz/face.png'),
  '/private/tmp/viz/huge.png': file(2 * MIB + 1, '/private/tmp/viz/huge.png'),
  '/private/tmp/viz/link.html': file(5, '/etc/passwd'),
  [`${HOME}/.claude/dev/s`]: dir(`${HOME}/.claude/dev/s`),
  [`${HOME}/.claude/dev/s/index.html`]: file(5, `${HOME}/.claude/dev/s/index.html`),
  '/etc': dir('/etc'),
  '/etc/hosts': file(5, '/etc/hosts'),
  '/tmp/evil': dir('/etc'),
}

const prepare = (input: unknown, table = DISK) => prepareScene(input, { cwd: CWD, home: HOME }, fakeFs(table))
const refusal = async (input: unknown, table = DISK): Promise<string> =>
  prepare(input, table).then(
    () => 'ok',
    (err: unknown) => {
      if (err instanceof Invalid) return err.message
      throw err
    },
  )

test('the allowed roots: the session cwd, the temp dirs, ~/.claude', () => {
  expect(allowedRoots({ cwd: CWD, home: HOME })).toEqual([
    CWD,
    '/tmp',
    '/private/tmp',
    '/var/folders',
    '/private/var/folders',
    `${HOME}/.claude`,
  ])
  expect(allowedRoots({ cwd: CWD })).not.toContain('/.claude')
})

test('prepareScene resolves dir to its real path (/tmp is /private/tmp)', async () => {
  const a = await prepare({ ...GOOD, dir: '/tmp/viz', term: { image: '/private/tmp/viz/face.png' } })
  expect(a.kind === 'upsert' && a.scene.dir).toBe('/private/tmp/viz')
  expect(a.kind === 'upsert' && a.scene.term?.image).toBe('/private/tmp/viz/face.png')
  const b = await prepare({ ...GOOD, dir: '/work/proj/chart' })
  expect(b.kind === 'upsert' && b.scene.dir).toBe('/work/proj/chart')
  const c = await prepare({ ...GOOD, dir: '/tmp/viz', entry: 'pages/main.html' })
  expect(c.kind === 'upsert' && c.scene.entry).toBe('pages/main.html')
  const d = await prepare({ ...GOOD, dir: `${HOME}/.claude/dev/s` })
  expect(d.kind === 'upsert' && d.scene.dir).toBe(`${HOME}/.claude/dev/s`)
})

test('prepareScene refuses a folder that is missing, a file, or outside the roots', async () => {
  expect(await refusal({ ...GOOD, dir: '/tmp/nope' })).toMatch(/scene\.dir "\/tmp\/nope" does not exist: create the folder/)
  expect(await refusal({ ...GOOD, dir: '/etc/hosts' })).toMatch(/is not a directory: pass the folder/)
  expect(await refusal({ ...GOOD, dir: '/etc' })).toMatch(/scene\.dir "\/etc" is outside the allowed folders/)
  expect(await refusal({ ...GOOD, dir: '/tmp/evil' })).toMatch(/\(really \/etc\) is outside the allowed folders/)
  expect(await refusal({ ...GOOD, dir: '/tmp' })).toMatch(/is outside the allowed folders/)
  expect(await refusal({ ...GOOD, dir: CWD })).toMatch(/is outside the allowed folders/)
  expect(await refusal({ ...GOOD, dir: '/tmp/viz' }, { ...DISK, '/tmp/viz': { kind: 'dir', size: 0 } })).toMatch(
    /cannot be resolved to a real path/,
  )
})

test('prepareScene refuses an entry that is missing, a folder, or a link that leaves the folder', async () => {
  const at = { ...GOOD, dir: '/tmp/viz' }
  expect(await refusal({ ...at, entry: 'gone.html' })).toMatch(/scene\.entry "gone\.html" was not found as a file in \/private\/tmp\/viz/)
  expect(await refusal({ ...at, entry: 'pages' })).toMatch(/scene\.entry "pages" was not found as a file/)
  expect(await refusal({ ...at, entry: 'link.html' })).toMatch(/scene\.entry "link\.html" leads outside \/private\/tmp\/viz/)
  expect(await refusal({ ...at, entry: 'index.html' })).toBe('ok')
})

test('prepareScene refuses a term.image that is missing or over 2 MiB', async () => {
  const at = { ...GOOD, dir: '/tmp/viz' }
  expect(await refusal({ ...at, term: { image: '/tmp/viz/none.png' } })).toMatch(/scene\.term\.image .* was not found as a file/)
  expect(await refusal({ ...at, term: { image: '/private/tmp/viz/huge.png' } })).toMatch(
    /is 2097153 bytes; the limit is 2097152 \(2 MiB\): downscale it/,
  )
  expect(await refusal({ ...at, term: { image: '/private/tmp/viz/face.png' } })).toBe('ok')
})

test('prepareScene checks nothing on disk for remove and clear', async () => {
  const fs = fakeFs({})
  expect(await prepareScene({ remove: 'a' }, { cwd: CWD }, fs)).toEqual({ kind: 'remove', id: 'a' })
  expect(await prepareScene({ clear: true }, { cwd: CWD }, fs)).toEqual({ kind: 'clear' })
  expect(fs.seen).toEqual([])
  // and a plain field error is raised before any disk check
  expect(await refusal({ ...GOOD, alt: undefined })).toMatch(/scene\.alt is required/)
})
