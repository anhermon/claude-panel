// chart-xy.js - bar (vertical/horizontal, grouped/stacked), line, area and scatter drawn with d3 joins so updates transition in place.
import * as d3 from 'd3';
import { dur, DUR, seriesColor } from './core.js';
import { inferKind, yExtent, spreadLabels, textWidth, clamp } from './pure.js';
import { drawAxes, margins, numFmt, valueFmt, thinTicks } from './chart-base.js';

const BAR_PAD = 0.25;
const SUB_PAD = 0.08;
const BAR_LABEL_MAX = 14; // bars up to this many get a value label
const DIRECT_GAP = 15;
const DIRECT_PAD = 10;
const DOT_R = 4;
const SCATTER_R = 5;
const POINT_LABEL_MAX = 16;
const LABEL_FIT_PX = 7;
const TIME_CLOCK_SPAN_MS = 3600000; // below this a time axis shows clock times with seconds

const keyX = (x) => (x instanceof Date ? +x : x);
const tr = (sel, anim) => (anim ? sel.transition().duration(dur(DUR.grow)) : sel);
const colorOf = (s, i) => seriesColor(i, s.color);

/** Direct labels (series names in their colour) at the right edge, pushed apart so they never overlap. */
function directLabels(f, items, x, lo, hi, anim) {
  const ys = spreadLabels(items.map((d) => d.y), DIRECT_GAP, lo, hi);
  const sel = f.layer('direct').selectAll('text').data(items.map((d, i) => ({ ...d, y: ys[i] })), (d) => d.name);
  const merged = sel.join((enter) => enter.append('text').attr('class', 'ui-chart-direct').attr('x', x).attr('y', (d) => d.y).attr('opacity', 0)).text((d) => d.name).attr('fill', (d) => d.color).attr('dy', '0.35em');
  tr(merged, anim).attr('x', x).attr('y', (d) => d.y).attr('opacity', 1);
  sel.exit().remove();
}
const clearDirect = (f) => f.layer('direct').selectAll('text').remove();

