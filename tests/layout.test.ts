import { expect, test } from 'claude-code/testing'

import { blockLines, footer, layout } from '../hooks/layout'
import type { Faces, Line } from '../hooks/layout'
import { cellWidth, fit, wrapText } from '../hooks/layout-text'
import { imageBox } from '../hooks/png'
import { imageRows, scrollHint, windowTree } from '../hooks/scroll'
import type { PanelBlock, PanelCard, PanelScene, PanelState } from '../types'
import { FIXTURE } from './fixture-state'

const NARROW_WIDTHS = [40, 41, 42, 43, 44, 45, 46, 47, 48] as const
const WIDE = 100
const TINY = 20

const text = (l: Line): string => l.map(s => s.text).join('')
const rows = (s: PanelState, w: number, faces?: Faces): string[] => layout(s, w, faces).map(text)
const block = (b: unknown, w: number): string[] => blockLines(b, w).map(text)
const widest = (lines: readonly string[]): number => Math.max(0, ...lines.map(cellWidth))

const state = (over: Partial<PanelState> = {}): PanelState => ({
  ...FIXTURE,
  task: { title: 'T', why: 'W' },
  ask: null,
  labels: {},
  context: [],
  done: [],
  next: [],
  cards: [],
  scenes: [],
  ...over,
})
const card = (id: string, blocks: PanelBlock[], over: Partial<PanelCard> = {}): PanelCard => ({ id, blocks, ...over })

// One compact sample per kind, written against the shapes in types/index.d.ts.
const SAMPLES: Record<string, PanelBlock> = {
  text: { kind: 'text', text: 'Plain words that must wrap at the pane width and never past it.' },
  list: { kind: 'list', items: ['first item is a long one that wraps around the edge', 'second'] },
  table: {
    kind: 'table',
    head: ['Option', 'Cost', 'Risk', 'Owner', 'Notes'],
    rows: [['Client retry with backoff', 'S', 'Low', 'storage', 'smallest change'], ['Queue', 'L', 'Medium', 'infra', 'a project']],
  },
  code: { kind: 'code', text: 'const veryLongIdentifierName = computeSomethingExpensive(argumentOne, argumentTwo)' },
  callout: { kind: 'callout', tone: 'warn', text: 'A warning that is long enough to wrap onto a second line.' },
  steps: {
    kind: 'steps',
    items: [
      { text: 'done thing', state: 'done' },
      { text: 'doing thing with a long description that wraps', state: 'doing', note: 'a note under it' },
      { text: 'todo', state: 'todo' },
      { text: 'failed', state: 'failed' },
      { text: 'skipped', state: 'skipped', note: 'why' },
    ],
  },
  kv: { kind: 'kv', rows: [['Path', 'POST /v1/objects'], ['A really long key name here', 'and a long value that has to wrap to the next line']] },
  metrics: {
    kind: 'metrics',
    items: [
      { label: 'CI flake rate', value: '30%', delta: 'flat', tone: 'danger' },
      { label: 'A label that is far too long to fit beside its value', value: '12345678', delta: 'worst case ever seen', tone: 'ok' },
    ],
  },
  progress: { kind: 'progress', value: 0.62, label: 'Overall', note: '3 of 5 steps' },
  diff: { kind: 'diff', file: 'src/a.ts', text: '@@ -1,3 +1,4 @@ function longName(argument)\n-old line\n+new line that is quite a bit longer than the pane is wide\n context' },
  tree: {
    kind: 'tree',
    items: [
      { path: 'src/net/upload.ts', mark: 'changed', note: 'backoff' },
      { path: 'src/net/retry.ts', mark: 'added' },
      { path: 'a/b/c/d/deeply-nested-file-name.ts', mark: 'focus', note: 'a note' },
      { path: 'old.ts', mark: 'removed' },
    ],
  },
  options: {
    kind: 'options',
    items: [
      { title: 'Client retry with backoff', summary: 'Smallest change.', pros: ['No new infra'], cons: ['Adds latency'], pick: true },
      { title: 'A server-side queue that is a project of its own', pros: ['Durable'], cons: ['New infra to operate', 'Weeks'] },
    ],
  },
  timeline: {
    kind: 'timeline',
    items: [{ when: '10:02', text: 'First CI flake report' }, { when: '10:20', text: 'Pattern found: bursts of 503 over several seconds', tone: 'warn' }],
  },
  sources: {
    kind: 'sources',
    items: [
      { title: 'Exponential backoff and jitter', url: 'https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/', note: 'why jitter matters' },
      { title: 'Internal runbook' },
    ],
  },
  bars: { kind: 'bars', unit: 'runs', items: [{ label: 'Pass', value: 21 }, { label: 'A very long label name', value: 7 }, { label: 'Zero', value: 0 }] },
  tags: { kind: 'tags', items: ['retry', 'http', 'flaky-test', 'a-rather-long-tag-name', 'x'] },
  quote: { kind: 'quote', text: 'Retries are selfish: they trade the callers latency for the servers load.', by: 'builders library' },
}

