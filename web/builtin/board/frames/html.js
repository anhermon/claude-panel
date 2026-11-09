// html: the freeform escape hatch. The text is run through sanitize.mjs (no scripts, no handlers, no remote urls,
// styles from an allow-list) and may hold a small inline <svg> picture.
import { sanitizeHtml } from '../sanitize.mjs';
import { h } from './dom.js';

export function render(el, f, ctx) {
  const box = h('div', { class: 'html' });
  box.innerHTML = sanitizeHtml(f.html, { idPrefix: `h-${ctx.frameId}-` });
  el.append(box);
}
