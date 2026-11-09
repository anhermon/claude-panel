import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMPACT_CONFIG, FALLBACK_TOKENS, HIGHLIGHT_MAX, SEQUENCE, VIEW, croppedAxes, edgeLeaves, fitView, isDrag, mermaidTheme, nodeIdFromDomId, normalizeHighlight, resolveTokens, sequenceActors, sequenceGeometry, wheelFactor, zoomAt } from './diagram-logic.mjs';

test('normalizeHighlight keeps valid ids and states, drops the rest, caps the count', () => {
  assert.deepEqual(normalizeHighlight({ a: 'active', 'b-2': 'done', 'bad id': 'active', c: 'weird', d: 7 }), { a: 'active', 'b-2': 'done' });
  assert.deepEqual(normalizeHighlight(null), {});
  assert.deepEqual(normalizeHighlight([1]), {});
  const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`n${i}`, 'todo']));
  assert.equal(Object.keys(normalizeHighlight(many)).length, HIGHLIGHT_MAX);
});

test('nodeIdFromDomId reads the author id out of Mermaid element ids', () => {
  assert.equal(nodeIdFromDomId('flowchart-build-3'), 'build');
  assert.equal(nodeIdFromDomId('uml-svg-2-flowchart-build-0'), 'build');
  assert.equal(nodeIdFromDomId('state-Idle-0'), 'Idle');
  assert.equal(nodeIdFromDomId('classId-Animal-12'), 'Animal');
  assert.equal(nodeIdFromDomId('entity-CUSTOMER-1'), 'CUSTOMER');
  assert.equal(nodeIdFromDomId('L_a_b_0'), null);
  assert.equal(nodeIdFromDomId(undefined), null);
});

test('edgeLeaves matches the source of a flowchart edge id', () => {
  assert.ok(edgeLeaves('L_a1_b1_0', 'a1'));
  assert.ok(!edgeLeaves('L_b1_a1_0', 'a1'));
  assert.ok(!edgeLeaves(undefined, 'a1'));
});

test('resolveTokens prefers the first set variable and falls back per scheme', () => {
  const read = (n) => ({ '--acc': '#111111', '--panel-fg': '#222222' })[n] ?? '';
  const t = resolveTokens(read, 'dark');
  assert.equal(t.acc, '#111111');
  assert.equal(t.fg, '#222222');
  assert.equal(t.ok, FALLBACK_TOKENS.dark.ok);
  assert.equal(resolveTokens(() => '', 'light').bg, FALLBACK_TOKENS.light.bg);
  assert.equal(mermaidTheme(t).textColor, t.fg);
});

test('fitView scales to fit, centres small content, anchors big content, honours the readable floor', () => {
  const small = fitView({ vw: 400, vh: 300, w: 100, h: 50 });
  assert.equal(small.k, VIEW.FIT_MAX);
  assert.ok(small.x > VIEW.PAD && small.y > VIEW.PAD);
  const exact = fitView({ vw: 416, vh: 1000, w: 800, h: 100 }, { min: 0.1 });
  assert.ok(Math.abs(exact.k - 0.5) < 1e-9);
  const huge = fitView({ vw: 300, vh: 300, w: 2000, h: 2000 });
  assert.equal(huge.k, VIEW.READABLE_MIN);
  assert.equal(huge.x, VIEW.PAD);
  assert.deepEqual(fitView({ vw: 0, vh: 0, w: 1, h: 1 }), { k: 1, x: 0, y: 0 });
});

test('zoomAt keeps the point under the pointer and clamps the scale', () => {
  const v = zoomAt({ k: 1, x: 0, y: 0 }, 100, 50, 2);
  assert.deepEqual(v, { k: 2, x: -100, y: -50 });
  assert.equal(zoomAt({ k: 5, x: 0, y: 0 }, 0, 0, 10).k, VIEW.ZOOM_MAX);
  assert.equal(zoomAt({ k: 1, x: 0, y: 0 }, 0, 0, 0.0001).k, VIEW.ZOOM_MIN);
});

test('wheelFactor zooms in on a negative delta, bounded', () => {
  assert.ok(wheelFactor(-100) > 1 && wheelFactor(100) < 1);
  assert.equal(wheelFactor(-1e6), wheelFactor(-120));
});

test('isDrag separates a click from a drag', () => {
  assert.ok(!isDrag(1, 2));
  assert.ok(isDrag(10, 0));
});

const SEQ = 'sequenceDiagram\n  participant main as main\n  participant na1 as Survey the re…\n  participant na2 as Implement the…\n  participant na3 as Run the checks\n  participant na4 as Review the pa…\n  main->>na1: spawn Survey the re…\n  na1-->>main: done\n  na2--xmain: failed';

test('sequenceActors counts declared and message-only participants, 0 for other diagrams', () => {
  assert.equal(sequenceActors(SEQ), 5);
  assert.equal(sequenceActors('sequenceDiagram\n  A->>B: hi\n  B-->>C: yo'), 3);
  assert.equal(sequenceActors('flowchart LR\n  a --> b'), 0);
  assert.equal(sequenceActors(null), 0);
});

test('sequenceGeometry squeezes only when the compact defaults would not fit the tile at the readable floor', () => {
  assert.deepEqual(sequenceGeometry(SEQ, 1400), {}, 'wide tile: defaults fit');
  assert.deepEqual(sequenceGeometry('flowchart LR\n  a --> b', 300), {}, 'not a sequence');
  assert.deepEqual(sequenceGeometry(SEQ, 0), {}, 'no width yet');
  const narrow = sequenceGeometry(SEQ, 345);
  assert.equal(narrow.wrap, true);
  assert.equal(narrow.mirrorActors, false);
  assert.ok(narrow.width >= SEQUENCE.WIDTH_MIN && narrow.actorMargin >= SEQUENCE.MARGIN_MIN);
  const natural = 5 * (narrow.width + narrow.actorMargin);
  assert.ok(natural * VIEW.READABLE_MIN <= 345 - 2 * VIEW.PAD + 5, `natural ${natural} fits 345 px at the floor (+ rounding)`);
  assert.ok(sequenceGeometry(SEQ, 345).width < COMPACT_CONFIG.sequence.width);
  assert.deepEqual(sequenceGeometry(SEQ, 345), narrow, 'pure');
  const tiny = sequenceGeometry(SEQ, 120); // cannot fit legibly: the floor holds, the diagram will pan
  assert.equal(tiny.width, SEQUENCE.WIDTH_MIN);
  assert.equal(tiny.actorMargin, SEQUENCE.MARGIN_MIN);
});

test('croppedAxes names the axes that run past the viewport at the chosen view', () => {
  const box = { vw: 300, vh: 200, w: 1000, h: 100 };
  assert.equal(croppedAxes(box, { k: 0.2 }), '');
  assert.equal(croppedAxes(box, { k: 0.61 }), 'x');
  assert.equal(croppedAxes({ ...box, h: 600 }, { k: 0.61 }), 'xy');
  assert.equal(croppedAxes({ ...box, w: 100, h: 600 }, { k: 0.61 }), 'y');
});
