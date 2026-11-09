// Unit tests for the DOM-free logic of panel/ui (web/kit/ui/pure.js) plus the import wiring of the library.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as P from './kit/ui/pure.js';
import { HOUSE_IMPORTS } from './scene-kit.mjs';

const UI_DIR = join(dirname(fileURLToPath(import.meta.url)), 'kit', 'ui');
const MAX_LINES = 800;
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);

test('tween math: endpoints are exact, easing is monotonic, non-numbers snap', () => {
  assert.equal(P.tweenAt(0, 10, 0), 0);
  assert.equal(P.tweenAt(0, 10, 1), 10);
  assert.equal(P.tweenAt(0, 10, 2), 10);
  let prev = -1;
  for (let t = 0; t <= 1; t += 0.1) { const v = P.tweenAt(0, 100, t); assert.ok(v >= prev); prev = v; }
  assert.equal(P.tweenAt('a', 5, 0.3), 5);
  assert.equal(P.progressAt(100, 150, 100), 0.5);
  assert.equal(P.progressAt(100, 50, 100), 0);
  assert.equal(P.progressAt(100, 500, 0), 1);
  near(P.easeInOut(0.5), 0.5);
});

test('formatNumber: decimals, compact, sign, prefix/suffix, non-numbers', () => {
  assert.equal(P.formatNumber(1234.5), '1,234.5');
  assert.equal(P.formatNumber(1280), '1,280');
  assert.equal(P.formatNumber(12.3456, { decimals: 1 }), '12.3');
  assert.equal(P.formatNumber(1500, { compact: true }), '1.5k');
  assert.equal(P.formatNumber(2_000_000, { compact: true }), '2M');
  assert.equal(P.formatNumber(4.2, { sign: true, suffix: '%' }), '+4.2%');
  assert.equal(P.formatNumber(-3, { prefix: '$' }), '-$3');
  assert.equal(P.formatNumber('n/a'), 'n/a');
  assert.equal(P.formatNumber(null), '');
  assert.equal(P.formatDuration(45_000), '45 s');
  assert.equal(P.formatDuration(125_000), '2 min 5 s');
  assert.equal(P.formatDuration(2 * 3_600_000 + 600_000), '2 h 10 min');
});

test('tones and fractions', () => {
  assert.equal(P.deltaTone(5), 'ok');
  assert.equal(P.deltaTone(5, 'down'), 'danger');
  assert.equal(P.deltaTone(0), 'neutral');
  const th = [{ upTo: 60, tone: 'ok' }, { upTo: 85, tone: 'warn' }, { tone: 'danger' }];
  assert.equal(P.toneForValue(10, th), 'ok');
  assert.equal(P.toneForValue(60, th), 'ok');
  assert.equal(P.toneForValue(70, th), 'warn');
  assert.equal(P.toneForValue(99, th), 'danger');
  assert.equal(P.toneForValue(1, []), 'info');
  assert.equal(P.fraction(50, 0, 100), 0.5);
  assert.equal(P.fraction(500, 0, 100), 1);
  assert.equal(P.fraction(5, 10, 10), 0);
  assert.equal(P.progressFraction({ value: 0.25 }), 0.25);
  assert.equal(P.progressFraction({ value: 30, max: 120 }), 0.25);
});

test('sortRows: numeric, natural text, stable, empty cells last, direction; nextSort cycles', () => {
  const rows = [{ n: 'b10', v: 10 }, { n: 'b2', v: 2 }, { n: 'a', v: null }, { n: 'c', v: 10 }];
  assert.deepEqual(P.sortRows(rows, 'v', 'asc').map((r) => r.n), ['b2', 'b10', 'c', 'a']);
  assert.deepEqual(P.sortRows(rows, 'v', 'desc').map((r) => r.n), ['b10', 'c', 'b2', 'a']);
  assert.deepEqual(P.sortRows(rows, 'n', 'asc').map((r) => r.n), ['a', 'b2', 'b10', 'c']);
  assert.deepEqual(P.sortRows(rows, undefined).map((r) => r.n), ['b10', 'b2', 'a', 'c']);
  assert.notEqual(P.sortRows(rows, 'v'), rows);
  assert.deepEqual(P.nextSort(null, 'x'), { key: 'x', dir: 'asc' });
  assert.deepEqual(P.nextSort({ key: 'x', dir: 'asc' }, 'x'), { key: 'x', dir: 'desc' });
  assert.equal(P.nextSort({ key: 'x', dir: 'desc' }, 'x'), null);
  assert.deepEqual(P.nextSort({ key: 'x', dir: 'desc' }, 'y'), { key: 'y', dir: 'asc' });
});

test('normalizeColumns: strings, inferred keys, types and alignment', () => {
  const cols = P.normalizeColumns(['name', { key: 'qty', label: 'Qty' }], [{ name: 'a', qty: 2 }]);
  assert.deepEqual(cols.map((c) => [c.key, c.label, c.type, c.align]), [['name', 'name', 'text', 'left'], ['qty', 'Qty', 'num', 'right']]);
  assert.deepEqual(P.normalizeColumns(undefined, [{ a: 1, b: 'x' }]).map((c) => c.key), ['a', 'b']);
  assert.deepEqual(P.normalizeColumns(undefined, []), []);
});

