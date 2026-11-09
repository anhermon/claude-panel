// board-logic.test.mjs - the board's pure logic: data normalising, grid planning, change queue, sanitiser, diagram layout.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  CAPS, CHANGE_GAP_MS, GRID_COLS, GRID_ROWS_MAX, MAX_FRAMES, MAX_MOUNTED, QUIET_AFTER_MS, SHAPES,
  capText, createChangeQueue, formatMetric, isQuiet, minSizeFor, moreCount, nextOp, normalizeData, parseMetric, planGrid, safeColor, safeImageSrc, scaleSeries, shapeOf, sortLanes,
} from './board-logic.mjs';
import { sanitizeHtml, cleanStyle } from './sanitize.mjs';
import { MIN_FONT, layerGraph, layoutDiagram, normalizeDiagram } from './diagram-layout.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(join(here, 'fixtures', `${name}.json`), 'utf8'));
const frame = (id, type = 'text', extra = {}) => ({ id, type, title: id, size: 'm', text: 'hi', ...extra });
const measure = (text, font) => text.length * font * 0.55;

test('capText trims, collapses and caps with an ellipsis', () => {
  assert.equal(capText('  a   b ', 10), 'a b');
  assert.equal(capText('x'.repeat(50), 10).length, 10);
  assert.equal(capText(undefined, 5), '');
});

test('safeColor and safeImageSrc only let safe values through', () => {
  assert.equal(safeColor('#fff'), '#fff');
  assert.equal(safeColor('red; background:url(x)'), null);
  assert.equal(safeImageSrc('pics/a.png'), 'pics/a.png');
  assert.equal(safeImageSrc('../a.png'), null);
  assert.equal(safeImageSrc('https://x.test/a.png'), null);
  assert.equal(safeImageSrc('data:image/svg+xml;utf8,<svg/>'), 'data:image/svg+xml;utf8,<svg/>');
  assert.equal(safeImageSrc('data:text/html,<script>'), null);
});

test('metric parse/format round-trips and keeps grouping and decimals', () => {
  const p = parseMetric('1,840 ms');
  assert.equal(p.n, 1840);
  assert.equal(formatMetric(p, 1840), '1,840 ms');
  assert.equal(formatMetric(parseMetric('12.5%'), 3.25), '3.3%');
  assert.equal(parseMetric('n/a'), null);
});

test('sortLanes puts active lanes first and drops junk', () => {
  const out = sortLanes([{ id: 'a', state: 'done' }, { id: 'b', state: 'working' }, 7, null]);
  assert.deepEqual(out.map((l) => l.id), ['b', 'a']);
});

test('normalizeData never throws and repairs ids, sizes, titles', () => {
  for (const junk of [null, 5, 'x', [], { frames: 'no' }]) assert.deepEqual(normalizeData(junk).frames, []);
  const d = normalizeData({ frames: [{ id: 'Bad Id!', type: 'text', title: 'x'.repeat(99), size: 'huge' }, { id: 'a', type: 'text' }, { id: 'a', type: 'text' }, 3] });
  assert.equal(d.frames.length, 3);
  assert.equal(new Set(d.frames.map((f) => f.id)).size, 3);
  assert.ok(d.frames.every((f) => /^[a-z0-9-]{1,24}$/.test(f.id)));
  assert.ok(d.frames[0].title.length <= CAPS.title);
  assert.equal(d.frames[0].size, 'm');
});

test('normalizeData feeds data.lanes to lanes frames and data.now to now frames', () => {
  const d = normalizeData({ lanes: [{ id: 'a', label: 'A', state: 'working', pct: 40 }], now: { title: 'Doing it', status: 'working' }, frames: [{ id: 'l', type: 'lanes' }, { id: 'n', type: 'now' }] });
  assert.equal(d.frames[0].lanes.length, 1);
  assert.equal(d.frames[1].text, 'Doing it');
});

