// uncertainty.js - saying "about this much, give or take": `ranges` (estimates as intervals vs what happened / a target) and `fan`
// (a forecast whose bands widen with time). Shares the row/axis helpers of compare.js.
import { AssetError, check, each, numbers, defineAsset, s, txt, tip, soft, textWidth, fmt, clamp } from './core.js';
import { niceTicks, rowLayout, drawHAxis, labelColumn } from './compare.js';
import { spread } from './layout.js';

const SMALL = 0.95;
const BAR_H = 12;
const RING_R = 5;
const MID_H = 18;
const MAX_ITEMS = 10;
const MAX_BANDS = 3;
const MAX_POINTS = 120;
const BAND_BASE_PCT = 12;
const BAND_STEP_PCT = 14;
const Y_TICKS = 4;
const X_TICK_PX = 84;
const END_GAP = 8;

// ---- ranges ---------------------------------------------------------------------------------------------------------------------------
function validateRanges(d) {
  check.object(d, 'data', ['unit', 'items', 'target', 'confidence']);
  const items = each(d.items, 'data.items', { max: MAX_ITEMS }, (r, p) => {
    check.object(r, p, ['label', 'low', 'mid', 'high', 'actual', 'note']);
    const low = check.number(r.low, `${p}.low`);
    const high = check.number(r.high, `${p}.high`);
    if (low > high) throw new AssetError(`${p}.low (${low}) is above ${p}.high (${high})`);
    const mid = check.number(r.mid, `${p}.mid`, { min: low, max: high, optional: true });
    return { label: check.string(r.label, `${p}.label`, { max: 40 }), low, mid, high, actual: check.number(r.actual, `${p}.actual`, { optional: true }), note: check.string(r.note, `${p}.note`, { max: 80, optional: true }) };
  });
  return { items, unit: check.string(d.unit, 'data.unit', { max: 12, optional: true }), target: check.number(d.target, 'data.target', { optional: true }), confidence: check.string(d.confidence, 'data.confidence', { max: 40, optional: true }) };
}

function drawRanges(ctx) {
  const { data, svg, w, fs } = ctx;
  const small = fs * SMALL;
  const head = data.target === undefined ? fs * 0.6 : fs * 1.8;
  const axisH = fs * 2;
  const foot = fs * 1.7;
  const { hh, pitch } = rowLayout(ctx, data.items.length, fs * 2.6, fs * 3.4, head + axisH + foot);
  const labW = labelColumn(data.items.map((r) => r.label), fs, w);
  const endW = textWidth(fmt(Math.max(...data.items.map((r) => Math.abs(r.high))), data.unit), small, 600) / 2 + 6;
  const x0 = labW + endW;
  const x1 = w - endW - 4;
  const vals = data.items.flatMap((r) => [r.low, r.high, r.actual ?? r.low]).concat(data.target ?? []);
  const x = drawHAxis(svg, { x0, x1, top: head, bottom: hh - axisH - foot, lo: Math.min(...vals), hi: Math.max(...vals), fs, unit: data.unit });
  const plotBottom = hh - axisH - foot;
  if (data.target !== undefined) {
    svg.append(s('line', { x1: x(data.target), x2: x(data.target), y1: head - 4, y2: plotBottom, stroke: 'var(--ui-warn)', 'stroke-width': 2, 'stroke-dasharray': '5 4' }));
    txt(svg, clamp(x(data.target), x0 + 30, x1 - 30), head / 2 - 2, `target ${fmt(data.target, data.unit)}`, { size: small, anchor: 'middle', cls: 'pa-m pa-halo', weight: 650 });
  }
  data.items.forEach((r, i) => {
    const y = head + pitch * (i + 0.5);
    txt(svg, labW - 8, y, r.label, { size: fs, anchor: 'end', maxW: labW - 8, cls: 'pa-t' });
    svg.append(tip(s('rect', { x: x(r.low), y: y - BAR_H / 2, width: Math.max(2, x(r.high) - x(r.low)), height: BAR_H, rx: BAR_H / 2, fill: soft('var(--ui-acc)', 32), stroke: 'var(--ui-acc)', 'stroke-width': 1.5, class: 'pa-in' }),
      `${r.label}: ${fmt(r.low, data.unit)} to ${fmt(r.high, data.unit)}${r.mid === undefined ? '' : `, best guess ${fmt(r.mid, data.unit)}`}${r.actual === undefined ? '' : `, actual ${fmt(r.actual, data.unit)}`}${r.note ? ` - ${r.note}` : ''}`));
    if (r.mid !== undefined) svg.append(s('line', { x1: x(r.mid), x2: x(r.mid), y1: y - MID_H / 2, y2: y + MID_H / 2, stroke: 'var(--ui-acc)', 'stroke-width': 3, 'stroke-linecap': 'round' }));
    // the interval as text above the bar: end labels beside it would collide with the actual ring
    txt(svg, clamp((x(r.low) + x(r.high)) / 2, x0, x1), y - BAR_H / 2 - small * 0.55, `${fmt(r.low)}-${fmt(r.high, data.unit)}`, { size: small, anchor: 'middle', cls: 'pa-m pa-halo' });
    if (r.actual !== undefined) {
      const inside = r.actual >= r.low && r.actual <= r.high;
      svg.append(s('circle', { cx: x(r.actual), cy: y, r: RING_R, fill: 'var(--ui-card)', stroke: inside ? 'var(--ui-ok)' : 'var(--ui-danger)', 'stroke-width': 3 }));
    }
  });
  const hasActual = data.items.some((r) => r.actual !== undefined);
  const key = [data.confidence, 'tick = best guess', hasActual ? 'ring = actual' : ''].filter(Boolean).join('  ·  ');
  txt(svg, 0, hh - foot / 2, key, { size: small, cls: 'pa-m', maxW: w });
}

