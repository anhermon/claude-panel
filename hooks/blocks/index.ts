// The block validator: one entry per kind, unknown kind / key / type is denied.
import type { PanelBlock, PanelBlockKind } from '../../types'
import * as basic from './basic'
import { Invalid, shape } from './common'
import type { Plain } from './common'
import * as rich from './rich'

type Check = (b: Plain, path: string, trimmed: string[]) => PanelBlock

// The allowed keys per kind, besides `kind`; the single place a kind is declared.
const KINDS: { [K in PanelBlockKind]: { keys: readonly string[]; check: Check } } = {
  text: { keys: ['text'], check: basic.text },
  list: { keys: ['items'], check: basic.list },
  table: { keys: ['head', 'rows'], check: basic.table },
  code: { keys: ['text', 'lang'], check: basic.code },
  callout: { keys: ['tone', 'text'], check: basic.callout },
  steps: { keys: ['items'], check: rich.steps },
  kv: { keys: ['rows'], check: basic.kv },
  metrics: { keys: ['items'], check: rich.metrics },
  progress: { keys: ['value', 'label', 'note'], check: basic.progress },
  diff: { keys: ['text', 'file'], check: basic.diff },
  tree: { keys: ['items'], check: rich.tree },
  options: { keys: ['items'], check: rich.options },
  timeline: { keys: ['items'], check: rich.timeline },
  sources: { keys: ['items'], check: rich.sources },
  bars: { keys: ['items', 'unit'], check: basic.bars },
  tags: { keys: ['items'], check: basic.tags },
  quote: { keys: ['text', 'by'], check: basic.quote },
}

export const BLOCK_KINDS = Object.keys(KINDS) as PanelBlockKind[]

export function validateBlock(v: unknown, path: string, trimmed: string[]): PanelBlock {
  const kind = (v as Plain | null)?.kind
  if (typeof v !== 'object' || v === null || Array.isArray(v))
    throw new Invalid(`${path} must be an object`)
  if (typeof kind !== 'string' || !Object.hasOwn(KINDS, kind))
    throw new Invalid(`${path}.kind must be one of ${BLOCK_KINDS.join(', ')}`)
  const entry = KINDS[kind as PanelBlockKind]
  return entry.check(shape(v, path, ['kind', ...entry.keys]), path, trimmed)
}
