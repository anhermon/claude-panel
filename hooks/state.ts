// Pure merge / validate / trim logic for the panel state. No `$`, no I/O: the
// mod and the tests call these functions directly. The block and card
// validators live in ./blocks.
import type { PanelCard, PanelChoice, PanelLabels, PanelState, PanelStatus } from '../types'
import { validateCard, validateCards, removeIds, CARD_CAPS } from './blocks/card'
import {
  BLOCK_CAPS,
  Invalid,
  capList,
  isAbsent,
  isPlain,
  shape,
  str,
  strings,
} from './blocks/common'
import type { Plain } from './blocks/common'
import { BLOCK_KINDS } from './blocks/index'
import { FRAME_INPUT_KEYS } from './board-model'
import { LANE_INPUT_KEYS } from './pulse-lanes'

export const STATE_VERSION = 4

export { BLOCK_CAPS, BLOCK_KINDS, CARD_CAPS }

// Caps of the header and the three core lists. Spec values, plus "extra" ones.
export const CAPS = {
  TITLE_CHARS: 120,
  WHY_CHARS: 240,
  ITEM_CHARS: BLOCK_CAPS.ITEM_CHARS,
  CONTEXT_ITEMS: 6,
  DONE_ITEMS: 8,
  NEXT_ITEMS: 6,
  LABEL_CHARS: 24,
  ASK_CHARS: 240, // extra
  CHOICES: 6,
  CHOICE_ID_PATTERN: /^[a-z0-9-]{1,24}$/,
  CHOICE_ID_CHARS: 24,
  CHOICE_LABEL_CHARS: 40,
  CARDS: CARD_CAPS.CARDS,
  BLOCKS_PER_CARD: CARD_CAPS.BLOCKS,
  CARD_TITLE_CHARS: CARD_CAPS.TITLE_CHARS,
} as const

export const STATUSES: readonly PanelStatus[] = ['working', 'waiting', 'blocked', 'done']
export const LABEL_KEYS = ['context', 'done', 'next'] as const
export const INPUT_KEYS = [
  'task',
  'status',
  'ask',
  'choices',
  'labels',
  'context',
  'done',
  'done_add',
  'next',
  'cards',
  'card',
  'card_remove',
  'canvas',
  'clear',
  ...LANE_INPUT_KEYS, // taken apart by register.tsx first (./pulse-lanes.ts): applyInput never sees them
  ...FRAME_INPUT_KEYS, // likewise (./board-model.ts)
] as const

const DEFAULT_STATUS: PanelStatus = 'working'

export type ApplyResult =
  | { isOk: true; state: PanelState; trimmed: string[] }
  | { isOk: false; error: string }

export function emptyState(): PanelState {
  return {
    v: STATE_VERSION,
    rev: 0,
    updatedAt: 0,
    url: null,
    status: DEFAULT_STATUS,
    task: null,
    ask: null,
    choices: [],
    labels: {},
    context: [],
    done: [],
    next: [],
    cards: [],
    scenes: [],
  }
}

/** True when there is nothing to show (the "Waiting for Claude…" case). */
export function isEmptyState(s: PanelState): boolean {
  return (
    s.task === null &&
    s.ask === null &&
    s.context.length === 0 &&
    s.done.length === 0 &&
    s.next.length === 0 &&
    s.cards.length === 0 &&
    s.scenes.every(scene => scene.builtin === true) // the mod's own scene (the pulse) is nothing the model put there
  )
}

/** The state with a new url (or none), the revision bumped. */
export function withUrl(prev: PanelState, url: string | null, now: number): PanelState {
  return { ...prev, url, rev: prev.rev + 1, updatedAt: now }
}

/** The compact line the tool answers with: `panel rev N · cards: a, b · <url> · trimmed: …`. */
export function resultLine(s: PanelState, trimmed: readonly string[]): string {
  const parts = [`panel rev ${s.rev}`]
  if (s.cards.length > 0) parts.push(`cards: ${s.cards.map(c => c.id).join(', ')}`)
  if (s.url !== null) parts.push(s.url)
  if (trimmed.length > 0) parts.push(`trimmed: ${trimmed.join('; ')}`)
  return parts.join(' · ')
}

