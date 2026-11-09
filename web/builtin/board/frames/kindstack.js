// kindstack (auto frame `time-by-kind`): one stacked bar per agent, split by KIND of work. The slices are as wide as the time
// they stand for (longest kind first); a slice wide enough carries its kind's word, and under the bar the three biggest kinds
// say their time in words ("Logic 14 min 3 s"). The agent's total time and tokens are on the line above. A key of the colours
// closes the frame. Everything it says is data the mod measured; the page only draws it (insight-frames-logic.mjs).
import { normalizeKindStack } from '../insight-frames-logic.mjs';
import { kindMeta } from '../kind-meta.mjs';
import { h } from './dom.js';
import { captionEl, footEl, insightFrame, kindKeyEl } from './insight-dom.js';

const DETAIL_JOIN = ' · ';

const sliceEl = (s) => h('i', { class: 'ks-slice', style: `flex:${s.s} 1 0;--kc:${kindMeta(s.k).color}`, title: `${kindMeta(s.k).label} ${s.text}`, 'data-k': s.k }, s.showLabel ? h('span', { text: kindMeta(s.k).label }) : null);

const detailEl = (it) => h('p', { class: 'ks-detail' },
  it.detail.flatMap((s, i) => [i > 0 ? DETAIL_JOIN : null, h('span', { class: 'ks-d', style: `--kc:${kindMeta(s.k).color}` }, h('i', { text: kindMeta(s.k).glyph }), `${kindMeta(s.k).label} ${s.text}`)]),
  it.more > 0 ? `${DETAIL_JOIN}+${it.more} more` : null,
  it.tokens ? h('span', { class: 'ks-tok', text: `${DETAIL_JOIN}${it.tokens}` }) : null);

const rowEl = (it) => h('li', { class: 'ks-row' },
  h('b', { class: 'ks-name', text: it.label }),
  h('span', { class: 'ks-total', text: it.total }),
  h('div', { class: 'ks-bar', role: 'img', 'aria-label': `${it.label}: ${it.detail.map((s) => `${kindMeta(s.k).label} ${s.text}`).join(', ')}` }, it.segs.map(sliceEl)),
  detailEl(it));

export const { render, update } = insightFrame({
  name: 'kindstack',
  clamped: '.ks-name',
  paint(body, f) {
    const data = normalizeKindStack(f);
    body.append(...[captionEl(data.caption), h('ol', { class: 'ks-list' }, data.items.map(rowEl)), kindKeyEl(data.kinds), footEl(data.foot)].filter(Boolean));
  },
});
