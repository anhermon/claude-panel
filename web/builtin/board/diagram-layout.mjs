// diagram-layout.mjs - auto layout of the `diagram` frame, pure (no DOM; text widths come from an injected `measure`).
// Layered left to right: longest-path layering (cycles tolerated: back edges are drawn as loops under the nodes),
// barycentre ordering, columns centred. The caller gives the pixel box it has and the font size it would like; the
// layout shrinks the type (never below MIN_FONT) and the gaps until it fits, so 1 svg unit = 1 css px and the labels
// stay readable. Nodes never overlap and edge-label chips sit in the gaps between layers, never on a node.
import { CAPS, capText } from './board-logic.mjs';

export const MIN_FONT = 14;
export const EDGE_LABEL_MAX = 14;
const SWEEPS = 4;
/** Gap tiers tried at each font before it shrinks: full layer gaps, then tighter (a 6-node diagram in a half tile keeps its 14 px text this way). */
const GAP_SCALES = [1, 0.8, 0.62];
const WRAP_CHARS = 16;
/** Last resort at the smallest font, before the drawing is scaled below it: labels wrap at this many characters (two lines) instead of WRAP_CHARS. */
export const WRAP_CHARS_TIGHT = 9;
const LINE_HEIGHT = 1.3;
const PAD_X = 0.95;
const PAD_Y = 0.62;
const NODE_GAP = 0.9;
const LAYER_GAP_MIN = 2.6;
const LABEL_PAD = 2.2;
const CHIP_PAD_X = 0.45;
const CHIP_H = 1.5;
const LOOP_DEPTH = 2.4;
const MARGIN = 0.5;
const NODE_MIN_W = 4.2;
const FONT_STEP = 1;
const ROW_GAP_MIN = 2.4;
const LABEL_PAD_V = 1.1;
const NODE_GAP_X = 1.1;
/** Spare height of a top-to-bottom diagram goes into the gaps between rows (so the edges show), up to this many fonts each. */
const GAP_STRETCH_MAX = 3;
/** Edge labels are set a touch smaller than the nodes, never below MIN_FONT. */
export const labelFont = (font, minFont = MIN_FONT) => Math.max(minFont, font - 1);

/** The frame's `nodes`/`edges` -> clean lists: caps, unique ids, edges between known nodes only. */
export function normalizeDiagram(frame) {
  const nodes = [];
  const seen = new Set();
  for (const n of Array.isArray(frame.nodes) ? frame.nodes : []) {
    if (n === null || typeof n !== 'object' || nodes.length >= CAPS.nodes) continue;
    const id = String(n.id ?? '');
    if (id === '' || seen.has(id)) continue;
    seen.add(id);
    nodes.push({ id, label: capText(n.label ?? id, CAPS.label) || id, tone: typeof n.tone === 'string' ? n.tone : '' });
  }
  const edges = [];
  for (const e of Array.isArray(frame.edges) ? frame.edges : []) {
    if (e === null || typeof e !== 'object' || edges.length >= CAPS.edges) continue;
    if (seen.has(e.from) && seen.has(e.to) && e.from !== e.to) edges.push({ from: e.from, to: e.to, label: capText(e.label, EDGE_LABEL_MAX) });
  }
  return { nodes, edges };
}

function backEdgeKeys(ids, edges) {
  const out = new Map(ids.map((id) => [id, []]));
  for (const e of edges) out.get(e.from).push(e.to);
  const state = new Map();
  const back = new Set();
  const visit = (id) => {
    state.set(id, 1);
    for (const next of out.get(id)) {
      if (state.get(next) === 1) back.add(`${id}>${next}`);
      else if (!state.has(next)) visit(next);
    }
    state.set(id, 2);
  };
  for (const id of ids) if (!state.has(id)) visit(id);
  return back;
}

