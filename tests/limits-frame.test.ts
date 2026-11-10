import { expect, test } from 'claude-code/testing'

import { AUTO, applyFramePlan, assembleFrames, newBoardModel, planFrames, restoreBoardModel } from '../hooks/board-model'
import type { BoardInput, BoardModel } from '../hooks/board-model'
import { validateFrame } from '../hooks/board-frames'
import { LIMITS_NEVER_PCT, LIMITS_SHOW_FROM_PCT, limitsFrameOf } from '../hooks/limits-frame'
import { QUOTA_WARN_PCT } from '../hooks/viz-kinds'
import { QUOTA_MAX_PCT } from '../hooks/limits-quota'
import { configOf } from '../hooks/panel-config'
import { CONTEXT_PCT, EMPTY_PCT, EMPTY_USAGE, EXCEEDED_PCT, LIMITS_NOW, LIMITS_RESET, LIMITS_SAMPLE, LOW_PCT, PRESSURE_PCT, SAMPLE_USD, WEEKLY_PCT } from './limits-sample'

const withWindow = (percentUsed: number, kind = 'five_hour') => ({ ...EMPTY_USAGE, rateLimits: [{ kind, percentUsed, resetsAt: LIMITS_RESET }] })
const frameOf = (usage: unknown, pct = LIMITS_SHOW_FROM_PCT) => limitsFrameOf(usage, LIMITS_NOW, pct)
const FRAME_COUNT = 1
const NO_FRAMES = 0
const PRESSURE_THRESHOLD = QUOTA_WARN_PCT
const NEXT_PCT = PRESSURE_THRESHOLD - FRAME_COUNT
const OVERRIDE_TEXT = 'Measured budget'
const READING_ERROR = 'unreadable reading'

test('no readings stay absent, even with the always-show setting', () => {
  for (const input of [undefined, null, {}, EMPTY_USAGE]) {
    expect(frameOf(input)).toBeUndefined()
    expect(frameOf(input, EMPTY_PCT)).toBeUndefined()
  }
})

test('default shows low usage; an explicit pressure threshold is inclusive', () => {
  expect(frameOf(withWindow(LOW_PCT))).toBeDefined()
  expect(frameOf(withWindow(NEXT_PCT), PRESSURE_THRESHOLD)).toBeUndefined()
  expect(frameOf(withWindow(PRESSURE_THRESHOLD), PRESSURE_THRESHOLD)).toBeDefined()
})

test('five-hour usage preserves the engine percentage, converts ISO resets to milliseconds and adds no id', () => {
  const frame = frameOf(LIMITS_SAMPLE)
  expect(frame).toEqual({
    type: 'viz', kind: 'limits', title: 'Limits', size: 's',
    data: {
      groups: [{ title: 'Claude', status: 'fresh', windows: [{ label: '5h', usedPct: PRESSURE_PCT, resetsAt: Date.parse(LIMITS_RESET), tone: 'warn' }] }],
      context: { usedPct: LOW_PCT }, cost: { amount: SAMPLE_USD, unit: 'USD' },
    },
  })
  expect(validateFrame({ id: AUTO.LIMITS, ...frame })).toMatchObject(frame!)
})

test('context fill alone can show a valid frame; a known window size alone cannot', () => {
  expect(frameOf(EMPTY_USAGE)).toBeUndefined()
  const frame = frameOf({ ...EMPTY_USAGE, context: { ...EMPTY_USAGE.context, percent: CONTEXT_PCT } })
  expect(frame?.data).toEqual({ groups: [], context: { usedPct: CONTEXT_PCT } })
  expect(validateFrame({ id: AUTO.LIMITS, ...frame })).toMatchObject(frame!)
})

test('zero shows any available reading; 101 disables even exceeded spend limits', () => {
  expect(frameOf(withWindow(EMPTY_PCT), EMPTY_PCT)).toBeDefined()
  expect(frameOf({ ...EMPTY_USAGE, context: { percent: EMPTY_PCT } }, EMPTY_PCT)).toBeDefined()
  expect(frameOf(LIMITS_SAMPLE, LIMITS_NEVER_PCT)).toBeUndefined()
  expect(frameOf(withWindow(EXCEEDED_PCT, 'spend_limit'), LIMITS_NEVER_PCT)).toBeUndefined()
})

