// Pure layout: turns a PanelState (v2) into pre-wrapped terminal lines, one
// line per terminal row and none wider than the pane body (measured in cells).
// Order: status · task title · why · ask · pinned cards · scenes (pinned
// first) · core lists · unpinned cards. Empty sections are omitted. The footer is separate (see `footer`) so
// the scroller can pin it. No `$`, no JSX.
import type { PanelCard, PanelChoice, PanelLabels, PanelState, PanelStatus } from '../types'
import { calloutBlock, codeBlock, listBlock, tableBlock, textBlock } from './layout-basic'
import { barsBlock, kvBlock, metricsBlock, progressBlock, stepsBlock, tagsBlock } from './layout-data'
import { diffBlock, optionsBlock, quoteBlock, sourcesBlock, timelineBlock, treeBlock } from './layout-rich'
import { sceneLines, orderedScenes } from './layout-scene'
import { ANSWER_KEY_PREFIX, BLANK, BUTTON_CHROME_WIDTH, COLOR, EMPTY_TEXT, GLYPH, MIN_WIDTH, TONE_COLOR } from './layout-types'
import type { BlockRender, Extras, Faces, Line, Seg } from './layout-types'
import { cellWidth, fit, hang, own, plain, rec, str, wrapText } from './layout-text'

export { wrapText } from './layout-text'
export { EMPTY_TEXT, MIN_WIDTH } from './layout-types'
export type { ButtonSeg, Extras, Faces, ImageSeg, Line, LiveFace, Outlines, SceneImage, Seg } from './layout-types'

const ASK_LABEL = 'Claude needs you'
const HEADINGS = { context: 'Context', done: 'Done', next: 'Next' } as const
const LABEL_MAX = 24
const CARD_GUTTER_WIDTH = 2
// A url given less room than this is not worth showing: it would be cut to nothing.
const MIN_URL_ROOM = 8
// Shown instead of a url that does not fit: a cut url cannot be read, the link under it is still whole.
const OPEN_LABEL = 'open in browser ↗'

export const STATUS_COLOR: Record<PanelStatus, string> = {
  working: COLOR.ACCENT,
  waiting: COLOR.WARN,
  blocked: COLOR.DANGER,
  done: COLOR.OK,
}

/** One renderer per block kind. An unknown kind has none: it is skipped. */
const RENDERERS: Readonly<Record<string, BlockRender>> = {
  text: textBlock,
  list: listBlock,
  table: tableBlock,
  code: codeBlock,
  callout: calloutBlock,
  steps: stepsBlock,
  kv: kvBlock,
  metrics: metricsBlock,
  progress: progressBlock,
  diff: diffBlock,
  tree: treeBlock,
  options: optionsBlock,
  timeline: timelineBlock,
  sources: sourcesBlock,
  bars: barsBlock,
  tags: tagsBlock,
  quote: quoteBlock,
}

/** A block as lines; unknown or malformed blocks render as nothing. */
export function blockLines(block: unknown, width: number): Line[] {
  const b = rec(block)
  const render = own(RENDERERS, str(b.kind))
  if (render === undefined) return []
  try {
    return render(b, width)
  } catch {
    return []
  }
}

const heading = (label: string, width: number): Line => [
  { text: fit(label, width), isBold: true, isDim: true },
]

const labelOf = (labels: PanelLabels | undefined, key: keyof typeof HEADINGS): string => {
  const given = str(labels?.[key]).trim()
  return given === '' ? HEADINGS[key] : fit(given, LABEL_MAX)
}

/** One answer button per row inside the ask box: `│ [ label ]`, the label cut so the row fits. */
function choiceLines(choices: readonly PanelChoice[], side: Seg, width: number): Line[] {
  const room = Math.max(1, width - cellWidth(side.text) - BUTTON_CHROME_WIDTH)
  return choices.map((c): Line => {
    const label = fit(str(c.label), room)
    return [side, { text: `[ ${label} ]`, button: { key: `${ANSWER_KEY_PREFIX}${str(c.id)}`, label } }]
  })
}

export function askBox(ask: string, width: number, choices: readonly PanelChoice[], note: string): Line[] {
  const side: Seg = { text: GLYPH.BOX_SIDE, color: COLOR.WARN }
  const inner = Math.max(1, width - cellWidth(side.text))
  return [
    [
      { text: GLYPH.BOX_TOP, color: COLOR.WARN },
      { text: ASK_LABEL, color: COLOR.WARN, isBold: true },
    ],
    ...wrapText(ask, inner).map((l): Line => [side, { text: l }]),
    ...choiceLines(choices, side, width),
    ...(note === '' ? [] : [[side, { text: fit(note, inner), isDim: true }] as Line]),
    [{ text: GLYPH.BOX_BOTTOM, color: COLOR.WARN }],
  ]
}

function numbered(items: readonly string[], width: number): Line[] {
  const digits = String(items.length).length
  return items.flatMap((item, i) => {
    const label = `${String(i + 1).padStart(digits)}. `
    const prefix: Seg =
      i === 0
        ? { text: `${GLYPH.UP_NEXT} ${label}`, color: COLOR.ACCENT }
        : { text: `  ${label}`, isDim: true }
    return hang(prefix, item, width, i === 0 ? {} : { isDim: true })
  })
}

