// hierarchy.js - part-of-whole over a tree: `treemap` (area = share, nested boxes), `sunburst` (rings out from the whole),
// `icicle` (bars left to right, best for long names and narrow widths). All three read the same {unit, root:{name, value|children}}.
import * as d3 from '../d3/d3.mjs';
import { AssetError, check, each, defineAsset, s, txt, tip, catColor, soft, textWidth, ellipsize, fmt, clamp, px } from './core.js';

const MAX_DEPTH = 4; // levels below the root
const MAX_NODES = 150;
const NAME_MAX = 60;
const UNIT_MAX = 12;
const HEADER_PAD = 6;
const INNER_PAD = 2;
const MIN_LABEL_W = 44; // a treemap leaf narrower than this gets no text (tooltip only)
const LEAF_PCT_TOP = 52; // fill strength of depth-1 leaves; deeper levels get lighter
const LEAF_PCT_STEP = 9;
const LEAF_PCT_MIN = 22;
const PARENT_BODY_PCT = 14;
const PARENT_HEAD_PCT = 40;
const EDGE_PCT = 60;
const ROOT_TINT_PCT = 18;
const ARC_GAP = 1.5;
const CENTER_FRAC = 0.28;
const MIN_ARC_LABEL_W = 28;
const NARROW_RINGS = 2; // rings that get labels on narrow stages
const LEGEND_MAX_W = 270;
const LEGEND_FRAC = 0.3;
const LEGEND_EXTRA_MIN = 300; // spare width beside the circle needed for the legend
const LEGEND_ROW = 1.9;
const SWATCH = 12;
const FULL_TURN = Math.PI * 2;
const DEG = 180 / Math.PI;
const MIN_PCT_SHOWN = 1;
const SUB_OPACITY = 0.8;

// ---- shared validation ----------------------------------------------------------------------------------------------------------
/** {unit?, root:{name, value (leaf) | children}} -> clean tree. Exported so other tree assets share one data shape. */
export function validateTree(d) {
  check.object(d, 'data', ['unit', 'root']);
  const unit = check.string(d.unit, 'data.unit', { max: UNIT_MAX, optional: true }) ?? '';
  let count = 0;
  const node = (n, p, depth) => {
    check.object(n, p, ['name', 'value', 'children']);
    if (++count > MAX_NODES) throw new AssetError(`data.root has more than ${MAX_NODES} nodes: group the small ones`);
    const name = check.string(n.name, `${p}.name`, { max: NAME_MAX });
    if (n.children === undefined || n.children === null) return { name, value: check.number(n.value, `${p}.value`, { min: 0 }) };
    if (n.value !== undefined && n.value !== null) throw new AssetError(`${p} has both children and a value: give values to leaves only (parents add up)`);
    if (depth >= MAX_DEPTH) throw new AssetError(`${p}.children goes deeper than ${MAX_DEPTH} levels below the root: flatten the tree`);
    return { name, children: each(n.children, `${p}.children`, { max: MAX_NODES }, (c, cp) => node(c, cp, depth + 1)) };
  };
  const root = node(d.root, 'data.root', 0);
  if (!root.children) throw new AssetError('data.root.children needs at least 1 item (the root is the whole, its children are the parts)');
  return { unit, root };
}

const prune = (n) => {
  if (!n.children) return n.value > 0 ? n : null;
  const kids = n.children.map(prune).filter(Boolean);
  return kids.length ? { name: n.name, children: kids } : null;
};
/** d3 hierarchy of the non-zero part of the tree, biggest first; null when everything is zero. */
function build(data) {
  const raw = prune(data.root);
  if (!raw) return null;
  const root = d3.hierarchy(raw).sum((n) => (n.children ? 0 : n.value)).sort((a, b) => b.value - a.value);
  return { root, total: root.value, top: root.children };
}
const pathOf = (n) => n.ancestors().reverse().map((a) => a.data.name).join(' / ');
const pctOf = (v, total) => { const p = (v / total) * 100; return p < MIN_PCT_SHOWN ? '<1%' : `${Math.round(p)}%`; };
const colorOf = (n, top) => (n.depth === 0 ? 'var(--ui-mut)' : catColor(top.indexOf(n.ancestors().at(-2))));
const depthPct = (depth) => clamp(LEAF_PCT_TOP - (depth - 1) * LEAF_PCT_STEP, LEAF_PCT_MIN, LEAF_PCT_TOP);
const hover = (el, n, t, unit) => tip(el, `${pathOf(n)}: ${fmt(n.value, unit)} (${pctOf(n.value, t.total)} of ${t.root.data.name})`);
/** Secondary text on a tinted fill: the theme's text colour, dimmed (the muted token is too faint on colour). */
const sub = (el) => { el.setAttribute('opacity', SUB_OPACITY); return el; };
const labelFs = (fs) => Math.max(px.min, fs * 0.92);

