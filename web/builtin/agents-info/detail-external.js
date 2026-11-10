// The Metrics facts of a run of another harness that has a rollout (see detail-external-logic.mjs): the token split as one stacked bar with its
// numbers, the context against the model's window as a meter, then the labelled facts (model, task time, limits, cost: "not measured" and why).
// Data arrived scrubbed from the host.
import { h } from './dom.js';
import { harnessWord } from './detail-run-logic.mjs';
import { externalRows, percentText, tokenParts } from './detail-external-logic.mjs';

const PERCENT = 100;
const MIN_BAR_PCT = 1.5;

export function tokenBar(t) {
  const wrap = h('div', 'x-tokens');
  const bar = h('div', 'x-bar');
  bar.setAttribute('role', 'img');
  const parts = tokenParts(t);
  bar.setAttribute('aria-label', parts.map((p) => `${p.text} ${p.label}`).join(', '));
  const legend = h('ul', 'x-legend');
  for (const p of parts) {
    const seg = h('i');
    seg.dataset.part = p.key;
    seg.style.width = `${Math.max(MIN_BAR_PCT, p.share * PERCENT)}%`;
    bar.append(seg);
    const li = h('li');
    li.dataset.part = p.key;
    li.append(h('b', '', p.text), h('span', '', p.label));
    legend.append(li);
  }
  wrap.append(bar, legend);
  return wrap;
}

function contextMeter(c) {
  const wrap = h('div', 'x-context');
  const track = h('span', 'x-meter');
  const fill = h('i');
  fill.style.width = `${Math.max(MIN_BAR_PCT, (c.share ?? 0) * PERCENT)}%`;
  track.setAttribute('role', 'img');
  track.setAttribute('aria-label', c.share === null ? 'peak context' : `peak context ${percentText(c.share)} of the window`);
  track.append(fill);
  wrap.append(track);
  return wrap;
}

/** The node of one run's rollout facts; `ext` is a normalized `external` (normalizeExternal). */
export function renderExternal(ext, now) {
  const sec = h('section', 'm-sec x-sec');
  sec.append(h('h3', 'm-head', `${harnessWord(ext.harness) || 'Agent'} run`));
  if (ext.tokens !== null) sec.append(tokenBar(ext.tokens));
  if (ext.context !== null && ext.context.window !== null) sec.append(contextMeter(ext.context));
  const dl = h('dl', 'm-standing x-facts');
  for (const [label, value] of externalRows(ext, now)) dl.append(h('dt', '', label), h('dd', '', value));
  sec.append(dl);
  return sec;
}
