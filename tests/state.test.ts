import { expect, test } from 'claude-code/testing'

import { footer, layout, wrapText } from '../hooks/layout'
import { applyInput, BLOCK_CAPS, CAPS, emptyState, isEmptyState, parsePort, resultLine, withUrl } from '../hooks/state'
import type { ApplyResult } from '../hooks/state'
import type { PanelState } from '../types'

const NOW = 1_767_000_000_000

function ok(r: ApplyResult): { state: PanelState; trimmed: string[] } {
  if (!r.isOk) throw new Error(`expected ok, got: ${r.error}`)
  return r
}

test('each given key replaces its section, the rest stay', () => {
  const a = ok(
    applyInput(
      emptyState(),
      { task: { title: 'Add retry', why: '503s' }, context: ['a', 'b'], next: ['x'] },
      NOW,
    ),
  )
  expect(a.state.rev).toBe(1)
  expect(a.state.updatedAt).toBe(NOW)
  expect(a.state.task).toEqual({ title: 'Add retry', why: '503s' })
  const b = ok(applyInput(a.state, { context: ['only'], status: 'waiting' }, NOW))
  expect(b.state.context).toEqual(['only'])
  expect(b.state.next).toEqual(['x'])
  expect(b.state.status).toBe('waiting')
  expect(b.state.rev).toBe(2)
})

test('done_add appends and keeps the newest', () => {
  const eleven = Array.from({ length: 11 }, (_, i) => `step ${i + 1}`)
  const r = ok(applyInput(emptyState(), { done_add: eleven }, NOW))
  expect(r.state.done).toHaveLength(CAPS.DONE_ITEMS)
  expect(r.state.done.at(-1)).toBe('step 11')
  expect(r.state.done[0]).toBe('step 4')
  expect(r.trimmed.join(' ')).toMatch(/done 11 to 8/)
  const r2 = ok(applyInput(r.state, { done_add: ['step 12'] }, NOW))
  expect(r2.state.done.at(-1)).toBe('step 12')
  expect(r2.state.done).toHaveLength(CAPS.DONE_ITEMS)
})

test('caps trim and the result line says what was cut', () => {
  const r = ok(
    applyInput(
      emptyState(),
      {
        task: { title: 'x'.repeat(200), why: 'y'.repeat(300) },
        context: Array.from({ length: 9 }, (_, i) => `c${i}`),
        cards: Array.from({ length: 10 }, (_, i) => ({
          id: `k${i}`,
          blocks: [
            {
              kind: 'table',
              head: ['a', 'b', 'c', 'd', 'e', 'f'],
              rows: Array.from({ length: 12 }, () => ['1', '2', '3', '4', '5', '6']),
            },
            { kind: 'code', text: Array.from({ length: 40 }, (_, i) => `l${i}`).join('\n') },
          ],
        })),
      },
      NOW,
    ),
  )
  const s = r.state
  expect(s.task?.title).toHaveLength(CAPS.TITLE_CHARS)
  expect(s.task?.why).toHaveLength(CAPS.WHY_CHARS)
  expect(s.context).toHaveLength(CAPS.CONTEXT_ITEMS)
  expect(s.cards).toHaveLength(CAPS.CARDS)
  const table = s.cards[0]?.blocks[0]
  expect(table?.kind === 'table' && table.head.length).toBe(BLOCK_CAPS.TABLE_COLS)
  expect(table?.kind === 'table' && table.rows.length).toBe(BLOCK_CAPS.TABLE_ROWS)
  expect(table?.kind === 'table' && table.rows[0]?.length).toBe(BLOCK_CAPS.TABLE_COLS)
  const code = s.cards[0]?.blocks[1]
  expect(code?.kind === 'code' && code.text.split('\n').length).toBe(BLOCK_CAPS.CODE_LINES)
  const line = resultLine(withUrl(s, 'http://127.0.0.1:4717', NOW), r.trimmed)
  expect(line).toMatch(
    /^panel rev 2 · cards: k0, k1, k2, k3, k4, k5, k6, k7 · http:\/\/127\.0\.0\.1:4717 · trimmed: .*context 9 to 6.*cards 10 to 8/,
  )
})