test('cell widths: wide glyphs count 2, combining marks 0, truncation keeps the cell budget', () => {
  expect(cellWidth('abc')).toBe(3)
  expect(cellWidth('日本語')).toBe(6)
  expect(cellWidth('á')).toBe(1)
  expect(cellWidth('✓ ● ★')).toBe(5)
  expect(fit('日本語日本語', 7)).toBe('日本語…')
  expect(cellWidth(fit('日本語日本語', 7))).toBeLessThanOrEqual(7)
  expect(fit('short', 10)).toBe('short')
  expect(wrapText('aaa bbb ccc', 7)).toEqual(['aaa bbb', 'ccc'])
  expect(wrapText('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij'])
  expect(wrapText('日本語日本語', 6)).toEqual(['日本語', '日本語'])
})

test('every block kind fits its width at 40 and 100 cells, and says something', () => {
  for (const [kind, b] of Object.entries(SAMPLES))
    for (const w of [40, WIDE, TINY]) {
      const out = block(b, w)
      expect(out.length).toBeGreaterThan(0)
      expect(widest(out)).toBeLessThanOrEqual(w)
      expect(kind).toBe(b.kind)
    }
})

test('golden lines at 40 cells', () => {
  const at = (k: string): string[] => block(SAMPLES[k], 40)
  expect(at('steps')).toContain('✓ done thing')
  expect(at('steps')).toContain('◐ doing thing with a long description')
  expect(at('steps')).toContain('  a note under it')
  expect(at('steps')).toContain('○ todo')
  expect(at('steps')).toContain('✗ failed')
  expect(at('steps')).toContain('– skipped')
  expect(at('progress')[0]).toMatch(/^Overall ▕█+░+▏ 62%$/)
  expect(at('progress')[1]).toBe('3 of 5 steps')
  expect(at('quote')[0]).toBe('▎ Retries are selfish: they trade the')
  expect(at('quote').at(-1)).toBe('▎ — builders library')
  expect(at('options')[0]).toBe('★ Client retry with backoff Recommended')
  expect(at('options')).toContain('  ✓ No new infra')
  expect(at('options')).toContain('  ✗ Adds latency')
  expect(at('tags')[0]).toBe('[retry] [http] [flaky-test]')
  expect(at('tree')).toContain('  src/net/')
  expect(at('tree')).toContain('~   upload.ts  backoff')
  expect(at('tree')).toContain('+   retry.ts')
  expect(at('tree')).toContain('- old.ts')
  expect(at('diff')[0]).toBe('src/a.ts')
  expect(at('diff')).toContain('-old line')
  expect(at('timeline')[0]).toBe('● 10:02  First CI flake report')
  expect(at('sources')[0]).toBe('• Exponential backoff and jitter')
  expect(at('sources')[1]).toMatch(/^ {2}aws\.amazon\.com\/builders-library.*…$/)
  expect(at('sources')).toContain('• Internal runbook')
  expect(at('bars')[0]).toMatch(/^Pass {11}█+ 21 runs$/)
  expect(at('bars').at(-1)).toMatch(/^Zero +\s*0 runs$/)
  expect(at('kv')[0]).toMatch(/^Path {2,}POST \/v1\/objects$/)
  expect(at('metrics')[0]).toMatch(/^30% +CI flake rate +flat$/)
  expect(at('metrics').some(l => /^12345678 +A label.*…$/.test(l))).toBe(true)
})

