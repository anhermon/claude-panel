// The frame validator: every type valid, every cap and shape refused with the field named, unknown keys refused.
import { expect, test } from 'claude-code/testing'

import { FRAME_CAPS, FRAME_TYPES, validateFrame } from '../hooks/board-frames'
import { EXAMPLES, TYPES } from './board-examples'

const refusal = (input: unknown): string => {
  try {
    validateFrame(input)
  } catch (err) {
    return (err as Error).message
  }
  throw new Error(`accepted: ${JSON.stringify(input).slice(0, 120)}`)
}
const ex = (type: string, over: Record<string, unknown>): Record<string, unknown> => ({ ...EXAMPLES[type], ...over })
const long = (n: number): string => 'x'.repeat(n)
const nums = (n: number): number[] => Array.from({ length: n }, (_, i) => i)

test('every type has a valid example, and the validator keeps it as it is', () => {
  expect(TYPES.sort()).toEqual([...FRAME_TYPES].sort())
  for (const type of TYPES) expect(validateFrame(EXAMPLES[type]), type).toEqual(EXAMPLES[type])
})

test('the common fields: id pattern, type, title cap, size enum, unknown keys named', () => {
  const table: [Record<string, unknown>, RegExp][] = [
    [ex('text', { id: 'Bad Id' }), /^frame\.id "Bad Id" is invalid: use 1-24 characters/],
    [ex('text', { id: long(25) }), /^frame\.id .* is invalid/],
    [ex('text', { id: undefined }), /^frame\.id undefined is invalid/],
    [ex('text', { type: 'sparkle' }), /^frame\.type "sparkle" must be one of text, now, metric/],
    [ex('text', { title: long(41) }), /^frame\.title is 41 characters; the limit is 40/],
    [ex('text', { size: 'xxl' }), /^frame\.size "xxl" must be one of s, m, l, xl/],
    [ex('text', { colour: 'red' }), /^frame\.colour is not a known field of a "text" frame \(allowed: id, type, title, size, text, sub\)/],
    [ex('lanes', { text: 'no' }), /^frame\.text is not a known field of a "lanes" frame/],
    [ex('metric', { q: 'x' }), /^frame\.q is not a known field of a "metric" frame/],
  ]
  for (const [input, pattern] of table) expect(refusal(input)).toMatch(pattern)
  expect(refusal('text')).toMatch(/^frame must be an object/)
  expect(refusal(['x'])).toMatch(/^frame must be an object/)
  for (const size of ['s', 'm', 'l', 'xl']) expect(validateFrame(ex('text', { size })).size).toBe(size)
  expect(validateFrame(ex('text', { title: long(40) })).title).toHaveLength(40)
  expect(validateFrame(ex('text', { sub: '  ' }))).not.toHaveProperty('sub') // blank optional text is none
})

test('text, now, avatar, ask: caps and enums', () => {
  const table: [Record<string, unknown>, RegExp][] = [
    [ex('text', { text: long(91) }), /^frame\.text is 91 characters; the limit is 90/],
    [ex('text', { text: '' }), /^frame\.text must not be empty/],
    [ex('text', { text: 5 }), /^frame\.text must be a string of at most 90/],
    [ex('text', { sub: long(121) }), /^frame\.sub is 121 characters; the limit is 120/],
    [ex('now', { status: 'busy' }), /^frame\.status "busy" must be one of working, waiting, blocked, done/],
    [ex('avatar', { mood: 'angry' }), /^frame\.mood "angry" must be one of idle, thinking, working, happy, alert, sleepy/],
    [ex('avatar', { say: long(81) }), /^frame\.say is 81 characters; the limit is 80/],
    [ex('ask', { q: long(121) }), /^frame\.q is 121 characters; the limit is 120/],
    [ex('ask', { options: [] }), /^frame\.options needs at least 1 item/],
    [ex('ask', { options: ['a', 'b', 'c', 'd', 'e'] }), /^frame\.options has 5 items; the limit is 4/],
    [ex('ask', { options: [long(33)] }), /^frame\.options\[0\] is 33 characters; the limit is 32/],
  ]
  for (const [input, pattern] of table) expect(refusal(input)).toMatch(pattern)
  for (const mood of ['idle', 'thinking', 'working', 'happy', 'alert', 'sleepy']) expect(validateFrame(ex('avatar', { mood })).type).toBe('avatar')
})