function assertValidPlan(plan) {
  const used = new Set();
  for (const c of plan.cells) {
    assert.ok(c.col >= 0 && c.row >= 0 && c.col + c.w <= plan.cols && c.row + c.h <= plan.rows, `${c.id} inside the grid`);
    for (let y = c.row; y < c.row + c.h; y++) for (let x = c.col; x < c.col + c.w; x++) {
      assert.ok(!used.has(`${x},${y}`), `${c.id} overlaps at ${x},${y}`);
      used.add(`${x},${y}`);
    }
  }
  return used.size;
}

test('planGrid: 1 frame fills the board, 2 split it, more tile a 4x3 grid without overlaps or holes', () => {
  assert.deepEqual(planGrid([frame('a')]).cells.map((c) => [c.col, c.row, c.w, c.h]), [[0, 0, 1, 1]]);
  assert.equal(planGrid([frame('a'), frame('b')]).cells.length, 2);
  for (let n = 3; n <= 8; n++) {
    const plan = planGrid(Array.from({ length: n }, (_, i) => frame(`f${i}`, 'metric', { size: i === 0 ? 'l' : 's', value: '1' })));
    const covered = assertValidPlan(plan);
    assert.equal(plan.cols, GRID_COLS);
    assert.ok(plan.rows <= GRID_ROWS_MAX);
    assert.equal(covered, plan.cols * plan.rows, `${n} frames leave no hole`);
    assert.equal(plan.cells.length + plan.hidden, n);
  }
});

test('planGrid: more than MAX_FRAMES reports the rest as hidden', () => {
  const plan = planGrid(Array.from({ length: 11 }, (_, i) => frame(`f${i}`, 'metric', { size: 's', value: '1' })));
  assert.equal(plan.cells.length, MAX_FRAMES);
  assert.equal(plan.hidden, 3);
});

test('planGrid: frames are never made smaller than their content needs', () => {
  const nodes = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, label: id }));
  const edges = [['a', 'b'], ['b', 'c'], ['c', 'd'], ['d', 'e']].map(([from, to]) => ({ from, to }));
  const plan = planGrid([frame('d', 'diagram', { size: 's', nodes, edges }), frame('m', 'metric', { value: '1', size: 's' }), frame('n', 'now', { size: 's' })]);
  const d = plan.cells.find((c) => c.id === 'd');
  assert.equal(d.size, 'xl');
  assert.equal(d.w, GRID_COLS);
});

test('planGrid on the shipped fixtures: valid, nothing silently lost', () => {
  for (const name of readdirSync(join(here, 'fixtures')).map((f) => f.replace('.json', ''))) {
    const data = normalizeData(fixture(name));
    const plan = planGrid(data.frames);
    assertValidPlan(plan);
    assert.equal(plan.cells.length + plan.hidden, data.frames.length, name);
  }
});

// ---- aspect -> grid ------------------------------------------------------------------------------------------------
const ASPECTS = { phone: 720 / 1600, narrow: 600 / 1300, tabletPortrait: 0.79, square: 1, wide: 1.3, laptop: 960 / 540, ultra: 21 / 9 };
const shapeFrames = (n, extra = {}) => Array.from({ length: n }, (_, i) => frame(`f${i}`, 'metric', { size: 's', value: String(i), ...extra }));

test('shapeOf: portrait below 0.8, square-ish up to 1.3, landscape above', () => {
  assert.deepEqual(['phone', 'narrow', 'tabletPortrait', 'square', 'wide', 'laptop', 'ultra'].map((k) => shapeOf(ASPECTS[k])),
    ['portrait', 'portrait', 'portrait', 'square', 'square', 'landscape', 'landscape']);
  assert.equal(shapeOf(0.8), 'square');
  assert.equal(shapeOf(1.31), 'landscape');
});

