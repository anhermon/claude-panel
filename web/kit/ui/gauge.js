// gauge.js - gauge (single value on an arc) and rings (up to 6 concentric completion rings).
import { h, build, addCss, counter } from './core.js';
import { arcPath, arcLength, fraction, formatNumber, toneForValue, TONES, isNum, toArray } from './pure.js';

const GAUGE_SIZE = 200;
const GAUGE_R = 80;
const GAUGE_START_DEG = -120;
const GAUGE_END_DEG = 120;
const GAUGE_STROKE = 14;
const RING_SIZE = 168;
const RING_STROKE = 12;
const RING_GAP = 5;
const RING_MAX = 6;

addCss(`
.ui-gauge { display: inline-flex; flex-direction: column; align-items: center; width: 100%; max-width: 240px; --tone: var(--ui-acc); }
.ui-gauge svg { width: 100%; height: auto; display: block; overflow: visible; }
.ui-gauge-track { fill: none; stroke: var(--ui-line-hi); stroke-width: ${GAUGE_STROKE}; stroke-linecap: round; }
.ui-gauge-fill { fill: none; stroke: var(--tone); stroke-width: ${GAUGE_STROKE}; stroke-linecap: round; transition: stroke-dashoffset .7s var(--ui-ease), stroke .4s; }
.ui-gauge-value { font-size: 34px; font-weight: 700; fill: var(--ui-fg); font-variant-numeric: tabular-nums; text-anchor: middle; }
.ui-gauge-unit { font-size: 14px; fill: var(--ui-mut); text-anchor: middle; }
.ui-gauge-end { font-size: 13px; fill: var(--ui-mut); text-anchor: middle; font-variant-numeric: tabular-nums; }
.ui-gauge-label { margin-top: -6px; font-size: var(--ui-fs-s); font-weight: 600; letter-spacing: .1em; text-transform: uppercase; color: var(--ui-mut); text-align: center; }
.ui-rings { display: flex; align-items: center; gap: 20px; flex-wrap: wrap; }
.ui-rings svg { width: ${RING_SIZE}px; height: ${RING_SIZE}px; flex: none; }
.ui-ring-track { fill: none; stroke: var(--ui-line); stroke-width: ${RING_STROKE}; }
.ui-ring-fill { fill: none; stroke-width: ${RING_STROKE}; stroke-linecap: round; transition: stroke-dashoffset .7s var(--ui-ease); }
.ui-rings-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.ui-rings-list li { display: flex; align-items: center; gap: 8px; font-size: var(--ui-fs); }
.ui-rings-swatch { width: 10px; height: 10px; border-radius: 50%; flex: none; }
.ui-rings-pct { margin-left: auto; padding-left: 12px; font-weight: 700; font-variant-numeric: tabular-nums; }
`);

/**
 * gauge({value, min, max, label, unit, thresholds: [{upTo, tone}], decimals}): value on a 240-degree arc, colour by threshold.
 * e.g. gauge({value: 72, label: 'CPU', unit: '%', thresholds: [{upTo: 60, tone: 'ok'}, {upTo: 85, tone: 'warn'}, {tone: 'danger'}]})
 */
