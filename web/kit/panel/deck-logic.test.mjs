import test from 'node:test';
import assert from 'node:assert/strict';
import * as L from './deck-logic.js';

// 3 horizontal slides: #0 has 2 fragment steps, #1 is a vertical stack of 2 (1 step, 0 steps), #2 has none.
const MODEL = [[2], [1, 0], [0]];
const at = (h, v, f) => ({ h, v, f });

test('parseHash accepts #/h, #/h/v, #/h/v/f and falls back to the first slide', () => {
  assert.deepEqual(L.parseHash('#/3'), at(3, 0, 0));
  assert.deepEqual(L.parseHash('#/3/2'), at(3, 2, 0));
  assert.deepEqual(L.parseHash('#/3/2/5'), at(3, 2, 5));
  assert.deepEqual(L.parseHash('/1/1/1/'), at(1, 1, 1));
  for (const bad of ['', '#', '#/', '#/x', '#/-1', '#/1/2/3/4', '#stage=deck', null, undefined, '#/1.5']) assert.deepEqual(L.parseHash(bad), at(0, 0, 0), String(bad));
});

test('formatHash drops trailing zeros and round-trips through parseHash', () => {
  assert.equal(L.formatHash(at(2, 0, 0)), '#/2');
  assert.equal(L.formatHash(at(2, 1, 0)), '#/2/1');
  assert.equal(L.formatHash(at(2, 0, 3)), '#/2/0/3');
  for (const p of [at(0, 0, 0), at(4, 0, 0), at(1, 2, 0), at(1, 2, 3), at(0, 0, 1)]) assert.deepEqual(L.parseHash(L.formatHash(p)), p);
});

test('fragmentOrder: unindexed fragments follow the previous index, explicit indices can reorder', () => {
  assert.deepEqual(L.fragmentOrder([null, null, null]), [0, 1, 2]);
  assert.deepEqual(L.fragmentOrder([NaN, 5, null]), [0, 5, 6]);
  assert.deepEqual(L.fragmentOrder([2, 0, 1]), [2, 0, 1]);
  assert.deepEqual(L.fragmentOrder([0, 0, null]), [0, 0, 1]); // same index = shown together
  assert.deepEqual(L.fragmentOrder([-3, null]), [0, 1]); // negative is not an index
});

test('fragmentSteps / visibleFragments: steps are distinct sorted indices; f counts steps, not fragments', () => {
  const order = L.fragmentOrder([0, 0, null, 7]); // [0,0,1,7]
  assert.deepEqual(L.fragmentSteps(order), [0, 1, 7]);
  assert.deepEqual(L.visibleFragments(order, 0), [false, false, false, false]);
  assert.deepEqual(L.visibleFragments(order, 1), [true, true, false, false]);
  assert.deepEqual(L.visibleFragments(order, 2), [true, true, true, false]);
  assert.deepEqual(L.visibleFragments(order, 3), [true, true, true, true]);
  assert.deepEqual(L.visibleFragments(L.fragmentOrder([2, 0, 1]), 1), [false, true, false]); // index 0 shows first
});

test('navigate next: fragments first, then down the stack, then the next column', () => {
  let p = at(0, 0, 0);
  const seen = [];
  for (let i = 0; i < 10; i++) { const n = L.navigate(MODEL, p, 'next'); if (L.samePos(n, p)) break; seen.push(L.formatHash(n)); p = n; }
  assert.deepEqual(seen, ['#/0/0/1', '#/0/0/2', '#/1', '#/1/0/1', '#/1/1', '#/2']);
  assert.deepEqual(L.navigate(MODEL, at(2, 0, 0), 'next'), at(2, 0, 0)); // end stays
});

