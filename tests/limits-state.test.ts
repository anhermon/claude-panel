import { expect, test } from 'claude-code/testing'
import type { EngineInterface, SessionUsage } from 'claude-code'

import { limitsUsage, noteLimits } from '../hooks/limits-state'
import { EMPTY_USAGE, LIMITS_SAMPLE } from './limits-sample'

const FIRST_READ = 1
const SECOND_READ = 2
const UNAVAILABLE = 'usage unavailable'

test('first use caches the snapshot and session start forces a fresh read', async () => {
  let reads = 0
  let snapshot = EMPTY_USAGE
  const $ = { session: { usage: async () => { reads++; return snapshot } } } as EngineInterface
  expect(await limitsUsage($, true)).toEqual(EMPTY_USAGE)
  expect(await limitsUsage($)).toEqual(EMPTY_USAGE)
  expect(reads).toBe(FIRST_READ)
  snapshot = LIMITS_SAMPLE
  expect(await limitsUsage($, true)).toEqual(LIMITS_SAMPLE)
  expect(reads).toBe(SECOND_READ)
})

test('a live observation wins over an initial snapshot still being read', async () => {
  let finish!: (usage: SessionUsage) => void
  let reads = 0
  const waiting = new Promise<SessionUsage>(resolve => { finish = resolve })
  const $ = { session: { usage: () => { reads++; return waiting } } } as EngineInterface
  const first = limitsUsage($, true)
  const same = limitsUsage($)
  noteLimits(LIMITS_SAMPLE)
  finish(EMPTY_USAGE)
  const { context, rateLimits, cost } = LIMITS_SAMPLE
  expect(await first).toEqual({ context, rateLimits, cost })
  expect(await same).toEqual({ context, rateLimits, cost })
  expect(reads).toBe(FIRST_READ)
})

test('an unavailable first reading can be retried without failing the board', async () => {
  let reads = 0
  const $ = { session: { usage: async () => {
    reads++
    if (reads === FIRST_READ) throw new Error(UNAVAILABLE)
    return LIMITS_SAMPLE
  } } } as EngineInterface
  expect(await limitsUsage($, true)).toBeUndefined()
  expect(await limitsUsage($)).toEqual(LIMITS_SAMPLE)
  expect(reads).toBe(SECOND_READ)
})
