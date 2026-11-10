import { expect, test } from 'claude-code/testing'
import type { EngineInterface } from 'claude-code'
import { QUOTA_SAMPLE as fixture } from './fixtures/quota-sample'
import { quotaIdle, quotaRead, QUOTA_IO, resetQuota } from '../hooks/limits-io'
import { groupsOf, QUOTA_FRESH_MS } from '../hooks/limits-quota'
import { configOf } from '../hooks/panel-config'

const NOW = Date.parse(fixture.checkedAt)
const TEXT = JSON.stringify(fixture)
const HOME = '/home/example'
const CACHE = `${HOME}/.claude/plugins/cache/delegation-kit/delegation-kit`
const VERSION_OLD = '1.9.0'
const VERSION_NEW = '1.10.0'
const SCRIPT = `${CACHE}/${VERSION_NEW}/bin/delegate.py`
const SUCCESS = 0
const FAILURE = 1
const NO_CALLS = 0
const FIRST_CALL = 1
const NEXT_CALL = 2
const GROUP_COUNT = 4
const INTERVAL_MS = QUOTA_IO.EVERY_S * QUOTA_IO.MS_PER_SECOND
const TIMEOUT_ERROR = 'process timed out'
const JUNK = 'not json'

type Answer = { exitCode: number; stdout: string }
function fake() {
  const calls: { argv: readonly string[]; timeoutMs: number }[] = []
  const options = { missing: false, noHome: false, answer: { exitCode: SUCCESS, stdout: TEXT }, timeout: false, pending: undefined as Promise<Answer> | undefined }
  const $ = {
    env: { get: async () => options.noHome ? undefined : HOME },
    fs: {
      list: async () => options.missing ? [] : [VERSION_OLD, VERSION_NEW].map(name => ({ name, kind: 'dir' })),
      stat: async () => ({ kind: 'file' }),
    },
    process: { run: async (argv: readonly string[], init: { timeoutMs: number }) => {
      calls.push({ argv, timeoutMs: init.timeoutMs })
      if (options.timeout) throw new Error(TIMEOUT_ERROR)
      return options.pending ?? options.answer
    } },
  } as unknown as EngineInterface
  resetQuota()
  return { $, calls, options }
}

test('first read is background, selects the newest version, refreshes once and throttles', async () => {
  const { $, calls } = fake()
  let refreshes = NO_CALLS
  const refresh = () => { refreshes++ }
  expect(quotaRead($, NOW, QUOTA_IO.EVERY_S, refresh)).toEqual([])
  quotaRead($, NOW, QUOTA_IO.EVERY_S, refresh)
  await quotaIdle()
  expect(calls).toEqual([{ argv: ['python3', SCRIPT, 'quota', '--json'], timeoutMs: QUOTA_IO.TIMEOUT_MS }])
  expect(refreshes).toBe(FIRST_CALL)
  expect(quotaRead($, NOW + INTERVAL_MS - FIRST_CALL)).toHaveLength(GROUP_COUNT)
  await quotaIdle()
  expect(calls).toHaveLength(FIRST_CALL)
  quotaRead($, NOW + INTERVAL_MS)
  await quotaIdle()
  expect(calls).toHaveLength(NEXT_CALL)
})

test('missing script and missing home never run a process', async () => {
  for (const key of ['missing', 'noHome'] as const) {
    const { $, calls, options } = fake()
    options[key] = true
    expect(quotaRead($, NOW)).toEqual([])
    await quotaIdle()
    expect(quotaRead($, NOW)).toEqual([])
    expect(calls).toHaveLength(NO_CALLS)
  }
})

test('non-zero exit, timeout, junk and empty JSON keep the last good data with its original age', async () => {
  for (const failure of ['exit', 'timeout', 'junk', 'empty'] as const) {
    const { $, options } = fake()
    quotaRead($, NOW)
    await quotaIdle()
    const good = quotaRead($, NOW)
    options.answer = { exitCode: failure === 'exit' ? FAILURE : SUCCESS, stdout: failure === 'empty' ? '{}' : JUNK }
    options.timeout = failure === 'timeout'
    quotaRead($, NOW + QUOTA_FRESH_MS)
    await quotaIdle()
    const held = quotaRead($, NOW + QUOTA_FRESH_MS)
    expect(held).toEqual(good)
    expect(groupsOf({ quota: held, now: NOW + QUOTA_FRESH_MS }).every(g => g.status === 'stale')).toBe(true)
  }
})

test('only one read runs in flight even beyond the interval; resetting isolates an old read', async () => {
  const { $, calls, options } = fake()
  let finish!: (answer: Answer) => void
  options.pending = new Promise(resolve => { finish = resolve })
  quotaRead($, NOW)
  const waiting = quotaIdle()
  quotaRead($, NOW + INTERVAL_MS)
  resetQuota()
  expect(quotaRead($, NOW + INTERVAL_MS)).toEqual([])
  finish({ exitCode: SUCCESS, stdout: TEXT })
  await waiting
  expect(calls).toHaveLength(FIRST_CALL)
  expect(quotaRead($, NOW, QUOTA_IO.OFF)).toEqual([])
})

test('quotaEveryS zero disables reads and hides cached providers; configuration rejects junk', async () => {
  const { $, calls } = fake()
  expect(configOf().quotaEveryS).toBe(QUOTA_IO.EVERY_S)
  expect(configOf({ quotaEveryS: NaN }).quotaEveryS).toBe(QUOTA_IO.EVERY_S)
  const disabled = configOf({ quotaEveryS: QUOTA_IO.OFF }).quotaEveryS
  expect(quotaRead($, NOW, disabled)).toEqual([])
  await quotaIdle()
  expect(calls).toHaveLength(NO_CALLS)
  quotaRead($, NOW)
  await quotaIdle()
  expect(quotaRead($, NOW, disabled)).toEqual([])
  expect(calls).toHaveLength(FIRST_CALL)
})
