// The Metrics facts of a codex run: node --test web/builtin/agents-info/*.test.mjs. The fixture is a real run's detail (codex-detail.json).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { EXTERNAL_CAPS, externalRows, normalizeExternal, percentText, resetText, tokenParts, windowWord } from './detail-external-logic.mjs';
import { normalizeDetail } from './detail-logic.mjs';

const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/codex-detail.json', import.meta.url), 'utf8'));
const NOW = 1_800_000_000_000;
const RICH = 'run-run-aaa111';
const SMOKE = 'run-codex-smoke';
const PERCENT = 100;
const TOKENS = { input: 1000, fresh: 400, cached: 600, output: 100, reasoning: 30, total: 500, cacheShare: 0.6 };
const base = (over = {}) => ({ harness: 'codex', source: 'rollout', runMs: 18304, taskMs: 11943, failed: 0, tokens: TOKENS, cost: { isMeasured: false, reason: 'no price' }, ...over });
const rowOf = (rows, label) => rows.find(([l]) => l === label)?.[1];
/** The fixture's `...AgoMs` keys become instants, as scripts/render-agents-info.mjs does. */
const abs = (v) => (Array.isArray(v) ? v.map(abs) : v !== null && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => (k === 'agoMs' ? ['t', NOW - x] : k.endsWith('AgoMs') ? [k.slice(0, -5), NOW - x] : [k, abs(x)]))) : v);

test('normalizeExternal: garbage is null, never a throw', () => {
  for (const v of [null, undefined, 1, 'x', [], {}, { harness: 'codex' }, { harness: 'codex', source: 'weird' }, { harness: 5, source: 'rollout' }]) assert.equal(normalizeExternal(v), null);
});

test('normalizeExternal: words are capped, numbers checked, an absent figure stays null', () => {
  const e = normalizeExternal(base({ harness: 'x'.repeat(500), model: 'm', effort: '', runMs: -4, taskMs: 'no', failed: null, tokens: { input: 0, output: 0 }, context: { peak: 'big' }, rate: { primary: { usedPct: 250 } } }));
  assert.equal(e.harness.length <= EXTERNAL_CAPS.word, true);
  assert.equal(e.effort, null);
  assert.equal(e.runMs, 0);
  assert.equal(e.taskMs, null);
  assert.equal(e.failed, null);
  assert.equal(e.tokens, null);
  assert.equal(e.context, null);
  assert.equal(e.rate.primary.usedPct, PERCENT);
  assert.equal(normalizeExternal(base({ rate: { plan: 'plus' } })).rate, null);
});

test('normalizeExternal: a cost is never "measured" unless the data says so, and always carries a reason', () => {
  assert.match(normalizeExternal(base()).costReason, /no price/);
  assert.equal(normalizeExternal(base({ cost: undefined })).costReason, 'not recorded');
  assert.equal(normalizeExternal(base({ cost: { isMeasured: false } })).costReason, 'not recorded');
});

test('tokenParts: fresh, cached and output share the whole; an empty one is dropped', () => {
  const parts = tokenParts(normalizeExternal(base()).tokens);
  assert.deepEqual(parts.map((p) => p.key), ['fresh', 'cached', 'out']);
  assert.ok(Math.abs(parts.reduce((a, p) => a + p.share, 0) - 1) < 1e-9);
  assert.deepEqual(tokenParts({ ...TOKENS, cached: 0 }).map((p) => p.key), ['fresh', 'out']);
  assert.deepEqual(tokenParts({ input: 0, fresh: 0, cached: 0, output: 0, reasoning: 0, total: 0, cacheShare: null }), []);
});

test('windowWord names a limit by its length; percentText rounds', () => {
  assert.equal(windowWord({ windowMinutes: 300 }, 'fb'), '5-hour limit');
  assert.equal(windowWord({ windowMinutes: 10080 }, 'fb'), 'weekly limit');
  assert.equal(windowWord({ windowMinutes: 2880 }, 'fb'), '2-day limit');
  assert.equal(windowWord({ windowMinutes: null }, 'fb'), 'fb');
  assert.equal(percentText(0.4957), '50%');
  assert.equal(percentText(null), '');
});

