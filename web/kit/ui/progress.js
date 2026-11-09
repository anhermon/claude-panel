// progress.js - progress (one bar) and steps (a checklist/stepper with todo|doing|done|failed states).
import { h, build, addCss, counter } from './core.js';
import { progressFraction, STEP_STATES, TONES, toArray } from './pure.js';

const PERCENT = 100;

addCss(`
.ui-progress { display: flex; flex-direction: column; gap: 6px; --tone: var(--ui-acc); }
.ui-progress-head { display: flex; justify-content: space-between; gap: 12px; font-size: var(--ui-fs); }
.ui-progress-label { color: var(--ui-fg); overflow-wrap: anywhere; }
.ui-progress-text { color: var(--ui-mut); font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; }
.ui-progress-track { height: 10px; border-radius: 99px; background: var(--ui-line); overflow: hidden; }
.ui-progress-fill { height: 100%; width: 0; border-radius: 99px; background: var(--tone); transition: width .6s var(--ui-ease), background .4s; }
.ui-steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0; }
.ui-steps li { display: grid; grid-template-columns: 24px 1fr; column-gap: 12px; position: relative; padding-bottom: 14px; --tone: var(--ui-dim); }
.ui-steps li:last-child { padding-bottom: 0; }
.ui-steps li::before { content: ""; position: absolute; left: 11px; top: 24px; bottom: 0; width: 2px; background: var(--ui-line-hi); }
.ui-steps li:last-child::before { display: none; }
.ui-step-dot { width: 24px; height: 24px; border-radius: 50%; display: grid; place-items: center; font-size: 13px; font-weight: 700; border: 2px solid var(--tone); color: var(--ui-on-acc);
  background: transparent; transition: background .3s, border-color .3s; position: relative; }
.ui-steps li[data-state="doing"] { --tone: var(--ui-acc); }
.ui-steps li[data-state="done"] { --tone: var(--ui-ok); }
.ui-steps li[data-state="failed"] { --tone: var(--ui-danger); }
.ui-steps li[data-state="done"] .ui-step-dot, .ui-steps li[data-state="failed"] .ui-step-dot { background: var(--tone); }
.ui-steps li[data-state="doing"] .ui-step-dot::after { content: ""; position: absolute; inset: -2px; border-radius: 50%; border: 2px solid var(--tone); animation: ui-step-ping 1.6s ease-out infinite; }
@keyframes ui-step-ping { from { transform: scale(1); opacity: .8; } to { transform: scale(1.7); opacity: 0; } }
.ui-step-t { font-size: var(--ui-fs); line-height: 24px; overflow-wrap: anywhere; }
.ui-steps li[data-state="todo"] .ui-step-t { color: var(--ui-mut); }
.ui-steps li[data-state="doing"] .ui-step-t { font-weight: 600; }
.ui-step-note { font-size: var(--ui-fs-s); color: var(--ui-mut); grid-column: 2; margin-top: -2px; }
.ui-steps[data-dir="row"] { flex-direction: row; gap: 8px; flex-wrap: wrap; }
.ui-steps[data-dir="row"] li { grid-template-columns: 24px auto; padding: 0 12px 0 0; align-items: center; }
.ui-steps[data-dir="row"] li::before { display: none; }
`);
const GLYPH = Object.freeze({ todo: '', doing: '', done: '✓', failed: '×' });

/**
 * progress({value, max, label, text, tone}): a bar; value 0..1, or value/max. The fill slides when you update({value}).
 * e.g. progress({label: 'Upload', value: 42, max: 100})
 */
export function progress(opts = {}) {
  const label = h('span.ui-progress-label');
  const text = h('span.ui-progress-text');
  const fill = h('div.ui-progress-fill');
  const el = h('div', { role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': PERCENT }, h('div.ui-progress-head', null, label, text), h('div.ui-progress-track', null, fill));
  let set = counter(text, (v) => `${Math.round(v)}%`);
  return build(el, 'progress', opts, (o, prev, first) => {
    const f = progressFraction(o);
    fill.style.width = `${f * PERCENT}%`;
    label.textContent = o.label ?? '';
    if (o.text !== undefined) { text.textContent = o.text; set = counter(text, (v) => `${Math.round(v)}%`); }
    else set(f * PERCENT, { first });
    for (const t of TONES) el.classList.toggle(`ui-tone-${t}`, o.tone === t);
    el.setAttribute('aria-valuenow', String(Math.round(f * PERCENT)));
  });
}

/**
 * steps({items: [{t, state: 'todo'|'doing'|'done'|'failed', note}], horizontal}): ordered progress through a plan.
 * e.g. steps({items: [{t: 'Build', state: 'done'}, {t: 'Test', state: 'doing'}, {t: 'Ship', state: 'todo'}]})
 */
export function steps(opts = {}) {
  const el = h('ol');
  const rows = [];
  return build(el, 'steps', opts, (o) => {
    const items = toArray(o.items).map((it) => (typeof it === 'string' ? { t: it, state: 'todo' } : it));
    el.dataset.dir = o.horizontal ? 'row' : 'col';
    while (rows.length < items.length) {
      const dot = h('span.ui-step-dot');
      const t = h('span.ui-step-t');
      const note = h('div.ui-step-note');
      const li = h('li', null, dot, h('div', null, t, note));
      rows.push({ li, dot, t, note });
      el.append(li);
    }
    while (rows.length > items.length) rows.pop().li.remove();
    items.forEach((it, i) => {
      const r = rows[i];
      const state = STEP_STATES.includes(it.state) ? it.state : 'todo';
      r.li.dataset.state = state;
      r.dot.textContent = GLYPH[state];
      r.t.textContent = it.t ?? it.text ?? '';
      r.note.textContent = it.note ?? '';
      r.note.hidden = !it.note;
      if (state === 'doing') r.li.setAttribute('aria-current', 'step'); else r.li.removeAttribute('aria-current');
    });
  });
}
