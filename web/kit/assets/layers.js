// layers.js - `layers`: an architecture stack (UI on top, storage at the bottom). Wide: each layer is an isometric slab with thickness and
// item tiles on its top face, names at the left on leader lines, flow arrows in the right gutter. Narrow: flat bands with the same content.
import { AssetError, check, each, defineAsset, s, txt, tip, catColor, toneColor, soft, textWidth, wrap, clamp, px } from './core.js';
import { paintArea } from './fit.js';

const MAX_LAYERS = 6;
const MAX_ITEMS = 8;
const MAX_FLOWS = 12;
const MARGIN = 8;
const SHEAR = 0.38; // screen x shift per px of depth: the isometric lean
const THICK = 14;
const SLAB_GAP = 14;
const TILE_GAP = 8;
const TILE_MIN_W = 92;
const TILE_H_FS = 2.1; // tile height in font sizes
const PAD_S = 10;
const NAME_W_FRAC = 0.2;
const NAME_W_MIN = 110;
const NAME_W_MAX = 190;
const NOTE_LINES = 3;
const GUTTER_FRAC = 0.12;
const GUTTER_MIN = 70;
const GUTTER_MAX = 130;
const BOW_BASE = 26;
const BOW_STEP = 14;
const ARROW_LEN = 9;
const ARROW_HALF = 0.42;
const FILL = { top: 16, front: 38, side: 54, tile: 34 };
const NARROW_GUTTER = 30;
const NARROW_ARROW_STEP = 8;
const BAND_BAR = 5;
const MAX_GROW = 1.7;

function validateLayers(d) {
  check.object(d, 'data', ['layers', 'flow']);
  const names = new Set();
  const layers = each(d.layers, 'data.layers', { max: MAX_LAYERS }, (l, p) => {
    check.object(l, p, ['name', 'items', 'note']);
    const name = check.string(l.name, `${p}.name`, { max: 40 });
    if (names.has(name)) throw new AssetError(`${p}.name "${name}" is used twice: give each layer its own name`);
    names.add(name);
    const items = each(l.items, `${p}.items`, { max: MAX_ITEMS }, (it, ip) => {
      check.object(it, ip, ['label', 'tone']);
      const out = { label: check.string(it.label, `${ip}.label`, { max: 40 }) };
      const tone = check.tone(it.tone, `${ip}.tone`);
      if (tone) out.tone = tone;
      return out;
    });
    const out = { name, items };
    const note = check.string(l.note, `${p}.note`, { max: 120, optional: true });
    if (note) out.note = note;
    return out;
  });
  const flow = d.flow === undefined ? [] : each(d.flow, 'data.flow', { min: 0, max: MAX_FLOWS }, (f, p) => {
    check.object(f, p, ['from', 'to', 'label']);
    const end = (k) => { const v = check.string(f[k], `${p}.${k}`, { max: 40 }); if (!names.has(v)) throw new AssetError(`${p}.${k} "${v}" is not a layer name (layers: ${[...names].join(', ')})`); return v; };
    const out = { from: end('from'), to: end('to') };
    if (out.from === out.to) throw new AssetError(`${p} goes from layer "${out.from}" to itself`);
    const label = check.string(f.label, `${p}.label`, { max: 30, optional: true });
    if (label) out.label = label;
    return out;
  });
  return flow.length ? { layers, flow } : { layers };
}

const arrowHead = (x, y, ang) => {
  const wing = (sg) => `${x - Math.cos(ang + sg * ARROW_HALF) * ARROW_LEN},${y - Math.sin(ang + sg * ARROW_HALF) * ARROW_LEN}`;
  return `${x},${y} ${wing(1)} ${wing(-1)}`;
};

/** Greedy grid for `n` tiles: columns by the width available, rows to match. */
const grid = (n, width) => {
  const cols = clamp(Math.floor((width + TILE_GAP) / (TILE_MIN_W + TILE_GAP)), 1, n);
  return { cols, rows: Math.ceil(n / cols), tw: (width - (cols - 1) * TILE_GAP) / cols };
};

