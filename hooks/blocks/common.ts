// Shared validation helpers for the block validators. Pure: no `$`, no I/O.
// A bad type / enum / unknown key throws `Invalid` (the tool then denies with
// the path); an over-cap value is truncated and noted in `trimmed`.

export class Invalid extends Error {}

export type Plain = Record<string, unknown>

/** Caps of the block kinds (spec table) plus the ones the spec leaves open (extra). */
export const BLOCK_CAPS = {
  TEXT_CHARS: 600, // extra: text blocks and callouts
  ITEM_CHARS: 160, // list block items, also the core lists
  LIST_ITEMS: 8, // extra
  CELL_CHARS: 60, // extra: table cells and headers
  TABLE_ROWS: 8,
  TABLE_COLS: 5,
  CODE_LINES: 30,
  CODE_LINE_CHARS: 160, // extra
  LANG_CHARS: 20, // extra
  STEPS_ITEMS: 12,
  STEPS_TEXT_CHARS: 120,
  STEPS_NOTE_CHARS: 80,
  KV_ROWS: 10,
  KV_KEY_CHARS: 30,
  KV_VALUE_CHARS: 120,
  METRICS_ITEMS: 4,
  METRICS_LABEL_CHARS: 30,
  METRICS_VALUE_CHARS: 12,
  METRICS_DELTA_CHARS: 12,
  PROGRESS_LABEL_CHARS: 60,
  PROGRESS_NOTE_CHARS: 80,
  DIFF_LINES: 40,
  DIFF_LINE_CHARS: 160,
  DIFF_FILE_CHARS: 100, // extra
  TREE_ITEMS: 20,
  TREE_PATH_CHARS: 100,
  TREE_NOTE_CHARS: 60,
  OPTIONS_ITEMS: 4,
  OPTIONS_TITLE_CHARS: 60, // extra
  OPTIONS_SUMMARY_CHARS: 140,
  OPTIONS_POINTS: 3, // pros and cons, each
  OPTIONS_POINT_CHARS: 80,
  TIMELINE_ITEMS: 8,
  TIMELINE_TEXT_CHARS: 120,
  TIMELINE_WHEN_CHARS: 20,
  SOURCES_ITEMS: 8,
  SOURCES_TITLE_CHARS: 100,
  SOURCES_URL_CHARS: 200,
  SOURCES_NOTE_CHARS: 80,
  BARS_ITEMS: 8,
  BARS_LABEL_CHARS: 30,
  BARS_UNIT_CHARS: 10,
  TAGS_ITEMS: 10,
  TAGS_CHARS: 30,
  QUOTE_TEXT_CHARS: 300,
  QUOTE_BY_CHARS: 40,
} as const

export const STEP_STATES = ['todo', 'doing', 'done', 'failed', 'skipped'] as const
export const TREE_MARKS = ['added', 'changed', 'removed', 'focus'] as const
export const CALLOUT_TONES = ['info', 'warn', 'ok'] as const
export const DELTA_TONES = ['ok', 'warn', 'danger'] as const // metrics, timeline

export const ELLIPSIS = '…'
const HTTP_URL = /^https?:\/\/\S+$/i

export const isPlain = (v: unknown): v is Plain =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** An optional field is absent when undefined or null (models emit null). */
export const isAbsent = (v: unknown): v is undefined | null => v === undefined || v === null

export function cut(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + ELLIPSIS
}

/** A string field, whitespace-trimmed and cut to `max`; records the cut. */
export function str(v: unknown, path: string, max: number, trimmed: string[]): string {
  if (typeof v !== 'string') throw new Invalid(`${path} must be a string`)
  const whole = v.trim()
  const out = cut(whole, max)
  if (out !== whole) trimmed.push(`${path} to ${max} chars`)
  return out
}

/** Like `str`, but numbers and booleans are written out (table cells, kv, metrics). */
export function cell(v: unknown, path: string, max: number, trimmed: string[]): string {
  return str(typeof v === 'number' || typeof v === 'boolean' ? String(v) : v, path, max, trimmed)
}