// ------------------------------------------------------------------------------------------------ bar
export function drawBar(f, o, series, anim) {
  const multi = series.length > 1;
  const horizontal = Boolean(o.horizontal) && !multi;
  const stacked = Boolean(o.stacked) && multi;
  const cats = [...new Set(series.flatMap((s) => s.points.map((p) => String(p.x))))];
  const [lo, hi] = yExtent(series, stacked);
  const fmt = valueFmt(o);
  const dirW = multi ? Math.max(...series.map((s) => textWidth(s.name))) + DIRECT_PAD : 0;
  const catW = Math.max(0, ...cats.map((c) => textWidth(c, LABEL_FIT_PX)));
  const ticks = numFmt(o.yFormat, o);
  const probe = d3.scaleLinear().domain([lo, hi]).nice();
  const m = horizontal ? margins(o, { left: clamp(catW + 14, 40, f.w * 0.4), right: 56 }) : margins(o, { yTexts: probe.ticks(5).map(ticks), right: 10 + dirW });
  const iw = Math.max(10, f.w - m.left - m.right);
  const ih = Math.max(10, f.h - m.top - m.bottom);
  const band = d3.scaleBand().domain(cats).range(horizontal ? [0, ih] : [0, iw]).padding(BAR_PAD);
  const val = d3.scaleLinear().domain([lo, hi]).nice().range(horizontal ? [0, iw] : [ih, 0]);
  const sub = d3.scaleBand().domain(series.map((_, i) => i)).range([0, band.bandwidth()]).padding(SUB_PAD);
  const base = val(Math.max(0, lo));
  const run = new Map();
  const rects = series.flatMap((s, si) => s.points.map((p) => {
    const cat = String(p.x);
    const start = stacked ? run.get(cat) ?? 0 : 0;
    if (stacked) run.set(cat, start + p.y);
    const v0 = start;
    const v1 = start + p.y;
    return { key: `${si}|${cat}`, cat, si, name: s.name, value: p.y, color: p.color ?? colorOf(s, si), v0, v1 };
  }));
  const geom = (d) => {
    const a = val(d.v0);
    const b = val(d.v1);
    const off = band(d.cat) + (multi && !stacked ? sub(d.si) : 0);
    const size = multi && !stacked ? sub.bandwidth() : band.bandwidth();
    return horizontal ? { x: Math.min(a, b), y: off, w: Math.abs(b - a), h: size } : { x: off, y: Math.min(a, b), w: size, h: Math.abs(b - a) };
  };
  const startGeom = (d) => { const g = geom(d); return horizontal ? { ...g, w: 0, x: base } : { ...g, h: 0, y: base }; };
  const marks = f.layer('marks').attr('transform', `translate(${m.left},${m.top})`);
  const sel = marks.selectAll('rect.ui-mark').data(rects, (d) => d.key);
  const enter = sel.enter().append('rect').attr('class', 'ui-mark').attr('rx', 3)
    .attr('x', (d) => startGeom(d).x).attr('y', (d) => startGeom(d).y).attr('width', (d) => startGeom(d).w).attr('height', (d) => startGeom(d).h);
  const all = enter.merge(sel).attr('fill', (d) => d.color);
  tr(all, anim).attr('x', (d) => geom(d).x).attr('y', (d) => geom(d).y).attr('width', (d) => geom(d).w).attr('height', (d) => geom(d).h);
  sel.exit().remove();
  all.on('pointermove', (e, d) => { f.showTip(e, d.cat, [{ color: d.color, label: multi ? d.name : '', value: fmt(d.value) }]); })
    .on('pointerleave', () => f.hideTip());
  // value labels (single series, few bars)
  const labelData = !multi && cats.length <= BAR_LABEL_MAX ? rects : [];
  const lab = marks.selectAll('text.ui-chart-value').data(labelData, (d) => d.key);
  const labPos = (d) => { const g = geom(d); return horizontal ? { x: g.x + g.w + 6, y: g.y + g.h / 2, a: 'start' } : { x: g.x + g.w / 2, y: d.value >= 0 ? g.y - 6 : g.y + g.h + 14, a: 'middle' }; };
  const labAll = lab.join((en) => en.append('text').attr('class', 'ui-chart-value').attr('opacity', 0).attr('x', (d) => labPos(d).x).attr('y', (d) => labPos(d).y)).attr('text-anchor', (d) => labPos(d).a).attr('dy', horizontal ? '0.35em' : null).text((d) => fmt(d.value));
  tr(labAll, anim).attr('x', (d) => labPos(d).x).attr('y', (d) => labPos(d).y).attr('opacity', 1);
  // axes
  const catValues = horizontal ? undefined : thinTicks(cats, catW, iw);
  drawAxes(f, { xs: horizontal ? val : band, ys: horizontal ? band : val, m, iw, ih, grid: horizontal ? 'x' : 'y', xFmt: horizontal ? ticks : undefined, yFmt: horizontal ? undefined : ticks, xValues: catValues, noX: false }, o, anim);
  // direct series labels at the last category
  if (multi && !horizontal) {
    const last = cats[cats.length - 1];
    const items = series.map((s, si) => {
      const r = rects.find((d) => d.si === si && d.cat === last);
      if (!r) return null;
      const g = geom(r);
      return { name: s.name, color: colorOf(s, si), y: m.top + g.y + (stacked ? g.h / 2 : 0) };
    }).filter(Boolean);
    directLabels(f, items, m.left + iw + 8, m.top, m.top + ih, anim);
  } else clearDirect(f);
  f.layer('overlay').selectAll('*').remove();
}

