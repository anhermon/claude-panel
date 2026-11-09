// Terminal renderers for the "data" block kinds: steps, kv, metrics, progress,
// bars, tags. Every one is legible from ~20 cells up: when a column or bar has
// no room it stacks, truncates with `…`, or drops to a simpler form.
import { COLOR, GAP, GLYPH } from './layout-types'
import type { Line, Seg } from './layout-types'
import { arr, cellWidth, fit, hang, num, own, pad, padEnd, padStart, plain, recs, str, wrapText } from './layout-text'
import type { Rec } from './layout-text'

// ---- steps -----------------------------------------------------------------
const STEP_ICON: Record<string, Seg> = {
  todo: { text: `${GLYPH.TODO} `, isDim: true },
  doing: { text: `${GLYPH.DOING} `, color: COLOR.ACCENT },
  done: { text: `${GLYPH.DONE} `, color: COLOR.OK },
  failed: { text: `${GLYPH.FAIL} `, color: COLOR.DANGER },
  skipped: { text: `${GLYPH.SKIP} `, isDim: true },
}
const STEP_ICON_WIDTH = 2

export function stepsBlock(b: Rec, width: number): Line[] {
  const out: Line[] = []
  for (const it of recs(b.items)) {
    const text = str(it.text)
    if (text.trim() === '') continue
    const state = str(it.state)
    const icon = own(STEP_ICON, state) ?? (STEP_ICON.todo as Seg)
    out.push(...hang(icon, text, width, state === 'doing' ? { isBold: true } : state === 'skipped' ? { isDim: true } : {}))
    const note = str(it.note)
    if (note.trim() !== '')
      out.push(...hang({ text: pad(STEP_ICON_WIDTH) }, note, width, { isDim: true }))
  }
  return out
}

// ---- kv --------------------------------------------------------------------
const KV_KEY_SHARE = 0.4
const KV_MIN_VALUE = 10

export function kvBlock(b: Rec, width: number): Line[] {
  const rows = arr(b.rows)
    .map(r => [str(arr(r)[0]), str(arr(r)[1])] as const)
    .filter(([k, v]) => k.trim() !== '' || v.trim() !== '')
  if (rows.length === 0) return []
  const keyW = Math.min(Math.max(...rows.map(([k]) => cellWidth(k))), Math.floor(width * KV_KEY_SHARE))
  const valW = width - keyW - GAP
  if (valW < KV_MIN_VALUE)
    return rows.flatMap(([k, v]) => [
      [{ text: fit(k, width), isDim: true }] as Line,
      ...hang({ text: pad(GAP) }, v, width),
    ])
  return rows.flatMap(([k, v]) =>
    wrapText(v, valW).map((l, i): Line => [
      { text: padEnd(i === 0 ? fit(k, keyW) : '', keyW + GAP), isDim: true },
      { text: l },
    ]),
  )
}

// ---- metrics ---------------------------------------------------------------
const METRIC_VALUE_MAX = 12
const METRIC_DELTA_MAX = 14
const METRIC_MIN_LABEL = 8
const METRIC_PAIR_MIN_WIDTH = 60
const TONE_TEXT_COLOR: Record<string, string> = { ok: COLOR.OK, warn: COLOR.WARN, danger: COLOR.DANGER }

type Tile = { value: string; label: string; delta: string; color: string | undefined }

function tileLine(t: Tile, v: { value: number; label: number; delta: number }, isDeltaInline: boolean): Seg[] {
  const segs: Seg[] = [
    { text: padEnd(fit(t.value, v.value), v.value), isBold: true, ...(t.color ? { color: t.color } : {}) },
    { text: pad(GAP) + padEnd(fit(t.label, v.label), v.label) },
  ]
  if (isDeltaInline && v.delta > 0)
    segs.push({ text: pad(GAP) + fit(t.delta, v.delta), ...(t.color ? { color: t.color } : { isDim: true }) })
  return segs
}

const segsWidth = (segs: readonly Seg[]): number => segs.reduce((a, s) => a + cellWidth(s.text), 0)

export function metricsBlock(b: Rec, width: number): Line[] {
  const tiles: Tile[] = recs(b.items)
    .map(it => ({
      value: str(it.value),
      label: str(it.label),
      delta: str(it.delta),
      color: own(TONE_TEXT_COLOR, str(it.tone)),
    }))
    .filter(t => t.value !== '' || t.label !== '')
  if (tiles.length === 0) return []
  const widest = (f: (t: Tile) => string, cap: number): number =>
    Math.min(cap, Math.max(0, ...tiles.map(t => cellWidth(f(t)))))
  const natural = {
    value: widest(t => t.value, METRIC_VALUE_MAX),
    label: Math.max(0, ...tiles.map(t => cellWidth(t.label))),
    delta: widest(t => t.delta, METRIC_DELTA_MAX),
  }
  const naturalW = natural.value + GAP + natural.label + (natural.delta > 0 ? GAP + natural.delta : 0)

  // Two tiles per row only when the page is wide and every tile fits whole.
  const cellW = Math.floor((width - GAP) / 2)
  const isPaired = width >= METRIC_PAIR_MIN_WIDTH && tiles.length > 1 && naturalW <= cellW
  const room = isPaired ? cellW : width
  const labelRoom = room - natural.value - GAP - (natural.delta > 0 ? GAP + natural.delta : 0)
  const isDeltaInline = natural.delta === 0 || labelRoom >= Math.min(natural.label, METRIC_MIN_LABEL)
  const v = {
    value: natural.value,
    delta: isDeltaInline ? natural.delta : 0,
    label: Math.min(natural.label, isDeltaInline ? labelRoom : room - natural.value - GAP),
  }

  const out: Line[] = []
  const perRow = isPaired ? 2 : 1
  for (let i = 0; i < tiles.length; i += perRow) {
    const cells = tiles.slice(i, i + perRow).map(t => tileLine(t, v, isDeltaInline))
    const row: Seg[] = []
    cells.forEach((c, k) => {
      if (k > 0) row.push({ text: pad(cellW - segsWidth(cells[0] ?? []) + GAP) })
      row.push(...c)
    })
    out.push(row)
    // A delta that has no room on the line goes right under its value.
    if (!isDeltaInline)
      for (const t of tiles.slice(i, i + perRow))
        if (t.delta !== '')
          out.push([{ text: pad(v.value + GAP) + fit(t.delta, room - v.value - GAP), ...(t.color ? { color: t.color } : { isDim: true }) }])
  }
  return out
}

