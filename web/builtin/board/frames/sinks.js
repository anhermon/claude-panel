// sinks (auto frame `time-sinks`): where all the agents' time went, ranked by kind of work. Each row: the kind, its share of the
// total ("41%" and its time), agents and tokens as small muted figures on the same line, and a bar. Under the rows the
// longest runs of one kind ("38 min writing logic · Fix parser (14 actions)").
import { normalizeSinks } from '../insight-frames-logic.mjs';
import { kindMeta } from '../kind-meta.mjs';
import { h } from './dom.js';
import { captionEl, footEl, insightFrame } from './insight-dom.js';

const NOTES_HEADING = 'Longest runs on one kind';

const rowEl = (it) => {
  const meta = kindMeta(it.k);
  return h('li', { class: 'sk-row', style: `--kc:${meta.color}` },
    h('i', { class: 'sk-glyph', text: meta.glyph }),
    h('span', { class: 'sk-name', title: it.text }, h('b', { class: 'sk-kind', text: meta.label }), it.meta ? h('span', { class: 'sk-meta', text: it.meta }) : null),
    h('span', { class: 'sk-fig' }, h('b', { class: 'sk-pct', text: `${it.pct}%` }), it.time ? h('span', { class: 'sk-time', text: it.time }) : null),
    h('div', { class: 'sk-bar', role: 'img', 'aria-label': `${meta.label} ${it.pct}% of agent time` }, h('i', { style: `width:${it.pct}%` })),
    it.time || it.meta ? null : h('p', { class: 'sk-text', text: it.text }));
};

export const { render, update } = insightFrame({
  name: 'sinks',
  clamped: '.sk-kind',
  paint(body, f) {
    const data = normalizeSinks(f);
    body.append(...[
      captionEl(data.caption),
      h('ol', { class: 'sk-list' }, data.items.map(rowEl)),
      footEl(data.foot),
      data.notes.length === 0 ? null : h('div', { class: 'sk-notes' }, h('b', { class: 'ix-sub', text: NOTES_HEADING }), h('ul', {}, data.notes.map((n) => h('li', { text: n })))),
    ].filter(Boolean));
  },
});
