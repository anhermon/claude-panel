import { defineAsset, h } from './core.js';
import { validateWork, STATES, PERCENT } from './work-schema.js';
import { workBox, headline, muted, row, rows, word, clipped } from './custom.js';
const KIND = 'hypotheses';
export const hypotheses = defineAsset({
  kind: KIND, html: true, custom: true,
  shape: 'A debugging question has competing explanations, investigation states and evidence.',
  summary: 'The question heads explanations grouped by state with evidence and optional confidence.',
  keys: ['question', 'items'],
  sample: { question: 'Why is the response delayed?', items: [{ id: 'cache', label: 'Cache entries expire together', state: 'confirmed', evidence: ['Delay coincides with expiration'], confidence: 0.9 }, { id: 'queue', label: 'Queue is saturated', state: 'testing', evidence: ['Measuring queue depth'] }, { id: 'network', label: 'Network retries', state: 'ruled-out', evidence: ['No retries recorded'] }] },
  validate: (data) => validateWork(KIND, data),
  draw(ctx) {
    const box = workBox(ctx);
    box.append(headline(ctx.data.question));
    const sorted = [...ctx.data.items].sort((a, b) => STATES.indexOf(a.state) - STATES.indexOf(b.state));
    let previous;
    rows(ctx, box, sorted, (it) => {
      const card = row();
      if (previous !== it.state) card.append(h('strong.pa-work-badge', null, word(ctx, it.state)));
      previous = it.state;
      if (it.state === STATES.at(-1)) card.dataset.muted = '';
      card.append(h('strong', { title: it.id }, it.label));
      if (it.confidence !== undefined) card.append(muted(`${word(ctx, 'confidence')} ${Math.round(it.confidence * PERCENT)}%`));
      for (const line of it.evidence ?? []) card.append(clipped(line));
      return card;
    });
  },
});