test('weekly windows use short labels; percentages clamp and unknown spend kinds are ignored', () => {
  expect(frameOf(withWindow(WEEKLY_PCT, 'seven_day'))?.data.groups[NO_FRAMES]?.windows).toEqual([
    { label: '7d', usedPct: WEEKLY_PCT, resetsAt: Date.parse(LIMITS_RESET), tone: 'warn' },
  ])
  const frame = frameOf(withWindow(EXCEEDED_PCT))
  expect(frame?.data.groups[NO_FRAMES]?.windows[NO_FRAMES]?.usedPct).toBe(QUOTA_MAX_PCT)
  expect(frameOf(withWindow(EXCEEDED_PCT, 'spend_limit'))).toBeUndefined()
  expect(validateFrame({ id: AUTO.LIMITS, ...frame })).toMatchObject(frame!)
})

test('cost is present only when measured and never triggers pressure on its own', () => {
  expect(frameOf(withWindow(PRESSURE_PCT))?.data.cost).toBeUndefined()
  expect(frameOf(LIMITS_SAMPLE)?.data.cost).toEqual({ amount: SAMPLE_USD, unit: 'USD' })
  const onlyCost = { ...EMPTY_USAGE, cost: { usd: EMPTY_PCT } }
  expect(frameOf(onlyCost, PRESSURE_THRESHOLD)).toBeUndefined()
  expect(frameOf(onlyCost, EMPTY_PCT)?.data).toEqual({ groups: [], cost: { amount: EMPTY_PCT, unit: 'USD' } })
})

test('junk input never throws or leaks unknown labels; malformed optional readings stay absent', () => {
  const throwing = Object.defineProperty({}, 'rateLimits', { get() { throw new Error(READING_ERROR) } })
  for (const input of [false, PRESSURE_PCT, 'junk', [], throwing, { rateLimits: {} },
    { rateLimits: [null, {}, { kind: 'five_hour', percentUsed: NaN }, { kind: 'seven_day', percentUsed: Infinity }] },
    { context: { percent: '85' }, cost: { usd: -SAMPLE_USD } }, withWindow(PRESSURE_PCT, 'toString')]) {
    expect(frameOf(input, EMPTY_PCT)).toBeUndefined()
  }
  const frame = frameOf({ ...withWindow(PRESSURE_PCT), rateLimits: [{ kind: 'five_hour', percentUsed: PRESSURE_PCT, resetsAt: 'junk' }], cost: { usd: NaN } })
  expect(frame?.data).toEqual({ groups: [{ title: 'Claude', status: 'fresh', windows: [{ label: '5h', usedPct: PRESSURE_PCT, tone: 'warn' }] }] })
})

test('automatic limits obey replacement, removal, clear and persisted removals', () => {
  const input: BoardInput = { task: null, status: 'working', ask: null, choices: [], lanes: [], loops: [], pulse: undefined, now: LIMITS_NOW, usage: LIMITS_SAMPLE }
  const initial = newBoardModel()
  const apply = (model: BoardModel, raw: Record<string, unknown>): BoardModel => {
    const planned = planFrames(raw)
    if (!planned.isOk) throw new Error(planned.error)
    const applied = applyFramePlan(model, planned.plan)
    if (!applied.isOk) throw new Error(applied.error)
    return applied.model
  }
  expect(assembleFrames(initial, input).map(f => f.id)).toEqual([AUTO.LIMITS])
  const replaced = apply(initial, { frame: { id: AUTO.LIMITS, type: 'text', text: OVERRIDE_TEXT } })
  expect(assembleFrames(replaced, input)).toHaveLength(FRAME_COUNT)
  expect(assembleFrames(replaced, input)[NO_FRAMES]).toMatchObject({ type: 'text', text: OVERRIDE_TEXT })
  const silenced = apply(replaced, { frame_remove: AUTO.LIMITS })
  expect(silenced.removedAuto).toContain(AUTO.LIMITS)
  expect(assembleFrames(silenced, input)).toHaveLength(NO_FRAMES)
  expect(assembleFrames(restoreBoardModel(JSON.parse(JSON.stringify(silenced))), input)).toHaveLength(NO_FRAMES)
  expect(assembleFrames(apply(silenced, { frames_clear: true }), input)).toHaveLength(FRAME_COUNT)
})

test('limits configuration accepts the two sentinel settings and rejects junk', () => {
  expect(configOf().limitsShowPct).toBe(LIMITS_SHOW_FROM_PCT)
  expect(configOf({ limitsShowPct: EMPTY_PCT }).limitsShowPct).toBe(EMPTY_PCT)
  expect(configOf({ limitsShowPct: LIMITS_NEVER_PCT }).limitsShowPct).toBe(LIMITS_NEVER_PCT)
  expect(configOf({ limitsShowPct: NaN }).limitsShowPct).toBe(LIMITS_SHOW_FROM_PCT)
})
