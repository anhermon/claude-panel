// steps: a checklist with its progress in the header ("2 of 5 done" + a thin bar). todo = empty ring, doing = pulsing accent ring
// (with the owner and the time under it when the data says them), done = a muted one-liner with a green check (drawn in), failed = red cross.
// An open item wraps to 2 lines; the font grows when there are few items and shrinks (to the text floor) when there are many.
import { CAPS, capText } from '../board-logic.mjs';
import { h } from './dom.js';
import { fitStack } from './fit.js';

const STATES = ['todo', 'doing', 'done', 'failed'];
const ICONS = {
  done: 'M5 10.5 L8.5 14 L15 6.5',
  failed: 'M6 6 L14 14 M14 6 L6 14',
};
const FIT_SHARE = 0.08;
const FIT_MAX_TIMES = 1.2; // body text: readable, never poster-sized (the card scrolls when the list still overflows)
const SPREAD_MAX_EM = 0.9;
const PCT = 100;

export function render(el, f, ctx) {
  const items = (Array.isArray(f.items) ? f.items : []).filter((i) => i && typeof i === 'object').slice(0, CAPS.steps);
  const states = items.map((it) => (STATES.includes(it.state) ? it.state : 'todo'));
  const doneCount = states.filter((s) => s === 'done').length;
  const owner = [capText(f.owner, CAPS.title), capText(f.since, CAPS.label)].filter(Boolean).join(' · ');
  const doingAt = states.indexOf('doing');
  const list = h('ol', { class: 'steps-list' }, items.map((it, i) => {
    const state = states[i];
    return h('li', { class: 'step', 'data-state': state },
      h('i', { class: 'step-icon' }, ICONS[state] ? h('svg', { viewBox: '0 0 20 20', 'aria-hidden': 'true' }, h('path', { d: ICONS[state], pathLength: '1' })) : null),
      h('span', { class: 'step-body' },
        h('span', { class: 'step-text', text: capText(it.t, CAPS.stepItem) }),
        i === doingAt && owner ? h('span', { class: 'step-owner', text: owner }) : null));
  }));
  const head = items.length > 0 && h('div', { class: 'steps-head' },
    h('span', { class: 'steps-count', text: `${doneCount} of ${items.length} done` }),
    h('span', { class: 'steps-bar' }, h('i', { style: `width:${Math.round((doneCount / items.length) * PCT)}%` })));
  const body = h('div', { class: 'steps-body' }, head || null, list);
  const root = h('div', { class: 'steps' }, body);
  el.append(root);
  const stack = fitStack({ box: root, content: body, share: FIT_SHARE, maxTimes: FIT_MAX_TIMES, maxSpreadEm: SPREAD_MAX_EM, rows: () => items.length, clamped: '.step-text' });
  ctx.onDispose(stack.stop);
}
