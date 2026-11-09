// The VISUAL pane: when the terminal can draw images and the state has a scene to show, the pane is the picture and
// nothing else. Top to bottom: the ask box with its answer buttons while a question is pending · the hero picture, which
// takes every row the others leave · the slide buttons `[ ◀ ] [ ▶ ]` (only when the hero is a deck) and the scene
// switcher (only when the model has a scene of its own besides the board). The pinned footer (rev + link) is added by
// scroll.ts. No header, no outline, no details: the browser page has the whole summary. Otherwise (no images, no scene)
// the old text layout. Pure, no `$`.
import type { PanelScene, PanelState } from '../types'
import { heroOf, switcherScenes } from './hero'
import { askBox, layout } from './layout'
import { AGENT_BACK_HOTKEY, AGENT_BACK_KEY, AGENT_TABS, agentOpenKey, agentTabKey } from './agent-controls'
import type { AgentControls } from './agent-controls'
import { faceLines, pictureLines } from './layout-scene'
import { cellWidth, fit, str } from './layout-text'
import { BUTTON_CHROME_WIDTH, GLYPH, HERO_KEY_PREFIX, LIVE_KEY, LIVE_KEY_PREFIX, LIVE_STEPS, MIN_WIDTH, SCROLL_ACTIONS, SCROLL_CONTROLS, SCROLL_KEY_PREFIX } from './layout-types'
import type { Extras, Faces, ImageSeg, Line, LiveFace, Seg } from './layout-types'
import { CELL_ASPECT, IMAGE_MAX_COLUMNS } from './png'
import type { CellBox, PixelSize } from './png'

export const HERO_MIN_ROWS = 6
export const HERO_MAX_ROWS = 255
/** Rows besides the picture that the pinned footer takes. */
const FOOTER_ROWS = 1
const BUTTON_GAP = ' '
const NO_FACES: Faces = new Map()
const SLIDE_LABEL = { prev: GLYPH.PREV, next: GLYPH.NEXT } as const

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n))

/** The cell box of the hero: full width (`maxColumns`), the picture's aspect, at most `maxRows` (then narrower), rows in [6, 255]. */
export function heroBox(size: PixelSize, maxColumns: number, maxRows: number): CellBox {
  const widest = clamp(Math.floor(maxColumns), 1, IMAGE_MAX_COLUMNS)
  const tallest = clamp(Math.floor(maxRows), HERO_MIN_ROWS, HERO_MAX_ROWS)
  let columns = widest
  let rows = Math.round((columns * size.height) / (size.width * CELL_ASPECT))
  if (rows > tallest) {
    rows = tallest
    columns = Math.round((rows * CELL_ASPECT * size.width) / size.height)
  }
  return { columns: clamp(columns, 1, widest), rows: clamp(rows, HERO_MIN_ROWS, HERO_MAX_ROWS) }
}

/** What the visual pane needs besides the state. */
export type PaneContext = {
  /** The terminal can draw images (the pane has an Image element). */
  canDraw: boolean
  /** Readable pictures by scene id; the hero's is the one used. */
  faces: Faces
  extras: Extras
  /** The scene the person picked as the hero; none or gone: the default. */
  heroId?: string | null
}

type Token = { width: number; seg: Seg }
const button = (key: string, label: string, maxWidth: number, hotkey?: string): Token => {
  const shown = fit(label, Math.max(1, maxWidth - BUTTON_CHROME_WIDTH))
  return { width: cellWidth(shown) + BUTTON_CHROME_WIDTH, seg: { text: `[ ${shown} ]`, button: { key, label: shown, ...(hotkey === undefined ? {} : { hotkey }) } } }
}

/** Buttons packed left to right, wrapping to a new row when the next one would pass `width`. */
function packRows(tokens: readonly Token[], width: number): Line[] {
  const rows: Seg[][] = []
  let used = 0
  for (const t of tokens) {
    const last = rows.at(-1)
    if (last === undefined || used + cellWidth(BUTTON_GAP) + t.width > width) {
      rows.push([t.seg])
      used = t.width
    } else {
      last.push({ text: BUTTON_GAP }, t.seg)
      used += cellWidth(BUTTON_GAP) + t.width
    }
  }
  return rows
}

