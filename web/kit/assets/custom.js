// Shared presentation options and primitives for work assets. No animation: these are snapshots.
import { addCss } from '../ui/core.js';
import { h, check, AssetError, toneColor, catColor } from './core.js';
export const DENSITIES = ['comfortable', 'compact'];
const ACCENTS = ['info', 'ok', 'warn', 'danger', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6'];
const DEFAULT_ROWS = 12;
const MAX_ROWS = 400;
export const MORE_LABEL = 'more';
export function customOptions(opts = {}) {
  const accent = check.oneOf(opts.accent, 'opts.accent', ACCENTS, { optional: true });
  const density = check.oneOf(opts.density, 'opts.density', DENSITIES, { optional: true }) ?? DENSITIES[0];
  const maxRows = check.number(opts.maxRows, 'opts.maxRows', { min: 1, max: MAX_ROWS, optional: true }) ?? DEFAULT_ROWS;
  if (!Number.isInteger(maxRows)) throw new AssetError('opts.maxRows must be an integer');
  const labels = opts.labels ?? {};
  check.object(labels, 'opts.labels', Object.keys(labels));
  for (const [key, value] of Object.entries(labels)) check.string(value, `opts.labels.${key}`);
  return { accent: accent?.startsWith('c') ? catColor(Number(accent.slice(1)) - 1) : toneColor(accent), density, maxRows, labels, now: opts.now ?? Date.now() };
}
export function workBox(ctx) {
  const box = h('div.pa-work', { 'data-density': ctx.custom.density });
  box.style.setProperty('--work-accent', ctx.custom.accent);
  box.style.setProperty('--ui-fs', `${ctx.fs}px`);
  if (ctx.h) { box.style.height = `${ctx.h}px`; box.style.overflow = 'auto'; }
  ctx.root.append(box);
  return box;
}
export const word = (ctx, key, fallback = key) => ctx.custom.labels[key] ?? fallback;
export const headline = (text) => h('strong.pa-work-head', null, text);
export const muted = (text) => h('div.pa-work-muted', null, text);
export const row = (...children) => h('section.pa-work-row', null, ...children);
export const clipped = (text) => h('div.pa-work-clip', { title: text }, text);
export function rows(ctx, parent, items, draw, noticeParent = parent) {
  items.slice(0, ctx.custom.maxRows).forEach((it, i) => parent.append(draw(it, i)));
  const left = items.length - ctx.custom.maxRows;
  if (left > 0) noticeParent.append(muted(`+${left} ${word(ctx, MORE_LABEL)}`));
}
export function meter(parts, title) {
  return h('div.pa-work-meter', { title, role: 'img', 'aria-label': title }, parts.map(({ pct, color }) => h('span', { style: { width: `${pct}%`, background: color } })));
}
addCss(`
.pa-work { display:flex; flex-direction:column; gap:12px; min-width:0; font-size:var(--ui-fs); overflow-wrap:anywhere; }
.pa-work[data-density="compact"] { gap:6px; }
.pa-work-head { color:var(--work-accent); font-size:1.3em; }
.pa-work-row { padding:10px; border:1px solid var(--ui-line); border-radius:var(--ui-r-s); min-width:0; display:flex; flex-direction:column; gap:6px; background:var(--ui-card); }
.pa-work[data-density="compact"] .pa-work-row { padding:6px; gap:3px; }
.pa-work-muted { color:var(--ui-mut); }
.pa-work-clip { overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
.pa-work-meter { display:flex; height:14px; overflow:hidden; background:var(--ui-card-hi); border-radius:var(--ui-r-s); }
.pa-work-meter span { display:block; }
.pa-work-badge { color:var(--work-accent); font-weight:650; }
.pa-work [data-muted] { color:var(--ui-mut); }
.pa-work [data-chosen] { border:2px solid var(--work-accent); }
.pa-work-table-wrap { overflow:auto; }
.pa-work table { border-collapse:collapse; width:100%; font:inherit; }
.pa-work th,.pa-work td { padding:8px; border:1px solid var(--ui-line); text-align:left; min-width:5em; }
.pa-work th { font-weight:650; } .pa-work td { color:var(--ui-fg); }
.pa-work a { color:var(--work-accent); }
.pa-risk-layout { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:16px; }
.pa-risk-grid { display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); aspect-ratio:1; gap:3px; }
.pa-risk-cell { border:1px solid var(--ui-line); display:flex; flex-wrap:wrap; align-content:center; justify-content:center; gap:2px; min-width:0; }
.pa-risk-dot { border-radius:50%; background:var(--work-accent); color:var(--ui-on-acc); width:1.6em; height:1.6em; display:inline-grid; place-items:center; font-weight:700; }
.pa-risk-legend { display:flex; flex-direction:column; gap:8px; }
.pa-risk-layout[data-narrow] { grid-template-columns:minmax(0,1fr); }
`);
