// repeats (auto frame `repeats`): the same work done again and again. A small matrix: one row per file touched many times, one
// column per agent (numbered; the key under the matrix names them), each cell the number of times that agent read or edited the
// file, darker for more. Under it sentences about commands re-run, retries after a failure and tasks started more than once.
import { normalizeRepeats } from '../insight-frames-logic.mjs';
import { h } from './dom.js';
import { captionEl, footEl, insightFrame } from './insight-dom.js';

const KEY_JOIN = '   ';

const matrixEl = (data) => h('div', { class: 'rp-grid', style: `--cols:${data.cols.length}`, role: 'table' },
  h('span', { class: 'rp-corner', text: 'File' }),
  data.cols.map((_, i) => h('b', { class: 'rp-col', text: String(i + 1), title: data.cols[i] })),
  data.rows.flatMap((r) => [
    h('span', { class: 'rp-file' }, h('b', { text: r.label }), r.note ? h('span', { text: r.note }) : null),
    ...r.cells.map((n, i) => h('span', { class: 'rp-cell', 'data-level': r.levels[i], text: n > 0 ? String(n) : '' })),
  ]));

const keyEl = (cols) => h('p', { class: 'rp-key' }, cols.flatMap((c, i) => [i > 0 ? KEY_JOIN : null, h('span', { class: 'rp-key-item' }, h('b', { text: String(i + 1) }), ` ${c}`)]));

export const { render, update } = insightFrame({
  name: 'repeats',
  clamped: '.rp-file b',
  paint(body, f) {
    const data = normalizeRepeats(f);
    body.append(...[
      captionEl(data.caption),
      data.rows.length > 0 ? matrixEl(data) : null,
      data.rows.length > 0 ? keyEl(data.cols) : null,
      footEl(data.foot),
      data.notes.length === 0 ? null : h('ul', { class: 'rp-notes' }, data.notes.map((n) => h('li', { text: n }))),
    ].filter(Boolean));
  },
});
