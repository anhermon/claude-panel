// Words for the numbers of the workflow-insight frames: a duration or a token count always carries its unit. The page has
// the same two formatters for the agent rows (web/builtin/board/insight-logic.mjs); the frames below send finished text so one
// place decides the wording. Pure.
export const MS_PER_SECOND = 1000
export const MS_PER_MINUTE = 60_000
const SEC_PER_MIN = 60
const MIN_PER_HOUR = 60
const TOKENS_K = 1000
const TOKENS_M = 1_000_000
const TOKENS_ONE_DECIMAL_BELOW = 10_000
const PERCENT = 100

/** 42_000 -> "42 s", 200_000 -> "3 min 20 s", 180_000 -> "3 min", 7_500_000 -> "2 h 05 min". */
export function formatDuration(ms: number): string {
  const total = Math.floor(Math.max(0, ms) / MS_PER_SECOND)
  if (total < SEC_PER_MIN) return `${total} s`
  const minutes = Math.floor(total / SEC_PER_MIN)
  if (minutes < MIN_PER_HOUR) {
    const seconds = total % SEC_PER_MIN
    return seconds === 0 ? `${minutes} min` : `${minutes} min ${seconds} s`
  }
  return `${Math.floor(minutes / MIN_PER_HOUR)} h ${String(minutes % MIN_PER_HOUR).padStart(2, '0')} min`
}

/** 850 -> "850 tokens", 4_250 -> "4.3k tokens", 42_400 -> "42k tokens", 1_200_000 -> "1.2M tokens". */
export function formatTokens(n: number): string {
  if (n < TOKENS_K) return `${Math.round(n)} tokens`
  if (n < TOKENS_ONE_DECIMAL_BELOW) return `${Math.round(n / (TOKENS_K / 10)) / 10}k tokens`
  if (Math.round(n / TOKENS_K) < TOKENS_K) return `${Math.round(n / TOKENS_K)}k tokens`
  return `${Math.round(n / (TOKENS_M / 10)) / 10}M tokens`
}

/** "1 agent", "3 agents". */
export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

/** Whole percent of a part of a whole (0 when the whole is nothing). */
export const percentOf = (part: number, whole: number): number => (whole > 0 ? Math.round((part / whole) * PERCENT) : 0)

/** Percentages of shares that add up to exactly 100: the rest of the rounding goes to the largest share. Input order is kept. */
export function percentShares(values: readonly number[]): number[] {
  const total = values.reduce((a, b) => a + b, 0)
  if (total <= 0) return values.map(() => 0)
  const out = values.map(v => Math.round((v / total) * PERCENT))
  const top = values.indexOf(Math.max(...values))
  out[top] = (out[top] ?? 0) + PERCENT - out.reduce((a, b) => a + b, 0)
  return out
}
