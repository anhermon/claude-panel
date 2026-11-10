import { expect, test } from 'claude-code/testing'

import { planCommand, NO_BROWSER_TEXT } from '../hooks/commands'
import { IMAGE_MAX_COLUMNS, IMAGE_MAX_ROWS, imageBox, pngSize } from '../hooks/png'
import { envPortOf, hexOf, mintToken, portMapOf, preferredPort, serverArgv, serverUrl, TOKEN_PATTERN, withPort } from '../hooks/server'
import { emptyState, parsePort } from '../hooks/state'
import type { PanelScene, PanelState } from '../types'

import { pngHeader } from './png-header'

const TOKEN = '0123456789abcdef0123456789abcdef'
const BASE = `http://127.0.0.1:4717/${TOKEN}/`

// --- the picture's size and box ----------------------------------------------------------

test('pngSize reads the IHDR from the first bytes, and is null for anything else', () => {
  expect(pngSize(pngHeader(640, 480))).toEqual({ width: 640, height: 480 })
  expect(pngSize(pngHeader(1, 1))).toEqual({ width: 1, height: 1 })
  expect(pngSize(pngHeader(70_000, 3))).toEqual({ width: 70_000, height: 3 })
  expect(pngSize(pngHeader(0, 5))).toBeNull()
  // The engine refuses an Image without a complete IHDR chunk, so the mod does not use one either.
  const whole = atob(pngHeader(640, 480))
  expect(pngSize(btoa(whole.slice(0, 24)))).toBeNull()
  expect(pngSize(btoa(whole.slice(0, 11) + String.fromCharCode(12) + whole.slice(12)))).toBeNull()
  expect(pngSize(btoa('GIF89a, not a png at all, just some bytes'))).toBeNull()
  expect(pngSize('')).toBeNull()
  expect(pngSize('!!! not base64 !!!')).toBeNull()
})

test('imageBox keeps the aspect (a cell is twice as tall as wide) and caps the rows at 20', () => {
  expect(imageBox({ width: 200, height: 100 }, 40)).toEqual({ columns: 40, rows: 10 })
  expect(imageBox({ width: 100, height: 100 }, 40)).toEqual({ columns: 40, rows: 20 })
  // too tall for 20 rows: narrower, aspect kept
  expect(imageBox({ width: 100, height: 1000 }, 40)).toEqual({ columns: 4, rows: IMAGE_MAX_ROWS })
  // a hairline still gets one row
  expect(imageBox({ width: 1000, height: 10 }, 45)).toEqual({ columns: 45, rows: 1 })
  // never past the Image element's 255 columns
  expect(imageBox({ width: 4000, height: 100 }, 1000).columns).toBe(IMAGE_MAX_COLUMNS)
  expect(imageBox({ width: 10, height: 10 }, 0).columns).toBe(1)
})

// --- the url token and the server's argv -------------------------------------------------

const noOpenssl = (): Promise<string> => Promise.reject(new Error('no openssl'))

test('mintToken: 32 hex characters from the random source when there is one', async () => {
  const token = await mintToken({ random: b => b.fill(0xab), openssl: noOpenssl })
  expect(token).toBe('ab'.repeat(16))
  expect(TOKEN_PATTERN.test(token ?? '')).toBe(true)
  expect(hexOf(Uint8Array.of(0, 1, 255))).toBe('0001ff')
})

test('mintToken: falls back to openssl when the random source is missing, throws or answers short', async () => {
  const openssl = async (): Promise<string> => `${TOKEN.toUpperCase()}\n`
  expect(await mintToken({ openssl })).toBe(TOKEN)
  expect(await mintToken({ random: () => { throw new Error('boom') }, openssl })).toBe(TOKEN)
  expect(await mintToken({ random: () => new Uint8Array(3), openssl })).toBe(TOKEN)
})

test('mintToken: null when no source gives a usable token', async () => {
  expect(await mintToken({ openssl: noOpenssl })).toBeNull()
  expect(await mintToken({ openssl: async () => 'not hex\n' })).toBeNull()
  expect(await mintToken({ openssl: async () => 'abcd\n' })).toBeNull()
})

test('serverArgv: node <root>/web/server.mjs <state> --token T --port P --root DIR ...', () => {
  const launch = { pluginRoot: '/p', stateFile: '/t/s.json', token: TOKEN, port: null, roots: ['/work', '/private/tmp'] }
  expect(serverArgv(launch)).toEqual([
    'node', '/p/web/server.mjs', '/t/s.json', '--token', TOKEN, '--port', '0', '--root', '/work', '--root', '/private/tmp',
  ])
  expect(serverArgv({ ...launch, port: 4717, roots: [] })).toEqual([
    'node', '/p/web/server.mjs', '/t/s.json', '--token', TOKEN, '--port', '4717',
  ])
})