// ---- progress --------------------------------------------------------------
const PROGRESS_LABEL_SHARE = 1 / 3
const PROGRESS_MIN_BAR = 6
const PROGRESS_LABEL_MAX = 60
const PROGRESS_FRAME = 3 // `▕` and `▏` around the cells, one space before the percent

export function progressBlock(b: Rec, width: number): Line[] {
  const raw = num(b.value, Number.NaN)
  if (Number.isNaN(raw)) return []
  const value = Math.min(1, Math.max(0, raw))
  const label = fit(str(b.label).trim(), PROGRESS_LABEL_MAX)
  const pct = `${Math.round(value * 100)}%`
  const labelW = cellWidth(label) + 1
  // The label shares the bar's row only while it is short and the bar keeps room.
  const isInline =
    label !== '' &&
    cellWidth(label) <= Math.floor(width * PROGRESS_LABEL_SHARE) &&
    width - labelW - PROGRESS_FRAME - cellWidth(pct) >= PROGRESS_MIN_BAR
  const out: Line[] = []
  if (label !== '' && !isInline) out.push([{ text: fit(label, width), isBold: true }])
  const barW = Math.max(1, width - (isInline ? labelW : 0) - PROGRESS_FRAME - cellWidth(pct))
  const filled = Math.round(value * barW)
  out.push([
    ...(isInline ? [{ text: label + ' ', isBold: true }] : []),
    { text: GLYPH.BAR_OPEN, isDim: true },
    { text: GLYPH.BAR_FULL.repeat(filled), color: COLOR.ACCENT },
    { text: GLYPH.BAR_EMPTY.repeat(barW - filled), isDim: true },
    { text: GLYPH.BAR_CLOSE, isDim: true },
    { text: ' ' + pct },
  ])
  const note = str(b.note)
  if (note.trim() !== '') out.push(...plain(note, width, { isDim: true }))
  return out
}

// ---- bars ------------------------------------------------------------------
const BARS_LABEL_SHARE = 0.35
const BARS_MIN_BAR = 4
const NUM_DECIMALS = 2

const fmtNum = (n: number): string =>
  Number.isInteger(n) ? String(n) : String(Number(n.toFixed(NUM_DECIMALS)))

export function barsBlock(b: Rec, width: number): Line[] {
  const unit = str(b.unit).trim()
  const items = recs(b.items)
    .map(it => ({ label: str(it.label), value: Math.max(0, num(it.value, Number.NaN)) }))
    .filter(it => it.label.trim() !== '' && !Number.isNaN(it.value))
  if (items.length === 0) return []
  const valueText = (v: number): string => fmtNum(v) + (unit !== '' ? ` ${unit}` : '')
  const maxValue = Math.max(...items.map(i => i.value))
  const valueW = Math.max(...items.map(i => cellWidth(valueText(i.value))))
  const labelW = Math.min(Math.max(...items.map(i => cellWidth(i.label))), Math.floor(width * BARS_LABEL_SHARE))
  const inlineBar = width - labelW - 1 - 1 - valueW
  const isStacked = inlineBar < BARS_MIN_BAR
  const barW = isStacked ? width - 1 - valueW : inlineBar
  const out: Line[] = []
  for (const it of items) {
    const len = it.value > 0 && maxValue > 0 ? Math.max(1, Math.round((it.value / maxValue) * barW)) : 0
    const bar: Seg = { text: GLYPH.BAR_FULL.repeat(len) + pad(barW - len), color: COLOR.ACCENT }
    const value: Seg = { text: ' ' + padStart(valueText(it.value), valueW) }
    if (isStacked) {
      out.push([{ text: fit(it.label, width) }])
      out.push([bar, value])
    } else out.push([{ text: padEnd(fit(it.label, labelW), labelW) + ' ' }, bar, value])
  }
  return out
}

// ---- tags ------------------------------------------------------------------
export function tagsBlock(b: Rec, width: number): Line[] {
  const tags = arr(b.items)
    .map(str)
    .filter(t => t.trim() !== '')
    .map(t => `[${fit(t, width - 2)}]`)
  const out: Line[] = []
  let row: Seg[] = []
  let rowW = 0
  for (const t of tags) {
    const w = cellWidth(t)
    if (row.length > 0 && rowW + 1 + w > width) {
      out.push(row)
      row = []
      rowW = 0
    }
    row.push({ text: (row.length > 0 ? ' ' : '') + t, color: COLOR.INFO })
    rowW += (row.length > 1 ? 1 : 0) + w
  }
  if (row.length > 0) out.push(row)
  return out
}
