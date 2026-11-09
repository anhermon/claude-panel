// checks (one ticket's checklist): the verifier's verdict per check, each with a mark and its evidence line under it (cut to two
// lines, the full text in the title), a result badge, and the fix round the ticket is in.
import { fixRoundText, normalizeChecks } from '../router-frames-logic.mjs';
import { h } from './dom.js';
import { insightFrame } from './insight-dom.js';
import { markEl } from './router-dom.js';

const GLYPHS = Object.freeze({ pass: '✓', fail: '✕', pending: '○' });
const RESULT_TEXT = Object.freeze({ PASS: 'PASS', FAIL: 'FAIL' });
const PENDING_TEXT = 'Pending';
const stateOf = (pass) => (pass === true ? 'pass' : pass === false ? 'fail' : 'pending');

const rowEl = (it) => h('li', { class: 'ck-row', 'data-state': stateOf(it.pass) },
  markEl(stateOf(it.pass), GLYPHS),
  h('b', { class: 'ck-item', title: it.item, text: it.item }),
  it.evidence ? h('p', { class: 'ck-evidence', title: it.evidence, text: it.evidence }) : null);

export const { render, update } = insightFrame({
  name: 'checks',
  clamped: '.ck-item, .ck-evidence',
  paint(body, f) {
    const c = normalizeChecks(f);
    const state = c.result === 'PASS' ? 'pass' : c.result === 'FAIL' ? 'fail' : 'pending';
    body.append(
      h('div', { class: 'ck-head' },
        h('b', { class: 'ck-badge', 'data-state': state, text: RESULT_TEXT[c.result] ?? PENDING_TEXT }),
        h('span', { class: 'ck-count', text: `${c.passed} of ${c.items.length} checks passed` }),
        fixRoundText(c) ? h('span', { class: 'ck-round', text: fixRoundText(c) }) : null),
      h('ol', { class: 'ck-list' }, c.items.map(rowEl)));
  },
});
