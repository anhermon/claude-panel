// grid-plan.mjs - where each frame goes, as a function of the board's SHAPE (its window aspect). Pure, no DOM.
// Three shapes: portrait (a tall narrow pane: 1-2 columns, frames stack), square-ish (3 columns), landscape (4x3).
// planGrid tries every grid the shape allows, packs the frames first-fit, lets them grow into holes, and keeps the grid
// whose frames come out closest to a comfortable aspect with no empty cells and nothing hidden. A frame is never given
// less room than its content needs (minSizeFor); one that cannot fit even at that is hidden and counted.
import { layerGraph, normalizeDiagram } from './diagram-layout.mjs';
import { INSIGHT_TYPES, insightBodyPx, isInsightType } from './insight-frames-logic.mjs';

export const DEFAULT_SIZE = 'm';
export const PORTRAIT_BELOW = 0.8;
export const SQUARE_UP_TO = 1.3;
export const LANDSCAPE_ASPECT = 16 / 9;

/** Size -> [cols, rows] of grid cells, per shape. `xl` is the hero: a full-width strip, or in portrait a full-width tower. */
export const SHAPES = Object.freeze({
  portrait: { cols: [1, 2], rowsMax: 6, max: 10, sizes: { s: [1, 1], m: [2, 1], l: [2, 2], xl: [2, 3] } },
  square: { cols: [3], rowsMax: 4, max: 8, sizes: { s: [1, 1], m: [2, 1], l: [2, 2], xl: [3, 1] } },
  landscape: { cols: [4], rowsMax: 3, max: 8, sizes: { s: [1, 1], m: [2, 1], l: [2, 2], xl: [4, 1] } },
});
export const GRID_COLS = SHAPES.landscape.cols[0];
export const GRID_ROWS_MAX = SHAPES.landscape.rowsMax;
export const SIZE_CELLS = SHAPES.landscape.sizes;
export const MAX_FRAMES = SHAPES.landscape.max;
/** The most frames the board ever mounts (the biggest shape cap); the planner cuts to the current shape's cap. */
export const MAX_MOUNTED = Math.max(...Object.values(SHAPES).map((s) => s.max));

export const shapeOf = (aspect) => (aspect < PORTRAIT_BELOW ? 'portrait' : aspect <= SQUARE_UP_TO ? 'square' : 'landscape');
export const isSize = (v) => Object.hasOwn(SHAPES.landscape.sizes, v);

const SIZE_RANK = Object.freeze({ s: 0, m: 1, l: 2, xl: 3 });
const SIZES_DOWN = Object.freeze(['xl', 'l', 'm', 's']);
/** Frames grow toward this width:height (measured on screen, not in cells). */
const IDEAL_ASPECT = 1.5;
const HIDDEN_PENALTY = 100;
const HOLE_PENALTY = 10;

const ASK_SMALL_Q = 20;
const DIAGRAM_SMALL_NODES = 3;
const DIAGRAM_WIDE_LAYERS = 4;
const DIAGRAM_TALL_LAYERS = 7;
const TIMELINE_SHORT = 3;
const DOING_SMALL_ROWS = 3;
const DOING_LANDSCAPE_ROWS = 6;
const SWIMLANE_SMALL_LANES = 2;
const SWIMLANE_MID_LANES = 4;
const KINDSTACK_SMALL_ROWS = 2;
const HINTS_SMALL_ITEMS = 2;
const TICKETS_SMALL_ROWS = 3;
const CHECKS_SMALL_ROWS = 3;
const len = (v) => (Array.isArray(v) ? v.length : 0);
const textLen = (v) => String(v ?? '').length;

function diagramMinSize(frame, shape) {
  const spec = normalizeDiagram(frame);
  const layers = spec.nodes.length ? layerGraph(spec.nodes, spec.edges).columns.length : 0;
  if (shape === 'portrait') { // laid out top to bottom: it needs height, not a full-width strip
    if (layers >= DIAGRAM_TALL_LAYERS) return 'xl';
    const labelled = spec.edges.some((e) => e.label); // chips sit across the short edges, which then need the height
    return layers >= 3 || spec.nodes.length > DIAGRAM_SMALL_NODES || labelled ? 'l' : 'm';
  }
  if (layers >= DIAGRAM_WIDE_LAYERS) return 'xl'; // a left-to-right flow of 4+ layers is wide and short
  return spec.nodes.length <= DIAGRAM_SMALL_NODES ? 'm' : 'l';
}