function drawLayers(ctx) {
  const { data, w, narrow } = ctx;
  const f = Math.max(px.min, ctx.fs * 0.92);
  const lineH = f * 1.25;
  const th = f * TILE_H_FS;
  const noteF = Math.max(px.min, f * 0.9);
  const idx = new Map(data.layers.map((l, i) => [l.name, i]));
  const flows = data.flow ?? [];
  const tileColor = (l, i, it) => (it.tone ? toneColor(it.tone) : catColor(i));
  const paintTile = (g, x, y, tw, c, it) => {
    g.append(tip(s('rect', { x, y, width: tw, height: th, rx: 4, fill: soft(c, FILL.tile), stroke: c, 'stroke-width': 1 }), it.label));
    txt(g, x + tw / 2, y + th / 2, it.label, { size: f, anchor: 'middle', maxW: tw - 8 });
  };

  if (narrow) {
    // ---- flat bands, top first; flows as vertical arrows in a right gutter ----
    const gut = flows.length ? NARROW_GUTTER + flows.length * NARROW_ARROW_STEP : 0;
    const bw = w - 2 * MARGIN - gut;
    const bands = data.layers.map((l) => {
      const gr = grid(l.items.length, bw - 2 * PAD_S);
      const noteL = l.note ? wrap(l.note, bw - 2 * PAD_S, noteF, NOTE_LINES) : [];
      return { l, gr, noteL, h: PAD_S + lineH + (noteL.length ? noteL.length * noteF * 1.25 + 2 : 0) + PAD_S / 2 + gr.rows * th + (gr.rows - 1) * TILE_GAP + PAD_S + BAND_BAR };
    });
    const need = bands.reduce((a, b) => a + b.h + SLAB_GAP, MARGIN * 2 - SLAB_GAP);
    const { g, h } = paintArea(ctx, need);
    let y = MARGIN + Math.max(0, (h - need) / 2);
    bands.forEach((b, i) => {
      const c = catColor(i);
      b.y = y;
      g.append(s('rect', { x: MARGIN, y: y + BAND_BAR, width: bw, height: b.h - BAND_BAR, rx: 8, fill: soft(c, FILL.front), stroke: 'none' })); // the slab's thickness
      g.append(tip(s('rect', { x: MARGIN, y, width: bw, height: b.h - BAND_BAR, rx: 8, fill: soft(c, FILL.top), stroke: c, 'stroke-width': 1.2 }), b.l.name));
      txt(g, MARGIN + PAD_S, y + PAD_S + lineH / 2, b.l.name, { size: f, cls: 'pa-b', maxW: bw - 2 * PAD_S });
      let ty = y + PAD_S + lineH;
      b.noteL.forEach((ln, k) => txt(g, MARGIN + PAD_S, ty + noteF * 0.7 + k * noteF * 1.25, ln, { size: noteF, cls: 'pa-m' }));
      ty += b.noteL.length ? b.noteL.length * noteF * 1.25 + 2 : 0;
      ty += PAD_S / 2;
      b.l.items.forEach((it, k) => paintTile(g, MARGIN + PAD_S + (k % b.gr.cols) * (b.gr.tw + TILE_GAP), ty + Math.floor(k / b.gr.cols) * (th + TILE_GAP), b.gr.tw, tileColor(b.l, i, it), it));
      y += b.h + SLAB_GAP;
    });
    flows.forEach((fl, k) => {
      const a = bands[idx.get(fl.from)];
      const bnd = bands[idx.get(fl.to)];
      const x = w - MARGIN - gut + NARROW_GUTTER / 2 + k * NARROW_ARROW_STEP;
      const y0 = a.y + (a.h - BAND_BAR) / 2;
      const y1 = bnd.y + (bnd.h - BAND_BAR) / 2;
      const edge = bw + MARGIN;
      g.append(s('path', { d: `M${edge},${y0} H${x} V${y1} H${edge + ARROW_LEN * 0.7}`, fill: 'none', stroke: 'var(--ui-acc)', 'stroke-width': 2, 'stroke-linejoin': 'round' }));
      g.append(tip(s('polygon', { points: arrowHead(edge + 1, y1, Math.PI), fill: 'var(--ui-acc)' }), `${fl.from} -> ${fl.to}${fl.label ? `: ${fl.label}` : ''}`));
      if (fl.label) {
        const len = Math.abs(y1 - y0) - 2 * ARROW_LEN;
        const dir = Math.sign(y1 - y0);
        if (len > noteF * 2) { const t = txt(g, 0, 0, fl.label, { size: noteF, anchor: 'middle', cls: 'pa-m pa-halo', maxW: len }); t.setAttribute('transform', `translate(${x - noteF * 0.5 - 2},${(y0 + y1) / 2}) rotate(-90)`); }
      }
    });
    return;
  }

  // ---- isometric slabs ----
  const nameW = clamp(w * NAME_W_FRAC, NAME_W_MIN, NAME_W_MAX);
  const gut = flows.length ? clamp(w * GUTTER_FRAC, GUTTER_MIN, GUTTER_MAX) : 0;
  const x0 = MARGIN + nameW + 12;
  // the slab width must leave room for the lean of the deepest layer and the flow gutter
  const probeW = w - x0 - gut - MARGIN;
  const build = (k) => data.layers.map((l) => {
    const thK = th * k;
    const naive = grid(l.items.length, probeW - 2 * PAD_S - SHEAR * (thK + 2 * TILE_GAP) * 3);
    const d = naive.rows * thK + (naive.rows + 1) * TILE_GAP;
    const gr = grid(l.items.length, probeW - SHEAR * d - 2 * PAD_S);
    const d2 = gr.rows * thK + (gr.rows + 1) * TILE_GAP;
    const nameL = wrap(l.name, nameW - 8, f, 2, 700);
    const noteL = l.note ? wrap(l.note, nameW - 8, noteF, NOTE_LINES) : [];
    const block = nameL.length * lineH + noteL.length * noteF * 1.25 + 4;
    return { l, gr, d: d2, thK, thick: THICK * k, sk: SHEAR * d2, nameL, noteL, pitch: Math.max(d2 + THICK * k, block) + SLAB_GAP };
  });
  const total = (sl) => sl.reduce((a, x) => a + x.pitch, 0) - SLAB_GAP + 2 * MARGIN;
  // a short stack in a tall box: thicker slabs and taller tiles so it fills the room (capped), never smaller than the base size
  const k = clamp((ctx.h - 2 * MARGIN) / (total(build(1)) - 2 * MARGIN), 1, MAX_GROW);
  const slabs = build(k);
  const skMax = Math.max(...slabs.map((sl) => sl.sk));
  const wd = w - x0 - gut - MARGIN - skMax; // the front edge width, the same for every slab so they stack as one block
  const need = total(slabs);
  const { g, h } = paintArea(ctx, need);
  const base = MARGIN + Math.max(0, (h - need) / 2);
  const slabLayer = g.appendChild(s('g'));
  const flowLayer = g.appendChild(s('g', { fill: 'none' }));
  const labelLayer = g.appendChild(s('g'));
  let top = base;
  slabs.forEach((sl, i) => {
    const c = catColor(i);
    const THICKK = sl.thick;
    const yTop = top + (sl.pitch - SLAB_GAP - (sl.d + THICKK)) / 2;
    const yb = yTop + sl.d; // front edge of the top face
    sl.yTop = yTop;
    sl.yb = yb;
    const x1 = x0 + wd;
    const poly = (pts, fill) => s('polygon', { points: pts.map((q) => q.join(',')).join(' '), fill, stroke: c, 'stroke-width': 1, 'stroke-linejoin': 'round' });
    const group = s('g');
    group.append(poly([[x0, yb], [x1, yb], [x1, yb + THICKK], [x0, yb + THICKK]], soft(c, FILL.front)));
    group.append(poly([[x1, yb], [x1 + sl.sk, yTop], [x1 + sl.sk, yTop + THICKK], [x1, yb + THICKK]], soft(c, FILL.side)));
    group.append(poly([[x0, yb], [x1, yb], [x1 + sl.sk, yTop], [x0 + sl.sk, yTop]], soft(c, FILL.top)));
    slabLayer.append(tip(group, sl.l.name));
    // tiles: a sheared parallelogram on the top face, first item at the back-left, text kept upright
    const pt = (xl, v) => [x0 + xl + SHEAR * v, yb - v];
    const gw = wd - 2 * PAD_S;
    const gr = { ...sl.gr, tw: (gw - (sl.gr.cols - 1) * TILE_GAP) / sl.gr.cols };
    sl.l.items.forEach((it, k) => {
      const col = k % gr.cols;
      const row = Math.floor(k / gr.cols);
      const xa = PAD_S + col * (gr.tw + TILE_GAP);
      const xb = xa + gr.tw;
      const v1 = sl.d - TILE_GAP - row * (sl.thK + TILE_GAP);
      const v0 = v1 - sl.thK;
      const tc = tileColor(sl.l, i, it);
      const corners = [pt(xa, v0), pt(xb, v0), pt(xb, v1), pt(xa, v1)];
      slabLayer.append(tip(s('polygon', { points: corners.map((q) => q.join(',')).join(' '), fill: soft(tc, FILL.tile), stroke: tc, 'stroke-width': 1, 'stroke-linejoin': 'round' }), it.label));
      const [cx, cy] = pt((xa + xb) / 2, (v0 + v1) / 2);
      txt(labelLayer, cx, cy, it.label, { size: f, anchor: 'middle', maxW: gr.tw - 8 });
    });
    // name + note on the left, joined to the slab by a leader line
    const midY = yb - sl.d / 2;
    const blockH = sl.nameL.length * lineH + sl.noteL.length * noteF * 1.25;
    let ty = midY - blockH / 2;
    sl.nameL.forEach((ln) => { txt(labelLayer, MARGIN, ty + lineH / 2, ln, { size: f, cls: 'pa-b', weight: 700 }); ty += lineH; });
    sl.noteL.forEach((ln) => { txt(labelLayer, MARGIN, ty + noteF * 0.62, ln, { size: noteF, cls: 'pa-m' }); ty += noteF * 1.25; });
    const nameEnd = MARGIN + Math.max(...sl.nameL.map((ln) => textWidth(ln, f, 700)), ...sl.noteL.map((ln) => textWidth(ln, noteF)));
    flowLayer.append(s('path', { d: `M${nameEnd + 6},${midY} H${x0 + SHEAR * (sl.d / 2) - 3}`, class: 'pa-grid', 'stroke-dasharray': '2 4' }));
    flowLayer.append(s('circle', { cx: x0 + SHEAR * (sl.d / 2), cy: midY, r: 2.5, fill: c }));
    top += sl.pitch;
  });
  // flows: curves from the right end of one slab to the next, bowing into the gutter
  const x1 = x0 + wd;
  flows.forEach((fl, k) => {
    const a = slabs[idx.get(fl.from)];
    const b = slabs[idx.get(fl.to)];
    const ax = x1 + a.sk / 2;
    const ay = a.yb - a.d / 2 + a.thick / 2;
    const bx = x1 + b.sk / 2;
    const by = b.yb - b.d / 2 + b.thick / 2;
    const bow = BOW_BASE + k * BOW_STEP;
    const ex = bx + 2;
    flowLayer.append(tip(s('path', { d: `M${ax + 2},${ay} C${ax + bow},${ay} ${bx + bow},${by} ${ex + ARROW_LEN * 0.7},${by}`, stroke: 'var(--ui-acc)', 'stroke-width': 2, 'stroke-linecap': 'round' }), `${fl.from} -> ${fl.to}${fl.label ? `: ${fl.label}` : ''}`));
    flowLayer.append(s('polygon', { points: arrowHead(ex, by, Math.PI), fill: 'var(--ui-acc)' }));
    if (fl.label) txt(labelLayer, Math.max(ax, bx) + bow * 0.75 + 6, (ay + by) / 2, fl.label, { size: noteF, cls: 'pa-m pa-halo', maxW: w - (Math.max(ax, bx) + bow * 0.75 + 6) - 2 });
  });
}

