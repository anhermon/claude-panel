// Card validation: a card is a stable id, an optional title / span / pin / tone,
// and up to CARD_BLOCKS blocks. Also the deprecated `canvas` group alias.
import type { PanelCard, PanelTone } from '../../types'
import { validateBlock } from './index'
import { Invalid, arr, capList, isAbsent, oneOf, opt, optStr, shape } from './common'
import type { Plain } from './common'

export const CARD_CAPS = {
  CARDS: 8,
  BLOCKS: 8,
  TITLE_CHARS: 60,
  ID_CHARS: 24,
  ID_PATTERN: /^[a-z0-9-]{1,24}$/,
} as const

export const CARD_SPANS = [1, 2, 3] as const
export const CARD_TONES: readonly PanelTone[] = ['info', 'warn', 'ok', 'danger']
const CARD_KEYS = ['id', 'title', 'span', 'pin', 'tone', 'blocks'] as const
const CANVAS_KEYS = ['id', 'title', 'blocks'] as const
const GENERATED_ID_PREFIX = 'c'

export function cardId(v: unknown, path: string): string {
  if (typeof v !== 'string' || !CARD_CAPS.ID_PATTERN.test(v))
    throw new Invalid(`${path} must match [a-z0-9-]{1,24}`)
  return v
}

function blocks(v: unknown, path: string, trimmed: string[]): PanelCard['blocks'] {
  return capList(
    arr(v, path, 'blocks').map((b, i) => validateBlock(b, `${path}[${i}]`, trimmed)),
    path,
    CARD_CAPS.BLOCKS,
    trimmed,
  )
}

/** One card. `fallbackId` (canvas groups) stands in for a missing id. */
export function validateCard(
  v: unknown,
  path: string,
  trimmed: string[],
  fallbackId?: string,
): PanelCard {
  const c: Plain = shape(v, path, fallbackId === undefined ? CARD_KEYS : CANVAS_KEYS)
  const id = cardId(isAbsent(c.id) ? fallbackId : c.id, `${path}.id`)
  if (!isAbsent(c.pin) && typeof c.pin !== 'boolean')
    throw new Invalid(`${path}.pin must be a boolean`)
  if (!isAbsent(c.span) && !(CARD_SPANS as readonly unknown[]).includes(c.span))
    throw new Invalid(`${path}.span must be one of ${CARD_SPANS.join(', ')}`)
  return {
    id,
    ...opt('title', optStr(c, 'title', path, CARD_CAPS.TITLE_CHARS, trimmed)),
    ...opt('span', isAbsent(c.span) ? undefined : (c.span as PanelCard['span'])),
    ...opt('pin', isAbsent(c.pin) ? undefined : (c.pin as boolean)),
    ...opt('tone', isAbsent(c.tone) ? undefined : oneOf(c.tone, `${path}.tone`, CARD_TONES)),
    blocks: blocks(c.blocks, `${path}.blocks`, trimmed),
  }
}

function noDuplicateIds(cards: PanelCard[], path: string): PanelCard[] {
  const seen = new Set<string>()
  cards.forEach((card, i) => {
    if (seen.has(card.id)) throw new Invalid(`${path}[${i}].id "${card.id}" is used twice`)
    seen.add(card.id)
  })
  return cards
}

/** A whole card list (`cards`, or the `canvas` alias when `isCanvas`), capped. */
export function validateCards(
  v: unknown,
  path: string,
  trimmed: string[],
  isCanvas = false,
): PanelCard[] {
  const list = arr(v, path, isCanvas ? 'groups' : 'cards').map((c, i) =>
    validateCard(c, `${path}[${i}]`, trimmed, isCanvas ? `${GENERATED_ID_PREFIX}${i + 1}` : undefined),
  )
  return capList(noDuplicateIds(list, path), path, CARD_CAPS.CARDS, trimmed)
}

/** `card_remove`: one id or a list of ids. */
export function removeIds(v: unknown, path: string): string[] {
  const list = typeof v === 'string' ? [v] : arr(v, path, 'card ids')
  return list.map((id, i) => cardId(id, typeof v === 'string' ? path : `${path}[${i}]`))
}