test('normalizeSeries: every data shape becomes {name, points}', () => {
  assert.deepEqual(P.normalizeSeries({ data: [1, 2] })[0].points, [{ x: 0, y: 1 }, { x: 1, y: 2 }]);
  assert.deepEqual(P.normalizeSeries({ data: [[1, 5], [2, 6]] })[0].points, [{ x: 1, y: 5 }, { x: 2, y: 6 }]);
  assert.deepEqual(P.normalizeSeries({ data: [{ label: 'a', value: 3 }] })[0].points, [{ x: 'a', y: 3 }]);
  assert.deepEqual(P.normalizeSeries({ data: [{ x: 1, y: 2, color: 'red' }] })[0].points, [{ x: 1, y: 2, color: 'red' }]);
  const many = P.normalizeSeries({ series: [{ name: 'p', data: [1] }, { data: [{ x: 'z', y: 2 }], color: 'red' }] });
  assert.deepEqual(many.map((s) => s.name), ['p', 'Series 2']);
  assert.equal(many[1].color, 'red');
  assert.deepEqual(P.normalizeSeries({ data: [1, NaN, 'x'] })[0].points, [{ x: 0, y: 1 }]);
  assert.deepEqual(P.normalizeSeries({})[0].points, []);
});

test('chart helpers: inferKind, yExtent, donutSlices, heatGrid, niceStep, spreadLabels', () => {
  assert.equal(P.inferKind([1, 2]), 'num');
  assert.equal(P.inferKind([new Date(), new Date()]), 'time');
  assert.equal(P.inferKind([1, 'a']), 'cat');
  assert.equal(P.inferKind([]), 'cat');
  const s = [{ points: [{ x: 'a', y: 3 }, { x: 'b', y: 5 }] }, { points: [{ x: 'a', y: 4 }, { x: 'b', y: -1 }] }];
  assert.deepEqual(P.yExtent(s), [-1, 5]);
  assert.deepEqual(P.yExtent(s, true), [-1, 7]);
  assert.deepEqual(P.yExtent([]), [0, 1]);
  const d = P.donutSlices([{ label: 'a', value: 1 }, { label: 'b', value: 3 }, { label: 'z', value: 0 }]);
  assert.equal(d.length, 2);
  near(d[0].pct, 0.25);
  near(d[1].end, 2 * Math.PI);
  near(d[1].start, d[0].end);
  const g = P.heatGrid([{ x: 'a', y: 'r', value: 0 }, { x: 'b', y: 'r', value: 10 }, { x: 'a', y: 's', value: 5 }], 5);
  assert.deepEqual([g.xs, g.ys, g.min, g.max], [['a', 'b'], ['r', 's'], 0, 10]);
  assert.deepEqual(g.cells.map((c) => c.step), [0, 4, 2]);
  assert.equal(P.niceStep(0.7), 1);
  assert.equal(P.niceStep(3), 5);
  assert.equal(P.niceStep(12), 20);
  const ys = P.spreadLabels([10, 12, 14, 200], 15, 0, 300);
  assert.ok(ys[1] - ys[0] >= 15 - 1e-9 && ys[2] - ys[1] >= 15 - 1e-9);
  assert.equal(ys[3], 200);
  assert.deepEqual(P.spreadLabels([300, 300], 15, 0, 300), [285, 300]);
  assert.deepEqual(P.spreadLabels([], 15, 0, 10), []);
});

test('timeline: normalisation (lanes+items and gantt rows), ticks, bar boxes', () => {
  const now = 1_700_000_000_000;
  const t = P.normalizeTimeline({ now, rows: [{ name: 'a', sub: 'x', start: now - 60_000, state: 'running' }, { name: 'b', start: now - 120_000, end: now - 30_000, state: 'done' }] });
  assert.equal(t.lanes.length, 2);
  assert.equal(t.from, now - 120_000);
  assert.equal(t.to, now);
  assert.equal(t.lanes[0].items[0].end, now, 'a running item stretches to now');
  assert.equal(t.lanes[0].items[0].open, true);
  assert.equal(t.lanes[1].items[0].open, false);
  const m = P.normalizeTimeline({ lanes: ['L'], items: [{ lane: 'L', start: 5, state: 'milestone' }, { lane: 'L', start: '2024-01-01T00:00:00Z', end: '2024-01-01T01:00:00Z' }, { lane: 'L', start: 'junk' }] });
  assert.equal(m.lanes[0].items.length, 2, 'unparsable start is dropped');
  assert.equal(m.lanes[0].items[0].milestone, true);
  assert.equal(P.normalizeTimeline({}).lanes.length, 0);
  const ticks = P.timeTicks(now - 600_000, now, 5);
  assert.ok(ticks.length >= 3 && ticks.length <= 8);
  assert.ok(ticks.every((x) => x % 60_000 === 0 || x % 120_000 === 0 || x % 300_000 === 0 || x % 15_000 === 0));
  assert.deepEqual(P.timeTicks(0, 10, 5), [0, 2, 4, 6, 8, 10]);
  assert.deepEqual(P.timeTicks(5, 5), [5]);
  assert.deepEqual(P.barBox(50, 100, 0, 200, 1), { left: 25, width: 25 });
  assert.equal(P.barBox(0, 0, 0, 100, 2).width, 2);
  assert.equal(P.barBox(100, 100, 0, 100, 2).left, 98, 'a minimum-width bar never leaves the track');
});