/** Layer index per node and the order of the nodes inside each layer. */
export function layerGraph(nodes, edges) {
  const ids = nodes.map((n) => n.id);
  const back = backEdgeKeys(ids, edges);
  const forward = edges.filter((e) => !back.has(`${e.from}>${e.to}`));
  const layer = new Map(ids.map((id) => [id, 0]));
  for (let pass = 0; pass < ids.length; pass++) {
    let moved = false;
    for (const e of forward) if (layer.get(e.to) < layer.get(e.from) + 1) { layer.set(e.to, layer.get(e.from) + 1); moved = true; }
    if (!moved) break;
  }
  const columns = [];
  for (const id of ids) (columns[layer.get(id)] ??= []).push(id);
  const rank = new Map();
  const reindex = () => columns.forEach((col) => col.forEach((id, i) => rank.set(id, i)));
  reindex();
  const preds = new Map(ids.map((id) => [id, []]));
  const succs = new Map(ids.map((id) => [id, []]));
  for (const e of forward) { preds.get(e.to).push(e.from); succs.get(e.from).push(e.to); }
  const bary = (id, around) => { const l = around.get(id); return l.length ? l.reduce((s, n) => s + rank.get(n), 0) / l.length : rank.get(id); };
  for (let sweep = 0; sweep < SWEEPS; sweep++) {
    const down = sweep % 2 === 0;
    for (const col of down ? columns.slice(1) : columns.slice(0, -1).reverse()) {
      col.sort((a, b) => bary(a, down ? preds : succs) - bary(b, down ? preds : succs) || rank.get(a) - rank.get(b));
      reindex();
    }
  }
  return { layer, columns, back };
}

function wrap(label, chars = WRAP_CHARS) {
  if (label.length <= chars) return [label];
  const words = label.split(' ');
  const lines = [''];
  for (const w of words) {
    const last = lines.length - 1;
    if (lines[last] === '' || `${lines[last]} ${w}`.length <= chars) lines[last] = `${lines[last]} ${w}`.trim();
    else lines.push(w);
  }
  return lines.length <= 2 ? lines : [lines[0], capText(lines.slice(1).join(' '), chars)];
}

function makeBoxes(spec, font, measure, chars = WRAP_CHARS) {
  const lineH = font * LINE_HEIGHT;
  const boxes = new Map();
  for (const n of spec.nodes) {
    const lines = wrap(n.label, chars);
    const w = Math.max(font * NODE_MIN_W, ...lines.map((l) => measure(l, font))) + font * PAD_X * 2;
    boxes.set(n.id, { ...n, lines, w, h: lines.length * lineH + font * PAD_Y * 2 });
  }
  return boxes;
}

