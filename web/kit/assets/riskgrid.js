import { defineAsset, h, soft } from './core.js';
import { validateWork, SCORE_MAX } from './work-schema.js';
import { workBox, headline, muted, row, rows, word } from './custom.js';
const KIND = 'riskgrid';
const HEAT_BASE = 4;
const HEAT_RANGE = 32;
const MAX_RISK = SCORE_MAX * SCORE_MAX;
export const rankRisks = (items) => [...items].sort((a, b) => b.likelihood * b.impact - a.likelihood * a.impact);
export const riskgrid = defineAsset({
  kind: KIND, html: true, custom: true,
  shape: 'Risks have likelihood and impact scores with owners and mitigations.',
  summary: 'A five-by-five risk grid with numbered dots and a ranked mitigation legend.',
  keys: ['items'],
  sample: { items: [{ label: 'Migration delay', likelihood: 4, impact: 4, mitigation: 'Rehearse the migration', owner: 'Delivery' }, { label: 'Stale documentation', likelihood: 3, impact: 2, mitigation: 'Review examples', owner: 'Documentation' }, { label: 'Capacity shortage', likelihood: 2, impact: 5, mitigation: 'Reserve spare capacity' }] },
  validate: (data) => validateWork(KIND, data),
  draw(ctx) {
    const box = workBox(ctx);
    box.append(headline(word(ctx, 'risks')));
    const grid = h('div.pa-risk-grid', { role: 'img', 'aria-label': `${word(ctx, 'likelihood')} 1–${SCORE_MAX} ↑ · ${word(ctx, 'impact')} 1–${SCORE_MAX} →` });
    const legend = h('div.pa-risk-legend');
    const layout = h('div.pa-risk-layout', ctx.narrow ? { 'data-narrow': '' } : {}, h('div', null, muted(`${word(ctx, 'likelihood')} ↑ · ${word(ctx, 'impact')} → (1–${SCORE_MAX})`), grid), legend);
    const sorted = rankRisks(ctx.data.items);
    const visible = sorted.slice(0, ctx.custom.maxRows);
    for (let likelihood = SCORE_MAX; likelihood >= 1; likelihood--) {
      for (let impact = 1; impact <= SCORE_MAX; impact++) {
        const cell = h('div.pa-risk-cell', { title: `${word(ctx, 'likelihood')} ${likelihood}/${SCORE_MAX} · ${word(ctx, 'impact')} ${impact}/${SCORE_MAX}`, style: { background: soft('var(--ui-danger)', HEAT_BASE + likelihood * impact / MAX_RISK * HEAT_RANGE) } });
        visible.forEach((it, i) => { if (it.likelihood === likelihood && it.impact === impact) cell.append(h('span.pa-risk-dot', { title: `${it.label}: ${likelihood} × ${impact} = ${likelihood * impact}` }, String(i + 1))); });
        grid.append(cell);
      }
    }
    rows(ctx, legend, sorted, (it, i) => row(h('strong', null, `${i + 1}. ${it.label}`), muted(`${word(ctx, 'likelihood')} ${it.likelihood}/${SCORE_MAX} · ${word(ctx, 'impact')} ${it.impact}/${SCORE_MAX}`), it.mitigation ? h('div', null, `${word(ctx, 'mitigation')}: ${it.mitigation}`) : null, it.owner ? muted(`${word(ctx, 'owner')}: ${it.owner}`) : null));
    box.append(layout);
  },
});
