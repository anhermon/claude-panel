// tickets (router run): one row per ticket, in pipeline order. A row says the stage in words and colour, who works it, how many of
// its checks passed, and which fix round it is in. "Verified" (green tick) is only a done ticket with a PASS verdict; "claimed done,
// not verified" is amber and "blocked" red, so a claim never looks like a check. The header tells one story: "3 of 5 verified"
// (said once: a frame title that already says it is not repeated).
import { afterText, evalChipOf, LOOKS, normalizeTickets, proofText, roundText, verifiedText } from '../router-frames-logic.mjs';
import { h } from './dom.js';
import { insightFrame } from './insight-dom.js';
import './router-dom.js';

const chipEl = (cls, text, tone) => h('span', { class: `rt-chip ${cls}`, 'data-tone': tone, text });
const meterEl = (c) => h('span', { class: 'tk-meter', role: 'img', 'aria-label': `${c.pass} of ${c.total} checks passed` },
  h('span', { class: 'tk-bar' }, h('i', { style: `width:${(c.pass / c.total) * 100}%` })), h('b', { text: `${c.pass}/${c.total}` }));

const rowEl = (it) => {
  const look = LOOKS[it.look];
  const evalChip = evalChipOf(it);
  const proof = proofText(it);
  const meta = [
    evalChip ? chipEl('tk-eval', evalChip.text, evalChip.tone) : null,
    it.agent ? chipEl('tk-role', it.agent, 'mut') : null,
    it.checks ? meterEl(it.checks) : null,
    roundText(it) ? chipEl('tk-round', roundText(it), 'warn') : null,
    afterText(it) ? h('span', { class: 'tk-after', text: afterText(it) }) : null,
  ].filter(Boolean);
  const full = it.title;
  return h('li', { class: 'tk-row', 'data-look': it.look, 'data-tone': look.tone },
    h('i', { class: 'tk-mark', 'aria-hidden': 'true', text: look.mark }),
    h('b', { class: 'tk-title', title: full, text: full }),
    h('span', { class: 'tk-stage', text: look.label }),
    proof ? h('p', { class: 'tk-proof', title: it.proof.evidence || proof }, h('i', { 'aria-hidden': 'true', text: '✓' }), proof) : null,
    meta.length > 0 ? h('div', { class: 'tk-meta' }, meta) : null,
    it.note ? h('p', { class: 'tk-note', title: it.note, text: it.note }) : null);
};

const headEl = (s, title = '') => h('div', { class: 'tk-head' },
  title.includes(verifiedText(s)) ? null : h('b', { class: 'tk-story', 'data-all': s.total > 0 && s.verified === s.total ? 'yes' : 'no', text: verifiedText(s) }),
  s.unproven > 0 ? chipEl('tk-sum', `${s.unproven} unproven`, 'warn') : null,
  s.unverified > 0 ? chipEl('tk-sum', `${s.unverified} unverified`, 'warn') : null,
  s.blocked > 0 ? chipEl('tk-sum', `${s.blocked} blocked`, 'danger') : null,
  s.inflight > 0 ? chipEl('tk-sum', `${s.inflight} in flight`, 'acc') : null);

export const { render, update } = insightFrame({
  name: 'tickets',
  clamped: '.tk-title, .tk-note, .tk-proof',
  paint(body, f) {
    const data = normalizeTickets(f);
    body.append(headEl(data.summary, f.title), h('ol', { class: 'tk-list' }, data.items.map(rowEl)));
  },
});