/** The smallest size a frame stays legible at (the text floor) given what it holds and the board's shape. */
export function minSizeFor(frame, shape = 'landscape') {
  switch (frame.type) {
    case 'avatar': return textLen(frame.say) <= 28 ? 's' : 'm';
    case 'now': return textLen(frame.text) <= 18 ? 's' : 'm';
    case 'metric': case 'image': case 'html': case 'pulse': return 's';
    case 'text': return textLen(frame.text) <= 36 ? 's' : 'm';
    case 'steps': return len(frame.items) <= 3 ? 's' : len(frame.items) <= 4 || shape !== 'landscape' ? 'm' : 'l'; // landscape rows are short: 5+ items at the text floor need 2 rows
    case 'ask': return len(frame.options) <= 2 && textLen(frame.q) <= ASK_SMALL_Q ? 's' : 'm';
    case 'lanes': // a card per agent (tighter wording when the cell is short); landscape cells are short, so 3 agents need 2 rows there
      return len(frame.lanes) <= 2 ? 's' : len(frame.lanes) <= 3 && shape !== 'landscape' ? 'm' : 'l';
    case 'doing': // one line per agent; a wide cell lists them in two columns, so 4+ agents want 2 cells wide unless the board is landscape
      return len(frame.lanes) <= DOING_SMALL_ROWS || (shape === 'landscape' && len(frame.lanes) <= DOING_LANDSCAPE_ROWS) ? 's' : 'm';
    case 'swimlane': return len(frame.items) <= SWIMLANE_SMALL_LANES ? 's' : len(frame.items) <= SWIMLANE_MID_LANES && shape === 'landscape' ? 'm' : 'l';
    case 'kindstack': return len(frame.items) <= KINDSTACK_SMALL_ROWS ? 'm' : 'l'; // a bar, its words and a key per agent: wide, and tall with many agents
    case 'hints': return len(frame.items) <= HINTS_SMALL_ITEMS ? 'm' : 'l';
    case 'tickets': return len(frame.items) <= TICKETS_SMALL_ROWS ? 'm' : 'l'; // a row per ticket: stage, role, check meter
    case 'checks': return len(frame.items) <= CHECKS_SMALL_ROWS ? 'm' : 'l'; // a mark and an evidence line per check
    case 'viz': return 'l'; // a visual asset needs room for its labels (frames/viz.js); the asset fills the cell it is given
    case 'sinks': case 'repeats': return 'l'; // ranked rows / a matrix with sentences under them
    case 'rings': return len(frame.items) <= 2 ? 's' : 'm';
    case 'bars': return len(frame.items) <= 4 ? 's' : len(frame.items) <= 6 ? 'm' : 'l';
    case 'diagram': return diagramMinSize(frame, shape);
    case 'timeline': return len(frame.items) <= TIMELINE_SHORT ? 'm' : shape === 'portrait' ? 'l' : 'xl';
    case 'compare': return 'm';
    case 'line': return 'm';
    default: return 's';
  }
}

// ---- a narrow board (a half-width tile, ~360 px): one column, rows sized by what each frame needs, lanes first ----------------
export const NARROW_MAX_PX = 420;
const NARROW_GAP_PX = 10; // board gap + frame chrome per frame, estimated (inset is added once)
const NARROW_CHROME_PX = 46; // frame padding + heading line
const NARROW_TITLE_EXTRA_PX = 17; // a heading that wraps onto a second line
const NARROW_TITLE_CHARS = 24; // longer headings wrap (uppercase, letter-spaced)
const NARROW_INSET_PX = 20;
const NARROW_MORE_PX = 30; // the "+N more" chip's strip, reserved only when something is dropped
const LANE_ROW_PX = 110; // one agent row without an insight, at the roomy wording (2-line title, 2-line step, bar + numbers)
// Rows that say what the agent does (insight) are measured in em of the text floor (the floor is ~14 px on a narrow board):
// roomy = title + pill, headline, step, strip + figures, mix, files, feed; compact = title + pill, headline, strip + figures, mix as an edge.
const LANE_INSIGHT_ROOMY_EM = 7.4;
const LANE_INSIGHT_COMPACT_EM = 4.4;
const DOING_ROOMY_EM = 2.7; // a row of the `doing` frame: name + kind, the files under the name
const DOING_COMPACT_EM = 1.45; // name + kind on one line
const SWIMLANE_ROOMY_EM = 2.6; // a lane of the `swimlane` frame: name + duration, the track under it
const SWIMLANE_COMPACT_EM = 1.5; // all on one line
const LEGEND_EM = 1.6; // the one-line legend under doing / swimlane
const DOING_ROWS_MAX = 8;
const LIST_GAP_EM = 0.3;
export const TEXT_FLOOR_MIN_PX = 14; // --fs-min of board.css
const FLOOR_PER_VU = 1.46; // --fs = max(--fs-min, 1.46 vu)
const VU_PER_VH = 1.7778; // --vu = min(1vw, 1.7778vh)
const ITEM_ROW_PX = 28; // one list row (step, bar, timeline item)
const NARROW_BODY_PX = Object.freeze({ now: 80, diagram: 150, rings: 110, text: 60, metric: 80, avatar: 90, ask: 90, compare: 140, line: 110, image: 120, html: 120, pulse: 60, viz: 240 });
const NARROW_ROW_TYPES = new Set(['steps', 'bars', 'timeline']);
const NARROW_PRIORITY = Object.freeze({ lanes: 0, now: 1, ask: 1, doing: 1, steps: 2, text: 2, metric: 2, avatar: 3, diagram: 3, timeline: 3, kindstack: 3, compare: 4, rings: 4, line: 4, swimlane: 4, hints: 4, tickets: 2, checks: 3, bars: 5, sinks: 5, repeats: 5, viz: 5 });
const NARROW_PRIORITY_LAST = 6;

