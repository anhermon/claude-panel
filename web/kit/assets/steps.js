// steps.js - where something got lost or added along a sequence: `funnel` (stages that only shrink; the drop between them is the point)
// and `waterfall` (a start value, signed steps, a computed total; what added and what took away).
import { AssetError, check, each, defineAsset, s, txt, tip, catColor, toneColor, soft, textWidth, ellipsize, fmt, clamp, px } from './core.js';

const MAX_STAGES = 8;
const MAX_STEPS = 12;
const MIN_BAR_FRAC = 0.02; // a stage with value 0 still shows a sliver so its row is visible
const ROW_MIN_EM = 2.8; // funnel row height floor, in font sizes (a bar plus a connector that can hold "-34%")
const BAR_SHARE = 0.62;
const LABEL_COL_MAX = 190;
const LABEL_COL_SHARE = 0.3;
const WF_NARROW_ROW_EM = 2.3;
const WF_GAP = 0.22; // gap between waterfall columns as a share of the column
const WF_LABEL_ROWS = 2;
const PCT_DECIMALS = 0;

const unitOf = (u, p) => (u === '' ? '' : check.string(u, p, { max: 12, optional: true }) ?? '');
const pct = (x) => `${(x * 100).toFixed(PCT_DECIMALS)}%`;
const signed = (v, unit) => `${v > 0 ? '+' : v < 0 ? '-' : ''}${fmt(Math.abs(v), unit)}`;

/** Grows the stage when the content needs more than the box (non-fill only); returns the usable height. */
function growTo(ctx, need) {
  if (ctx.fill || need <= ctx.h) return ctx.h;
  ctx.root.style.height = `${need}px`;
  ctx.svg.setAttribute('height', need);
  ctx.svg.setAttribute('viewBox', `0 0 ${ctx.w} ${need}`);
  return need;
}

// ---- funnel ---------------------------------------------------------------------------------------------------------------------
function validateFunnel(d) {
  check.object(d, 'data', ['unit', 'stages']);
  const stages = each(d.stages, 'data.stages', { min: 2, max: MAX_STAGES }, (st, p) => {
    check.object(st, p, ['label', 'value', 'note']);
    return { label: check.string(st.label, `${p}.label`, { max: 40 }), value: check.number(st.value, `${p}.value`, { min: 0 }), note: check.string(st.note, `${p}.note`, { max: 80, optional: true }) };
  });
  if (!(stages[0].value > 0)) throw new AssetError('data.stages[0].value must be above 0 (got 0): the first stage is the 100% reference');
  return { unit: unitOf(d.unit, 'data.unit'), stages };
}

