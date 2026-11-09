// chart-base.js - shared chart frame: responsive svg, persistent layers, axes + grid, tooltip, number formats. Built on the vendored d3.
import * as d3 from 'd3';
import { h, addCss, dur, DUR } from './core.js';
import { formatNumber, textWidth, clamp } from './pure.js';

export const DEFAULT_HEIGHT = 240;
export const TIP_OFFSET = 12;
const AXIS_TICK_PX = 4;
const Y_TICK_SPACING = 42;
const X_TICK_SPACING = 84;
const MIN_WIDTH = 120;
const LAYER_ORDER = ['grid', 'axx', 'axy', 'axlabels', 'marks', 'centre', 'direct', 'overlay'];

addCss(`
.ui-chart { position: relative; display: flex; flex-direction: column; gap: 6px; }
.ui-chart-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.ui-chart-title { font-size: var(--ui-fs-s); font-weight: 600; letter-spacing: .1em; text-transform: uppercase; color: var(--ui-mut); }
.ui-chart-svg { width: 100%; display: block; overflow: visible; touch-action: pan-y; }
.ui-chart .domain { display: none; }
.ui-chart .tick line { stroke: var(--ui-line); }
.ui-chart .tick text { fill: var(--ui-mut); font-size: 13px; font-variant-numeric: tabular-nums; }
.ui-chart .ui-grid-g .tick line { stroke: var(--ui-line); stroke-opacity: .9; }
.ui-chart .ui-grid-g .tick text { display: none; }
.ui-chart-axis-label { fill: var(--ui-mut); font-size: 13px; }
.ui-chart-direct { font-size: 13px; font-weight: 600; }
.ui-chart-value { font-size: 13px; font-weight: 600; fill: var(--ui-fg); font-variant-numeric: tabular-nums; }
.ui-mark { transition: opacity .15s; }
.ui-tip { position: absolute; z-index: 5; pointer-events: none; background: var(--ui-card-hi); color: var(--ui-fg); border: 1px solid var(--ui-line-hi); border-radius: var(--ui-r-s);
  padding: 6px 9px; font-size: var(--ui-fs-s); box-shadow: 0 6px 18px rgba(0,0,0,.35); white-space: nowrap; transition: opacity ${DUR.tip}ms; }
.ui-tip-title { color: var(--ui-mut); margin-bottom: 2px; }
.ui-tip-row { display: flex; align-items: center; gap: 6px; font-variant-numeric: tabular-nums; }
.ui-tip-row b { margin-left: auto; padding-left: 12px; }
.ui-tip-sw { width: 8px; height: 8px; border-radius: 50%; flex: none; }
`);

/** Creates the svg + tooltip inside `host` and calls `onResize()` when the host width changes. Returns the frame. */
export function createFrame(host, onResize) {
  const node = h('svg.ui-chart-svg', { role: 'img' });
  const tip = h('div.ui-tip', { role: 'status' });
  tip.hidden = true;
  host.append(node, tip);
  const svg = d3.select(node);
  for (const name of LAYER_ORDER) svg.append('g').attr('class', `layer-${name}`); // paint order: grid and axes under the marks
  const frame = {
    svg, node, tip, host, w: 0, h: DEFAULT_HEIGHT, kind: null,
    /** Persistent <g class="layer-name"> in creation order. */
    layer(name) {
      const sel = svg.select(`g.layer-${name}`);
      return sel.empty() ? svg.append('g').attr('class', `layer-${name}`) : sel;
    },
    /** Drops every layer (used when the chart type changes). */
    clear() { svg.selectAll('*').remove(); for (const name of LAYER_ORDER) svg.append('g').attr('class', `layer-${name}`); },
    size(w, hh) {
      frame.w = w; frame.h = hh;
      svg.attr('viewBox', `0 0 ${w} ${hh}`).attr('width', w).attr('height', hh).style('height', `${hh}px`);
    },
    /** Shows the tooltip near a pointer event: title line + rows [{color, label, value}]. */
    showTip(evt, title, rows) {
      tip.replaceChildren(...(title ? [h('div.ui-tip-title', null, title)] : []),
        ...rows.map((r) => h('div.ui-tip-row', null, r.color ? h('span.ui-tip-sw', { style: { background: r.color } }) : null, r.label ? h('span', null, r.label) : null, h('b', null, r.value))));
      tip.hidden = false;
      const box = host.getBoundingClientRect();
      const x = evt.clientX - box.left;
      const y = evt.clientY - box.top;
      const left = x + TIP_OFFSET + tip.offsetWidth > box.width ? x - TIP_OFFSET - tip.offsetWidth : x + TIP_OFFSET;
      tip.style.left = `${clamp(left, 0, Math.max(0, box.width - tip.offsetWidth))}px`;
      tip.style.top = `${Math.max(0, y - tip.offsetHeight - TIP_OFFSET / 2)}px`;
    },
    hideTip() { tip.hidden = true; },
  };
  let last = 0;
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => {
      const w = Math.round(host.clientWidth);
      if (w && w !== last) { last = w; onResize(); }
    }).observe(host);
  }
  return frame;
}