const MORE_TEXT = (n: number): string => `+${n}`
/** One button per agent (digits 1-6 press them), then, with one open, its tabs and Back; a dim `+N` for agents left out. */
function agentTokens(c: AgentControls, width: number): Token[] {
  const mark = (on: boolean, label: string): string => (on ? `${GLYPH.ACTIVE} ${label}` : label)
  const agents = c.agents.map((a, i) => button(agentOpenKey(a.id), mark(a.id === c.openId, a.label), width, String(i + 1)))
  const more: Token[] = c.more > 0 ? [{ width: cellWidth(MORE_TEXT(c.more)), seg: { text: MORE_TEXT(c.more), isDim: true } }] : []
  if (c.openId === null) return [...agents, ...more]
  const tabs = AGENT_TABS.map(t => button(agentTabKey(t.name), mark(t.name === c.tab, t.label), width, t.hotkey))
  return [...agents, ...more, ...tabs, button(AGENT_BACK_KEY, 'Back', width, AGENT_BACK_HOTKEY)]
}

/** `isDeck`: the hero is a slide deck (its slide buttons); `canScroll`: the live picture is the hero (its scroll buttons, which a deck does not get). */
function controlLines(isDeck: boolean, canScroll: boolean, switcher: readonly PanelScene[], activeId: string, width: number, agents?: AgentControls): Line[] {
  const slides = isDeck ? LIVE_STEPS.map(step => button(`${LIVE_KEY_PREFIX}${step}`, SLIDE_LABEL[step], width)) : []
  const scrolls = canScroll
    ? SCROLL_ACTIONS.map(a => button(`${SCROLL_KEY_PREFIX}${a}`, SCROLL_CONTROLS[a].label, width, SCROLL_CONTROLS[a].hotkey))
    : []
  const scenes = switcher.map(c => button(`${HERO_KEY_PREFIX}${c.id}`, `${c.id === activeId ? `${GLYPH.ACTIVE} ` : ''}${c.id}`, width))
  return [...packRows([...slides, ...scrolls, ...scenes], width), ...(agents === undefined ? [] : packRows(agentTokens(agents, width), width))]
}

/** The live picture's cell box: every column and every row it is given (the page's viewport is made to match, see live.ts). */
export function fillBox(maxColumns: number, maxRows: number): CellBox {
  return {
    columns: clamp(Math.floor(maxColumns), 1, IMAGE_MAX_COLUMNS),
    rows: clamp(Math.floor(maxRows), HERO_MIN_ROWS, HERO_MAX_ROWS),
  }
}

function heroLines(hero: PanelScene, width: number, ctx: PaneContext, maxRows: number): Line[] {
  const alt = str(hero.alt) || hero.id
  const { live } = ctx.extras
  if (live?.sceneId === hero.id) {
    const { columns, rows } = fillBox(width, maxRows)
    return pictureLines({ png: '', columns, rows, alt, key: LIVE_KEY, file: live.file, generation: live.generation })
  }
  // A still picture (a scene's face image) cannot be stretched: it keeps its aspect.
  const picture = ctx.faces.get(hero.id)
  if (picture !== undefined) {
    const { columns, rows } = heroBox({ width: picture.width, height: picture.height }, width, maxRows)
    return pictureLines({ png: picture.png, columns, rows, alt } satisfies ImageSeg)
  }
  // No picture (the live view is starting or off, or the PNG cannot be read): the scene's own art or alt text.
  return faceLines(hero, width, NO_FACES)
}

/**
 * The pane body (no footer): the visual layout, or the old text layout when there is no picture to lead with.
 * `bodyRows` is what the window shows; the hero takes what the other rows leave.
 */
export function paneContent(s: PanelState, columns: number, bodyRows: number, ctx: PaneContext): Line[] {
  const hero = ctx.canDraw ? heroOf(s, ctx.heroId) : undefined
  if (hero === undefined) return layout(s, columns, ctx.faces, ctx.extras)

  const width = Math.max(MIN_WIDTH, columns)
  const live: LiveFace | undefined = ctx.extras.live?.sceneId === hero.id ? ctx.extras.live : undefined
  const above: Line[] = s.ask !== null ? askBox(s.ask, width, Array.isArray(s.choices) ? s.choices : [], ctx.extras.note ?? '') : []
  // The slide buttons belong to a deck (a page with `<section` slides); the board and a dashboard have none.
  const isDeck = live !== undefined && (ctx.extras.outlines?.get(hero.id) ?? []).length > 0
  const below: Line[] = controlLines(isDeck, live !== undefined && !isDeck, switcherScenes(s.scenes), hero.id, width, live === undefined ? undefined : ctx.extras.agents)
  const room = bodyRows - above.length - below.length - FOOTER_ROWS
  return [...above, ...heroLines(hero, width, ctx, room), ...below]
}