function drawFunnel(ctx) {
  const { data, svg, w, fs, narrow } = ctx;
  const n = data.stages.length;
  const top = data.stages[0].value;
  const labelCol = narrow ? 0 : Math.min(LABEL_COL_MAX, w * LABEL_COL_SHARE);
  const x0 = labelCol + (narrow ? 4 : 8);
  const span = w - x0 - 4;
  const cx = x0 + span / 2;
  const rowH = Math.max(fs * ROW_MIN_EM + (narrow ? fs * 1.3 : 0), ctx.h / n);
  const H = growTo(ctx, rowH * n);
  const rh = Math.max(rowH, H / n);
  const barH = rh * BAR_SHARE - (narrow ? fs * 0.8 : 0);
  const widthOf = (v) => Math.max(span * MIN_BAR_FRAC, (span * v) / top);
  data.stages.forEach((st, i) => {
    const bw = widthOf(st.value);
    const y = i * rh + (narrow ? fs * 1.4 : (rh * (1 - BAR_SHARE)) / 4);
    const by = y;
    const color = catColor(i);
    const share = st.value / top;
    const note = `${st.label}: ${fmt(st.value, data.unit)} (${pct(share)} of ${data.stages[0].label})${st.note ? ` - ${st.note}` : ''}`;
    const prevV = i > 0 ? data.stages[i - 1].value : 0;
    const drop = prevV > 0 ? (st.value - prevV) / prevV : 0;
    const dropText = drop < 0 ? (drop > -0.005 ? '-<1%' : `-${pct(-drop)}`) : '';
    if (i > 0 && !narrow) {
      const prev = widthOf(data.stages[i - 1].value);
      const gapTop = (i - 1) * rh + (narrow ? fs * 1.4 : (rh * (1 - BAR_SHARE)) / 4) + barH;
      svg.append(s('path', { d: `M${cx - prev / 2},${gapTop} L${cx + prev / 2},${gapTop} L${cx + bw / 2},${by} L${cx - bw / 2},${by} Z`, fill: soft(color, 22) }));
      const midY = (gapTop + by) / 2;
      if (by - gapTop >= px.min + 2 && dropText) txt(svg, cx, midY, dropText, { size: Math.max(px.min, fs * 0.9), anchor: 'middle', weight: 650, fill: toneColor('danger'), cls: 'pa-halo' });
    }
    svg.append(tip(s('rect', { x: cx - bw / 2, y: by, width: bw, height: barH, rx: 4, fill: color, 'fill-opacity': 0.9, class: 'pa-in' }), note));
    const value = `${fmt(st.value, data.unit)}  ${pct(share)}`;
    if (narrow) {
      txt(svg, 4, y - fs * 0.7, st.label, { size: fs, weight: 650, maxW: w - textWidth(value, px.min) - 70 });
      txt(svg, w - 4, y - fs * 0.7, value, { size: px.min, anchor: 'end', cls: 'pa-m' });
      // no connectors when narrow (the label row sits between bars): the drop goes in the text line instead
      if (dropText) txt(svg, w - 4 - textWidth(value, px.min) - 8, y - fs * 0.7, dropText, { size: px.min, anchor: 'end', weight: 650, fill: toneColor('danger') });
    } else {
      txt(svg, labelCol, by + barH / 2 - (st.note ? fs * 0.6 : 0), st.label, { size: fs, weight: 650, anchor: 'end', maxW: labelCol - 4 });
      if (st.note) txt(svg, labelCol, by + barH / 2 + px.min * 0.7, st.note, { size: px.min, anchor: 'end', cls: 'pa-m', maxW: labelCol - 4 });
      // the numbers sit inside the bar when it is wide enough, else just to its right
      const inside = bw >= textWidth(value, fs, 650) + 12;
      txt(svg, inside ? cx : cx + bw / 2 + 6, by + barH / 2, value, { size: fs, anchor: inside ? 'middle' : 'start', weight: 650, cls: inside ? 'pa-on' : 'pa-t', maxW: inside ? bw - 8 : w - (cx + bw / 2 + 8) });
    }
  });
}

export const funnel = defineAsset({
  kind: 'funnel',
  shape: 'ordered stages where each is a subset of the previous (test pipeline, review gates, triage); how much survives each step',
  summary: 'Centred bars narrowing top to bottom with tapered connectors; share of the first stage in each bar and the drop between stages in red.',
  keys: ['unit', 'stages'],
  aspect: 0.62,
  minH: 260,
  sample: {
    unit: '',
    stages: [
      { label: 'Test cases', value: 1240, note: 'whole suite' },
      { label: 'Ran', value: 1180, note: 'not skipped' },
      { label: 'Passed first try', value: 1010 },
      { label: 'Passed after retry', value: 960, note: 'flaky ones retried' },
      { label: 'Reviewed', value: 540 },
      { label: 'Merged', value: 310 },
    ],
  },
  validate: validateFunnel,
  draw: drawFunnel,
});

