// The kind of work of a tool call: the table (every row), the folder zones, the privacy of the targets and the spans.
// (That the page's KIND_META is the mod's is checked by web/builtin/board/kind-meta.test.mjs: a plugin test cannot import() a file.)
import { expect, test } from 'claude-code/testing'

import { zoneOf } from '../hooks/pulse-redact'
import { INSIGHT_KINDS, KIND_META, KIND_ORDER, WORK_KINDS, fileKind, kindOf, kindOfLetter } from '../hooks/work-kinds'
import { addSpan, extendSpan, restoreSpans, segmentsOf, SPAN_CAPS, timeByKind } from '../hooks/work-spans'
import type { Span } from '../hooks/work-spans'

const kind = (tool: string, target = '', zone = ''): string | undefined => kindOf({ tool, target, zone })

test('kindOf: editing a file is ui, logic, tests or docs by its extension and zone', () => {
  for (const f of ['board.css', 'index.html', 'logo.svg', 'Card.tsx', 'App.jsx']) expect(kind('Edit', f)).toBe('ui')
  expect(kind('Write', 'lanes.js', 'ui')).toBe('ui') // web/**/*.js
  expect(kind('Edit', 'lanes.mjs', 'ui')).toBe('ui')
  for (const f of ['agent-insight.ts', 'x.mjs', 'x.js', 'x.py', 'x.go']) expect(kind('Edit', f)).toBe('logic')
  expect(kind('MultiEdit', 'hooks.ts')).toBe('logic')
  for (const f of ['a.test.ts', 'a.spec.js', 'test_a.py', 'a_test.go', 'board.test.tsx']) expect(kind('Edit', f)).toBe('tests') // a test file of any kind
  expect(kind('Edit', 'helper.ts', 'tests')).toBe('tests') // tests/**
  expect(kind('Edit', 'data.json', 'tests')).toBe('working') // a fixture is no test code
  for (const f of ['README.md', 'SKILL.md', 'notes.txt', 'readme', 'CHANGELOG.md']) expect(kind('Write', f)).toBe('docs')
  expect(kind('Edit', 'config.json')).toBe('working') // unknown stays neutral
  expect(kind('Edit', '')).toBe('working')
  expect(fileKind('Makefile', '')).toBe('working')
})

test('kindOf: reading, searching, the web, delegating, browsers and scenes, the shell', () => {
  expect(kind('Read', 'a.ts')).toBe('reading')
  expect(kind('Read', 'a.md')).toBe('reading')
  for (const f of ['a.png', 'b.JPG', 'c.jpeg', 'd.gif', 'e.webp']) expect(kind('Read', f)).toBe('visual')
  for (const t of ['Grep', 'Glob', 'LS']) expect(kind(t)).toBe('reading')
  expect(kind('WebSearch', '12 chars')).toBe('research')
  expect(kind('WebFetch', 'docs.x.io')).toBe('research')
  for (const t of ['Agent', 'Task', 'SendMessage']) expect(kind(t)).toBe('delegating')
  expect(kind('spawn', 'ag-2')).toBe('delegating')
  expect(kind('mcp__claude-in-chrome__computer')).toBe('visual')
  expect(kind('mcp__claude-in-chrome__navigate')).toBe('visual')
  expect(kind('mcp__panel__scene')).toBe('visual')
  expect(kind('Bash', 'tsc')).toBe('tests')
  expect(kind('Bash', 'npm test')).toBe('tests')
  expect(kind('Bash', 'node test')).toBe('tests') // node --test
  expect(kind('Bash', 'claude test')).toBe('tests')
  expect(kind('Bash', 'npm lint')).toBe('tests')
  expect(kind('Bash', 'pytest')).toBe('tests')
  expect(kind('Bash', 'node render')).toBe('visual')
  expect(kind('Bash', 'screencapture')).toBe('visual')
  expect(kind('Bash', 'google-chrome')).toBe('visual')
  expect(kind('Bash', 'render-board.sh')).toBe('visual')
  expect(kind('Bash', 'cat')).toBe('reading')
  expect(kind('Bash', 'git')).toBe('working')
  expect(kind('Bash', 'node')).toBe('working')
  expect(kind('Bash', 'npm build')).toBe('working')
  expect(kind('Bash', '')).toBe('working')
  expect(kind('Bash', 'constructor')).toBe('working') // the prototype is not a program we know
  expect(kind('SomeNewTool')).toBe('working') // unknown stays neutral: no kind is invented
  expect(kind('mcp__other__thing')).toBe('working')
  for (const quiet of ['lane', 'ToolSearch', 'TodoWrite', 'mcp__savvy-progress__step', 'mcp__panel__panel']) expect(kind(quiet)).toBeUndefined() // bookkeeping
})

