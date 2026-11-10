import type { Job, SessionProfile } from './session-context'
import { SCENE_FORM } from './variety'

export const SUGGEST_LIMIT = 4
export const LONG_SESSION_FORM = 'limits'
/** Candidates describe information shapes, not a fixed board template. New viz kinds stay plain strings. */
export const JOB_FORMS: Readonly<Record<Job, readonly string[]>> = {
  build: ['steps', 'filetree', 'testresults', 'uml', 'metric', 'timeline'],
  debug: ['hypotheses', 'timeline', 'uml', 'line', 'compare', 'metric'],
  research: ['sources', 'compare', 'treemap', 'sankey', 'bars', 'network'],
  review: ['riskgrid', 'compare', 'filetree', 'dumbbell', 'uml'],
  decide: ['decisionmatrix', 'riskgrid', 'decision', 'compare', 'ranges', 'ask'],
  explain: ['uml', 'network', 'sankey', SCENE_FORM, 'timeline'],
  ops: ['testresults', 'timeline', 'metric', 'line', 'steps', 'ranges'],
  chat: [],
}
/** Visual kinds for motion/media work; offered first when the prompt names animation, audio, video, 3D or particles. */
export const MOTION_FORMS = ['waveform', 'shotlist', 'easing', 'galton', 'particles', 'scene3d'] as const
const FRESH_NOTE = 'Choose the form that fits the evidence.'
const STALE_NOTE = 'Avoid recent forms unless the content demands them: '
const ALL_STALE_NOTE = 'Recent forms repeat; use one only when the content demands it: '
const STACK_FORMS: readonly { labels: readonly string[]; form: string }[] = [
  { labels: ['Node project', 'TypeScript', 'Python', 'Rust', 'Go'], form: 'filetree' },
  { labels: ['test suite'], form: 'testresults' },
]
const STACK_JOBS: readonly Job[] = ['build', 'review', 'ops']

export function suggestFor(profile: SessionProfile, stale: readonly string[], seed: number): { forms: string[]; note: string } {
  if (profile.job === 'chat') return { forms: [], note: '' }
  const contextual = STACK_JOBS.includes(profile.job)
    ? STACK_FORMS.filter(r => r.labels.some(l => profile.stack.includes(l))).map(r => r.form) : []
  const motion = profile.motion ? MOTION_FORMS : []
  const candidates = [...new Set([...(profile.isLong ? [LONG_SESSION_FORM] : []), ...motion, ...contextual, ...JOB_FORMS[profile.job]])]
  const fresh = candidates.filter(f => !stale.includes(f))
  // Name only forms that could have been suggested: a stale "text" or "viz" is not a candidate here.
  const staleCandidates = candidates.filter(f => stale.includes(f))
  const pool = fresh.length > 0 ? fresh : candidates
  const rotate = (list: readonly string[]): string[] => {
    const start = Number.isFinite(seed) && list.length > 0 ? ((Math.trunc(seed) % list.length) + list.length) % list.length : 0
    return [...list.slice(start), ...list.slice(0, start)]
  }
  // Motion kinds rotate among themselves and lead, so the seed can never rotate them out of view.
  const rotated = [...rotate(pool.filter(f => motion.includes(f as never))), ...rotate(pool.filter(f => !motion.includes(f as never)))]
  // A long session always leaves room for its measured limits, independent of rotation.
  const showLimits = profile.isLong && pool.includes(LONG_SESSION_FORM)
  const forms = (showLimits ? [LONG_SESSION_FORM, ...rotated.filter(f => f !== LONG_SESSION_FORM)] : rotated).slice(0, SUGGEST_LIMIT)
  return { forms, note: staleCandidates.length === 0 ? FRESH_NOTE : `${fresh.length === 0 ? ALL_STALE_NOTE : STALE_NOTE}${staleCandidates.join(', ')}.` }
}
