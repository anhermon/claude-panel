// dial.js - a value against thresholds: `dial` (one reading on a semicircle with coloured bands and a needle) and `thermo`
// (several readings as thermometer tubes on a shared scale). Own look, not the ui gauge.
import { AssetError, check, each, defineAsset, s, txt, tip, toneColor, soft, textWidth, fmt, clamp, TONES } from './core.js';
import { arcPath } from '../ui/pure.js';
import { fitHeight } from './compare.js';

const SMALL = 0.95;
const SWEEP_DEG = 180;
const START_DEG = -90; // arcPath: 0 = 12 o'clock, clockwise; -90 is the left end
const RING_FRAC = 0.2; // ring thickness as a share of the radius
const MAX_BANDS = 6;
const MAX_TUBES = 6;
const TUBE_W = 26;
const BULB_R = 22;
const TUBE_CELL_MIN_W = 88; // a tube, its band edges and a label need about this much
const TUBE_CELL_K = 14; // cell height in font sizes: a tall tube reads as a thermometer
const BAND_FILL_PCT = 80;
const TUBE_BG_PCT = 28;

function validateBands(list, path) {
  let prev = -Infinity;
  return each(list, path, { max: MAX_BANDS }, (b, p) => {
    check.object(b, p, ['to', 'tone', 'label']);
    const to = check.number(b.to, `${p}.to`);
    if (to <= prev) throw new AssetError(`${p}.to (${to}) must be above the previous band (${prev}): list bands in ascending order`);
    prev = to;
    return { to, tone: check.oneOf(b.tone, `${p}.tone`, TONES), label: check.string(b.label, `${p}.label`, { max: 16, optional: true }) };
  });
}
const toneAt = (bands, v) => (bands.find((b) => v <= b.to) ?? bands.at(-1))?.tone;
const frac = (v, lo, hi) => clamp((v - lo) / (hi - lo), 0, 1);

// ---- dial ----------------------------------------------------------------------------------------------------------------------------------
function validateDial(d) {
  check.object(d, 'data', ['label', 'unit', 'min', 'max', 'value', 'target', 'bands']);
  const min = check.number(d.min, 'data.min');
  const max = check.number(d.max, 'data.max');
  if (max <= min) throw new AssetError(`data.max (${max}) must be above data.min (${min})`);
  const bands = validateBands(d.bands, 'data.bands');
  if (bands.at(-1).to < max) throw new AssetError(`data.bands: the last band must reach data.max (${max}), it ends at ${bands.at(-1).to}`);
  return {
    label: check.string(d.label, 'data.label', { max: 40 }), unit: check.string(d.unit, 'data.unit', { max: 12, optional: true }), min, max,
    value: check.number(d.value, 'data.value'), target: check.number(d.target, 'data.target', { optional: true }), bands,
  };
}

