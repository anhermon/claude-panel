// callout.js - a highlighted note: a tone, an optional title and a message.
import { h, build, addCss, setChildren } from './core.js';
import { TONES, isObj } from './pure.js';

addCss(`
.ui-callout { display: flex; gap: 12px; padding: 12px 14px; border-radius: var(--ui-r-s); --tone: var(--ui-acc);
  background: color-mix(in srgb, var(--tone) 12%, var(--ui-card)); border: 1px solid color-mix(in srgb, var(--tone) 38%, var(--ui-line)); }
.ui-callout-icon { flex: none; width: 22px; height: 22px; border-radius: 50%; display: grid; place-items: center; font-size: 13px; font-weight: 700;
  background: var(--tone); color: var(--ui-on-acc); margin-top: 1px; }
.ui-callout-title { font-weight: 600; color: var(--tone); }
.ui-callout-text { color: var(--ui-fg); overflow-wrap: anywhere; }
`);
const ICONS = Object.freeze({ neutral: 'i', info: 'i', ok: '✓', warn: '!', danger: '×' });

/** callout({tone: 'warn', title: 'Heads up', text: 'Quota at 90%'}) or callout('Plain note'). tone = info|ok|warn|danger|neutral. */
export function callout(input = '') {
  const opts = isObj(input) ? input : { text: input };
  const icon = h('span.ui-callout-icon', { 'aria-hidden': 'true' });
  const body = h('div');
  const el = h('div', { role: 'note' }, icon, body);
  return build(el, 'callout', opts, (o) => {
    const tone = TONES.includes(o.tone) ? o.tone : 'info';
    for (const t of TONES) el.classList.toggle(`ui-tone-${t}`, tone === t);
    icon.textContent = ICONS[tone];
    setChildren(body, o.title ? h('div.ui-callout-title', null, o.title) : null, h('div.ui-callout-text', null, o.text ?? '', o.children));
  });
}