test('planGrid: the grid follows the aspect (2 columns up to 6 rows tall, 3 x 4, 4 x 3)', () => {
  const frames = shapeFrames(8);
  const grid = (aspect) => { const p = planGrid(frames, { aspect }); return [p.shape, p.cols]; };
  assert.deepEqual(grid(ASPECTS.phone), ['portrait', 2]);
  assert.deepEqual(grid(ASPECTS.square), ['square', 3]);
  assert.deepEqual(grid(ASPECTS.laptop), ['landscape', 4]);
  for (const [shape, def] of Object.entries(SHAPES)) {
    const p = planGrid(frames, { aspect: { portrait: ASPECTS.phone, square: 1, landscape: 16 / 9 }[shape] });
    assert.ok(p.cols <= Math.max(...def.cols) && p.rows <= def.rowsMax, shape);
  }
});

test('planGrid: few frames in a tall pane stack in one column instead of becoming thin towers', () => {
  const p = planGrid(shapeFrames(3), { aspect: ASPECTS.phone });
  assert.equal(p.cols, 1);
  assert.equal(assertValidPlan(p), p.cols * p.rows);
  assert.deepEqual(p.cells.map((c) => c.row), [0, 1, 2]);
  const two = planGrid(shapeFrames(2), { aspect: ASPECTS.phone });
  assert.deepEqual(two.cells.map((c) => [c.col, c.row]), [[0, 0], [0, 1]]);
});

test('planGrid: the visible cap is 10 in portrait and 8 elsewhere; the rest is counted as hidden', () => {
  assert.equal(MAX_MOUNTED, 10);
  const tall = planGrid(shapeFrames(11), { aspect: ASPECTS.phone });
  assert.equal(tall.cells.length, 10);
  assert.equal(tall.hidden, 1);
  assert.equal(planGrid(shapeFrames(10), { aspect: ASPECTS.phone }).hidden, 0);
  assert.equal(planGrid(shapeFrames(10), { aspect: ASPECTS.laptop }).hidden, 2);
  assert.equal(planGrid(shapeFrames(10), { aspect: ASPECTS.square }).hidden, 2);
});

test('planGrid guarantee: every placed frame gets at least the share of the board its content needs, in every shape', () => {
  // physical share: the minimum size's cells over the shape's nominal grid, against the cell's share of the actual grid
  const share = (plan, f) => {
    const def = SHAPES[plan.shape];
    const [w, h] = def.sizes[minSizeFor(f, plan.shape)];
    return [Math.min(1, w / Math.max(...def.cols)), h / def.rowsMax];
  };
  for (const name of readdirSync(join(here, 'fixtures')).map((f) => f.replace('.json', ''))) {
    const data = normalizeData(fixture(name));
    for (const [label, aspect] of Object.entries(ASPECTS)) {
      const plan = planGrid(data.frames, { aspect });
      assertValidPlan(plan);
      assert.equal(plan.cells.length + plan.hidden, data.frames.length, `${name} ${label}`);
      for (const c of plan.cells) {
        const [needW, needH] = share(plan, data.frames.find((f) => f.id === c.id));
        assert.ok(c.w / plan.cols >= needW - 1e-9 && c.h / plan.rows >= needH - 1e-9, `${name} ${label}: ${c.id} has ${c.w}/${plan.cols} x ${c.h}/${plan.rows}, needs ${needW} x ${needH}`);
      }
    }
  }
});

test('planGrid: busy fits every frame in the portrait shapes and the landscape one (no +N more)', () => {
  const frames = normalizeData(fixture('busy')).frames;
  for (const aspect of [ASPECTS.phone, ASPECTS.narrow, ASPECTS.laptop]) {
    const p = planGrid(frames, { aspect });
    assert.equal(p.hidden, 0, `aspect ${aspect}`);
    assert.equal(p.cells.length, frames.length);
  }
});

test('planGrid: a 5-item timeline in a portrait pane keeps a tall cell (l), not a thin strip, and nothing is hidden', () => {
  const items = Array.from({ length: 5 }, (_, i) => ({ when: `0${i}:00`, text: `step ${i}` }));
  const frames = [frame('t', 'timeline', { size: 'xl', items }), ...shapeFrames(8)];
  const p = planGrid(frames, { aspect: ASPECTS.phone });
  assert.equal(p.hidden, 0);
  assert.ok(p.cells.find((c) => c.id === 't').h >= 2);
});