test('golden lines at 100 cells: metrics pair up, tables stay aligned, options stay stacked', () => {
  const tiles = FIXTURE.cards.find(c => c.id === 'numbers')?.blocks[0]
  expect(block(tiles, WIDE)).toHaveLength(2)
  expect(block(tiles, WIDE)[0]).toMatch(/^30% +CI flake rate +flat +0% +With retry \(stub\) +-9\/10$/)
  expect(block(tiles, 45)).toHaveLength(3)
  expect(block(SAMPLES.table, WIDE)[0]).toMatch(/^Option +Cost +Risk +Owner +Notes$/)
  expect(block(SAMPLES.table, WIDE)[1]).toMatch(/^─+$/)
  expect(block(SAMPLES.options, WIDE)[0]).toBe('★ Client retry with backoff Recommended')
})

test('a table too narrow for its columns stacks each row as Header: value', () => {
  const t = block(SAMPLES.table, 40)
  expect(t).toContain('Client retry with backoff')
  expect(t.some(l => /^ {2}Cost: S$/.test(l))).toBe(true)
  expect(t.some(l => /^ {2}Risk: Low$/.test(l))).toBe(true)
  expect(widest(t)).toBeLessThanOrEqual(40)
})

test('the fixture, with and without card tones, fits every width from 40 to 48 and at 100', () => {
  const toned: PanelState = { ...FIXTURE, cards: FIXTURE.cards.map(c => ({ ...c, tone: 'danger' })) }
  for (const w of [...NARROW_WIDTHS, WIDE])
    for (const s of [FIXTURE, toned]) {
      const out = rows(s, w)
      expect(widest(out)).toBeLessThanOrEqual(w)
      expect(out.length).toBeGreaterThan(50)
    }
})

test('stress: long keys, deep paths, unbroken urls, long labels and wide glyphs never overflow', () => {
  const stress = state({
    ask: 'ÄÖ 日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語日本語 ' + 'x'.repeat(120),
    cards: [
      card('a', [
        { kind: 'table', head: ['one', 'two', 'three', 'four', 'five'], rows: [['aaaaaaaaaa', 'bbbbbbbbbb', 'cccccccccc', 'dddddddddd', 'eeeeeeeeee']] },
        { kind: 'kv', rows: [['k'.repeat(30), 'v'.repeat(120)]] },
        { kind: 'tree', items: [{ path: 'a/b/c/d/e/f/g/h/' + 'n'.repeat(60) + '.ts', mark: 'added', note: 'n'.repeat(60) }] },
        { kind: 'sources', items: [{ title: 'T'.repeat(100), url: 'https://example.com/' + 'u'.repeat(180), note: 'N'.repeat(80) }] },
        { kind: 'progress', value: 0.5, label: 'L'.repeat(60), note: 'n'.repeat(80) },
        { kind: 'metrics', items: [{ label: 'label', value: '1', delta: 'd'.repeat(40) }, { label: 'x', value: '2' }] },
        { kind: 'bars', unit: 'u'.repeat(10), items: [{ label: 'l'.repeat(30), value: 3.14159 }] },
        { kind: 'timeline', items: [{ when: 'w'.repeat(20), text: 't'.repeat(100) }] },
        { kind: 'steps', items: [{ text: 's'.repeat(120), state: 'doing', note: 'n'.repeat(80) }] },
        { kind: 'options', items: [{ title: 'o'.repeat(90), summary: 's'.repeat(140), pros: ['p'.repeat(80)], cons: ['c'.repeat(80)], pick: true }] },
        { kind: 'tags', items: ['t'.repeat(30), 'u'.repeat(30)] },
        { kind: 'diff', text: '+' + 'x'.repeat(200), file: 'f'.repeat(120) },
        { kind: 'quote', text: 'q'.repeat(200), by: 'b'.repeat(40) },
      ], { tone: 'warn', pin: true }),
    ],
  })
  for (const w of [...NARROW_WIDTHS, WIDE, TINY]) expect(widest(rows(stress, w))).toBeLessThanOrEqual(w)
})

test('order: status, title, why, ask, pinned cards, scenes, core lists, unpinned cards; empty sections omitted', () => {
  const out = rows(FIXTURE, 60).join('\n')
  const order = ['● working', 'Fix flaky uploads', 'Failures cluster', 'Claude needs you', '┃ Plan', '▣ Retry timing', '▣ Request flow', 'Known', 'Ruled out', 'To try', 'Failure rate', 'Notes']
  let at = -1
  for (const part of order) {
    const i = out.indexOf(part, at + 1)
    expect(i).toBeGreaterThan(at)
    at = i
  }
  expect(out).toMatch(/→ 1\. Add exponential backoff/)
  expect(out).toMatch(/✓ Reproduced the 503 flake/)

  const sparse = rows(state({ done: ['only done'] }), 50).join('\n')
  expect(sparse).toContain('Done')
  expect(sparse).not.toMatch(/Context|Next/)
})

