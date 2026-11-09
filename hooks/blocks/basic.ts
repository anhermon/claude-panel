// Validators for the original five block kinds plus the simple new ones:
// text, list, table, code, callout, kv, progress, diff, bars, tags, quote.
import type { PanelBlock } from '../../types'
import {
  BLOCK_CAPS as C,
  CALLOUT_TONES,
  Invalid,
  arr,
  capList,
  cell,
  items,
  num,
  oneOf,
  opt,
  optStr,
  str,
  strings,
  textLines,
} from './common'
import type { Plain } from './common'

type Check = (b: Plain, path: string, trimmed: string[]) => PanelBlock

const DEFAULT_CALLOUT_TONE = 'info'
const PERCENT_MIN = 0
const PERCENT_MAX = 1
const KV_PAIR_LENGTH = 2

export const text: Check = (b, path, t) => ({
  kind: 'text',
  text: str(b.text, `${path}.text`, C.TEXT_CHARS, t),
})

export const list: Check = (b, path, t) => ({
  kind: 'list',
  items: strings(b.items, `${path}.items`, C.LIST_ITEMS, C.ITEM_CHARS, t),
})

export const table: Check = (b, path, t) => {
  const head = capList(
    arr(b.head, `${path}.head`, 'strings').map((x, i) =>
      cell(x, `${path}.head[${i}]`, C.CELL_CHARS, t),
    ),
    `${path}.head`,
    C.TABLE_COLS,
    t,
  )
  const rows = arr(b.rows, `${path}.rows`, 'string arrays').map((r, i) => {
    const cells = arr(r, `${path}.rows[${i}]`, 'strings').map((x, j) =>
      cell(x, `${path}.rows[${i}][${j}]`, C.CELL_CHARS, t),
    )
    return cells.slice(0, C.TABLE_COLS)
  })
  return { kind: 'table', head, rows: capList(rows, `${path}.rows`, C.TABLE_ROWS, t) }
}

export const code: Check = (b, path, t) => ({
  kind: 'code',
  text: textLines(b.text, `${path}.text`, C.CODE_LINES, C.CODE_LINE_CHARS, t),
  ...opt('lang', optStr(b, 'lang', path, C.LANG_CHARS, t)),
})

export const callout: Check = (b, path, t) => ({
  kind: 'callout',
  tone: oneOf(b.tone ?? DEFAULT_CALLOUT_TONE, `${path}.tone`, CALLOUT_TONES),
  text: str(b.text, `${path}.text`, C.TEXT_CHARS, t),
})

export const kv: Check = (b, path, t) => {
  const rows = arr(b.rows, `${path}.rows`, '[key, value] pairs').map((r, i) => {
    const p = `${path}.rows[${i}]`
    const pair = arr(r, p, 'strings')
    if (pair.length !== KV_PAIR_LENGTH) throw new Invalid(`${p} must be [key, value]`)
    return [
      cell(pair[0], `${p}[0]`, C.KV_KEY_CHARS, t),
      cell(pair[1], `${p}[1]`, C.KV_VALUE_CHARS, t),
    ] as [string, string]
  })
  return { kind: 'kv', rows: capList(rows, `${path}.rows`, C.KV_ROWS, t) }
}

export const progress: Check = (b, path, t) => {
  const raw = num(b.value, `${path}.value`)
  const value = Math.min(PERCENT_MAX, Math.max(PERCENT_MIN, raw))
  if (value !== raw) t.push(`${path}.value ${raw} to ${value}`)
  return {
    kind: 'progress',
    value,
    ...opt('label', optStr(b, 'label', path, C.PROGRESS_LABEL_CHARS, t)),
    ...opt('note', optStr(b, 'note', path, C.PROGRESS_NOTE_CHARS, t)),
  }
}

export const diff: Check = (b, path, t) => ({
  kind: 'diff',
  text: textLines(b.text, `${path}.text`, C.DIFF_LINES, C.DIFF_LINE_CHARS, t),
  ...opt('file', optStr(b, 'file', path, C.DIFF_FILE_CHARS, t)),
})

export const bars: Check = (b, path, t) => ({
  kind: 'bars',
  items: items(b.items, `${path}.items`, ['label', 'value'], C.BARS_ITEMS, t, (it, p) => {
    const value = num(it.value, `${p}.value`)
    if (value < 0) throw new Invalid(`${p}.value must be >= 0`)
    return { label: str(it.label, `${p}.label`, C.BARS_LABEL_CHARS, t), value }
  }),
  ...opt('unit', optStr(b, 'unit', path, C.BARS_UNIT_CHARS, t)),
})

export const tags: Check = (b, path, t) => ({
  kind: 'tags',
  items: strings(b.items, `${path}.items`, C.TAGS_ITEMS, C.TAGS_CHARS, t),
})

export const quote: Check = (b, path, t) => ({
  kind: 'quote',
  text: str(b.text, `${path}.text`, C.QUOTE_TEXT_CHARS, t),
  ...opt('by', optStr(b, 'by', path, C.QUOTE_BY_CHARS, t)),
})