/** The body-text floor (--fs) in px on a board of this size, as board.css computes it. */
export const floorPx = (width = 0, height = 0) => Math.max(TEXT_FLOOR_MIN_PX, FLOOR_PER_VU * Math.min(width / 100, (VU_PER_VH * height) / 100));

/** The frames that are a list of rows whose wording gets tighter when short (frames/lanes.js, doing.js, swimlane.js, and the four insight frames). */
export const LIST_TYPES = new Set(['lanes', 'doing', 'swimlane', ...INSIGHT_TYPES]);
const rowCount = (frame) => (frame.type === 'swimlane' ? len(frame.items) : frame.type === 'doing' ? Math.min(DOING_ROWS_MAX, len(frame.lanes)) : len(frame.lanes));

/** The px height of the body of a list frame: `compact` is the tightest wording, else the roomy one; `floor` is the text floor in px. */
export function listBodyPx(frame, { compact = false, floor = TEXT_FLOOR_MIN_PX } = {}) {
  if (isInsightType(frame.type)) return insightBodyPx(frame, { compact, floor });
  const rows = Math.max(1, rowCount(frame));
  if (frame.type === 'lanes') {
    const insightRows = (Array.isArray(frame.lanes) ? frame.lanes : []).filter((l) => l?.insight).length;
    const plain = Math.max(0, rows - insightRows);
    return Math.round(plain * (compact ? LANE_ROW_PX / 2 : LANE_ROW_PX) + insightRows * (compact ? LANE_INSIGHT_COMPACT_EM : LANE_INSIGHT_ROOMY_EM) * floor + LIST_GAP_EM * floor * (rows - 1));
  }
  const [roomy, tight] = frame.type === 'doing' ? [DOING_ROOMY_EM, DOING_COMPACT_EM] : [SWIMLANE_ROOMY_EM, SWIMLANE_COMPACT_EM];
  return Math.round((rows * (compact ? tight : roomy) + LEGEND_EM + LIST_GAP_EM * rows) * floor);
}

/** Px height of the item rows of a steps / bars / timeline frame at a text floor (0 for any other type): they grow with the text size. */
export const itemRowsPx = (frame, floor = TEXT_FLOOR_MIN_PX) => (NARROW_ROW_TYPES.has(frame.type) ? Math.max(1, len(frame.items)) * ITEM_ROW_PX * (floor / TEXT_FLOOR_MIN_PX) : 0);

/** Estimated px height a frame needs on a narrow board so none of its text is clipped. */
export function narrowNeedPx(frame) {
  const title = textLen(frame.title) > NARROW_TITLE_CHARS ? NARROW_TITLE_EXTRA_PX : 0;
  const body = LIST_TYPES.has(frame.type) ? listBodyPx(frame)
    : NARROW_ROW_TYPES.has(frame.type) ? Math.max(1, len(frame.items)) * ITEM_ROW_PX
    : NARROW_BODY_PX[frame.type] ?? NARROW_BODY_PX.text;
  return NARROW_CHROME_PX + title + body;
}

/**
 * One column. Frames are admitted by priority (agents first) while their estimated heights fit the board; the rest are
 * dropped (counted in `hidden`, drawn as "+N more"). Kept frames stay in their order and `weights` gives each row's share
 * (its need), so every row gets at least what it needs and the spare height is shared in proportion.
 */
