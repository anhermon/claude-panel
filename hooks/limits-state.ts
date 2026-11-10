// Module memory only: a reload reads the engine again on the board's first use.
import type { EngineInterface, SessionUsage } from 'claude-code'

export type LimitsUsage = Pick<SessionUsage, 'context' | 'rateLimits' | 'cost'>
type State = { usage?: LimitsUsage; reading?: Promise<void> }
let state: State = {}

export function noteLimits(usage: LimitsUsage): void {
  state.usage = { context: usage.context, rateLimits: usage.rateLimits, ...(usage.cost === undefined ? {} : { cost: usage.cost }) }
}

/** Read once on first use, and afresh at session start. A measurement arriving during a read wins. */
export async function limitsUsage($: EngineInterface, isForced = false): Promise<LimitsUsage | undefined> {
  if (isForced) state = {}
  const current = state
  if (current.usage === undefined) {
    current.reading ??= (async () => {
      try {
        const usage = await $.session.usage()
        current.usage ??= usage
      } catch {
        // An unavailable reading leaves the board alone; a later use can try again.
      } finally {
        current.reading = undefined
      }
    })()
    await current.reading
  }
  return state.usage
}
