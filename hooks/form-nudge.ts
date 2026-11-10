// A task alone is not a board: when the model posts only a task (no frame, no card), the tool result adds one short line
// asking for a form that fits the evidence, at most twice per session. Pure decision and text only; the state claim that
// uses them lives beside the proactive state (./proactive.ts: formNudgeLine).
import type { ProactiveState } from '../types'
import { clip } from './transcript-redact'

export const MAX_FORM_NUDGES_PER_SESSION = 2
export const FORM_NUDGE_MAX_CHARS = 200
const NUDGE_LEAD = 'Task is up. When you have first evidence, add one form that fits it'
const NUDGE_TAIL = 'do not wait for the end.'

/** The nudge is due: a task-only call, a work job, and the session's cap not yet reached. Returns the state with the nudge counted. */
export function formNudgePlan(state: ProactiveState, hasTask: boolean, hasForm: boolean): { state: ProactiveState; nudge: boolean } {
  const nudge = hasTask && !hasForm && state.job !== null && state.job !== 'chat' && state.formNudges < MAX_FORM_NUDGES_PER_SESSION
  return { state: nudge ? { ...state, formNudges: state.formNudges + 1 } : state, nudge }
}

/** One plain line, at most FORM_NUDGE_MAX_CHARS long, naming the candidate forms when there are any. */
export function formNudgeText(forms: readonly string[]): string {
  const fit = forms.length > 0 ? ` (candidates: ${forms.join(', ')})` : ''
  return clip(`${NUDGE_LEAD}${fit}; ${NUDGE_TAIL}`, FORM_NUDGE_MAX_CHARS)
}
