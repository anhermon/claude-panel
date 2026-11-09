// timeline: a horizontal track, one dot per item, oldest to newest; the newest is highlighted.
import { CAPS, capText } from '../board-logic.mjs';
import { h, toneColor } from './dom.js';

export function render(el, f) {
  const items = (Array.isArray(f.items) ? f.items : []).filter((i) => i && typeof i === 'object').slice(-CAPS.timeline);
  el.append(h('ol', { class: 'timeline' }, items.map((it, i) => h('li', { class: `tl-item${i === items.length - 1 ? ' newest' : ''}`, style: toneColor(it.tone) ? `--tone:${toneColor(it.tone)}` : null },
    h('span', { class: 'tl-when', text: capText(it.when, CAPS.status) }),
    h('i', { class: 'tl-dot' }),
    h('span', { class: 'tl-text', text: capText(it.text, CAPS.item) })))));
}