test('ask: "" clears, clear resets everything but url and rev', () => {
  const a = ok(applyInput(withUrl(emptyState(), 'http://u', NOW), { ask: 'Which?', next: ['n'] }, NOW))
  expect(a.state.ask).toBe('Which?')
  expect(ok(applyInput(a.state, { ask: '' }, NOW)).state.ask).toBeNull()
  const c = ok(applyInput(a.state, { clear: true, context: ['k'] }, NOW))
  expect(c.state.ask).toBeNull()
  expect(c.state.next).toEqual([])
  expect(c.state.context).toEqual(['k'])
  expect(c.state.url).toBe('http://u')
  expect(c.state.rev).toBe(a.state.rev + 1)
})

test('invalid input names the field', () => {
  const bad = (input: unknown): string => {
    const r = applyInput(emptyState(), input, NOW)
    return r.isOk ? 'ok' : r.error
  }
  expect(bad('nope')).toMatch(/input must be an object/)
  expect(bad({ status: 'busy' })).toMatch(/status must be one of/)
  expect(bad({ task: { why: 'no title' } })).toMatch(/task\.title must be a string/)
  expect(bad({ context: 'a' })).toMatch(/context must be an array/)
  expect(bad({ next: ['ok', 3] })).toMatch(/next\[1\] must be a string/)
  expect(bad({ canvas: [{ blocks: [{ kind: 'chart' }] }] })).toMatch(/canvas\[0\]\.blocks\[0\]\.kind/)
  expect(bad({ cards: [{ id: 'a', blocks: [{ kind: 'chart' }] }] })).toMatch(/cards\[0\]\.blocks\[0\]\.kind/)
  expect(bad({ canvas: [{ blocks: [{ kind: 'table', head: ['a'], rows: ['x'] }] }] })).toMatch(
    /canvas\[0\]\.blocks\[0\]\.rows\[0\]/,
  )
  expect(bad({ canvas: [{ blocks: [{ kind: 'callout', tone: 'loud', text: 't' }] }] })).toMatch(/tone/)
  expect(bad({ dones: [] })).toMatch(/unknown field "dones"/)
})

test('parsePort reads the PORT line, even split over pieces', () => {
  expect(parsePort('PORT 4717\n')).toBe(4717)
  expect(parsePort('noise\nPORT 4718\r\n')).toBe(4718)
  expect(parsePort('PORT 47')).toBeNull()
  expect(parsePort('POR')).toBeNull()
  expect(parsePort('PORT 99999\n')).toBeNull()
  expect(parsePort('PORT 12abc\n')).toBeNull()
})

test('wrapText wraps words, keeps paragraphs, breaks long words', () => {
  expect(wrapText('aaa bbb ccc', 7)).toEqual(['aaa bbb', 'ccc'])
  expect(wrapText('one\n\ntwo', 10)).toEqual(['one', '', 'two'])
  expect(wrapText('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij'])
})

test('layout: empty state is one quiet line, full state has every section in order', () => {
  const text = (s: PanelState, cols = 50): string =>
    layout(s, cols).map(l => l.map(seg => seg.text).join('')).join('\n')
  expect(text(emptyState())).toBe('● working\n \nWaiting for Claude…')

  const s = ok(
    applyInput(
      emptyState(),
      {
        task: { title: 'Title', why: 'Because' },
        ask: 'Pick one',
        context: ['ctx'],
        done: ['old', 'new'],
        next: ['first', 'second'],
        canvas: [
          {
            title: 'Options',
            blocks: [
              { kind: 'table', head: ['Option', 'Cost'], rows: [['Client retry', 'S']] },
              { kind: 'callout', tone: 'warn', text: 'careful' },
            ],
          },
        ],
      },
      NOW,
    ),
  ).state
  const out = text(s)
  const order = ['working', 'Title', 'Because', 'Claude needs you', 'Pick one', 'Context', 'Done', 'Next', 'Options', 'Client retry', 'careful']
  let at = -1
  for (const part of order) {
    const i = out.indexOf(part, at + 1)
    expect(i).toBeGreaterThan(at)
    at = i
  }
  expect(out).toMatch(/→ 1\. first/)
  expect(out).toMatch(/✓ new/)
  expect(out).toMatch(/Option\s+Cost/)
})

