// The visual pane's pure half: mode choice, hero order, the single picture, the controls row and the width rules (hooks/layout-visual.ts, hero.ts, outline.ts).
import { expect, test } from 'claude-code/testing'

import { heroCandidates, heroOf, switcherScenes } from '../hooks/hero'
import { layout } from '../hooks/layout'
import type { Faces, Line, LiveFace } from '../hooks/layout'
import { cellWidth } from '../hooks/layout-text'
import { SCROLL_ACTIONS, SCROLL_CONTROLS, SCROLL_KEY_PREFIX, SCROLL_KEYS_HINT } from '../hooks/layout-types'
import { IMAGE_MAX_COLUMNS } from '../hooks/png'
import { fillBox, HERO_MAX_ROWS, HERO_MIN_ROWS, heroBox, paneContent } from '../hooks/layout-visual'
import type { PaneContext } from '../hooks/layout-visual'
import { OUTLINE_TITLE_CHARS, outlineOf } from '../hooks/outline'
import { windowTree } from '../hooks/scroll'
import type { PanelScene, PanelState } from '../types'
import { FIXTURE } from './fixture-state'

const BODY_ROWS = 30
const SCROLL_KEYS = SCROLL_ACTIONS.map(a => `${SCROLL_KEY_PREFIX}${a}`)
const WIDTHS = [40, 41, 42, 43, 44, 45, 46, 47, 48, 80, 120] as const
const NARROW = 40
const FRAME = { width: 960, height: 540 }
const PNG = { png: 'AAAA', ...FRAME }

const text = (l: Line): string => l.map(s => s.text).join('')
const scene = (id: string, over: Partial<PanelScene> = {}): PanelScene => ({ id, dir: `/tmp/${id}`, alt: `Alt of ${id}.`, rev: 1, ...over })
const stage = (id: string, over: Partial<PanelScene> = {}): PanelScene => scene(id, { layout: 'stage', ...over })
const state = (over: Partial<PanelState> = {}): PanelState => ({
  ...FIXTURE,
  task: { title: 'Fix flaky uploads', why: 'Because retries.' },
  ask: null,
  choices: [],
  labels: {},
  context: ['a fact'],
  done: [],
  next: [],
  cards: [],
  scenes: [stage('deck')],
  ...over,
})
const facesOf = (...ids: string[]): Faces => new Map(ids.map(id => [id, PNG]))
const ctx = (over: Partial<PaneContext> = {}): PaneContext => ({ canDraw: true, faces: facesOf('deck'), extras: {}, ...over })
const content = (s: PanelState, c: PaneContext = ctx(), width = 45, rows = BODY_ROWS): Line[] => paneContent(s, width, rows, c)
const texts = (s: PanelState, c?: PaneContext, width?: number): string[] => content(s, c, width).map(text)
const pictures = (lines: readonly Line[]) => lines.flatMap(l => l.flatMap(seg => (seg.image === undefined ? [] : [seg.image])))
const buttonsOf = (lines: readonly Line[]) => lines.flatMap(l => l.flatMap(seg => (seg.button === undefined ? [] : [seg.button])))
const live = (sceneId: string): LiveFace => ({ sceneId, file: '/tmp/f.png', generation: 1, ...FRAME })

test('mode: the visual layout needs a terminal that draws images AND a scene; otherwise the text layout, unchanged', () => {
  const s = state({ scenes: [stage('deck')] })
  expect(content(s, ctx({ canDraw: false, faces: new Map() })).map(text)).toEqual(layout(s, 45, new Map(), {}).map(text))
  const none = state({ scenes: [] })
  expect(content(none).map(text)).toEqual(layout(none, 45, new Map(), {}).map(text))
  expect(pictures(content(s))).toHaveLength(1)
  // A card scene with no face image cannot be the hero either.
  const card = state({ scenes: [scene('viz')] })
  expect(content(card).map(text)).toEqual(layout(card, 45, new Map(), {}).map(text))
})

