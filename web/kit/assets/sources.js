import { defineAsset, h } from './core.js';
import { validateWork, SOURCE_KINDS, PERCENT } from './work-schema.js';
import { workBox, headline, muted, row, rows, word } from './custom.js';
const KIND = 'sources';
const UNKNOWN_CONFIDENCE = -1;
export const sortSources = (items) => [...items].sort((a, b) => (b.confidence ?? UNKNOWN_CONFIDENCE) - (a.confidence ?? UNKNOWN_CONFIDENCE) || SOURCE_KINDS.indexOf(a.kind ?? SOURCE_KINDS.at(-1)) - SOURCE_KINDS.indexOf(b.kind ?? SOURCE_KINDS.at(-1)));
export const sources = defineAsset({
  kind: KIND, html: true, custom: true,
  shape: 'Research claims are supported by sources with provenance and confidence.',
  summary: 'Evidence cards sorted by confidence and provenance, with host-only link labels.',
  keys: ['items'],
  sample: { items: [{ title: 'Example Docs', url: 'https://example.com/docs', kind: 'primary', claim: 'The format supports optional metadata.', confidence: 0.95, date: '2026-01-10' }, { title: 'Example Discussion', kind: 'forum', claim: 'Some readers report a migration delay.', confidence: 0.4 }] },
  validate: (data) => validateWork(KIND, data),
  draw(ctx) {
    const box = workBox(ctx);
    box.append(headline(word(ctx, 'evidence')));
    rows(ctx, box, sortSources(ctx.data.items), (it) => row(h('strong', null, it.title),
      h('span.pa-work-badge', null, word(ctx, it.kind ?? SOURCE_KINDS.at(-1))),
      it.claim ? h('div', null, it.claim) : null,
      it.url ? h('a', { href: it.url, target: '_blank', rel: 'noopener noreferrer' }, new URL(it.url).hostname) : null,
      it.confidence !== undefined ? muted(`${word(ctx, 'confidence')} ${Math.round(it.confidence * PERCENT)}%`) : null,
      it.date ? muted(it.date) : null));
  },
});