export const ranges = defineAsset({
  kind: 'ranges',
  shape: 'estimates with a spread (how long, how many tokens) against a target or what actually happened',
  summary: 'A bar from low to high per item with a best-guess tick; a ring marks the actual (green inside the range, red outside); a dashed line is the target.',
  keys: ['unit', 'items', 'target', 'confidence'],
  aspect: 0.55,
  minH: 200,
  sample: {
    unit: 'h', target: 8, confidence: '80% interval',
    items: [{ label: 'Parser rewrite', low: 2, mid: 3, high: 5, actual: 4 }, { label: 'Migration', low: 4, mid: 6, high: 11, actual: 12 }, { label: 'Test suite', low: 1, mid: 2, high: 3, actual: 2.5 }, { label: 'Docs', low: 1, mid: 1.5, high: 4 }],
  },
  validate: validateRanges,
  draw: drawRanges,
});

// ---- fan ----------------------------------------------------------------------------------------------------------------------------------
function validateFan(d) {
  check.object(d, 'data', ['unit', 'xLabels', 'history', 'forecast']);
  const history = numbers(d.history, 'data.history', { min: 2, max: MAX_POINTS });
  check.object(d.forecast, 'data.forecast', ['mid', 'bands']);
  const mid = numbers(d.forecast.mid, 'data.forecast.mid', { min: 1, max: MAX_POINTS });
  const bands = each(d.forecast.bands, 'data.forecast.bands', { max: MAX_BANDS }, (b, p) => {
    check.object(b, p, ['label', 'low', 'high']);
    const low = numbers(b.low, `${p}.low`, { min: mid.length, max: mid.length });
    const high = numbers(b.high, `${p}.high`, { min: mid.length, max: mid.length });
    low.forEach((v, i) => { if (v > high[i]) throw new AssetError(`${p}.low[${i}] (${v}) is above ${p}.high[${i}] (${high[i]})`); });
    return { label: check.string(b.label, `${p}.label`, { max: 12 }), low, high };
  });
  const total = history.length + mid.length;
  const xLabels = d.xLabels === undefined ? undefined : each(d.xLabels, 'data.xLabels', { min: total, max: total }, (l, p) => check.string(l, p, { max: 16 }));
  return { unit: check.string(d.unit, 'data.unit', { max: 12, optional: true }), xLabels, history, forecast: { mid, bands } };
}

