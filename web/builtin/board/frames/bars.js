// bars: horizontal bars growing from 0, one row per item (max 8), values written at the end of each bar.
import { CAPS, capText, safeColor } from '../board-logic.mjs';
import { PALETTE, h, nextPaint } from './dom.js';
import { fitStack } from './fit.js';

const list = (f) => (Array.isArray(f.items) ? f.items.filter((i) => i && typeof i === 'object').slice(0, CAPS.bars) : []);
const valueOf = (i) => (Number.isFinite(i.value) ? i.value : 0);
const fmt = (v, unit) => `${Number.isInteger(v) ? v.toLocaleString('en-US') : String(Math.round(v * 100) / 100)}${unit ? ` ${unit}` : ''}`;
const widthOf = (items, i) => `${Math.max(0, Math.min(100, (Math.max(0, valueOf(i)) / (Math.max(...items.map(valueOf), 0) || 1)) * 100))}%`;

const FIT_SHARE = 0.07;
const FIT_MAX_TIMES = 2.2;
const SPREAD_MAX_EM = 3;
const fits = new WeakMap(); // .bars root -> { stop, refit }

export function render(el, f, ctx) {
  const items = list(f);
  const unit = capText(f.unit, 8);
  const rows = items.map((it, i) => {
    const fill = h('i', { class: 'bar-fill', style: `background:${safeColor(it.color) ?? PALETTE[i % PALETTE.length]};width:${ctx.reduced ? widthOf(items, it) : '0%'}` });
    if (!ctx.reduced) nextPaint(() => { fill.style.width = widthOf(items, it); });
    return h('div', { class: 'bar-row' }, h('span', { class: 'bar-label', text: capText(it.label, CAPS.label) }), h('span', { class: 'bar-track' }, fill), h('b', { class: 'bar-value', text: fmt(valueOf(it), unit) }));
  });
  const grid = h('div', { class: 'bars-grid' }, rows);
  const root = h('div', { class: 'bars' }, grid);
  el.append(root);
  const stack = fitStack({ box: root, content: grid, share: FIT_SHARE, maxTimes: FIT_MAX_TIMES, maxSpreadEm: SPREAD_MAX_EM, rows: () => items.length, clamped: '.bar-label' });
  fits.set(root, stack);
  ctx.onDispose(stack.stop);
}

export function update(el, f) {
  const items = list(f);
  const rows = [...el.querySelectorAll('.bar-row')];
  if (rows.length !== items.length) return false;
  const unit = capText(f.unit, 8);
  items.forEach((it, i) => {
    rows[i].querySelector('.bar-label').textContent = capText(it.label, CAPS.label);
    rows[i].querySelector('.bar-value').textContent = fmt(valueOf(it), unit);
    const fill = rows[i].querySelector('.bar-fill');
    fill.style.width = widthOf(items, it);
    fill.style.background = safeColor(it.color) ?? PALETTE[i % PALETTE.length];
  });
  fits.get(el.querySelector('.bars'))?.refit();
  return true;
}