test('metric: value string or number (<= 12 chars), label, delta, tone, spark', () => {
  const table: [Record<string, unknown>, RegExp][] = [
    [ex('metric', { value: long(13) }), /^frame\.value is 13 characters; the limit is 12/],
    [ex('metric', { value: 123456789012345 }), /^frame\.value 123456789012345 is 15 characters; the limit is 12/],
    [ex('metric', { value: Number.NaN }), /^frame\.value null must be a finite number/],
    [ex('metric', { value: Infinity }), /^frame\.value null must be a finite number/],
    [ex('metric', { value: undefined }), /^frame\.value must be a string of at most 12/],
    [ex('metric', { label: long(41) }), /^frame\.label is 41 characters; the limit is 40/],
    [ex('metric', { delta: long(13) }), /^frame\.delta is 13 characters; the limit is 12/],
    [ex('metric', { tone: 'purple' }), /^frame\.tone "purple" must be one of info, ok, warn, danger/],
    [ex('metric', { spark: nums(25) }), /^frame\.spark has 25 items; the limit is 24/],
    [ex('metric', { spark: [1] }), /^frame\.spark needs at least 2 items/],
    [ex('metric', { spark: [1, 'a'] }), /^frame\.spark\[1\] "a" must be a finite number/],
  ]
  for (const [input, pattern] of table) expect(refusal(input)).toMatch(pattern)
  expect(validateFrame(ex('metric', { value: 42 })).type).toBe('metric')
  expect(validateFrame({ id: 'm', type: 'metric', value: 7 })).not.toHaveProperty('label') // the label is optional
  expect(validateFrame({ id: 'n', type: 'now', status: 'working' })).not.toHaveProperty('text') // a now frame falls back to the task
  expect(validateFrame(ex('metric', { value: long(12) })).type).toBe('metric')
})