test('navigate prev: undoes fragments, lands on the previous slide fully revealed', () => {
  assert.deepEqual(L.navigate(MODEL, at(0, 0, 2), 'prev'), at(0, 0, 1));
  assert.deepEqual(L.navigate(MODEL, at(1, 0, 0), 'prev'), at(0, 0, 2));
  assert.deepEqual(L.navigate(MODEL, at(1, 1, 0), 'prev'), at(1, 0, 1));
  assert.deepEqual(L.navigate(MODEL, at(2, 0, 0), 'prev'), at(1, 1, 0)); // back into the stack's last slide
  assert.deepEqual(L.navigate(MODEL, at(0, 0, 0), 'prev'), at(0, 0, 0));
});

test('navigate right/left skip the rest of a vertical stack; first/last; unknown action is a no-op', () => {
  assert.deepEqual(L.navigate(MODEL, at(1, 0, 1), 'right'), at(2, 0, 0));
  assert.deepEqual(L.navigate(MODEL, at(1, 1, 0), 'right'), at(2, 0, 0));
  assert.deepEqual(L.navigate(MODEL, at(1, 1, 0), 'left'), at(0, 0, 2));
  assert.deepEqual(L.navigate(MODEL, at(0, 0, 0), 'right'), at(0, 0, 1));
  assert.deepEqual(L.navigate(MODEL, at(1, 1, 0), 'first'), at(0, 0, 0));
  assert.deepEqual(L.navigate(MODEL, at(0, 0, 0), 'last'), at(2, 0, 0));
  assert.deepEqual(L.navigate([[0], [3]], at(0, 0, 0), 'last'), at(1, 0, 3));
  assert.deepEqual(L.navigate(MODEL, at(1, 0, 0), 'bogus'), at(1, 0, 0));
});

test('every slide is reachable by repeating next from the start (keyboard reachability)', () => {
  const reached = new Set();
  let p = at(0, 0, 0);
  for (let i = 0; i < 50; i++) { reached.add(`${p.h}/${p.v}`); p = L.navigate(MODEL, p, 'next'); }
  assert.deepEqual([...reached].sort(), L.leaves(MODEL).map(({ h, v }) => `${h}/${v}`).sort());
});

test('clampPos keeps positions inside the model', () => {
  assert.deepEqual(L.clampPos(MODEL, at(99, 99, 99)), at(2, 0, 0));
  assert.deepEqual(L.clampPos(MODEL, at(1, 5, 9)), at(1, 1, 0));
  assert.deepEqual(L.clampPos(MODEL, at(0, 0, 9)), at(0, 0, 2));
  assert.deepEqual(L.clampPos(MODEL, at(-1, -1, -1)), at(0, 0, 0));
});

test('keyToAction maps the documented keys and ignores modified or unknown ones', () => {
  const expect = { ArrowRight: 'right', ArrowLeft: 'left', ArrowDown: 'next', ArrowUp: 'prev', PageDown: 'next', PageUp: 'prev', ' ': 'next', Home: 'first', End: 'last', o: 'overview', O: 'overview', f: 'fullscreen', F: 'fullscreen', i: 'drawer', I: 'drawer', s: 'drawer', m: 'mute', Escape: 'escape', Enter: 'enter', Space: 'next' };
  for (const [key, action] of Object.entries(expect)) assert.equal(L.keyToAction(key), action, key);
  assert.equal(L.keyToAction(' ', { shift: true }), 'prev');
  assert.equal(L.keyToAction('ArrowRight', { meta: true }), null); // cmd+arrow is the browser's
  assert.equal(L.keyToAction('f', { ctrl: true }), null);
  assert.equal(L.keyToAction('Tab'), null); // never trap Tab
  assert.equal(L.keyToAction('toString'), null);
  assert.equal(L.keyToAction(42), null);
});

