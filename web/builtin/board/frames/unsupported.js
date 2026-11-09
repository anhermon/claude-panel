// unsupported: a quiet tile for a frame type this board does not know. Never an error.
import { capText } from '../board-logic.mjs';
import { h } from './dom.js';

export function render(el, f) {
  el.append(h('div', { class: 'unsupported' }, h('span', { text: `unsupported frame${f.type ? `: ${capText(f.type, 24)}` : ''}` })));
}
