// sketch.js - `sketch`: a hand-drawn diagram (rough.js) for ideas that are not final. Wobbly boxes and arrows say "draft";
// `unsure` nodes and edges are dashed, lighter and carry a "?". The seed is fixed so every redraw is identical.
import { AssetError, check, each, ref, defineAsset, s, txt, tip, catColor, soft, textWidth, wrap, clamp, px } from './core.js';
import { layerGraph, placeLayers } from './layout.js';
import { paintArea } from './fit.js';

const MAX_NODES = 16;
const MAX_EDGES = 30;
const MAX_LABEL = 50;
const SHAPES = ['box', 'ellipse', 'diamond'];
const SEED = 7;
const ROUGHNESS = 1.3;
const BOWING = 1.4;
const STROKE_W = 1.7;
const UNSURE_OPACITY = 0.62;
const UNSURE_DASH = [7, 6];
const FILL_PCT = 22;
const PAD_X = 12;
const PAD_Y = 8;
const MIN_FS = 13;
const MAX_LINES = 2;
const SHAPE_GROW = { box: [1, 1], ellipse: [1.3, 1.45], diamond: [1.7, 1.9] };
const EDGE_GAP = 64;
const MIN_TEXT_W = 56;
const MIN_COL_W = 120;
const MIN_NODE_SLOT = 100;
const MAX_TEXT_W = 200;
const LONG_BEND = 0.2; // an edge that skips layers bows so it does not run through the nodes between
const NODE_GAP = 22;
const MARGIN = 10;
const ARROW_LEN = 13;
const ARROW_ANGLE = 0.46;
const LAYER_GAP_NARROW = 54;
const BACK_BEND = 0.5;
const NOTE_GAP = 14;
const LABEL_SIDE = 12;

function validateSketch(d) {
  check.object(d, 'data', ['nodes', 'edges', 'note']);
  const ids = new Set();
  const nodes = each(d.nodes, 'data.nodes', { max: MAX_NODES }, (n, p) => {
    check.object(n, p, ['id', 'label', 'shape', 'unsure']);
    return { id: check.id(n.id, `${p}.id`, ids), label: check.string(n.label, `${p}.label`, { max: MAX_LABEL }), shape: check.oneOf(n.shape, `${p}.shape`, SHAPES, { optional: true }) ?? 'box', unsure: check.bool(n.unsure, `${p}.unsure`) === true };
  });
  const edges = d.edges === undefined ? [] : each(d.edges, 'data.edges', { min: 0, max: MAX_EDGES }, (e, p) => {
    check.object(e, p, ['from', 'to', 'label', 'unsure']);
    const from = ref(e.from, `${p}.from`, ids);
    const to = ref(e.to, `${p}.to`, ids);
    if (from === to) throw new AssetError(`${p} goes from "${from}" to itself`);
    return { from, to, label: check.string(e.label, `${p}.label`, { max: 30, optional: true }), unsure: check.bool(e.unsure, `${p}.unsure`) === true };
  });
  const out = { nodes, edges };
  const note = check.string(d.note, 'data.note', { max: 200, optional: true });
  if (note) out.note = note;
  return out;
}

/** Where the ray from node centre `p` towards `q` leaves the node's outline (box, ellipse or diamond). */
function boundary(p, q) {
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  const hw = p.w / 2;
  const hh = p.h / 2;
  const k = p.shape === 'ellipse' ? 1 / Math.hypot(dx / hw || 0, dy / hh || 0) : p.shape === 'diamond' ? 1 / (Math.abs(dx) / hw + Math.abs(dy) / hh) : 1 / Math.max(Math.abs(dx) / hw, Math.abs(dy) / hh);
  return Number.isFinite(k) ? { x: p.x + dx * k, y: p.y + dy * k } : { x: p.x, y: p.y };
}

