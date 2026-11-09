// now: what is happening right now. The pulsing dot lives in the frame header (board.js adds it for this type).
// Headline = the concrete activity (else the task title); under it the status chip with who is working and for how long,
// the last thing that finished, and the session's task as a small subtitle. The headline shrinks (to a floor) instead of clipping.
import { CAPS, capText } from '../board-logic.mjs';
import { h, watchSize } from './dom.js';
import { fitHeadline } from './fit.js';

const FIT_MARGIN_PX = 2;
const STATUS_TONE = { working: 'acc', waiting: 'warn', blocked: 'danger', failed: 'danger', done: 'ok', testing: 'cyan' };

export function render(el, f, ctx) {
  const status = capText(f.status, CAPS.status);
  const [who, since, last, sub] = [f.who, f.for, f.last, f.sub].map((v) => capText(v, CAPS.sub));
  const main = h('p', { class: 'text-main', text: capText(f.text, CAPS.text) });
  const facts = [who, since].filter(Boolean);
  const meta = (status || facts.length) && h('div', { class: 'now-meta' },
    status && h('span', { class: 'chip', 'data-tone': STATUS_TONE[status.toLowerCase()] ?? 'acc', text: status }),
    facts.length > 0 && h('span', { class: 'now-facts', text: facts.join(' · ') }));
  const lastEl = last && h('p', { class: 'now-last', text: last });
  const subEl = sub && h('p', { class: 'text-sub now-sub', text: sub });
  const body = h('div', { class: 'text-body' }, main, meta || null, lastEl, subEl);
  const root = h('div', { class: 'now' }, body);
  el.append(root);
  ctx.onDispose(fitHeadline(root, main));
  // still too tall with the headline at its floor: the subtitle goes first, then the last-finished line (the headline and the who/how long stay)
  ctx.onDispose(watchSize(root, () => {
    for (const part of [subEl, lastEl]) if (part) part.hidden = false;
    for (const part of [subEl, lastEl]) if (part && body.offsetHeight + FIT_MARGIN_PX > root.clientHeight) part.hidden = true;
  }));
}
