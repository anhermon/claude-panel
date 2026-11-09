// compare.js - comparing things on several measures: `radar` (profiles over many axes), `dumbbell` (before -> after per item),
// `multiples` (one small chart per item, same shape, side by side). Also exports the row/axis helpers the uncertainty assets reuse.
import { AssetError, check, each, numbers, defineAsset, s, txt, tip, catColor, toneColor, soft, textWidth, fmt, clamp } from './core.js';
import { niceStep } from '../ui/pure.js';

const AXIS_FS = 0.95;
const TICK_GAP_PX = 74;
const TICK_LABEL_GAP = 8;
const TICKS_MIN = 2;
const TICKS_MAX = 6;
const LEGEND_SW = 10;
const LEGEND_GAP = 14;
const RING_COUNT = 4;
const RADAR_MIN_R = 40;
const DOT_R = 4;
const LABEL_SHARE = 0.34;
const LABEL_MIN_PX = 54;
const MULTI_MIN_CELL = 150;
const MULTI_GAP = 10;

// ---- helpers shared with uncertainty.js -----------------------------------------------------------------------------------------
/** Nice axis bounds around [lo, hi]: {lo, hi, ticks}. */
export function niceTicks(lo, hi, count) {
  const span = hi - lo || Math.abs(hi) || 1;
  const step = niceStep(span / Math.max(1, count));
  const a = Math.floor(lo / step + 1e-9) * step;
  const b = Math.max(Math.ceil(hi / step - 1e-9) * step, a + step);
  const ticks = [];
  for (let v = a; v <= b + step * 1e-6; v += step) ticks.push(Math.round(v / step) * step);
  return { lo: a, hi: b, ticks };
}
/** Sets the stage to `hh` px (not when the frame fills its parent). */
export function fitHeight(ctx, hh) {
  if (ctx.fill) return ctx.h;
  ctx.svg.setAttribute('viewBox', `0 0 ${ctx.w} ${hh}`);
  ctx.svg.setAttribute('height', hh);
  ctx.root.style.height = `${hh}px`;
  return hh;
}
/** Height for `n` rows: the natural pitch of the box, kept between `minP` and `maxP`; `chrome` px stay for headers and axes. Returns {hh, pitch}. */
export function rowLayout(ctx, n, minP, maxP, chrome) {
  const pitch = clamp((ctx.h - chrome) / n, minP, maxP);
  const hh = fitHeight(ctx, ctx.fill ? ctx.h : Math.ceil(n * pitch + chrome));
  return { hh, pitch: ctx.fill ? clamp((hh - chrome) / n, 1, maxP) : pitch };
}
/** Widest label in px, capped to `share` of the width, never below `LABEL_MIN_PX`. */
export function labelColumn(labels, fs, w, weight = 500, share = LABEL_SHARE) {
  return clamp(Math.max(...labels.map((l) => textWidth(l, fs, weight))), LABEL_MIN_PX, Math.max(LABEL_MIN_PX, w * share)) + 8;
}
/** Vertical gridlines + tick labels along the bottom of a horizontal value axis. Returns the x scale. */
export function drawHAxis(svg, { x0, x1, top, bottom, lo, hi, fs, unit }) {
  const { lo: a, hi: b, ticks } = niceTicks(lo, hi, clamp(Math.floor((x1 - x0) / TICK_GAP_PX), TICKS_MIN, TICKS_MAX));
  const x = (v) => x0 + ((v - a) / (b - a)) * (x1 - x0);
  const size = fs * AXIS_FS;
  const last = ticks.length - 1;
  const lastW = textWidth(fmt(ticks[last], unit), size);
  let edge = -Infinity; // right edge of the last label drawn: a label that would touch it (or the final one) is skipped, its gridline stays
  ticks.forEach((t, i) => {
    svg.append(s('line', { x1: x(t), x2: x(t), y1: top, y2: bottom, class: 'pa-grid' }));
    const text = fmt(t, i === last ? unit : '');
    const tw = textWidth(text, size);
    const left = i === 0 ? x(t) : i === last ? x(t) - tw : x(t) - tw / 2;
    if (i !== last && i !== 0 && (left < edge + TICK_LABEL_GAP || x(t) + tw / 2 > x(ticks[last]) - lastW - TICK_LABEL_GAP)) return;
    edge = left + tw;
    txt(svg, x(t), bottom + fs * 0.9, text, { size, anchor: i === 0 ? 'start' : i === last ? 'end' : 'middle', cls: 'pa-m', baseline: 'hanging' });
  });
  return x;
}

