import { defineAsset, h, toneColor, fmt } from './core.js';
import { validateWork, PERCENT } from './work-schema.js';
import { workBox, headline, muted, row, clipped, rows, word, meter } from './custom.js';
const KIND = 'testresults';
const COUNTS = ['passed', 'failed', 'skipped'];
const COLORS = ['ok', 'danger', 'neutral'];
export const testresults = defineAsset({
  kind: KIND, html: true, custom: true,
  shape: 'A test or check run has suite outcomes, durations and individual failures.',
  summary: 'Pass totals, stacked suite bars, slowest duration and clipped failure details.',
  keys: ['unit', 'suites', 'failures'],
  sample: { unit: 'tests', suites: [{ name: 'Parser', passed: 18, failed: 1, ms: 420 }, { name: 'Storage', passed: 12, failed: 0, skipped: 2, ms: 810 }], failures: [{ name: 'Reads an empty document', message: 'Expected an empty result; received a missing value.', file: 'parser.test.js' }] },
  validate: (data) => validateWork(KIND, data),
  draw(ctx) {
    const { data } = ctx;
    const box = workBox(ctx);
    const total = (it) => COUNTS.reduce((n, key) => n + (it[key] ?? 0), 0);
    const passed = data.suites.reduce((n, it) => n + it.passed, 0);
    box.append(headline(`${passed}/${data.suites.reduce((n, it) => n + total(it), 0)} ${word(ctx, 'passed')} ${data.unit ?? word(ctx, 'tests')}`));
    const timed = data.suites.filter((it) => it.ms !== undefined);
    const slowest = timed.length ? timed.reduce((a, b) => a.ms >= b.ms ? a : b) : null;
    rows(ctx, box, data.suites, (it) => {
      const title = COUNTS.map((key) => `${it[key] ?? 0} ${word(ctx, key)}`).join(' · ');
      return row(h('strong', null, it.name), meter(COUNTS.map((key, i) => ({ pct: total(it) ? (it[key] ?? 0) / total(it) * PERCENT : 0, color: toneColor(COLORS[i]) })), title),
        muted(title), it.ms !== undefined ? muted(`${fmt(it.ms, 'ms')} ${it === slowest ? `· ${word(ctx, 'slowest')}` : ''}`) : null);
    });
    if (data.failures?.length) {
      box.append(h('strong', null, word(ctx, 'failures')));
      rows(ctx, box, data.failures, (it) => row(h('strong', null, it.name), it.message ? clipped(it.message) : null, it.file ? muted(it.file) : null));
    }
  },
});
