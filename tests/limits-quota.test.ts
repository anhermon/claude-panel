import { expect, test } from 'claude-code/testing'
import { QUOTA_SAMPLE as fixture } from './fixtures/quota-sample'
import { groupsOf, parseQuota, QUOTA_FRESH_MS, QUOTA_MAX_PCT, QUOTA_MIN_PCT } from '../hooks/limits-quota'
import { validateFrame } from '../hooks/board-frames'
import { AUTO } from '../hooks/board-model'
import { limitsFrameOf, LIMITS_NEVER_PCT } from '../hooks/limits-frame'
import { EMPTY_USAGE, LIMITS_SAMPLE, PRESSURE_PCT } from './limits-sample'

const NOW = Date.parse(fixture.checkedAt)
const QUOTA_TEXT = JSON.stringify(fixture)
const GROUP_COUNT = 4
const FIRST = 0
const NEXT = 1
const TITLES = ['Claude', 'Codex', 'AGY Gemini shared', 'AGY Claude/GPT pool']
const LABELS = ['5h', '7d']
const UNKNOWN_MINUTES = 42
const EXCEEDED_PCT = 125
const NEGATIVE_PCT = -10
const UNKNOWN_KIND = 'unrecognized'
const UNAVAILABLE_STATE = 'offline'
const GROUP_PRESSURE = 60

const groups = (text = QUOTA_TEXT, now = NOW) => groupsOf({ quota: parseQuota(text), now })

test('fixture yields four groups in fixed order, classifies by minutes and names, and discards metadata', () => {
  const result = groups()
  expect(result).toHaveLength(GROUP_COUNT)
  expect(result.map(g => g.title)).toEqual(TITLES)
  for (const group of result) expect(group.windows.map(w => w.label)).toEqual(LABELS)
  expect(result.map(g => g.status)).toEqual(['fresh', 'fresh', 'stale', 'stale'])
  expect(result[FIRST]?.windows[NEXT]?.usedPct).toBe(fixture.providers.claude.windows[NEXT]!.usedPct)
  expect(result[NEXT]?.windows[FIRST]?.usedPct).toBe(fixture.providers.codex.windows[FIRST]!.usedPct)
  expect(JSON.stringify(result).includes('source')).toBe(false)
  expect(JSON.stringify(result).includes('models')).toBe(false)
})

test('freshness expires at the named age; failures show titles without bars', () => {
  expect(groups(QUOTA_TEXT, NOW + QUOTA_FRESH_MS).every(g => g.status === 'stale')).toBe(true)
  const raw = structuredClone(fixture)
  raw.providers.codex.state = UNAVAILABLE_STATE
  raw.providers.codex.observedAt = 'junk'
  expect(groups(JSON.stringify(raw))[NEXT]).toEqual({ title: TITLES[NEXT], status: 'unavailable', windows: [] })
})

test('uninstalled providers and nested pools disappear, while absent installed flags remain supported', () => {
  const raw = structuredClone(fixture)
  raw.providers.codex.installed = false
  raw.providers.gemini.installed = false
  expect(groups(JSON.stringify(raw)).map(g => g.title)).toEqual([TITLES[FIRST]])
})

test('live Claude wins over JSON, and an empty live reading falls back', () => {
  const quota = parseQuota(QUOTA_TEXT)
  const live = groupsOf({ claudeLive: LIMITS_SAMPLE, quota, now: NOW + QUOTA_FRESH_MS })
  expect(live[FIRST]?.status).toBe('fresh')
  expect(live[FIRST]?.windows[FIRST]?.usedPct).toBe(PRESSURE_PCT)
  expect(groupsOf({ claudeLive: EMPTY_USAGE, quota, now: NOW })).toEqual(groups())
})

test('minutes take precedence; names work without minutes; unknown windows vanish and percentages clamp', () => {
  const windows = [
    { kind: 'weekly', windowMinutes: 300, usedPct: EXCEEDED_PCT, resetsAt: 'junk' },
    { kind: 'seven_day', usedPct: NEGATIVE_PCT },
    { kind: UNKNOWN_KIND, usedPct: GROUP_PRESSURE },
    { kind: 'five_hour', windowMinutes: UNKNOWN_MINUTES, usedPct: GROUP_PRESSURE },
    { kind: 'five_hour', usedPct: 'junk' },
  ]
  const quota = parseQuota(JSON.stringify({ providers: { claude: { state: 'ok', windows } } }))
  expect(quota[FIRST]?.windows).toEqual([{ label: '5h', usedPct: QUOTA_MAX_PCT }, { label: '7d', usedPct: QUOTA_MIN_PCT }])
  expect(groupsOf({ quota, now: NOW })[FIRST]?.status).toBe('stale')
})

test('junk, empty and missing providers are harmless', () => {
  for (const raw of ['', 'junk', 'null', '[]', '{}', '{"providers":null}', '{"providers":{"codex":null}}']) expect(parseQuota(raw)).toEqual([])
  expect(groupsOf({ now: NOW })).toEqual([])
})

test('frame can show quota alone, uses shared warning thresholds and obeys visibility settings', () => {
  const quota = parseQuota(QUOTA_TEXT)
  const frame = limitsFrameOf(undefined, NOW, QUOTA_MIN_PCT, quota)
  expect(frame?.data.groups.map(g => g.title)).toEqual(TITLES)
  expect(validateFrame({ id: AUTO.LIMITS, ...frame })).toMatchObject(frame!)
  expect(frame?.data.groups[FIRST]?.windows[NEXT]?.tone).toBe('warn')
  expect(limitsFrameOf(undefined, NOW, GROUP_PRESSURE, quota)).toBeDefined()
  expect(limitsFrameOf(undefined, NOW, QUOTA_MAX_PCT, quota)).toBeUndefined()
  expect(limitsFrameOf(undefined, NOW, LIMITS_NEVER_PCT, quota)).toBeUndefined()
})


test('Codex kinds classify without minutes; AGY kinds also classify without minutes', () => {
  const raw = structuredClone(fixture)
  const text = JSON.stringify(raw, (key, value) => key === 'windowMinutes' ? undefined : value)
  const result = groups(text)
  expect(result.map(g => g.windows.map(w => w.label))).toEqual(TITLES.map(() => LABELS))
})
