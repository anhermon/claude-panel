// hints (auto frame `improve`): up to four suggestions, each a small card: the measured fact with its number (bold) and what to
// change (a short action); the setting that fired it is the hover text. A card exists only when its rule was met.
import { normalizeHints } from '../insight-frames-logic.mjs';
import { h } from './dom.js';
import { captionEl, footEl, insightFrame } from './insight-dom.js';

// one card = the measured fact (bold), then what to do; the rule that fired is the hover text
const cardEl = (it) => h('li', { class: 'hn-card', title: it.rule },
  it.evidence ? h('p', { class: 'hn-evidence', text: it.evidence }) : null,
  h('p', { class: 'hn-text', text: it.text }));

export const { render, update } = insightFrame({
  name: 'hints',
  clamped: '.hn-text',
  paint(body, f) {
    const data = normalizeHints(f);
    body.append(...[captionEl(data.caption), h('ol', { class: 'hn-list' }, data.items.map(cardEl)), footEl(data.foot)].filter(Boolean));
  },
});