test('externalRows: the real smoke run says model, task time, cache share, context, limits and that the cost is not measured', () => {
  const e = normalizeExternal(FIXTURE[SMOKE].external);
  const rows = externalRows(e);
  assert.equal(rowOf(rows, 'Model'), 'gpt-6.1-sol:low');
  assert.match(rowOf(rows, 'Task time'), /^11 s/);
  assert.match(rowOf(rows, 'Cache share'), /^50%/);
  assert.match(rowOf(rows, 'Peak context'), /475k window \(4%\)/);
  assert.match(rowOf(rows, '5-hour limit'), /^27% used \(plus plan\)/);
  assert.match(rowOf(rows, 'Weekly limit'), /^12% used/);
  assert.match(rowOf(rows, 'Cost'), /^not measured: .*no price/);
  assert.equal(rowOf(rows, 'Thinking'), undefined);
  assert.equal(rowOf(rows, 'Coverage'), undefined);
});

test('externalRows: hidden reasoning and a partial read are said; with no rollout there is no token or context row', () => {
  const rows = externalRows(normalizeExternal(base({ reasoningHidden: 2, isPartial: true, tokens: null, context: null, taskMs: null, source: 'record' })));
  assert.match(rowOf(rows, 'Thinking'), /^2 reasoning steps kept only encrypted/);
  assert.match(rowOf(rows, 'Coverage'), /only the end/);
  for (const label of ['Output', 'Cache share', 'Peak context', 'Task time']) assert.equal(rowOf(rows, label), undefined);
  assert.match(rowOf(rows, 'Cost'), /^not measured/);
});

test('normalizeDetail on the real runs keeps think and note entries and the external facts, the failure still red', () => {
  const rich = normalizeDetail(abs(FIXTURE[RICH]));
  assert.equal(rich.external.source, 'rollout');
  assert.equal(rich.external.failed, 1);
  assert.equal(rich.external.proof.result, 'pass');
  const failedCall = rich.transcript.entries.find((e) => e.kind === 'tool' && e.error);
  assert.match(failedCall.error, /^exit 1/);
  assert.match(failedCall.note, /^exit 1/);
  assert.ok(rich.transcript.entries.some((e) => e.kind === 'tool' && e.note?.startsWith('exit 0')));
  assert.equal(normalizeDetail(abs(FIXTURE[SMOKE])).metrics.elapsedMs, 18304);
  const think = normalizeDetail({ ...abs(FIXTURE[RICH]), transcript: { ...abs(FIXTURE[RICH]).transcript, entries: [{ t: NOW, kind: 'think', text: 'weighing options' }] } });
  assert.deepEqual(think.transcript.entries.map((e) => e.kind), ['think']);
});


test('rate reset instants survive normalization and render relative minutes or a dated clock time', () => {
  const MS_SEC = 1000;
  const MS_MIN = 60 * MS_SEC;
  const MS_DAY = 24 * 60 * MS_MIN;
  const MINUTES = 42;
  const soon = (NOW + MINUTES * MS_MIN) / MS_SEC;
  const later = (NOW + 2 * MS_DAY) / MS_SEC;
  const e = normalizeExternal(base({ rate: { primary: { usedPct: 10, windowMinutes: 300, resetsAt: soon }, secondary: { usedPct: 20, windowMinutes: 10080, resetsAt: later } } }));
  assert.equal(e.rate.primary.resetsAt, soon);
  assert.match(rowOf(externalRows(e, NOW), '5-hour limit'), /resets in 42 min/);
  assert.match(rowOf(externalRows(e, NOW), 'Weekly limit'), /resets at .+\d.+:/);
  assert.equal(resetText(soon, NOW + MS_DAY), 'resets in 0 min');
  assert.equal(resetText(null, NOW), '');
  assert.equal(resetText(soon, undefined), '');
  assert.equal(normalizeExternal(base({ rate: { primary: { usedPct: 1, resetsAt: 'bad' } } })).rate.primary.resetsAt, null);
});
