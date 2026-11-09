// chart-round.js - donut (arcs tween between values, direct labels outside) and heatmap (colour = value, CSS-themed).
import * as d3 from 'd3';
import { dur, DUR, seriesColor } from './core.js';
import { donutSlices, heatGrid, textWidth, clamp, formatNumber } from './pure.js';
import { valueFmt, thinTicks } from './chart-base.js';

const DONUT_HOLE = 0.62;
const DONUT_LABEL_GAP = 10;
const DONUT_MIN_LABEL_PCT = 0.03;
const HEAT_STEPS = 6;
const HEAT_MIN_MIX = 10; // % of the series colour in the lowest cell
const HEAT_LABEL_MIN_W = 30;
const HEAT_LABEL_MIN_H = 18;
const HEAT_KEY_W = 74;
const HEAT_PAD = 0.08;
const tr = (sel, anim) => (anim ? sel.transition().duration(dur(DUR.grow)) : sel);

/** donut chart. data: [{label, value, color?}]; opts.center = text in the hole (default: the total). */
export function drawDonut(f, o, series, anim) {
  const items = (Array.isArray(o.data) ? o.data : series[0].points.map((p) => ({ label: p.x, value: p.y, color: p.color }))).map((d, i) => (d && typeof d === 'object' ? d : { label: `Item ${i + 1}`, value: d }));
  const slices = donutSlices(items).map((s, i) => ({ ...s, color: s.color ?? seriesColor(i) }));
  const fmt = valueFmt(o);
  const total = slices.reduce((t, s) => t + s.value, 0);
  const labelW = Math.max(0, ...slices.map((s) => textWidth(`${s.label} ${Math.round(s.pct * 100)}%`))) + DONUT_LABEL_GAP;
  const radius = Math.max(40, Math.min(f.h / 2 - 14, (f.w - 2 * Math.min(labelW, f.w * 0.3)) / 2));
  const cx = f.w / 2;
  const cy = f.h / 2;
  const arc = d3.arc().innerRadius(radius * DONUT_HOLE).outerRadius(radius).cornerRadius(2).padAngle(slices.length > 1 ? 0.012 : 0);
  const outer = d3.arc().innerRadius(radius + DONUT_LABEL_GAP).outerRadius(radius + DONUT_LABEL_GAP);
  const marks = f.layer('marks').attr('transform', `translate(${cx},${cy})`);
  const sel = marks.selectAll('path.ui-mark').data(slices, (d) => d.label);
  const en = sel.enter().append('path').attr('class', 'ui-mark').each(function (d) { this._cur = { start: d.start, end: d.start }; });
  const all = en.merge(sel).attr('fill', (d) => d.color);
  const arcOf = (cur) => arc({ startAngle: cur.start, endAngle: cur.end });
  if (anim) {
    all.transition().duration(dur(DUR.grow)).attrTween('d', function (d) {
      const i = d3.interpolateObject(this._cur ?? { start: d.start, end: d.start }, { start: d.start, end: d.end });
      return (k) => { this._cur = i(k); return arcOf(this._cur); };
    });
  } else {
    all.each(function (d) { this._cur = { start: d.start, end: d.end }; }).attr('d', function () { return arcOf(this._cur); });
  }
  sel.exit().remove();
  all.on('pointermove', (e, d) => f.showTip(e, d.label, [{ color: d.color, label: `${(d.pct * 100).toFixed(1)}%`, value: fmt(d.value) }])).on('pointerleave', () => f.hideTip());
  // centre: total (or custom)
  const centre = f.layer('centre').attr('transform', `translate(${cx},${cy})`);
  const lines = [{ k: 'v', text: o.center ?? fmt(total), dy: '-0.05em', cls: 'ui-gauge-value' }, o.centerLabel ? { k: 'l', text: o.centerLabel, dy: '1.5em', cls: 'ui-gauge-unit' } : null].filter(Boolean);
  centre.selectAll('text').data(lines, (d) => d.k).join('text').attr('class', (d) => d.cls).attr('dy', (d) => d.dy).style('font-size', (d) => (d.k === 'v' ? `${clamp(radius * 0.36, 18, 34)}px` : null)).text((d) => d.text);
  // direct labels outside each slice
  const lbl = f.layer('direct').attr('transform', `translate(${cx},${cy})`);
  const shown = slices.filter((s) => s.pct >= DONUT_MIN_LABEL_PCT);
  lbl.selectAll('text').data(shown, (d) => d.label).join('text').attr('class', 'ui-chart-direct').attr('fill', (d) => d.color).attr('dy', '0.35em')
    .each(function (d) {
      const mid = (d.start + d.end) / 2;
      const [x, y] = outer.centroid({ startAngle: mid, endAngle: mid });
      d3.select(this).attr('x', x).attr('y', y).attr('text-anchor', x < -4 ? 'end' : x > 4 ? 'start' : 'middle');
    }).text((d) => `${d.label} ${Math.round(d.pct * 100)}%`);
  f.layer('grid').selectAll('*').remove(); f.layer('axx').selectAll('*').remove(); f.layer('axy').selectAll('*').remove(); f.layer('axlabels').selectAll('*').remove();
}