function drawDial({ data, svg, w, h, fs }) {
  const small = fs * SMALL;
  const labelPad = textWidth(fmt(data.max, data.unit), small) + 8;
  const bigFs = fs * 2.1;
  const r = Math.max(40, Math.min((w - 2 * labelPad) / 2, h - fs * 8.6 - 4));
  const cx = w / 2;
  const cy = r + fs * 3.4;
  const thick = r * RING_FRAC;
  const mid = r - thick / 2;
  const deg = (v) => START_DEG + frac(v, data.min, data.max) * SWEEP_DEG;
  const polar = (v, rad) => [cx + Math.sin((deg(v) * Math.PI) / 180) * rad, cy - Math.cos((deg(v) * Math.PI) / 180) * rad];
  let from = data.min;
  data.bands.forEach((b) => {
    const to = Math.min(b.to, data.max);
    svg.append(tip(s('path', { d: arcPath(cx, cy, mid, deg(from), deg(to)), fill: 'none', stroke: soft(toneColor(b.tone), BAND_FILL_PCT), 'stroke-width': thick, class: 'pa-in' }), `${b.label ?? b.tone}: up to ${fmt(b.to, data.unit)}`));
    if (to < data.max) {
      const [x0, y0] = polar(to, r - thick - 3);
      const [x1, y1] = polar(to, r + 4);
      svg.append(s('line', { x1: x0, y1: y0, x2: x1, y2: y1, stroke: 'var(--ui-card)', 'stroke-width': 2 }));
      const [tx, ty] = polar(to, r + small * 0.9 + 4);
      const cos = Math.sin((deg(to) * Math.PI) / 180);
      txt(svg, tx, ty, fmt(to), { size: small, anchor: Math.abs(cos) < 0.25 ? 'middle' : cos > 0 ? 'start' : 'end', cls: 'pa-m' });
    }
    from = to;
  });
  txt(svg, cx - r + thick / 2, cy + small * 1.2, fmt(data.min), { size: small, anchor: 'middle', cls: 'pa-m' });
  txt(svg, cx + r - thick / 2, cy + small * 1.2, fmt(data.max), { size: small, anchor: 'middle', cls: 'pa-m' });
  if (data.target !== undefined) {
    const [x0, y0] = polar(data.target, r - thick - 6);
    const [x1, y1] = polar(data.target, r + 8);
    svg.append(tip(s('line', { x1: x0, y1: y0, x2: x1, y2: y1, stroke: 'var(--ui-fg)', 'stroke-width': 3, 'stroke-linecap': 'round' }), `target ${fmt(data.target, data.unit)}`));
    const [tx, ty] = polar(data.target, r + small * 2.5 + 6);
    txt(svg, tx, ty, `target ${fmt(data.target)}`, { size: small, anchor: 'middle', cls: 'pa-m pa-halo', weight: 650 });
  }
  const [nx, ny] = polar(clamp(data.value, data.min, data.max), r - thick - 8);
  svg.append(s('line', { x1: cx, y1: cy, x2: nx, y2: ny, stroke: 'var(--ui-fg)', 'stroke-width': 4, 'stroke-linecap': 'round', class: 'pa-in' }));
  svg.append(s('circle', { cx, cy, r: 8, fill: 'var(--ui-fg)', stroke: 'var(--ui-card)', 'stroke-width': 2 }));
  txt(svg, cx, cy + fs * 2.3, fmt(data.value, data.unit), { size: bigFs, anchor: 'middle', cls: 'pa-b', baseline: 'middle' });
  txt(svg, cx, cy + fs * 2.3 + bigFs * 0.8 + 4, data.label, { size: fs, anchor: 'middle', cls: 'pa-m', maxW: w - 8, weight: 600, baseline: 'hanging' });
}

export const dial = defineAsset({
  kind: 'dial',
  shape: 'one reading against thresholds (budget used, coverage, error rate): is it fine, close, or past the line',
  summary: 'A semicircle ring split into coloured bands (the thresholds are written on it), a needle at the value, the value in big text and an optional target tick.',
  keys: ['label', 'unit', 'min', 'max', 'value', 'target', 'bands'],
  aspect: 0.7,
  minH: 220,
  maxH: 460,
  sample: {
    label: 'Context window used', unit: '%', min: 0, max: 100, value: 72, target: 60,
    bands: [{ to: 60, tone: 'ok', label: 'comfortable' }, { to: 85, tone: 'warn', label: 'compact soon' }, { to: 100, tone: 'danger', label: 'critical' }],
  },
  validate: validateDial,
  draw: drawDial,
});

// ---- thermo ---------------------------------------------------------------------------------------------------------------------------------
function validateThermo(d) {
  check.object(d, 'data', ['unit', 'min', 'max', 'items']);
  const min = check.number(d.min, 'data.min', { optional: true }) ?? 0;
  const max = check.number(d.max, 'data.max', { optional: true }) ?? 100;
  if (max <= min) throw new AssetError(`data.max (${max}) must be above data.min (${min})`);
  const items = each(d.items, 'data.items', { max: MAX_TUBES }, (it, p) => {
    check.object(it, p, ['label', 'value', 'bands', 'target']);
    return { label: check.string(it.label, `${p}.label`, { max: 24 }), value: check.number(it.value, `${p}.value`), bands: it.bands === undefined ? undefined : validateBands(it.bands, `${p}.bands`), target: check.number(it.target, `${p}.target`, { optional: true }) };
  });
  return { unit: check.string(d.unit, 'data.unit', { max: 12, optional: true }), min, max, items };
}