// ---- radar --------------------------------------------------------------------------------------------------------------------------
const AXES_MAX = 8;
function validateRadar(d) {
  check.object(d, 'data', ['unit', 'axes', 'series']);
  const keys = new Set();
  const axes = each(d.axes, 'data.axes', { min: 3, max: AXES_MAX }, (a, p) => {
    check.object(a, p, ['key', 'label', 'max']);
    return { key: check.id(a.key, `${p}.key`, keys), label: check.string(a.label, `${p}.label`, { max: 28 }), max: check.number(a.max, `${p}.max`, { min: 0, optional: true }) };
  });
  const series = each(d.series, 'data.series', { max: 4 }, (r, p) => {
    check.object(r, p, ['name', 'values', 'tone']);
    let values;
    if (Array.isArray(r.values)) values = numbers(r.values, `${p}.values`, { min: axes.length, max: axes.length });
    else {
      check.object(r.values, `${p}.values`, axes.map((a) => a.key));
      values = axes.map((a) => check.number(r.values[a.key], `${p}.values.${a.key}`));
    }
    return { name: check.string(r.name, `${p}.name`, { max: 28 }), values, tone: check.tone(r.tone, `${p}.tone`) };
  });
  return { unit: check.string(d.unit, 'data.unit', { max: 12, optional: true }), axes, series };
}

function legendRows(items, fs, w) {
  const rows = [[]];
  let x = 0;
  for (const it of items) {
    const iw = LEGEND_SW + 6 + textWidth(it.label, fs, 600);
    if (x && x + iw > w) { rows.push([]); x = 0; }
    rows.at(-1).push({ ...it, x, iw });
    x += iw + LEGEND_GAP;
  }
  return rows;
}

