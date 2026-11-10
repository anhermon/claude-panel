import { defineAsset, toneColor, h } from './core.js';
import { addCss } from '../ui/core.js';
import { validateWork, PERCENT, QUOTA_WARN_PCT, QUOTA_DANGER_PCT } from './work-schema.js';
import { workBox, headline, muted, row, rows, word, meter } from './custom.js';
const KIND = 'limits';
export const OK_THRESHOLD = QUOTA_WARN_PCT;
export const WARN_THRESHOLD = QUOTA_DANGER_PCT;
const MIN_PCT = 0;
const MONEY_DECIMALS = 2;
const MONEY_LOCALE = 'en-US';
const MINUTE_MS = 60 * 1000;
const MINUTES_PER_HOUR = 60;
const STATUS_STALE = 'stale';
const STATUS_UNAVAILABLE = 'unavailable';
const STATUS_FRESH = 'fresh';
const GROUP_COLUMNS = 2;
export const quotaTone = (pct) => pct < OK_THRESHOLD ? 'ok' : pct < WARN_THRESHOLD ? 'warn' : 'danger';
export function resetDuration(at, now) {
  const minutes = Math.max(MIN_PCT, Math.ceil(((typeof at === 'number' ? at : Date.parse(at)) - now) / MINUTE_MS));
  return `${Math.floor(minutes / MINUTES_PER_HOUR)}h ${minutes % MINUTES_PER_HOUR}m`;
}
export function costText({ amount, unit }) {
  try { return new Intl.NumberFormat(MONEY_LOCALE, { style: 'currency', currency: unit, minimumFractionDigits: MONEY_DECIMALS, maximumFractionDigits: MONEY_DECIMALS }).format(amount); }
  catch { return `${amount.toFixed(MONEY_DECIMALS)} ${unit}`; }
}
const SAMPLE_RESET = '2026-11-10T17:27:48.000Z';
export const limits = defineAsset({
  kind: KIND, html: true, custom: true,
  shape: 'Provider groups have quota windows, usage percentages and reset times, alongside context usage and cost.',
  summary: 'Provider quotas with freshness, reset countdowns, context fill and cost.',
  keys: ['groups', 'windows', 'context', 'cost'],
  sample: { groups: [
    { title: 'Claude', status: STATUS_FRESH, windows: [{ label: '5h', usedPct: 10, resetsAt: '2026-11-10T15:40:00.000Z' }, { label: '7d', usedPct: 63, resetsAt: '2026-11-12T06:00:00.000Z' }] },
    { title: 'Codex', status: STATUS_FRESH, windows: [{ label: '5h', usedPct: 34, resetsAt: '2026-11-10T17:28:17.000Z' }, { label: '7d', usedPct: 28, resetsAt: '2026-11-15T13:15:56.000Z' }] },
    { title: 'AGY Gemini shared', status: STATUS_STALE, windows: [{ label: '5h', usedPct: MIN_PCT, resetsAt: SAMPLE_RESET }, { label: '7d', usedPct: MIN_PCT, resetsAt: '2026-11-16T12:59:22.000Z' }] },
    { title: 'AGY Claude/GPT pool', status: STATUS_STALE, windows: [{ label: '5h', usedPct: MIN_PCT, resetsAt: SAMPLE_RESET }, { label: '7d', usedPct: MIN_PCT, resetsAt: '2026-11-17T12:27:48.000Z' }] },
  ] },
  validate: (data) => validateWork(KIND, data),
  draw(ctx) {
    const box = workBox(ctx);
    const usage = (it) => {
      const pct = Math.round(it.usedPct);
      const bar = meter([{ pct: Math.min(PERCENT, Math.max(MIN_PCT, it.usedPct)), color: toneColor(it.tone ?? quotaTone(it.usedPct)) }], `${it.label}: ${pct}% ${word(ctx, 'used')}`);
      return h('div.pa-limits-window', null,
        h('div.pa-limits-reading', null, h('strong', null, it.label), bar, h('span', null, `${pct}%`)),
        it.resetsAt !== undefined ? muted(`${word(ctx, 'resetsIn', 'reset')} ${resetDuration(it.resetsAt, ctx.custom.now)}`) : null);
    };
    if (ctx.data.groups !== undefined) {
      const groups = h('div.pa-limits-groups', ctx.narrow ? { 'data-narrow': '' } : {});
      box.append(groups);
      rows(ctx, groups, ctx.data.groups, (group) => {
        const status = group.status;
        const heading = h('div.pa-limits-heading', null, h('strong', null, group.title), status ? h('span.pa-work-muted', { style: { color: status === STATUS_STALE ? toneColor('warn') : undefined } }, ` · ${word(ctx, status)}`) : null);
        const grid = h('div.pa-limits-grid', ctx.narrow ? { 'data-narrow': '' } : {});
        if (status !== STATUS_UNAVAILABLE) rows(ctx, grid, group.windows, usage);
        return h('section.pa-limits-group', null, heading, grid);
      }, box);
    } else {
      box.append(headline(word(ctx, 'usage')));
      rows(ctx, box, ctx.data.windows, (it) => row(usage(it)));
    }
    if (ctx.data.context) box.append(h('div.pa-limits-context', null, `${word(ctx, 'context', 'Context')} ${Math.round(ctx.data.context.usedPct)}% ${word(ctx, 'used')}`));
    if (ctx.data.cost) box.append(muted(`${word(ctx, 'cost', 'Cost')} ${costText(ctx.data.cost)}`));
  },
});
addCss(`
.pa-limits-groups { display:grid; grid-template-columns:repeat(${GROUP_COLUMNS},minmax(0,1fr)); gap:12px; }
.pa-limits-groups[data-narrow] { grid-template-columns:minmax(0,1fr); }
.pa-limits-group { display:flex; flex-direction:column; gap:8px; min-width:0; padding:10px; border:1px solid var(--ui-line); border-radius:var(--ui-r-s); }
.pa-limits-heading strong { color:var(--work-accent); }
.pa-limits-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:10px 20px; }
.pa-limits-groups[data-narrow] { gap:4px; }
.pa-limits-groups[data-narrow] .pa-limits-group { padding:2px 8px; gap:1px; line-height:1.25; }
.pa-limits-groups[data-narrow] .pa-work-muted { font-size:max(12px,.82em); white-space:nowrap; }
.pa-limits-grid[data-narrow] { gap:2px 12px; }
.pa-limits-grid[data-narrow] .pa-limits-reading { grid-template-columns:minmax(0,1fr) auto; gap:2px 6px; }
.pa-limits-grid[data-narrow] .pa-limits-reading > strong { grid-area:1 / 1; }
.pa-limits-grid[data-narrow] .pa-limits-reading > span { grid-area:1 / 2; }
.pa-limits-grid[data-narrow] .pa-limits-reading > :not(strong):not(span) { grid-area:2 / 1 / 3 / 3; }
.pa-limits-window { display:flex; flex-direction:column; gap:4px; min-width:0; }
.pa-limits-reading { display:grid; grid-template-columns:auto minmax(0,1fr) auto; gap:8px; align-items:center; }
.pa-limits-reading .pa-work-meter { height:8px; }
.pa-limits-reading > span { font-variant-numeric:tabular-nums; text-align:right; }
.pa-limits-context { border-top:1px solid var(--ui-line); padding-top:6px; color:var(--ui-mut); }
.pa-limits-groups[data-narrow] ~ .pa-limits-context { padding-top:2px; font-size:max(12px,.82em); }
.pa-work[data-density="compact"] .pa-limits-group { gap:4px; }
`);
