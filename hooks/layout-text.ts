// Text primitives for the terminal layout, all in terminal CELLS (a wide CJK
// or emoji glyph is 2, a combining mark 0): measuring, truncating with `…`,
// padding, word-wrapping, and the coercion helpers that make a malformed block
// render as less instead of throwing. Pure, no `$`.
import { GLYPH } from './layout-types'
import type { Line, Seg, Style } from './layout-types'

// East Asian wide / emoji ranges (inclusive) and zero-width ranges. Ambiguous
// symbols such as ✓ ● ★ stay 1: that is what terminals draw by default.
const WIDE_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f], [0x231a, 0x231b], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3],
  [0x25fd, 0x25fe], [0x2614, 0x2615], [0x2648, 0x2653], [0x267f, 0x267f], [0x2693, 0x2693],
  [0x26a1, 0x26a1], [0x26aa, 0x26ab], [0x26bd, 0x26be], [0x26c4, 0x26c5], [0x26ce, 0x26ce],
  [0x26d4, 0x26d4], [0x26ea, 0x26ea], [0x26f2, 0x26f3], [0x26f5, 0x26f5], [0x26fa, 0x26fa],
  [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b], [0x2728, 0x2728], [0x274c, 0x274c],
  [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797], [0x27b0, 0x27b0],
  [0x27bf, 0x27bf], [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55], [0x2e80, 0x303e],
  [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xac00, 0xd7a3],
  [0xf900, 0xfaff], [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x1f300, 0x1f64f],
  [0x1f680, 0x1f6ff], [0x1f900, 0x1f9ff], [0x20000, 0x3fffd],
]
const ZERO_RANGES: readonly (readonly [number, number])[] = [
  [0x0000, 0x001f], [0x007f, 0x009f], [0x0300, 0x036f], [0x200b, 0x200f], [0x2060, 0x2064],
  [0x20d0, 0x20ff], [0xfe00, 0xfe0f], [0xfe20, 0xfe2f],
]
const TAB_AS = '  '

const inRanges = (cp: number, ranges: readonly (readonly [number, number])[]): boolean =>
  ranges.some(([lo, hi]) => cp >= lo && cp <= hi)

function charWidth(cp: number): number {
  if (inRanges(cp, ZERO_RANGES)) return 0
  return inRanges(cp, WIDE_RANGES) ? 2 : 1
}

/** Display width of `text` in terminal cells. */
export function cellWidth(text: string): number {
  let w = 0
  for (const ch of text) w += charWidth(ch.codePointAt(0) ?? 0)
  return w
}

/** Tabs become spaces, other control characters vanish, CRLF becomes LF. */
export const clean = (text: string): string =>
  // eslint-disable-next-line no-control-regex
  text.replace(/\r\n?/g, '\n').replace(/\t/g, TAB_AS).replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, '')

export const pad = (n: number): string => ' '.repeat(Math.max(0, n))
export const padEnd = (text: string, w: number): string => text + pad(w - cellWidth(text))
export const padStart = (text: string, w: number): string => pad(w - cellWidth(text)) + text

/** The longest head of `text` that is at most `w` cells, and the rest. */
function splitAt(text: string, w: number): [string, string] {
  let used = 0
  let head = ''
  const chars = Array.from(text)
  let i = 0
  for (; i < chars.length; i++) {
    const cw = charWidth((chars[i] as string).codePointAt(0) ?? 0)
    if (used + cw > w && head !== '') break
    used += cw
    head += chars[i]
  }
  return [head, chars.slice(i).join('')]
}

/** `text` cut to `w` cells, ending in `…` when it was cut. One line. */
export function fit(text: string, w: number): string {
  const flat = clean(text).replace(/\n/g, ' ')
  if (w <= 0) return ''
  if (cellWidth(flat) <= w) return flat
  return splitAt(flat, Math.max(0, w - 1))[0] + GLYPH.ELLIPSIS
}

/** Word-wrap `text` to `width` cells; paragraph breaks kept, long words broken. */
export function wrapText(text: string, width: number): string[] {
  const w = Math.max(1, width)
  const out: string[] = []
  for (const para of clean(text).split('\n')) {
    let line = ''
    let lineW = 0
    for (const word of para.split(/\s+/).filter(x => x !== '')) {
      let rest = word
      let restW = cellWidth(rest)
      if (restW > w) {
        if (line !== '') out.push(line)
        line = ''
        lineW = 0
        while (cellWidth(rest) > w) {
          const [head, tail] = splitAt(rest, w)
          out.push(head)
          rest = tail
        }
        restW = cellWidth(rest)
      }
      if (line === '') {
        line = rest
        lineW = restW
      } else if (lineW + 1 + restW <= w) {
        line += ' ' + rest
        lineW += 1 + restW
      } else {
        out.push(line)
        line = rest
        lineW = restW
      }
    }
    out.push(line)
  }
  return out
}

export const lineWidth = (l: Line): number => l.reduce((sum, s) => sum + cellWidth(s.text), 0)
export const isBlank = (l: Line): boolean => l.every(s => s.text.trim() === '')

/** `prefix` on the first line, a blank of the same width on the rest. */
export function hang(prefix: Seg, text: string, width: number, style: Style = {}): Line[] {
  const pw = cellWidth(prefix.text)
  return wrapText(text, Math.max(1, width - pw)).map((l, i) => [
    i === 0 ? prefix : { text: pad(pw) },
    { text: l, ...style },
  ])
}

export const plain = (text: string, width: number, style: Style = {}): Line[] =>
  wrapText(text, width).map(l => [{ text: l, ...style }])

// Coercion: blocks arrive from the model, so every read tolerates a wrong type.
/** A table lookup that ignores inherited keys (`constructor`, `toString`...). */
export const own = <T>(table: Readonly<Record<string, T>>, key: string): T | undefined =>
  Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined
export type Rec = Record<string, unknown>
export const str = (x: unknown): string => (typeof x === 'string' ? x : '')
export const arr = (x: unknown): unknown[] => (Array.isArray(x) ? x : [])
export const rec = (x: unknown): Rec => (typeof x === 'object' && x !== null ? (x as Rec) : {})
export const recs = (x: unknown): Rec[] => arr(x).map(rec)
export const strs = (x: unknown): string[] => arr(x).map(str).filter(s => s.trim() !== '')
/** A finite number, else `fallback`. */
export const num = (x: unknown, fallback = 0): number =>
  typeof x === 'number' && Number.isFinite(x) ? x : fallback
