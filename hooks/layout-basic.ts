// Terminal renderers for the five original block kinds: text, list, table,
// code, callout. Each takes the (loosely typed) block and a width in cells and
// returns pre-wrapped lines no wider than that width.
import { COLUMN_GAP, GLYPH, MIN_COL_WIDTH, TONE_COLOR, TONE_GLYPH } from './layout-types'
import type { Line, Seg, Style } from './layout-types'
import { arr, cellWidth, clean, fit, hang, own, pad, padEnd, plain, str, strs, wrapText } from './layout-text'
import type { Rec } from './layout-text'
import type { PanelTone } from '../types'

// A column squeezed below this (when its content wanted more) is unreadable:
// the table then stacks each row as `Header: value` lines instead.
const TABLE_READABLE_COL = 10
const TABLE_STACK_INDENT = '  '
const TABLE_STACK_SEP = ': '
const DEFAULT_TONE: PanelTone = 'info'
const BULLET: Seg = { text: `${GLYPH.BULLET} `, isDim: true }

export const textBlock = (b: Rec, width: number): Line[] => plain(str(b.text), width)

export const listBlock = (b: Rec, width: number): Line[] =>
  strs(b.items).flatMap(i => hang(BULLET, i, width))

function stackedTable(head: string[], rows: string[][], width: number): Line[] {
  const out: Line[] = []
  for (const r of rows) {
    out.push(...plain(r[0] ?? '', width, { isBold: true }))
    for (let c = 1; c < r.length; c++) {
      if ((r[c] ?? '') === '') continue
      const label = `${TABLE_STACK_INDENT}${fit(head[c] ?? '', Math.floor(width / 2))}${TABLE_STACK_SEP}`
      out.push(...hang({ text: label, isDim: true }, r[c] ?? '', width))
    }
  }
  return out
}

export function tableBlock(b: Rec, width: number): Line[] {
  const head = arr(b.head).map(str)
  const rows = arr(b.rows).map(r => arr(r).map(str))
  const cols = Math.max(head.length, ...rows.map(r => r.length), 0)
  if (cols === 0) return []
  const cellsOf = (c: number): string[] => [head[c] ?? '', ...rows.map(r => r[c] ?? '')]
  const natural = Array.from({ length: cols }, (_, c) =>
    Math.max(1, ...cellsOf(c).map(s => cellWidth(clean(s)))),
  )
  const widths = [...natural]
  const total = (): number => widths.reduce((a, b2) => a + b2, 0) + COLUMN_GAP * (cols - 1)
  while (total() > width) {
    const widest = Math.max(...widths)
    if (widest <= MIN_COL_WIDTH) break
    widths[widths.indexOf(widest)] = widest - 1
  }
  const isCramped = widths.some((w, c) => w < Math.min(natural[c] ?? 0, TABLE_READABLE_COL))
  if (total() > width || (isCramped && cols > 1)) return stackedTable(head, rows, width)

  // Aligned columns; a long cell wraps inside its column, so nothing is cut.
  const row = (cells: readonly string[], style: Style): Line[] => {
    const wrapped = widths.map((w, c) => wrapText(cells[c] ?? '', w))
    const height = Math.max(...wrapped.map(w => w.length))
    return Array.from({ length: height }, (_, i): Line => [
      {
        text: widths
          .map((w, c) => padEnd(wrapped[c]?.[i] ?? '', w))
          .join(pad(COLUMN_GAP))
          .trimEnd(),
        ...style,
      },
    ])
  }
  const out: Line[] = []
  if (head.length > 0) {
    out.push(...row(head, { isBold: true }))
    out.push([{ text: GLYPH.RULE.repeat(Math.min(total(), width)), isDim: true }])
  }
  for (const r of rows) out.push(...row(r, {}))
  return out
}

export function codeBlock(b: Rec, width: number): Line[] {
  const side: Seg = { text: GLYPH.CODE_SIDE, isDim: true }
  const text = clean(str(b.text))
  if (text.trim() === '') return []
  return text.split('\n').map(l => [side, { text: ' ' + fit(l, width - 2), isDim: true }])
}

export function calloutBlock(b: Rec, width: number): Line[] {
  const raw = str(b.tone)
  const tone: PanelTone = own(TONE_COLOR, raw) === undefined ? DEFAULT_TONE : (raw as PanelTone)
  return hang({ text: `${TONE_GLYPH[tone]} `, color: TONE_COLOR[tone] }, str(b.text), width, {
    color: TONE_COLOR[tone],
  })
}
