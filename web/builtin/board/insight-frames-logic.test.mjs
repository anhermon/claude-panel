// insight-frames-logic.test.mjs - the four workflow-insight frames: what the page keeps of what the mod sent, the little
// arithmetic of the drawings, the height each needs, and how the grid places them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HEAT_LEVELS, IX_CAPS, heatLevel, insightBodyPx, isInsightType, normalizeHints, normalizeKindStack, normalizeRepeats, normalizeSinks, sliceFitsLabel,
} from './insight-frames-logic.mjs';
import { formatDuration, formatTokens } from './insight-logic.mjs';
import { LIST_TYPES, listBodyPx, minSizeFor } from './grid-plan.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(join(here, 'fixtures', `${name}.json`), 'utf8'));
const seg = (k, s, text = `${s} s`) => ({ k, s, text });

test('the four types are insight types and list frames', () => {
  for (const t of ['kindstack', 'sinks', 'repeats', 'hints']) assert.ok(isInsightType(t) && LIST_TYPES.has(t), t);
  assert.ok(!isInsightType('lanes'));
});

test('kindstack: junk is dropped, shares add to 1, a slice shows its word only when it has room, extra slices are counted', () => {
  const f = normalizeKindStack({
    caption: ' Each bar  is an agent ',
    items: [
      { label: 'writer', total: '3 min', tokens: '12k tokens', segs: [seg('logic', 60), seg('tests', 30), seg('nonsense', 10), seg('docs', 0), seg('reading', 6), seg('ui', 2), seg('visual', 2)] },
      { label: 'empty', total: '0 s', segs: [] },
      'junk',
    ],
  });
  assert.equal(f.caption, 'Each bar is an agent');
  assert.equal(f.items.length, 1);
  const [it] = f.items;
  assert.deepEqual(it.segs.map((s) => s.k), ['logic', 'tests', 'reading', 'ui', 'visual']);
  assert.ok(Math.abs(it.segs.reduce((a, s) => a + s.share, 0) - 1) < 1e-9);
  assert.equal(it.segs[0].showLabel, true); // 60% of the bar
  assert.equal(it.segs[3].showLabel, false); // 2% of the bar
  assert.equal(it.detail.length, IX_CAPS.detail);
  assert.equal(it.more, 2);
  assert.deepEqual(f.kinds, ['ui', 'logic', 'tests', 'visual', 'reading']); // the key, in the board's kind order
  assert.deepEqual(normalizeKindStack({}).items, []);
});

test('sliceFitsLabel: a longer word needs a bigger share', () => {
  assert.equal(sliceFitsLabel(0.03, 'ui'), false);
  assert.equal(sliceFitsLabel(0.12, 'ui'), true);
  assert.equal(sliceFitsLabel(0.12, 'delegating'), false);
  assert.equal(sliceFitsLabel(0.5, 'delegating'), true);
});

test('sinks: unknown kinds are dropped, a share is a whole number up to 100, notes are plain and capped', () => {
  const f = normalizeSinks({ items: [{ k: 'logic', pct: 61.6, text: '1 min' }, { k: 'zzz', pct: 5, text: 'x' }, { k: 'tests', pct: 900, text: 'y' }], notes: ['a', '', 'b', 'c', 'd', 'e'] });
  assert.deepEqual(f.items.map((i) => [i.k, i.pct]), [['logic', 62], ['tests', 100]]);
  assert.deepEqual(f.notes, ['a', 'b', 'c']); // the cap is applied before the blank is dropped
  assert.equal(IX_CAPS.notes, 4);
});

test('repeats: one number per column, heat in proportion to the busiest cell, no rows means no columns', () => {
  const f = normalizeRepeats({ cols: ['a', 'b'], rows: [{ label: 'x.css', cells: [8, 1], note: '9 reads' }, { label: 'y.ts', cells: [0, 4] }, { label: '', cells: [1, 1] }], notes: ['n'] });
  assert.equal(f.rows.length, 2);
  assert.deepEqual(f.rows[0].levels, [HEAT_LEVELS, 1]);
  assert.deepEqual(f.rows[1].levels, [0, 2]);
  assert.deepEqual(normalizeRepeats({ cols: ['a'], rows: [], notes: ['only a sentence'] }).cols, []);
  assert.equal(heatLevel(0, 5), 0);
  assert.equal(heatLevel(1, 100), 1);
  assert.equal(heatLevel(100, 100), HEAT_LEVELS);
  assert.equal(heatLevel(3, 0), 0);
});