test('footer: rev N, and the url once the server has one', () => {
  const foot = (s: PanelState): string => footer(s).map(seg => seg.text).join('')
  expect(foot(emptyState())).toBe('rev 0')
  expect(foot(withUrl(emptyState(), 'http://u', NOW))).toBe('rev 1 · http://u')
})

const card = (id: string, text = id) => ({ id, blocks: [{ kind: 'text', text }] })

test('v4: emptyState has labels {}, choices [], cards [] and scenes []', () => {
  const s = emptyState()
  expect(s.v).toBe(4)
  expect(s.labels).toEqual({})
  expect(s.choices).toEqual([])
  expect(s.cards).toEqual([])
  expect(s.scenes).toEqual([])
})

test('cards replace all, [] clears; the result line lists the ids', () => {
  const a = ok(applyInput(withUrl(emptyState(), 'http://u', NOW), { cards: [card('plan'), card('risks')] }, NOW))
  expect(a.state.cards.map(c => c.id)).toEqual(['plan', 'risks'])
  expect(resultLine(a.state, a.trimmed)).toBe('panel rev 2 · cards: plan, risks · http://u')
  const b = ok(applyInput(a.state, { cards: [card('only')] }, NOW))
  expect(b.state.cards.map(c => c.id)).toEqual(['only'])
  expect(ok(applyInput(b.state, { cards: [] }, NOW)).state.cards).toEqual([])
})

test('card upserts by id: keeps position, appends when new', () => {
  const a = ok(applyInput(emptyState(), { cards: [card('a'), card('b'), card('c')] }, NOW))
  const b = ok(applyInput(a.state, { card: card('b', 'changed') }, NOW))
  expect(b.state.cards.map(c => c.id)).toEqual(['a', 'b', 'c'])
  expect(b.state.cards[1]?.blocks[0]).toEqual({ kind: 'text', text: 'changed' })
  const c = ok(applyInput(b.state, { card: card('d') }, NOW))
  expect(c.state.cards.map(x => x.id)).toEqual(['a', 'b', 'c', 'd'])
})

test('a new card past the cap is denied, not silently dropped', () => {
  const full = ok(applyInput(emptyState(), { cards: Array.from({ length: 8 }, (_, i) => card(`k${i}`)) }, NOW))
  const r = applyInput(full.state, { card: card('extra') }, NOW)
  expect(r.isOk ? 'ok' : r.error).toMatch(/card: already 8 cards/)
  expect(ok(applyInput(full.state, { card: card('k3', 'x') }, NOW)).state.cards).toHaveLength(8)
})

test('card_remove takes an id or ids; unknown ids are ignored', () => {
  const a = ok(applyInput(emptyState(), { cards: [card('a'), card('b'), card('c')] }, NOW))
  const b = ok(applyInput(a.state, { card_remove: 'b' }, NOW))
  expect(b.state.cards.map(c => c.id)).toEqual(['a', 'c'])
  const c = ok(applyInput(b.state, { card_remove: ['a', 'zzz'] }, NOW))
  expect(c.state.cards.map(x => x.id)).toEqual(['c'])
  const d = ok(applyInput(c.state, { card_remove: ['c'], card: card('n') }, NOW))
  expect(d.state.cards.map(x => x.id)).toEqual(['n'])
})

test('canvas is an alias of cards: groups without an id get c1, c2, ...', () => {
  const r = ok(
    applyInput(
      emptyState(),
      { canvas: [{ title: 'One', blocks: [] }, { id: 'mine', blocks: [] }, { blocks: [] }] },
      NOW,
    ),
  )
  expect(r.state.cards).toEqual([
    { id: 'c1', title: 'One', blocks: [] },
    { id: 'mine', blocks: [] },
    { id: 'c3', blocks: [] },
  ])
  const both = applyInput(emptyState(), { canvas: [], cards: [] }, NOW)
  expect(both.isOk).toBe(false)
})

