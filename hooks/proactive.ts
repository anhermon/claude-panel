// Proactive panel: a short per-job context note on the prompt, form variety across sessions, and a task safety net.
// Pure decisions first; engine hooks below only read context, preserve the chain and apply those decisions.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'
import type { PanelTask, ProactiveState } from '../types'
export type { ProactiveState } from '../types'
import { plainTitle } from './agent-names'
import { formNudgePlan, formNudgeText } from './form-nudge'
import { pushForm, readHistory, staleForms, startSession, writeHistory } from './context-history'
import { panelConfig } from './panel-config'
import { jobOf, MOTION_PATTERN, profileOf, RULE_SCAN_CHARS } from './session-context'
import type { Job, SessionProfile } from './session-context'
import { SCENE_FULL_NAME, TOOL_FULL_NAME } from './spec'
import { suggestFor } from './suggest'
import { clip, scrubText } from './transcript-redact'

/** Shared with the browser-event hook: commands and shell escapes are not messages. */
export const NOT_A_MESSAGE = /^\s*[/!]/
/** Prompts the harness writes itself (background-task and hook notices): the person did not type them, so they never set the session's job. */
export const AUTOMATED_PROMPT = /\[SYSTEM NOTIFICATION|<task-notification>|^\s*<system-reminder>/
export const CONTEXT_MAX_CHARS = 450
export const TASK_TITLE_CHARS = 80
export const TASK_WHY = 'Started from your request; Claude will refine it'
const TASK_FALLBACK = 'Work on your request'
const CONTEXT_OPEN = '<panel-context>'
const CONTEXT_CLOSE = '</panel-context>'
const STACK_CHARS = 65
const NOTE_CHARS = 120
const NO_STACK = 'general session'
const START_INSTRUCTION = 'Post the task + why on the panel now if this will take more than a few tool calls.'
const SEED_MULTIPLIER = 31
const SEED_MODULUS = 2 ** 32
// A sentence ends at ". " but not inside "e.g." / "i.e.".
const SENTENCE_END = /(?<=[.!?])(?<!\b[a-z]\.[a-z]\.)\s|\n/i
/** Only the head of a prompt is ever scrubbed: a huge paste must not stall the hook. */
export const TASK_INPUT_CHARS = 400
/** A new job is announced again only after this many non-chat prompts since the last note, and never more than the cap per session. */
export const INJECT_COOLDOWN_PROMPTS = 5
export const MAX_INJECTIONS_PER_SESSION = 3
/** Only prompts the person sent themselves (terminal or bridge) set the job or seed a task. */
const HUMAN_ORIGINS: readonly string[] = ['composer', 'bridge']
/** Tools that keep the books and are not work: they never arm the task safety net. */
export const BOOKKEEPING_TOOLS: ReadonlySet<string> = new Set(['ToolSearch', 'TodoWrite', 'Skill', 'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList', 'TaskOutput', 'TaskStop'])
const SENTENCE_MARK = '<panel-task-end>'
// Strip whole paths after transcript redaction; a home prefix alone is not enough for a public task title.
const PATH_WORD = /(?:\b[A-Za-z]:(?=[\\/])|(?<![\w.-]))(?:~?[\\/]|\.{1,2}[\\/])[^\s"'`<>]+/g
// "src/app.ts", "a/b/c": paths; "read/write", "I/O": plain words.
const SLASH_WORD = /\b[\w.-]+(?:[\\/][^\s"'`<>\\/]+)+/g
const SLASH_TRAILING = /[.,;:!?)\]]+$/
const SLASH_PATH_SEGMENTS = 3
const EMAIL_WORD = /[\w.+-]+@[\w-]+\.[\w.-]+/g
const EMAIL_MARK = '[email]'
const PATH_MARK = '[path]'
const NAME_MARK = '[user]'
const PRIVATE_NAME_MIN_CHARS = 4
const REGEX_META = /[.*+?^${}()|[\]\\]/g
const PATH_SPLIT = /[\\/]/
const GIT_MARKER = '.git'
const ANY_PROMPT_TEXT = /[\s\S]*/
/** Every tool name: the engine wants a matcher when several hooks watch tool.call. */
export const ANY_TOOL_NAME = /./

export const initialProactive = (sessionKey: string | null = null): ProactiveState => ({
  lastInjected: null, job: null, title: null, calls: 0, seeded: false, toolCounts: {}, sessionKey, injections: 0, sinceInjection: 0, formNudges: 0, motion: false,
})
const proactiveAtom = atom({ plugin: 'panel', key: 'proactive' } as const, initialProactive(), { shape: 'panel-proactive-4' })

export const seedOf = (id: string): number => [...id].reduce((seed, char) => (seed * SEED_MULTIPLIER + char.charCodeAt(0)) % SEED_MODULUS, 0)

/** Bookkeeping that follows the session: a different session id means a fresh conversation (for example after /clear). */
export const forSession = (state: ProactiveState, sessionKey: string): ProactiveState => state.sessionKey === sessionKey ? state : initialProactive(sessionKey)

/** `title` is the already-redacted task title: the raw prompt is never kept. */
export function promptPlan(state: ProactiveState, job: Job, title: string): { state: ProactiveState; inject: boolean } {
  // Chat keeps the stored title so an approval ("yes, do it") after a plan can still start the task; it only restarts the count.
  if (job === 'chat') return { state: { ...state, calls: 0 }, inject: false }
  const inject = state.injections < MAX_INJECTIONS_PER_SESSION
    && (state.injections === 0 || (job !== state.lastInjected && state.sinceInjection >= INJECT_COOLDOWN_PROMPTS))
  const next = { ...state, job, title, calls: 0, seeded: false }
  return { state: inject ? { ...next, lastInjected: job, injections: state.injections + 1, sinceInjection: 0 } : { ...next, sinceInjection: state.sinceInjection + 1 }, inject }
}

export function callPlan(state: ProactiveState, tool: string, threshold: number, hasTask: boolean): { state: ProactiveState; seed: boolean } {
  if (tool === TOOL_FULL_NAME || tool === SCENE_FULL_NAME) return { state, seed: false }
  const counts = { ...state.toolCounts, [tool]: (state.toolCounts[tool] ?? 0) + 1 }
  if (BOOKKEEPING_TOOLS.has(tool)) return { state: { ...state, toolCounts: counts }, seed: false }
  const calls = state.title === null ? state.calls : state.calls + 1
  const seed = threshold > 0 && state.title !== null && !state.seeded && !hasTask && calls >= threshold
  return { state: { ...state, calls, seeded: state.seeded || seed || hasTask, toolCounts: counts }, seed }
}

function plainSlashWord(word: string): string {
  const core = word.replace(SLASH_TRAILING, '')
  return core.includes('.') || core.split(PATH_SPLIT).length >= SLASH_PATH_SEGMENTS ? PATH_MARK : word
}

export function taskFromPrompt(prompt: string, privateNames: readonly string[] = []): PanelTask {
  // Cut first: the scrub below is quadratic in the length of a pasted blob, and only one sentence is used.
  // Mark the boundary before redaction: a secret's trailing period may be scrubbed away with its value.
  const head = prompt.slice(0, TASK_INPUT_CHARS)
  let text = scrubText(head.replace(SENTENCE_END, ` ${SENTENCE_MARK} `)).split(SENTENCE_MARK)[0] ?? ''
  text = text.replace(EMAIL_WORD, EMAIL_MARK).replace(PATH_WORD, PATH_MARK).replace(SLASH_WORD, plainSlashWord)
  for (const name of privateNames.filter(n => n.trim().length >= PRIVATE_NAME_MIN_CHARS)) {
    const escaped = name.replace(REGEX_META, '\\$&')
    text = text.replace(new RegExp(`\\b${escaped}\\b`, 'gi'), NAME_MARK)
  }
  return { title: clip(plainTitle(text), TASK_TITLE_CHARS) || TASK_FALLBACK, why: TASK_WHY }
}

export function contextBlock(profile: SessionProfile, stale: readonly string[], seed: number): string {
  const suggestion = suggestFor(profile, stale, seed)
  const stack = clip(profile.stack.join(', ') || NO_STACK, STACK_CHARS)
  const body = `Session: ${profile.job}; ${stack}. ${START_INSTRUCTION} Candidates: ${suggestion.forms.join(', ')}. ${clip(suggestion.note, NOTE_CHARS)}`
  return `${CONTEXT_OPEN}${clip(body, CONTEXT_MAX_CHARS - CONTEXT_OPEN.length - CONTEXT_CLOSE.length)}${CONTEXT_CLOSE}`
}

export function formsOfFrame(frame: unknown): string[] {
  if (frame === null || typeof frame !== 'object') return []
  const { type, kind } = frame as { type?: unknown; kind?: unknown }
  return typeof type !== 'string' ? [] : [type, ...(type === 'viz' && typeof kind === 'string' ? [kind] : [])]
}

let historyQueue: Promise<unknown> = Promise.resolve()
let promptQueue: Promise<unknown> = Promise.resolve()
async function remember($: EngineInterface, forms: readonly string[], job?: Job): Promise<void> {
  if (!panelConfig.proactive) return
  const step = async (): Promise<void> => {
    const key = await $.session.id()
    const state = await read($, proactiveAtom)
    let history = startSession(await readHistory($), key, job ?? state.job ?? 'chat', await $.clock.now())
    for (const form of forms) history = pushForm(history, key, form)
    await writeHistory($, history)
  }
  const run = historyQueue.then(step, step)
  historyQueue = run
  // History is a nicety: a failing clock or store must never fail the panel call that already succeeded.
  await run.catch(() => undefined)
}
export async function recordForms($: EngineInterface, forms: readonly string[]): Promise<void> {
  if (forms.length > 0) await remember($, forms)
}

/** The engine requires literal environment names here so its permission inventory can list them. */
async function privateNamesOf($: EngineInterface): Promise<string[]> {
  const names = await Promise.all([$.env.get('USER').catch(() => undefined), $.env.get('LOGNAME').catch(() => undefined)])
  const home = await $.env.get('HOME').catch(() => undefined)
  return [...names, home?.split(PATH_SPLIT).at(-1)].filter((n): n is string => n !== undefined)
}

/** Task IO stays in register (the single writer of the panel state), which also owns the tool.call hook that seeds: this module imports nothing from it. */
export function registerProactive(on: On): void {
  on('prompt.submit', { text: ANY_PROMPT_TEXT }, async ($, e, next) => {
    if (!panelConfig.proactive || e.command !== undefined || e.isMeta === true || NOT_A_MESSAGE.test(e.text) || AUTOMATED_PROMPT.test(e.text)) return next(e)
    if (!HUMAN_ORIGINS.includes(e.origin?.kind ?? '')) return next(e)
    const step = async () => {
      const key = await $.session.id()
      const state = forSession(await read($, proactiveAtom), key)
      const job = jobOf(e.text).job
      const title = job === 'chat' ? '' : taskFromPrompt(e.text, await privateNamesOf($)).title
      const planned = promptPlan(state, job, title)
      // The tag is kept (not the prompt) so a later form nudge can still offer motion kinds.
      const plan = { ...planned, state: { ...planned.state, motion: job === 'chat' ? state.motion : MOTION_PATTERN.test(e.text.slice(0, RULE_SCAN_CHARS)) } }
      let block: string | undefined
      if (plan.inject) {
        const [markers, repo, history] = await Promise.all([$.fs.list().catch(() => []), $.session.repo().catch(() => null), readHistory($)])
        const profile = profileOf({ prompt: e.text, markers: [...markers.map(m => m.name), ...(repo === null ? [] : [GIT_MARKER])], toolCounts: state.toolCounts })
        block = contextBlock(profile, staleForms(history.filter(s => s.sessionKey !== key)), seedOf(key))
      }
      const entered = await next(block === undefined ? e : { ...e, context: [...(e.context ?? []), block] })
      // A dropped prompt does not consume the first-prompt nudge or arm the task safety net.
      if (entered.drop === undefined) {
        await update($, proactiveAtom, current => ({ ...plan.state, toolCounts: current.sessionKey === key ? current.toolCounts : plan.state.toolCounts }))
        if (job !== 'chat') await remember($, [], job)
      }
      return entered
    }
    const run = promptQueue.then(step, step)
    promptQueue = run
    return run
  })
}

/** True for a call that can count toward the safety net: the main loop's, and not the panel's own tools. */
export const isCountedCall = (e: { tool: string; agentId?: unknown }): boolean =>
  panelConfig.proactive && e.agentId === undefined && e.tool !== TOOL_FULL_NAME && e.tool !== SCENE_FULL_NAME

/** Counts one call. Returns the title to seed when this call reaches the threshold (the claim is taken here: only one caller gets it). */
export async function noteToolCall($: EngineInterface, tool: string, hasTask: boolean): Promise<string | null> {
  const key = await $.session.id()
  let title: string | null = null
  await update($, proactiveAtom, state => {
    const plan = callPlan(forSession(state, key), tool, panelConfig.autoTaskAfterCalls, hasTask)
    // update may retry after a concurrent write: clear a seed decision that lost that race.
    title = plan.seed ? plan.state.title : null
    return plan.state
  })
  return title
}

/** Seeding failed: give the claim back so a later call can try again. */
export async function releaseSeed($: EngineInterface): Promise<void> {
  await update($, proactiveAtom, state => ({ ...state, seeded: false }))
}

/**
 * The line for the result of a main-session `panel` call, or '' when none is due (./form-nudge.ts decides). The claim is
 * taken atomically, so concurrent calls never exceed the cap.
 */
export async function formNudgeLine($: EngineInterface, hasTask: boolean, hasForm: boolean): Promise<string> {
  if (!panelConfig.proactive || !hasTask || hasForm) return ''
  const key = await $.session.id()
  const box: { job: Job | null; motion: boolean; toolCounts: ProactiveState['toolCounts'] } = { job: null, motion: false, toolCounts: {} }
  await update($, proactiveAtom, state => {
    const plan = formNudgePlan(forSession(state, key), hasTask, hasForm)
    // update may retry after a concurrent write: reset a decision that lost that race.
    box.job = plan.nudge ? plan.state.job : null
    box.motion = plan.state.motion
    box.toolCounts = plan.state.toolCounts
    return plan.nudge ? plan.state : state
  })
  if (box.job === null) return ''
  const history = await readHistory($)
  const profile = { ...profileOf({ prompt: '', markers: [], toolCounts: box.toolCounts }), job: box.job, motion: box.motion }
  return formNudgeText(suggestFor(profile, staleForms(history.filter(s => s.sessionKey !== key)), seedOf(key)).forms)
}
