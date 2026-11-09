import { expect, test } from 'claude-code/testing'

import { applyInput, emptyState } from '../hooks/state'
import type { ApplyResult } from '../hooks/state'
import type { PanelState } from '../types'

import { FIXTURE as fixture } from './fixture-data'

const NOW = 1_767_000_000_000
const FIXTURE_FIELDS = ['task', 'status', 'ask', 'choices', 'labels', 'context', 'done', 'next', 'cards'] as const

function ok(r: ApplyResult): { state: PanelState; trimmed: string[] } {
  if (!r.isOk) throw new Error(`expected ok, got: ${r.error}`)
  return r
}

const denial = (input: unknown): string => {
  const r = applyInput(emptyState(), input, NOW)
  return r.isOk ? 'ok' : r.error
}

/** A one-card input holding one block. */
const withBlock = (block: unknown) => ({ cards: [{ id: 'x', blocks: [block] }] })

test('the showcase fixture is accepted whole: no deny, nothing trimmed, state equals it', () => {
  const input = Object.fromEntries(FIXTURE_FIELDS.map(k => [k, fixture[k]]))
  const r = ok(applyInput(emptyState(), input, NOW))
  expect(r.trimmed).toEqual([])
  // The scenes are published by the `scene` tool, not the panel tool: see scene.test.ts.
  const { rev: _rev, updatedAt: _at, url: _url, scenes: _scenes, ...expected } = fixture
  const { rev: _r, updatedAt: _u, url: _l, scenes: _s, ...actual } = r.state
  expect(actual).toEqual(expected)
  expect(r.state.scenes).toEqual([])
})

// One bad field per block kind: the deny names the exact path.
const WORST_FIELD: [string, unknown, RegExp][] = [
  ['text', { kind: 'text', text: 3 }, /cards\[0\]\.blocks\[0\]\.text must be a string/],
  ['list', { kind: 'list', items: ['a', 2] }, /blocks\[0\]\.items\[1\] must be a string/],
  ['table', { kind: 'table', head: ['a'], rows: [['b'], 'c'] }, /blocks\[0\]\.rows\[1\] must be an array/],
  ['code', { kind: 'code', text: 'x', lang: 5 }, /blocks\[0\]\.lang must be a string/],
  ['callout', { kind: 'callout', tone: 'danger', text: 't' }, /blocks\[0\]\.tone must be one of info, warn, ok/],
  ['steps', { kind: 'steps', items: [{ text: 'a', state: 'todo' }, { text: 'b', state: 'doing' }, { text: 'c', state: 'nope' }] }, /blocks\[0\]\.items\[2\]\.state must be one of/],
  ['kv', { kind: 'kv', rows: [['k', 'v'], ['only']] }, /blocks\[0\]\.rows\[1\] must be \[key, value\]/],
  ['metrics', { kind: 'metrics', items: [{ label: 'l', value: '1', tone: 'info' }] }, /blocks\[0\]\.items\[0\]\.tone must be one of ok, warn, danger/],
  ['progress', { kind: 'progress', value: '0.5' }, /blocks\[0\]\.value must be a number/],
  ['diff', { kind: 'diff', text: ['x'] }, /blocks\[0\]\.text must be a string/],
  ['tree', { kind: 'tree', items: [{ path: 'a', mark: 'moved' }] }, /blocks\[0\]\.items\[0\]\.mark must be one of/],
  ['options', { kind: 'options', items: [{ title: 't', pick: 'yes' }] }, /blocks\[0\]\.items\[0\]\.pick must be a boolean/],
  ['timeline', { kind: 'timeline', items: [{ text: 'a', tone: 'info' }] }, /blocks\[0\]\.items\[0\]\.tone must be one of/],
  ['sources', { kind: 'sources', items: [{ title: 't', url: 5 }] }, /blocks\[0\]\.items\[0\]\.url must be a string/],
  ['bars', { kind: 'bars', items: [{ label: 'a', value: -1 }] }, /blocks\[0\]\.items\[0\]\.value must be >= 0/],
  ['tags', { kind: 'tags', items: 'a' }, /blocks\[0\]\.items must be an array of strings/],
  ['quote', { kind: 'quote', text: 'q', by: {} }, /blocks\[0\]\.by must be a string/],
]

