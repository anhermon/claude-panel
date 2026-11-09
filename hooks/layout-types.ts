// Shared vocabulary of the terminal layout: the line/segment shapes, the
// glyphs, the theme colour keys and the width constants. Pure data, no `$`.
import type { PanelTone } from '../types'
import type { AgentControls } from './agent-controls'

/**
 * A picture drawn by the engine's Image element. It stands on the FIRST of the
 * `rows` lines it covers; the other rows-1 lines are blank placeholders the pane
 * skips, so the layout still counts one line per terminal row.
 */
export type ImageSeg = {
  png: string
  columns: number
  rows: number
  alt: string
  /** The live view of a stage scene: a keyed Image (`key`) whose picture is the PNG file `file` (read by the terminal; `generation` says when its content changed), and `png` is unused. */
  key?: string
  file?: string
  generation?: number
}

/** A pressable button: `key` is its address (`answer:<choice id>` or `live:<prev|next>`), `label` what it shows. */
/** `hotkey`: one lowercase letter or digit that presses it while the pane holds the keyboard (the scroll buttons: j k u d g b). */
export type ButtonSeg = { key: string; label: string; hotkey?: string }

export type Seg = {
  text: string
  color?: string
  isDim?: boolean
  isBold?: boolean
  isItalic?: boolean
  image?: ImageSeg
  /** Drawn as a `Button` by the pane; `text` is its plain-text look (`[ label ]`) for the print script and the width maths. */
  button?: ButtonSeg
  /** Drawn as a `Link` by the pane (OSC 8 hyperlink): `text` is what shows, `href` the FULL target even when `text` is cut. */
  href?: string
}
export type Line = readonly Seg[]
export type Style = Omit<Seg, 'text'>
/** A scene's terminal picture: the PNG as base64 and its pixel size. */
export type SceneImage = { png: string; width: number; height: number }
/** The readable pictures by scene id; a scene without one shows its art or alt. */
export type Faces = ReadonlyMap<string, SceneImage>

/** Slide titles of a stage scene's entry page, by scene id; a scene without one shows no outline. */
export type Outlines = ReadonlyMap<string, readonly string[]>
/** The live frame of a stage scene (hooks/live.ts): the scene it shows, the PNG file and its pixel size. */
export type LiveFace = { sceneId: string; file: string; generation: number; width: number; height: number }
/** What the layout draws that the state does not hold: the stage outlines, a one-line note under the answer buttons and the live frame. */
export type Extras = {
  outlines?: Outlines
  note?: string
  live?: LiveFace
  heroId?: string
  /** The Agents tile's buttons (hooks/agent-controls.ts), drawn under the live picture. */
  agents?: AgentControls
}

/** A block renderer: pre-wrapped lines no wider than `width` terminal cells. */
export type BlockRender = (block: Record<string, unknown>, width: number) => Line[]

export const MIN_WIDTH = 12
export const MIN_COL_WIDTH = 3
export const COLUMN_GAP = 2
export const GAP = 2
export const EMPTY_TEXT = 'Waiting for Claude…'

export const GLYPH = {
  DOT: '●',
  BULLET: '•',
  DONE: '✓',
  FAIL: '✗',
  UP_NEXT: '→',
  RULE: '─',
  BOX_TOP: '╭─ ',
  BOX_SIDE: '│ ',
  BOX_BOTTOM: '╰─',
  CODE_SIDE: '▏',
  QUOTE_SIDE: '▎',
  CARD_SIDE: '┃',
  ELLIPSIS: '…',
  STAR: '★',
  TL_DOT: '●',
  TL_LINE: '│',
  BAR_FULL: '█',
  BAR_EMPTY: '░',
  BAR_OPEN: '▕',
  BAR_CLOSE: '▏',
  SKIP: '–',
  TODO: '○',
  DOING: '◐',
  UP: '↑',
  DOWN: '↓',
  SEP: ' · ',
  SCENE: '▣',
  OPEN: '↗',
  STAGE: 'stage',
  PREV: '◀',
  NEXT: '▶',
  ACTIVE: '▸',
} as const

/** The key prefix of an answer button: `answer:<choice id>`. */
export const ANSWER_KEY_PREFIX = 'answer:'
/** The live view's Image key, and the key prefix of its slide buttons: `live:prev`, `live:next`. */
export const LIVE_KEY = 'live'
export const LIVE_KEY_PREFIX = 'live:'
export const LIVE_STEPS = ['prev', 'next'] as const
export type LiveStep = (typeof LIVE_STEPS)[number]
/**
 * The scroll buttons of the live picture (the hero tile scrolls, see live.ts): key prefix `scroll:<action>`, each with the glyph it
 * shows and its hotkey (a Button hotkey is one lowercase letter or digit, so `G` and `g` cannot differ: top is g, bottom is b).
 */
export const SCROLL_KEY_PREFIX = 'scroll:'
export const SCROLL_ACTIONS = ['up', 'down', 'pageup', 'pagedown', 'top', 'bottom'] as const
export type ScrollAction = (typeof SCROLL_ACTIONS)[number]
export const SCROLL_CONTROLS: Readonly<Record<ScrollAction, { label: string; hotkey: string }>> = {
  up: { label: '▲', hotkey: 'k' },
  down: { label: '▼', hotkey: 'j' },
  pageup: { label: '⇞', hotkey: 'u' },
  pagedown: { label: '⇟', hotkey: 'd' },
  top: { label: '⤒', hotkey: 'g' },
  bottom: { label: '⤓', hotkey: 'b' },
}
/** The footer's key hint while the scroll buttons are drawn: one short line. */
export const SCROLL_KEYS_HINT = 'j/k scroll · u/d page · g/b ends'
/** The visual pane's buttons: `hero:<scene id>` makes that scene the hero picture. */
export const HERO_KEY_PREFIX = 'hero:'
/** `[ label ]` is the label plus these cells; the side of the ask box takes 2 more. */
export const BUTTON_CHROME_WIDTH = 4

/** The slash command a scene's terminal face points to. */
export const OPEN_COMMAND = '/panel open'

// Theme keys of the terminal surface; the person's theme decides the actual hue.
export const COLOR = {
  ACCENT: 'claude',
  WARN: 'warning',
  OK: 'success',
  DANGER: 'error',
  INFO: 'suggestion',
} as const

export const TONE_COLOR: Record<PanelTone, string> = {
  info: COLOR.INFO,
  warn: COLOR.WARN,
  ok: COLOR.OK,
  danger: COLOR.DANGER,
}
export const TONE_GLYPH: Record<PanelTone, string> = { info: 'ℹ', warn: '⚠', ok: '✓', danger: '✗' }

export const BLANK: Line = [{ text: ' ' }]