function drawFan({ data, svg, w, h, fs }) {
  const small = fs * SMALL;
  const { history, forecast } = data;
  const nh = history.length;
  const n = nh + forecast.mid.length;
  const all = [...history, ...forecast.mid, ...forecast.bands.flatMap((b) => [...b.low, ...b.high])];
  const { lo, hi, ticks } = niceTicks(Math.min(...all), Math.max(...all), Y_TICKS);
  const wide = forecast.bands[0];
  const lastIdx = forecast.mid.length - 1;
  const endTexts = [{ v: wide ? wide.high[lastIdx] : forecast.mid[lastIdx], t: fmt(wide ? wide.high[lastIdx] : forecast.mid[lastIdx], data.unit), cls: 'pa-m' }, { v: forecast.mid[lastIdx], t: fmt(forecast.mid[lastIdx], data.unit), cls: 'pa-b' }, { v: wide ? wide.low[lastIdx] : forecast.mid[lastIdx], t: fmt(wide ? wide.low[lastIdx] : forecast.mid[lastIdx], data.unit), cls: 'pa-m' }];
  const left = Math.max(...ticks.map((t) => textWidth(fmt(t, data.unit), small))) + 10;
  const right = Math.max(...endTexts.map((e) => textWidth(e.t, small, 700))) + END_GAP + 4;
  const top = fs * 1.8;
  const bottom = h - fs * 2;
  const x = (i) => left + (i / (n - 1)) * (w - left - right);
  const y = (v) => bottom - ((v - lo) / (hi - lo)) * (bottom - top);
  ticks.forEach((t) => {
    svg.append(s('line', { x1: left, x2: w - right, y1: y(t), y2: y(t), class: 'pa-grid' }));
    txt(svg, left - 6, y(t), fmt(t, t === ticks.at(-1) ? data.unit : ''), { size: small, anchor: 'end', cls: 'pa-m' });
  });
  const xTicks = clamp(Math.floor((w - left - right) / X_TICK_PX), 2, n);
  for (let k = 0; k < xTicks; k++) {
    const i = Math.round((k / (xTicks - 1)) * (n - 1));
    txt(svg, x(i), bottom + fs * 0.9, data.xLabels ? data.xLabels[i] : String(i + 1), { size: small, anchor: k === 0 ? 'start' : k === xTicks - 1 ? 'end' : 'middle', cls: 'pa-m', baseline: 'hanging' });
  }
  const edge = (arr, base) => [base, ...arr];
  forecast.bands.forEach((b, k) => {
    const lows = edge(b.low, history[nh - 1]);
    const highs = edge(b.high, history[nh - 1]);
    const up = highs.map((v, i) => `${x(nh - 1 + i)},${y(v)}`);
    const dn = lows.map((v, i) => `${x(nh - 1 + i)},${y(v)}`).reverse();
    svg.append(tip(s('polygon', { points: [...up, ...dn].join(' '), fill: soft('var(--ui-acc)', BAND_BASE_PCT + k * BAND_STEP_PCT), class: 'pa-in' }), `${b.label} band: ${fmt(b.low[lastIdx], data.unit)} to ${fmt(b.high[lastIdx], data.unit)} at the end`));
  });
  svg.append(s('line', { x1: x(nh - 1), x2: x(nh - 1), y1: top - 4, y2: bottom, stroke: 'var(--ui-line-hi)', 'stroke-dasharray': '4 4' }));
  txt(svg, x(nh - 1), top - fs * 0.8, 'now', { size: small, anchor: 'middle', cls: 'pa-m', weight: 650 });
  svg.append(s('path', { d: history.map((v, i) => `${i ? 'L' : 'M'}${x(i)},${y(v)}`).join(''), fill: 'none', stroke: 'var(--ui-fg)', 'stroke-width': 2.2, 'stroke-linejoin': 'round' }));
  svg.append(s('path', { d: edge(forecast.mid, history[nh - 1]).map((v, i) => `${i ? 'L' : 'M'}${x(nh - 1 + i)},${y(v)}`).join(''), fill: 'none', stroke: 'var(--ui-acc)', 'stroke-width': 2.4, 'stroke-dasharray': '7 5', 'stroke-linecap': 'round' }));
  const keyText = forecast.bands.map((b) => b.label).join(' / ');
  if (keyText) txt(svg, left, top - fs * 0.8, keyText, { size: small, cls: 'pa-m', maxW: Math.max(40, x(nh - 1) - left - 24) });
  const ys = spread(endTexts.map((e) => y(e.v)), small * 1.15, top, bottom);
  endTexts.forEach((e, i) => txt(svg, w - right + END_GAP, ys[i], e.t, { size: small, cls: e.cls, weight: e.cls === 'pa-b' ? 700 : 500 }));
}

export const fan = defineAsset({
  kind: 'fan',
  shape: 'a forecast whose uncertainty grows with time (burn-down, token spend, finish date); what we know vs what we expect',
  summary: 'Solid history, a "now" divider, a dashed best-guess line and nested translucent bands that widen to the right; the end values are written out.',
  keys: ['unit', 'xLabels', 'history', 'forecast'],
  aspect: 0.5,
  minH: 220,
  sample: {
    unit: 'k tok',
    history: [12, 18, 22, 31, 36, 44, 51],
    forecast: {
      mid: [58, 65, 72, 79, 86],
      bands: [{ label: '80%', low: [56, 60, 64, 67, 70], high: [60, 70, 80, 91, 102] }, { label: '50%', low: [57, 62, 68, 73, 78], high: [59, 68, 76, 85, 94] }],
    },
  },
  validate: validateFan,
  draw: drawFan,
});