test('moreCount: frames still queued to appear are not "more"; cut and unplaced ones are', () => {
  assert.equal(moreCount({ total: 8, targeted: 8, mounted: 6, placed: 6 }), 0, 'two frames are still on their way in');
  assert.equal(moreCount({ total: 8, targeted: 8, mounted: 8, placed: 8 }), 0);
  assert.equal(moreCount({ total: 12, targeted: 10, mounted: 10, placed: 8 }), 4, '2 cut by the cap + 2 mounted without a cell');
  assert.equal(moreCount({ total: 3, targeted: 3, mounted: 6, placed: 6 }), 0, 'frames being removed never count');
});

test('nextOp walks remove, update, add, reorder one step at a time and then stops', () => {
  const a = frame('a'); const b = frame('b'); const c = frame('c');
  assert.deepEqual(nextOp([a, b], [a]), { kind: 'remove', id: 'b' });
  assert.equal(nextOp([a], [{ ...a, text: 'new' }]).kind, 'update');
  assert.equal(nextOp([a], [a, c]).kind, 'add');
  assert.equal(nextOp([a, b], [b, a]).kind, 'reorder');
  assert.equal(nextOp([a, b], [a, b]), null);
});

test('change queue: first paint shows everything, later changes are 600ms apart and converge', () => {
  const q = createChangeQueue();
  const a = frame('a'); const b = frame('b'); const c = frame('c');
  q.setTarget([a, b]);
  assert.equal(q.step(0).kind, 'init');
  assert.deepEqual(q.shown().map((f) => f.id), ['a', 'b']);
  q.setTarget([{ ...a, text: 'x' }, { ...b, text: 'y' }, c]);
  assert.equal(q.step(100), null, 'too soon');
  assert.equal(q.waitMs(100), CHANGE_GAP_MS - 100);
  const kinds = [];
  for (let t = CHANGE_GAP_MS; kinds.length < 10; t += CHANGE_GAP_MS) {
    const op = q.step(t);
    if (!op) break;
    kinds.push(op.kind);
  }
  assert.deepEqual(kinds, ['update', 'update', 'add']);
  assert.equal(q.pending(), false);
  assert.deepEqual(q.shown(), q.target());
});

test('change queue: a target that changes while waiting is honoured (latest wins)', () => {
  const q = createChangeQueue();
  const a = frame('a');
  q.setTarget([a]); q.step(0);
  q.setTarget([{ ...a, text: '1' }]);
  q.setTarget([{ ...a, text: '2' }]);
  q.step(CHANGE_GAP_MS);
  assert.equal(q.shown()[0].text, '2');
});

test('isQuiet flips after QUIET_AFTER_MS', () => {
  assert.equal(isQuiet(QUIET_AFTER_MS - 1, 0), false);
  assert.equal(isQuiet(QUIET_AFTER_MS, 0), true);
});

test('scaleSeries maps the extremes to the box edges (y flipped)', () => {
  const pts = scaleSeries([0, 5, 10], 100, 50);
  assert.deepEqual(pts.map((p) => [p.x, p.y]), [[0, 50], [50, 25], [100, 0]]);
  assert.equal(scaleSeries([3, 3], 10, 10).length, 2, 'flat series does not divide by zero');
});

test('sanitizeHtml keeps text, basic tags and inline svg', () => {
  const out = sanitizeHtml('<p class="a">hi <b>there</b></p><svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="#f00"/></svg>');
  assert.match(out, /<p class="a">hi <b>there<\/b><\/p>/);
  assert.match(out, /<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="#f00"\/><\/svg>/);
});