export function gauge(opts = {}) {
  const sweep = GAUGE_END_DEG - GAUGE_START_DEG;
  const d = arcPath(GAUGE_SIZE / 2, GAUGE_SIZE / 2, GAUGE_R, GAUGE_START_DEG, GAUGE_END_DEG);
  const len = arcLength(GAUGE_R, sweep);
  const track = h('path.ui-gauge-track', { d });
  const fill = h('path.ui-gauge-fill', { d, 'stroke-dasharray': len, 'stroke-dashoffset': len });
  const value = h('text.ui-gauge-value', { x: GAUGE_SIZE / 2, y: GAUGE_SIZE / 2 + 6 });
  const unit = h('text.ui-gauge-unit', { x: GAUGE_SIZE / 2, y: GAUGE_SIZE / 2 + 28 });
  const endY = GAUGE_SIZE / 2 + GAUGE_R * 0.5 + 22;
  const lo = h('text.ui-gauge-end', { x: GAUGE_SIZE / 2 - GAUGE_R * Math.sin((sweep / 2) * Math.PI / 180), y: endY });
  const hi = h('text.ui-gauge-end', { x: GAUGE_SIZE / 2 + GAUGE_R * Math.sin((sweep / 2) * Math.PI / 180), y: endY });
  const label = h('div.ui-gauge-label');
  const el = h('div', { role: 'img' }, h('svg', { viewBox: `0 0 ${GAUGE_SIZE} ${GAUGE_SIZE - 20}` }, track, fill, value, unit, lo, hi), label);
  let set = counter(value);
  return build(el, 'gauge', opts, (o, prev, first) => {
    const min = o.min ?? 0;
    const max = o.max ?? 100;
    const frac = fraction(o.value, min, max);
    fill.style.strokeDashoffset = String(len * (1 - frac));
    if (first || o.decimals !== prev.decimals) set = counter(value, (v) => formatNumber(v, { decimals: o.decimals }));
    set(o.value, { first });
    unit.textContent = o.unit ?? '';
    lo.textContent = formatNumber(min);
    hi.textContent = formatNumber(max);
    label.textContent = o.label ?? '';
    const tone = o.tone ?? (o.thresholds ? toneForValue(o.value, o.thresholds) : 'info');
    for (const t of TONES) el.classList.toggle(`ui-tone-${t}`, tone === t);
    el.setAttribute('aria-label', `${o.label ?? 'gauge'} ${o.value}${o.unit ?? ''}`);
  });
}

/** rings({items: [{label, pct, color?}]}): concentric completion rings (pct 0..100) with the values listed beside them. e.g. rings({items: [{label: 'Build', pct: 82}, {label: 'Tests', pct: 45}]}) */
export function rings(opts = {}) {
  const svg = h('svg', { viewBox: `0 0 ${RING_SIZE} ${RING_SIZE}`, role: 'img' });
  const list = h('ul.ui-rings-list');
  const el = h('div', null, svg, list);
  const parts = [];
  return build(el, 'rings', opts, (o) => {
    const items = toArray(o.items).slice(0, RING_MAX);
    while (parts.length < items.length) {
      const i = parts.length;
      const r = RING_SIZE / 2 - RING_STROKE / 2 - i * (RING_STROKE + RING_GAP);
      const len = 2 * Math.PI * r;
      const fillEl = h('circle.ui-ring-fill', { cx: RING_SIZE / 2, cy: RING_SIZE / 2, r, 'stroke-dasharray': len, 'stroke-dashoffset': len, transform: `rotate(-90 ${RING_SIZE / 2} ${RING_SIZE / 2})` });
      svg.append(h('circle.ui-ring-track', { cx: RING_SIZE / 2, cy: RING_SIZE / 2, r }), fillEl);
      const swatch = h('span.ui-rings-swatch');
      const name = h('span');
      const pct = h('span.ui-rings-pct');
      list.append(h('li', null, swatch, name, pct));
      parts.push({ len, fillEl, swatch, name, pct, set: counter(pct, (v) => `${Math.round(v)}%`), li: list.lastChild, trackEl: svg.lastChild.previousSibling });
    }
    while (parts.length > items.length) {
      const p = parts.pop();
      p.fillEl.remove(); p.trackEl.remove(); p.li.remove();
    }
    items.forEach((item, i) => {
      const p = parts[i];
      const pct = isNum(item.pct) ? item.pct : fraction(item.value, 0, item.max ?? 100) * 100;
      const color = item.color ?? `var(--ui-c${(i % RING_MAX) + 1})`;
      p.fillEl.style.strokeDashoffset = String(p.len * (1 - Math.min(100, Math.max(0, pct)) / 100));
      p.fillEl.style.stroke = color;
      p.swatch.style.background = color;
      p.name.textContent = item.label ?? '';
      p.set(pct);
    });
    svg.setAttribute('aria-label', items.map((it) => `${it.label} ${Math.round(it.pct ?? 0)}%`).join(', '));
  });
}