function drawRadar({ data, svg, w, h, fs, narrow }) {
  const colors = data.series.map((r, i) => (r.tone ? toneColor(r.tone) : catColor(i)));
  const rows = legendRows(data.series.map((r, i) => ({ label: r.name, color: colors[i] })), fs, w);
  const legendH = rows.length * fs * 1.5 + 4;
  const n = data.axes.length;
  const labelFs = fs * AXIS_FS;
  const wide = Math.min(Math.max(...data.axes.map((a) => textWidth(a.label, labelFs, 600))), narrow ? w * 0.26 : w * 0.3);
  const cx = w / 2;
  const cy = (h - legendH) / 2;
  const r = Math.max(RADAR_MIN_R, Math.min(cx - wide - 10, cy - labelFs * 1.6));
  const maxes = data.axes.map((a, i) => a.max ?? (Math.max(...data.series.map((x) => x.values[i]), 0) || 1));
  const ang = (i) => (i / n) * 2 * Math.PI - Math.PI / 2;
  const pt = (i, f) => [cx + Math.cos(ang(i)) * r * f, cy + Math.sin(ang(i)) * r * f];
  for (let k = 1; k <= RING_COUNT; k++) svg.append(s('polygon', { points: data.axes.map((_, i) => pt(i, k / RING_COUNT).join(',')).join(' '), class: 'pa-grid' }));
  data.axes.forEach((a, i) => {
    const [ex, ey] = pt(i, 1);
    svg.append(s('line', { x1: cx, y1: cy, x2: ex, y2: ey, class: 'pa-grid' }));
    const cos = Math.cos(ang(i));
    const sin = Math.sin(ang(i));
    const anchor = cos > 0.3 ? 'start' : cos < -0.3 ? 'end' : 'middle';
    const lx = cx + cos * (r + 8);
    const room = anchor === 'middle' ? w * 0.4 : anchor === 'start' ? w - lx - 2 : lx - 2;
    txt(svg, lx, cy + sin * (r + 8) + (Math.abs(sin) > 0.7 ? sin * labelFs * 0.7 : 0), a.label, { size: labelFs, anchor, maxW: Math.max(40, room), cls: 'pa-t', weight: 600 });
  });
  // ring values on the first axis (up), so the scale is readable without a key
  for (let k = 1; k <= RING_COUNT; k++) {
    const [tx, ty] = pt(0, k / RING_COUNT);
    txt(svg, tx + 4, ty, fmt((maxes[0] * k) / RING_COUNT, k === RING_COUNT ? data.unit : ''), { size: labelFs, cls: 'pa-d pa-halo' });
  }
  data.series.forEach((ser, k) => {
    const pts = ser.values.map((v, i) => pt(i, clamp(v / maxes[i], 0, 1)));
    svg.append(s('polygon', { points: pts.map((p) => p.join(',')).join(' '), fill: soft(colors[k], 22), stroke: colors[k], 'stroke-width': 2, 'stroke-linejoin': 'round', class: 'pa-in' }));
    pts.forEach(([x, y], i) => svg.append(tip(s('circle', { cx: x, cy: y, r: DOT_R, fill: colors[k], stroke: 'var(--ui-card)', 'stroke-width': 1.5 }), `${ser.name} - ${data.axes[i].label}: ${fmt(ser.values[i], data.unit)}`)));
  });
  rows.forEach((row, ri) => {
    const total = row.reduce((a, it, i) => a + it.iw + (i ? LEGEND_GAP : 0), 0);
    let x = (w - total) / 2;
    const y = h - legendH + ri * fs * 1.5 + fs * 0.8;
    for (const it of row) {
      svg.append(s('rect', { x, y: y - LEGEND_SW / 2, width: LEGEND_SW, height: LEGEND_SW, rx: 2, fill: it.color }));
      txt(svg, x + LEGEND_SW + 6, y, it.label, { size: fs, cls: 'pa-t', weight: 600 });
      x += it.iw + LEGEND_GAP;
    }
  });
}

export const radar = defineAsset({
  kind: 'radar',
  shape: 'a profile over 3-8 measures, compared between 1-4 candidates (which is stronger where)',
  summary: 'Axes spoke out from the centre, one polygon per candidate, each axis scaled to its own max; for scoring options on the same criteria. Not for exact values: use dumbbell or matrix.',
  keys: ['unit', 'axes', 'series'],
  aspect: 0.95,
  minH: 280,
  maxH: 560,
  sample: {
    axes: [{ key: 'speed', label: 'Speed', max: 10 }, { key: 'cost', label: 'Low cost', max: 10 }, { key: 'quality', label: 'Quality', max: 10 }, { key: 'rel', label: 'Reliability', max: 10 }, { key: 'reach', label: 'Reach', max: 10 }, { key: 'ease', label: 'Ease', max: 10 }],
    series: [{ name: 'Agent A', values: { speed: 8, cost: 5, quality: 7, rel: 9, reach: 4, ease: 6 } }, { name: 'Agent B', values: [5, 8, 9, 5, 7, 8] }],
  },
  validate: validateRadar,
  draw: drawRadar,
});