function planNarrow(frames, { width, height, extraHidden }) {
  const items = frames.slice(0, SHAPES.portrait.max).map((f, i) => ({ id: f.id, i, need: narrowNeedPx(f) + NARROW_GAP_PX, prio: NARROW_PRIORITY[f.type] ?? NARROW_PRIORITY_LAST }));
  const room = height - NARROW_INSET_PX;
  const admit = (budget) => {
    const kept = new Set();
    let used = 0;
    for (const it of [...items].sort((a, b) => a.prio - b.prio || a.i - b.i)) {
      if (used + it.need > budget && kept.size > 0) continue; // the top-priority frame is always shown
      used += it.need;
      kept.add(it.i);
    }
    return items.filter((it) => kept.has(it.i));
  };
  let shown = admit(room);
  if (shown.length < items.length) shown = admit(room - NARROW_MORE_PX);
  return {
    cols: 1, rows: Math.max(1, shown.length), shape: 'portrait', narrow: true, width,
    hidden: extraHidden + Math.max(0, frames.length - SHAPES.portrait.max) + items.length - shown.length,
    weights: shown.map((it) => it.need),
    cells: shown.map((it, row) => ({ id: it.id, col: 0, row, w: 1, h: 1, size: 'm' })),
  };
}

const atLeast = (size, min) => (SIZE_RANK[size] >= SIZE_RANK[min] ? size : min);
/** The next smaller size that still meets the frame's minimum AND takes fewer cells on this grid, or null. */
function smaller(s, dims) {
  const cells = (size) => dims(size)[0] * dims(size)[1];
  return SIZES_DOWN.find((size) => SIZE_RANK[size] < SIZE_RANK[s.size] && SIZE_RANK[size] >= SIZE_RANK[s.min] && cells(size) < cells(s.size)) ?? null;
}

/** The cells a size takes on a grid that is `cols` wide (never wider than the grid). */
const dimsOf = (sizes, cols) => (size) => { const [w, h] = sizes[size]; return [Math.min(w, cols), h]; };

/**
 * Frames (already normalised) -> { cols, rows, cells: [{ id, col, row, w, h, size }], hidden, shape } (0-based col/row).
 * `aspect` is the board's width:height. Frames beyond the shape's cap, and frames that cannot fit even at their smallest
 * size, are left out and counted in `hidden` (plus `extraHidden`, frames the caller already cut).
 */
export function planGrid(frames, { aspect = LANDSCAPE_ASPECT, extraHidden = 0, width = 0, height = 0 } = {}) {
  if (width > 0 && width <= NARROW_MAX_PX && height > 0) return planNarrow(frames, { width, height, extraHidden });
  const shape = shapeOf(aspect);
  const def = SHAPES[shape];
  const specs = frames.slice(0, def.max).map((f) => {
    const min = minSizeFor(f, shape);
    return { id: f.id, min, size: atLeast(isSize(f.size) ? f.size : DEFAULT_SIZE, min) };
  });
  const hidden = extraHidden + Math.max(0, frames.length - def.max);
  const one = (cols, rows, cells) => ({ cols, rows, cells, hidden, shape });
  if (specs.length === 0) return one(1, 1, []);
  if (specs.length === 1) return one(1, 1, [{ id: specs[0].id, col: 0, row: 0, w: 1, h: 1, size: specs[0].size }]);
  if (specs.length === 2) {
    const stacked = shape !== 'landscape' || specs.some((s) => s.size === 'xl' || s.min === 'xl');
    return one(stacked ? 1 : 2, stacked ? 2 : 1, specs.map((s, i) => ({ id: s.id, col: stacked ? 0 : i, row: stacked ? i : 0, w: 1, h: 1, size: s.size })));
  }
  let best = null;
  for (const cols of def.cols) {
    const dims = dimsOf(def.sizes, cols);
    const tallest = Math.max(...specs.map((s) => dims(s.min)[1]));
    for (let rows = tallest; rows <= def.rowsMax; rows++) {
      const plan = planOn(specs, cols, rows, aspect, dims);
      if (!best || plan.score < best.score) best = plan;
    }
  }
  return { cols: best.cols, rows: best.rows, cells: best.cells, hidden: hidden + best.hidden + clippedLists(frames, best, height, width), shape };
}

/**
 * How many list frames (agent rows, doing, swimlane) sit in a cell too short for even their tightest wording: counted as
 * hidden so the board scrolls (every frame at the height it needs) instead of clipping a row. Without a board height: 0.
 */
function clippedLists(frames, plan, height, width) {
  if (!(height > 0)) return 0;
  const floor = floorPx(width, height);
  const byId = new Map(frames.map((f) => [f.id, f]));
  const cellPx = (c) => ((height - NARROW_INSET_PX) * c.h) / plan.rows - NARROW_GAP_PX;
  return plan.cells.filter((c) => {
    const f = byId.get(c.id);
    return f && LIST_TYPES.has(f.type) && cellPx(c) < NARROW_CHROME_PX + listBodyPx(f, { compact: true, floor });
  }).length;
}

