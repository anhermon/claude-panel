// image: a picture, contain-fit, with an optional caption. src is a path inside the scene or a data:image URL.
import { CAPS, capText, safeImageSrc } from '../board-logic.mjs';
import { h } from './dom.js';

export function render(el, f) {
  const src = safeImageSrc(f.src);
  const caption = capText(f.caption, CAPS.sub);
  const img = src ? h('img', { src, alt: caption || 'image', draggable: 'false' }) : null;
  const box = h('figure', { class: 'image' }, img ?? h('span', { class: 'image-missing', text: 'image unavailable' }), caption && h('figcaption', { text: caption }));
  img?.addEventListener('error', () => img.replaceWith(h('span', { class: 'image-missing', text: 'image unavailable' })));
  el.append(box);
}
