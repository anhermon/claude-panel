// Small shared drawing primitives; presentation options remain owned by custom.js.
import { addCss } from '../ui/core.js';
import { s, txt } from './core.js';
import { workBox } from './custom.js';
export const MIN_FONT = 12;
export const SHORT_HEIGHT = 340;
export const PLOT_HEIGHT = 180;
export const COMPACT_PLOT_HEIGHT = 120;
export const PAD = 12;
export const AXIS_BOTTOM = 34;
export const STROKE = 2;
export const HALF = 0.5;
export const ONE = 1;
export const ZERO = 0;
export const MS_PER_SECOND = 1000;
const TICK_PARTS = 4;
const CHAR_WIDTH_EM = 0.62;
const LABEL_GAP_PX = 10;
const DECIMALS = 2;
const MOTION_STATIC = 'static';
const MOTION_DATA = 'data';
export const measure = (n) => Number(n.toFixed(DECIMALS)).toString();
export const compact = (ctx) => ctx.narrow || (ctx.h > ZERO && ctx.h < SHORT_HEIGHT);
export function mediaBox(ctx) {
  const box = workBox(ctx);
  box.setAttribute('class', 'pa-work pa-media');
  if (compact(ctx)) box.setAttribute('data-narrow', '');
  box.setAttribute('data-motion', ctx.reduced ? MOTION_STATIC : MOTION_DATA);
  return box;
}
export function plot(box, w, height, label) {
  const svg = s('svg', { viewBox: `0 0 ${w} ${height}`, width: w, height, role: 'img', 'aria-label': label, class: 'pa-media-plot' });
  box.append(svg);
  return svg;
}
export function timeAxis(svg, { left, right, bottom, end, unit, fs, secondary }) {
  svg.append(s('line', { x1: left, x2: right, y1: bottom, y2: bottom, class: 'pa-axis' }));
  // Fewer ticks when the widest label would touch its neighbour (ms and frame units are wide).
  const size = Math.max(MIN_FONT, fs);
  const labelPx = `${measure(end)} ${unit}`.length * size * CHAR_WIDTH_EM + LABEL_GAP_PX;
  let parts = TICK_PARTS;
  while (parts > ONE && (right - left) / parts < labelPx) parts /= STROKE;
  for (let i = ZERO; i <= parts; i++) {
    const t = i / parts;
    const x = left + (right - left) * t;
    const anchor = i === ZERO ? 'start' : i === parts ? 'end' : 'middle';
    txt(svg, x, bottom + PAD, `${measure(end * t)} ${unit}`, { size: Math.max(MIN_FONT, fs), anchor });
    if (secondary) txt(svg, x, bottom + PAD * STROKE, secondary(end * t), { size: Math.max(MIN_FONT, fs), anchor, cls: 'pa-m' });
  }
}
addCss(`
.pa-media { gap:8px; font-size:max(12px,var(--ui-fs)); }
.pa-media .pa-work-head { font-size:1.1em; }
.pa-media[data-narrow] { gap:4px; }
.pa-media-plot { display:block; width:100%; flex-shrink:0; overflow:visible; }
.pa-media-legend { display:flex; flex-wrap:wrap; gap:4px 14px; }
.pa-media-item { border-left:3px solid var(--work-accent); padding:2px 8px; min-width:0; }
.pa-media[data-narrow] .pa-media-item { padding:1px 6px; }
.pa-media .pa-work-row { padding:6px; gap:2px; }
.pa-media[data-narrow] .pa-work-row { padding:4px; }
`);
