// Windowing for the pane: the engine scrolls a taller-than-body tree itself
// (wheel, and arrows/page keys while the pane is focused), so we always return
// the whole tree. The only trick is a PINNED footer row: one row, carrying the
// scroll hint and `rev N · url`, is inserted INTO the tree at the bottom of the
// window the engine is about to show, so the footer stays visible while the
// content moves under it. The engine re-asks the render hook after a person's
// scroll (documented for `ui.scroll`), which is what keeps the row in place.
// Pure: no `$`, no JSX, so the print script and the tests run this exact code.
import type { PanelState } from '../types'
import { footer } from './layout'
import type { Line } from './layout'
import { GLYPH } from './layout-types'
import { IMAGE_MAX_ROWS } from './png'

const MIN_ROWS = 3

/** Rows a line's picture covers (0 for an ordinary line or a placeholder under a picture). */
export const imageRows = (line: Line | undefined): number =>
  line?.find(seg => seg.image !== undefined)?.image?.rows ?? 0

/**
 * Where the pinned footer may go if it was meant for row `at`: never inside a
 * picture (the engine draws the picture as one element, so the footer would
 * land under it, out of the window). Inside one it moves up in front of it.
 */
function beforePicture(content: readonly Line[], at: number): number {
  for (let i = at - 1; i >= Math.max(0, at - IMAGE_MAX_ROWS); i--) {
    const rows = imageRows(content[i])
    if (rows > 0) return i + rows > at ? i : at
  }
  return at
}

export type Windowed = {
  /** The tree to draw: content with the footer row at the window's bottom. */
  tree: Line[]
  /** Content rows above and below the rows the window shows. */
  above: number
  below: number
  isOverflowing: boolean
}

/** `↓ 34 more` / `↑ 12 · ↓ 34 more` / `↑ 12 above`; empty when nothing is hidden. */
export function scrollHint(above: number, below: number): string {
  if (above === 0 && below === 0) return ''
  if (above === 0) return `${GLYPH.DOWN} ${below} more`
  if (below === 0) return `${GLYPH.UP} ${above} above`
  return `${GLYPH.UP} ${above} · ${GLYPH.DOWN} ${below} more`
}

/**
 * @param content the layout lines (no footer)
 * @param offset the first tree row the engine's window shows (`scroll.offset`)
 * @param rows the rows the window shows (`scroll.bodyRows`)
 */
export function windowTree(
  content: readonly Line[],
  s: PanelState,
  columns: number,
  offset: number,
  rows: number,
  keysHint = '',
): Windowed {
  const body = Math.max(MIN_ROWS, Math.floor(rows))
  if (content.length + 1 <= body)
    return { tree: [...content, footer(s, columns, keysHint)], above: 0, below: 0, isOverflowing: false }

  // One pinned row: the tree is the content plus that row, and the engine
  // clamps the offset to it, so we clamp the same way.
  const treeRows = content.length + 1
  const at = Math.min(Math.max(0, Math.floor(offset)), treeRows - body)
  const meant = at + body - 1
  const slot = beforePicture(content, meant)
  // A picture taller than the window leaves no room before it: keep the slot.
  const place = slot >= at ? slot : meant
  const above = at
  const below = content.length - place
  const row = footer(s, columns, [scrollHint(above, below), keysHint].filter(h => h !== '').join(GLYPH.SEP))
  return {
    tree: [...content.slice(0, place), row, ...content.slice(place)],
    above,
    below,
    isOverflowing: true,
  }
}
