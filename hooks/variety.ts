// Anti-repetition, pure: the board remembers the forms of the last few panel updates (frame types, scene publishes) and,
// when the model keeps reaching for the same one, one line asks it to look at the others. A nudge, never a refusal.
import { FRAME_TYPES } from './board-frames'

/** How many recent forms are remembered. */
export const RECENT_MAX = 6
/** This many identical forms in a row ... */
export const STREAK_MIN = 3
/** ... or one form with this share of the remembered ones counts as repeating. */
export const DOMINANT_SHARE = 0.6
/** At most this many other forms are suggested. */
export const SUGGEST_MAX = 3
/** What a scene publish is called in the memory. */
export const SCENE_FORM = 'scene'
/** Forms never suggested: the mod draws them itself (the time and repeat frames of the workflow insight; `hints` stays: advice cards fit any job), or they only fit one moment (a question, a wait). */
const NOT_SUGGESTED: readonly string[] = ['now', 'lanes', 'pulse', 'ask', 'avatar', 'kindstack', 'sinks', 'repeats', 'tickets', 'checks']

/** The memory with `form` added, the oldest dropped. */
export const pushRecent = (recent: readonly string[], form: string): string[] => [...recent, form].slice(-RECENT_MAX)

/** A stored memory read back: strings only, at most RECENT_MAX. */
export const restoreRecent = (raw: unknown): string[] => (Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string').slice(-RECENT_MAX) : [])

/** The form repeated too often, with how many times in a row (`streak`) or in the window (`share`); undefined when the mix is fine. */
function repeated(recent: readonly string[]): { form: string; count: number; isStreak: boolean } | undefined {
  const last = recent[recent.length - 1]
  if (last === undefined || recent.length < STREAK_MIN) return undefined
  let run = 0
  while (run < recent.length && recent[recent.length - 1 - run] === last) run++
  if (run >= STREAK_MIN) return { form: last, count: run, isStreak: true }
  const counts = new Map<string, number>()
  for (const f of recent) counts.set(f, (counts.get(f) ?? 0) + 1)
  const [form, count] = [...counts].sort((a, b) => b[1] - a[1])[0] ?? ['', 0]
  return count / RECENT_MAX >= DOMINANT_SHARE && recent.length >= RECENT_MAX ? { form, count, isStreak: false } : undefined
}

/** Other forms to try: unused in the window, and a start that moves with the history so the same three are not always named. */
function unused(recent: readonly string[]): string[] {
  const pool = FRAME_TYPES.filter(t => !recent.includes(t) && !NOT_SUGGESTED.includes(t))
  const start = recent.join('').length % Math.max(pool.length, 1)
  return [...pool.slice(start), ...pool.slice(0, start)].slice(0, SUGGEST_MAX)
}

/** The one line for the prompt and the tool result, or '' when the recent forms are varied enough. */
export function varietyHint(recent: readonly string[]): string {
  const r = repeated(recent)
  if (r === undefined) return ''
  const lead = r.isStreak ? `Your last ${r.count} panel updates were all "${r.form}".` : `${r.count} of your last ${RECENT_MAX} panel updates were "${r.form}".`
  const others = unused(recent)
  return `${lead} Choose a different form if the content allows${others.length > 0 ? `: not used recently: ${others.join(', ')}` : ''}.`
}
