// line: a line chart (1-3 series) whose paths draw themselves. Axis-light: three faint gridlines, the min and max
// written inside the plot, the last value at the end of each line. Plain SVG sized to its box (1 unit = 1 css px).
import { CAPS, capText, scaleSeries } from '../board-logic.mjs';
import { PALETTE, h, nextId, nextPaint, uiScale, watchSize } from './dom.js';

const PAD_TOP = 14;
const PAD_BOTTOM = 10; // room for half an axis label under the lowest gridline
const GUTTER = 52;
const PAD_LEFT = 6;
const LABEL_W = 62;
const DOT_R = 4.5;
const GRID = 3;
const DRAW_MS_CLASS = 'drawn';

const seriesOf = (f) => (Array.isArray(f.series) ? f.series.filter((s) => s && Array.isArray(s.points)).slice(0, CAPS.series) : []).map((s) => ({ label: capText(s.label, CAPS.label), points: s.points.filter(Number.isFinite).slice(-CAPS.points) }));
const fmt = (v) => (Math.abs(v) >= 100 ? Math.round(v).toLocaleString('en-US') : String(Math.round(v * 10) / 10));

function build(svg, list, w, h2, animate) {
  const u = uiScale();
  const GUTTER_PX = GUTTER * u;
  const LABEL_PX = LABEL_W * u;
  svg.replaceChildren();
  svg.setAttribute('viewBox', `0 0 ${w} ${h2}`);
  const all = list.flatMap((s) => s.points);
  if (all.length < 2) return;
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const plotW = w - LABEL_PX - GUTTER_PX;
  const box = { min: lo, max: hi, padX: PAD_LEFT, padY: 0 };
  const top = PAD_TOP * u;
  const plotH = h2 - top - PAD_BOTTOM * u;
  for (let g = 0; g <= GRID; g++) {
    const y = top + (plotH * g) / GRID;
    svg.append(h('line', { class: 'grid', x1: GUTTER_PX, x2: GUTTER_PX + plotW + PAD_LEFT, y1: y, y2: y }));
  }
  svg.append(h('text', { class: 'axis', x: GUTTER_PX - 8, y: top, text: fmt(hi) }), h('text', { class: 'axis', x: GUTTER_PX - 8, y: top + plotH, text: fmt(lo) }));
  const defs = h('defs');
  svg.append(defs);
  list.forEach((s, i) => {
    if (s.points.length < 2) return;
    const color = PALETTE[i % PALETTE.length];
    const xy = scaleSeries(s.points, plotW, plotH, { ...box }).map((p) => ({ x: p.x + GUTTER_PX, y: p.y + top }));
    const d = xy.map((p, k) => `${k ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    if (i === 0) {
      const gid = nextId('lg');
      defs.append(h('linearGradient', { id: gid, x1: 0, y1: 0, x2: 0, y2: 1 }, h('stop', { offset: '0%', 'stop-color': color, 'stop-opacity': 0.28 }), h('stop', { offset: '100%', 'stop-color': color, 'stop-opacity': 0 })));
      svg.append(h('path', { class: 'area', d: `${d} L${xy[xy.length - 1].x},${top + plotH} L${xy[0].x},${top + plotH} Z`, fill: `url(#${gid})` }));
    }
    const last = xy[xy.length - 1];
    svg.append(
      h('path', { class: 'curve', d, pathLength: '1', style: `stroke:${color}` }),
      h('circle', { class: 'end', cx: last.x, cy: last.y, r: DOT_R * u, style: `fill:${color}` }),
      h('text', { class: 'end-label', x: Math.min(last.x + 9 * u, w - 2), y: last.y, style: `fill:${color}`, text: fmt(s.points[s.points.length - 1]) }));
  });
  if (animate) nextPaint(() => svg.classList.add(DRAW_MS_CLASS));
  else svg.classList.add(DRAW_MS_CLASS);
}

export function render(el, f, ctx) {
  const list = seriesOf(f);
  const svg = h('svg', { class: 'line-svg', 'aria-hidden': 'true' });
  const legend = list.length > 1 ? h('div', { class: 'legend' }, list.map((s, i) => h('span', { style: `--c:${PALETTE[i % PALETTE.length]}`, text: s.label }))) : null;
  const wrap = h('div', { class: 'line' }, legend, h('div', { class: 'line-plot' }, svg));
  el.append(wrap);
  let first = true;
  const stop = watchSize(wrap.querySelector('.line-plot'), ({ w, h: ph }) => { build(svg, list, w, ph, first && !ctx.reduced); first = false; });
  ctx.onDispose(stop);
}