// ---- waterfall ------------------------------------------------------------------------------------------------------------------
function validateWaterfall(d) {
  check.object(d, 'data', ['unit', 'start', 'steps', 'end']);
  check.object(d.start, 'data.start', ['label', 'value']);
  const start = { label: check.string(d.start.label, 'data.start.label', { max: 32 }), value: check.number(d.start.value, 'data.start.value') };
  const steps = each(d.steps, 'data.steps', { max: MAX_STEPS }, (st, p) => {
    check.object(st, p, ['label', 'delta']);
    return { label: check.string(st.label, `${p}.label`, { max: 32 }), delta: check.number(st.delta, `${p}.delta`) };
  });
  let end;
  if (d.end !== undefined) { check.object(d.end, 'data.end', ['label']); end = { label: check.string(d.end.label, 'data.end.label', { max: 32 }) }; }
  return { unit: unitOf(d.unit, 'data.unit'), start, steps, end: end ?? { label: 'Total' } };
}

/** Pure: bars {label, from, to, kind: start|up|down|end, total} with running totals. */
export function waterfallBars(data) {
  let run = data.start.value;
  const bars = [{ label: data.start.label, from: 0, to: run, kind: 'start', total: run }];
  for (const st of data.steps) { const from = run; run += st.delta; bars.push({ label: st.label, from, to: run, kind: st.delta >= 0 ? 'up' : 'down', total: run, delta: st.delta }); }
  bars.push({ label: data.end.label, from: 0, to: run, kind: 'end', total: run });
  return bars;
}
const barColor = (b) => (b.kind === 'up' ? toneColor('ok') : b.kind === 'down' ? toneColor('danger') : 'var(--ui-acc)');
const barText = (b, unit) => (b.kind === 'start' || b.kind === 'end' ? fmt(b.total, unit) : signed(b.delta, unit));
const barTip = (b, unit) => `${b.label}: ${barText(b, unit)}${b.kind === 'up' || b.kind === 'down' ? `, running total ${fmt(b.total, unit)}` : ''}`;

function drawWaterfallRows(ctx, bars) {
  const { data, svg, w, fs } = ctx;
  const lo = Math.min(0, ...bars.flatMap((b) => [b.from, b.to]));
  const hi = Math.max(0, ...bars.flatMap((b) => [b.from, b.to]));
  const rowH = Math.max(fs * WF_NARROW_ROW_EM, ctx.h / bars.length);
  const H = growTo(ctx, rowH * bars.length);
  const rh = Math.max(rowH, H / bars.length);
  const labelW = clamp(Math.max(...bars.map((b) => textWidth(b.label, fs, 600))) + 8, 70, w * 0.4);
  const valW = Math.max(...bars.map((b) => textWidth(barText(b, data.unit), fs, 650))) + 8;
  const x0 = labelW + 6;
  const span = Math.max(40, w - x0 - valW - 4);
  const xs = (v) => x0 + (span * (v - lo)) / Math.max(1e-9, hi - lo);
  svg.append(s('line', { x1: xs(0), x2: xs(0), y1: 0, y2: rh * bars.length, class: 'pa-axis' }));
  bars.forEach((b, i) => {
    const y = i * rh + rh * 0.2;
    const bh = rh * 0.6;
    const a = Math.min(xs(b.from), xs(b.to));
    const wd = Math.max(2, Math.abs(xs(b.to) - xs(b.from)));
    const c = barColor(b);
    if (i > 0) svg.append(s('line', { x1: xs(bars[i - 1].to), x2: xs(bars[i - 1].to), y1: (i - 1) * rh + rh * 0.8, y2: y, stroke: 'var(--ui-line-hi)', 'stroke-width': 1, 'stroke-dasharray': '2 3' }));
    svg.append(tip(s('rect', { x: a, y, width: wd, height: bh, rx: 3, fill: c, 'fill-opacity': b.kind === 'start' || b.kind === 'end' ? 0.9 : 0.8, class: 'pa-in' }), barTip(b, data.unit)));
    txt(svg, labelW, y + bh / 2, b.label, { size: fs, anchor: 'end', weight: b.kind === 'start' || b.kind === 'end' ? 700 : 500, maxW: labelW });
    const right = Math.max(xs(b.from), xs(b.to));
    txt(svg, right + 6, y + bh / 2, barText(b, data.unit), { size: fs, weight: 650, cls: 'pa-t', fill: b.kind === 'down' ? toneColor('danger') : b.kind === 'up' ? toneColor('ok') : undefined, maxW: w - right - 8 });
  });
}

