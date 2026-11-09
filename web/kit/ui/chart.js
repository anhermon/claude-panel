// chart.js - chart({type, ...}): bar, line, area, scatter, donut, heatmap. d3 does scales, axes and shapes; labels sit on the marks (no legends).
import { h, build, addCss } from './core.js';
import { normalizeSeries } from './pure.js';
import { createFrame, hostWidth, DEFAULT_HEIGHT } from './chart-base.js';
import { drawBar, drawLine, drawScatter } from './chart-xy.js';
import { drawDonut, drawHeatmap } from './chart-round.js';

export const CHART_TYPES = Object.freeze(['bar', 'line', 'area', 'scatter', 'donut', 'heatmap']);
const DEFAULT_TYPE = 'bar';

addCss(`.ui-chart-empty { color: var(--ui-mut); text-align: center; padding: 24px 8px; font-size: var(--ui-fs-s); }`);

/**
 * chart({type, data | series, height, title, xLabel, yLabel, format, unit, ...}) - data forms: [1,2,3] | [[x,y]] | [{x,y}|{label,value}];
 * many lines/bars: series: [{name, data, color?}]. Hover shows values; series are named on the chart itself.
 *   bar:     horizontal, stacked      line/area: smooth, yMin, yMax      scatter: r, labels      donut: center, centerLabel
 *   heatmap: data [{x, y, value}], color
 * update({data}) transitions the marks in place. e.g. chart({type: 'line', series: [{name: 'p95', data: [3, 5, 4]}], yLabel: 'ms'})
 */
export function chart(opts = {}) {
  const host = h('div');
  const head = h('div.ui-chart-head', null, h('span.ui-chart-title'), h('span.ui-card-sub'));
  host.append(head);
  const empty = h('div.ui-chart-empty', null, 'No data yet');
  empty.hidden = true;
  let api = null;
  const frame = createFrame(host, () => { frame.hideTip(); if (api) draw(api.opts(), false); });
  host.append(empty);
  let drawnType = null;
  let drawnOnce = false;
  function draw(o, animate) {
    const w = hostWidth(host);
    if (!w) return; // not laid out yet: the resize observer calls us back
    const type = CHART_TYPES.includes(o.type) ? o.type : DEFAULT_TYPE;
    frame.size(w, o.height ?? DEFAULT_HEIGHT);
    const series = normalizeSeries(o);
    const hasData = type === 'donut' ? (Array.isArray(o.data) && o.data.length > 0) : type === 'heatmap' ? (o.cells ?? o.data ?? []).length > 0 : series.some((s) => s.points.length);
    empty.hidden = hasData;
    frame.node.style.display = hasData ? '' : 'none';
    if (!hasData) return;
    if (drawnType !== type) { frame.clear(); drawnType = type; }
    const anim = animate || !drawnOnce; // the first real draw (also after a resize) grows in
    drawnOnce = true;
    if (!anim) frame.svg.selectAll('*').interrupt();
    if (type === 'bar') drawBar(frame, o, series, anim);
    else if (type === 'line' || type === 'area') drawLine(frame, o, series, anim, type === 'area');
    else if (type === 'scatter') drawScatter(frame, o, series, anim);
    else if (type === 'donut') drawDonut(frame, o, series, anim);
    else drawHeatmap(frame, o, series, anim);
    frame.node.setAttribute('aria-label', o.title ? `${o.title} (${type} chart)` : `${type} chart`);
  }
  api = build(host, 'chart', opts, (o, prev) => {
    const [title, sub] = head.children;
    title.textContent = o.title ?? '';
    sub.textContent = o.sub ?? '';
    head.hidden = !o.title && !o.sub;
    draw(o, Boolean(prev) && prev.type === o.type);
  });
  return api;
}

const shortcut = (type) => (opts = {}) => chart({ ...opts, type });
/** Shorthands: bar(opts) === chart({...opts, type: 'bar'}). */
export const bar = shortcut('bar');
export const line = shortcut('line');
export const area = shortcut('area');
export const scatter = shortcut('scatter');
export const donut = shortcut('donut');
export const heatmap = shortcut('heatmap');