/** An optional string field: absent or empty gives undefined. */
export function optStr(
  o: Plain,
  key: string,
  path: string,
  max: number,
  trimmed: string[],
): string | undefined {
  if (isAbsent(o[key])) return undefined
  const out = str(o[key], `${path}.${key}`, max, trimmed)
  return out === '' ? undefined : out
}

export function capList<T>(
  items: T[],
  path: string,
  max: number,
  trimmed: string[],
  keep: 'first' | 'last' = 'first',
): T[] {
  if (items.length <= max) return items
  trimmed.push(`${path} ${items.length} to ${max}`)
  return keep === 'first' ? items.slice(0, max) : items.slice(-max)
}

/** `v` as an object holding only `allowed` keys; an unknown key names its path. */
export function shape(v: unknown, path: string, allowed: readonly string[]): Plain {
  if (!isPlain(v)) throw new Invalid(`${path} must be an object`)
  for (const key of Object.keys(v)) {
    if (!allowed.includes(key))
      throw new Invalid(`${path}.${key} is not a known field (allowed: ${allowed.join(', ')})`)
  }
  return v
}

export function oneOf<T extends string>(v: unknown, path: string, allowed: readonly T[]): T {
  if (typeof v !== 'string' || !allowed.includes(v as T))
    throw new Invalid(`${path} must be one of ${allowed.join(', ')}`)
  return v as T
}

export function optOneOf<T extends string>(
  o: Plain,
  key: string,
  path: string,
  allowed: readonly T[],
): T | undefined {
  return isAbsent(o[key]) ? undefined : oneOf(o[key], `${path}.${key}`, allowed)
}

/** `v` as an array (any element type), else an error saying what was expected. */
export function arr(v: unknown, path: string, what: string): unknown[] {
  if (!Array.isArray(v)) throw new Invalid(`${path} must be an array of ${what}`)
  return v
}

/** An array of objects with only `allowed` keys, mapped by `fn`, then capped. */
export function items<T>(
  v: unknown,
  path: string,
  allowed: readonly string[],
  max: number,
  trimmed: string[],
  fn: (item: Plain, p: string) => T,
): T[] {
  const mapped = arr(v, path, 'objects').map((x, i) => {
    const p = `${path}[${i}]`
    return fn(shape(x, p, allowed), p)
  })
  return capList(mapped, path, max, trimmed)
}

/** An array of strings (empty ones dropped), each cut to `chars`, at most `max`. */
export function strings(
  v: unknown,
  path: string,
  max: number,
  chars: number,
  trimmed: string[],
  keep: 'first' | 'last' = 'first',
): string[] {
  const list = arr(v, path, 'strings')
    .map((x, i) => str(x, `${path}[${i}]`, chars, trimmed))
    .filter(x => x !== '')
  return capList(list, path, max, trimmed, keep)
}

/** A multi-line text (code, diff): indentation kept, trailing blanks dropped, lines and width capped. */
export function textLines(
  v: unknown,
  path: string,
  maxLines: number,
  maxChars: number,
  trimmed: string[],
): string {
  if (typeof v !== 'string') throw new Invalid(`${path} must be a string`)
  const raw = v.replace(/\s+$/, '').split('\n')
  const lines = raw.map(l => cut(l, maxChars))
  if (lines.some((l, i) => l !== raw[i])) trimmed.push(`${path} lines to ${maxChars} chars`)
  return capList(lines, `${path} lines`, maxLines, trimmed).join('\n')
}

/** `v` as a finite number. */
export function num(v: unknown, path: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Invalid(`${path} must be a number`)
  return v
}

/** An http(s) url within `max` chars, else undefined (the item stays, the url goes). */
export function httpUrl(
  o: Plain,
  key: string,
  path: string,
  max: number,
  trimmed: string[],
): string | undefined {
  if (isAbsent(o[key])) return undefined
  const url = str(o[key], `${path}.${key}`, Number.MAX_SAFE_INTEGER, trimmed).trim()
  if (url === '') return undefined
  if (!HTTP_URL.test(url) || url.length > max) {
    trimmed.push(`${path}.${key} dropped (not http/https or over ${max} chars)`)
    return undefined
  }
  return url
}

/** `{ [key]: value }` when there is a value, else `{}`: keeps absent optionals out of the state. */
export function opt<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V }
}