test('rings, bars, line: item caps, ranges, finite numbers, #hex colors', () => {
  const ring = (over: Record<string, unknown>) => ex('rings', { items: [{ label: 'a', pct: 50, ...over }] })
  const bar = (over: Record<string, unknown>) => ex('bars', { items: [{ label: 'a', value: 1, ...over }] })
  const table: [Record<string, unknown>, RegExp][] = [
    [ex('rings', { items: nums(5).map(i => ({ label: `r${i}`, pct: 1 })) }), /^frame\.items has 5 items; the limit is 4/],
    [ring({ pct: 101 }), /^frame\.items\[0\]\.pct 101 must be from 0 to 100/],
    [ring({ pct: -1 }), /^frame\.items\[0\]\.pct -1 must be from 0 to 100/],
    [ring({ pct: 'x' }), /^frame\.items\[0\]\.pct "x" must be a finite number/],
    [ring({ label: long(17) }), /^frame\.items\[0\]\.label is 17 characters; the limit is 16/],
    [ring({ color: 'red' }), /^frame\.items\[0\]\.color "red" must be a #hex color/],
    [ring({ extra: 1 }), /^frame\.items\[0\]\.extra is not a known field \(allowed: label, pct, color\)/],
    [ex('bars', { items: nums(9).map(i => ({ label: `b${i}`, value: i })) }), /^frame\.items has 9 items; the limit is 8/],
    [bar({ color: 'red' }), /^frame\.items\[0\]\.color "red" must be a #hex color/],
    [bar({ tone: 'ok' }), /^frame\.items\[0\]\.tone is not a known field \(allowed: label, value, color\)/],
    [bar({ value: Infinity }), /^frame\.items\[0\]\.value null must be a finite number/],
    [bar({ label: long(25) }), /^frame\.items\[0\]\.label is 25 characters; the limit is 24/],
    [ex('bars', { unit: long(9) }), /^frame\.unit is 9 characters; the limit is 8/],
    [ex('line', { series: nums(4).map(i => ({ label: `s${i}`, points: [1, 2] })) }), /^frame\.series has 4 items; the limit is 3/],
    [ex('line', { series: [{ label: 'a', points: nums(61) }] }), /^frame\.series\[0\]\.points has 61 items; the limit is 60/],
    [ex('line', { series: [{ label: 'a', points: [1] }] }), /^frame\.series\[0\]\.points needs at least 2 items/],
    [ex('line', { series: [{ label: 'a', points: [1, Number.NaN] }] }), /^frame\.series\[0\]\.points\[1\] null must be a finite number/],
    [ex('line', { series: [] }), /^frame\.series needs at least 1 item/],
    [ex('line', { series: 'cpu' }), /^frame\.series must be an array of at most 3 items/],
  ]
  for (const [input, pattern] of table) expect(refusal(input)).toMatch(pattern)
  expect(validateFrame(ring({ color: '#abc' })).type).toBe('rings')
  expect(validateFrame(ring({ pct: 0 })).type).toBe('rings')
  expect(validateFrame(bar({ value: -5 })).type).toBe('bars') // a negative bar is a legal number
})

test('steps, timeline, compare: caps and enums', () => {
  const table: [Record<string, unknown>, RegExp][] = [
    [ex('steps', { items: nums(7).map(i => ({ t: `s${i}`, state: 'todo' })) }), /^frame\.items has 7 items; the limit is 6/],
    [ex('steps', { items: [{ t: 'a', state: 'skipped' }] }), /^frame\.items\[0\]\.state "skipped" must be one of todo, doing, done, failed/],
    [ex('steps', { items: [{ t: long(49), state: 'todo' }] }), /^frame\.items\[0\]\.t is 49 characters; the limit is 48/],
    [ex('timeline', { items: nums(7).map(i => ({ text: `e${i}` })) }), /^frame\.items has 7 items; the limit is 6/],
    [ex('timeline', { items: [{ text: 'a', when: long(13) }] }), /^frame\.items\[0\]\.when is 13 characters; the limit is 12/],
    [ex('timeline', { items: [{ text: long(49) }] }), /^frame\.items\[0\]\.text is 49 characters; the limit is 48/],
    [ex('timeline', { items: [{ text: 'a', tone: 'x' }] }), /^frame\.items\[0\]\.tone "x" must be one of/],
    [ex('compare', { left: { title: long(25), items: ['a'] } }), /^frame\.left\.title is 25 characters; the limit is 24/],
    [ex('compare', { right: { title: 't', items: ['a', 'b', 'c', 'd', 'e'] } }), /^frame\.right\.items has 5 items; the limit is 4/],
    [ex('compare', { right: { title: 't', items: [long(41)] } }), /^frame\.right\.items\[0\] is 41 characters; the limit is 40/],
    [ex('compare', { left: undefined }), /^frame\.left must be an object \{title, items\}/],
    [ex('compare', { left: { title: 't', items: ['a'], x: 1 } }), /^frame\.left\.x is not a known field/],
  ]
  for (const [input, pattern] of table) expect(refusal(input)).toMatch(pattern)
  expect(validateFrame(ex('timeline', { items: [{ text: 'no when' }] })).type).toBe('timeline')
})

test('diagram: node ids, caps, edges must reference existing nodes', () => {
  const nodes = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }]
  const table: [Record<string, unknown>, RegExp][] = [
    [ex('diagram', { nodes: nums(11).map(i => ({ id: `n${i}`, label: 'N' })), edges: [] }), /^frame\.nodes has 11 items; the limit is 10/],
    [ex('diagram', { nodes: [{ id: 'Bad', label: 'A' }], edges: [] }), /^frame\.nodes\[0\]\.id "Bad" is invalid: use 1-16 characters/],
    [ex('diagram', { nodes: [{ id: long(17), label: 'A' }], edges: [] }), /^frame\.nodes\[0\]\.id .* is invalid: use 1-16 characters/],
    [ex('diagram', { nodes: [{ id: 'a', label: long(25) }], edges: [] }), /^frame\.nodes\[0\]\.label is 25 characters; the limit is 24/],
    [ex('diagram', { nodes: [...nodes, { id: 'a', label: 'again' }], edges: [] }), /^frame\.nodes\[2\]\.id "a" is used twice/],
    [ex('diagram', { nodes, edges: [{ from: 'a', to: 'zzz' }] }), /^frame\.edges\[0\]\.to "zzz" is not a node of this diagram \(nodes: a, b\)/],
    [ex('diagram', { nodes, edges: [{ from: 'q', to: 'a' }] }), /^frame\.edges\[0\]\.from "q" is not a node/],
    [ex('diagram', { nodes, edges: nums(15).map(() => ({ from: 'a', to: 'b' })) }), /^frame\.edges has 15 items; the limit is 14/],
    [ex('diagram', { nodes, edges: [{ from: 'a', to: 'b', label: long(17) }] }), /^frame\.edges\[0\]\.label is 17 characters; the limit is 16/],
    [ex('diagram', { nodes: [], edges: [] }), /^frame\.nodes needs at least 1 item/],
  ]
  for (const [input, pattern] of table) expect(refusal(input)).toMatch(pattern)
  expect(validateFrame(ex('diagram', { nodes, edges: undefined })).type).toBe('diagram') // edges are optional
})

