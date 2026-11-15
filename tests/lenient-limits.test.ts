// Lenient length handling and the frame shapes real model calls got wrong (eval round 2, case 07).
import { expect, test } from 'claude-code/testing'
import { FRAME_CAPS, parseFrameString, validateFrame } from '../hooks/board-frames'
import { planFrames } from '../hooks/board-model'
import { CONFIG_DEFAULTS, configOf } from '../hooks/panel-config'
import { toolDescription } from '../hooks/spec'

const long = (n: number): string => 'x'.repeat(n)
const items = (n: number) => Array.from({ length: n }, (_, i) => ({ t: `step ${i}`, state: 'todo' }))
const planOf = (raw: Record<string, unknown>, lenient = true) => {
  const r = planFrames(raw, lenient)
  if (!r.isOk) throw new Error(r.error)
  return r.plan
}
const errorOf = (raw: Record<string, unknown>, lenient = true): string => {
  const r = planFrames(raw, lenient)
  if (r.isOk) throw new Error('accepted')
  return r.error
}

// The inputs the model really sent (abtest out2/C2 case 07), shortened.
const STRING_FRAME = '{"id":"plan","type":"steps","title":"Narrowing plan","size":l,"items":[{"t":"1. Read logs","state":"doing"},{"t":"2. Rerun","state":"todo"}]}'
const STRING_COMPARE = '{"id":"suspects","type":"compare","title":"What each suspect predicts","size":l,"left":{"title":"Tmp race","items":["a","b"]},"right":{"title":"Clock","items":["c","d"]}}'

test('lenientLimits defaults to true and reads the option', () => {
  expect(CONFIG_DEFAULTS.lenientLimits).toBe(true)
  expect(configOf({}).lenientLimits).toBe(true)
  expect(configOf({ lenientLimits: false }).lenientLimits).toBe(false)
  expect(configOf({ lenientLimits: 'no' }).lenientLimits).toBe(true)
})

test('over-length text is cut with an ellipsis, applied, and noted', () => {
  const limit = FRAME_CAPS.STEP_CHARS
  const p = planOf({ frame: { id: 'plan', type: 'steps', title: long(FRAME_CAPS.TITLE_CHARS + 5), items: [{ t: 'ok', state: 'todo' }, { t: 'fine', state: 'todo' }, { t: long(61), state: 'doing' }] } })
  const steps = p.upsert as unknown as { title: string; items: { t: string }[] }
  expect(steps.items[2]!.t).toHaveLength(limit)
  expect(steps.items[2]!.t.endsWith('…')).toBe(true)
  expect(steps.title).toHaveLength(FRAME_CAPS.TITLE_CHARS)
  expect(p.trimmed).toContain(`items[2].t 61→${limit}`)
  expect(p.trimmed).toContain(`title ${FRAME_CAPS.TITLE_CHARS + 5}→${FRAME_CAPS.TITLE_CHARS}`)
})

test('compare left/right title and items over the cap are cut and noted', () => {
  const p = planOf({ frame: { id: 'c', type: 'compare', left: { title: long(28), items: [long(65)] }, right: { title: 'r', items: ['x'] } } })
  const left = (p.upsert as unknown as { left: { title: string; items: string[] } }).left
  expect(left.title).toHaveLength(FRAME_CAPS.COMPARE_TITLE_CHARS)
  expect(left.items[0]).toHaveLength(FRAME_CAPS.COMPARE_ITEM_CHARS)
  expect(p.trimmed).toEqual([`left.title 28→${FRAME_CAPS.COMPARE_TITLE_CHARS}`, `left.items[0] 65→${FRAME_CAPS.COMPARE_ITEM_CHARS}`])
})

test('an over-long list keeps the first items and says so', () => {
  const max = FRAME_CAPS.STEPS_ITEMS
  const p = planOf({ frame: { id: 'plan', type: 'steps', items: items(max + 3) } })
  expect((p.upsert as unknown as { items: unknown[] }).items).toHaveLength(max)
  expect((p.upsert as unknown as { items: { t: string }[] }).items[max - 1]!.t).toBe(`step ${max - 1}`)
  expect(p.trimmed).toEqual([`items ${max + 3}→${max}`])
})

test('a call within the limits notes nothing', () => {
  expect(planOf({ frame: { id: 'plan', type: 'steps', items: items(2) } }).trimmed).toEqual([])
})

test('structural problems are still refused when lenient', () => {
  const table: [Record<string, unknown>, RegExp][] = [
    [{ frame: { type: 'text', text: 'x' } }, /^panel: frame\.id undefined is invalid/],
    [{ frame: { id: 'a', text: 'x' } }, /^panel: frame\.type undefined must be one of/],
    [{ frame: { id: 'a', type: 'sparkle' } }, /^panel: frame\.type "sparkle" must be one of/],
    [{ frame: { id: 'a', type: 'text', text: 5 } }, /^panel: frame\.text must be a string/],
    [{ frame: { id: 'a', type: 'text', text: '  ' } }, /^panel: frame\.text must not be empty/],
    [{ frame: { id: 'a', type: 'text', text: 'x', colour: 'red' } }, /not a known field/],
    [{ frame: { id: 'a', type: 'text', text: 'x', size: 'xxl' } }, /^panel: frame\.size "xxl" must be one of/],
    [{ frame: { id: 'a', type: 'steps', items: [{ t: 'x', state: 'later' }] } }, /state "later" must be one of/],
    [{ frame: { id: 'a', type: 'steps', items: [] } }, /needs at least 1 item/],
    [{ frame: ['x'] }, /^panel: frame must be an object, not an array/],
    [{ frame: 'not json at all' }, /^panel: frame must be an object, not string/],
    [{ frame: 7 }, /^panel: frame must be an object, not number/],
  ]
  for (const [raw, pattern] of table) expect(errorOf(raw)).toMatch(pattern)
})

