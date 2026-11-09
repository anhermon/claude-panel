// The model and effort a subagent was started with, read from the meta file next to its transcript (pure parts: the parser and the loop update).
import { expect, test } from 'claude-code/testing'

import { parseMeta } from '../hooks/agent-meta'
import { MAIN_LOOP, loopFor, newModel, setLoopMeta } from '../hooks/pulse-model'

const NOW = 1_767_000_000_000

test('parseMeta takes the model alias and the effort; anything else is left alone', () => {
  const raw = '{"agentType":"savvy-flow:savvy-careful","model":"sonnet","effort":"high","toolUseId":"toolu_x"}'
  expect(parseMeta(raw)).toEqual({ model: 'sonnet', effort: 'high' })
  expect(parseMeta('{"effort":4000}')).toEqual({ effort: '4000' })
  expect(parseMeta('{"model":"sonnet"}')).toEqual({ model: 'sonnet' }) // an unknown effort stays unknown
  expect(parseMeta('not json')).toEqual({})
  expect(parseMeta('[1]')).toEqual({})
})

test('setLoopMeta sets what is missing once and keeps what a run record already said', () => {
  const m = newModel(NOW)
  loopFor(m, 'a', NOW)
  expect(setLoopMeta(m, 'a', { model: 'sonnet', effort: 'high' })).toBe(true)
  expect(m.loops.get('a')).toMatchObject({ model: 'sonnet', effort: 'high' })
  expect(setLoopMeta(m, 'a', { model: 'haiku', effort: 'low' })).toBe(false)
  expect(m.loops.get('a')).toMatchObject({ model: 'sonnet', effort: 'high' })
  expect(setLoopMeta(m, 'nope', { model: 'sonnet' })).toBe(false)
  expect(m.loops.has(MAIN_LOOP)).toBe(true)
})