/** One candidate grid: shrink to fit, pack, grow into holes, then score (lower is better). */
function planOn(base, cols, rows, aspect, dims) {
  const specs = base.map((s) => ({ ...s }));
  let hidden = 0;
  const total = () => specs.reduce((sum, s) => sum + dims(s.size)[0] * dims(s.size)[1], 0);
  const tooTall = (s) => dims(s.size)[1] > rows;
  for (;;) { // shrink from the end of the list (earlier frames matter more) until it fits; then hide what cannot shrink
    if (total() <= cols * rows && !specs.some(tooTall)) {
      const placed = packFirstFit(specs, cols, rows, dims);
      if (placed.failed === -1) return finish(placed.cells, cols, rows, aspect, hidden);
      const next = smaller(specs[placed.failed], dims);
      if (next) specs[placed.failed].size = next; else { specs.splice(placed.failed, 1); hidden++; }
      continue;
    }
    let k = specs.length - 1;
    while (k >= 0 && !((total() > cols * rows || tooTall(specs[k])) && smaller(specs[k], dims))) k--;
    if (k >= 0) specs[k].size = smaller(specs[k], dims);
    else { specs.pop(); hidden++; }
  }
}

function finish(cells, cols, rows, aspect, hidden) {
  fillHoles(cells, cols, rows, aspect);
  const empty = cols * rows - cells.reduce((sum, c) => sum + c.w * c.h, 0);
  const shapeError = cells.reduce((sum, c) => sum + Math.abs(Math.log(cellAspect(c.w, c.h, cols, rows, aspect) / IDEAL_ASPECT)), 0) / Math.max(1, cells.length);
  return { cols, rows, cells, hidden, score: hidden * HIDDEN_PENALTY + empty * HOLE_PENALTY + shapeError };
}

/** On-screen width:height of a w x h block of cells on a board of the given aspect. */
const cellAspect = (w, h, cols, rows, aspect) => ((w * aspect) / cols) / (h / rows);

function packFirstFit(specs, cols, rows, dims) {
  const used = Array.from({ length: rows }, () => Array(cols).fill(false));
  const cells = [];
  for (const [i, s] of specs.entries()) {
    const [w, h] = dims(s.size);
    let spot = null;
    for (let r = 0; r + h <= rows && !spot; r++) {
      for (let c = 0; c + w <= cols && !spot; c++) if (fits(used, c, r, w, h)) spot = { c, r };
    }
    if (!spot) return { cells, failed: i };
    mark(used, spot.c, spot.r, w, h);
    cells.push({ id: s.id, col: spot.c, row: spot.r, w, h, size: s.size });
  }
  return { cells, failed: -1 };
}

const fits = (used, c, r, w, h) => {
  for (let y = r; y < r + h; y++) for (let x = c; x < c + w; x++) if (used[y][x]) return false;
  return true;
};
function mark(used, c, r, w, h) {
  for (let y = r; y < r + h; y++) for (let x = c; x < c + w; x++) used[y][x] = true;
}

/** Grows frames into empty cells (smallest frame first, toward IDEAL_ASPECT) until nothing can grow. */
function fillHoles(cells, cols, rows, aspect) {
  const used = Array.from({ length: rows }, () => Array(cols).fill(false));
  for (const c of cells) mark(used, c.col, c.row, c.w, c.h);
  const off = (w, h) => Math.abs(Math.log(cellAspect(w, h, cols, rows, aspect) / IDEAL_ASPECT));
  for (;;) {
    let best = null;
    for (const c of cells) {
      const options = [];
      if (c.col + c.w < cols && fits(used, c.col + c.w, c.row, 1, c.h)) options.push({ c, dw: 1, dh: 0, score: off(c.w + 1, c.h) });
      if (c.row + c.h < rows && fits(used, c.col, c.row + c.h, c.w, 1)) options.push({ c, dw: 0, dh: 1, score: off(c.w, c.h + 1) });
      for (const o of options) {
        const area = c.w * c.h;
        if (!best || area < best.area || (area === best.area && o.score < best.score)) best = { ...o, area };
      }
    }
    if (!best) return;
    const { c, dw, dh } = best;
    if (dw) mark(used, c.col + c.w, c.row, 1, c.h); else mark(used, c.col, c.row + c.h, c.w, 1);
    c.w += dw;
    c.h += dh;
  }
}