test('labels merge, "" removes one override, > 24 chars is trimmed', () => {
  const a = ok(applyInput(emptyState(), { labels: { context: 'Known', done: 'Ruled out' } }, NOW))
  expect(a.state.labels).toEqual({ context: 'Known', done: 'Ruled out' })
  const b = ok(applyInput(a.state, { labels: { next: 'To try', done: '' } }, NOW))
  expect(b.state.labels).toEqual({ context: 'Known', next: 'To try' })
  expect(ok(applyInput(b.state, { labels: {} }, NOW)).state.labels).toEqual(b.state.labels)
  const c = ok(applyInput(b.state, { labels: { context: 'x'.repeat(40) } }, NOW))
  expect(c.state.labels.context).toHaveLength(CAPS.LABEL_CHARS)
  expect(c.trimmed.join(' ')).toMatch(/labels\.context to 24 chars/)
  const bad = applyInput(b.state, { labels: { later: 'x' } }, NOW)
  expect(bad.isOk ? 'ok' : bad.error).toMatch(/labels\.later/)
})

test('clear resets labels and cards too', () => {
  const a = ok(applyInput(emptyState(), { labels: { done: 'D' }, cards: [card('a')] }, NOW))
  const c = ok(applyInput(a.state, { clear: true }, NOW))
  expect(c.state.labels).toEqual({})
  expect(c.state.cards).toEqual([])
})

test('card fields are checked: id, span, tone, pin, title, unknown key, duplicates', () => {
  const bad = (c: unknown): string => {
    const r = applyInput(emptyState(), { cards: [c] }, NOW)
    return r.isOk ? 'ok' : r.error
  }
  expect(bad({ id: 'Bad Id', blocks: [] })).toMatch(/cards\[0\]\.id/)
  expect(bad({ id: 'a'.repeat(25), blocks: [] })).toMatch(/cards\[0\]\.id/)
  expect(bad({ id: 'a', span: 4, blocks: [] })).toMatch(/cards\[0\]\.span/)
  expect(bad({ id: 'a', tone: 'loud', blocks: [] })).toMatch(/cards\[0\]\.tone/)
  expect(bad({ id: 'a', pin: 'yes', blocks: [] })).toMatch(/cards\[0\]\.pin/)
  expect(bad({ id: 'a', blocks: {} })).toMatch(/cards\[0\]\.blocks must be an array/)
  expect(bad({ id: 'a', color: 'red', blocks: [] })).toMatch(/cards\[0\]\.color is not a known field/)
  const dup = applyInput(emptyState(), { cards: [card('a'), card('a')] }, NOW)
  expect(dup.isOk ? 'ok' : dup.error).toMatch(/cards\[1\]\.id "a" is used twice/)
  const long = ok(applyInput(emptyState(), { cards: [{ id: 'a', title: 't'.repeat(90), span: 2, pin: true, tone: 'danger', blocks: Array.from({ length: 10 }, () => ({ kind: 'text', text: 'x' })) }] }, NOW))
  expect(long.state.cards[0]?.title).toHaveLength(CAPS.CARD_TITLE_CHARS)
  expect(long.state.cards[0]?.blocks).toHaveLength(CAPS.BLOCKS_PER_CARD)
  expect(long.state.cards[0]).toMatchObject({ span: 2, pin: true, tone: 'danger' })
  expect(long.trimmed.join(' ')).toMatch(/cards\[0\]\.blocks 10 to 8/)
})

test('a state with only a scene is not empty; clear on the panel tool leaves the scenes', () => {
  const scene = { id: 's', dir: '/tmp/s', entry: 'index.html', alt: 'a', span: 3 as const, height: 420, rev: 1 }
  const withScene: PanelState = { ...emptyState(), scenes: [scene] }
  expect(isEmptyState(emptyState())).toBe(true)
  expect(isEmptyState(withScene)).toBe(false)
  const c = ok(applyInput(withScene, { clear: true }, NOW))
  expect(c.state.scenes).toEqual([scene])
})
