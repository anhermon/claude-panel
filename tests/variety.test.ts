import { expect, test } from 'claude-code/testing'

import { pushRecent, RECENT_MAX, restoreRecent, SCENE_FORM, varietyHint } from '../hooks/variety'

test('varietyHint: silent for a varied or short history', () => {
  expect(varietyHint([])).toBe('')
  expect(varietyHint(['steps', 'steps'])).toBe('')
  expect(varietyHint(['steps', 'metric', 'steps', 'bars', 'steps', 'line'])).toBe('') // 3 of 6 is half, not 60%
})

test('varietyHint: a streak of three names the form and offers up to three others', () => {
  const hint = varietyHint(['bars', 'text', 'text', 'text'])
  expect(hint).toMatch(/^Your last 3 panel updates were all "text"\. Choose a different form if the content allows: not used recently: /)
  const offered = hint.split(': not used recently: ')[1]?.replace(/\.$/, '').split(', ') ?? []
  expect(offered.length).toBeGreaterThan(0)
  expect(offered.length).toBeLessThanOrEqual(3)
  for (const t of offered) expect(['text', 'bars', 'now', 'lanes', 'pulse', 'ask', 'avatar']).not.toContain(t)
})

test('varietyHint: one form with 60% of the last six, not in a row', () => {
  expect(varietyHint(['steps', 'steps', 'metric', 'steps', 'bars', 'steps'])).toMatch(/^4 of your last 6 panel updates were "steps"/)
  expect(varietyHint(['steps', 'steps', 'metric', 'steps', 'bars', 'steps'])).not.toContain('metric,') // forms in the window are never suggested
})

test('varietyHint: scenes count as a form', () => {
  expect(varietyHint([SCENE_FORM, SCENE_FORM, SCENE_FORM])).toMatch(/all "scene"/)
})

test('pushRecent keeps the last RECENT_MAX; restoreRecent drops junk', () => {
  let r: string[] = []
  for (let i = 0; i < 10; i++) r = pushRecent(r, `f${i}`)
  expect(r).toHaveLength(RECENT_MAX)
  expect(r[RECENT_MAX - 1]).toBe('f9')
  expect(restoreRecent(['a', 1, null, 'b'])).toEqual(['a', 'b'])
  expect(restoreRecent('nope')).toEqual([])
})