function task(v: unknown, trimmed: string[]): PanelState['task'] {
  if (!isPlain(v)) throw new Invalid('task must be an object {title, why}')
  const title = str(v.title, 'task.title', CAPS.TITLE_CHARS, trimmed)
  if (title === '') throw new Invalid('task.title must not be empty')
  const why = v.why === undefined ? '' : str(v.why, 'task.why', CAPS.WHY_CHARS, trimmed)
  return { title, why }
}

/**
 * The answer buttons of an `ask`: at most CHOICES `{id, label}`, ids unique and `[a-z0-9-]{1,24}`,
 * labels 1..40 characters. Too many, a bad id or a long label is refused (a button must stay a button:
 * cutting a label would change what the user clicked), and the message names the path.
 */
function choices(v: unknown): PanelChoice[] {
  if (!Array.isArray(v)) throw new Invalid('choices must be an array of {id, label}')
  if (v.length > CAPS.CHOICES)
    throw new Invalid(`choices has ${v.length} items; the limit is ${CAPS.CHOICES}: keep the ${CAPS.CHOICES} that matter most`)
  const seen = new Set<string>()
  return v.map((item, i) => {
    const at = `choices[${i}]`
    const o = shape(item, at, ['id', 'label'])
    if (typeof o.id !== 'string' || !CAPS.CHOICE_ID_PATTERN.test(o.id))
      throw new Invalid(
        `${at}.id ${JSON.stringify(o.id)} is invalid: use 1-${CAPS.CHOICE_ID_CHARS} characters from a-z, 0-9 and "-" (for example "only-503")`,
      )
    if (seen.has(o.id)) throw new Invalid(`${at}.id "${o.id}" is used twice: give each choice its own id`)
    seen.add(o.id)
    if (typeof o.label !== 'string' || o.label.trim() === '') throw new Invalid(`${at}.label must be a non-empty string`)
    const label = o.label.trim()
    if (label.length > CAPS.CHOICE_LABEL_CHARS)
      throw new Invalid(
        `${at}.label is ${label.length} characters; the limit is ${CAPS.CHOICE_LABEL_CHARS}: shorten it`,
      )
    return { id: o.id, label }
  })
}

/**
 * `ask` and `choices` are one unit. A new `ask` replaces the old buttons (they answered the old
 * question), `choices` given with it become the new ones; clearing the ask clears them; buttons
 * without a question are refused.
 */
function mergeAsk(next: PanelState, input: Plain, trimmed: string[]): void {
  const hasAsk = input.ask !== undefined
  const hasChoices = !isAbsent(input.choices)
  if (hasAsk) {
    if (input.ask === null) next.ask = null
    else {
      const ask = str(input.ask, 'ask', CAPS.ASK_CHARS, trimmed)
      next.ask = ask === '' ? null : ask
    }
    next.choices = []
  }
  if (hasChoices) {
    const list = choices(input.choices)
    if (list.length > 0 && next.ask === null)
      throw new Invalid('choices need an ask: send ask (the question the buttons answer) with them')
    next.choices = list
  }
}

/** Heading overrides merge into the existing ones; "" removes one. */
function labels(prev: PanelLabels, v: unknown, trimmed: string[]): PanelLabels {
  if (!isPlain(v)) throw new Invalid('labels must be an object {context?, done?, next?}')
  const out: PanelLabels = { ...prev }
  for (const key of Object.keys(v)) {
    if (!(LABEL_KEYS as readonly string[]).includes(key))
      throw new Invalid(`labels.${key} is not a known field (allowed: ${LABEL_KEYS.join(', ')})`)
  }
  for (const key of LABEL_KEYS) {
    if (v[key] === undefined) continue
    const label = str(v[key], `labels.${key}`, CAPS.LABEL_CHARS, trimmed)
    if (label === '') delete out[key]
    else out[key] = label
  }
  return out
}

/** Replace the card with the same id (keeping its place), or append a new one. */
function upsert(cards: PanelCard[], card: PanelCard): PanelCard[] {
  const at = cards.findIndex(c => c.id === card.id)
  if (at >= 0) return cards.map((c, i) => (i === at ? card : c))
  if (cards.length >= CARD_CAPS.CARDS)
    throw new Invalid(
      `card: already ${CARD_CAPS.CARDS} cards, remove one first (card_remove) to add "${card.id}"`,
    )
  return [...cards, card]
}