function drawWaterfallCols(ctx, bars) {
  const { data, svg, w, fs } = ctx;
  const lo = Math.min(0, ...bars.flatMap((b) => [b.from, b.to]));
  const hi = Math.max(0, ...bars.flatMap((b) => [b.from, b.to]));
  const labelBand = fs * 1.3 * WF_LABEL_ROWS + 8;
  const topPad = fs * 2.6; // room for the value label of the tallest bar
  const colW = (w - 8) / bars.length;
  const labelMax = colW * WF_LABEL_ROWS - 4;
  const plotH = ctx.h - labelBand - topPad - fs * 1.4;
  const ys = (v) => topPad + (plotH * (hi - v)) / Math.max(1e-9, hi - lo);
  svg.append(s('line', { x1: 0, x2: w, y1: ys(0), y2: ys(0), class: 'pa-axis' }));
  bars.forEach((b, i) => {
    const x = 4 + i * colW + (colW * WF_GAP) / 2;
    const bw = colW * (1 - WF_GAP);
    const y0 = ys(Math.max(b.from, b.to));
    const y1 = ys(Math.min(b.from, b.to));
    const c = barColor(b);
    if (i > 0) svg.append(s('line', { x1: x - colW * WF_GAP, x2: x, y1: ys(bars[i - 1].to), y2: ys(bars[i - 1].to), stroke: 'var(--ui-line-hi)', 'stroke-width': 1, 'stroke-dasharray': '2 3' }));
    svg.append(tip(s('rect', { x, y: y0, width: bw, height: Math.max(2, y1 - y0), rx: 3, fill: c, 'fill-opacity': b.kind === 'start' || b.kind === 'end' ? 0.9 : 0.8, class: 'pa-in' }), barTip(b, data.unit)));
    const down = b.kind === 'down';
    const text = barText(b, data.unit);
    const cx = x + bw / 2;
    const room = Math.max(colW + 6, textWidth(text, fs, 650));
    const lx = clamp(cx, room / 2, w - room / 2);
    const ly = down ? y1 + fs * 0.8 : y0 - fs * 0.8;
    txt(svg, lx, ly, text, { size: fs, anchor: 'middle', weight: 650, fill: b.kind === 'down' ? toneColor('danger') : b.kind === 'up' ? toneColor('ok') : undefined, cls: 'pa-t pa-halo' });
    const row = i % WF_LABEL_ROWS;
    const lbl = ellipsize(b.label, labelMax, fs, 500);
    const half = textWidth(lbl, fs, 500) / 2 + 2;
    txt(svg, clamp(cx, half, w - half), ctx.h - labelBand + fs * 0.7 + row * fs * 1.3, lbl, { size: fs, anchor: 'middle', cls: b.kind === 'start' || b.kind === 'end' ? 'pa-b' : 'pa-m' });
  });
}

export const waterfall = defineAsset({
  kind: 'waterfall',
  shape: 'a total that grows and shrinks through signed steps (token budget, cost, latency, test count); what added and what took away',
  summary: 'A start bar, floating green (added) and red (removed) bars joined by connectors, a computed total bar. Rows on narrow widths.',
  keys: ['unit', 'start', 'steps', 'end'],
  aspect: 0.55,
  minH: 260,
  sample: {
    unit: 'k tok',
    start: { label: 'Context at start', value: 40 },
    steps: [
      { label: 'Read 12 files', delta: 34 },
      { label: 'Tool output', delta: 18 },
      { label: 'Agent plan', delta: 9 },
      { label: 'Compaction', delta: -46 },
      { label: 'Edits', delta: 21 },
      { label: 'Test logs', delta: 15 },
      { label: 'Pruned logs', delta: -12 },
    ],
    end: { label: 'Context now' },
  },
  validate: validateWaterfall,
  draw(ctx) {
    const bars = waterfallBars(ctx.data);
    if (ctx.narrow) drawWaterfallRows(ctx, bars); else drawWaterfallCols(ctx, bars);
  },
});
