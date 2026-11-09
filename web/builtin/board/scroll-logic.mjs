// scroll-logic.mjs - the board's SCROLL mode, pure (no DOM). The fit-to-screen planner (grid-plan.mjs) keeps its job; when
// it would have to hide frames ("+N more") the board switches to this mode instead: every frame is laid out at the height
// its size hint asks for and the board scrolls. Also the scroll bookkeeping: where to stay after a re-layout, which frame
// the viewer has reached ("3/8") and whether there is more below.
import { DEFAULT_SIZE, LIST_TYPES, NARROW_MAX_PX, SHAPES, floorPx, isSize, itemRowsPx, listBodyPx, minSizeFor, narrowNeedPx, shapeOf } from './grid-plan.mjs';

export const MODE_FIT = 'fit';
export const MODE_SCROLL = 'scroll';
/** The most frames the board mounts: scroll mode shows them all (the data file allows far fewer than this in practice). */
export const SCROLL_MAX_FRAMES = 24;
/** The scroll grid's columns follow the board's WIDTH (not its aspect): one per this many px, an EVEN count (so m and l are exactly half the board and pair up with no gap), between the two bounds. */
export const SCROLL_COL_MIN_PX = 340;
export const SCROLL_COLS_MIN = 2;
export const SCROLL_COLS_MAX = 6;
/** Rows a size spans in the scroll grid; an `xl` strip is one row on 4+ columns, a tower (this many rows) on 2. */
const SCROLL_ROWS = Object.freeze({ s: 1, m: 1, l: 2, xl: 1 });
const SCROLL_XL_TOWER_ROWS = 3;
const SCROLL_WIDE_COLS = 4;

/** Columns of the scroll grid on a board `width` px wide (narrow boards are one column, see planScroll). */
export const scrollCols = (width) => {
  const n = Math.floor(width / SCROLL_COL_MIN_PX);
  return clamp(n - (n % 2), SCROLL_COLS_MIN, SCROLL_COLS_MAX);
};

/** [w, h] grid spans of a size on `cols` columns: s one column, m and l half the board (l two rows tall), xl the full width. */
export function scrollSpan(size, cols) {
  const half = Math.max(1, cols / 2);
  const w = { s: 1, m: half, l: half, xl: cols }[size];
  return [w, size === 'xl' && cols < SCROLL_WIDE_COLS ? SCROLL_XL_TOWER_ROWS : SCROLL_ROWS[size]];
}

/** A row of the scroll grid is as tall as a cell is wide divided by this, kept between the two px bounds. */
const CELL_ASPECT = 1.6;
const ROW_MIN_PX = 140;
const ROW_MAX_PX = 320;
/** On a narrow board each frame is one column; a size hint beyond `m` asks for at least this many px of height. */
export const NARROW_HINT_PX = Object.freeze({ s: 0, m: 150, l: 240, xl: 340 });
/** A text or now headline wraps at about this many characters per line on a narrow board, each extra line costing this many px. */
const HEADLINE_CHARS_PER_LINE = 22;
const HEADLINE_LINE_PX = 34;
/** A list frame (agent rows, doing, swimlane) on a wide board gets as many grid rows as its roomy wording needs: the frame's chrome (heading, padding) in px. */
const LIST_CHROME_PX = 46;
const HEADLINE_TYPES = new Set(['text', 'now']);
/** Closer to the bottom than this counts as "at the end": the fade goes away. */
export const END_SLACK_PX = 4;

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const SIZE_ORDER = Object.freeze(['s', 'm', 'l', 'xl']);
const atLeast = (size, min) => (SIZE_ORDER.indexOf(size) >= SIZE_ORDER.indexOf(min) ? size : min);

const wrappedHeadlinePx = (f) => (HEADLINE_TYPES.has(f.type) ? Math.max(0, Math.ceil(String(f.text ?? '').length / HEADLINE_CHARS_PER_LINE) - 1) * HEADLINE_LINE_PX : 0);

/** Scroll when the fit plan had to leave frames out, else fit. (Frames that merely shrink to the text floor still fit.) */
export const chooseMode = (fitPlan) => (fitPlan.hidden > 0 ? MODE_SCROLL : MODE_FIT);

/** The px height of one grid row of the scroll grid for a board `width` wide and `cols` columns. */
export const scrollRowPx = (width, cols) => clamp(Math.round(width / Math.max(1, cols) / CELL_ASPECT), ROW_MIN_PX, ROW_MAX_PX);

/**
 * Frames (normalised) -> { mode, cols, narrow, shape, rowPx, cells: [{ id, w, h, px, size }] } in the frames' order. `w`/`h` are
 * grid spans (the shape's size table, never narrower than the frame's minimum); on a narrow board (one column) `px` is the
 * height the frame needs so none of its text is clipped, raised to the size hint's height. Nothing is hidden.
 */
export function planScroll(frames, { width = 0, aspect = 1, height = 0 } = {}) {
  const narrow = width > 0 && width <= NARROW_MAX_PX;
  const shape = narrow ? 'portrait' : shapeOf(aspect);
  const cols = narrow ? 1 : scrollCols(width);
  const rowPx = scrollRowPx(width, cols);
  const floor = floorPx(width, height);
  const cells = frames.slice(0, SCROLL_MAX_FRAMES).map((f) => {
    const size = atLeast(isSize(f.size) ? f.size : DEFAULT_SIZE, minSizeFor(f, shape));
    const [w, h] = scrollSpan(size, cols);
    const bodyPx = LIST_TYPES.has(f.type) ? listBodyPx(f, { floor }) : itemRowsPx(f, floor); // the rows' wording never gets squeezed in the scroll
    const listRows = bodyPx > 0 ? Math.ceil((LIST_CHROME_PX + bodyPx) / rowPx) : 0;
    return narrow
      ? { id: f.id, w: 1, h: 1, size, px: Math.max(narrowNeedPx(f), NARROW_HINT_PX[size]) + wrappedHeadlinePx(f) }
      : { id: f.id, w: Math.min(w, cols), h: Math.max(h, listRows), size, px: 0 };
  });
  return { mode: MODE_SCROLL, cols, narrow, shape, rowPx, cells, hidden: 0 };
}

/** Where the scroller stays after a re-layout: the same offset, clamped to the new end. (At the top it stays at the top.) */
export const nextScrollTop = ({ prev, max }) => clamp(Number.isFinite(prev) ? prev : 0, 0, Math.max(0, max));

/** The most the scroller can move: content height less the view, never negative. */
export const maxScrollTop = ({ scrollHeight, clientHeight }) => Math.max(0, scrollHeight - clientHeight);

/** How many frames the viewer has seen whole: those whose bottom edge is inside the view (at least 1). `bottoms` are offsets in the scroller. */
export const reachedCount = ({ bottoms, scrollTop, viewHeight }) => Math.max(1, bottoms.filter((b) => b <= scrollTop + viewHeight + END_SLACK_PX).length);

/** "3/8" for the position cue; empty when nothing scrolls. */
export const positionLabel = ({ reached, total, max }) => (max > END_SLACK_PX && total > 0 ? `${Math.min(reached, total)}/${total}` : '');

/** Is there more below the view? (drives the bottom fade) */
export const hasMoreBelow = ({ scrollTop, max }) => max - scrollTop > END_SLACK_PX;
