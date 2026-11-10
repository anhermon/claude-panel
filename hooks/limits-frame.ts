// Only measured numbers and fixed labels leave this pure adapter; never session or account metadata.
import { QUOTA_WARN_PCT, QUOTA_DANGER_PCT } from './viz-kinds'
import { isPlain } from './blocks/common'
import { groupsOf, QUOTA_MIN_PCT, QUOTA_MAX_PCT } from './limits-quota'
import type { LimitsGroup, ProviderQuota } from './limits-quota'

export const LIMITS_SHOW_FROM_PCT = QUOTA_MIN_PCT
export const LIMITS_NEVER_PCT = 101
const COST_UNIT = 'USD'
const FRAME = { type: 'viz', kind: 'limits', title: 'Limits', size: 's' } as const
type QuotaTone = 'ok' | 'warn' | 'danger'
type TonedGroup = Omit<LimitsGroup, 'windows'> & { windows: (LimitsGroup['windows'][number] & { tone: QuotaTone })[] }
export type LimitsData = {
  groups: TonedGroup[]
  context?: { usedPct: number }
  cost?: { amount: number; unit: string }
}
export type LimitsFrame = typeof FRAME & { data: LimitsData }
const toneOf = (pct: number): QuotaTone => pct < QUOTA_WARN_PCT ? 'ok' : pct < QUOTA_DANGER_PCT ? 'warn' : 'danger'
const isReading = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= QUOTA_MIN_PCT

/** Provider snapshots can stand alone when the engine has no reading. */
export function limitsFrameOf(usage: unknown, now: number, showFromPct = LIMITS_SHOW_FROM_PCT, quota: readonly ProviderQuota[] = []): LimitsFrame | undefined {
  try {
    if (showFromPct >= LIMITS_NEVER_PCT) return undefined
    const threshold = isReading(showFromPct) ? showFromPct : LIMITS_SHOW_FROM_PCT
    const groups = groupsOf({ claudeLive: usage, quota, now }).map(g => ({ ...g, windows: g.windows.map(w => ({ ...w, tone: toneOf(w.usedPct) })) }))
    const live = isPlain(usage) ? usage : {}
    const fill = isPlain(live.context) ? live.context.percent : undefined
    const context = isReading(fill) && fill <= QUOTA_MAX_PCT ? { usedPct: fill } : undefined
    const usd = isPlain(live.cost) ? live.cost.usd : undefined
    const cost = isReading(usd) ? { amount: usd, unit: COST_UNIT } : undefined
    const hasReading = groups.length > QUOTA_MIN_PCT || context !== undefined || cost !== undefined
    const isPressure = groups.some(g => g.windows.some(w => w.usedPct >= threshold)) || (context !== undefined && context.usedPct >= threshold)
    if (!hasReading || (threshold !== QUOTA_MIN_PCT && !isPressure)) return undefined
    return { ...FRAME, data: { groups, ...(context === undefined ? {} : { context }), ...(cost === undefined ? {} : { cost }) } }
  } catch {
    return undefined
  }
}