test('the kinds: every one has a label, a letter, a glyph and a color, and the order and weights cover the work kinds', () => {
  expect(new Set(INSIGHT_KINDS).size).toBe(INSIGHT_KINDS.length)
  const letters = INSIGHT_KINDS.map(k => KIND_META[k].letter)
  expect(new Set(letters).size).toBe(letters.length)
  for (const k of INSIGHT_KINDS) {
    expect(KIND_META[k].color).toMatch(/^#[0-9a-f]{6}$/)
    expect([...KIND_META[k].glyph]).toHaveLength(1)
    expect(KIND_META[k].label.length).toBeLessThan(11)
    expect(kindOfLetter(KIND_META[k].letter)).toBe(k)
  }
  expect([...KIND_ORDER].sort()).toEqual([...WORK_KINDS].sort())
  expect(kindOfLetter('.')).toBeUndefined()
  expect(kindOfLetter('constructor')).toBeUndefined()
})

test('zoneOf: only a class of folder (tests, ui) is kept, never a folder name, and only for file tools', () => {
  const zone = (tool: string, path: string): string => zoneOf(tool, { file_path: path })
  expect(zone('Edit', '/Users/me/secret-client/proj/web/builtin/board/lanes.js')).toBe('ui')
  expect(zone('Edit', '/Users/me/secret-client/proj/tests/a.ts')).toBe('tests')
  expect(zone('Write', '/p/web/tests/a.js')).toBe('tests') // tests before ui
  expect(zone('Edit', '/Users/me/secret-client/proj/hooks/a.ts')).toBe('')
  expect(zone('Read', 'C:\\work\\Components\\a.tsx')).toBe('ui')
  expect(zone('Bash', '/p/web/a')).toBe('')
  expect(zoneOf('Edit', {})).toBe('')
  expect(zone('Edit', 'web')).toBe('') // a bare file name has no folder
  for (const p of ['/Users/me/secret-client/proj/web/a.js', '/Users/me/secret-client/proj/tests/a.js']) expect(JSON.stringify(zone('Edit', p))).not.toMatch(/secret|Users|proj/)
})

test('spans: calls of one kind close together are one span; a gap or another kind starts a new one; time is owned up to a cap', () => {
  const T0 = 1_767_000_000_000
  const spans: Span[] = []
  addSpan(spans, 'ui', T0)
  addSpan(spans, 'ui', T0 + 10_000)
  addSpan(spans, 'ui', T0 + 10_000 + SPAN_CAPS.OWN_MS + 1) // too long a gap: a new span of the same kind
  addSpan(spans, 'tests', T0 + 60_000)
  expect(spans.map(s => [s.k, s.n])).toEqual([['ui', 2], ['ui', 1], ['tests', 1]])
  extendSpan(spans, 'tests', T0 + 90_000) // the call ended 30 s later
  extendSpan(spans, 'ui', T0 + 99_000) // not the last span's kind: ignored
  expect(spans[2]).toMatchObject({ t: T0 + 60_000, e: T0 + 90_000 })
  const end = T0 + 200_000
  const segs = segmentsOf(spans, end)
  expect(segs[0]).toEqual({ k: 'ui', a: T0, b: T0 + 10_000 + SPAN_CAPS.OWN_MS }) // owns 20 s after its last call
  expect(segs[2]).toEqual({ k: 'tests', a: T0 + 60_000, b: T0 + 90_000 + SPAN_CAPS.OWN_MS }) // and then a hole until `end`
  const time = timeByKind(spans, end, T0 + 60_000, end) // clipped to a window
  expect(time.get('tests')).toBe(30_000 + SPAN_CAPS.OWN_MS)
  expect(time.has('ui')).toBe(false)
})

test('spans: past the cap the two shortest neighbours merge, the kind with more time wins; junk in a stored list is dropped', () => {
  const T0 = 1_767_000_000_000
  const spans: Span[] = []
  for (let i = 0; i < SPAN_CAPS.MAX + 10; i++) addSpan(spans, i % 2 === 0 ? 'ui' : 'logic', T0 + i * 60_000)
  expect(spans).toHaveLength(SPAN_CAPS.MAX)
  expect(spans.reduce((a, s) => a + s.n, 0)).toBe(SPAN_CAPS.MAX + 10) // no call is lost
  expect(spans[0]?.t).toBe(T0)
  const good = { k: 'ui', t: T0, e: T0 + 5, n: 2 }
  expect(restoreSpans([good, { k: 'nope', t: T0, e: T0, n: 1 }, { k: 'ui', t: T0, e: T0 - 1, n: 1 }, 'x', null, { k: 'logic', t: 'a', e: 1, n: 1 }])).toEqual([good])
  expect(restoreSpans('nope')).toEqual([])
})