test('visual mode is the picture and nothing else: no header, no task, no outline, no sections, no details button', () => {
  const s = state({
    task: { title: 'TASK-TITLE', why: 'WHY-TEXT' },
    context: ['CONTEXT-FACT'],
    done: ['DONE-THING'],
    next: ['NEXT-THING'],
    cards: [{ id: 'c', title: 'AGENTS-CARD', blocks: [{ kind: 'text', text: 'x' }] }],
    scenes: [stage('deck'), stage('mission', { title: 'Mission control' })],
  })
  const lines = content(s, ctx({ extras: { live: live('deck'), outlines: new Map([['deck', ['One', 'Two']]]) } }))
  const rows = lines.map(text)
  expect(rows.join('\n')).not.toMatch(/TASK-TITLE|WHY-TEXT|CONTEXT-FACT|DONE-THING|NEXT-THING|AGENTS-CARD|Mission control|working|1 One|details/)
  expect(lines.findIndex(l => l.some(seg => seg.image !== undefined))).toBe(0) // the picture is the first row
  // The only text rows are the controls (this is a deck with a second scene); with the board alone there are none.
  expect(lines.filter(l => l.every(seg => seg.image === undefined)).map(text).filter(r => r !== '')).toEqual(['[ ◀ ] [ ▶ ] [ ▸ deck ] [ mission ]'])
  const alone = content(state({ scenes: [stage('board', { builtin: true })] }), ctx({ faces: facesOf('board') }))
  expect(alone.filter(l => l.every(seg => seg.image === undefined)).map(text).filter(r => r !== '')).toEqual([]) // the rest of the picture's rows are blank placeholders
  expect(buttonsOf(alone)).toEqual([])
})

test('hero order: the board (default), the model\'s stage scenes, then a card with a face image; other built-ins are never heroes', () => {
  const user = stage('mine')
  const board = stage('board', { builtin: true })
  const stale = stage('pulse', { builtin: true })
  const card = scene('shot', { term: { image: '/tmp/shot.png' } })
  const st = (...scenes: PanelScene[]) => state({ scenes })
  expect(heroOf(st(user, board, card))?.id).toBe('board')
  expect(heroOf(st(board))?.id).toBe('board')
  expect(heroOf(st(card, user))?.id).toBe('mine')
  expect(heroOf(st(card, scene('plain')))?.id).toBe('shot')
  expect(heroOf(st(scene('plain')))).toBeUndefined()
  expect(heroOf(st(stale))).toBeUndefined()
  expect(heroCandidates([card, user, stale, board]).map(x => x.id)).toEqual(['board', 'mine', 'shot'])
  // The picked scene wins while it exists; a gone pick (a removed scene) falls back to the board.
  expect(heroOf(st(board, user), 'mine')?.id).toBe('mine')
  expect(heroOf(st(board), 'mine')?.id).toBe('board')
  expect(heroOf(st(board, user), 'gone')?.id).toBe('board')
})

test('the switcher: nothing for the board alone; `board` plus every scene of the model\'s; never another built-in', () => {
  const board = stage('board', { builtin: true })
  const ids = (...scenes: PanelScene[]) => switcherScenes(scenes).map(x => x.id)
  expect(ids(board)).toEqual([])
  expect(ids(board, stage('pulse', { builtin: true }))).toEqual([])
  expect(ids(board, stage('mine'))).toEqual(['board', 'mine'])
  expect(ids(stage('mine'), board, stage('pulse', { builtin: true }), scene('shot', { term: { image: '/tmp/s.png' } }))).toEqual(['board', 'mine', 'shot'])
  expect(ids(stage('mine'))).toEqual([]) // one candidate: nothing to switch to
  expect(ids(stage('a'), stage('b'))).toEqual(['a', 'b'])
})