// ---- dumbbell -------------------------------------------------------------------------------------------------------------------------
const GOOD_WHEN = ['up', 'down'];
function validateDumbbell(d) {
  check.object(d, 'data', ['unit', 'goodWhen', 'fromLabel', 'toLabel', 'items']);
  const items = each(d.items, 'data.items', { max: 14 }, (r, p) => {
    check.object(r, p, ['label', 'from', 'to', 'note']);
    return { label: check.string(r.label, `${p}.label`, { max: 40 }), from: check.number(r.from, `${p}.from`, { optional: true }), to: check.number(r.to, `${p}.to`), note: check.string(r.note, `${p}.note`, { max: 80, optional: true }) };
  });
  return {
    items, unit: check.string(d.unit, 'data.unit', { max: 12, optional: true }), goodWhen: check.oneOf(d.goodWhen, 'data.goodWhen', GOOD_WHEN, { optional: true }),
    fromLabel: check.string(d.fromLabel, 'data.fromLabel', { max: 20, optional: true }) ?? 'Before', toLabel: check.string(d.toLabel, 'data.toLabel', { max: 20, optional: true }) ?? 'After',
  };
}

function drawDumbbell(ctx) {
  const { data, svg, w, fs } = ctx;
  const sorted = [...data.items].sort((a, b) => (b.to - (b.from ?? b.to)) - (a.to - (a.from ?? a.to)));
  const head = fs * 1.8;
  const axisH = fs * 2;
  const { hh, pitch } = rowLayout(ctx, sorted.length, fs * 1.9, fs * 2.8, head + axisH);
  const labW = labelColumn(sorted.map((r) => r.label), fs, w);
  const small = fs * AXIS_FS;
  const valW = textWidth(fmt(Math.max(...sorted.flatMap((r) => [Math.abs(r.from ?? 0), Math.abs(r.to)])), data.unit), small, 600) + 8;
  const x0 = labW + valW;
  const x1 = w - valW - 4;
  const vals = sorted.flatMap((r) => [r.from ?? 0, r.to]);
  const x = drawHAxis(svg, { x0, x1, top: head, bottom: hh - axisH, lo: Math.min(...vals), hi: Math.max(...vals), fs, unit: data.unit });
  const verdict = (r) => (!data.goodWhen || r.from === undefined || r.to === r.from ? 'var(--ui-acc)' : (r.to > r.from) === (data.goodWhen === 'up') ? 'var(--ui-ok)' : 'var(--ui-danger)');
  svg.append(s('circle', { cx: 6, cy: head / 2, r: 5, fill: 'var(--ui-card)', stroke: 'var(--ui-mut)', 'stroke-width': 2 }));
  txt(svg, 16, head / 2, data.fromLabel, { size: small, cls: 'pa-m', weight: 600 });
  const lx = 16 + textWidth(data.fromLabel, small, 600) + 16;
  svg.append(s('circle', { cx: lx, cy: head / 2, r: 5, fill: 'var(--ui-acc)' }));
  txt(svg, lx + 10, head / 2, data.toLabel, { size: small, cls: 'pa-m', weight: 600 });
  sorted.forEach((r, i) => {
    const y = head + pitch * (i + 0.5);
    const c = verdict(r);
    const hasFrom = r.from !== undefined;
    const up = r.to >= (r.from ?? 0);
    const xa = hasFrom ? x(r.from) : x(0);
    const xb = x(r.to);
    txt(svg, labW - 8, y, r.label, { size: fs, anchor: 'end', maxW: labW - 8, cls: 'pa-t' });
    const delta = hasFrom ? ` (${r.to - r.from >= 0 ? '+' : ''}${fmt(r.to - r.from, data.unit)})` : '';
    svg.append(tip(s('line', { x1: xa, x2: xb, y1: y, y2: y, stroke: soft(c, 55), 'stroke-width': hasFrom ? 4 : 2, 'stroke-linecap': 'round', class: 'pa-in' }), `${r.label}: ${hasFrom ? `${fmt(r.from, data.unit)} -> ` : ''}${fmt(r.to, data.unit)}${delta}${r.note ? ` - ${r.note}` : ''}`));
    if (hasFrom) {
      svg.append(s('circle', { cx: xa, cy: y, r: DOT_R + 1, fill: 'var(--ui-card)', stroke: 'var(--ui-mut)', 'stroke-width': 2 }));
      txt(svg, xa + (up ? -1 : 1) * (DOT_R + 7), y, fmt(r.from, data.unit), { size: small, anchor: up ? 'end' : 'start', cls: 'pa-m pa-halo' });
    }
    svg.append(s('circle', { cx: xb, cy: y, r: DOT_R + 1, fill: c }));
    txt(svg, xb + (up ? 1 : -1) * (DOT_R + 7), y, fmt(r.to, data.unit), { size: small, anchor: up ? 'start' : 'end', cls: 'pa-b pa-halo' });
  });
}