// ------------------------------------------------------------------------------------------------ line / area
export function drawLine(f, o, series, anim, withArea) {
  const all = series.flatMap((s) => s.points);
  const kind = inferKind(all.map((p) => p.x));
  const fmt = valueFmt(o);
  const ys = all.map((p) => p.y);
  const lo = withArea ? Math.min(0, ...ys) : (o.yMin ?? Math.min(...ys));
  const hi = o.yMax ?? Math.max(...ys);
  const probe = d3.scaleLinear().domain([lo, hi]).nice();
  const ticks = numFmt(o.yFormat, o);
  const dirW = Math.max(...series.map((s) => textWidth(s.name)), 0) + DIRECT_PAD;
  const showDirect = series.length > 1 || (series[0]?.name && o.label !== false);
  const m = margins(o, { yTexts: probe.ticks(5).map(ticks), right: showDirect ? Math.min(f.w * 0.3, dirW + 10) : 14 });
  const iw = Math.max(10, f.w - m.left - m.right);
  const ih = Math.max(10, f.h - m.top - m.bottom);
  const cats = [...new Set(all.map((p) => String(p.x)))];
  const X = kind === 'time' ? d3.scaleTime().domain(d3.extent(all, (p) => p.x)).range([0, iw])
    : kind === 'num' ? d3.scaleLinear().domain(d3.extent(all, (p) => p.x)).range([0, iw]) : d3.scalePoint().domain(cats).range([0, iw]).padding(0.4);
  const Y = d3.scaleLinear().domain([lo, hi]).nice().range([ih, 0]);
  const px = (p) => X(kind === 'cat' ? String(p.x) : p.x);
  const curve = o.smooth ? d3.curveMonotoneX : d3.curveLinear;
  const line = d3.line().defined((p) => Number.isFinite(p.y)).x(px).y((p) => Y(p.y)).curve(curve);
  const area = d3.area().defined((p) => Number.isFinite(p.y)).x(px).y0(Y(Math.max(0, lo))).y1((p) => Y(p.y)).curve(curve);
  const marks = f.layer('marks').attr('transform', `translate(${m.left},${m.top})`);
  const groups = marks.selectAll('g.ui-series').data(series.map((s, i) => ({ ...s, color: colorOf(s, i), id: s.name || String(i) })), (d) => d.id);
  const en = groups.enter().append('g').attr('class', 'ui-series');
  if (withArea) en.append('path').attr('class', 'ui-area').attr('opacity', 0);
  en.append('path').attr('class', 'ui-line').attr('fill', 'none').attr('stroke-width', 2.25).attr('stroke-linejoin', 'round').attr('stroke-linecap', 'round').attr('opacity', 0);
  en.append('circle').attr('class', 'ui-end').attr('r', DOT_R);
  const g = en.merge(groups);
  // first draw fades the path in; later draws morph `d` (the transition interpolates the path string)
  const setPath = (node, d, anim2) => {
    const p = d3.select(node);
    const first = !p.attr('d');
    if (first) p.attr('d', d).transition().duration(dur(DUR.grow)).attr('opacity', 1);
    else tr(p, anim2).attr('d', d).attr('opacity', 1);
  };
  g.select('path.ui-line').attr('stroke', (d) => d.color).each(function (d) { setPath(this, line(d.points), anim); });
  if (withArea) g.select('path.ui-area').attr('fill', (d) => d.color).attr('fill-opacity', 0.16).each(function (d) { setPath(this, area(d.points), anim); });
  g.select('circle.ui-end').attr('fill', (d) => d.color).each(function (d) {
    const last = [...d.points].reverse().find((p) => Number.isFinite(p.y));
    if (last) tr(d3.select(this), anim).attr('cx', px(last)).attr('cy', Y(last.y)).attr('opacity', 1); else d3.select(this).attr('opacity', 0);
  });
  groups.exit().remove();
  const span = kind === 'time' ? X.domain()[1] - X.domain()[0] : 0;
  const xFmt = kind === 'cat' ? undefined : o.xFormat ?? (kind === 'time' && span < TIME_CLOCK_SPAN_MS ? d3.timeFormat('%H:%M:%S') : undefined);
  drawAxes(f, { xs: X, ys: Y, m, iw, ih, grid: 'y', xFmt, yFmt: ticks, xValues: kind === 'cat' ? thinTicks(cats, Math.max(...cats.map((c) => textWidth(c))), iw) : undefined }, o, anim);
  if (showDirect) {
    const items = series.map((s, i) => { const last = [...s.points].reverse().find((p) => Number.isFinite(p.y)); return last ? { name: s.name || String(o.unit ?? ''), color: colorOf(s, i), y: m.top + Y(last.y) } : null; }).filter((d) => d && d.name);
    directLabels(f, items, m.left + iw + 10, m.top, m.top + ih, anim);
  } else clearDirect(f);
  // hover: nearest x across all series
  const xsAll = [...new Map(all.map((p) => [keyX(p.x), p])).values()].sort((a, b) => px(a) - px(b));
  const overlay = f.layer('overlay').attr('transform', `translate(${m.left},${m.top})`);
  overlay.selectAll('*').remove();
  const guide = overlay.append('line').attr('class', 'ui-guide').attr('y1', 0).attr('y2', ih).attr('stroke', 'var(--ui-line-hi)').attr('opacity', 0);
  const dots = overlay.append('g');
  const hit = overlay.append('rect').attr('width', iw).attr('height', ih).attr('fill', 'transparent');
  hit.on('pointermove', (e) => {
    const [mx] = d3.pointer(e);
    const near = xsAll.reduce((best, p) => (Math.abs(px(p) - mx) < Math.abs(px(best) - mx) ? p : best), xsAll[0]);
    if (!near) return;
    const rows = series.map((s, i) => ({ s, i, p: s.points.find((q) => keyX(q.x) === keyX(near.x)) })).filter((r) => r.p && Number.isFinite(r.p.y));
    guide.attr('x1', px(near)).attr('x2', px(near)).attr('opacity', 1);
    dots.selectAll('circle').data(rows).join('circle').attr('r', DOT_R + 1).attr('cx', px(near)).attr('fill', (r) => colorOf(r.s, r.i)).attr('stroke', 'var(--ui-card)').attr('cy', (r) => Y(r.p.y));
    const title = near.x instanceof Date ? near.x.toLocaleString() : o.xFormat ? o.xFormat(near.x) : String(near.x);
    f.showTip(e, title, rows.map((r) => ({ color: colorOf(r.s, r.i), label: r.s.name, value: fmt(r.p.y) })));
  }).on('pointerleave', () => { guide.attr('opacity', 0); dots.selectAll('*').remove(); f.hideTip(); });
}

