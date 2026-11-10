import type { SessionUsage } from 'claude-code'

export const LIMITS_NOW = Date.parse('2026-11-10T10:00:00Z')
export const LIMITS_RESET = '2026-11-10T12:30:00Z'
export const LOW_PCT = 40
export const PRESSURE_PCT = 72
export const CONTEXT_PCT = 85
export const WEEKLY_PCT = 65
export const EXCEEDED_PCT = 125
export const EMPTY_PCT = 0
export const SAMPLE_USD = 1.25
export const CONTEXT_WINDOW = 200_000
export const EMPTY_USAGE: SessionUsage = { startedAt: LIMITS_NOW, context: { window: CONTEXT_WINDOW }, rateLimits: [] }
export const LIMITS_SAMPLE: SessionUsage = {
  ...EMPTY_USAGE,
  context: { window: CONTEXT_WINDOW, percent: LOW_PCT },
  rateLimits: [{ kind: 'five_hour', percentUsed: PRESSURE_PCT, resetsAt: LIMITS_RESET }],
  cost: { usd: SAMPLE_USD },
}