test('image: a relative path or a data:image URL <= 200 KB, never a URL; html <= 8 KB', () => {
  const table: [Record<string, unknown>, RegExp][] = [
    [ex('image', { src: 'http://x.io/a.png' }), /^frame\.src must not be a URL \(no http/],
    [ex('image', { src: 'https://x.io/a.png' }), /^frame\.src must not be a URL/],
    [ex('image', { src: '//x.io/a.png' }), /^frame\.src must not be a URL/],
    [ex('image', { src: 'file:///etc/passwd' }), /^frame\.src must not be a URL/],
    [ex('image', { src: '/etc/passwd' }), /^frame\.src "\/etc\/passwd" must be a plain relative path/],
    [ex('image', { src: '../secret.png' }), /^frame\.src "\.\.\/secret\.png" must be a plain relative path/],
    [ex('image', { src: 'a/../b.png' }), /must be a plain relative path/],
    [ex('image', { src: '.hidden.png' }), /must be a plain relative path/],
    [ex('image', { src: '' }), /^frame\.src must be a string/],
    [ex('image', { src: `data:image/png;base64,${long(200 * 1024)}` }), /^frame\.src is \d+ characters; the limit is 204800 \(200 KB\)/],
    [ex('image', { caption: long(61) }), /^frame\.caption is 61 characters; the limit is 60/],
    [ex('html', { html: long(8193) }), /^frame\.html is 8193 characters; the limit is 8192/],
    [ex('html', { html: '' }), /^frame\.html must not be empty/],
  ]
  for (const [input, pattern] of table) expect(refusal(input)).toMatch(pattern)
  expect(validateFrame(ex('image', { src: 'data:image/png;base64,AAAA' })).type).toBe('image')
  expect(validateFrame(ex('html', { html: long(8192) })).type).toBe('html')
  expect(FRAME_CAPS.IMAGE_SRC_CHARS).toBe(200 * 1024)
})

test('uml: Mermaid code <= 4096 chars, highlight {nodeId: state} <= 24 entries with safe ids, unknown keys named', () => {
  const table: [Record<string, unknown>, RegExp][] = [
    [ex('uml', { code: long(4097) }), /^frame\.code is 4097 characters; the limit is 4096/],
    [ex('uml', { code: '  ' }), /^frame\.code must not be empty/],
    [ex('uml', { code: undefined }), /^frame\.code must be a string/],
    [ex('uml', { highlight: 'writer' }), /^frame\.highlight must be an object \{nodeId: active\|done\|blocked\|todo\}/],
    [ex('uml', { highlight: { writer: 'running' } }), /^frame\.highlight\.writer "running" must be one of active, done, blocked, todo/],
    [ex('uml', { highlight: { 'bad id': 'active' } }), /^frame\.highlight\.bad id is not a node id/],
    [ex('uml', { highlight: { '<script>': 'active' } }), /is not a node id/],
    [ex('uml', { highlight: Object.fromEntries(nums(25).map(i => [`n${i}`, 'todo'])) }), /^frame\.highlight has 25 entries; the limit is 24/],
    [ex('uml', { nodes: [] }), /^frame\.nodes is not a known field of a "uml" frame \(allowed: id, type, title, size, code, highlight\)/],
  ]
  for (const [input, pattern] of table) expect(refusal(input)).toMatch(pattern)
  expect(validateFrame(ex('uml', { code: long(4096), highlight: undefined })).type).toBe('uml')
  expect(validateFrame(ex('uml', { highlight: { 'a_1-b': 'blocked', Main: 'done' } }))).toMatchObject({ highlight: { 'a_1-b': 'blocked', Main: 'done' } })
  expect(FRAME_CAPS.UML_CODE_CHARS).toBe(4096)
})

test('swimlane: <= 8 lanes with <= 48 stretches of a known kind, whole seconds, unknown keys named; doing takes no payload', () => {
  const lane = { label: 'main', state: 'working', from: 0, to: 60, segs: [{ k: 'ui', a: 0, b: 30 }] }
  const table: [Record<string, unknown>, RegExp][] = [
    [ex('swimlane', { items: [] }), /^frame\.items needs at least 1 item/],
    [ex('swimlane', { items: nums(9).map(() => lane) }), /^frame\.items has 9 items; the limit is 8/],
    [ex('swimlane', { items: [{ ...lane, label: long(25) }] }), /^frame\.items\[0\]\.label is 25 characters; the limit is 24/],
    [ex('swimlane', { items: [{ ...lane, state: 'busy' }] }), /^frame\.items\[0\]\.state "busy" must be one of working, waiting, done/],
    [ex('swimlane', { items: [{ ...lane, from: 'x' }] }), /^frame\.items\[0\]\.from "x" must be a finite number/],
    [ex('swimlane', { items: [{ ...lane, segs: nums(49).map(() => ({ k: 'ui', a: 0, b: 1 })) }] }), /^frame\.items\[0\]\.segs has 49 items; the limit is 48/],
    [ex('swimlane', { items: [{ ...lane, segs: [{ k: 'coding', a: 0, b: 1 }] }] }), /^frame\.items\[0\]\.segs\[0\]\.k "coding" must be one of ui, logic, tests/],
    [ex('swimlane', { items: [{ ...lane, calls: 3 }] }), /^frame\.items\[0\]\.calls is not a known field/],
    [ex('doing', { items: [] }), /^frame\.items is not a known field of a "doing" frame/],
  ]
  for (const [input, pattern] of table) expect(refusal(input)).toMatch(pattern)
  const kept = validateFrame(ex('swimlane', { items: [{ ...lane, from: 1.6, to: -3, segs: [] }] })) as { items: { from: number; to: number }[] }
  expect([kept.items[0]!.from, kept.items[0]!.to]).toEqual([2, 0]) // whole seconds, never negative
})

test('viz: a known kind, a plain data object <= 12288 chars and 8 levels deep, caption <= 120; an unknown kind lists the valid ones', () => {
  const kind = 'sankey'
  const deep = (n: number): Record<string, unknown> => (n === 0 ? {} : { a: deep(n - 1) })
  const table: [Record<string, unknown>, RegExp][] = [
    [ex('viz', { kind: 'piechart' }), /^frame\.kind "piechart" must be one of .*sankey/],
    [ex('viz', { kind: undefined }), /^frame\.kind/],
    [ex('viz', { kind, data: [1] }), /^frame\.data must be an object \(the fields of the "sankey" asset: \["unit"/],
    [ex('viz', { kind, data: { unit: 'x'.repeat(FRAME_CAPS.VIZ_DATA_CHARS) } }), /^frame\.data is \d+ characters; the limit is 12288/],
    [ex('viz', { kind, data: deep(FRAME_CAPS.VIZ_DEPTH + 1) }), /^frame\.data nests deeper than 8 levels/],
    [ex('viz', { kind, caption: long(FRAME_CAPS.VIZ_CAPTION_CHARS + 1) }), /^frame\.caption is 121 characters; the limit is 120/],
    [ex('viz', { kind, colour: 'red' }), /^frame\.colour is not a known field/],
  ]
  for (const [input, pattern] of table) expect(refusal(input)).toMatch(pattern)
})