// ------------------------------------------------------------------------------------------------ scatter
export function drawScatter(f, o, series, anim) {
  const all = series.flatMap((s) => s.points);
  const kind = inferKind(all.map((p) => p.x));
  const fmt = valueFmt(o);
  const ticks = numFmt(o.yFormat, o);
  const ysx = d3.extent(all, (p) => p.y);
  const probe = d3.scaleLinear().domain(ysx).nice();
  const multi = series.length > 1;
  const m = margins(o, { yTexts: probe.ticks(5).map(ticks), right: multi ? Math.min(f.w * 0.3, Math.max(...series.map((s) => textWidth(s.name))) + 20) : 14 });
  const iw = Math.max(10, f.w - m.left - m.right);
  const ih = Math.max(10, f.h - m.top - m.bottom);
  const X = (kind === 'time' ? d3.scaleTime() : d3.scaleLinear()).domain(d3.extent(all, (p) => (kind === 'cat' ? 0 : p.x))).range([0, iw]);
  if (kind !== 'time') X.nice();
  const Y = d3.scaleLinear().domain(ysx).nice().range([ih, 0]);
  const pts = series.flatMap((s, si) => s.points.map((p, i) => ({ ...p, si, name: s.name, color: p.color ?? colorOf(s, si), key: `${si}|${i}` })));
  const marks = f.layer('marks').attr('transform', `translate(${m.left},${m.top})`);
  const sel = marks.selectAll('circle.ui-mark').data(pts, (d) => d.key);
  const en = sel.enter().append('circle').attr('class', 'ui-mark').attr('r', 0).attr('cx', (d) => X(d.x)).attr('cy', (d) => Y(d.y)).attr('fill-opacity', 0.78);
  const mergedSel = en.merge(sel).attr('fill', (d) => d.color).attr('stroke', (d) => d.color);
  tr(mergedSel, anim).attr('cx', (d) => X(d.x)).attr('cy', (d) => Y(d.y)).attr('r', (d) => d.r ?? o.r ?? SCATTER_R);
  sel.exit().remove();
  mergedSel.on('pointermove', (e, d) => f.showTip(e, d.label ?? (multi ? d.name : ''), [{ color: d.color, label: `${o.xName ?? 'x'} ${o.xFormat ? o.xFormat(d.x) : d.x instanceof Date ? d.x.toLocaleDateString() : d.x}`, value: `${o.yName ?? 'y'} ${fmt(d.y)}` }]))
    .on('pointerleave', () => f.hideTip());
  const pl = pts.length <= POINT_LABEL_MAX && o.labels !== false ? pts.filter((d) => d.label) : [];
  marks.selectAll('text.ui-chart-value').data(pl, (d) => d.key).join('text').attr('class', 'ui-chart-value').attr('x', (d) => X(d.x) + 8).attr('y', (d) => Y(d.y)).attr('dy', '0.35em').text((d) => d.label);
  drawAxes(f, { xs: X, ys: Y, m, iw, ih, grid: 'y', xFmt: o.xFormat ?? (kind === 'time' ? undefined : numFmt(null, {})), yFmt: ticks }, o, anim);
  if (multi) {
    const items = series.map((s, si) => { const ys = s.points.map((p) => p.y); return ys.length ? { name: s.name, color: colorOf(s, si), y: m.top + Y(d3.mean(ys)) } : null; }).filter(Boolean);
    directLabels(f, items, m.left + iw + 10, m.top, m.top + ih, anim);
  } else clearDirect(f);
  f.layer('overlay').selectAll('*').remove();
}