function layoutAt(spec, graph, font, measure, gapScale, minFont, _extraGap = 0, chars = WRAP_CHARS) {
  const { layer, columns, back } = graph;
  const boxes = makeBoxes(spec, font, measure, chars);
  const labelW = (e) => (e.label ? measure(e.label, labelFont(font, minFont)) + font * CHIP_PAD_X * 2 : 0);
  // gap after layer i: room for the widest label of an edge leaving it, plus a bit of line either side
  const gaps = columns.map((_, i) => {
    const widest = Math.max(0, ...spec.edges.filter((e) => layer.get(e.from) === i && !back.has(`${e.from}>${e.to}`)).map(labelW));
    return Math.max(font * LAYER_GAP_MIN * gapScale, widest + font * LABEL_PAD);
  });
  const colW = columns.map((col) => Math.max(...col.map((id) => boxes.get(id).w)));
  const colH = columns.map((col) => col.reduce((s, id, k) => s + boxes.get(id).h + (k ? font * NODE_GAP : 0), 0));
  const innerH = Math.max(...colH);
  const m = font * MARGIN;
  const hasBack = spec.edges.some((e) => back.has(`${e.from}>${e.to}`));
  let x = m;
  columns.forEach((col, i) => {
    let y = m + (innerH - colH[i]) / 2;
    for (const id of col) {
      const b = boxes.get(id);
      b.x = x + (colW[i] - b.w) / 2;
      b.y = y;
      y += b.h + font * NODE_GAP;
    }
    x += colW[i] + (i < columns.length - 1 ? gaps[i] : 0);
  });
  const bottom = m + innerH;
  const width = x + m;
  const height = bottom + m + (hasBack ? font * (LOOP_DEPTH - 0.4) : 0);
  const edges = spec.edges.map((e) => {
    const a = boxes.get(e.from);
    const b = boxes.get(e.to);
    const isBack = back.has(`${e.from}>${e.to}`);
    const chipW = labelW(e);
    const chipH = font * CHIP_H;
    if (isBack) {
      const p0 = { x: a.x + a.w / 2, y: a.y + a.h };
      const p1 = { x: b.x + b.w / 2, y: b.y + b.h };
      const c = bottom + font * LOOP_DEPTH;
      const midX = (p0.x + p1.x) / 2;
      const midY = 0.25 * ((p0.y + p1.y) / 2) + 0.75 * c;
      return { from: e.from, to: e.to, back: true, d: `M${r(p0.x)},${r(p0.y)} C${r(p0.x)},${r(c)} ${r(p1.x)},${r(c)} ${r(p1.x)},${r(p1.y)}`, label: e.label, lx: midX, ly: midY, lw: chipW, lh: chipH, end: { x: p1.x, y: p1.y, angle: -90 } };
    }
    const p0 = { x: a.x + a.w, y: a.y + a.h / 2 };
    const p1 = { x: b.x, y: b.y + b.h / 2 };
    const k = (p1.x - p0.x) / 2;
    const gapMid = p0.x + gaps[layer.get(e.from)] / 2 - (colW[layer.get(e.from)] - a.w) / 2;
    const t = solveT(p0.x, p0.x + k, p1.x - k, p1.x, gapMid);
    const ly = bez(p0.y, p0.y, p1.y, p1.y, t);
    return { from: e.from, to: e.to, back: false, d: `M${r(p0.x)},${r(p0.y)} C${r(p0.x + k)},${r(p0.y)} ${r(p1.x - k)},${r(p1.y)} ${r(p1.x)},${r(p1.y)}`, label: e.label, lx: gapMid, ly, lw: chipW, lh: chipH, end: { x: p1.x, y: p1.y, angle: 0 } };
  });
  return { nodes: [...boxes.values()], edges, width, height };
}

/** Top to bottom: each layer is a row of nodes, rows stacked, edges leave a node's bottom and enter the next node's top. */
function layoutDownAt(spec, graph, font, measure, gapScale, minFont, extraGap = 0, chars = WRAP_CHARS) {
  const { layer, columns: rows, back } = graph;
  const boxes = makeBoxes(spec, font, measure, chars);
  const chipH = font * CHIP_H;
  const hasLabel = (i) => spec.edges.some((e) => e.label && layer.get(e.from) === i && !back.has(`${e.from}>${e.to}`));
  const gaps = rows.map((_, i) => Math.max(font * ROW_GAP_MIN * gapScale, hasLabel(i) ? chipH + font * LABEL_PAD_V : 0) + extraGap);
  const rowH = rows.map((row) => Math.max(...row.map((id) => boxes.get(id).h)));
  const rowW = rows.map((row) => row.reduce((sum, id, k) => sum + boxes.get(id).w + (k ? font * NODE_GAP_X : 0), 0));
  const innerW = Math.max(...rowW);
  const m = font * MARGIN;
  const hasBack = spec.edges.some((e) => back.has(`${e.from}>${e.to}`));
  const loop = hasBack ? font * LOOP_DEPTH : 0;
  const rowTop = [];
  let y = m;
  rows.forEach((row, i) => {
    rowTop.push(y);
    let x = m + (innerW - rowW[i]) / 2;
    for (const id of row) {
      const b = boxes.get(id);
      b.x = x;
      b.y = y + (rowH[i] - b.h) / 2;
      x += b.w + font * NODE_GAP_X;
    }
    y += rowH[i] + (i < rows.length - 1 ? gaps[i] : 0);
  });
  const width = innerW + 2 * m + loop;
  const height = y + m;
  const right = m + innerW;
  const edges = spec.edges.map((e) => {
    const a = boxes.get(e.from);
    const b = boxes.get(e.to);
    const chipW = e.label ? measure(e.label, labelFont(font, minFont)) + font * CHIP_PAD_X * 2 : 0;
    if (back.has(`${e.from}>${e.to}`)) {
      const p0 = { x: a.x + a.w, y: a.y + a.h / 2 };
      const p1 = { x: b.x + b.w, y: b.y + b.h / 2 };
      const c = right + loop * 0.9;
      return { from: e.from, to: e.to, back: true, d: `M${r(p0.x)},${r(p0.y)} C${r(c)},${r(p0.y)} ${r(c)},${r(p1.y)} ${r(p1.x)},${r(p1.y)}`, label: e.label, lx: Math.min(0.25 * ((p0.x + p1.x) / 2) + 0.75 * c, width - chipW / 2), ly: (p0.y + p1.y) / 2, lw: chipW, lh: chipH, end: { x: p1.x, y: p1.y, angle: 180 } };
    }
    const p0 = { x: a.x + a.w / 2, y: a.y + a.h };
    const p1 = { x: b.x + b.w / 2, y: b.y };
    const k = (p1.y - p0.y) / 2;
    const i = layer.get(e.from);
    const gapMid = rowTop[i] + rowH[i] + gaps[i] / 2;
    const t = solveT(p0.y, p0.y + k, p1.y - k, p1.y, gapMid);
    return { from: e.from, to: e.to, back: false, d: `M${r(p0.x)},${r(p0.y)} C${r(p0.x)},${r(p0.y + k)} ${r(p1.x)},${r(p1.y - k)} ${r(p1.x)},${r(p1.y)}`, label: e.label, lx: bez(p0.x, p0.x, p1.x, p1.x, t), ly: gapMid, lw: chipW, lh: chipH, end: { x: p1.x, y: p1.y, angle: 90 } };
  });
  return { nodes: [...boxes.values()], edges, width, height };
}

