// Pure quota adapter. Only fixed provider names and measured windows leave this module.
import { isPlain } from './blocks/common'

export const QUOTA_FRESH_MS = 30 * 60_000
export const QUOTA_STATE_OK = 'ok'
export const QUOTA_STATUS = { FRESH: 'fresh', STALE: 'stale', UNAVAILABLE: 'unavailable' } as const
export const QUOTA_MIN_PCT = 0
export const QUOTA_MAX_PCT = 100
const FIVE_HOUR_MINUTES = 300
const WEEK_MINUTES = 10080
const FIVE_HOUR = '5h'
const WEEK = '7d'
const WINDOW_LABELS = [FIVE_HOUR, WEEK] as const
const CODEX_PRIMARY = 'primary'
const CODEX_SECONDARY = 'secondary'
const PROVIDERS = [
  { id: 'claude', title: 'Claude' },
  { id: 'codex', title: 'Codex' },
  { id: 'gemini', title: 'AGY Gemini shared' },
  { id: 'claude-gpt', title: 'AGY Claude/GPT pool' },
] as const

type ProviderId = typeof PROVIDERS[number]['id']
export type LimitsWindow = { label: typeof FIVE_HOUR | typeof WEEK; usedPct: number; resetsAt?: number }
export type ProviderQuota = { id: ProviderId; state: string; observedAt?: number; windows: LimitsWindow[] }
export type LimitsGroup = { title: string; status: typeof QUOTA_STATUS[keyof typeof QUOTA_STATUS]; windows: LimitsWindow[] }
export const clampQuota = (pct: number): number => Math.min(QUOTA_MAX_PCT, Math.max(QUOTA_MIN_PCT, pct))
const timestamp = (value: unknown): number | undefined => {
  const at = typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isFinite(at) ? at : undefined
}

function labelOf(raw: Record<string, unknown>): LimitsWindow['label'] | undefined {
  if (typeof raw.windowMinutes === 'number') {
    return raw.windowMinutes === FIVE_HOUR_MINUTES ? FIVE_HOUR : raw.windowMinutes === WEEK_MINUTES ? WEEK : undefined
  }
  if (typeof raw.kind !== 'string') return undefined
  if (raw.kind === CODEX_PRIMARY || /five_hour|(^|_)5h($|_)/.test(raw.kind)) return FIVE_HOUR
  if (raw.kind === CODEX_SECONDARY || /seven_day|weekly|(^|_)7d($|_)/.test(raw.kind)) return WEEK
  return undefined
}

function windowsOf(raw: unknown, isLive = false): LimitsWindow[] {
  if (!Array.isArray(raw)) return []
  const found = new Map<LimitsWindow['label'], LimitsWindow>()
  for (const value of raw) {
    if (!isPlain(value)) continue
    const label = labelOf(value)
    const pct = isLive ? value.percentUsed : value.usedPct
    if (label === undefined || typeof pct !== 'number' || !Number.isFinite(pct)) continue
    const resetsAt = timestamp(value.resetsAt)
    found.set(label, { label, usedPct: clampQuota(pct), ...(resetsAt === undefined ? {} : { resetsAt }) })
  }
  return WINDOW_LABELS.flatMap(label => found.has(label) ? [found.get(label)!] : [])
}

/** Malformed output and absent/uninstalled providers are silent. Account/source metadata is discarded. */
export function parseQuota(text: string): ProviderQuota[] {
  try {
    const raw: unknown = JSON.parse(text)
    if (!isPlain(raw) || !isPlain(raw.providers)) return []
    const providers = raw.providers
    const gemini = isPlain(providers.gemini) ? providers.gemini : undefined
    const models = isPlain(gemini?.models) ? gemini.models : undefined
    return PROVIDERS.flatMap(({ id }) => {
      const value = id === 'claude-gpt' ? models?.[id] : providers[id]
      if (!isPlain(value) || value.installed === false || (id === 'claude-gpt' && gemini?.installed === false) || typeof value.state !== 'string') return []
      const observedAt = timestamp(value.observedAt) ?? (id === 'claude-gpt' ? timestamp(gemini?.observedAt) : undefined)
      return [{ id, state: value.state, ...(observedAt === undefined ? {} : { observedAt }), windows: windowsOf(value.windows) }]
    })
  } catch {
    return []
  }
}

/** Live Claude windows are the session's truth, even when the cached provider snapshot differs. */
export function groupsOf({ claudeLive, quota = [], now }: { claudeLive?: unknown; quota?: readonly ProviderQuota[]; now: number }): LimitsGroup[] {
  try {
    const live = isPlain(claudeLive) ? windowsOf(claudeLive.rateLimits, true) : []
    return PROVIDERS.flatMap(({ id, title }) => {
      if (id === 'claude' && live.length > QUOTA_MIN_PCT) return [{ title, status: QUOTA_STATUS.FRESH, windows: live }]
      const provider = quota.find(p => p.id === id)
      if (provider === undefined) return []
      const status = provider.state !== QUOTA_STATE_OK ? QUOTA_STATUS.UNAVAILABLE
        : provider.observedAt !== undefined && now - provider.observedAt < QUOTA_FRESH_MS ? QUOTA_STATUS.FRESH : QUOTA_STATUS.STALE
      return [{ title, status, windows: status === QUOTA_STATUS.UNAVAILABLE ? [] : provider.windows }]
    })
  } catch {
    return []
  }
}