function empty(svg, w, h, fs) {
  txt(svg, w / 2, h / 2, 'Nothing to show: every value is 0', { size: fs, anchor: 'middle', cls: 'pa-m', maxW: w - 16 });
}

// ---- treemap -----------------------------------------------------------------------------------------------------------------------
function drawTreemap({ data, svg, w, h, fs }) {
  const t = build(data);
  if (!t) return empty(svg, w, h, fs);
  const f = labelFs(fs);
  const head = f + HEADER_PAD;
  d3.treemap().size([w, h]).tile(d3.treemapSquarify).paddingInner(INNER_PAD).paddingOuter(INNER_PAD)
    .paddingTop((n) => (n.depth === 0 || n.children ? head : INNER_PAD)).round(true)(t.root);
  for (const n of t.root.descendants()) {
    const bw = n.x1 - n.x0;
    const bh = n.y1 - n.y0;
    if (n.depth === 0) { txt(svg, n.x0 + INNER_PAD + 2, n.y0 + head / 2, `${n.data.name} · ${fmt(t.total, data.unit)}`, { size: f, weight: 700, maxW: w - 12 }); continue; }
    if (bw < 1 || bh < 1) continue;
    const c = colorOf(n, t.top);
    const g = svg.appendChild(s('g', { class: 'pa-in' }));
    g.append(hover(s('rect', { x: n.x0, y: n.y0, width: bw, height: bh, rx: 2, fill: soft(c, n.children ? PARENT_BODY_PCT : depthPct(n.depth)), stroke: soft(c, EDGE_PCT), 'stroke-width': 1 }), n, t, data.unit));
    if (n.children) {
      if (bh < head || bw < MIN_LABEL_W) continue;
      g.append(s('rect', { x: n.x0, y: n.y0, width: bw, height: head, rx: 2, fill: soft(c, PARENT_HEAD_PCT), 'pointer-events': 'none' }));
      txt(g, n.x0 + 5, n.y0 + head / 2, `${n.data.name} · ${fmt(n.value, data.unit)}`, { size: f, weight: 650, maxW: bw - 8 });
    } else if (bw >= MIN_LABEL_W && bh >= f + 4) {
      const two = bh >= f * 2.7;
      txt(g, n.x0 + 5, n.y0 + f * 0.85 + 2, n.data.name, { size: f, weight: 600, maxW: bw - 9 });
      if (two) sub(txt(g, n.x0 + 5, n.y0 + f * 2.05 + 3, fmt(n.value, data.unit), { size: f, maxW: bw - 9 }));
    }
  }
}

// ---- sunburst ----------------------------------------------------------------------------------------------------------------------
function ringLabel(g, n, geo, f, t) {
  const { cx, cy, inner, outer } = geo;
  const rm = (inner + outer) / 2;
  const thick = outer - inner;
  const arcLen = (n.x1 - n.x0) * rm;
  const tang = thick >= f + 2 ? arcLen * 0.9 : 0;
  const rad = arcLen >= f + 3 ? thick - 8 : 0;
  const room = Math.max(tang, rad);
  if (room < MIN_ARC_LABEL_W) return;
  const th = (n.x0 + n.x1) / 2;
  const down = Math.cos(th) < 0;
  const left = th > Math.PI;
  const deg = tang >= rad ? th * DEG + (down ? 180 : 0) : th * DEG - 90 + (left ? 180 : 0);
  const withPct = `${n.data.name} ${pctOf(n.value, t.total)}`;
  const text = textWidth(withPct, f, 600) <= room ? withPct : n.data.name;
  const x = cx + rm * Math.sin(th);
  const y = cy - rm * Math.cos(th);
  const el = txt(g, 0, 0, text, { size: f, weight: 600, anchor: 'middle', maxW: room });
  el.setAttribute('transform', `translate(${x.toFixed(1)},${y.toFixed(1)}) rotate(${deg.toFixed(1)})`);
  el.style.pointerEvents = 'none';
}

