// Session classification: only generic labels leave this module. No prompt, path or branch is kept in the profile.
export const JOBS = ['build', 'debug', 'research', 'review', 'decide', 'explain', 'ops', 'chat'] as const
export type Job = typeof JOBS[number]
export const SHORT_CHAT_WORDS = 16
export const LONG_SESSION_CALLS = 20
export const CONFIDENCE = { MATCH: 0.9, CHAT: 0.8, FALLBACK: 0.3 } as const

/** Rules and the chat gate read only this many leading characters: a long paste says what it is in its first lines. */
export const RULE_SCAN_CHARS = 300
// "look at"/"check" is a review only when something concrete is named: a path, a file name or "code".
const REVIEW_TARGET = String.raw`(?=[\s\S]*(?:[\w.-]+[\\/][\w.-]+|\b[\w-]+\.[a-z]{1,4}\b|\bcode\b))`
const DECIDE_OR_QUESTION = String.raw`\w+ or \w+\?`

/** First matching rule wins; specific work takes precedence over general build/explain words. */
export const JOB_RULES: readonly { job: Job; pattern: RegExp; signal: string }[] = [
  { job: 'review', pattern: new RegExp(String.raw`\b(?:review|audit|critique|inspect)\b|^${REVIEW_TARGET}[\s\S]*\b(?:look at|check)\b`, 'i'), signal: 'review request' },
  { job: 'decide', pattern: new RegExp(String.raw`\b(?:decide|choose|compare|trade[ -]?offs?|which option|pick between|should (?:we|i))\b|${DECIDE_OR_QUESTION}`, 'i'), signal: 'decision request' },
  { job: 'debug', pattern: /\b(debug|fix|diagnose|troubleshoot|fails?|failing|broken|crash|bug|regression|slow(?:er|ly)?|profile|errors?|exceptions?|TypeError|red)\b/i, signal: 'debugging request' },
  { job: 'research', pattern: /\b(research|investigate|look into|find out|sources|survey|literature)\b/i, signal: 'research request' },
  { job: 'ops', pattern: /\b(deploy|release|monitor|rollback|backup|migrate|restart|push|run (?:the )?(?:tests|checks)|production)\b/i, signal: 'operations request' },
  { job: 'build', pattern: /\b(build|implement|create|add|write|change|update|refactor|remove|make|develop|rename|extract|rewrite)\b/i, signal: 'build request' },
  { job: 'explain', pattern: /\b(explain|teach|walk me through|how (?:does|do|would)|help me understand)\b/i, signal: 'explanation request' },
]
const WORDS = /\s+/
const QUESTION = /\?|^(?:what|where|when|who|which|why|is|are|does|can)\b/i
const ACKNOWLEDGEMENT = /^(?:thanks?|thank you|ok(?:ay)?|got it|great|yes|no)\b/i
// Nouns such as "bug", "sources", "production" and "the build" alone do not turn a quick question into work.
const WORK_VERBS = new RegExp(String.raw`\b(?:review|audit|critique|inspect|decide|choose|compare|pick|debug|fix|diagnose|troubleshoot|research|investigate|survey|deploy|release|monitor|rollback|backup|migrate|restart|push|run|build (?:a|an|the|me|us|this|that|it|some)|implement|create|add|write|change|update|refactor|remove|make|develop|rename|extract|rewrite|explain|teach|look into|look at|check|slow(?:er|ly)?|profile|find out|walk me through|help me understand|how (?:does|do|would)|should (?:we|i))\b|${DECIDE_OR_QUESTION}`, 'i')
const SHORT_SIGNAL = 'short message without a work verb'
const FALLBACK_SIGNAL = 'general explanation'

/** Motion/media work (animation, video, audio, 3D, particles): a domain tag beside the job, not a job of its own. */
export const MOTION_PATTERN = /\b(?:animat\w*|motion|video|audio|beats?|bpm|particles?|3d|shaders?|three\.?js|blender|physics|easing|waveform|spectrogram|sprites?|pixel[ -]?art|shot ?list|galton|rapier|librosa|postprocessing)\b/i

export function jobOf(promptText: string): { job: Job; confidence: number; signals: string[] } {
  const full = promptText.trim()
  const text = full.slice(0, RULE_SCAN_CHARS)
  const isShort = full.length <= RULE_SCAN_CHARS && (text === '' || text.split(WORDS).length <= SHORT_CHAT_WORDS)
  if (isShort && (QUESTION.test(text) || ACKNOWLEDGEMENT.test(text)) && !WORK_VERBS.test(text))
    return { job: 'chat', confidence: CONFIDENCE.CHAT, signals: [SHORT_SIGNAL] }
  const rule = JOB_RULES.find(r => r.pattern.test(text))
  if (rule !== undefined) return { job: rule.job, confidence: CONFIDENCE.MATCH, signals: [rule.signal] }
  if (isShort)
    return { job: 'chat', confidence: CONFIDENCE.CHAT, signals: [SHORT_SIGNAL] }
  return { job: 'explain', confidence: CONFIDENCE.FALLBACK, signals: [FALLBACK_SIGNAL] }
}

export const STACK_RULES = [
  { markers: ['package.json'], label: 'Node project' },
  { markers: ['tsconfig.json'], label: 'TypeScript' },
  { markers: ['pyproject.toml', 'requirements.txt'], label: 'Python' },
  { markers: ['Cargo.toml'], label: 'Rust' },
  { markers: ['go.mod'], label: 'Go' },
  { markers: ['.router'], label: 'router-kit run' },
  { markers: ['.git'], label: 'git repo' },
  { markers: ['test', 'tests', '__tests__', 'spec', 'specs', 'e2e'], label: 'test suite' },
] as const
const GIT_LABEL = 'git repo'

export function stackOf(markerNames: readonly string[], branchName?: string): string[] {
  const names = new Set(markerNames)
  const labels: string[] = STACK_RULES.filter(r => r.markers.some(m => names.has(m))).map(r => r.label)
  if (branchName?.trim() && !labels.includes(GIT_LABEL)) labels.push(GIT_LABEL)
  return labels
}

export type ProfileInput = { prompt: string; markers: readonly string[]; branch?: string; toolCounts: Readonly<Record<string, number>> }
export type SessionProfile = ReturnType<typeof jobOf> & { stack: string[]; totalCalls: number; isLong: boolean; motion: boolean }

export function profileOf({ prompt, markers, branch, toolCounts }: ProfileInput): SessionProfile {
  const totalCalls = Object.values(toolCounts).reduce((sum, n) => sum + (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0), 0)
  return { ...jobOf(prompt), stack: stackOf(markers, branch), totalCalls, isLong: totalCalls >= LONG_SESSION_CALLS, motion: MOTION_PATTERN.test(prompt.slice(0, RULE_SCAN_CHARS)) }
}