/** Host width the chart should draw at (>= MIN_WIDTH), 0 when it is not laid out yet. */
export const hostWidth = (host) => (host.clientWidth ? Math.max(MIN_WIDTH, Math.round(host.clientWidth)) : 0);

/** Axis tick label format: caller's, else compact numbers. */
export const numFmt = (custom, o = {}) => custom ?? ((v) => formatNumber(v, { compact: true, prefix: o.prefix, suffix: o.suffix ?? o.unit }));
/** Value format for tooltips and direct labels. */
export const valueFmt = (o) => o.format ?? ((v) => formatNumber(v, { prefix: o.prefix, suffix: o.suffix ?? o.unit, decimals: o.decimals }));

/** Margins {top,right,bottom,left}: from the widest y tick text and the axis labels. */
export function margins(o, { yTexts = [], right = 12, left } = {}) {
  const yw = Math.max(0, ...yTexts.map((t) => textWidth(t)));
  return { top: o.yLabel ? 24 : 12, right, bottom: 26 + (o.xLabel ? 20 : 0), left: left ?? Math.max(30, yw + 14) };
}

/**
 * Draws grid + axes into the frame's layers. xs / ys are d3 scales; `grid` is 'x' | 'y' | null (gridlines follow that axis).
 * opts: xFmt, yFmt, xValues, yValues, noX, noY. Transitions when `anim`.
 */
export function drawAxes(f, { xs, ys, m, iw, ih, grid = 'y', xFmt, yFmt, xValues, noX, noY }, o, anim) {
  const t = (sel) => (anim ? sel.transition().duration(dur(DUR.grow)) : sel);
  const nx = Math.max(2, Math.floor(iw / X_TICK_SPACING));
  const ny = Math.max(2, Math.floor(ih / Y_TICK_SPACING));
  const gridG = f.layer('grid').attr('class', 'layer-grid ui-grid-g').attr('transform', `translate(${m.left},${m.top})`);
  if (grid === 'y') t(gridG).call(d3.axisLeft(ys).ticks(ny).tickSize(-iw).tickFormat(''));
  else if (grid === 'x') t(gridG.attr('transform', `translate(${m.left},${m.top + ih})`)).call(d3.axisBottom(xs).ticks(nx).tickSize(-ih).tickFormat(''));
  else gridG.selectAll('*').remove();
  const gx = f.layer('axx').attr('transform', `translate(${m.left},${m.top + ih})`);
  if (noX) gx.selectAll('*').remove();
  else {
    const ax = d3.axisBottom(xs).tickSizeOuter(0).tickSize(AXIS_TICK_PX);
    if (xs.ticks) ax.ticks(nx);
    if (xFmt) ax.tickFormat(xFmt);
    if (xValues) ax.tickValues(xValues);
    t(gx).call(ax);
  }
  const gy = f.layer('axy').attr('transform', `translate(${m.left},${m.top})`);
  if (noY) gy.selectAll('*').remove();
  else {
    const ay = d3.axisLeft(ys).tickSizeOuter(0).tickSize(AXIS_TICK_PX);
    if (ys.ticks) ay.ticks(ny);
    if (yFmt) ay.tickFormat(yFmt);
    t(gy).call(ay);
  }
  // axis titles: y at the top-left (read horizontally), x under the axis, right-aligned
  const labels = f.layer('axlabels');
  const items = [o.yLabel ? { k: 'y', text: o.yLabel, x: 0, y: 12, anchor: 'start' } : null, o.xLabel ? { k: 'x', text: o.xLabel, x: m.left + iw, y: m.top + ih + 44, anchor: 'end' } : null].filter(Boolean);
  labels.selectAll('text').data(items, (d) => d.k).join('text').attr('class', 'ui-chart-axis-label').attr('x', (d) => d.x).attr('y', (d) => d.y).attr('text-anchor', (d) => d.anchor).text((d) => d.text);
}

/** Every x tick-able label value thinned so that labels of width `lab` fit in `iw`. */
export function thinTicks(values, lab, iw) {
  const step = Math.max(1, Math.ceil((values.length * (lab + 8)) / Math.max(1, iw)));
  return values.filter((_, i) => i % step === 0);
}