export const dumbbell = defineAsset({
  kind: 'dumbbell',
  shape: 'one measure per item, two moments or two groups (before -> after, plan vs actual); the gap is the point',
  summary: 'A row per item: hollow dot = start, filled dot = end, a bar between; green/red when goodWhen says which way is better. An item with no `from` is a lollipop.',
  keys: ['unit', 'goodWhen', 'fromLabel', 'toLabel', 'items'],
  aspect: 0.6,
  minH: 200,
  sample: {
    unit: 'ms', goodWhen: 'down', fromLabel: 'Before', toLabel: 'After',
    items: [{ label: 'Cold start', from: 920, to: 410 }, { label: 'Render', from: 310, to: 180 }, { label: 'Search', from: 540, to: 260 }, { label: 'Export', from: 700, to: 760 }, { label: 'Sync', from: 450, to: 300 }],
  },
  validate: validateDumbbell,
  draw: drawDumbbell,
});

// ---- multiples --------------------------------------------------------------------------------------------------------------------------
const MULTI_KINDS = ['line', 'area', 'bars'];
function validateMultiples(d) {
  check.object(d, 'data', ['unit', 'kind', 'shared', 'panels']);
  const panels = each(d.panels, 'data.panels', { max: 12 }, (it, p) => {
    check.object(it, p, ['label', 'values', 'tone', 'note']);
    return { label: check.string(it.label, `${p}.label`, { max: 32 }), values: numbers(it.values, `${p}.values`, { min: 2, max: 60 }), tone: check.tone(it.tone, `${p}.tone`), note: check.string(it.note, `${p}.note`, { max: 80, optional: true }) };
  });
  return { panels, unit: check.string(d.unit, 'data.unit', { max: 12, optional: true }), kind: check.oneOf(d.kind, 'data.kind', MULTI_KINDS, { optional: true }) ?? 'area', shared: check.bool(d.shared, 'data.shared') ?? true };
}

