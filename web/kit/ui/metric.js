// metric.js - metric (big number + delta + sparkline, counts up on change) and sparkline.
import { h, build, addCss, counter, flash } from './core.js';
import { formatNumber, deltaTone, sparkPath, isNum, isObj, TONES } from './pure.js';

const SPARK_W = 120;
const SPARK_H = 32;

addCss(`
.ui-metric { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.ui-metric-label { font-size: var(--ui-fs-s); font-weight: 600; letter-spacing: .1em; text-transform: uppercase; color: var(--ui-mut); }
.ui-metric-value { font-size: var(--ui-fs-xl); font-weight: 700; line-height: 1.1; font-variant-numeric: tabular-nums; display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; }
.ui-metric-unit { font-size: var(--ui-fs); font-weight: 500; color: var(--ui-mut); }
.ui-metric-foot { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; min-height: 1.4em; }
.ui-metric-delta { font-size: var(--ui-fs-s); font-weight: 600; font-variant-numeric: tabular-nums; color: var(--tone, var(--ui-mut)); }
.ui-metric-delta small { color: var(--ui-mut); font-weight: 400; margin-left: 4px; font-size: inherit; }
.ui-spark { position: relative; display: inline-block; width: ${SPARK_W}px; height: ${SPARK_H}px; flex: none; --tone: var(--ui-acc); }
.ui-spark svg { width: 100%; height: 100%; display: block; overflow: visible; }
.ui-spark-line { fill: none; stroke: var(--tone); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; vector-effect: non-scaling-stroke; transition: d .5s var(--ui-ease); }
.ui-spark-area { fill: color-mix(in srgb, var(--tone) 16%, transparent); stroke: none; transition: d .5s var(--ui-ease); }
.ui-spark-dot { position: absolute; width: 7px; height: 7px; margin: -3.5px 0 0 -3.5px; border-radius: 50%; background: var(--tone); transition: left .5s var(--ui-ease), top .5s var(--ui-ease); }
`);

function setPath(node, d) {
  node.setAttribute('d', d);
  node.style.setProperty('d', `path("${d}")`);
}

/** sparkline({values: [3,5,4,8], tone: 'info'}): tiny trend line with an end dot; update({values}) morphs it. */
export function sparkline(input = {}) {
  const opts = Array.isArray(input) ? { values: input } : input;
  const area = h('path.ui-spark-area');
  const line = h('path.ui-spark-line');
  const dot = h('span.ui-spark-dot');
  const el = h('span', null, h('svg', { viewBox: `0 0 ${SPARK_W} ${SPARK_H}`, preserveAspectRatio: 'none', 'aria-hidden': 'true' }, area, line), dot);
  return build(el, 'spark', opts, (o) => {
    const p = sparkPath(o.values, SPARK_W, SPARK_H);
    setPath(line, p.d);
    setPath(area, p.area);
    dot.style.left = `${p.fx * 100}%`;
    dot.style.top = `${p.fy * 100}%`;
    dot.hidden = !p.d;
    for (const t of TONES) el.classList.toggle(`ui-tone-${t}`, o.tone === t);
  });
}

/**
 * metric({label, value, unit, delta, deltaLabel, goodWhen: 'up'|'down', spark: [..], decimals, compact, prefix, suffix})
 * Big number that counts up when update({value}) changes it; delta is a number (green/red by goodWhen) or text.
 * e.g. metric({label: 'Requests', value: 1280, delta: 4.2, deltaUnit: '%', spark: [3, 5, 4, 8]})
 */
export function metric(opts = {}) {
  const label = h('div.ui-metric-label');
  const num = h('span');
  const unit = h('span.ui-metric-unit');
  const delta = h('span.ui-metric-delta');
  const spark = sparkline({ values: [] });
  const foot = h('div.ui-metric-foot', null, delta, spark);
  const el = h('div', null, label, h('div.ui-metric-value', null, num, unit), foot);
  let set = counter(num);
  return build(el, 'metric', opts, (o, prev, first) => {
    label.textContent = o.label ?? '';
    unit.textContent = o.unit ?? '';
    if (first || o.decimals !== prev.decimals || o.compact !== prev.compact || o.prefix !== prev.prefix || o.suffix !== prev.suffix || o.format !== prev.format) {
      set = counter(num, o.format ?? ((v) => formatNumber(v, { decimals: o.decimals, compact: o.compact, prefix: o.prefix, suffix: o.suffix })));
    }
    if (first || o.value !== prev.value || o.decimals !== prev.decimals) {
      set(o.value, { first: Boolean(first && isNum(o.value) && o.countUp !== false) });
    }
    const d = o.delta;
    const tone = o.deltaTone ?? (isNum(d) ? deltaTone(d, o.goodWhen) : 'neutral');
    const arrow = isNum(d) ? (d > 0 ? '▲ ' : d < 0 ? '▼ ' : '') : '';
    delta.textContent = d === undefined || d === null ? '' : `${arrow}${isNum(d) ? formatNumber(d, { sign: true }) : d}${isNum(d) ? o.deltaUnit ?? '' : ''}`;
    if (o.deltaLabel && delta.textContent) delta.append(h('small', null, o.deltaLabel));
    for (const t of TONES) delta.classList.toggle(`ui-tone-${t}`, tone === t);
    if (prev && prev.delta !== d && delta.textContent) flash(delta);
    const hasSpark = Array.isArray(o.spark) && o.spark.length > 0;
    spark.hidden = !hasSpark;
    if (hasSpark) spark.update({ values: o.spark, tone: o.sparkTone ?? (o.tone ?? 'info') });
    foot.hidden = !delta.textContent && !hasSpark;
  });
}
