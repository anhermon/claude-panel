// rings: animated progress rings (3-4 of them), the percentage in the middle, the label below.
import { CAPS, capTitle, pctOf, safeColor } from '../board-logic.mjs';
import { PALETTE, h, nextPaint } from './dom.js';

const R = 40;
const CIRC = 2 * Math.PI * R;
const items = (f) => (Array.isArray(f.items) ? f.items.slice(0, CAPS.rings) : []);
const offsetOf = (pct) => CIRC * (1 - (pct ?? 0) / 100);

function ring(item, i, ctx) {
  const pct = pctOf(item?.pct);
  const color = safeColor(item?.color) ?? PALETTE[i % PALETTE.length];
  const arc = h('circle', { class: 'ring-arc', cx: 50, cy: 50, r: R, 'stroke-dasharray': CIRC, 'stroke-dashoffset': ctx.reduced ? offsetOf(pct) : CIRC, style: `stroke:${color}` });
  if (!ctx.reduced) nextPaint(() => { arc.style.strokeDashoffset = offsetOf(pct); });
  return h('div', { class: 'ring' },
    h('div', { class: 'ring-disc' },
      h('svg', { viewBox: '0 0 100 100', 'aria-hidden': 'true' }, h('circle', { class: 'ring-track', cx: 50, cy: 50, r: R }), arc),
      h('span', { class: 'ring-num', text: pct === null ? '–' : String(Math.round(pct)) })), // html, so its size can have a px floor
    h('b', { class: 'ring-label', text: capTitle(item?.label, CAPS.label) }));
}

export function render(el, f, ctx) {
  el.append(h('div', { class: 'rings' }, items(f).map((it, i) => ring(it, i, ctx))));
}

export function update(el, f, ctx) {
  const rings = [...el.querySelectorAll('.ring')];
  const list = items(f);
  if (rings.length !== list.length) return false;
  list.forEach((it, i) => {
    const pct = pctOf(it?.pct);
    const arc = rings[i].querySelector('.ring-arc');
    arc.style.stroke = safeColor(it?.color) ?? PALETTE[i % PALETTE.length];
    arc.style.strokeDashoffset = offsetOf(pct);
    rings[i].querySelector('.ring-num').textContent = pct === null ? '–' : String(Math.round(pct));
    rings[i].querySelector('.ring-label').textContent = capTitle(it?.label, CAPS.label);
  });
  return true;
}