test('kanban: columns with cards, flat cards by column, generated ids', () => {
  const cols = P.normalizeKanban({ columns: ['todo', { id: 'doing', title: 'Doing', cards: [{ id: 'k', title: 'K' }, 'plain'] }], cards: [{ id: 'a', column: 'todo', title: 'A' }, { column: 'nope', title: 'lost' }] });
  assert.deepEqual(cols.map((c) => [c.id, c.title, c.cards.length]), [['todo', 'todo', 1], ['doing', 'Doing', 2]]);
  assert.equal(cols[1].cards[0].id, 'k');
  assert.ok(cols[1].cards[1].id.startsWith('doing:plain'));
  assert.deepEqual(P.normalizeKanban({}), []);
});

test('form: defaults, options, coercion and clamping', () => {
  assert.equal(P.defaultFieldValue({ type: 'toggle' }), false);
  assert.equal(P.defaultFieldValue({ type: 'slider', min: 5 }), 5);
  assert.equal(P.defaultFieldValue({ type: 'select', options: ['x', 'y'] }), 'x');
  assert.equal(P.defaultFieldValue({ type: 'text', value: 'v' }), 'v');
  assert.deepEqual(P.normalizeOptions(['a', { value: 1, label: 'One' }, { value: 2 }]), [{ value: 'a', label: 'a' }, { value: 1, label: 'One' }, { value: 2, label: '2' }]);
  assert.equal(P.coerceField({ type: 'number', min: 0, max: 10 }, '15'), 10);
  assert.equal(P.coerceField({ type: 'number', min: 0 }, '-3'), 0);
  assert.equal(P.coerceField({ type: 'number' }, ''), '');
  assert.equal(P.coerceField({ type: 'number' }, 'abc'), '');
  assert.equal(P.coerceField({ type: 'slider', min: 0, max: 100 }, '42'), 42);
  assert.equal(P.coerceField({ type: 'select', options: [1, 2] }, '2'), 2);
  assert.equal(P.coerceField({ type: 'toggle' }, 1), true);
  assert.equal(P.coerceField({ type: 'text' }, 7), '7');
});

test('markdown-lite: blocks and inline spans, no HTML ever', () => {
  const b = P.parseMarkdown('# Title\n\nsome **bold** text\ncontinued\n\n- a\n- b\n1. one\n\n> quote\n\n```\ncode <b>\n```');
  assert.deepEqual(b.map((x) => x.t), ['h', 'p', 'ul', 'ol', 'quote', 'code']);
  assert.equal(b[1].text, 'some **bold** text continued');
  assert.deepEqual(b[2].items, ['a', 'b']);
  assert.equal(b[5].text, 'code <b>');
  assert.deepEqual(P.parseInline('a `c` **b** *i* [l](https://x.io) z'), ['a ', { t: 'code', text: 'c' }, ' ', { t: 'b', text: 'b' }, ' ', { t: 'i', text: 'i' }, ' ', { t: 'a', text: 'l', href: 'https://x.io' }, ' z']);
  assert.deepEqual(P.parseInline('[x](javascript:alert(1))'), ['[x](javascript:alert(1))'], 'only http(s) links become links');
  assert.deepEqual(P.parseMarkdown(''), []);
});

test('sparkline and arc geometry', () => {
  const s = P.sparkPath([1, 3, 2], 100, 20, 0);
  assert.equal(s.d, 'M0 20L50 0L100 10');
  assert.equal(s.fx, 1);
  assert.equal(s.fy, 0.5);
  assert.equal(P.sparkPath([4, 4], 100, 20, 0).d, 'M0 10L100 10');
  assert.equal(P.sparkPath([], 100, 20).d, '');
  assert.equal(P.arcPath(50, 50, 40, 0, 90), 'M50 10A40 40 0 0 1 90 50');
  assert.match(P.arcPath(50, 50, 40, -120, 120), /A40 40 0 1 1/);
  near(P.arcLength(80, 240), (80 * 240 * Math.PI) / 180);
});

test('panel/ui is wired: house import exists and every file is <= 800 lines', () => {
  assert.equal(HOUSE_IMPORTS['panel/ui'], 'ui/index.js');
  const files = readdirSync(UI_DIR).filter((f) => f.endsWith('.js'));
  assert.ok(files.includes('index.js') && files.includes('core.js'));
  for (const f of files) assert.ok(readFileSync(join(UI_DIR, f), 'utf8').split('\n').length <= MAX_LINES, f);
  const index = readFileSync(join(UI_DIR, 'index.js'), 'utf8');
  for (const f of files.filter((x) => !['index.js', 'pure.js'].includes(x) && !x.startsWith('chart-'))) assert.ok(index.includes(`./${f}`), `${f} is re-exported`);
});