export const layers = defineAsset({
  kind: 'layers',
  shape: 'how a system is stacked (UI over services over storage): which components live in which layer, and what talks to what across layers',
  summary: 'An isometric stack of slabs, top layer first: tiles of components sit on each slab, layer names on leader lines at the left, accent arrows between layers. Flat bands when narrow.',
  keys: ['layers', 'flow'],
  aspect: 0.62,
  minH: 300,
  sample: {
    layers: [
      { name: 'Interface', items: [{ label: 'Web app' }, { label: 'CLI' }, { label: 'Panel' }], note: 'what the user touches' },
      { name: 'Agents', items: [{ label: 'Planner' }, { label: 'Coder' }, { label: 'Reviewer' }, { label: 'Tester', tone: 'warn' }], note: 'decide and act' },
      { name: 'Tools', items: [{ label: 'Shell' }, { label: 'Editor' }, { label: 'Search' }, { label: 'Browser' }, { label: 'Git' }] },
      { name: 'Storage', items: [{ label: 'Repo' }, { label: 'Cache', tone: 'ok' }, { label: 'Logs' }], note: 'what survives a restart' },
    ],
    flow: [{ from: 'Interface', to: 'Agents', label: 'prompts' }, { from: 'Agents', to: 'Tools', label: 'calls' }, { from: 'Tools', to: 'Storage', label: 'writes' }],
  },
  validate: validateLayers,
  draw: drawLayers,
});
