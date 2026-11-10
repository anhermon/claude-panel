import { expect, test } from 'claude-code/testing'
import type { BoardData } from '../types'

import { AUTO } from '../hooks/board-model'
import { BOARD_SOURCE_DIR, DATA_TEMP_NAME, boardDirOf } from '../hooks/board-io'
import { LIVE_DIR_NAME, COOLDOWN_MS, LEAD_MS } from '../hooks/pulse-flush'
import { boot, file, HOME } from './boot'
import { quotaIdle } from '../hooks/limits-io'
import { QUOTA_SAMPLE } from './fixtures/quota-sample'
import { EMPTY_USAGE, LIMITS_NOW, LIMITS_SAMPLE, LOW_PCT, PRESSURE_PCT } from './limits-sample'

const TMP_DIR = '/tmp/t'
const SESSION_ID = 'sess-1'
const DATA_TEMP = `${boardDirOf(TMP_DIR, SESSION_ID)}/${LIVE_DIR_NAME}/${DATA_TEMP_NAME}`
const SOURCE_FILE = 'index.html'
const SOURCE_HTML = '<main>Board</main>'
const FILE_SIZE = SOURCE_HTML.length
const FILE_TIME = LIMITS_NOW
const NO_FRAMES = 0
const FRAME_COUNT = 1
const ONE_WRITE = 1
const CHANGED_UNITS = ['rateLimits'] as const

test('session.measure passes through its result and refreshes the board with pulse off', async ($, on) => {
  const initial = { ...LIMITS_SAMPLE, rateLimits: LIMITS_SAMPLE.rateLimits.map(w => ({ ...w, percentUsed: LOW_PCT })) }
  const b = await boot($, on, {
    setup: o => {
      o('session.usage', () => ({ value: initial }))
      o('session.measure', (_, e) => ({ changed: e.changed }))
      o('fs.list', (_, e) => ({ value: e.path.endsWith(BOARD_SOURCE_DIR) ? [{ name: SOURCE_FILE, kind: 'file', size: FILE_SIZE, mtimeMs: FILE_TIME, isLink: false }] : [] }))
    },
    texts: new Proxy({}, { get: (_, key) => typeof key === 'string' && key.endsWith(`${BOARD_SOURCE_DIR}/${SOURCE_FILE}`) ? SOURCE_HTML : undefined }),
  })
  const settle = () => b.clock.advance(LEAD_MS + COOLDOWN_MS)
  const dataWrites = () => b.writes.filter(w => w.path === DATA_TEMP)
  const data = (): BoardData => JSON.parse(dataWrites().at(-ONE_WRITE)?.text ?? 'null')
  await settle()
  expect(data().frames).toHaveLength(FRAME_COUNT)
  const before = dataWrites().length
  const { context, rateLimits, cost } = LIMITS_SAMPLE
  const measurement = { context, rateLimits, cost, changed: [...CHANGED_UNITS] }
  const result = await $.session.measure(measurement)
  expect(result).toEqual({ changed: [...CHANGED_UNITS] })
  await settle()
  expect(dataWrites().length).toBe(before + ONE_WRITE)
  expect(data().frames).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: AUTO.LIMITS, type: 'viz', kind: AUTO.LIMITS, data: expect.objectContaining({ groups: [expect.objectContaining({ title: 'Claude', status: 'fresh', windows: [expect.objectContaining({ label: '5h', usedPct: PRESSURE_PCT })] })] }) }),
  ]))
  // Equal observations do not rewrite the board; low usage remains visible by default.
  await $.session.measure(measurement)
  await settle()
  expect(dataWrites().length).toBe(before + ONE_WRITE)
  await $.session.measure({ context: EMPTY_USAGE.context, rateLimits: EMPTY_USAGE.rateLimits, changed: [...CHANGED_UNITS] })
  await settle()
  expect(data().frames).toHaveLength(NO_FRAMES)
  b.stopServer()
})


test('provider quota completion refreshes all four groups after the first board draw', async ($, on) => {
  const CACHE_SUFFIX = '.claude/plugins/cache/delegation-kit/delegation-kit'
  const VERSION = '1.10.0'
  const SCRIPT = `${HOME}/${CACHE_SUFFIX}/${VERSION}/bin/delegate.py`
  const PROGRAM = 'python3'
  const GROUP_COUNT = 4
  const GROUP_TITLES = ['Claude', 'Codex', 'AGY Gemini shared', 'AGY Claude/GPT pool']
  const b = await boot($, on, {
    files: { [SCRIPT]: file() },
    onRun: argv => argv[NO_FRAMES] === PROGRAM ? { stdout: JSON.stringify(QUOTA_SAMPLE) } : undefined,
    setup: o => {
      o('session.usage', () => ({ value: LIMITS_SAMPLE }))
      o('fs.list', (_, e) => ({ value: e.path.endsWith(BOARD_SOURCE_DIR)
        ? [{ name: SOURCE_FILE, kind: 'file', size: FILE_SIZE, mtimeMs: FILE_TIME, isLink: false }]
        : e.path.endsWith(CACHE_SUFFIX) ? [{ name: VERSION, kind: 'dir', size: NO_FRAMES, mtimeMs: FILE_TIME, isLink: false }] : [] }))

    },
    texts: new Proxy({}, { get: (_, key) => typeof key === 'string' && key.endsWith(`${BOARD_SOURCE_DIR}/${SOURCE_FILE}`) ? SOURCE_HTML : undefined }),
  })
  const settle = () => b.clock.advance(LEAD_MS + COOLDOWN_MS)
  const dataWrites = () => b.writes.filter(w => w.path === DATA_TEMP)
  const data = (): BoardData => JSON.parse(dataWrites().at(-ONE_WRITE)?.text ?? 'null')
  await settle()
  const first: BoardData = JSON.parse(dataWrites()[NO_FRAMES]?.text ?? 'null')
  expect(first.frames).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: AUTO.LIMITS, data: expect.objectContaining({ groups: [expect.objectContaining({ title: 'Claude' })] }) }),
  ]))
  await quotaIdle()
  await settle()
  expect(data().frames).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: AUTO.LIMITS, data: expect.objectContaining({ groups: expect.arrayContaining(GROUP_TITLES.map(title => expect.objectContaining({ title }))) }) }),
  ]))
  const frame = data().frames.find(f => f.id === AUTO.LIMITS)
  if (frame?.type !== 'viz') throw new Error('missing limits frame')
  expect((frame.data as { groups: unknown[] }).groups).toHaveLength(GROUP_COUNT)
  b.stopServer()
})
