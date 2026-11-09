// The hub's judgement of a command file (pure): every refusal reason, and the one way through.
import { expect, test } from 'claude-code/testing'

import { COMMAND_MAX_AGE_MS, FLEET_ORIGIN, FLEET_ORIGIN_PREFIX, RATE_MAX_PER_TARGET, RATE_WINDOW_MS } from '../hooks/fleet-contract'
import { judge, parseLstart, parseRegistry, sameStart, sendsInWindow } from '../hooks/fleet-validate'
import type { JudgeInput } from '../hooks/fleet-validate'

const ID = 'a'.repeat(32)
const TARGET = '11111111-2222-3333-4444-555555555555'
const SELF = '99999999-2222-3333-4444-555555555555'
const NOW = 1_800_000_000_000
const PROC_START = 'Thu Nov  5 07:34:30 2026' // the registry writes UTC

const command = (over: Record<string, unknown> = {}) => ({ id: ID, sessionId: TARGET, pid: 4242, procStart: PROC_START, text: 'hello there', ts: NOW - 1000, origin: FLEET_ORIGIN, ...over })
const input = (over: Partial<JudgeInput> = {}): JudgeInput => ({
  command: command(),
  now: NOW,
  selfSessionId: SELF,
  allowSelf: false,
  registry: { pid: 4242, sessionId: TARGET, procStart: PROC_START },
  lstart: PROC_START,
  recentSends: [],
  ...over,
})
const reason = (over: Partial<JudgeInput>): string => {
  const j = judge(input(over))
  return j.ok ? 'OK' : j.reason
}

test('a good command passes and comes back cleaned', () => {
  const j = judge(input({ command: command({ text: '  hi\u0007 there \n' }) }))
  expect(j).toMatchObject({ ok: true, command: { id: ID, sessionId: TARGET, pid: 4242, text: 'hi there' } })
})

test('the shape is checked field by field', () => {
  expect(reason({ command: null })).toMatch(/not a JSON object/)
  expect(reason({ command: command({ origin: 'curl' }) })).toMatch(/does not come from the fleet page/)
  expect(reason({ command: command({ id: 'x' }) })).toMatch(/id is malformed/)
  expect(reason({ command: command({ sessionId: 'nope' }) })).toMatch(/not a session id/)
  expect(reason({ command: command({ pid: 0 }) })).toMatch(/not a process id/)
  expect(reason({ command: command({ pid: '12' }) })).toMatch(/not a process id/)
  expect(reason({ command: command({ ts: 'now' }) })).toMatch(/no time/)
  expect(reason({ command: command({ text: 5 }) })).toMatch(/must be a string/)
})

test('the text: not empty, capped, never carrying the fleet marker', () => {
  expect(reason({ command: command({ text: ' \u0001 ' }) })).toMatch(/empty/)
  expect(reason({ command: command({ text: 'x'.repeat(2001) }) })).toMatch(/longer than 2000/)
  expect(reason({ command: command({ text: 'x'.repeat(2000) }) })).toBe('OK')
  expect(reason({ command: command({ text: `see ${FLEET_ORIGIN_PREFIX} too` }) })).toMatch(/fleet marker/)
})

test('time: a command older than the limit or dated in the future is refused', () => {
  expect(reason({ command: command({ ts: NOW - COMMAND_MAX_AGE_MS - 1 }) })).toMatch(/expired/)
  expect(reason({ command: command({ ts: NOW - COMMAND_MAX_AGE_MS + 1000 }) })).toBe('OK')
  expect(reason({ command: command({ ts: NOW + 60_000 }) })).toMatch(/future/)
})

test('a send to the hub\'s own session is refused unless the config allows it', () => {
  expect(reason({ command: command({ sessionId: SELF }), registry: { pid: 4242, sessionId: SELF, procStart: PROC_START } })).toMatch(/runs in/)
  expect(reason({ command: command({ sessionId: SELF.toUpperCase() }), registry: { pid: 4242, sessionId: SELF, procStart: PROC_START } })).toMatch(/runs in/)
  expect(reason({ allowSelf: true, command: command({ sessionId: SELF }), registry: { pid: 4242, sessionId: SELF, procStart: PROC_START } })).toBe('OK')
})

test('the registry and the process table must both vouch for the pid', () => {
  expect(reason({ registry: undefined })).toMatch(/no registry entry/)
  expect(reason({ registry: { pid: 4242, sessionId: SELF, procStart: PROC_START } })).toMatch(/another session/)
  expect(reason({ registry: { pid: 4242, sessionId: TARGET, procStart: null } })).toMatch(/no start time/)
  expect(reason({ command: command({ procStart: 'Fri Nov  6 01:00:00 2026' }) })).toMatch(/restarted/)
  expect(reason({ lstart: undefined })).toMatch(/not running/)
  expect(reason({ lstart: 'Fri Nov  6 01:00:00 2026' })).toMatch(/another process/)
  expect(reason({ command: command({ procStart: null }) })).toBe('OK') // a ps-only page row carries no start time; the registry still vouches
})

test('rate limit: the sixth message inside a minute to one session is refused, an older one does not count', () => {
  const recent = Array.from({ length: RATE_MAX_PER_TARGET }, (_, n) => NOW - 1000 * n)
  expect(reason({ recentSends: recent })).toMatch(/rate limit/)
  expect(reason({ recentSends: recent.slice(1) })).toBe('OK')
  expect(reason({ recentSends: recent.map(t => t - RATE_WINDOW_MS) })).toBe('OK')
  expect(sendsInWindow(recent, NOW)).toBe(RATE_MAX_PER_TARGET)
})

test('helpers: registry text, ps output, start time under both clock readings', () => {
  expect(parseRegistry(JSON.stringify({ pid: 7, sessionId: TARGET.toUpperCase(), procStart: PROC_START, token: 'x' }))).toEqual({ pid: 7, sessionId: TARGET, procStart: PROC_START })
  expect(parseRegistry('{"pid":"7"}')).toBeUndefined()
  expect(parseRegistry('not json')).toBeUndefined()
  expect(parseLstart('Thu Nov  5 07:34:30 2026\n')).toBe(PROC_START)
  expect(parseLstart('')).toBeUndefined()
  expect(sameStart(PROC_START, PROC_START, 2000)).toBe(true) // the registry writes UTC and `ps` local time: either reading may match, so the zone cannot hide a restart
  expect(sameStart(PROC_START, 'Thu Nov  5 07:34:32 2026', 2000)).toBe(true)
  expect(sameStart(PROC_START, 'Thu Nov  5 07:34:40 2026', 2000)).toBe(false)
})