test('serverUrl is http://127.0.0.1:<port>/<token>/', () => {
  expect(serverUrl(4717, TOKEN)).toBe(BASE)
})

test('parsePort reads both `PORT n` and `PORT n TOKEN t`, even split over pieces', () => {
  expect(parsePort('PORT 4717\n')).toBe(4717)
  expect(parsePort(`PORT 4717 TOKEN ${TOKEN}\n`)).toBe(4717)
  expect(parsePort(`noise\nPORT 4718 TOKEN ${TOKEN}\r\n`)).toBe(4718)
  expect(parsePort(`PORT 4717 TOK`)).toBeNull()
  expect(parsePort(`PORT 4717 TOKEN ${TOKEN}`)).toBeNull()
  expect(parsePort('PORT 4717 JUNK\n')).toBeNull()
})

// --- /panel, /panel open, /panel open <id> -----------------------------------------------

const scene = (id: string): PanelScene => ({ id, dir: `/tmp/${id}`, entry: 'index.html', alt: id, span: 3, height: 420, rev: 1 })
const running = (...ids: string[]): PanelState => ({ ...emptyState(), url: BASE, scenes: ids.map(scene) })

test('/panel answers the url and opens nothing; an unknown word is the same', () => {
  expect(planCommand('', running())).toEqual({ text: BASE })
  expect(planCommand('  ', running('a'))).toEqual({ text: BASE })
  expect(planCommand('whatever', running('a'))).toEqual({ text: BASE })
})

test('/panel open opens the panel page; /panel open <id> opens that scene under it', () => {
  expect(planCommand('open', running('a'))).toEqual({ text: BASE, open: BASE })
  expect(planCommand('open a', running('a', 'b'))).toEqual({ text: `${BASE}s/a/`, open: `${BASE}s/a/` })
  expect(planCommand('  open   b  ', running('a', 'b')).open).toBe(`${BASE}s/b/`)
})

test('/panel open <unknown id> says which scenes exist, and opens nothing', () => {
  const none = planCommand('open zzz', running('a', 'b'))
  expect(none.text).toBe('No scene "zzz" (scenes: a, b).')
  expect(none.open).toBeUndefined()
  expect(planCommand('open zzz', running()).text).toBe('No scene "zzz" (there are no scenes yet).')
})

test('with no browser view running every form answers plainly and opens nothing', () => {
  const down: PanelState = { ...running('a'), url: null }
  expect(planCommand('', down)).toEqual({ text: NO_BROWSER_TEXT })
  expect(planCommand('open', down)).toEqual({ text: NO_BROWSER_TEXT })
  const one = planCommand('open a', down)
  expect(one.text).toBe('The browser view is not running yet, so scene "a" cannot be opened.')
  expect(one.open).toBeUndefined()
})

test('the link port map: odd stored values are dropped, the newest folder goes last and the map is capped', () => {
  expect(portMapOf(undefined)).toEqual({})
  expect(portMapOf([1])).toEqual({})
  expect(portMapOf({ '/a': 4717, '/b': 'x', '/c': 0, '/d': 70000, '/e': 1.5 })).toEqual({ '/a': 4717 })
  expect(Object.keys(withPort({ '/a': 1, '/b': 2 }, '/a', 3))).toEqual(['/b', '/a'])
  const many = Array.from({ length: 80 }, (_, i) => i).reduce<Record<string, number>>((m, i) => withPort(m, `/f${i}`, 4000 + i), {})
  expect(Object.keys(many)).toHaveLength(64)
  expect(many['/f79']).toBe(4079)
  expect(many['/f0']).toBeUndefined()
})

test('port: a valid CLAUDE_PANEL_PORT beats the live and remembered port; junk does not', () => {
  expect(envPortOf('5000')).toBe(5000)
  for (const bad of [undefined, '', '0', 'abc', '70000', '-1', '12.5']) expect(envPortOf(bad)).toBeNull()
  expect(preferredPort(5000, 4801, 4802)).toBe(5000)
  expect(preferredPort(null, 4801, 4802)).toBe(4801)
  expect(preferredPort(null, null, 4802)).toBe(4802)
  expect(preferredPort(null, null, undefined)).toBe(4717)
})
