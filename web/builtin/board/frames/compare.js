// compare: two columns (before / after, us / them), at most 4 short items each.
import { CAPS, capText } from '../board-logic.mjs';
import { h } from './dom.js';

function side(data, cls) {
  const d = data && typeof data === 'object' ? data : {};
  const items = (Array.isArray(d.items) ? d.items : []).slice(0, CAPS.compare);
  return h('section', { class: `cmp-side ${cls}` },
    h('h3', { text: capText(d.title, CAPS.label) }),
    h('ul', {}, items.map((t) => h('li', { text: capText(t, CAPS.item) }))));
}

export function render(el, f) {
  el.append(h('div', { class: 'compare' }, side(f.left, 'left'), h('i', { class: 'cmp-arrow', 'aria-hidden': 'true', text: '→' }), side(f.right, 'right')));
}