/** heatmap. data: [{x, y, value}]; colour mixes the series colour into the card colour by value (so it follows the theme). */
export function drawHeatmap(f, o, series, anim) {
  const grid = heatGrid(o.cells ?? o.data, HEAT_STEPS);
  const fmt = valueFmt(o);
  const yw = Math.max(0, ...grid.ys.map((t) => textWidth(t)));
  const m = { top: 8, right: HEAT_KEY_W + 12, bottom: 30, left: Math.max(24, yw + 12) };
  const iw = Math.max(10, f.w - m.left - m.right);
  const ih = Math.max(10, f.h - m.top - m.bottom);
  const X = d3.scaleBand().domain(grid.xs).range([0, iw]).padding(HEAT_PAD);
  const Y = d3.scaleBand().domain(grid.ys).range([0, ih]).padding(HEAT_PAD);
  const mix = (v) => (grid.max > grid.min ? HEAT_MIN_MIX + ((v - grid.min) / (grid.max - grid.min)) * (100 - HEAT_MIN_MIX) : 55);
  const color = o.color ?? 'var(--ui-c1)';
  const fillOf = (d) => `color-mix(in srgb, ${color} ${mix(d.value)}%, var(--ui-card-hi))`;
  const marks = f.layer('marks').attr('transform', `translate(${m.left},${m.top})`);
  const cells = grid.cells.map((c) => ({ ...c, key: `${c.x}|${c.y}` }));
  const sel = marks.selectAll('rect.ui-mark').data(cells, (d) => d.key);
  const en = sel.enter().append('rect').attr('class', 'ui-mark').attr('rx', 3).attr('opacity', 0);
  const all = en.merge(sel).attr('x', (d) => X(d.x)).attr('y', (d) => Y(d.y)).attr('width', X.bandwidth()).attr('height', Y.bandwidth()).style('transition', 'fill .45s');
  all.style('fill', fillOf);
  tr(all, anim).attr('opacity', 1);
  sel.exit().remove();
  all.on('pointermove', (e, d) => f.showTip(e, `${d.x} / ${d.y}`, [{ color: fillOf(d), value: fmt(d.value) }])).on('pointerleave', () => f.hideTip());
  const roomy = X.bandwidth() >= HEAT_LABEL_MIN_W && Y.bandwidth() >= HEAT_LABEL_MIN_H;
  marks.selectAll('text.ui-chart-value').data(roomy ? cells : [], (d) => d.key).join('text').attr('class', 'ui-chart-value').attr('text-anchor', 'middle').attr('dy', '0.35em')
    .attr('x', (d) => X(d.x) + X.bandwidth() / 2).attr('y', (d) => Y(d.y) + Y.bandwidth() / 2)
    .style('fill', (d) => (mix(d.value) > 62 ? 'var(--ui-on-acc)' : 'var(--ui-fg)')).style('transition', 'fill .45s').text((d) => formatNumber(d.value, { compact: true }));
  // axes (band scales: plain labels, thinned to fit)
  const xs = f.layer('axx').attr('transform', `translate(${m.left},${m.top + ih})`);
  const xv = thinTicks(grid.xs, Math.max(0, ...grid.xs.map((t) => textWidth(t))), iw);
  xs.call(d3.axisBottom(X).tickValues(xv).tickSize(0));
  f.layer('axy').attr('transform', `translate(${m.left},${m.top})`).call(d3.axisLeft(Y).tickSize(0));
  f.layer('grid').selectAll('*').remove();
  // colour key: low .. high, the only legend (a colour scale needs one)
  const key = f.layer('direct').attr('transform', `translate(${m.left + iw + 12},${m.top})`);
  const steps = Array.from({ length: HEAT_STEPS }, (_, i) => i);
  key.selectAll('rect').data(steps).join('rect').attr('width', 14).attr('height', Math.max(8, (ih - 40) / HEAT_STEPS)).attr('y', (i) => 18 + i * Math.max(8, (ih - 40) / HEAT_STEPS))
    .style('fill', (i) => `color-mix(in srgb, ${color} ${HEAT_MIN_MIX + ((HEAT_STEPS - 1 - i) / (HEAT_STEPS - 1)) * (100 - HEAT_MIN_MIX)}%, var(--ui-card-hi))`);
  key.selectAll('text').data([{ t: formatNumber(grid.max, { compact: true }), y: 8 }, { t: formatNumber(grid.min, { compact: true }), y: 18 + HEAT_STEPS * Math.max(8, (ih - 40) / HEAT_STEPS) + 12 }]).join('text')
    .attr('class', 'ui-chart-axis-label').attr('y', (d) => d.y).text((d) => d.t);
  f.layer('axlabels').selectAll('*').remove();
}