function legend(svg, t, unit, x, w, h, fs) {
  const f = labelFs(fs);
  const rowH = f * LEGEND_ROW;
  const fit = Math.max(1, Math.floor(h / rowH) - 1);
  const rows = t.top.slice(0, fit);
  const y0 = (h - rows.length * rowH) / 2;
  rows.forEach((n, i) => {
    const y = y0 + i * rowH + rowH / 2;
    svg.append(s('rect', { x, y: y - SWATCH / 2, width: SWATCH, height: SWATCH, rx: 3, fill: catColor(i) }));
    const val = `${fmt(n.value, unit)} · ${pctOf(n.value, t.total)}`;
    const vw = textWidth(val, f);
    txt(svg, x + SWATCH + 8, y, n.data.name, { size: f, weight: 600, maxW: w - SWATCH - vw - 22 });
    txt(svg, x + w, y, val, { size: f, anchor: 'end', cls: 'pa-m' });
  });
  if (rows.length < t.top.length) txt(svg, x, y0 + rows.length * rowH + rowH / 2, `+${t.top.length - rows.length} more`, { size: f, cls: 'pa-m' });
}

function drawSunburst({ data, svg, w, h, fs, narrow }) {
  const t = build(data);
  if (!t) return empty(svg, w, h, fs);
  const f = labelFs(fs);
  const legendW = !narrow && w - h >= LEGEND_EXTRA_MIN ? Math.min(LEGEND_MAX_W, w * LEGEND_FRAC) : 0;
  const R = Math.min(w - legendW, h) / 2 - 6;
  const cx = (w - legendW) / 2;
  const cy = h / 2;
  const r0 = R * CENTER_FRAC;
  const th = (R - r0) / t.root.height;
  d3.partition().size([FULL_TURN, 1])(t.root);
  const arc = d3.arc();
  const labelled = narrow ? NARROW_RINGS : Infinity;
  const todo = [];
  for (const n of t.root.descendants()) {
    if (n.depth === 0) continue;
    const geo = { cx, cy, inner: r0 + (n.depth - 1) * th, outer: r0 + n.depth * th - ARC_GAP };
    const c = colorOf(n, t.top);
    const path = s('path', { d: arc({ startAngle: n.x0, endAngle: n.x1, innerRadius: geo.inner, outerRadius: geo.outer, padAngle: ARC_GAP / Math.max(geo.outer, 1) }), transform: `translate(${cx},${cy})`, fill: soft(c, depthPct(n.depth)), stroke: 'var(--ui-card)', 'stroke-width': 1, class: 'pa-in' });
    svg.append(hover(path, n, t, data.unit));
    if (n.depth <= labelled) todo.push([n, geo]);
  }
  const labels = svg.appendChild(s('g')); // after the arcs so the text sits on top
  for (const [n, geo] of todo) ringLabel(labels, n, geo, f, t);
  txt(svg, cx, cy - f * 0.6, t.root.data.name, { size: f, weight: 700, anchor: 'middle', maxW: r0 * 1.7 });
  txt(svg, cx, cy + f * 0.75, fmt(t.total, data.unit), { size: f, anchor: 'middle', cls: 'pa-m', maxW: r0 * 1.7 });
  if (legendW) legend(svg, t, data.unit, w - legendW + 8, legendW - 8, h, fs);
}