test('lenientLimits false keeps the old refusals', () => {
  expect(errorOf({ frame: { id: 'plan', type: 'steps', items: [{ t: long(61), state: 'todo' }] } }, false)).toMatch(/^panel: frame\.items\[0\]\.t is 61 characters; the limit is 48/)
  expect(errorOf({ frame: { id: 'plan', type: 'steps', items: items(FRAME_CAPS.STEPS_ITEMS + 1) } }, false)).toMatch(/has \d+ items; the limit is/)
  expect(() => validateFrame({ id: 'a', type: 'text', text: long(FRAME_CAPS.TEXT_CHARS + 1) })).toThrow(/characters; the limit is/)
})

test('a failed lenient call does not leave the validator lenient', () => {
  errorOf({ frame: { id: 'a', type: 'text' } })
  expect(() => validateFrame({ id: 'a', type: 'text', text: long(FRAME_CAPS.TEXT_CHARS + 1) })).toThrow(/characters; the limit is/)
})

test('a frame sent as a JSON string is read, including a bare-word value from the real failing calls', () => {
  for (const raw of [STRING_FRAME, STRING_COMPARE]) {
    const p = planOf({ frame: raw })
    expect(p.upsert).toMatchObject({ size: 'l' })
    expect(p.trimmed).toEqual(['frame was a JSON string, send an object'])
  }
  expect(planOf({ frame: STRING_FRAME }).upsert).toMatchObject({ id: 'plan', type: 'steps', items: [{ t: '1. Read logs', state: 'doing' }, { t: '2. Rerun', state: 'todo' }] })
  expect(planOf({ frame: JSON.stringify({ id: 'a', type: 'text', text: 'hi' }) }).upsert).toMatchObject({ id: 'a', text: 'hi' })
})

test('a string frame is still checked: the repaired frame can be refused', () => {
  expect(errorOf({ frame: '{"id":"a","type":"text"}' })).toMatch(/frame\.text must be a string/)
  expect(parseFrameString('[1,2]')).toBeNull()
  expect(parseFrameString('{"a": true, "b": null, "c": 3}')).toEqual({ a: true, b: null, c: 3 })
})

test('the tool text shows one concrete frame object and says it is not a string', () => {
  const text = toolDescription()
  expect(text).toContain('{"id":"plan","type":"steps","size":"m"')
  expect(text).toContain('not a string')
  expect(text).not.toMatch(/size s\|m\|l\|xl/)
})

// Eval round 3 (abtest out3/C3 case 07): compare frames sent with placeholder fields.
const LEFT = { title: 'Clock', items: ['Fails near second edges', 'Fixed by freezing time'] }
const RIGHT = { title: 'Tmp dir', items: ['Fails only in parallel', 'Fixed by unique dirs'] }

test('compare with an empty text placeholder is applied and the drop is noted', () => {
  const p = planOf({ frame: { id: 'suspects', type: 'compare', size: 'l', title: 'What each suspect predicts', text: '', left: LEFT, right: RIGHT } })
  expect(p.upsert).toEqual({ id: 'suspects', type: 'compare', size: 'l', title: 'What each suspect predicts', left: LEFT, right: RIGHT })
  expect(p.trimmed).toEqual(['empty text dropped'])
})

test('compare with text:"" and data:{} and no sides is refused, naming the fields and an example', () => {
  const e = errorOf({ frame: { id: 'probes', type: 'compare', size: 'l', title: 'Probe per suspect', data: {}, text: '' } })
  expect(e).toContain('frame.left')
})

test('a non-empty text or data on a compare is refused with the valid fields and an example, never mapped', () => {
  for (const key of ['text', 'data']) {
    const e = errorOf({ frame: { id: 'c', type: 'compare', [key]: key === 'text' ? 'hello' : { a: 1 }, left: LEFT, right: RIGHT } })
    expect(e).toContain(`frame.${key} is not a known field of a "compare" frame (allowed: id, type, title, size, left, right)`)
    expect(e).toContain('Example: {"id":"cmp","type":"compare","left":{"title":')
  }
  expect(errorOf({ frame: { id: 'c', type: 'compare', text: 'hello', left: LEFT, right: RIGHT } }, false)).toContain('Example:')
})

test('an empty placeholder is refused when lenientLimits is off', () => {
  expect(errorOf({ frame: { id: 'c', type: 'compare', text: '', left: LEFT, right: RIGHT } }, false)).toContain('frame.text is not a known field')
})

test('a frame nested in frame is unwrapped one level with a note', () => {
  const p = planOf({ frame: { id: 'signals', type: 'compare', size: 'l', frame: { left: LEFT, right: RIGHT } } })
  expect(p.upsert).toEqual({ id: 'signals', type: 'compare', size: 'l', left: LEFT, right: RIGHT })
  expect(p.trimmed).toEqual(['frame was nested in frame, send it flat'])
})

test('frame:null on a compare is dropped, then the missing sides are what is refused', () => {
  const e = errorOf({ frame: { id: 'signals', type: 'compare', size: 'l', frame: null } })
  expect(e).toContain('frame.left')
  expect(e).not.toContain('frame.frame')
})

test('a nested frame of another type is not unwrapped', () => {
  expect(errorOf({ frame: { id: 'a', type: 'compare', frame: { type: 'steps', items: [] } } })).toContain('frame.frame is not a known field')
})
