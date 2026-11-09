// Panel v4, the pure parts: ask choices, scene layout, stage cap, shot / shot_at and the shot's face.
import { expect, test } from 'claude-code/testing'

import { Invalid } from '../hooks/blocks/common'
import { applyScene, parseSceneInput, SCENE_CAPS, withShotFace } from '../hooks/scene'
import type { SceneAction } from '../hooks/scene'
import { applyInput, CAPS, emptyState, isEmptyState } from '../hooks/state'
import type { ApplyResult } from '../hooks/state'
import type { PanelState } from '../types'

const NOW = 1_767_000_000_000
const GOOD = { id: 'deck', dir: '/tmp/deck', alt: 'A deck.' }
const CHOICES = [
  { id: 'both', label: 'Both fixes' },
  { id: 'only-503', label: 'Only the 503' },
]

function ok(r: ApplyResult): PanelState {
  if (!r.isOk) throw new Error(`expected ok, got: ${r.error}`)
  return r.state
}

/** The denial without the tool-name prefix the panel tool adds, or 'ok'. */
const deny = (prev: PanelState, input: unknown): string => {
  const r = applyInput(prev, input, NOW)
  return r.isOk ? 'ok' : r.error.replace(/^panel: /, '')
}

const asked = (): PanelState => ok(applyInput(emptyState(), { ask: 'Which fix?', choices: CHOICES }, NOW))

// --- ask choices -------------------------------------------------------------------------------

test('choices travel with their ask and are stored as given (labels trimmed)', () => {
  const s = ok(applyInput(emptyState(), { ask: 'Which fix?', choices: [{ id: 'a', label: '  Alpha  ' }] }, NOW))
  expect(s.ask).toBe('Which fix?')
  expect(s.choices).toEqual([{ id: 'a', label: 'Alpha' }])
  expect(isEmptyState(s)).toBe(false)
})

test('a call that does not mention ask or choices keeps both', () => {
  const s = ok(applyInput(asked(), { status: 'waiting' }, NOW))
  expect(s.ask).toBe('Which fix?')
  expect(s.choices).toEqual(CHOICES)
})

test('a new ask replaces the buttons of the old one; choices sent with it become the new ones', () => {
  expect(ok(applyInput(asked(), { ask: 'And then?' }, NOW)).choices).toEqual([])
  const next = ok(applyInput(asked(), { ask: 'And then?', choices: [{ id: 'go', label: 'Go' }] }, NOW))
  expect(next.choices).toEqual([{ id: 'go', label: 'Go' }])
})

test('ask "" or null clears the question and its buttons; clear:true resets them too', () => {
  for (const cleared of ['', null]) {
    const s = ok(applyInput(asked(), { ask: cleared }, NOW))
    expect(s.ask).toBeNull()
    expect(s.choices).toEqual([])
  }
  expect(ok(applyInput(asked(), { clear: true }, NOW)).choices).toEqual([])
})

test('choices alone replace the buttons of the standing ask; [] removes them', () => {
  const s = ok(applyInput(asked(), { choices: [{ id: 'x', label: 'X' }] }, NOW))
  expect(s.choices).toEqual([{ id: 'x', label: 'X' }])
  expect(ok(applyInput(asked(), { choices: [] }, NOW)).choices).toEqual([])
})

test('buttons without a question are refused, whether the ask is missing or blank', () => {
  expect(deny(emptyState(), { choices: CHOICES })).toMatch(/^choices need an ask/)
  expect(deny(asked(), { ask: '', choices: CHOICES })).toMatch(/^choices need an ask/)
  expect(deny(emptyState(), { choices: [] })).toBe('ok')
})