test('every block kind denies its worst field with a precise path', () => {
  for (const [kind, block, pattern] of WORST_FIELD) {
    expect(denial(withBlock(block)), kind).toMatch(pattern)
  }
  expect(new Set(WORST_FIELD.map(([k]) => k)).size).toBe(17)
})

test('unknown kind, unknown key and non-object blocks are denied', () => {
  expect(denial(withBlock({ kind: 'chart' }))).toMatch(/cards\[0\]\.blocks\[0\]\.kind must be one of text, list/)
  expect(denial(withBlock({ kind: 'text', text: 't', bold: true }))).toMatch(/blocks\[0\]\.bold is not a known field/)
  expect(denial(withBlock({ kind: 'steps', items: [{ text: 'a', state: 'todo', icon: 'x' }] }))).toMatch(
    /blocks\[0\]\.items\[0\]\.icon is not a known field/,
  )
  expect(denial(withBlock('text'))).toMatch(/cards\[0\]\.blocks\[0\] must be an object/)
})

test('progress clamps to 0..1 and reports it', () => {
  const hi = ok(applyInput(emptyState(), withBlock({ kind: 'progress', value: 1.5 }), NOW))
  expect(hi.state.cards[0]?.blocks[0]).toEqual({ kind: 'progress', value: 1 })
  expect(hi.trimmed.join(' ')).toMatch(/blocks\[0\]\.value 1\.5 to 1/)
  const lo = ok(applyInput(emptyState(), withBlock({ kind: 'progress', value: -2 }), NOW))
  expect(lo.state.cards[0]?.blocks[0]).toEqual({ kind: 'progress', value: 0 })
})

test('sources: a non-http(s) url drops the url, not the item', () => {
  const r = ok(
    applyInput(
      emptyState(),
      withBlock({
        kind: 'sources',
        items: [
          { title: 'js', url: 'javascript:alert(1)', note: 'n' },
          { title: 'ok', url: 'https://example.com/a' },
          { title: 'ftp', url: 'ftp://example.com' },
        ],
      }),
      NOW,
    ),
  )
  expect(r.state.cards[0]?.blocks[0]).toEqual({
    kind: 'sources',
    items: [{ title: 'js', note: 'n' }, { title: 'ok', url: 'https://example.com/a' }, { title: 'ftp' }],
  })
  expect(r.trimmed.filter(t => t.includes('url dropped'))).toHaveLength(2)
})

test('over-cap items are truncated and reported, per kind', () => {
  const many = (n: number, mk: (i: number) => unknown) => Array.from({ length: n }, (_, i) => mk(i))
  const r = ok(
    applyInput(
      emptyState(),
      {
        cards: [
          {
            id: 'x',
            blocks: [
              { kind: 'steps', items: many(15, i => ({ text: `s${i}`, state: 'todo' })) },
              { kind: 'metrics', items: many(6, i => ({ label: `m${i}`, value: 'v'.repeat(20) })) },
              { kind: 'tags', items: many(12, i => `t${i}`) },
              { kind: 'diff', text: many(50, i => `+l${i}`).join('\n') },
              { kind: 'options', items: [{ title: 't', pros: ['a', 'b', 'c', 'd'] }] },
            ],
          },
        ],
      },
      NOW,
    ),
  )
  const [steps, metrics, tags, diff, options] = r.state.cards[0]?.blocks ?? []
  expect(steps?.kind === 'steps' && steps.items.length).toBe(12)
  expect(metrics?.kind === 'metrics' && metrics.items.length).toBe(4)
  expect(metrics?.kind === 'metrics' && metrics.items[0]?.value.length).toBe(12)
  expect(tags?.kind === 'tags' && tags.items.length).toBe(10)
  expect(diff?.kind === 'diff' && diff.text.split('\n').length).toBe(40)
  expect(options?.kind === 'options' && options.items[0]?.pros?.length).toBe(3)
  expect(r.trimmed.length).toBeGreaterThanOrEqual(6)
})
