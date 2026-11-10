import type { On } from 'claude-code'

import { boardRefresh } from './board-host'
import { noteLimits } from './limits-state'

/** Observe the engine's figures and use the board's existing coalescing writer. */
export function registerLimits(on: On): void {
  on('session.measure', (_, e, next) => {
    noteLimits(e)
    boardRefresh()
    return next(e)
  })
}