const BAD_CHOICES: [string, unknown, RegExp][] = [
  ['not an array', 'yes', /^choices must be an array of \{id, label\}/],
  ['seven of them', Array.from({ length: CAPS.CHOICES + 1 }, (_, i) => ({ id: `c${i}`, label: 'L' })), /^choices has 7 items; the limit is 6/],
  ['id: capital', [{ id: 'Both', label: 'L' }], /^choices\[0\]\.id "Both" is invalid: use 1-24 characters from a-z, 0-9 and "-"/],
  ['id: underscore', [{ id: 'a_b', label: 'L' }], /^choices\[0\]\.id "a_b" is invalid/],
  ['id: 25 characters', [{ id: 'a'.repeat(25), label: 'L' }], /^choices\[0\]\.id .* is invalid/],
  ['id: missing', [{ label: 'L' }], /^choices\[0\]\.id undefined is invalid/],
  ['id: twice', [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }], /^choices\[1\]\.id "a" is used twice/],
  ['label: blank', [{ id: 'a', label: '   ' }], /^choices\[0\]\.label must be a non-empty string/],
  ['label: 41 characters', [{ id: 'a', label: 'x'.repeat(41) }], /^choices\[0\]\.label is 41 characters; the limit is 40: shorten it/],
  ['unknown key', [{ id: 'a', label: 'A', color: 'red' }], /^choices\[0\]\.color is not a known field/],
  ['item not an object', ['a'], /^choices\[0\]/],
]
for (const [name, value, pattern] of BAD_CHOICES)
  test(`choices refused: ${name}`, () => {
    expect(deny(emptyState(), { ask: 'Q?', choices: value })).toMatch(pattern)
  })

test('the limits themselves are accepted: 6 choices, a 24-character id, a 40-character label', () => {
  const six = Array.from({ length: CAPS.CHOICES }, (_, i) => ({ id: `c${i}`, label: 'x'.repeat(CAPS.CHOICE_LABEL_CHARS) }))
  expect(deny(emptyState(), { ask: 'Q?', choices: six })).toBe('ok')
  expect(deny(emptyState(), { ask: 'Q?', choices: [{ id: 'a'.repeat(CAPS.CHOICE_ID_CHARS), label: 'L' }] })).toBe('ok')
})

// --- scene layout, stage cap, shot, shot_at ----------------------------------------------------

function upsert(input: unknown): Extract<SceneAction, { kind: 'upsert' }> {
  const a = parseSceneInput(input)
  if (a.kind !== 'upsert') throw new Error(`expected an upsert, got ${a.kind}`)
  return a
}

const refusal = (input: unknown): string => {
  try {
    parseSceneInput(input)
    return 'ok'
  } catch (err) {
    if (err instanceof Invalid) return err.message
    throw err
  }
}

function publish(prev: PanelState, input: unknown): PanelState {
  const r = applyScene(prev, parseSceneInput(input), NOW)
  if (!r.isOk) throw new Error(`expected ok, got: ${r.error}`)
  return r.state
}

test('layout defaults to "card", stored explicitly; "stage" is kept', () => {
  expect(upsert(GOOD).scene.layout).toBe('card')
  expect(upsert({ ...GOOD, layout: 'stage' }).scene.layout).toBe('stage')
  expect(publish(emptyState(), GOOD).scenes[0]?.layout).toBe('card')
})

test('layout must be card or stage', () => {
  expect(refusal({ ...GOOD, layout: 'wide' })).toBe('scene.layout "wide" must be one of card, stage')
  expect(refusal({ ...GOOD, layout: 3 })).toMatch(/^scene\.layout 3 must be one of card, stage/)
})

test('shot defaults to true and shot_at to ""; neither is part of the stored scene', () => {
  const a = upsert(GOOD)
  expect(a.shot).toEqual({ isWanted: true, at: '' })
  expect('shot' in a.scene).toBe(false)
  expect('shot_at' in a.scene).toBe(false)
  expect(upsert({ ...GOOD, shot: false }).shot).toEqual({ isWanted: false, at: '' })
  expect(upsert({ ...GOOD, shot_at: '#/3' }).shot).toEqual({ isWanted: true, at: '#/3' })
  expect(upsert({ ...GOOD, shot: false, shot_at: '#/3' }).shot).toEqual({ isWanted: false, at: '#/3' })
})

