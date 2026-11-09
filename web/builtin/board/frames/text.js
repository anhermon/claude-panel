// text: one big sentence (and an optional smaller line under it). The headline shrinks (to a floor) so both always fit.
import { CAPS, capText } from '../board-logic.mjs';
import { h } from './dom.js';
import { fitHeadline } from './fit.js';

const SHORT_MAX = 32;
const MID_MAX = 60;

export function render(el, f, ctx) {
  const text = capText(f.text, CAPS.text);
  const sub = capText(f.sub, CAPS.sub);
  const bucket = text.length <= SHORT_MAX ? 'short' : text.length <= MID_MAX ? 'mid' : 'long';
  const main = h('p', { class: 'text-main', text });
  const root = h('div', { class: 'text', 'data-len': bucket }, h('div', { class: 'text-body' }, main, sub && h('p', { class: 'text-sub', text: sub })));
  el.append(root);
  ctx.onDispose(fitHeadline(root, main));
}
