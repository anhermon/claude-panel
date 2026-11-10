import { defineAsset, h, soft } from './core.js';
import { validateWork, SCORE_MAX } from './work-schema.js';
import { workBox, headline, rows, word } from './custom.js';
const KIND = 'decisionmatrix';
const HEAT_MIN = 6;
const HEAT_RANGE = 28;
const TOTAL_DECIMALS = 2;
export function rankOptions(data) {
  return data.options.map((option) => ({ ...option, total: data.criteria.reduce((sum, c) => sum + (data.scores[option.id]?.[c.id] ?? 0) * c.weight, 0), complete: data.criteria.every((c) => data.scores[option.id]?.[c.id] !== undefined) })).sort((a, b) => b.total - a.total);
}
export const decisionmatrix = defineAsset({
  kind: KIND, html: true, custom: true,
  shape: 'Options have scores against weighted criteria and an optional selected choice.',
  summary: 'Ranked heat table with weighted totals; missing scores stay visibly absent and totals provisional.',
  keys: ['options', 'criteria', 'scores', 'chosen'],
  sample: { options: [{ id: 'simple', label: 'Simple approach' }, { id: 'flexible', label: 'Flexible approach' }], criteria: [{ id: 'speed', label: 'Speed', weight: 2 }, { id: 'upkeep', label: 'Upkeep', weight: 1 }], scores: { simple: { speed: 5, upkeep: 4 }, flexible: { speed: 3, upkeep: 5 } }, chosen: 'simple' },
  validate: (data) => validateWork(KIND, data),
  draw(ctx) {
    const box = workBox(ctx);
    box.append(headline(word(ctx, 'ranking')));
    const table = h('table');
    const heading = h('tr', null, h('th', { scope: 'col' }, word(ctx, 'option')), ctx.data.criteria.map((c) => h('th', { scope: 'col', title: `${c.label}: ${word(ctx, 'weight')} ${c.weight}` }, `${c.label} (×${c.weight})`)), h('th', { scope: 'col' }, word(ctx, 'total')));
    const body = h('tbody');
    table.append(h('thead', null, heading), body);
    box.append(h('div.pa-work-table-wrap', null, table));
    rows(ctx, body, rankOptions(ctx.data), (it, index) => {
      const chosen = it.id === ctx.data.chosen;
      const tr = h('tr', chosen ? { 'data-chosen': '' } : {}, h('th', { scope: 'row' }, `${index + 1}. ${it.label}${chosen ? ` · ${word(ctx, 'chosen')}` : ''}`));
      for (const c of ctx.data.criteria) {
        const score = ctx.data.scores[it.id]?.[c.id];
        tr.append(h('td', { title: `${it.label} · ${c.label}: ${score === undefined ? word(ctx, 'missing') : `${score}/${SCORE_MAX}`}`, style: { background: score === undefined ? 'var(--ui-card)' : soft(ctx.custom.accent, HEAT_MIN + score / SCORE_MAX * HEAT_RANGE) } }, score === undefined ? '—' : `${score}/${SCORE_MAX}`));
      }
      tr.append(h('td', { title: word(ctx, 'weighted') }, `${it.total.toFixed(TOTAL_DECIMALS)}${it.complete ? '' : ` · ${word(ctx, 'partial')}`}`));
      return tr;
    }, box);
  },
});