/** A card: bold title, then its blocks one blank line apart; `tone` = coloured gutter. */
function cardLines(card: PanelCard, width: number): Line[] {
  const color = own(TONE_COLOR, str(card.tone))
  const inner = color === undefined ? width : width - CARD_GUTTER_WIDTH
  const body: Line[] = []
  const title = str(card.title).trim()
  if (title !== '') body.push(...plain(title, inner, { isBold: true }))
  const blocks = Array.isArray(card.blocks) ? card.blocks : []
  let isFirstBlock = true
  for (const b of blocks) {
    const lines = blockLines(b, inner)
    if (lines.length === 0) continue
    if (!isFirstBlock) body.push(BLANK)
    isFirstBlock = false
    body.push(...lines)
  }
  if (color === undefined) return body
  const gutter: Seg = { text: `${GLYPH.CARD_SIDE} `, color }
  return body.map((l): Line => [gutter, ...l])
}

export function isEmptyLayout(s: PanelState): boolean {
  return (
    s.task === null &&
    s.ask === null &&
    s.context.length === 0 &&
    s.done.length === 0 &&
    s.next.length === 0 &&
    s.cards.length === 0 &&
    !(Array.isArray(s.scenes) && s.scenes.some(sc => sc.builtin !== true)) // the mod's own scene (the board) is nothing the model put there
  )
}

const join = (sections: Line[][]): Line[] =>
  sections.filter(sec => sec.length > 0).flatMap((sec, i) => (i === 0 ? sec : [BLANK, ...sec]))

const NO_FACES: Faces = new Map()
const NO_EXTRAS: Extras = {}

/**
 * The whole body (no footer) as lines, sections separated by one blank line.
 * `faces` holds the scenes' readable PNGs by scene id (the mod reads them);
 * without one a scene shows its art or alt text. `extras` is what the mod reads
 * besides: the stage scenes' slide outlines and the `sent: <label>` note under the answer buttons.
 */
export function layout(s: PanelState, columns: number, faces: Faces = NO_FACES, extras: Extras = NO_EXTRAS): Line[] {
  const width = Math.max(MIN_WIDTH, columns)
  const header: Line[] = [
    [
      { text: `${GLYPH.DOT} `, color: STATUS_COLOR[s.status] },
      { text: s.status, color: STATUS_COLOR[s.status] },
    ],
  ]
  if (s.task !== null) {
    header.push(...plain(s.task.title, width, { isBold: true }))
    if (str(s.task.why) !== '') header.push(...plain(s.task.why, width, { isDim: true }))
  }
  if (isEmptyLayout(s)) return join([header, [[{ text: EMPTY_TEXT, isDim: true }]]])

  const cards = Array.isArray(s.cards) ? s.cards : []
  const pinned = cards.filter(c => c.pin === true)
  const loose = cards.filter(c => c.pin !== true)
  const scenes = orderedScenes(s.scenes, extras.heroId)
  const list = (key: keyof typeof HEADINGS, lines: Line[]): Line[] =>
    lines.length === 0 ? [] : [heading(labelOf(s.labels, key), width), ...lines]

  return join([
    header,
    s.ask !== null ? askBox(s.ask, width, Array.isArray(s.choices) ? s.choices : [], extras.note ?? '') : [],
    ...pinned.map(c => cardLines(c, width)),
    ...[...scenes.pinned, ...scenes.loose].map(sc => sceneLines(sc, width, faces, extras.outlines, extras.live)),
    list('context', s.context.flatMap(c => hang({ text: `${GLYPH.BULLET} `, isDim: true }, c, width))),
    list(
      'done',
      s.done.flatMap((d, i) =>
        hang({ text: `${GLYPH.DONE} `, color: COLOR.OK }, d, width, i === s.done.length - 1 ? {} : { isDim: true }),
      ),
    ),
    list('next', numbered(s.next, width)),
    ...loose.map(c => cardLines(c, width)),
  ])
}

/**
 * `rev N · url` (dim), with an optional `hint` in front (accent), cut to
 * `width` cells: the url gives way first, then the whole line.
 */
export function footer(s: PanelState, width = Number.POSITIVE_INFINITY, hint = ''): Line {
  const head = `rev ${s.rev}`
  const lead = hint === '' ? '' : hint + GLYPH.SEP
  let rest = head
  let label = ''
  if (s.url !== null) {
    const room = width - cellWidth(lead) - cellWidth(head) - cellWidth(GLYPH.SEP)
    if (room >= MIN_URL_ROOM) {
      label = cellWidth(s.url) <= room ? s.url : fit(OPEN_LABEL, room)
      rest = head + GLYPH.SEP + label
    }
  }
  if (cellWidth(lead + rest) > width) return [{ text: fit(lead + rest, width), isDim: true }]
  const segs: Seg[] = []
  if (lead !== '') segs.push({ text: lead, color: COLOR.ACCENT })
  if (label === '' || s.url === null) return [...segs, { text: rest, isDim: true }]
  return [...segs, { text: head + GLYPH.SEP, isDim: true }, { text: label, color: COLOR.ACCENT, href: s.url }]
}