test('labels override the three headings; "" or missing falls back to the default', () => {
  const s = state({ context: ['c'], done: ['d'], next: ['n'], labels: { context: 'Known', done: '', next: 'To try' } })
  const out = rows(s, 40)
  expect(out).toContain('Known')
  expect(out).toContain('Done')
  expect(out).toContain('To try')
  expect(out).not.toContain('Context')
  expect(rows(state({ context: ['c'], labels: { context: 'x'.repeat(40) } }), 60)).toContain('x'.repeat(23) + '…')
})

test('empty state is the status line and one quiet line', () => {
  const empty = state({ task: null })
  expect(rows(empty, 50)).toEqual(['● working', ' ', 'Waiting for Claude…'])
})

test('a card: bold title, tone = coloured gutter on every row, no title and no blocks = nothing', () => {
  const s = state({ cards: [card('a', [{ kind: 'text', text: 'body' }], { title: 'Card', tone: 'warn' }), card('b', [], {}), card('c', [{ kind: 'bogus' } as never])] })
  const out = rows(s, 40)
  const at = out.indexOf('┃ Card')
  expect(at).toBeGreaterThan(0)
  expect(out[at + 1]).toBe('┃ body')
  expect(out.join('\n')).not.toMatch(/bogus/)
  const colors = layout(s, 40).flatMap(l => l.filter(g => g.text === '┃ ').map(g => g.color))
  expect(colors).toEqual(['warning', 'warning'])
})

test('unknown or malformed blocks are skipped silently, the rest still draws', () => {
  const bad = [
    { kind: 'nope' }, null, 'text', 7, { kind: 'steps', items: 'x' }, { kind: 'progress', value: 'a' },
    { kind: 'kv', rows: [null, 5] }, { kind: 'tree', items: [{ path: 3 }] }, { kind: 'toString' }, { kind: 'constructor' },
    { kind: 'callout', tone: 'constructor', text: 'still ok' }, { kind: 'bars', items: [{ label: 'a', value: 'x' }] },
  ]
  for (const b of bad) expect(() => blockLines(b, 40)).not.toThrow()
  const s = state({ cards: [card('a', [...bad, { kind: 'text', text: 'survivor' }] as PanelBlock[])] })
  expect(rows(s, 40)).toContain('survivor')
})

test('footer: rev and url, the url gives way first, a hint leads', () => {
  const s = state({ rev: 7, url: 'http://127.0.0.1:4717' })
  expect(text(footer(s))).toBe('rev 7 · http://127.0.0.1:4717')
  expect(text(footer(s, 15))).toBe('rev 7')
  expect(text(footer(s, 24))).toMatch(/^rev 7 · open in .*/)
  expect(footer(s, 24).find(seg => seg.href !== undefined)?.href).toBe('http://127.0.0.1:4717')
  expect(footer(s).find(seg => seg.href !== undefined)?.href).toBe('http://127.0.0.1:4717')
  expect(text(footer(s, 45, '↓ 34 more'))).toBe('↓ 34 more · rev 7 · http://127.0.0.1:4717')
  expect(cellWidth(text(footer(s, 12, '↑ 100 · ↓ 100 more')))).toBeLessThanOrEqual(12)
  expect(text(footer(state({ rev: 3, url: null })))).toBe('rev 3')
})

test('windowTree: fits = plain tree plus footer; overflow = footer pinned on the last row of the window', () => {
  const s = state({ rev: 7, url: 'http://127.0.0.1:4717' })
  const content = Array.from({ length: 30 }, (_, i): Line => [{ text: `line ${i}` }])

  const fits = windowTree(content, s, 45, 0, 40)
  expect(fits.isOverflowing).toBe(false)
  expect(fits.tree).toHaveLength(31)
  expect(text(fits.tree.at(-1) as Line)).toBe('rev 7 · http://127.0.0.1:4717')

  const body = 10
  const treeRows = content.length + 1
  const lastOffset = treeRows - body
  const seen = new Set<string>()
  for (let o = 0; o <= lastOffset; o++) {
    const w = windowTree(content, s, 45, o, body)
    expect(w.tree).toHaveLength(treeRows)
    const view = w.tree.slice(o, o + body).map(text)
    expect(view).toHaveLength(body)
    expect(view.at(-1)).toMatch(/^.*rev 7 · /)
    expect(w.above).toBe(o)
    expect(w.below).toBe(content.length - (o + body - 1))
    // The visible content starts one row further on with every wheel step.
    expect(view[0]).toBe(`line ${o}`)
    for (const l of view.slice(0, -1)) seen.add(l)
  }
  expect(seen.size).toBe(content.length)

  // Past the end clamps like the engine does; negative clamps to the top.
  expect(windowTree(content, s, 45, 999, body).above).toBe(lastOffset)
  expect(windowTree(content, s, 45, -5, body).above).toBe(0)
})

