// metric: a big number that counts up to its value, a label, an optional delta chip and sparkline.
import { CAPS, capText, formatMetric, parseMetric, safeColor, scaleSeries } from '../board-logic.mjs';
import { h, nextPaint, tween, toneColor } from './dom.js';

const COUNT_MS = 1100;
const SPARK_W = 100;
const SPARK_H = 32;
const SPARK_PAD = 3;
const SHORT_VALUE = 4;
const MID_VALUE = 7;
const state = new WeakMap();

function sparkSvg(points) {
  const pts = points.filter(Number.isFinite).slice(-CAPS.spark);
  if (pts.length < 2) return null;
  const xy = scaleSeries(pts, SPARK_W, SPARK_H, { padY: SPARK_PAD });
  const line = xy.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const last = xy[xy.length - 1];
  const wrap = h('div', { class: 'spark' },
    h('svg', { viewBox: `0 0 ${SPARK_W} ${SPARK_H}`, preserveAspectRatio: 'none', 'aria-hidden': 'true' },
      h('path', { class: 'spark-area', d: `${line} L${SPARK_W},${SPARK_H} L0,${SPARK_H} Z` }),
      h('path', { class: 'spark-line', d: line, pathLength: '1' })),
    h('i', { class: 'spark-dot', style: `left:${(last.x / SPARK_W) * 100}%;top:${(last.y / SPARK_H) * 100}%` }));
  nextPaint(() => wrap.classList.add('drawn'));
  return wrap;
}

function show(el, f, ctx, from) {
  const s = state.get(el);
  s.cancel?.();
  const parts = parseMetric(f.value);
  const valueEl = s.valueEl;
  const text = capText(f.value, CAPS.label);
  valueEl.dataset.len = text.length <= SHORT_VALUE ? 'short' : text.length <= MID_VALUE ? 'mid' : 'long';
  if (!parts || ctx.reduced) { valueEl.textContent = text; return; }
  const start = from ?? 0;
  valueEl.textContent = formatMetric(parts, start);
  s.cancel = tween({ from: start, to: parts.n, ms: COUNT_MS, onUpdate: (v, done) => { valueEl.textContent = done ? text : formatMetric(parts, v); } });
  s.n = parts.n;
}

export function render(el, f, ctx) {
  const valueEl = h('div', { class: 'metric-value' });
  const delta = capText(f.delta, CAPS.status);
  const tone = toneColor(f.tone);
  const box = h('div', { class: 'metric', style: tone ? `--tone:${tone}` : (safeColor(f.color) ? `--tone:${safeColor(f.color)}` : null) },
    valueEl,
    h('div', { class: 'metric-meta' },
      f.label && h('span', { class: 'metric-label', text: capText(f.label, CAPS.label) }),
      delta && h('span', { class: 'chip', 'data-tone': f.tone ?? 'muted', text: delta })),
    Array.isArray(f.spark) && sparkSvg(f.spark));
  el.append(box);
  state.set(el, { valueEl, n: null });
  show(el, f, ctx, 0);
  ctx.onDispose(() => state.get(el)?.cancel?.());
}

/** Same layout: count from the old number to the new one. Otherwise (sparkline or delta appeared or vanished) cross-fade. */
export function update(el, f, ctx) {
  const s = state.get(el);
  const box = el.querySelector('.metric');
  const hasSpark = Array.isArray(f.spark) && f.spark.filter(Number.isFinite).length > 1;
  if (!s || !box || hasSpark !== !!box.querySelector('.spark') || !!capText(f.delta, 1) !== !!box.querySelector('.chip')) return false;
  if (hasSpark) box.querySelector('.spark').replaceWith(sparkSvg(f.spark));
  const parts = parseMetric(f.value);
  show(el, f, ctx, parts ? s.n ?? 0 : null);
  box.querySelector('.metric-label')?.replaceChildren(capText(f.label, CAPS.label));
  box.querySelector('.chip')?.replaceChildren(capText(f.delta, CAPS.status));
  return true;
}
