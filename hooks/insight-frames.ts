// The four workflow-insight frames the board draws by itself (auto frames, see board-model.ts): `time-by-kind` (one stacked
// bar per agent), `time-sinks` (where all agent time went), `repeats` (the same files and commands again and again) and
// `improve` (evidence-backed suggestions). Each is left out while its data is thin. Pure: no `$`, no I/O.
import type { BoardFrame } from '../types'
import { hintsFrame, HINTS_FRAME_ID } from './insight-hints'
import { repeatsFrame, REPEAT_FRAME_ID } from './insight-repeats'
import { kindStackFrame, sinksFrame, subjectsOf, TIME_FRAME_IDS } from './insight-time'
import type { PulseEvent, PulseLoop } from './pulse-model'

/** The ids of the four frames, in the order the board shows them. */
export const INSIGHT_FRAME_IDS = [TIME_FRAME_IDS.BY_KIND, TIME_FRAME_IDS.SINKS, REPEAT_FRAME_ID, HINTS_FRAME_ID] as const

/** The frames that have something to say now, in board order. */
export function insightFrames(loops: readonly PulseLoop[], events: readonly PulseEvent[], now: number): BoardFrame[] {
  const subjects = subjectsOf(loops, events, now)
  return [kindStackFrame(subjects), sinksFrame(subjects), repeatsFrame(loops, subjects), hintsFrame(loops, subjects)].filter((f): f is BoardFrame => f !== undefined)
}
