// badge.js - small status pill with an optional dot.
import { h, build, addCss, flash } from './core.js';
import { TONES, isObj } from './pure.js';

addCss(`
.ui-badge { display: inline-flex; align-items: center; gap: 6px; padding: 2px 10px; border-radius: 99px; font-size: var(--ui-fs-s); font-weight: 600; line-height: 1.5;
  --tone: var(--ui-mut); color: var(--tone); background: color-mix(in srgb, var(--tone) 14%, transparent); border: 1px solid color-mix(in srgb, var(--tone) 40%, transparent); white-space: nowrap; }
.ui-badge-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--tone); }
.ui-badge[data-live] .ui-badge-dot { animation: ui-badge-pulse 1.4s ease-in-out infinite; }
@keyframes ui-badge-pulse { 50% { opacity: .35; } }
`);

/** badge('Running') or badge({text, tone: 'ok', dot: true, live: true}): pill; live pulses the dot while something is in progress. e.g. badge({text: 'Failed', tone: 'danger'}) */
export function badge(input = '') {
  const opts = isObj(input) ? input : { text: input };
  const dot = h('span.ui-badge-dot');
  const label = h('span');
  const el = h('span', null, dot, label);
  return build(el, 'badge', opts, (o, prev) => {
    if (prev && prev.text !== o.text) flash(el);
    label.textContent = o.text ?? '';
    dot.hidden = !o.dot && !o.live;
    el.toggleAttribute('data-live', Boolean(o.live));
    for (const t of TONES) el.classList.toggle(`ui-tone-${t}`, o.tone === t);
  });
}
/** pill is an alias of badge. */
export const pill = badge;
