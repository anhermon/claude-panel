// <p-timeline><li data-when="2019" data-tone="ok|warn|danger">What happened</li>...</p-timeline> - vertical timeline whose line and items animate in when shown.
import { PanelElement, el } from './base.js';

const STAGGER_MS = 140;

export class PTimeline extends PanelElement {
  async setup() {
    const items = this.kids.filter((k) => k.tagName === 'LI');
    if (!items.length) throw new Error('add <li data-when="..."> children');
    const list = el('ol', { className: 'p-tl' });
    items.forEach((li, i) => {
      li.classList.add('p-tl-item');
      li.style.setProperty('--d', `${i * STAGGER_MS}ms`);
      const when = li.dataset.when;
      if (when) li.prepend(el('time', { className: 'p-tl-when', textContent: when }));
      if (li.dataset.tone) li.dataset.tone = li.dataset.tone.replace(/[^a-z]/g, '');
      list.append(li);
    });
    this.append(list);
    this.own(() => { for (const li of items) { li.querySelector(':scope > .p-tl-when')?.remove(); li.classList.remove('p-tl-item'); } });
    this.watchActive((active) => {
      list.classList.remove('in');
      if (active) requestAnimationFrame(() => requestAnimationFrame(() => list.classList.add('in'))); // re-arm so the animation replays
    });
  }
}
