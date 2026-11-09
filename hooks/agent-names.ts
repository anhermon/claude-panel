// Human titles for agents, never ids or hashes. Pure helpers (plainTitle, titleFromBrief, placeholderFor) plus one lazy,
// bounded, once-per-agent lookup of an agent's own transcript head (resolveBriefTitle) for an agent seen without a spawn.
// NOTE: plainTitle also exists in agent-roles.ts (T65) and avatar-model.mjs (T64): the three should be unified.
import type { EngineInterface } from 'claude-code'

import type { WorkKind } from './work-kinds'
import { briefOf } from './transcript-parse'

export const NAME_CAPS = { TITLE_CHARS: 40, TRIES: 3, RETRY_MS: 4000, RUN_TIMEOUT_MS: 5000 } as const
/** The label of a subagent nothing is known about yet. */
export const PLACEHOLDER_BASE = 'Agent'
const PLACEHOLDER_JOIN = ' · '
const PROJECTS_DIR = '.claude/projects'
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/
const FIND_DEPTH = '4'
const MAIN_ID = 'main'

/** What a latest tool kind reads as, after "Agent · ". Short on purpose: the ticker clips a name at 14 characters ("Agent · tests"). */
const KIND_WORDS: Readonly<Record<WorkKind, string>> = {
  ui: 'UI',
  logic: 'code',
  tests: 'tests',
  visual: 'look',
  docs: 'docs',
  research: 'search',
  reading: 'read',
  delegating: 'spawn',
  working: 'work',
}
/** `Agent` alone, or `Agent · read` when the latest tool kind is known. */
export const placeholderFor = (kind?: WorkKind): string => (kind === undefined ? PLACEHOLDER_BASE : `${PLACEHOLDER_BASE}${PLACEHOLDER_JOIN}${KIND_WORDS[kind]}`)
export const isPlaceholder = (label: string): boolean => label === PLACEHOLDER_BASE || label.startsWith(`${PLACEHOLDER_BASE}${PLACEHOLDER_JOIN}`)

const LEADING_TICKET = /^T\d+\b[\s·:.—–-]*/i
const TRAILING_ROUTING = /\s*\(\s*[a-z0-9._-]+(?:\/[a-z0-9._-]+){1,2}\s*\)\s*$/i
/** `Ticket: T66` (the id token and its separator): the brief may arrive on one line, so only the token goes, not the line. */
const TICKET_LINE = /^\s*(?:ticket|task)\s*[:#]\s*\S+[\s·:—–-]*/gim
const HEADING_MARK = /^[#>*\-\s]+/
const SENTENCE_END = /^(.+?[.!?])(?:\s|$)/
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g

const capitalise = (s: string): string => (s === '' ? s : s[0]!.toUpperCase() + s.slice(1))

/** `T64 · avatar redesign (sonnet/low)` -> `Avatar redesign`. A text with nothing else left keeps itself; '' stays ''. */
export function plainTitle(text: string): string {
  const flat = text.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim()
  const body = flat.replace(TRAILING_ROUTING, '').replace(LEADING_TICKET, '').trim()
  return capitalise(body === '' ? flat : body)
}

/** Cut at a word boundary within `max` characters (an ellipsis-free cut: the ticker adds its own). */
export function cutWords(text: string, max: number): string {
  if (text.length <= max) return text
  const head = text.slice(0, max + 1)
  const at = head.lastIndexOf(' ')
  return (at > max / 2 ? head.slice(0, at) : head.slice(0, max)).replace(/[\s,;:.\-—–·]+$/, '')
}

/** A short title from an agent's brief: its first imperative sentence / first line, minus `Ticket:` lines. '' when nothing usable. */
export function titleFromBrief(brief: string): string {
  const lines = brief.replace(TICKET_LINE, '\n').split('\n').map(l => l.replace(HEADING_MARK, '').trim()).filter(l => l !== '')
  const line = lines.find(l => /[\p{L}]{3}/u.test(l))
  if (line === undefined) return ''
  const tidy = line.replace(/\([^)]*\)/g, ' ').replace(/\S*[/\\=]\S*/g, ' ').replace(/\s+/g, ' ').trim()
  const sentence = SENTENCE_END.exec(tidy)?.[1] ?? tidy
  return capitalise(plainTitle(cutWords(sentence.replace(/[.!?:]+$/, ''), NAME_CAPS.TITLE_CHARS)))
}

// ---- the lazy transcript lookup ---------------------------------------------------------------------------------------------
type Attempt = { tries: number; at: number; isDone: boolean }
const attempts = new Map<string, Attempt>()
export const resetNames = (): void => attempts.clear()

/** Run a program with a timeout: its stdout, or undefined when it failed. Never throws. */
export async function run($: EngineInterface, argv: readonly string[]): Promise<string | undefined> {
  try {
    const out = await $.process.run(argv, { timeoutMs: NAME_CAPS.RUN_TIMEOUT_MS })
    return out.exitCode === 0 ? out.stdout : undefined
  } catch {
    return undefined
  }
}

/** The path of an agent's transcript file in this session (one bounded `find`), or undefined: not found, unsafe id, or the main session. */
export async function findTranscript($: EngineInterface, agentId: string): Promise<string | undefined> {
  if (agentId === MAIN_ID || !SAFE_ID.test(agentId)) return undefined
  const home = await $.env.get('HOME')
  const session = await $.session.id()
  if (home === undefined || !SAFE_ID.test(session)) return undefined
  const root = `${home.replace(/\/+$/, '')}/${PROJECTS_DIR}`
  const argv = ['find', root, '-maxdepth', FIND_DEPTH, '-type', 'f', '-path', `*/${session}/subagents/agent-${agentId}.jsonl`]
  return ((await run($, argv)) ?? '').split('\n').find(l => l !== '')
}

/**
 * The title an agent's own transcript head gives it, or undefined (not found yet, nothing usable, tried enough times).
 * At most NAME_CAPS.TRIES lookups per agent, NAME_CAPS.RETRY_MS apart; one `find` and one `head -n 1`. Never throws.
 */
export async function resolveBriefTitle($: EngineInterface, agentId: string, now: number): Promise<string | undefined> {
  const held = attempts.get(agentId) ?? { tries: 0, at: 0, isDone: false }
  if (held.isDone || held.tries >= NAME_CAPS.TRIES || (held.tries > 0 && now - held.at < NAME_CAPS.RETRY_MS) || agentId === MAIN_ID || !SAFE_ID.test(agentId)) return undefined
  attempts.set(agentId, { ...held, tries: held.tries + 1, at: now })
  try {
    const path = await findTranscript($, agentId)
    if (path === undefined) return undefined
    const title = titleFromBrief(briefOf((await run($, ['head', '-n', '1', path])) ?? ''))
    attempts.set(agentId, { tries: held.tries + 1, at: now, isDone: true })
    return title === '' ? undefined : title
  } catch {
    return undefined
  }
}