function drawMultiples(ctx) {
  const { data, svg, w, fs } = ctx;
  const cols = Math.max(1, Math.floor((w + MULTI_GAP) / (MULTI_MIN_CELL + MULTI_GAP)));
  const cw = (w - MULTI_GAP * (cols - 1)) / cols;
  const nrows = Math.ceil(data.panels.length / cols);
  const small = fs * AXIS_FS;
  const ch = fs * 6.8;
  fitHeight(ctx, ctx.fill ? ctx.h : nrows * ch + (nrows - 1) * MULTI_GAP + 2);
  const all = data.panels.flatMap((i) => i.values);
  const padX = 10;
  data.panels.forEach((it, k) => {
    const g = svg.appendChild(s('g', { transform: `translate(${(k % cols) * (cw + MULTI_GAP)},${Math.floor(k / cols) * (ch + MULTI_GAP)})` }));
    const c = it.tone ? toneColor(it.tone) : catColor(k);
    g.append(s('rect', { width: cw, height: ch, rx: 8, fill: soft(c, 6), stroke: 'var(--ui-line)' }));
    const n = it.values.length;
    const last = it.values[n - 1];
    const val = fmt(last, data.unit);
    txt(g, cw - padX, fs * 1.1, val, { size: fs * 1.15, anchor: 'end', cls: 'pa-b' });
    txt(g, padX, fs * 1.1, it.label, { size: small, maxW: cw - 2 * padX - textWidth(val, fs * 1.15, 700) - 6, cls: 'pa-m', weight: 600 });
    const lo = data.shared ? Math.min(0, ...all) : Math.min(0, ...it.values);
    const hi = data.shared ? Math.max(...all) : Math.max(...it.values);
    const top = fs * 3.3;
    const bottom = ch - fs * 1.5;
    const xs = (i) => padX + (n === 1 ? 0.5 : i / (n - 1)) * (cw - 2 * padX);
    const ys = (v) => (hi === lo ? (top + bottom) / 2 : bottom - ((v - lo) / (hi - lo)) * (bottom - top));
    const hint = `${it.label}: ${fmt(it.values[0], data.unit)} -> ${val}${it.note ? ` - ${it.note}` : ''}`;
    if (data.kind === 'bars') {
      const bw = Math.max(1, ((cw - 2 * padX) / n) * 0.7);
      it.values.forEach((v, i) => g.append(s('rect', { x: xs(i) - bw / 2, y: Math.min(ys(v), ys(0)), width: bw, height: Math.max(1, Math.abs(ys(v) - ys(0))), fill: i === n - 1 ? c : soft(c, 55) })));
      g.append(tip(s('rect', { width: cw, height: ch, fill: 'none', 'pointer-events': 'all' }), hint));
    } else {
      const d = it.values.map((v, i) => `${i ? 'L' : 'M'}${xs(i).toFixed(1)},${ys(v).toFixed(1)}`).join('');
      if (data.kind === 'area') g.append(s('path', { d: `${d}L${xs(n - 1)},${ys(lo)}L${xs(0)},${ys(lo)}Z`, fill: soft(c, 16) }));
      g.append(tip(s('path', { d, fill: 'none', stroke: c, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', class: 'pa-in' }), hint));
    }
    // min and max marked with dots and labels so the range reads without an axis
    const iMax = it.values.indexOf(Math.max(...it.values));
    const iMin = it.values.indexOf(Math.min(...it.values));
    for (const [i, above] of [[iMax, true], [iMin, false]]) {
      if (iMax === iMin && !above) continue;
      const near = Math.abs(xs(i) - xs(n - 1)) < textWidth(fmt(it.values[i], data.unit), small) + 12 && i !== n - 1;
      g.append(s('circle', { cx: xs(i), cy: ys(it.values[i]), r: 3, fill: i === n - 1 ? c : 'var(--ui-card)', stroke: c, 'stroke-width': 1.5 }));
      if (!near && i !== n - 1) txt(g, clamp(xs(i), padX + 14, cw - padX - 14), ys(it.values[i]) + (above ? -small * 0.9 : small * 0.95), fmt(it.values[i], data.unit), { size: small, anchor: 'middle', cls: 'pa-d pa-halo' });
    }
    g.append(s('circle', { cx: xs(n - 1), cy: ys(last), r: 3.5, fill: c }));
  });
}

export const multiples = defineAsset({
  kind: 'multiples',
  shape: 'the same measure for many items (services, files, repos); the shape of each trend, side by side',
  summary: 'A grid of small self-contained charts with the latest value and min/max dots. Pick it over one crowded multi-line chart; shared scale by default so sizes compare.',
  keys: ['unit', 'kind', 'shared', 'panels'],
  aspect: 0.5,
  minH: 160,
  sample: {
    unit: '%', kind: 'area',
    panels: [
      { label: 'api', values: [62, 64, 61, 70, 74, 73, 80, 86] }, { label: 'web', values: [40, 42, 41, 39, 44, 43, 41, 42] }, { label: 'worker', values: [90, 85, 80, 70, 66, 61, 58, 50], tone: 'ok' },
      { label: 'db', values: [30, 35, 33, 48, 52, 60, 71, 88], tone: 'danger' }, { label: 'cache', values: [55, 56, 58, 57, 60, 59, 61, 62] }, { label: 'queue', values: [10, 12, 30, 22, 18, 14, 12, 11] },
    ],
  },
  validate: validateMultiples,
  draw: drawMultiples,
});