test('normaliseHostKey validates the host key message', () => {
  assert.deepEqual(L.normaliseHostKey({ key: 'ArrowLeft' }), { key: 'ArrowLeft', shift: false, ctrl: false, meta: false, alt: false });
  assert.equal(L.normaliseHostKey({ key: 'x', shift: true }).shift, true);
  assert.equal(L.normaliseHostKey({ key: 'x', shift: 'yes' }).shift, false);
  for (const bad of [null, undefined, 'k', 3, {}, { key: 3 }, { key: '' }, { key: 'k'.repeat(L.KEY_MAX_LENGTH + 1) }]) assert.equal(L.normaliseHostKey(bad), null, JSON.stringify(bad));
});

test('swipeAction needs distance and a dominant axis', () => {
  assert.equal(L.swipeAction(-120, 10), 'next');
  assert.equal(L.swipeAction(120, -10), 'prev');
  assert.equal(L.swipeAction(5, -90), 'next');
  assert.equal(L.swipeAction(0, 90), 'prev');
  assert.equal(L.swipeAction(-40, 0), null);
  assert.equal(L.swipeAction(-80, 70), null); // diagonal
});

test('clickAction: left 30 % is back, the rest forward', () => {
  assert.equal(L.clickAction(10, 1000), 'prev');
  assert.equal(L.clickAction(299, 1000), 'prev');
  assert.equal(L.clickAction(300, 1000), 'next');
  assert.equal(L.clickAction(900, 1000), 'next');
  assert.equal(L.clickAction(5, 0), 'next');
});

test('scaleToFit letterboxes 16:9 and never reaches zero', () => {
  assert.equal(L.scaleToFit(1280, 720), 1);
  assert.equal(L.scaleToFit(640, 720), 0.5);
  assert.equal(L.scaleToFit(2560, 720), 1);
  assert.equal(L.scaleToFit(0, 0), L.MIN_SCALE);
});

test('normaliseTransition', () => {
  assert.equal(L.normaliseTransition('fade'), 'fade');
  assert.equal(L.normaliseTransition(' ZOOM '), 'zoom');
  assert.equal(L.normaliseTransition('fade-in slide-out'), 'fade');
  assert.equal(L.normaliseTransition('none'), 'none');
  assert.equal(L.normaliseTransition('convex'), 'slide');
  assert.equal(L.normaliseTransition(undefined, 'fade'), 'fade');
});

test('slideTitle prefers data-title, then the heading, then a number; deckReport clips', () => {
  assert.equal(L.slideTitle('  Custom  ', 'Heading', 0), 'Custom');
  assert.equal(L.slideTitle('', 'The   Problem\n', 1), 'The Problem');
  assert.equal(L.slideTitle('', '', 2), 'Slide 3');
  const r = L.deckReport(at(1, 2, 3), 6, 'T'.repeat(500), 'n'.repeat(5000));
  assert.equal(r.type, 'panel-deck');
  assert.deepEqual([r.h, r.v, r.f, r.count], [1, 2, 3, 6]);
  assert.equal(r.title.length, L.REPORT_TITLE_MAX);
  assert.equal(r.notes.length, L.REPORT_NOTES_MAX);
  assert.deepEqual(Object.keys(r), ['type', 'h', 'v', 'f', 'count', 'title', 'notes']);
});

test('overviewLayout: all slides get a cell, thumbnails stay inside the viewport, many slides scroll', () => {
  const o = L.overviewLayout(6, 1280, 720);
  assert.equal(o.cells.length, 6);
  const cellW = L.SLIDE_WIDTH * o.scale;
  for (const c of o.cells) { assert.ok(c.x >= 0 && c.x + cellW <= 1280 + 0.5, JSON.stringify(c)); }
  assert.ok(o.cells[o.cols - 1].y === o.cells[0].y, 'first row is level');
  const many = L.overviewLayout(60, 1280, 720);
  assert.equal(many.scale, L.OVERVIEW_MIN_SCALE);
  assert.equal(many.cells.length, 60);
  assert.ok(many.rows * L.SLIDE_HEIGHT * many.scale > 720, 'taller than the viewport: container scrolls');
  assert.equal(L.overviewLayout(1, 800, 450).cells.length, 1);
});