test('shot must be a boolean', () => {
  expect(refusal({ ...GOOD, shot: 'yes' })).toBe('scene.shot must be true or false')
})

const SHOT_AT_OK = ['#', '#/3', '#slide-2', '#a/b.c_d-e', '#' + 'x'.repeat(40)]
const SHOT_AT_BAD = ['', '/3', '3', '#a b', '#a?b', '#a#b', '#é', '#' + 'x'.repeat(41), '#<x>', 7]

test('shot_at accepts a location hash of up to 40 safe characters', () => {
  for (const at of SHOT_AT_OK) expect(refusal({ ...GOOD, shot_at: at }), at).toBe('ok')
})

test('shot_at refuses anything else and names the field', () => {
  for (const at of SHOT_AT_BAD)
    expect(refusal({ ...GOOD, shot_at: at }), String(at)).toMatch(/^scene\.shot_at .* is invalid: use a location hash such as "#\/3"/)
})

test('up to 6 stage scenes (the cap equals the scene cap): the seventh is refused, a replace of a stage scene still works', () => {
  let s = emptyState()
  for (const id of ['s1', 's2', 's3', 's4', 's5', 's6']) s = publish(s, { ...GOOD, id, layout: 'stage' })
  const r = applyScene(s, parseSceneInput({ ...GOOD, id: 's7', layout: 'stage' }), NOW)
  expect(r.isOk).toBe(false)
  if (!r.isOk) expect(r.error).toMatch(/^scene: already 6 scenes \(s1, s2, s3, s4, s5, s6\)/)
  expect(publish(s, { ...GOOD, id: 's2', layout: 'stage', alt: 'Changed.' }).scenes).toHaveLength(6)
  expect(SCENE_CAPS.STAGE_SCENES).toBe(6)
  expect(SCENE_CAPS.STAGE_SCENES).toBeLessThanOrEqual(SCENE_CAPS.SCENES)
})

test('slot: big, side or auto; anything else is refused naming the field; absent stays absent', () => {
  for (const slot of ['big', 'side', 'auto']) expect(publish(emptyState(), { ...GOOD, layout: 'stage', slot }).scenes[0]?.slot).toBe(slot)
  expect(publish(emptyState(), { ...GOOD, layout: 'stage' }).scenes[0]?.slot).toBeUndefined()
  expect(refusal({ ...GOOD, slot: 'huge' })).toMatch(/^scene\.slot "huge" must be one of big, side, auto/)
  expect(refusal({ ...GOOD, slot: 3 })).toMatch(/slot/)
})

// --- the shot as the scene's face --------------------------------------------------------------

const PNG = '/tmp/t/claude-panel/shots/deck-1.png'

test('withShotFace sets term.image for the shot revision and changes nothing else (no rev bump)', () => {
  const s = publish(emptyState(), GOOD)
  const next = withShotFace(s, 'deck', 1, PNG)
  expect(next.scenes[0]?.term).toEqual({ image: PNG })
  expect(next.scenes[0]?.rev).toBe(1)
  expect(next.rev).toBe(s.rev)
  expect(next.updatedAt).toBe(s.updatedAt)
})

test('withShotFace keeps an art the scene already has', () => {
  const s = publish(emptyState(), { ...GOOD, term: { art: ['##'] } })
  expect(withShotFace(s, 'deck', 1, PNG).scenes[0]?.term).toEqual({ art: ['##'], image: PNG })
})

test('withShotFace leaves the state alone when the scene has its own image, moved on, or is gone', () => {
  const own = publish(emptyState(), { ...GOOD, term: { image: '/tmp/own.png' } })
  expect(withShotFace(own, 'deck', 1, PNG)).toBe(own)
  const s = publish(emptyState(), GOOD)
  const again = publish(s, { ...GOOD, alt: 'Second.' })
  expect(withShotFace(again, 'deck', 1, PNG)).toBe(again)
  expect(withShotFace(s, 'other', 1, PNG)).toBe(s)
})