test('hints: a card needs its text; evidence and rule are kept; at most the cap', () => {
  const items = Array.from({ length: 6 }, (_, i) => ({ text: `t${i}`, evidence: 'e', rule: 'r' }));
  const f = normalizeHints({ items: [{ text: '', evidence: 'e', rule: 'r' }, ...items] });
  assert.equal(f.items.length, IX_CAPS.hints - 1); // the empty one took a place of the cap, then was dropped
  assert.deepEqual(f.items[0], { text: 't0', evidence: 'e', rule: 'r' });
});

test('insightBodyPx: grows with the rows, the compact wording is smaller, another type is 0', () => {
  const ks = (n) => ({ type: 'kindstack', items: Array.from({ length: n }, () => ({})) });
  assert.ok(insightBodyPx(ks(4)) > insightBodyPx(ks(2)));
  assert.ok(insightBodyPx(ks(4), { compact: true }) < insightBodyPx(ks(4)));
  assert.ok(insightBodyPx(ks(4), { floor: 28 }) > insightBodyPx(ks(4), { floor: 14 }));
  assert.ok(insightBodyPx({ type: 'hints', items: [{}, {}] }) > insightBodyPx({ type: 'hints', items: [{}] }));
  assert.equal(insightBodyPx({ type: 'lanes' }), 0);
  assert.equal(listBodyPx(ks(3), {}), insightBodyPx(ks(3), {}));
});

test('minSizeFor: few rows fit a medium cell, many need a large one', () => {
  const n = (type, c) => ({ type, items: Array.from({ length: c }, () => ({})) });
  assert.equal(minSizeFor(n('kindstack', 2)), 'm');
  assert.equal(minSizeFor(n('kindstack', 5)), 'l');
  assert.equal(minSizeFor(n('hints', 1)), 'm');
  assert.equal(minSizeFor(n('hints', 3)), 'l');
  assert.equal(minSizeFor(n('sinks', 1)), 'l');
  assert.equal(minSizeFor({ type: 'repeats', rows: [] }), 'l');
});

test('the twin formatters of the page say what the mod says', () => {
  assert.equal(formatDuration(42_000), '42 s');
  assert.equal(formatDuration(200_000), '3 min 20 s');
  assert.equal(formatDuration(180_000), '3 min');
  assert.equal(formatDuration(7_500_000), '2 h 05 min');
  assert.equal(formatTokens(850), '850 tokens');
  assert.equal(formatTokens(4_250), '4.3k tokens');
  assert.equal(formatTokens(42_400), '42k tokens');
  assert.equal(formatTokens(1_200_000), '1.2M tokens');
});

test('the shipped fixtures: every insight frame survives its normaliser with content', () => {
  const frames = fixture('workflow-insight').frames;
  const by = (type) => frames.find((f) => f.type === type);
  assert.ok(normalizeKindStack(by('kindstack')).items.length >= 4); // four or more agents
  assert.ok(normalizeSinks(by('sinks')).items.length > 0);
  assert.ok(normalizeRepeats(by('repeats')).rows.length > 0);
  assert.ok(normalizeHints(by('hints')).items.length > 0);
  assert.equal(normalizeKindStack(fixture('workflow-insight-thin').frames.find((f) => f.type === 'kindstack')).items.length, 1);
});

test('headline and foot: the finding is kept as the caption, the method as a foot of at most 70 characters; sink time and meta ride on the row', () => {
  const sinks = normalizeSinks({ caption: 'Tests took 39% of agent time', foot: 'f'.repeat(200), items: [{ k: 'tests', pct: 39, text: 'x', time: '43 min 59 s', meta: '3 agents · ~372k tok' }] });
  assert.equal(sinks.caption, 'Tests took 39% of agent time');
  assert.equal(sinks.foot.length, IX_CAPS.foot);
  assert.deepEqual([sinks.items[0].time, sinks.items[0].meta], ['43 min 59 s', '3 agents · ~372k tok']);
  assert.equal(normalizeSinks({ items: [{ k: 'tests', pct: 5, text: 'old frame' }] }).items[0].time, ''); // an older frame still works
  assert.equal(normalizeRepeats({ cols: [], rows: [], foot: 'no matrix, no key note' }).foot, '');
  // no paragraph above a chart: a headline-only frame needs less room than the old caption did
  assert.ok(insightBodyPx({ type: 'sinks', caption: 'x', items: [{}] }) < insightBodyPx({ type: 'sinks', caption: 'x', foot: 'y', items: [{}] }));
});