test('scroll hint: top, middle, bottom', () => {
  expect(scrollHint(0, 34)).toBe('↓ 34 more')
  expect(scrollHint(12, 34)).toBe('↑ 12 · ↓ 34 more')
  expect(scrollHint(12, 0)).toBe('↑ 12 above')
  expect(scrollHint(0, 0)).toBe('')
})

test('the real fixture overflows a 20-row window and its priority content comes first', () => {
  const content = layout(FIXTURE, 45)
  const top = windowTree(content, FIXTURE, 45, 0, 20)
  const view = top.tree.slice(0, 20).map(text)
  expect(view[0]).toBe('● working')
  expect(view.some(l => l.includes('Claude needs you'))).toBe(true)
  expect(view.some(l => l.includes('┃ Plan'))).toBe(true)
  expect(view.at(-1)).toMatch(/^↓ \d+ more · rev 7/)
  expect(widest(view)).toBeLessThanOrEqual(45)
})

// --- scenes: the terminal faces ----------------------------------------------------------

const scene = (id: string, over: Partial<PanelScene> = {}): PanelScene => ({
  id,
  dir: `/tmp/${id}`,
  entry: 'index.html',
  alt: `The ${id} scene shows something that needs a sentence of words to say.`,
  span: 3,
  height: 420,
  rev: 1,
  ...over,
})
const withScenes = (...scenes: PanelScene[]): PanelState => state({ scenes })
const pictureOf = (width: number, height: number): Faces => new Map([['pic', { png: 'AAAA', width, height }]])
const imageSegs = (lines: readonly Line[]) => lines.flatMap(l => l.filter(g => g.image !== undefined))

test('a scene is `▣ title`, its art (dim), then a dim `↗ /panel open <id>`', () => {
  const art = FIXTURE.scenes[0]?.term?.art ?? []
  expect(art.length).toBeGreaterThan(0)
  for (const w of NARROW_WIDTHS) {
    const out = rows(FIXTURE, w)
    const at = out.indexOf('▣ Retry timing')
    expect(at, `width ${w}`).toBeGreaterThan(0)
    expect(out.slice(at + 1, at + 1 + art.length)).toEqual(art.map(l => fit(l, w)))
    expect(out[at + 1 + art.length]).toBe('↗ /panel open pulse')
  }
  const lines = layout(FIXTURE, 45)
  const at = lines.findIndex(l => text(l) === '▣ Retry timing')
  expect(lines[at]?.[1]?.isBold).toBe(true)
  expect(lines[at + 1]?.every(g => g.isDim === true)).toBe(true)
  expect(lines[at + 1 + art.length]?.every(g => g.isDim === true)).toBe(true)
})

test('no art: the alt text, wrapped; no title: the id; nothing is wider than the pane', () => {
  const s = withScenes(scene('orbit', { alt: FIXTURE.scenes[1]?.alt ?? '' }))
  for (const w of [...NARROW_WIDTHS, WIDE, TINY]) {
    const out = rows(s, w)
    expect(out, `width ${w}`).toContain('▣ orbit')
    const at = out.indexOf('▣ orbit')
    const body = out.slice(at + 1, out.indexOf('↗ /panel open orbit'))
    expect(body.length).toBeGreaterThan(0)
    expect(body.join(' ').replace(/\s+/g, ' ')).toContain('Dots travelling')
    expect(widest(out)).toBeLessThanOrEqual(w)
  }
})

test('art is clipped to the pane width, never wrapped; a long title is cut', () => {
  const s = withScenes(scene('wide', { title: 'T'.repeat(90), term: { art: ['#'.repeat(100), 'ok'] } }))
  const out = rows(s, 40)
  const at = out.findIndex(l => l.startsWith('▣ T'))
  expect(cellWidth(out[at] ?? '')).toBeLessThanOrEqual(40)
  expect(out[at]).toMatch(/…$/)
  expect(out[at + 1]).toBe(fit('#'.repeat(100), 40))
  expect(out[at + 2]).toBe('ok')
})