async function drawSketch(ctx) {
  const rough = (await import('roughjs')).default;
  const { data, w, narrow } = ctx;
  const f = Math.max(MIN_FS, px.min, ctx.fs);
  const lineH = f * 1.25;
  const { layers, layerOf, backEdges } = layerGraph(data.nodes.map((n) => n.id), data.edges);
  const perLayer = Math.max(...layers.map((l) => l.length));
  const vertical = narrow || layers.length * MIN_COL_W > w; // too many columns for the width: flow top -> down instead
  // text width budget: wide = columns share the width; narrow (top -> down) = a layer's nodes share the width
  const perRow = clamp(Math.floor((w - 2 * MARGIN) / MIN_NODE_SLOT), 1, perLayer); // vertical: more nodes than fit one row wrap onto the next row
  const slot = vertical ? (w - 2 * MARGIN) / perRow - NODE_GAP : (w - 2 * MARGIN) / layers.length - EDGE_GAP;
  const nodes = data.nodes.map((n, i) => {
    const [gw, gh] = SHAPE_GROW[n.shape];
    const lines = wrap(n.label, clamp(slot / gw - 2 * PAD_X, MIN_TEXT_W, MAX_TEXT_W), f, MAX_LINES); // a bigger shape gets less text width: its outline adds the rest
    const tw = Math.max(...lines.map((l) => textWidth(l, f)));
    return { ...n, i, lines, w: (tw + 2 * PAD_X) * gw, h: (lines.length * lineH + 2 * PAD_Y) * gh };
  });
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const noteLines = data.note ? wrap(data.note, w - 2 * MARGIN, f, 3) : [];
  const noteH = noteLines.length ? noteLines.length * lineH + NOTE_GAP : 0;
  const maxH = Math.max(...nodes.map((n) => n.h));
  // along-axis length: wide = x (fixed w); narrow = y (grows with the number of layers)
  const rows = vertical ? layers.flatMap((l) => Array.from({ length: Math.ceil(l.length / perRow) }, (_, i) => l.slice(i * perRow, (i + 1) * perRow))) : layers;
  const needVertical = rows.length * maxH + (rows.length - 1) * LAYER_GAP_NARROW + 2 * MARGIN;
  const needWide = Math.max(...layers.map((l) => l.reduce((a, id) => a + byId.get(id).h + NODE_GAP, 0))) + 2 * MARGIN;
  const { g, h } = paintArea(ctx, (vertical ? needVertical : needWide) + noteH);
  const boxH = h - noteH;
  const padA = vertical ? maxH / 2 + MARGIN : Math.max(...nodes.map((n) => n.w)) / 2 + MARGIN;
  const place = vertical ? placeLayers(rows, boxH, w, padA) : placeLayers(layers, w, boxH, padA);
  const padC = vertical ? Math.max(...nodes.map((n) => n.w)) / 2 + MARGIN : maxH / 2 + MARGIN;
  // vertical: a row's nodes share the full width evenly, so neighbours stay one slot apart
  const xInRow = new Map(rows.flatMap((row) => row.map((id, i) => [id, MARGIN + ((i + 0.5) * (w - 2 * MARGIN)) / row.length])));
  for (const n of nodes) {
    const p = place.get(n.id);
    // cross axis: keep clear of the edge so the shape never leaves the box
    n.x = vertical ? xInRow.get(n.id) : p.x;
    n.y = vertical ? p.x : clamp(p.y, padC, boxH - padC);
  }

  const rc = rough.svg(ctx.svg);
  const ink = g.appendChild(s('g', { color: 'var(--ui-fg)', fill: 'none' }));
  const label = g.appendChild(s('g'));
  const opt = (i, unsure, extra) => ({ seed: SEED + i, roughness: ROUGHNESS, bowing: BOWING, stroke: 'currentColor', strokeWidth: STROKE_W, fill: 'none', ...(unsure ? { strokeLineDash: UNSURE_DASH } : {}), ...extra });
  const stroke = (i, unsure, make) => { const el = make(opt(i, unsure)); if (unsure) el.setAttribute('opacity', UNSURE_OPACITY); ink.append(el); return el; };

  // edges first (under the nodes' fills)
  data.edges.forEach((e, i) => {
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    const back = backEdges.has(e);
    const bent = back || Math.abs(layerOf.get(e.to) - layerOf.get(e.from)) > 1;
    let line;
    let p0 = boundary(a, b);
    let p1 = boundary(b, a);
    let mid = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
    let angle = Math.atan2(p1.y - p0.y, p1.x - p0.x);
    if (bent) { // a return or layer-skipping arrow bows away so it does not run through the nodes between
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const k = back ? BACK_BEND : LONG_BEND;
      const between = nodes.filter((n) => layerOf.get(n.id) > Math.min(layerOf.get(e.from), layerOf.get(e.to)) && layerOf.get(n.id) < Math.max(layerOf.get(e.from), layerOf.get(e.to)));
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      const cand = [1, -1].map((sg) => ({ x: mx - dy * k * sg, y: my + dx * k * sg }));
      const away = (c) => (between.length ? Math.min(...between.map((n) => Math.hypot(n.x - c.x, n.y - c.y))) : 0);
      const pick = away(cand[0]) >= away(cand[1]) ? cand[0] : cand[1];
      const bow = { x: clamp(pick.x, MARGIN, w - MARGIN), y: pick.y };
      p0 = boundary(a, bow);
      p1 = boundary(b, bow);
      angle = Math.atan2(p1.y - bow.y, p1.x - bow.x);
      mid = { x: 0.25 * p0.x + 0.5 * bow.x + 0.25 * p1.x, y: 0.25 * p0.y + 0.5 * bow.y + 0.25 * p1.y };
      line = stroke(i, e.unsure, (o) => rc.curve([[p0.x, p0.y], [bow.x, bow.y], [p1.x, p1.y]], o));
    } else line = stroke(i, e.unsure, (o) => rc.line(p0.x, p0.y, p1.x, p1.y, o));
    for (const sgn of [1, -1]) {
      const hx = p1.x - Math.cos(angle + sgn * ARROW_ANGLE) * ARROW_LEN;
      const hy = p1.y - Math.sin(angle + sgn * ARROW_ANGLE) * ARROW_LEN;
      stroke(i + 100 * (sgn > 0 ? 1 : 2), false, (o) => rc.line(p1.x, p1.y, hx, hy, { ...o, strokeLineDash: undefined })).setAttribute('opacity', e.unsure ? UNSURE_OPACITY : 1);
    }
    if (e.label) { // wide: above the line; narrow (vertical edges): beside it
      const t = vertical ? txt(label, mid.x + LABEL_SIDE, mid.y, e.label, { size: f, cls: 'pa-m pa-halo', maxW: w - mid.x - LABEL_SIDE - MARGIN })
        : txt(label, mid.x, mid.y - lineH * 0.7, e.label, { size: f, anchor: 'middle', cls: 'pa-m pa-halo', maxW: Math.max(70, EDGE_GAP * 1.4) });
      t.setAttribute('font-style', 'italic');
    }
    tip(line, `${a.label} -> ${b.label}${e.label ? `: ${e.label}` : ''}${e.unsure ? ' (unsure)' : ''}`);
  });

  for (const n of nodes) {
    const c = catColor(layerOf.get(n.id));
    const shape = n.shape === 'diamond' ? [[n.x, n.y - n.h / 2], [n.x + n.w / 2, n.y], [n.x, n.y + n.h / 2], [n.x - n.w / 2, n.y]] : null;
    const fillEl = shape ? s('polygon', { points: shape.map((q) => q.join(',')).join(' '), fill: soft(c, FILL_PCT) }) : n.shape === 'ellipse' ? s('ellipse', { cx: n.x, cy: n.y, rx: n.w / 2, ry: n.h / 2, fill: soft(c, FILL_PCT) }) : s('rect', { x: n.x - n.w / 2, y: n.y - n.h / 2, width: n.w, height: n.h, rx: 4, fill: soft(c, FILL_PCT) });
    fillEl.setAttribute('opacity', n.unsure ? UNSURE_OPACITY : 1);
    label.append(tip(fillEl, `${n.label}${n.unsure ? ' (unsure)' : ''}`));
    stroke(n.i + 50, n.unsure, (o) => (shape ? rc.polygon(shape, o) : n.shape === 'ellipse' ? rc.ellipse(n.x, n.y, n.w, n.h, o) : rc.rectangle(n.x - n.w / 2, n.y - n.h / 2, n.w, n.h, o)));
    const el = s('text', { x: n.x, y: n.y - ((n.lines.length - 1) * lineH) / 2, class: 'pa-t', 'font-size': f, 'font-style': 'italic', 'text-anchor': 'middle', 'dominant-baseline': 'middle', opacity: n.unsure ? 0.8 : 1 });
    n.lines.forEach((ln, k) => el.append(s('tspan', { x: n.x, dy: k === 0 ? 0 : lineH }, ln)));
    label.append(el);
    if (n.unsure) txt(label, n.x + n.w / 2 - 2, n.y - n.h / 2 - 2, '?', { size: f + 4, anchor: 'middle', cls: 'pa-b pa-halo', fill: 'var(--ui-warn)' });
  }
  noteLines.forEach((ln, k) => txt(label, MARGIN, boxH + NOTE_GAP / 2 + lineH * (k + 0.5), ln, { size: f, cls: 'pa-m' }).setAttribute('font-style', 'italic'));
}