function mergeInto(base: PanelState, input: Plain, trimmed: string[]): PanelState {
  const next: PanelState = { ...base }
  if (input.task !== undefined) next.task = task(input.task, trimmed)
  if (input.status !== undefined) {
    if (!STATUSES.includes(input.status as PanelStatus))
      throw new Invalid(`status must be one of ${STATUSES.join(', ')}`)
    next.status = input.status as PanelStatus
  }
  mergeAsk(next, input, trimmed)
  if (input.labels !== undefined) next.labels = labels(base.labels, input.labels, trimmed)
  const list = (key: string, max: number, keep: 'first' | 'last' = 'first'): string[] =>
    strings(input[key], key, max, CAPS.ITEM_CHARS, trimmed, keep)
  if (input.context !== undefined) next.context = list('context', CAPS.CONTEXT_ITEMS)
  if (input.next !== undefined) next.next = list('next', CAPS.NEXT_ITEMS)
  if (input.done !== undefined) next.done = list('done', CAPS.DONE_ITEMS, 'last')
  if (input.done_add !== undefined) {
    const added = list('done_add', Number.MAX_SAFE_INTEGER)
    next.done = capList([...next.done, ...added], 'done', CAPS.DONE_ITEMS, trimmed, 'last')
  }
  if (input.cards !== undefined && input.canvas !== undefined)
    throw new Invalid('canvas is the deprecated alias of cards: send only one of them')
  if (input.cards !== undefined) next.cards = validateCards(input.cards, 'cards', trimmed)
  if (input.canvas !== undefined) next.cards = validateCards(input.canvas, 'canvas', trimmed, true)
  if (!isAbsent(input.card)) next.cards = upsert(next.cards, validateCard(input.card, 'card', trimmed))
  if (input.card_remove !== undefined) {
    const gone = new Set(removeIds(input.card_remove, 'card_remove'))
    next.cards = next.cards.filter(c => !gone.has(c.id))
  }
  return next
}

/**
 * Merge one tool call's input into the previous state. Each key given REPLACES
 * its section (`done_add` appends, `card` upserts, `card_remove` deletes);
 * `clear: true` resets the header, lists and cards first, keeping only the url,
 * the revision counter and the scenes (they have their own tool and their own
 * `clear`: a re-titled task must not make a running demo vanish). Invalid input
 * names the field.
 */
export function applyInput(prev: PanelState, input: unknown, now: number): ApplyResult {
  try {
    if (!isPlain(input)) throw new Invalid('input must be an object')
    for (const key of Object.keys(input)) {
      if (!(INPUT_KEYS as readonly string[]).includes(key))
        throw new Invalid(`unknown field "${key}" (allowed: ${INPUT_KEYS.join(', ')})`)
    }
    if (input.clear !== undefined && typeof input.clear !== 'boolean')
      throw new Invalid('clear must be a boolean')
    const trimmed: string[] = []
    const base =
      input.clear === true ? { ...emptyState(), url: prev.url, rev: prev.rev, scenes: prev.scenes } : prev
    const merged = mergeInto(base, input, trimmed)
    return { isOk: true, state: { ...merged, rev: prev.rev + 1, updatedAt: now }, trimmed }
  } catch (err) {
    if (err instanceof Invalid) return { isOk: false, error: `panel: ${err.message}` }
    throw err
  }
}

// Needs the newline: "PORT 47" may be the start of "PORT 4717". The server may
// echo the token it was given (`PORT 4717 TOKEN abc`); the mod keeps its own.
const PORT_LINE = /^PORT (\d+)(?: TOKEN \S+)?\r?\n/m
const MAX_PORT = 65535

/** The port from the server's `PORT <n>` stdout line, or null if the line is not complete (yet). */
export function parsePort(output: string): number | null {
  const m = PORT_LINE.exec(output)
  const port = m === null ? NaN : Number(m[1])
  return Number.isInteger(port) && port > 0 && port <= MAX_PORT ? port : null
}