test('one picture only, whatever the number of scenes; the other scenes\' pictures are not drawn', () => {
  const scenes = [stage('deck'), stage('mission'), stage('pulse', { builtin: true }), scene('shot', { term: { image: '/tmp/s.png' } })]
  const s = state({ scenes })
  const lines = content(s, ctx({ faces: facesOf('deck', 'mission', 'pulse', 'shot') }))
  expect(pictures(lines)).toHaveLength(1)
  expect(pictures(lines)[0]?.alt).toBe('Alt of deck.')
  const other = content(s, ctx({ faces: facesOf('deck', 'mission', 'pulse', 'shot'), heroId: 'mission' }))
  expect(pictures(other)).toHaveLength(1)
  expect(pictures(other)[0]?.alt).toBe('Alt of mission.')
  // The picture is on one line and the rest of its rows are placeholders, so rows add up.
  expect(pictures(lines)[0]?.rows).toBeGreaterThanOrEqual(HERO_MIN_ROWS)
})

test('a pending ask stays visible in the visual layout: the box, its choice buttons, above the picture', () => {
  const s = state({ ask: 'Which fix?', choices: [{ id: 'a', label: 'Fix A' }, { id: 'b', label: 'Fix B' }] })
  const lines = content(s)
  const rows = lines.map(text)
  expect(rows).toContain('╭─ Claude needs you')
  expect(rows).toContain('│ Which fix?')
  expect(buttonsOf(lines).filter(b => b.key.startsWith('answer:'))).toEqual([
    { key: 'answer:a', label: 'Fix A' },
    { key: 'answer:b', label: 'Fix B' },
  ])
  const pictureAt = lines.findIndex(l => l.some(seg => seg.image !== undefined))
  expect(rows.indexOf('╰─')).toBeLessThan(pictureAt)
})

test('the controls row: slide buttons only for a deck (a live view of a page with slides); a scene switcher only with a scene of the model\'s', () => {
  const one = state({ scenes: [stage('deck')] })
  const keys = (lines: readonly Line[]) => buttonsOf(lines).map(b => b.key).filter(k => k !== 'details')
  const deckOutline = new Map([['deck', ['One', 'Two']]])
  expect(keys(content(one))).toEqual([])
  expect(keys(content(one, ctx({ extras: { live: live('deck') } })))).toEqual(SCROLL_KEYS) // live but no slides: no slide buttons, the scroll buttons instead
  expect(keys(content(one, ctx({ extras: { live: live('deck'), outlines: deckOutline } })))).toEqual(['live:prev', 'live:next'])

  const two = state({ scenes: [stage('deck'), stage('mission')] })
  const lines = content(two, ctx({ extras: { live: live('deck'), outlines: deckOutline } }))
  expect(buttonsOf(lines).filter(b => b.key !== 'details')).toEqual([
    { key: 'live:prev', label: '◀' },
    { key: 'live:next', label: '▶' },
    { key: 'hero:deck', label: '▸ deck' },
    { key: 'hero:mission', label: 'mission' },
  ])
  expect(lines.map(text)).toContain('[ ◀ ] [ ▶ ] [ ▸ deck ] [ mission ]')
  // The mark follows the pick.
  expect(buttonsOf(content(two, ctx({ heroId: 'mission' }))).filter(b => b.key.startsWith('hero:')).map(b => b.label)).toEqual(['deck', '▸ mission'])

  // The board alone: no switcher row at all, and no slide buttons (the board is no deck).
  const board = stage('board', { builtin: true })
  const alone = state({ scenes: [board] })
  expect(keys(content(alone, ctx({ faces: facesOf('board'), extras: { live: live('board') } })))).toEqual(SCROLL_KEYS)
  // The board and a scene of the model's: `[ board ] [ deck ]`, the board active; never the other built-ins.
  const both = state({ scenes: [board, stage('pulse', { builtin: true }), stage('deck')] })
  const c = ctx({ faces: facesOf('board', 'deck') })
  expect(content(both, c).map(text)).toContain('[ ▸ board ] [ deck ]')
  expect(buttonsOf(content(both, c)).filter(b => b.key.startsWith('hero:'))).toEqual([
    { key: 'hero:board', label: '▸ board' },
    { key: 'hero:deck', label: 'deck' },
  ])
  // Picking the deck (what a published stage scene does) makes it the picture and moves the mark.
  expect(buttonsOf(content(both, ctx({ faces: facesOf('board', 'deck'), heroId: 'deck' }))).filter(b => b.key.startsWith('hero:')).map(b => b.label)).toEqual(['board', '▸ deck'])
})

