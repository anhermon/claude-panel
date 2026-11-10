import { expect, test } from 'claude-code/testing'
import { HISTORY_MAX, pushForm, readHistory, restoreHistory, staleForms, startSession, STALE_WINDOW, writeHistory } from '../hooks/context-history'
import type { ContextHistory } from '../hooks/context-history'

const KEY = 'session'
const AT = 1000
const initial = () => startSession([], KEY, 'debug', AT)

test('pushForm deduplicates within a session and preserves its job and timestamp', () => {
  const history = pushForm(pushForm(initial(), KEY, 'hypotheses'), KEY, 'hypotheses')
  expect(history).toEqual([{ sessionKey: KEY, job: 'debug', forms: ['hypotheses'], at: AT }])
  expect(initial()[0]?.forms).toEqual([])
  expect(startSession(history, KEY, 'build', AT + 1)[0]).toMatchObject({ job: 'build', forms: ['hypotheses'], at: AT })
  expect(pushForm([], KEY, 'scene')[0]?.forms).toEqual(['scene'])
})

test('history is a ring of the last eight sessions and restoration rejects junk', () => {
  let history: ContextHistory = []
  for (let n = 0; n <= HISTORY_MAX; n++) history = startSession(history, String(n), 'build', AT + n)
  expect(history).toHaveLength(HISTORY_MAX)
  expect(history[0]?.sessionKey).toBe('1')
  expect(restoreHistory('bad')).toEqual([])
  expect(restoreHistory([null, {}, { sessionKey: KEY, job: 'odd', at: AT }, ...history])).toEqual(history)
  expect(restoreHistory([{ sessionKey: KEY, job: 'build', at: AT, forms: ['steps', null, 'steps', '<unsafe>'] }])[0]?.forms).toEqual(['steps'])
  expect(restoreHistory([{ sessionKey: KEY, job: 'build', at: NaN }])).toEqual([])
})

test('staleForms needs three distinct sessions in the last five', () => {
  const history = Array.from({ length: STALE_WINDOW + 1 }, (_, n) => ({ sessionKey: String(n), job: 'build' as const, at: AT + n,
    forms: n === 0 ? ['scene'] : n <= 3 ? ['steps', 'steps', 'scene'] : ['metric'] }))
  expect(staleForms(history)).toEqual(['steps', 'scene'])
  expect(staleForms(history.slice(-3))).toEqual([])
  expect(staleForms([{ ...history[0]!, forms: ['steps', 'steps', 'steps'] }])).toEqual([])
})

test('history IO swallows store failures', async () => {
  const unavailable = async (): Promise<never> => { throw new Error('unavailable') }
  const $ = { store: { get: unavailable, set: unavailable, delete: unavailable, keys: unavailable } }
  expect(await readHistory($)).toEqual([])
  await writeHistory($, initial())
})
