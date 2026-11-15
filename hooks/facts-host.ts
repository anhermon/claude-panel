// The session facts, wired (./session-facts.ts holds the rules): three pass-through hooks feed the pure reducer and the
// result is kept in an atom, so a mod reload keeps it. Best effort: whatever fails here, the prompt, call or turn still runs.
// register.tsx never touches the atom; the board reads the facts through `factsRead`.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'
import type { SessionFacts } from '../types'
import { ANY_PROMPT_TEXT, ANY_TOOL_NAME, AUTOMATED_PROMPT, HUMAN_ORIGINS, NOT_A_MESSAGE, privateNamesOf, taskFromPrompt } from './proactive'
import { factsForSession, initialFacts, isChecklistFileEdit, reduce } from './session-facts'
import type { FactsEvent } from './session-facts'

type Dollar = EngineInterface

const factsAtom = atom({ plugin: 'panel', key: 'facts' } as const, initialFacts(), { shape: 'panel-facts-1' })
let current: SessionFacts = initialFacts()
let isLoaded = false
let queue: Promise<unknown> = Promise.resolve()
let onChange: () => void = () => undefined

/** The board's redraw: told after every change of the facts (set by board-host.ts, which imports this module). */
export const setFactsListener = (fn: () => void): void => {
  onChange = fn
}

/** The facts as they stand now; read back from the atom on the first use of this module instance (a reload drops module memory). */
export async function factsRead($: Dollar): Promise<SessionFacts> {
  if (!isLoaded) {
    isLoaded = true
    current = factsForSession(await read($, factsAtom), await $.session.id())
  }
  return current
}

/** `at` is read here, inside the guard: a failing clock must not fail the prompt, call or turn this rides on. */
async function record($: Dollar, make: (t: number) => FactsEvent): Promise<void> {
  const step = async (): Promise<void> => {
    const key = await $.session.id()
    const e = make(await $.clock.now())
    current = await update($, factsAtom, f => reduce(factsForSession(f, key), e))
    isLoaded = true
    onChange()
  }
  const run = queue.then(step, step)
  queue = run
  await run.catch(() => undefined)
}

export function registerFacts(on: On): void {
  on('prompt.submit', { text: ANY_PROMPT_TEXT }, async ($, e, next) => {
    if (e.command !== undefined || e.isMeta === true || NOT_A_MESSAGE.test(e.text) || AUTOMATED_PROMPT.test(e.text)) return next(e)
    if (!HUMAN_ORIGINS.includes(e.origin?.kind ?? '')) return next(e)
    const entered = await next(e)
    if (entered.drop === undefined) {
      try {
        // every human prompt sets the goal: a work prompt as its task title, a short chat prompt as the question itself
        const title = taskFromPrompt(e.text, await privateNamesOf($)).title
        await record($, t => ({ kind: 'prompt', t, title }))
      } catch { /* the facts never fail a prompt */ }
    }
    return entered
  })
  on('tool.call', { tool: ANY_TOOL_NAME }, async ($, e, next) => {
    const out = await next(e)
    // a subagent's call is not the main session's: no write for it (the reducer ignores it too)
    if (out.deny === undefined && e.agentId === undefined) {
      const input = e as unknown as Record<string, unknown>
      // an Edit of CHECKLIST.md carries a patch, not the list: read the file back (unreadable: the list is skipped)
      const file = out.isError !== true && isChecklistFileEdit(e.tool, input) ? await $.fs.read(String(input.file_path)).then(x => (typeof x === 'string' ? x : undefined), () => undefined) : undefined
      await record($, t => ({ kind: 'tool', t, tool: e.tool, input, isError: out.isError === true, text: typeof out.text === 'string' ? out.text : '', ...(file === undefined ? {} : { file }) }))
    }
    return out
  })
  on('turn.complete', { answer: ANY_PROMPT_TEXT }, async ($, e, next) => {
    const ended = await next(e)
    if (e.agentId === undefined) await record($, t => ({ kind: 'turn', t, answer: e.answer, reason: e.reason }))
    return ended
  })
}