test('a readable PNG is the face: one marker row of the right size, blank rows under it, then the hint', () => {
  const s = withScenes(scene('pic', { title: 'Shot', term: { art: ['art that must not show'] } }))
  const faces = pictureOf(200, 100)
  const lines = layout(s, 40, faces)
  const [seg] = imageSegs(lines)
  const box = imageBox({ width: 200, height: 100 }, 40)
  expect(seg?.image).toEqual({ png: 'AAAA', columns: box.columns, rows: box.rows, alt: scene('pic').alt })
  const at = lines.findIndex(l => imageRows(l) > 0)
  expect(lines.slice(at + 1, at + box.rows).map(text)).toEqual(Array.from({ length: box.rows - 1 }, () => ''))
  expect(text(lines[at - 1] as Line)).toBe('▣ Shot')
  expect(text(lines[at + box.rows] as Line)).toBe('↗ /panel open pic')
  expect(rows(s, 40, faces).join('\n')).not.toContain('art that must not show')
  // a very tall picture is capped at 20 rows, a face for another scene is ignored
  expect(imageSegs(layout(s, 40, pictureOf(10, 1000)))[0]?.image?.rows).toBe(20)
  expect(imageSegs(layout(withScenes(scene('other')), 40, faces))).toEqual([])
})

test('pinned scenes come first, each group in the order given', () => {
  const s = withScenes(scene('a'), scene('b', { pin: true }), scene('c'), scene('d', { pin: true }))
  const marks = rows(s, 50).filter(l => l.startsWith('▣ '))
  expect(marks).toEqual(['▣ b', '▣ d', '▣ a', '▣ c'])
})

test('scenes sit after pinned cards and before the core lists; a scenes-only state is not empty', () => {
  const s = state({
    context: ['a fact'],
    cards: [card('p', [{ kind: 'text', text: 'pinned body' }], { pin: true }), card('q', [{ kind: 'text', text: 'loose body' }])],
    scenes: [scene('mid')],
  })
  const out = rows(s, 50).join('\n')
  const idx = ['pinned body', '▣ mid', 'Context', 'loose body'].map(p => out.indexOf(p))
  expect(idx.every(i => i >= 0)).toBe(true)
  expect(idx).toEqual([...idx].sort((x, y) => x - y))

  const only = state({ task: null, scenes: [scene('solo')] })
  expect(rows(only, 50).join('\n')).not.toContain('Waiting for Claude')
  expect(rows(only, 50)).toContain('▣ solo')
})

test('malformed scenes (an older or hand-edited state) are skipped or drawn plainly, never thrown on', () => {
  const broken = [null, 7, { id: 5 }, { id: 'ok-id', alt: 3, term: { art: [1, null, 'fine'] } }] as unknown as PanelScene[]
  expect(() => layout(state({ scenes: broken }), 40)).not.toThrow()
  expect(rows(state({ scenes: broken }), 40).filter(l => l.startsWith('▣ '))).toEqual(['▣ ok-id'])
  expect(() => layout(state({ scenes: 'nope' as never }), 40)).not.toThrow()
})

test('the pinned footer never lands inside a picture, at any scroll offset', () => {
  const s = state({ context: Array.from({ length: 20 }, (_, i) => `fact ${i}`), scenes: [scene('pic', { title: 'Shot' })] })
  const faces = pictureOf(100, 100)
  const content = layout(s, 40, faces)
  const box = imageBox({ width: 100, height: 100 }, 40)
  expect(box.rows).toBe(20)
  // A window at least as tall as the picture can always keep the footer out of it.
  const body = box.rows + 4
  expect(content.length).toBeGreaterThan(body)
  for (let offset = 0; offset <= content.length; offset++) {
    const w = windowTree(content, s, 40, offset, body)
    const at = w.tree.findIndex(l => imageRows(l) > 0)
    expect(at).toBeGreaterThan(-1)
    const under = w.tree.slice(at + 1, at + box.rows)
    expect(under, `offset ${offset}`).toHaveLength(box.rows - 1)
    expect(under.every(l => text(l) === ''), `offset ${offset}`).toBe(true)
  }
})