function drawThermo(ctx) {
  const { data, svg, w, fs } = ctx;
  const small = fs * SMALL;
  const per = Math.max(1, Math.min(data.items.length, Math.floor(w / TUBE_CELL_MIN_W)));
  const rows = Math.ceil(data.items.length / per);
  const cellH = ctx.fill ? ctx.h / rows : fs * TUBE_CELL_K;
  fitHeight(ctx, Math.ceil(cellH * rows));
  const colW = w / per;
  data.items.forEach((it, k) => {
    const cx = (k % per) * colW + colW / 2;
    const oy = Math.floor(k / per) * cellH;
    const top = oy + fs * 2.4;
    const bulbY = oy + cellH - fs * 2.4 - BULB_R;
    const tubeBottom = bulbY - BULB_R * 0.35;
    const y = (v) => tubeBottom - frac(v, data.min, data.max) * (tubeBottom - top);
    const tone = it.bands ? toneAt(it.bands, it.value) : undefined;
    const c = tone ? toneColor(tone) : 'var(--ui-acc)';
    const x0 = cx - TUBE_W / 2;
    const g = svg.appendChild(s('g'));
    g.append(s('rect', { x: x0, y: top, width: TUBE_W, height: tubeBottom - top + 4, rx: TUBE_W / 2, fill: 'var(--ui-card)', stroke: 'var(--ui-line-hi)', 'stroke-width': 2 }));
    let from = data.min;
    for (const b of it.bands ?? []) {
      const to = Math.min(b.to, data.max);
      g.append(s('rect', { x: cx + TUBE_W / 2 + 3, y: y(to), width: 5, height: Math.max(0, y(from) - y(to)), fill: soft(toneColor(b.tone), BAND_FILL_PCT), rx: 1 }));
      if (to < data.max) txt(g, cx + TUBE_W / 2 + 12, y(to), fmt(to), { size: small, cls: 'pa-d' });
      from = to;
    }
    g.append(tip(s('rect', { x: x0 + 5, y: y(it.value), width: TUBE_W - 10, height: Math.max(2, tubeBottom + 4 - y(it.value)), rx: (TUBE_W - 10) / 2, fill: c, class: 'pa-in' }), `${it.label}: ${fmt(it.value, data.unit)}`));
    g.append(s('circle', { cx, cy: bulbY, r: BULB_R, fill: c, stroke: 'var(--ui-card)', 'stroke-width': 3 }));
    if (it.target !== undefined) {
      g.append(s('line', { x1: x0 - 7, x2: x0 + TUBE_W + 7, y1: y(it.target), y2: y(it.target), stroke: 'var(--ui-fg)', 'stroke-width': 2.5, 'stroke-linecap': 'round' }));
      txt(g, x0 - 10, y(it.target), fmt(it.target), { size: small, anchor: 'end', cls: 'pa-m pa-halo', weight: 650 });
    }
    txt(g, cx, top - fs * 0.9, fmt(it.value, data.unit), { size: fs * 1.15, anchor: 'middle', cls: 'pa-b' });
    txt(g, cx, oy + cellH - fs * 1.2, it.label, { size: small, anchor: 'middle', cls: 'pa-t', maxW: colW - 8, weight: 600 });
  });
}

export const thermo = defineAsset({
  kind: 'thermo',
  shape: 'a few readings on one scale, each with its own thresholds (disk, memory, queue depth, error budget per service)',
  summary: 'Thermometer tubes side by side: fill level and bulb take the colour of the band the value is in; band edges are written beside the tube, a bar marks the target.',
  keys: ['unit', 'min', 'max', 'items'],
  aspect: 0.62,
  minH: 260,
  maxH: 480,
  sample: {
    unit: '%', min: 0, max: 100,
    items: [
      { label: 'Disk', value: 71, bands: [{ to: 70, tone: 'ok' }, { to: 90, tone: 'warn' }, { to: 100, tone: 'danger' }] },
      { label: 'Memory', value: 38, bands: [{ to: 70, tone: 'ok' }, { to: 90, tone: 'warn' }, { to: 100, tone: 'danger' }], target: 50 },
      { label: 'Queue', value: 93, bands: [{ to: 60, tone: 'ok' }, { to: 85, tone: 'warn' }, { to: 100, tone: 'danger' }] },
      { label: 'CPU', value: 55, bands: [{ to: 75, tone: 'ok' }, { to: 100, tone: 'warn' }] },
    ],
  },
  validate: validateThermo,
  draw: drawThermo,
});