test('many scenes wrap onto more control rows instead of passing the width', () => {
  const scenes = ['alpha-deck', 'bravo-board', 'charlie-view', 'delta-pulse'].map(id => stage(id))
  for (const width of [NARROW, 45]) {
    const rows = texts(state({ scenes }), ctx({ extras: { live: live('alpha-deck') } }), width)
    expect(Math.max(...rows.map(cellWidth))).toBeLessThanOrEqual(width)
    expect(rows.filter(r => r.includes('['))).toHaveLength(rows.filter(r => r.startsWith('[')).length)
  }
})

test('outlineOf: entities are decoded, tags dropped, whitespace collapsed, empty titles ignored', () => {
  const html = `<section data-title="Panel v4 &middot; live &amp; fast"></section>
    <section><h2>  A &lt;b&gt; &quot;q&quot; &#39;s&#39;<br>&nbsp;tail&#8212;&#x2014; </h2></section>
    <section data-title="   "></section><section><p>no heading</p></section><section data-title="&unknown; stays"></section>`
  expect(outlineOf(html)).toEqual(['Panel v4 · live & fast', 'A <b> "q" \'s\' tail——', '&unknown; stays'])
  expect(outlineOf(`<section data-title="${'é'.repeat(100)}"></section>`)[0]?.length).toBe(OUTLINE_TITLE_CHARS)
})

test('outlineOf: a page with no `<section` (a dashboard) has no outline even with headings and entities', () => {
  expect(outlineOf('<h1>Panel v4 &middot; live build Mission control</h1><h2>Agents</h2>')).toEqual([])
})

test('the scroll buttons: the live picture (never a deck) gets them, each with its hotkey; the footer names the keys in one short line', () => {
  const one = state({ scenes: [stage('deck')] })
  const lines = content(one, ctx({ extras: { live: live('deck') } }))
  const scrolls = buttonsOf(lines).filter(b => b.key.startsWith(SCROLL_KEY_PREFIX))
  expect(scrolls.map(b => b.key)).toEqual(SCROLL_KEYS)
  const hotkeys = lines.flat().flatMap(seg => (seg.button?.hotkey === undefined ? [] : [seg.button.hotkey]))
  expect(hotkeys).toEqual(SCROLL_ACTIONS.map(a => SCROLL_CONTROLS[a].hotkey))
  expect(new Set(hotkeys).size).toBe(hotkeys.length) // one key, one action
  for (const k of hotkeys) expect(k).toMatch(/^[a-z0-9]$/) // what a Button hotkey accepts
  const deck = content(one, ctx({ extras: { live: live('deck'), outlines: new Map([['deck', ['One', 'Two']]]) } }))
  expect(buttonsOf(deck).some(b => b.key.startsWith(SCROLL_KEY_PREFIX))).toBe(false)
  expect(buttonsOf(content(one)).some(b => b.key.startsWith(SCROLL_KEY_PREFIX))).toBe(false) // no live picture: nothing to scroll

  const foot = (hint: string, rows: number, find: string): string | undefined =>
    windowTree(lines, one, 45, 0, rows, hint).tree.map(text).find(l => l.includes(find))
  expect(foot(SCROLL_KEYS_HINT, 99, 'rev ')).toContain(SCROLL_KEYS_HINT)
  expect(foot('', 99, 'rev ')).not.toContain(SCROLL_KEYS_HINT)
  expect(cellWidth(SCROLL_KEYS_HINT)).toBeLessThanOrEqual(35)
  expect(cellWidth(foot(SCROLL_KEYS_HINT, 99, 'rev ') ?? '')).toBeLessThanOrEqual(45)
  expect(foot(SCROLL_KEYS_HINT, 4, 'j/k')).toBeDefined() // overflowing: the hint rides next to the scroll position (cut to the width)
})
