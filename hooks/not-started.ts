// Attempts that never started (a codex run deferred by the load governor, a refused one) as rows. Pure: no `$`, no I/O.
// Such an attempt is retried, so the same description piles up as many rows: only the newest of each description stays, and its
// note counts the attempts folded into it ("retried 3 times"). The row's state is `waiting` (it did not run), never `done`.
import type { PulseLoop } from './pulse-model'

export const NOT_STARTED_OUTCOME = 'notstarted'
const RETRY_JOIN = ' · '
const KEY_JOIN = '|'

export const isNotStartedLoop = (l: Pick<PulseLoop, 'outcome'>): boolean => l.outcome === NOT_STARTED_OUTCOME

/** Two attempts are "the same" when they come from the same harness with the same description (case and spacing aside). */
const keyOf = (l: PulseLoop): string => [l.harness ?? '', (l.name ?? l.label).replace(/\s+/g, ' ').trim().toLowerCase()].join(KEY_JOIN)

/** The words for a count of retries: "retried 1 time", "retried 3 times". */
export const retriedText = (n: number): string => `retried ${n} ${n === 1 ? 'time' : 'times'}`

/**
 * The loops without the not-started attempts that a later attempt with the same description replaced, and how many were folded into
 * each kept loop (by id). The main loop and Claude agents are never touched; a not-started attempt nothing replaced stays.
 */
export function collapseNotStarted(loops: readonly PulseLoop[]): { loops: PulseLoop[]; retries: Map<string, number> } {
  const groups = new Map<string, PulseLoop[]>()
  for (const l of loops) if (l.source === 'external') groups.set(keyOf(l), [...(groups.get(keyOf(l)) ?? []), l])
  const dropped = new Set<PulseLoop>()
  const retries = new Map<string, number>()
  for (const group of groups.values()) {
    const newest = group.reduce((a, b) => (b.startedAt >= a.startedAt ? b : a))
    const earlier = group.filter(l => l !== newest && isNotStartedLoop(l) && l.startedAt <= newest.startedAt)
    for (const l of earlier) dropped.add(l)
    if (earlier.length > 0) retries.set(newest.id, earlier.length)
  }
  return { loops: loops.filter(l => !dropped.has(l)), retries }
}

/** The note of a not-started row: why, then how many times it was retried. */
export const noteOfNotStarted = (loop: PulseLoop, retries: number): string => [loop.why ?? '', retries > 0 ? retriedText(retries) : ''].filter(Boolean).join(RETRY_JOIN)
