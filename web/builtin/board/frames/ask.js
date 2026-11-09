// ask: a question and up to 4 buttons. A click posts panel.emit('board.answer', {frame, option}) and marks the choice.
import { CAPS, capText } from '../board-logic.mjs';
import { h } from './dom.js';

export function render(el, f, ctx) {
  const options = (Array.isArray(f.options) ? f.options : []).map((o) => capText(o, CAPS.option)).filter(Boolean).slice(0, CAPS.options);
  const buttons = options.map((option, i) => h('button', { type: 'button', class: i === 0 ? 'primary' : '', text: option }));
  buttons.forEach((b, i) => b.addEventListener('click', () => {
    ctx.emit('board.answer', { frame: ctx.frameId, option: options[i] });
    for (const other of buttons) other.classList.toggle('chosen', other === b);
    el.firstChild.dataset.answered = 'true';
  }));
  el.append(h('div', { class: 'ask' }, h('p', { class: 'ask-q', text: capText(f.q, CAPS.question) }), h('div', { class: 'ask-options' }, buttons)));
}