test('sanitizeHtml removes scripts, handlers, urls, foreign content and obfuscated schemes', () => {
  const attacks = [
    '<script>alert(1)</script>x', '<img src=x onerror=alert(1)>', '<a href="javascript:alert(1)">x</a>', '<svg onload=alert(1)></svg>',
    '<svg><foreignObject><iframe src="//evil"></iframe></foreignObject></svg>', '<svg><use href="//evil#a"/></svg>', '<svg><image href="http://evil/a.png"/></svg>',
    '<svg><circle fill="url(http://evil/x)"/></svg>', '<div style="background:url(http://evil/x)">x</div>', '<div style="width:expression(alert(1))">x</div>',
    '<svg><a xlink:href="java&#x0A;script:alert(1)"><text>x</text></a></svg>', '<svg><animate attributeName="href" values="javascript:alert(1)"/></svg>',
    '<style>*{background:url(//evil)}</style>', '<iframe src="x"></iframe>', '<form action="//evil"><input></form>', '<div id="x" onclick="a()">x</div>',
    '<svg><set attributeName="onclick" to="alert(1)"/></svg>', '<math><mi xlink:href="javascript:x">x</mi></math>', '<<script>script>alert(1)<</script>/script>',
  ];
  for (const a of attacks) {
    const out = sanitizeHtml(a);
    assert.doesNotMatch(out, /<script|<iframe|<style|<form|<input|<use|<image|<animate|<set|<foreignObject|<math|<a[ >]/i, a);
    assert.doesNotMatch(out, /\son\w+\s*=|javascript:|url\((?!#)|expression|http:|https:|\/\/evil/i, a);
  }
});

test('sanitizeHtml prefixes ids and local gradient references, closes open tags, caps length', () => {
  const out = sanitizeHtml('<svg><defs><linearGradient id="g"/></defs><rect fill="url(#g)"/></svg><div>open', { idPrefix: 'p-' });
  assert.match(out, /id="p-g"/);
  assert.match(out, /fill="url\(#p-g\)"/);
  assert.match(out, /<div>open<\/div>$/);
  assert.ok(sanitizeHtml('a'.repeat(20000)).length <= 8192);
});

test('cleanStyle keeps allow-listed declarations only', () => {
  assert.equal(cleanStyle('color:#fff; position:fixed; width:50%'), 'color:#fff;width:50%');
  assert.equal(cleanStyle('background:url(x)'), '');
});

test('layerGraph: layers follow the edges; a cycle does not hang', () => {
  const nodes = ['a', 'b', 'c'].map((id) => ({ id }));
  const g = layerGraph(nodes, [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'a' }]);
  assert.deepEqual([g.layer.get('a'), g.layer.get('b'), g.layer.get('c')], [0, 1, 2]);
  assert.equal(g.back.size, 1);
});

test('normalizeDiagram drops unknown edge ends, self loops and duplicate nodes', () => {
  const spec = normalizeDiagram({ nodes: [{ id: 'a' }, { id: 'a' }, { id: 'b', label: 'B' }, 4], edges: [{ from: 'a', to: 'b' }, { from: 'a', to: 'zz' }, { from: 'b', to: 'b' }] });
  assert.equal(spec.nodes.length, 2);
  assert.equal(spec.edges.length, 1);
});

test('layoutDiagram: no overlapping nodes, inside the box, font never below the minimum', () => {
  const spec = normalizeDiagram(fixture('busy').frames.find((f) => f.type === 'diagram'));
  const lay = layoutDiagram(spec, { width: 900, height: 300, font: 22, measure });
  assert.ok(lay.font >= MIN_FONT);
  for (const [i, a] of lay.nodes.entries()) {
    assert.ok(a.x >= 0 && a.y >= 0 && a.x + a.w <= lay.base.width + 0.5 && a.y + a.h <= lay.base.height + 0.5, `${a.id} inside`);
    for (const b of lay.nodes.slice(i + 1)) assert.ok(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y, `${a.id} vs ${b.id}`);
  }
  assert.equal(lay.edges.length, spec.edges.length);
});

test('layoutDiagram honours a larger minFont (scaled stage) and shrinks to fit rather than overflow', () => {
  const spec = normalizeDiagram(fixture('busy').frames.find((f) => f.type === 'diagram'));
  const big = layoutDiagram(spec, { width: 1800, height: 600, font: 40, measure, minFont: 28 });
  assert.ok(big.font >= 28);
  const tight = layoutDiagram(spec, { width: 200, height: 100, font: 22, measure });
  assert.equal(tight.fits, false);
  assert.ok(tight.scale < 1);
});

test('layoutDiagram: a 6-node diagram in a half tile keeps the minimum font (tighter wrapping) instead of being scaled below it', () => {
  const spec = normalizeDiagram(fixture('halftile').frames.find((f) => f.type === 'diagram'));
  const loose = layoutDiagram(spec, { width: 4000, height: 4000, font: 14, measure });
  assert.ok(loose.base.width > 380, `needs ${loose.base.width} px with the usual wrapping, more than the 380 px tile`);
  const lay = layoutDiagram(spec, { width: 380, height: 260, font: 14, measure });
  assert.ok(lay.fits, 'fits at the minimum font');
  assert.equal(lay.scale, 1);
  assert.equal(lay.font, MIN_FONT);
  assert.ok(lay.nodes.some((n) => n.lines.length === 2), 'some labels wrapped to two lines');
  for (const [i, a] of lay.nodes.entries()) for (const b of lay.nodes.slice(i + 1)) assert.ok(!boxHit(a, b), `${a.id} / ${b.id}`);
});

const boxHit = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const chipBox = (e) => ({ x: e.lx - e.lw / 2, y: e.ly - e.lh / 2, w: e.lw, h: e.lh });

test('layoutDiagram down: layers are rows top to bottom, nothing overlaps, edge labels never sit on a node', () => {
  const spec = normalizeDiagram(fixture('busy').frames.find((f) => f.type === 'diagram'));
  const graph = layerGraph(spec.nodes, spec.edges);
  const lay = layoutDiagram(spec, { width: 640, height: 520, font: 24, measure, direction: 'down' });
  assert.ok(lay.fits && lay.font >= MIN_FONT);
  const at = new Map(lay.nodes.map((n) => [n.id, n]));
  for (const e of spec.edges) {
    if (!graph.back.has(`${e.from}>${e.to}`)) assert.ok(at.get(e.from).y + at.get(e.from).h <= at.get(e.to).y, `${e.from} above ${e.to}`);
  }
  for (const [i, a] of lay.nodes.entries()) for (const b of lay.nodes.slice(i + 1)) assert.ok(!boxHit(a, b), `${a.id} / ${b.id}`);
  for (const e of lay.edges.filter((x) => x.label)) for (const n of lay.nodes) assert.ok(!boxHit(chipBox(e), n), `label ${e.label} on ${n.id}`);
  assert.ok(lay.base.width <= 640 && lay.base.height <= 520);
});

test('layoutDiagram down: a cycle is drawn as a loop on the right and still fits', () => {
  const spec = normalizeDiagram({ nodes: [{ id: 'a', label: 'Plan' }, { id: 'b', label: 'Build' }, { id: 'c', label: 'Review' }], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'a', label: 'again' }] });
  const lay = layoutDiagram(spec, { width: 420, height: 420, font: 20, measure, direction: 'down' });
  assert.ok(lay.edges.some((e) => e.back));
  assert.ok(lay.fits);
  const loop = lay.edges.find((e) => e.back);
  assert.ok(loop.lx <= lay.base.width);
});

test('layoutDiagram right: edge labels never sit on a node either', () => {
  const spec = normalizeDiagram(fixture('busy').frames.find((f) => f.type === 'diagram'));
  const lay = layoutDiagram(spec, { width: 1100, height: 280, font: 20, measure });
  for (const e of lay.edges.filter((x) => x.label)) for (const n of lay.nodes) assert.ok(!boxHit(chipBox(e), n), `label ${e.label} on ${n.id}`);
});