export const sketch = defineAsset({
  kind: 'sketch',
  shape: 'a rough idea or draft architecture that is not settled: boxes and arrows with some parts still uncertain',
  summary: 'A hand-drawn diagram: wobbly boxes, ellipses and diamonds with wobbly arrows and italic labels; parts marked unsure are dashed, faded and carry a "?". It looks like a whiteboard on purpose: not final.',
  keys: ['nodes', 'edges', 'note'],
  aspect: 0.45,
  minH: 240,
  sample: {
    nodes: [
      { id: 'user', label: 'User prompt', shape: 'ellipse' }, { id: 'router', label: 'Router agent' }, { id: 'cached', label: 'Cache hit?', shape: 'diamond' },
      { id: 'reply', label: 'Cached reply', shape: 'ellipse' }, { id: 'coder', label: 'Coder agent' }, { id: 'review', label: 'Reviewer', unsure: true }, { id: 'ship', label: 'Commit', shape: 'ellipse' },
    ],
    edges: [
      { from: 'user', to: 'router' }, { from: 'router', to: 'cached', label: 'check' }, { from: 'cached', to: 'reply', label: 'yes' },
      { from: 'cached', to: 'coder', label: 'no' }, { from: 'coder', to: 'review', label: 'maybe', unsure: true }, { from: 'review', to: 'ship', unsure: true }, { from: 'coder', to: 'ship', label: 'pass' },
    ],
    note: 'Draft: the reviewer step is undecided, it may fold into the coder.',
  },
  validate: validateSketch,
  draw: drawSketch,
});
