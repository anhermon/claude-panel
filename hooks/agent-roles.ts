// The ROLE of an agent in a router-kit setup (router / worker / verifier / ...) and the TICKET it works on, pure: no `$`, no I/O.
// Data-driven and tolerant. Three signals, strongest first:
//   1. the subagent type the engine reports (`worker`, or namespaced `router-kit:worker`): exact, never a guess;
//   2. the main session, which is the router only when the run has a `.router/` folder (no run: it stays the plain session);
//   3. the spawn description or name starting with a role word ("worker 01-slugify", "verify 02"), used only inside a router run and
//      only for an agent of no specialised type, so an ordinary agent ("Worker pool survey" via Explore) keeps today's look.
// Anything else has no role. The ticket is found by id in the description, name or dispatch intent: `01-slugify`, or `T01` / `ticket 1`
// for a ticket whose id starts with that number. Both return undefined rather than guess.
import type { RouterRun, RouterTicket } from './router-state'
import { plainTitle } from './agent-names'
export { plainTitle } from './agent-names'

export const ROLES = ['router', 'worker', 'verifier', 'codex-worker', 'watchdog', 'qa', 'merger'] as const
export type Role = (typeof ROLES)[number]

/** The part of an agent these functions read (a PulseLoop fits). */
export type RoleSubject = { kind?: string; type?: string; label?: string; name?: string; intent?: string }

/** The short word for a role in tight places (a diagram box). */
export const ROLE_SHORT: Readonly<Record<Role, string>> = {
  router: 'router',
  worker: 'worker',
  verifier: 'verifier',
  'codex-worker': 'codex',
  watchdog: 'watchdog',
  qa: 'qa',
  merger: 'merger',
}

/** A label that starts with one of these words (case-insensitive) is that role. */
const LABEL_WORDS: readonly (readonly [RegExp, Role])[] = [
  [/^verif(?:ier|y)\b/i, 'verifier'],
  [/^codex[- ]worker\b/i, 'codex-worker'],
  [/^worker\b/i, 'worker'],
  [/^router\b/i, 'router'],
  [/^watchdog\b/i, 'watchdog'],
  [/^qa\b/i, 'qa'],
  [/^merger\b/i, 'merger'],
]
/** Types that say nothing about the job (a label may then name the role). */
const GENERIC_TYPES: readonly string[] = ['', 'general-purpose', 'claude']
const NAMESPACE_SEP = ':'
const MAIN_KIND = 'main'

const asRole = (s: string): Role | undefined => ROLES.find(r => r === s)

/** The role of an agent, or undefined (an ordinary agent). `hasRun`: the session has a router-kit `.router/` run. */
export function roleOf(agent: RoleSubject, hasRun: boolean): Role | undefined {
  if (agent.kind === MAIN_KIND) return hasRun ? 'router' : undefined
  const type = (agent.type ?? '').trim().toLowerCase()
  const typed = asRole(type.slice(type.lastIndexOf(NAMESPACE_SEP) + 1))
  if (typed !== undefined) return typed
  if (!hasRun || !GENERIC_TYPES.includes(type)) return undefined
  const words = [agent.name, agent.label].map(s => (s ?? '').trim())
  return LABEL_WORDS.find(([pattern]) => words.some(w => pattern.test(w)))?.[1]
}

// ---- tickets -----------------------------------------------------------------------------------------------------------

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** An id is not a piece of a longer word or a longer id: `01-slugify-more` is not `01-slugify`, `301-x` is not `01-x`. */
const NOT_WORD_BEFORE = '(?<![A-Za-z0-9])'
const NOT_WORD_AFTER = '(?![A-Za-z0-9]|-[A-Za-z0-9])'
const LEADING_NUMBER = /^(\d+)(?:-|$)/
/** `T01`, `T1`, `ticket 1`, `ticket #01` for a ticket whose id starts with that number. */
const aliasOf = (id: string): RegExp | undefined => {
  const n = LEADING_NUMBER.exec(id)?.[1]
  return n === undefined ? undefined : new RegExp(`${NOT_WORD_BEFORE}(?:T|ticket\\s*#?\\s*)0*${Number(n)}(?![A-Za-z0-9])`, 'i')
}
const textOf = (a: RoleSubject): string => [a.label, a.name, a.intent].filter(s => typeof s === 'string' && s !== '').join('\n')

/** The id of the ticket of `run` the agent works on, or undefined (no run, no mention, or an alias that fits two tickets). */
export function ticketOf(agent: RoleSubject, run: RouterRun | undefined): string | undefined {
  if (run === undefined || run.tickets.length === 0) return undefined
  const text = textOf(agent)
  const full = run.tickets
    .map(t => ({ id: t.id, at: new RegExp(`${NOT_WORD_BEFORE}${escapeRe(t.id)}${NOT_WORD_AFTER}`, 'i').exec(text)?.index ?? -1 }))
    .filter(h => h.at >= 0)
    .sort((a, b) => a.at - b.at)
  if (full[0] !== undefined) return full[0].id
  const alias = run.tickets.filter(t => aliasOf(t.id)?.test(text) === true)
  return alias.length === 1 ? alias[0]?.id : undefined
}

/** What the tile shows of a ticket: its id, stage word and checks (`01-slugify` + `verified 4/4`). */
export type TicketBadge = { id: string; stage: string; text: string }

/** A finished-and-verified ticket is `verified`; every other stage keeps its name. */
const STAGE_WORD: Readonly<Record<string, string>> = { done: 'verified' }

export function badgeOf(t: RouterTicket): TicketBadge {
  const stage = STAGE_WORD[t.stage] ?? t.stage
  const passed = t.checks.filter(c => c.pass === true).length
  return { id: t.id, stage, text: t.checks.length > 0 ? `${stage} ${passed}/${t.checks.length}` : stage }
}

/** The badge of the ticket the agent works on, or undefined. */
export function ticketBadgeOf(agent: RoleSubject, run: RouterRun | undefined): TicketBadge | undefined {
  const id = ticketOf(agent, run)
  const ticket = id === undefined ? undefined : run?.tickets.find(t => t.id === id)
  return ticket === undefined ? undefined : badgeOf(ticket)
}

/** Compatibility name for callers that used the old leading-number cleaner. */
export const dropTicketNumber = (text: string): string => plainTitle(text, false)

const TAG_FALLBACK_CHARS = 6
/** A ticket id in a few characters for a diagram box: its leading number (`01`), else its first characters. */
export const tagOf = (id: string): string => LEADING_NUMBER.exec(id)?.[1] ?? id.slice(0, TAG_FALLBACK_CHARS)
