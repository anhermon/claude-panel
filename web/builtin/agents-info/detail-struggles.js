// The Struggles tab: one sentence in words, then what went wrong with the evidence (a quote), when, how often and whether it is still open,
// then, muted, what is NOT a problem (edits with no failure). Never a bare count.
import { h } from './dom.js';
import { clockShort } from './detail-logic.mjs';
import { KIND_WORD, OUTCOME_WORD, countText, struggleGroups, whenRange } from './detail-progress-logic.mjs';

function row(item) {
  const li = h('li', 'sg-row');
  li.dataset.outcome = item.outcome;
  li.dataset.kind = item.kind;
  const top = h('div', 'sg-top');
  top.append(h('span', 'sg-kind', KIND_WORD[item.kind]), h('b', 'sg-title', item.title));
  const n = countText(item.n);
  if (n) top.append(h('span', 'sg-n', n));
  top.append(h('span', `sg-chip ${item.outcome}`, OUTCOME_WORD[item.outcome]));
  li.append(top);
  if (item.evidence) li.append(h('code', 'sg-evidence', item.evidence));
  const foot = h('div', 'sg-foot');
  foot.append(h('time', 'sg-when', whenRange(item, clockShort)));
  if (item.hint) foot.append(h('span', 'sg-hint', `Next: ${item.hint}`));
  li.append(foot);
  return li;
}

export function renderStruggles(root, detail) {
  root.replaceChildren();
  const r = detail.struggles;
  const open = r.items.some((i) => i.outcome === 'open');
  const verdict = h('p', 'sg-verdict', r.headline || (r.items.length === 0 ? 'No failures.' : ''));
  verdict.dataset.level = open ? 'bad' : r.items.length > 0 ? 'warn' : 'ok';
  root.append(verdict);
  for (const g of struggleGroups(r)) {
    const sec = h('section', 'sg-group');
    sec.dataset.group = g.id;
    sec.append(h('h3', 'sg-group-head', g.title));
    const ul = h('ul', 'sg-list');
    for (const item of g.items) ul.append(row(item));
    sec.append(ul);
    root.append(sec);
  }
  if (r.calm.length > 0) {
    const sec = h('section', 'sg-group sg-calm');
    sec.append(h('h3', 'sg-group-head', 'Not a problem'));
    const ul = h('ul', 'sg-calm-list');
    for (const c of r.calm) ul.append(h('li', '', c.title));
    sec.append(ul);
    root.append(sec);
  }
}