// ---- icicle ------------------------------------------------------------------------------------------------------------------------
function drawIcicle({ data, svg, w, h, fs }) {
  const t = build(data);
  if (!t) return empty(svg, w, h, fs);
  const f = labelFs(fs);
  const colW = w / (t.root.height + 1);
  d3.partition().size([h, 1])(t.root);
  for (const n of t.root.descendants()) {
    const x = n.depth * colW;
    const bw = (n.children ? colW : w - x) - ARC_GAP; // leaves run to the right edge: more room for long names
    const bh = n.x1 - n.x0 - ARC_GAP;
    if (bh < 0.5) continue;
    const c = colorOf(n, t.top);
    const fill = n.depth === 0 ? soft(c, ROOT_TINT_PCT) : soft(c, depthPct(n.depth));
    const g = svg.appendChild(s('g', { class: 'pa-in' }));
    g.append(hover(s('rect', { x, y: n.x0, width: bw, height: bh, rx: 2, fill }), n, t, data.unit));
    if (bh < f + 3 || bw < MIN_ARC_LABEL_W) continue;
    const val = n.depth === 0 ? fmt(t.total, data.unit) : `${fmt(n.value, data.unit)} · ${pctOf(n.value, t.total)}`;
    const room = bw - 10;
    if (bh >= f * 2.6) {
      txt(g, x + 6, n.x0 + bh / 2 - f * 0.6, n.data.name, { size: f, weight: 650, maxW: room });
      sub(txt(g, x + 6, n.x0 + bh / 2 + f * 0.65, val, { size: f, maxW: room }));
    } else {
      const left = Math.max(0, room - textWidth(` ${val}`, f) - 4);
      const name = ellipsize(n.data.name, left > MIN_ARC_LABEL_W ? left : room, f, 650);
      txt(g, x + 6, n.x0 + bh / 2, left > MIN_ARC_LABEL_W && name ? `${name} ${val}` : name, { size: f, weight: 650, maxW: room });
    }
  }
}

// ---- definitions -------------------------------------------------------------------------------------------------------------------
const leaf = (name, value) => ({ name, value });
const SAMPLE = {
  unit: 'k tok',
  root: {
    name: 'Session',
    children: [
      { name: 'Reading', children: [{ name: 'web/kit', children: [leaf('core.js', 12), leaf('flow.js', 9), leaf('layout.js', 4)] }, { name: 'hooks', children: [leaf('board-frames.ts', 18)] }, leaf('tests', 7)] },
      { name: 'Editing', children: [leaf('hierarchy.js', 14), leaf('filetree.js', 11), leaf('venn.js', 8), leaf('index.js', 3)] },
      { name: 'Tool output', children: [leaf('build log', 15), leaf('test run', 10), leaf('grep', 6)] },
      { name: 'Thinking', children: [leaf('planning', 12), leaf('review', 7)] },
    ],
  },
};
const KEYS = ['unit', 'root'];
const base = { keys: KEYS, sample: SAMPLE, validate: validateTree };

export const treemap = defineAsset({
  ...base,
  kind: 'treemap',
  shape: 'part of a whole with nested groups (which area / file / agent used most of the tokens, time or lines)',
  summary: 'Nested boxes, area = share of the total; group names as header strips, colour per top-level group, lighter when deeper. Best for comparing many sizes at once.',
  aspect: 0.66,
  minH: 280,
  draw: drawTreemap,
});

export const sunburst = defineAsset({
  ...base,
  kind: 'sunburst',
  shape: 'part of a whole read from the centre out (what the whole is made of, then what each part is made of)',
  summary: 'Concentric rings from the total in the middle; arc angle = share, colour per top-level group. A legend lists the top-level parts when there is room.',
  aspect: 0.72,
  minH: 300,
  maxH: 560,
  draw: drawSunburst,
});

export const icicle = defineAsset({
  ...base,
  kind: 'icicle',
  shape: 'part of a whole with long names or narrow space (a tree as stacked bars, depth running left to right)',
  summary: 'Columns per level, bars stacked by share; leaves extend to the right edge so long names fit. Reads like an outline with sizes.',
  aspect: 0.6,
  minH: 260,
  draw: drawIcicle,
});
