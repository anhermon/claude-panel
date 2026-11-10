// html: the freeform escape hatch. The text is run through sanitize.mjs (no scripts, no handlers, no remote urls,
// styles from an allow-list) and may hold a small inline <svg> picture and https links. The board iframe is sandboxed
// without allow-popups, so a click on a link is not followed here: it is handed to the page ({type:"panel-open"}),
// which opens the url in a new tab.
import { sanitizeHtml } from '../sanitize.mjs';
import { h } from './dom.js';

export function render(el, f, ctx) {
  const box = h('div', { class: 'html' });
  box.innerHTML = sanitizeHtml(f.html, { idPrefix: `h-${ctx.frameId}-` });
  box.addEventListener('click', (e) => {
    const a = e.target.closest?.('a[href]');
    if (!a) return;
    e.preventDefault();
    parent.postMessage({ type: 'panel-open', url: a.getAttribute('href') }, '*');
  });
  el.append(box);
}