const r = (v) => Math.round(v * 10) / 10;
const bez = (a, b, c, d, t) => (1 - t) ** 3 * a + 3 * (1 - t) ** 2 * t * b + 3 * (1 - t) * t * t * c + t ** 3 * d;
function solveT(x0, x1, x2, x3, x) {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i++) { const mid = (lo + hi) / 2; if (bez(x0, x1, x2, x3, mid) < x) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}

/**
 * spec = normalizeDiagram(frame); box = { width, height, font, measure(text, fontPx) -> px, direction: 'right' | 'down' }.
 * Returns { fits, font, scale, offset, base, nodes, edges }: nodes/edges in css px of the BASE drawing; draw it with
 * translate(offset) scale(scale) to centre it in the box. `scale` < 1 only when even MIN_FONT does not fit.
 */
export function layoutDiagram(spec, { width, height, font, measure, minFont = MIN_FONT, direction = 'right' }) {
  if (spec.nodes.length === 0) return { fits: true, font, scale: 1, width, height, nodes: [], edges: [] };
  const graph = layerGraph(spec.nodes, spec.edges);
  const place = direction === 'down' ? layoutDownAt : layoutAt;
  let best = null;
  for (let f = Math.max(minFont, Math.round(font)); f >= minFont; f -= FONT_STEP) {
    for (const chars of f === minFont ? [WRAP_CHARS, WRAP_CHARS_TIGHT] : [WRAP_CHARS]) { // tighter wrapping only once the font cannot shrink further
      for (const gapScale of GAP_SCALES) {
        best = { font: f, ...place(spec, graph, f, measure, gapScale, minFont, 0, chars) };
        if (best.width <= width && best.height <= height) {
          const spare = direction === 'down' && graph.columns.length > 1 ? (height - best.height) / (graph.columns.length - 1) : 0;
          if (spare > 0) best = { font: f, ...place(spec, graph, f, measure, gapScale, minFont, Math.min(spare, f * GAP_STRETCH_MAX), chars) };
          return center(best, width, height, true);
        }
      }
    }
  }
  return center(best, width, height, false);
}

function center(l, width, height, fits) {
  const scale = fits ? 1 : Math.min(1, width / l.width, height / l.height);
  return {
    fits, font: l.font, scale, width, height, base: { width: l.width, height: l.height },
    offset: { x: (width - l.width * scale) / 2, y: (height - l.height * scale) / 2 },
    nodes: l.nodes, edges: l.edges, // base coordinates: the renderer applies translate(offset) scale(scale)
  };
}
